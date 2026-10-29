// Cue 庫第 3a 階段：讀取路徑。只有「切成 Cue 庫模式」的專案（projects.cue_library = 1）會走這裡，其他專案原本的路徑完全不變。
// 設計：docs/superpowers/specs/2026-10-22-cue-library-design.md（2.2、2.6、4.2、4.3；第 10 節：編號是文字 label、每個 cue 是獨立快照）
//
// 這裡的函式都只用 env.DB。回應用 { status, body }（跟 mechanisms.mjs 一樣）的，worker.js 再包成 JSON。
// 不 import mechanisms.mjs / worker.js（避免互相 import）；舊路徑的函式由 worker.js 當參數傳進來。

import { resolveLibraryObjectStates } from './cueLibrary.mjs';

const all = async (db, sql, ...binds) => (await db.prepare(sql).bind(...binds).all()).results || [];

/** 網址帶 ?cuelib=1 → 這個畫面看得懂 Cue 庫模式的機關位置（沒帶 = 還在跑的舊版前端） */
export function wantsCueLib(request) {
  try { return new URL(request.url).searchParams.get('cuelib') === '1'; } catch { return false; }
}

/** 這個專案是 Cue 庫模式嗎 */
export async function isLibraryProject(env, projectId) {
  const r = await env.DB.prepare(`SELECT cue_library FROM projects WHERE id = ? LIMIT 1`).bind(projectId).first();
  return Number(r?.cue_library) === 1;
}

/** 這首歌所屬的專案是 Cue 庫模式嗎 */
async function isLibrarySong(env, songId) {
  const r = await env.DB.prepare(
    `SELECT p.cue_library FROM songs s JOIN projects p ON p.id = s.project_id WHERE s.id = ? LIMIT 1`
  ).bind(songId).first();
  return Number(r?.cue_library) === 1;
}

/** 專案 GET / 清單：加 cueLibrary: boolean（原本的欄位不動） */
export const cueLibraryFlag = (row) => Number(row?.cue_library) === 1;

// ───────────────────────── 物件狀態 ─────────────────────────

/** 物件列（跟 worker.js loadCueStates 的第一個查詢同一批欄位，不帶某個 cue 的設定） */
async function loadObjectRows(env, projectId) {
  return all(env.DB, `
    SELECT o.id AS object_id, o.mesh_name, o.display_name, o.category, o."order" AS object_order,
           o.default_position, o.default_rotation, o.default_scale, o.locked AS object_locked, o.default_hidden AS default_hidden
      FROM stage_objects o WHERE o.project_id = ? ORDER BY o."order" ASC, o.created_at ASC`, projectId);
}

/**
 * 一個 cue（slot）的物件狀態。Cue 庫專案：讀它指到的 Cue 庫的 cue（沒有「沿用前面的 cue」）；
 * 其他專案：呼叫 legacyLoad(env, projectId, cueId)（原本的 loadCueStates），輸出完全不變。
 * 呼叫的人要先確認 cueId 屬於 projectId。
 */
export async function slotStates(env, projectId, cueId, legacyLoad) {
  const slot = await env.DB.prepare(
    `SELECT p.cue_library, c.library_cue_id
       FROM cues c JOIN songs s ON s.id = c.song_id JOIN projects p ON p.id = s.project_id
      WHERE c.id = ? LIMIT 1`
  ).bind(cueId).first();
  if (!slot || Number(slot.cue_library) !== 1) return legacyLoad(env, projectId, cueId);
  const libRows = slot.library_cue_id
    ? await all(env.DB, `SELECT * FROM library_cue_object_states WHERE library_cue_id = ?`, slot.library_cue_id)
    : [];
  return resolveLibraryObjectStates(await loadObjectRows(env, projectId), libRows);
}

// ───────────────────────── cue 清單 ─────────────────────────

/**
 * 這首歌的 cue 清單：Cue 庫專案每個 cue 多 libraryCueId / libraryCue（{id, label, name}，沒指到 = null）。
 * 其他專案原封不動。share = true（分享連結）：libraryCue 只給 {label, name}
 */
export async function decorateCueList(env, songId, cues, { share = false } = {}) {
  if (!cues.length || !(await isLibrarySong(env, songId))) return cues;
  const rows = await all(env.DB,
    `SELECT c.id, c.library_cue_id, c.crossfade_own, l.label, l.name AS lib_name, l.crossfade_seconds AS lib_crossfade
       FROM cues c LEFT JOIN library_cues l ON l.id = c.library_cue_id WHERE c.song_id = ?`, songId);
  const byId = new Map(rows.map(r => [r.id, r]));
  return cues.map(c => {
    const r = byId.get(c.id);
    const lc = r?.library_cue_id
      ? (share ? { label: r.label, name: r.lib_name } : { id: r.library_cue_id, label: r.label, name: r.lib_name })
      : null;
    // 第 8 階段：name 改成 Cue 庫的名稱（導演頁 / 工作站 / 分享頁 / AE 標記都用 name），cue 自己原本的名字放 slotName
    const named = lc ? { ...c, name: r.lib_name, slotName: c.name } : c;
    // 分享連結不給 Cue 庫的 id（訪客只看編號和名稱）
    if (share) return { ...named, libraryCue: lc };
    // 轉場：crossfadeSeconds 已經是有效值（這首歌另外設的，或 Cue 庫的）；多給「是不是另外設的」和 Cue 庫的值，畫面才寫得出來源
    return {
      ...named, libraryCueId: r?.library_cue_id || null, libraryCue: lc,
      ...(lc ? { crossfadeOwn: Number(r.crossfade_own) !== 0, libraryCrossfadeSeconds: r.lib_crossfade == null ? null : Number(r.lib_crossfade) } : {}),
    };
  });
}

// ───────────────────────── 機關位置 ─────────────────────────

// 讀機關時 variant 的條件（跟 mechanisms.mjs variantCond 同一個規則）
function variantCond(alias, { mech2, mech3 }) {
  if (!mech2) return `${alias}.variant IS NULL`;
  if (!mech3) return `(${alias}.variant IS NULL OR ${alias}.variant = 'split')`;
  return '';
}

const secOrNull = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

function libraryPositionRow(r, withLibraryFields) {
  const base = {
    cueId: r.cue_id, mechanismId: r.mechanism_id, value: Number(r.value),
    delaySec: secOrNull(r.delay_sec), durationSec: secOrNull(r.duration_sec), updatedAt: r.updated_at,
  };
  return withLibraryFields ? { ...base, libraryCueId: r.library_cue_id, carried: Number(r.carried) === 1 } : base;
}

/**
 * Cue 庫專案每個 cue（slot）的機關位置，一個 slot 一列（同一個 Cue 庫的 cue 用兩次就出現兩次，cueId 不同）。
 * cuelib = true：全部的列，多 libraryCueId / carried；false：只給 carried = 0 的（舊版前端自己沿用，剛搬完答案一樣）
 * where / binds：選哪些 slot（SQL，別名 c = cues）
 */
async function librarySlotPositions(env, { where, binds, cuelib, mech2, mech3 }) {
  const cond = variantCond('m', { mech2, mech3 });
  const rows = await env.DB.prepare(
    `SELECT c.id AS cue_id, c.library_cue_id, p.mechanism_id, p.value, p.delay_sec, p.duration_sec, p.carried, p.updated_at
       FROM cues c
       JOIN library_cue_mechanism_positions p ON p.library_cue_id = c.library_cue_id
       ${cond ? `JOIN mechanisms m ON m.id = p.mechanism_id AND ${cond}` : ''}
      WHERE ${where}${cuelib ? '' : ' AND p.carried = 0'}
      ORDER BY c."order" ASC, c.created_at ASC, c.id ASC, p.mechanism_id ASC`
  ).bind(...binds).all();
  return (rows.results || []).map(r => libraryPositionRow(r, cuelib));
}

/**
 * GET songs/:s/mechanism-positions（管理頁 / 分享連結共用）。
 * legacyFn() 回傳原本的 { status, body }。沒有帶 ?cuelib=1 的舊專案輸出完全不變；帶了就多 mode。
 */
export async function songPositionsRoute(env, projectId, songId, { cuelib = false, masterOnly = false, mech2 = true, mech3 = mech2 }, legacyFn) {
  if (!(await isLibraryProject(env, projectId))) {
    const r = await legacyFn();
    return cuelib && r.status === 200 ? { status: r.status, body: { ...r.body, mode: 'legacy' } } : r;
  }
  // 導演頁「調整舞台」存回時要帶「拿到的時候的 rev」：這首歌用到的每個 Cue 庫的 cue 的 rev。
  // 先讀 rev 再讀位置：中間剛好有人改了，rev 會比位置舊 → 之後存的時候拿到 409（安全的那一邊），不會拿舊位置蓋掉別人的
  // 分享連結（masterOnly）不給
  const libraryRevs = cuelib && !masterOnly ? await songLibraryRevs(env, songId) : null;
  const positions = await librarySlotPositions(env, {
    where: `c.song_id = ?${masterOnly ? ` AND c.status = 'master'` : ''}`, binds: [songId], cuelib, mech2, mech3,
  });
  return { status: 200, body: cuelib ? { mode: 'library', positions, ...(libraryRevs ? { libraryRevs } : {}) } : { positions } };
}

/** 這首歌的 cue 指到的每個 Cue 庫的 cue 的 rev：{ libraryCueId: rev } */
async function songLibraryRevs(env, songId) {
  const rows = await all(env.DB,
    `SELECT DISTINCT l.id, l.rev FROM cues c JOIN library_cues l ON l.id = c.library_cue_id WHERE c.song_id = ?`, songId);
  const out = {};
  for (const r of rows) out[r.id] = Number(r.rev);
  return out;
}

/**
 * 機關總表：Cue 庫專案的 positions 換成每個 slot 的 Cue 庫位置，cue 多 libraryCue；帶 ?cuelib=1 多 mode。
 * legacyFn() 回傳原本的 { status, body }；其他專案輸出完全不變（帶 ?cuelib=1 才多 mode: 'legacy'）
 */
export async function sheetRoute(env, projectId, { cuelib = false, mech2 = true, mech3 = mech2 }, legacyFn) {
  const r = await legacyFn();
  if (r.status !== 200) return r;
  if (!(await isLibraryProject(env, projectId))) {
    return cuelib ? { status: r.status, body: { ...r.body, mode: 'legacy' } } : r;
  }
  const slots = await all(env.DB,
    `SELECT c.id, l.id AS lc_id, l.label, l.name AS lib_name
       FROM cues c JOIN songs s ON s.id = c.song_id LEFT JOIN library_cues l ON l.id = c.library_cue_id
      WHERE s.project_id = ? AND c.status = 'master'`, projectId);
  const bySlot = new Map(slots.map(s => [s.id, s]));
  const songs = r.body.songs.map(s => ({
    ...s,
    cues: s.cues.map(c => {
      const x = bySlot.get(c.id);
      return { ...c, libraryCueId: x?.lc_id || null, libraryCue: x?.lc_id ? { id: x.lc_id, label: x.label, name: x.lib_name } : null };
    }),
  }));
  const positions = await librarySlotPositions(env, {
    where: `c.status = 'master' AND c.song_id IN (SELECT id FROM songs WHERE project_id = ?)`, binds: [projectId], cuelib, mech2, mech3,
  });
  return { status: 200, body: { ...r.body, songs, positions, ...(cuelib ? { mode: 'library' } : {}) } };
}
