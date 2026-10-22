// Cue 庫搬家程式（離線、不碰線上資料庫）。規格：docs/superpowers/specs/2026-10-22-cue-library-design.md 第 3 節 / 第 10 節
//
// 做的事：讀 `wrangler d1 export` 的 .sql 檔（那個檔同時就是備份）→ 載入本機的 SQLite →
//   用跟後台一模一樣的舊算法算出每首歌每個 cue 現在的畫面和機關動法 → 烤成 Cue 庫的 cue（一模一樣的合併）→
//   產生搬家用的 SQL → 把這份 SQL 套到本機那份副本上 → 再用 Cue 庫的方式讀回來，跟搬之前逐項比對。
//   有任何一項不一樣：不寫 SQL，結束碼不是 0。
//
// 用法（在 cf-worker/ 底下）：
//   搬家（產生 SQL + 報告）：
//     node scripts/migrate-cue-library.mjs <匯出檔.sql> [--project <專案 id>] [--out <資料夾>] [--rebake]
//     → <資料夾>/cue-library.sql、cue-library-report.json、cue-library-report.txt（也會印在螢幕上）
//   搬完之後再匯出一次，確認線上和搬之前一樣：
//     node scripts/migrate-cue-library.mjs --verify-only <搬完後的匯出檔.sql> [--project <專案 id>]
//   退回（只把專案切回舊模式，舊的資料都還在；切到 Cue 庫之後才改的內容會沒有）：
//     node scripts/migrate-cue-library.mjs --revert <匯出檔.sql> [--project <專案 id>] [--out <資料夾>]
//     → <資料夾>/cue-library-revert.sql
//   --rebake：專案已經是 Cue 庫模式也重新搬（只能在剛切換之後用，會丟掉 Cue 庫模式下改的東西）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { D1Sqlite } from '../testing/d1-sqlite.mjs';
import { loadCueStates } from '../worker.js';
import { loadMechanisms, loadSongPositions } from '../mechanisms.mjs';
import { resolveSongMechanisms, ownValuesByCue, ownTimingsByCue } from '../mechanismTrack.mjs';
import { bakeSlotLook, resolveLibraryObjectStates, resolveSlotMechanisms, planProjectMigration, sha256Hex } from '../cueLibrary.mjs';
import { readExportText } from './hash-login-codes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0042 = path.join(here, '..', 'migrations', '0042_cue_library.sql');

// ───────────────────────── 載入匯出檔 ─────────────────────────

/** 匯出檔的文字 → 本機的假 D1（外鍵關著載入，載完打開；舊匯出檔沒有 0042 的表就補上） */
export function loadExportDb(sqlText) {
  const db = new D1Sqlite();
  db.raw.exec('PRAGMA foreign_keys = OFF;');
  db.raw.exec(sqlText);
  const hasLib = db.raw.prepare(`PRAGMA table_info(cues)`).all().some(c => c.name === 'library_cue_id');
  if (!hasLib) db.raw.exec(fs.readFileSync(MIGRATION_0042, 'utf8'));
  db.raw.exec('PRAGMA foreign_keys = ON;');
  return db;
}

// ───────────────────────── 讀舊資料 ─────────────────────────

const all = async (db, sql, ...binds) => (await db.prepare(sql).bind(...binds).all()).results || [];

/** 物件列（跟 worker.js loadCueStates 的第一個查詢同一批欄位，不帶某個 cue 的設定） */
async function loadObjectRows(db, projectId) {
  return all(db, `
    SELECT o.id AS object_id, o.mesh_name, o.display_name, o.category, o."order" AS object_order,
           o.default_position, o.default_rotation, o.default_scale, o.locked AS object_locked, o.default_hidden AS default_hidden,
           NULL AS state_position, NULL AS state_rotation, NULL AS state_scale, NULL AS state_visible, NULL AS state_custom, NULL AS state_updated_at
      FROM stage_objects o WHERE o.project_id = ? ORDER BY o."order" ASC, o.created_at ASC`, projectId);
}

async function loadProjectFacts(db, projectId) {
  const songs = await all(db, `SELECT id, name, code, "order" FROM songs WHERE project_id = ? ORDER BY "order" ASC, created_at ASC, id ASC`, projectId);
  const cuesBySong = new Map();
  for (const s of songs) {
    cuesBySong.set(s.id, await all(db,
      `SELECT id, song_id, name, "order", status, created_at, video_time_sec, crossfade_seconds, library_cue_id
         FROM cues WHERE song_id = ? ORDER BY "order" ASC, created_at ASC`, s.id));
  }
  const mechs = await loadMechanisms({ DB: db }, projectId, null, { mech2: true, mech3: true });
  return { songs, cuesBySong, mechs };
}

/** 舊算法：每個 cue 的物件狀態、機關動法（跟後台 / 前端同一份程式） */
async function legacyResolve(db, projectId, facts) {
  const env = { DB: db };
  const states = new Map(), mech = new Map();
  for (const s of facts.songs) {
    const cues = facts.cuesBySong.get(s.id);
    const positions = (await loadSongPositions(env, s.id, { masterOnly: false, mech2: true, mech3: true }))
      .map(p => ({ cueId: p.cueId, mechanismId: p.mechanismId, value: p.value, delaySec: p.delaySec, durationSec: p.durationSec }));
    const resolved = resolveSongMechanisms(facts.mechs, cues, ownValuesByCue(positions));
    const timings = ownTimingsByCue(positions);
    for (const c of cues) {
      states.set(c.id, await loadCueStates(env, projectId, c.id));
      mech.set(c.id, { row: resolved.get(c.id) || {}, timings: timings.get(c.id) || {} });
    }
  }
  return { states, mech };
}

/** 新做法：從 Cue 庫的表讀回每個 cue 的物件狀態、機關動法 */
async function libraryResolve(db, projectId, facts) {
  const objectRows = await loadObjectRows(db, projectId);
  const libObj = new Map(), libMech = new Map();
  for (const r of await all(db, `SELECT s.* FROM library_cue_object_states s JOIN library_cues l ON l.id = s.library_cue_id WHERE l.project_id = ?`, projectId)) {
    if (!libObj.has(r.library_cue_id)) libObj.set(r.library_cue_id, []);
    libObj.get(r.library_cue_id).push(r);
  }
  for (const r of await all(db, `SELECT p.* FROM library_cue_mechanism_positions p JOIN library_cues l ON l.id = p.library_cue_id WHERE l.project_id = ?`, projectId)) {
    if (!libMech.has(r.library_cue_id)) libMech.set(r.library_cue_id, []);
    libMech.get(r.library_cue_id).push(r);
  }
  const states = new Map(), mech = new Map();
  for (const s of facts.songs) {
    for (const c of facts.cuesBySong.get(s.id)) {
      states.set(c.id, resolveLibraryObjectStates(objectRows, libObj.get(c.library_cue_id) || []));
      mech.set(c.id, resolveSlotMechanisms(facts.mechs, libMech.get(c.library_cue_id) || [], c.id));
    }
  }
  return { states, mech };
}

// ───────────────────────── 比對 ─────────────────────────

const stable = (v) => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
};

const STATE_FIELDS = {
  effective: '實際看到的位置 / 角度 / 大小 / 顯示',
  override: '這個 cue 自己設的內容',
  tracked: '是不是沿用',
  defaultHidden: '預設隱藏',
  locked: '鎖定',
  order: '物件順序',
  default: '物件預設位置',
};

/** 兩個物件狀態有哪些項目不一樣（「自己設的內容」不比更新時間；來源標記 sources 不比，那是新增的說明用欄位） */
function diffState(a, b) {
  const out = [];
  for (const f of Object.keys(STATE_FIELDS)) {
    let x = a[f], y = b[f];
    if (f === 'override') {
      x = x ? { ...x, updatedAt: undefined } : null;
      y = y ? { ...y, updatedAt: undefined } : null;
    }
    if (stable(x) !== stable(y)) out.push(STATE_FIELDS[f]);
  }
  return out;
}

const MECH_FIELDS = { value: '位置', stored: '存的值', source: '自己設 / 沿用 / 預設', clamped: '超出行程' };

/** 搬家前後逐項比對（物件、機關、cue 有沒有指到 Cue 庫）→ 不一樣的清單 */
export function compareResolved(facts, before, after) {
  const diffs = [];
  const push = (song, cue, kind, name, what) => diffs.push({ song: song.name, cue: cue.name, slotId: cue.id, kind, name, what });
  for (const song of facts.songs) {
    for (const cue of facts.cuesBySong.get(song.id)) {
      if (!cue.library_cue_id) push(song, cue, 'cue', '', '沒有指到 Cue 庫的 cue');
      const bs = before.states.get(cue.id) || [], as = after.states.get(cue.id) || [];
      if (bs.length !== as.length) push(song, cue, '物件', '', `物件數量不一樣（${bs.length} → ${as.length}）`);
      const aById = new Map(as.map(x => [x.objectId, x]));
      for (const b of bs) {
        const a = aById.get(b.objectId);
        if (!a) { push(song, cue, '物件', b.displayName || b.meshName, '搬完後找不到這個物件'); continue; }
        const d = diffState(b, a);
        if (d.length) push(song, cue, '物件', b.displayName || b.meshName, d.join('、'));
      }
      const bm = before.mech.get(cue.id), am = after.mech.get(cue.id);
      for (const m of facts.mechs) {
        if (m.variant === 'hoist_rig') continue;
        const x = bm.row[m.id], y = am.row[m.id];
        const d = Object.keys(MECH_FIELDS).filter(f => stable(x?.[f]) !== stable(y?.[f])).map(f => MECH_FIELDS[f]);
        if (stable(bm.timings[m.id] ?? null) !== stable(am.timings[m.id] ?? null)) d.push('延遲 / 走幾秒');
        if (d.length) push(song, cue, '機關', m.name, d.join('、'));
      }
    }
  }
  return diffs;
}

/** cue 本身（名稱、順序、時間、轉場、狀態）的指紋，搬家前後要一樣 */
async function slotFingerprint(db, projectId) {
  return stable(await all(db,
    `SELECT c.id, c.song_id, c.name, c."order", c.video_time_sec, c.crossfade_seconds, c.status
       FROM cues c JOIN songs s ON s.id = c.song_id WHERE s.project_id = ? ORDER BY c.id`, projectId));
}

/** 資料有沒有怪怪的（不影響搬家，只是提醒） */
function collectWarnings(facts) {
  const warnings = [];
  for (const song of facts.songs) {
    const cues = facts.cuesBySong.get(song.id);
    const seen = new Map();
    for (const c of cues) seen.set(c.order, [...(seen.get(c.order) || []), c.name]);
    for (const [order, names] of seen) {
      if (names.length > 1) warnings.push(`歌「${song.name}」有 ${names.length} 個 cue 順序一樣（第 ${order} 個：${names.join('、')}），畫面照現在的算法搬，不受影響`);
    }
    const timed = cues.filter(c => c.video_time_sec != null);
    for (let i = 1; i < timed.length; i++) {
      if (Number(timed[i].video_time_sec) < Number(timed[i - 1].video_time_sec)) {
        warnings.push(`歌「${song.name}」的 cue 時間順序跟清單順序不一樣（「${timed[i].name}」比前一個時間早）`);
        break;
      }
    }
  }
  return warnings;
}

// ───────────────────────── 產生 SQL ─────────────────────────

const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${String(v).replace(/'/g, "''")}'`);
const CHUNK = 50;
const chunks = (arr) => { const out = []; for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK)); return out; };
const insert = (table, cols, rows) => chunks(rows).map(part =>
  `INSERT INTO ${table} (${cols.join(', ')}) VALUES\n${part.map(r => `  (${r.join(', ')})`).join(',\n')};`);

/** 一個專案的搬家 SQL（可以重複執行：先清掉這個專案上次搬的 Cue 庫，再寫） */
export function buildProjectSql(projectId, plan, slotCount) {
  const P = q(projectId);
  const out = [`-- 專案 ${projectId}：${slotCount} 個 cue → ${plan.libraryCues.length} 個 Cue 庫的 cue`];
  out.push(`UPDATE cues SET library_cue_id = NULL WHERE song_id IN (SELECT id FROM songs WHERE project_id = ${P});`);
  out.push(`DELETE FROM library_cues WHERE project_id = ${P};`);
  out.push(...insert('library_cues', ['id', 'project_id', 'label', 'name', 'migrated_from'],
    plan.libraryCues.map(l => [q(l.id), P, q(l.label), q(l.name), q(JSON.stringify(l.migratedFrom))])));
  const objRows = [], mechRows = [];
  for (const l of plan.libraryCues) {
    for (const o of l.objects) {
      objRows.push([q(l.id), q(o.stage_object_id), q(o.position), q(o.rotation), q(o.scale), q(o.visible), q(o.custom_props),
        q(o.own), q(o.own_fields), o.updated_at ? q(o.updated_at) : `datetime('now')`]);
    }
    for (const m of l.mechanisms) {
      mechRows.push([q(l.id), q(m.mechanism_id), q(m.value), q(m.delay_sec), q(m.duration_sec), q(m.carried)]);
    }
  }
  out.push(...insert('library_cue_object_states',
    ['library_cue_id', 'stage_object_id', 'position', 'rotation', 'scale', 'visible', 'custom_props', 'own', 'own_fields', 'updated_at'], objRows));
  out.push(...insert('library_cue_mechanism_positions',
    ['library_cue_id', 'mechanism_id', 'value', 'delay_sec', 'duration_sec', 'carried'], mechRows));
  const byLib = new Map();
  for (const [slotId, libId] of Object.entries(plan.slotToLibrary)) byLib.set(libId, [...(byLib.get(libId) || []), slotId]);
  for (const l of plan.libraryCues) {
    for (const part of chunks(byLib.get(l.id) || [])) {
      out.push(`UPDATE cues SET library_cue_id = ${q(l.id)} WHERE id IN (${part.map(q).join(', ')});`);
    }
  }
  out.push(`UPDATE projects SET cue_library = 1 WHERE id = ${P};`);
  const text = `把 ${slotCount} 個 cue 搬進 Cue 庫（${plan.libraryCues.length} 個 Cue 庫的 cue）`;
  const payload = JSON.stringify({ name: text, cueLibraryMigration: { cues: slotCount, libraryCues: plan.libraryCues.length } });
  out.push(`INSERT OR REPLACE INTO activity_log (id, project_id, user_id, action, target_type, target_id, payload) VALUES (${q('a_cuelib_' + sha256Hex('cuelib:' + projectId).slice(0, 16))}, ${P}, NULL, 'update', 'project', ${P}, ${q(payload)});`);
  return out.join('\n');
}

// ───────────────────────── 搬一個專案 ─────────────────────────

function bakeProject(project, facts, legacy) {
  const slots = [];
  for (const song of facts.songs) {
    for (const c of facts.cuesBySong.get(song.id)) {
      const { row, timings } = legacy.mech.get(c.id);
      const look = bakeSlotLook({ states: legacy.states.get(c.id), mechs: facts.mechs, resolved: row, timings });
      slots.push({ id: c.id, songId: song.id, name: c.name, order: c.order, createdAt: c.created_at, look });
    }
  }
  return planProjectMigration({ projectId: project.id, songs: facts.songs, slots });
}

function projectReport(project, facts, plan, slotCount, diffs, warnings) {
  const slotInfo = new Map();
  for (const s of facts.songs) for (const c of facts.cuesBySong.get(s.id)) slotInfo.set(c.id, { song: s.name, cue: c.name });
  return {
    projectId: project.id, projectName: project.name,
    songs: facts.songs.length, cues: slotCount, libraryCues: plan.libraryCues.length,
    mergedGroups: plan.merged.length,
    mergedAway: plan.merged.reduce((n, g) => n + g.slotIds.length - 1, 0),
    merged: plan.merged.map(g => ({ name: g.name, where: g.slotIds.map(id => `${slotInfo.get(id).song}「${slotInfo.get(id).cue}」`) })),
    rows: {
      objects: plan.libraryCues.reduce((n, l) => n + l.objects.length, 0),
      mechanisms: plan.libraryCues.reduce((n, l) => n + l.mechanisms.length, 0),
    },
    differences: diffs, warnings,
  };
}

const wholeDiff = (what) => ({ song: '', cue: '', slotId: '', kind: 'cue', name: '', what });

const listProjects = (db, projectId) =>
  all(db, `SELECT id, name, cue_library FROM projects ${projectId ? 'WHERE id = ?' : ''} ORDER BY created_at ASC, id ASC`, ...(projectId ? [projectId] : []));

/**
 * 整個匯出檔跑一遍（SQL 會套到傳進來的這份本機副本上）。
 * @returns {{sql: string|null, report: object}} 有任何不一樣 → sql = null
 */
export async function runMigration(db, { projectId = null, rebake = false } = {}) {
  const projects = await listProjects(db, projectId);
  if (projectId && !projects.length) throw new Error(`匯出檔裡沒有專案 ${projectId}`);
  const reports = [], parts = [], skipped = [];
  for (const project of projects) {
    if (Number(project.cue_library) === 1 && !rebake) { skipped.push({ projectId: project.id, projectName: project.name }); continue; }
    const facts = await loadProjectFacts(db, project.id);
    const slotCount = [...facts.cuesBySong.values()].reduce((n, l) => n + l.length, 0);
    const legacy = await legacyResolve(db, project.id, facts);
    const plan = bakeProject(project, facts, legacy);
    const sql = buildProjectSql(project.id, plan, slotCount);
    // 套到本機這份副本，再用 Cue 庫的方式讀回來比
    const before = await slotFingerprint(db, project.id);
    db.raw.exec(sql);
    const factsAfter = await loadProjectFacts(db, project.id);
    const diffs = compareResolved(factsAfter, legacy, await libraryResolve(db, project.id, factsAfter));
    if (before !== await slotFingerprint(db, project.id)) diffs.push(wholeDiff('cue 本身的資料（名稱 / 順序 / 時間 / 轉場 / 狀態）被改到了'));
    const libCount = (await db.prepare(`SELECT COUNT(*) AS n FROM library_cues WHERE project_id = ?`).bind(project.id).first()).n;
    if (libCount !== plan.libraryCues.length) diffs.push(wholeDiff('Cue 庫的 cue 數量不對'));
    const unused = (await db.prepare(`SELECT COUNT(*) AS n FROM library_cues l WHERE l.project_id = ? AND NOT EXISTS (SELECT 1 FROM cues c WHERE c.library_cue_id = l.id)`).bind(project.id).first()).n;
    if (unused) diffs.push(wholeDiff(`有 ${unused} 個 Cue 庫的 cue 沒有任何歌在用`));
    parts.push(sql);
    reports.push(projectReport(project, factsAfter, plan, slotCount, diffs, collectWarnings(facts)));
  }
  const totalDiffs = reports.reduce((n, r) => n + r.differences.length, 0);
  const header = '-- 由 cf-worker/scripts/migrate-cue-library.mjs 產生：把專案搬進 Cue 庫（只新增，舊資料都還在；退回用 --revert）\n';
  return {
    sql: totalDiffs || !parts.length ? null : header + parts.join('\n\n') + '\n',
    report: { projects: reports, skipped, totalDifferences: totalDiffs },
  };
}

/** 搬完之後（或任何時候）重新比一次：舊的表算出來的畫面，跟 Cue 庫讀出來的一不一樣 */
export async function verifyOnly(db, { projectId = null } = {}) {
  const reports = [], skipped = [];
  for (const project of await listProjects(db, projectId)) {
    if (Number(project.cue_library) !== 1) { skipped.push({ projectId: project.id, projectName: project.name }); continue; }
    const facts = await loadProjectFacts(db, project.id);
    const slotCount = [...facts.cuesBySong.values()].reduce((n, l) => n + l.length, 0);
    const diffs = compareResolved(facts, await legacyResolve(db, project.id, facts), await libraryResolve(db, project.id, facts));
    const libCount = (await db.prepare(`SELECT COUNT(*) AS n FROM library_cues WHERE project_id = ?`).bind(project.id).first()).n;
    reports.push({
      projectId: project.id, projectName: project.name, songs: facts.songs.length, cues: slotCount, libraryCues: libCount,
      mergedGroups: 0, mergedAway: 0, merged: [], rows: null, differences: diffs, warnings: [],
    });
  }
  return { report: { projects: reports, skipped, totalDifferences: reports.reduce((n, r) => n + r.differences.length, 0) } };
}

/** 退回：只把專案切回舊模式（舊的資料原封不動） */
export async function buildRevertSql(db, { projectId = null } = {}) {
  const rows = await all(db, `SELECT p.id, p.name FROM projects p WHERE p.cue_library = 1
      AND EXISTS (SELECT 1 FROM library_cues l WHERE l.project_id = p.id AND l.migrated_from IS NOT NULL)
      ${projectId ? 'AND p.id = ?' : ''} ORDER BY p.created_at ASC, p.id ASC`, ...(projectId ? [projectId] : []));
  if (!rows.length) return { sql: null, projects: [] };
  const sql = `-- 由 cf-worker/scripts/migrate-cue-library.mjs --revert 產生：專案切回舊模式（舊的 cue 資料沒動；切到 Cue 庫之後才改的內容不會帶回來）\n`
    + `UPDATE projects SET cue_library = 0 WHERE id IN (${rows.map(r => q(r.id)).join(', ')});\n`;
  return { sql, projects: rows };
}

// ───────────────────────── 報告（中文、白話） ─────────────────────────

export function renderReport(report, { verify = false } = {}) {
  const L = [verify ? 'Cue 庫比對報告（搬完之後重新比對）' : 'Cue 庫搬家報告', ''];
  for (const p of report.projects) {
    L.push(`專案「${p.projectName}」：${p.songs} 首歌、${p.cues} 個 cue`);
    if (verify) L.push(`  Cue 庫裡有 ${p.libraryCues} 個 cue`);
    else {
      L.push(`  搬成 ${p.libraryCues} 個 Cue 庫的 cue（合併了 ${p.mergedGroups} 組，省下 ${p.mergedAway} 個；名稱和內容完全一樣的才會合併）`);
      for (const g of p.merged) L.push(`    合併「${g.name}」：${g.where.join('、')}`);
    }
    if (p.differences.length === 0) L.push('  比對結果：0 個不一樣');
    else {
      L.push(`  比對結果：${p.differences.length} 個不一樣`);
      for (const d of p.differences) {
        L.push(`    ${d.song ? `歌「${d.song}」的 cue「${d.cue}」` : '專案整體'}${d.name ? ` 的${d.kind}「${d.name}」` : ''}：${d.what}`);
      }
    }
    for (const w of p.warnings || []) L.push(`  提醒：${w}`);
    L.push('');
  }
  for (const s of report.skipped) L.push(`略過「${s.projectName}」：${verify ? '還不是 Cue 庫模式' : '已經是 Cue 庫模式（要重搬請加 --rebake）'}`);
  if (report.skipped.length) L.push('');
  L.push(report.totalDifferences === 0 ? '全部比對：0 個不一樣。' : `全部比對：共 ${report.totalDifferences} 個不一樣${verify ? '。' : '，沒有產生 SQL。'}`);
  return L.join('\n') + '\n';
}

// ───────────────────────── 命令列 ─────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };
  const opt = (n) => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v ?? null; };
  const revert = flag('--revert'), verify = flag('--verify-only'), rebake = flag('--rebake');
  const projectId = opt('--project'), outDir = opt('--out') || '.';
  const file = args[0];
  if (!file) {
    console.error('用法：node scripts/migrate-cue-library.mjs [--revert | --verify-only] <wrangler d1 export 的 .sql> [--project <id>] [--out <資料夾>] [--rebake]');
    process.exit(1);
  }
  const db = loadExportDb(readExportText(fs.readFileSync(file)));
  fs.mkdirSync(outDir, { recursive: true });
  if (revert) {
    const { sql, projects } = await buildRevertSql(db, { projectId });
    if (!sql) { console.error('沒有需要退回的專案（沒有搬過的 Cue 庫專案）'); return; }
    const out = path.join(outDir, 'cue-library-revert.sql');
    fs.writeFileSync(out, sql, 'utf8');
    console.error(`已寫到 ${out}：${projects.length} 個專案切回舊模式（${projects.map(p => p.name).join('、')}）`);
    return;
  }
  if (verify) {
    const { report } = await verifyOnly(db, { projectId });
    console.error(renderReport(report, { verify: true }));
    if (report.totalDifferences) process.exit(2);
    return;
  }
  const { sql, report } = await runMigration(db, { projectId, rebake });
  const text = renderReport(report);
  fs.writeFileSync(path.join(outDir, 'cue-library-report.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'cue-library-report.txt'), text, 'utf8');
  console.error(text);
  if (report.totalDifferences) process.exit(2);
  if (sql) {
    const out = path.join(outDir, 'cue-library.sql');
    fs.writeFileSync(out, sql, 'utf8');
    console.error(`已寫到 ${out}（還沒有跑到線上）`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(e?.message || e); process.exit(1); });
}
