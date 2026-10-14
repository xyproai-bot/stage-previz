// 機關（升降台、轉台、滑軌…）的後台：定義的新增 / 修改 / 刪除 / 排序、每個 cue 的機關位置、機關總表資料、
// 分享連結看的資料、複製專案 / 匯出匯入 / 複製 cue / 常用擺位 / 重置 cue 時一起處理。
// （舊的全專案機關滑桿 projects.mechanism_offsets：0023 轉成機關之後就不再同步，後台也不收修改了）
// 設計：docs/superpowers/specs/2026-10-14-mechanism-system-design.md；API：docs/mechanisms-api.md
//
// 檢查規則跟前端共用 web/src/lib/mechanisms/model.ts（純判斷，wrangler 打包時會一起編進來）。
// worker.js 只負責：路由（access.mjs）→ 檢查網址上的 id → 呼叫這裡。
// 這裡的函式都只用 env.DB（D1），mechanisms.test.mjs 用 node:sqlite 做一個一樣的 DB 測。
//
// 回應：handler 回傳 { status, body }（worker.js 包成 JSON 回應），不直接 new Response → 這裡不用知道 CORS。

import {
  normalizeMechanismInput, mechanismToInput, parseCueValue, clampValue,
} from '../web/src/lib/mechanisms/model.ts';
import { planCueConversion } from '../web/src/lib/mechanisms/convert.ts';

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const newId = (prefix, i = 0) => prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + (i ? String(i) : '');
const ok = (body, status = 200) => ({ status, body });
const bad = (error, status = 400, extra = {}) => ({ status, body: { error, ...extra } });

function parseJson(s, fallback) {
  if (s == null || s === '') return fallback;
  try { const v = JSON.parse(s); return v ?? fallback; } catch { return fallback; }
}

async function readJson(request) {
  try { const b = await request.json(); return b && typeof b === 'object' && !Array.isArray(b) ? b : null; } catch { return null; }
}

// ─────────────────────────────────────────────
// 資料庫一列 ↔ API 格式（純函式，有測）
// ─────────────────────────────────────────────

/** mechanisms 一列 → API 的 Mechanism */
export function rowToMechanism(row, objectIds = [], cueCount = 0) {
  const vec = (v, fb) => {
    const o = parseJson(v, null);
    return o && Number.isFinite(Number(o.x)) && Number.isFinite(Number(o.y)) && Number.isFinite(Number(o.z))
      ? { x: Number(o.x), y: Number(o.y), z: Number(o.z) } : fb;
  };
  const presets = parseJson(row.presets, []);
  const metadata = parseJson(row.metadata, null);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'rotary' ? 'rotary' : 'linear',
    axis: vec(row.axis, { x: 0, y: 1, z: 0 }),
    pivot: row.kind === 'rotary' ? vec(row.pivot, { x: 0, y: 0, z: 0 }) : null,
    travelMin: Number(row.travel_min),
    travelMax: Number(row.travel_max),
    defaultValue: Number(row.default_value),
    maxSpeed: row.max_speed == null ? null : Number(row.max_speed),
    presets: Array.isArray(presets)
      ? presets.filter(p => p && typeof p.name === 'string' && Number.isFinite(Number(p.value)))
        .map(p => ({ name: p.name, value: Number(p.value) }))
        .sort((a, b) => a.value - b.value)
      : [],
    parentId: row.parent_id || null,
    objectIds,
    consoleLabel: row.console_label || null,
    order: Number(row.order) || 0,
    metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : null,
    cueCount: Number(cueCount) || 0,
    updatedAt: row.updated_at,
  };
}

/** 檢查完的 MechanismInput → 要寫進資料庫的欄位 */
export function inputToColumns(v) {
  return {
    name: v.name,
    kind: v.kind,
    axis: JSON.stringify(v.axis),
    pivot: v.kind === 'rotary' && v.pivot ? JSON.stringify(v.pivot) : null,
    travel_min: v.travelMin,
    travel_max: v.travelMax,
    default_value: v.defaultValue,
    max_speed: v.maxSpeed,
    presets: JSON.stringify(v.presets),
    parent_id: v.parentId,
    console_label: v.consoleLabel,
    metadata: v.metadata ? JSON.stringify(v.metadata) : null,
  };
}

/**
 * 要放進這個機關的物件，有哪些已經直接放在別的機關裡（一個物件只能直接放在一個機關）
 * @param {string[]} objectIds
 * @param {{stage_object_id: string, mechanism_id: string, mechanism_name: string}[]} memberships  這個專案所有的
 * @param {Map<string, string>} objectNames  objectId → 名稱
 * @param {string|null} selfId
 */
export function findObjectConflicts(objectIds, memberships, objectNames, selfId) {
  const want = new Set(objectIds);
  return memberships
    .filter(m => want.has(m.stage_object_id) && m.mechanism_id !== selfId)
    .map(m => ({
      objectId: m.stage_object_id,
      objectName: objectNames.get(m.stage_object_id) || m.stage_object_id,
      mechanismId: m.mechanism_id,
      mechanismName: m.mechanism_name,
    }));
}

export function conflictMessage(c) {
  return `「${c.objectName}」已經在「${c.mechanismName}」裡，一個物件只能直接放在一個機關`;
}

// ─────────────────────────────────────────────
// 讀
// ─────────────────────────────────────────────

/** 這個專案的機關（照順序；含帶哪些物件、幾個 cue 有設定） */
export async function loadMechanisms(env, projectId, onlyId = null) {
  const where = onlyId ? 'm.project_id = ? AND m.id = ?' : 'm.project_id = ?';
  const binds = onlyId ? [projectId, onlyId] : [projectId];
  const [mr, or] = await env.DB.batch([
    env.DB.prepare(
      `SELECT m.*, (SELECT COUNT(*) FROM cue_mechanism_positions p WHERE p.mechanism_id = m.id) AS cue_count
         FROM mechanisms m WHERE ${where} ORDER BY m."order" ASC, m.created_at ASC, m.id ASC`
    ).bind(...binds),
    env.DB.prepare(
      `SELECT mo.mechanism_id, mo.stage_object_id
         FROM mechanism_objects mo
         JOIN mechanisms m ON m.id = mo.mechanism_id
         JOIN stage_objects o ON o.id = mo.stage_object_id
        WHERE ${where}
        ORDER BY o."order" ASC, o.created_at ASC`
    ).bind(...binds),
  ]);
  const objs = new Map();
  for (const r of or.results || []) {
    const list = objs.get(r.mechanism_id) || [];
    list.push(r.stage_object_id);
    objs.set(r.mechanism_id, list);
  }
  return (mr.results || []).map(r => rowToMechanism(r, objs.get(r.id) || [], r.cue_count));
}

export async function listMechanisms(env, ctx) {
  return ok({ mechanisms: await loadMechanisms(env, ctx.projectId) });
}

/** 一首歌每個 cue 自己設的機關位置；masterOnly = 分享連結（只看得到正式 cue） */
export async function loadSongPositions(env, songId, { masterOnly = false } = {}) {
  const r = await env.DB.prepare(
    `SELECT p.cue_id, p.mechanism_id, p.value, p.updated_at
       FROM cue_mechanism_positions p
       JOIN cues c ON c.id = p.cue_id
      WHERE c.song_id = ?${masterOnly ? ` AND c.status = 'master'` : ''}
      ORDER BY c."order" ASC`
  ).bind(songId).all();
  return (r.results || []).map(rowToPosition);
}

function rowToPosition(r) {
  return { cueId: r.cue_id, mechanismId: r.mechanism_id, value: Number(r.value), updatedAt: r.updated_at };
}

export async function listSongPositions(env, ctx, songId) {
  return ok({ positions: await loadSongPositions(env, songId) });
}

/** 機關總表：整個專案每首歌的正式 cue + 每個 cue 自己設的位置（一次拿完） */
export async function mechanismSheet(env, ctx) {
  const pid = ctx.projectId;
  const [songsR, cuesR, posR] = await env.DB.batch([
    env.DB.prepare(`SELECT id, name, code, "order" FROM songs WHERE project_id = ? ORDER BY "order" ASC, created_at ASC`).bind(pid),
    env.DB.prepare(
      `SELECT c.id, c.song_id, c.name, c."order", c.video_time_sec, c.crossfade_seconds
         FROM cues c JOIN songs s ON s.id = c.song_id
        WHERE s.project_id = ? AND c.status = 'master'
        ORDER BY c."order" ASC, c.created_at ASC`
    ).bind(pid),
    env.DB.prepare(
      `SELECT p.cue_id, p.mechanism_id, p.value, p.updated_at
         FROM cue_mechanism_positions p
         JOIN cues c ON c.id = p.cue_id JOIN songs s ON s.id = c.song_id
        WHERE s.project_id = ? AND c.status = 'master'`
    ).bind(pid),
  ]);
  const bySong = new Map();
  for (const c of cuesR.results || []) {
    const list = bySong.get(c.song_id) || [];
    list.push({
      id: c.id, name: c.name, order: c.order,
      videoTimeSec: typeof c.video_time_sec === 'number' ? c.video_time_sec : null,
      crossfadeSeconds: Number(c.crossfade_seconds) || 0,
    });
    bySong.set(c.song_id, list);
  }
  return ok({
    songs: (songsR.results || []).map(s => ({ id: s.id, name: s.name, code: s.code || null, order: s.order, cues: bySong.get(s.id) || [] })),
    positions: (posR.results || []).map(rowToPosition),
    mechanisms: await loadMechanisms(env, pid),
  });
}

// ─────────────────────────────────────────────
// 新增 / 修改 / 刪除 / 排序
// ─────────────────────────────────────────────

async function projectFacts(env, projectId) {
  const [sibR, objR, memR] = await env.DB.batch([
    env.DB.prepare(`SELECT id, name, parent_id FROM mechanisms WHERE project_id = ?`).bind(projectId),
    env.DB.prepare(`SELECT id, display_name, mesh_name FROM stage_objects WHERE project_id = ?`).bind(projectId),
    env.DB.prepare(
      `SELECT mo.stage_object_id, mo.mechanism_id, m.name AS mechanism_name
         FROM mechanism_objects mo JOIN mechanisms m ON m.id = mo.mechanism_id
        WHERE m.project_id = ?`
    ).bind(projectId),
  ]);
  const objects = objR.results || [];
  return {
    siblings: (sibR.results || []).map(s => ({ id: s.id, name: s.name, parentId: s.parent_id || null })),
    projectObjectIds: new Set(objects.map(o => o.id)),
    objectNames: new Map(objects.map(o => [o.id, (o.display_name && String(o.display_name).trim()) || o.mesh_name])),
    memberships: memR.results || [],
  };
}

/** 新增或修改共用：檢查 → 物件衝突 → 寫進資料庫的語句 */
function membershipStatements(env, mechId, objectIds, conflicts) {
  const stmts = [];
  // 從別的機關移過來：那些機關算「在新介面改過」（舊滑桿不會再把物件放回去）
  const fromMechs = [...new Set(conflicts.map(c => c.mechanismId))];
  for (const c of conflicts) {
    stmts.push(env.DB.prepare(`DELETE FROM mechanism_objects WHERE stage_object_id = ? AND mechanism_id = ?`).bind(c.objectId, c.mechanismId));
  }
  for (const m of fromMechs) {
    stmts.push(env.DB.prepare(`UPDATE mechanisms SET edited_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).bind(m));
  }
  stmts.push(env.DB.prepare(`DELETE FROM mechanism_objects WHERE mechanism_id = ?`).bind(mechId));
  for (const oid of objectIds) {
    stmts.push(env.DB.prepare(`INSERT INTO mechanism_objects (mechanism_id, stage_object_id) VALUES (?, ?)`).bind(mechId, oid));
  }
  return stmts;
}

export async function createMechanism(request, env, ctx, log) {
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  const facts = await projectFacts(env, ctx.projectId);
  const n = normalizeMechanismInput(body, { siblings: facts.siblings, projectObjectIds: facts.projectObjectIds });
  if (!n.ok) return bad(n.error, 400, { field: n.field });
  const v = n.value;
  const conflicts = findObjectConflicts(v.objectIds, facts.memberships, facts.objectNames, null);
  if (conflicts.length && body.moveObjects !== true) return bad(conflictMessage(conflicts[0]), 409, { conflicts });

  const maxRow = await env.DB.prepare(`SELECT COALESCE(MAX("order"), -1) AS m FROM mechanisms WHERE project_id = ?`).bind(ctx.projectId).first();
  const maxOrder = Number(maxRow?.m);
  const order = Number.isFinite(maxOrder) ? maxOrder + 1 : 0;
  const id = newId('mech_');
  const c = inputToColumns(v);
  const stmts = [
    env.DB.prepare(
      `INSERT INTO mechanisms (id, project_id, name, kind, axis, pivot, travel_min, travel_max, default_value, max_speed,
                               presets, parent_id, console_label, "order", metadata, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(id, ctx.projectId, c.name, c.kind, c.axis, c.pivot, c.travel_min, c.travel_max, c.default_value, c.max_speed,
      c.presets, c.parent_id, c.console_label, order, c.metadata),
    ...membershipStatements(env, id, v.objectIds, conflicts),
  ];
  await env.DB.batch(stmts);
  await log?.('create', 'mechanism', id, { name: v.name, objects: v.objectIds.length, moved: conflicts.length || undefined });
  const [mechanism] = await loadMechanisms(env, ctx.projectId, id);
  return ok({ mechanism }, 201);
}

export async function updateMechanism(request, env, ctx, mechId, log) {
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  const [existing] = await loadMechanisms(env, ctx.projectId, mechId);
  if (!existing) return bad('這個專案裡找不到這個機關', 404);
  const facts = await projectFacts(env, ctx.projectId);
  const n = normalizeMechanismInput(body, {
    existing: mechanismToInput(existing), selfId: mechId, siblings: facts.siblings, projectObjectIds: facts.projectObjectIds,
  });
  if (!n.ok) return bad(n.error, 400, { field: n.field });
  const v = n.value;
  const touchesObjects = Array.isArray(body.objectIds);
  const conflicts = touchesObjects ? findObjectConflicts(v.objectIds, facts.memberships, facts.objectNames, mechId) : [];
  if (conflicts.length && body.moveObjects !== true) return bad(conflictMessage(conflicts[0]), 409, { conflicts });

  const c = inputToColumns(v);
  const stmts = [
    env.DB.prepare(
      `UPDATE mechanisms SET name = ?, kind = ?, axis = ?, pivot = ?, travel_min = ?, travel_max = ?, default_value = ?,
              max_speed = ?, presets = ?, parent_id = ?, console_label = ?, metadata = ?,
              edited_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND project_id = ?`
    ).bind(c.name, c.kind, c.axis, c.pivot, c.travel_min, c.travel_max, c.default_value, c.max_speed, c.presets,
      c.parent_id, c.console_label, c.metadata, mechId, ctx.projectId),
    ...(touchesObjects ? membershipStatements(env, mechId, v.objectIds, conflicts) : []),
  ];
  await env.DB.batch(stmts);
  const out = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM cue_mechanism_positions WHERE mechanism_id = ? AND (value < ? OR value > ?)`
  ).bind(mechId, v.travelMin, v.travelMax).first();
  const changes = {};
  for (const k of Object.keys(body)) if (k !== 'moveObjects') changes[k] = body[k];
  await log?.('update', 'mechanism', mechId, { name: v.name, changes });
  const [mechanism] = await loadMechanisms(env, ctx.projectId, mechId);
  return ok({ mechanism, outOfRangeCount: Number(out?.n) || 0 });
}

export async function deleteMechanism(request, env, ctx, mechId, log) {
  const before = await env.DB.prepare(
    `SELECT m.name, (SELECT COUNT(*) FROM cue_mechanism_positions p WHERE p.mechanism_id = m.id) AS n
       FROM mechanisms m WHERE m.id = ? AND m.project_id = ?`
  ).bind(mechId, ctx.projectId).first();
  if (!before) return bad('這個專案裡找不到這個機關', 404);
  await env.DB.prepare(`DELETE FROM mechanisms WHERE id = ? AND project_id = ?`).bind(mechId, ctx.projectId).run();
  const removedPositions = Number(before.n) || 0;
  await log?.('delete', 'mechanism', mechId, { name: before.name, removedPositions });
  return ok({ ok: true, removedPositions });
}

export async function reorderMechanisms(request, env, ctx, log) {
  const body = await readJson(request);
  const ids = Array.isArray(body?.ids) ? body.ids : null;
  if (!ids || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string' || !ID_RE.test(id))) {
    return bad('ids 不合法');
  }
  await env.DB.batch(ids.map((id, i) =>
    env.DB.prepare(`UPDATE mechanisms SET "order" = ? WHERE id = ? AND project_id = ?`).bind(i, id, ctx.projectId)));
  await log?.('reorder', 'mechanism', null, { count: ids.length });
  return ok({ ok: true });
}

// ─────────────────────────────────────────────
// 每個 cue 的機關位置（不寫活動紀錄：拖滑桿不洗版，跟物件位置一樣）
// ─────────────────────────────────────────────

/** ctx.mechanism = { id, kind, travel_min, travel_max }（router 已經確認屬於這個專案） */
export async function putCuePosition(request, env, ctx, cueId) {
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  const p = parseCueValue(body.value);
  if (!p.ok) return bad(p.error);
  const m = ctx.mechanism;
  const value = clampValue(p.value, Number(m.travel_min), Number(m.travel_max));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO cue_mechanism_positions (cue_id, mechanism_id, value, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(cue_id, mechanism_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(cueId, m.id, value),
    env.DB.prepare(`UPDATE mechanisms SET edited_at = datetime('now') WHERE id = ?`).bind(m.id),
  ]);
  return ok({ ok: true, value, clamped: value !== p.value });
}

export async function deleteCuePosition(request, env, ctx, cueId) {
  const m = ctx.mechanism;
  const [r] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM cue_mechanism_positions WHERE cue_id = ? AND mechanism_id = ?`).bind(cueId, m.id),
    env.DB.prepare(`UPDATE mechanisms SET edited_at = datetime('now') WHERE id = ?`).bind(m.id),
  ]);
  return ok({ ok: true, removed: r?.meta?.changes || 0 });
}

// ─────────────────────────────────────────────
// 複製 / 匯出匯入 / 新 cue / 常用擺位 / 重置
// ─────────────────────────────────────────────

/** 複製專案：機關（新 id、parent 換成新的）、帶的物件（objIdMap）、每個 cue 的位置（cueIdMap） */
export async function copyMechanismsToProject(env, srcProjectId, dstProjectId, objIdMap, cueIdMap) {
  const exp = await exportMechanisms(env, srcProjectId);
  return importMechanisms(env, dstProjectId, exp, objIdMap, cueIdMap);
}

/** 匯出檔的三個欄位（資料庫原樣的列） */
export async function exportMechanisms(env, projectId) {
  const [mr, or, pr] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM mechanisms WHERE project_id = ? ORDER BY "order" ASC`).bind(projectId),
    env.DB.prepare(
      `SELECT mo.mechanism_id, mo.stage_object_id FROM mechanism_objects mo
         JOIN mechanisms m ON m.id = mo.mechanism_id WHERE m.project_id = ?`
    ).bind(projectId),
    env.DB.prepare(
      `SELECT p.cue_id, p.mechanism_id, p.value FROM cue_mechanism_positions p
         JOIN mechanisms m ON m.id = p.mechanism_id WHERE m.project_id = ?`
    ).bind(projectId),
  ]);
  return {
    mechanisms: mr.results || [],
    mechanismObjects: or.results || [],
    cueMechanismPositions: pr.results || [],
  };
}

/**
 * 匯入（或複製）：重新給 id；物件 / cue 對不到的略過；舊的匯出檔沒有這些欄位 → 什麼都不做
 * 定義先全部檢查一次（壞資料略過），parent 等全部建好再接上
 */
export async function importMechanisms(env, projectId, data, objIdMap, cueIdMap) {
  const mechs = Array.isArray(data?.mechanisms) ? data.mechanisms.slice(0, 500) : [];
  if (!mechs.length) return { mechanisms: 0, objects: 0, positions: 0 };
  const idMap = new Map();
  const rows = [];
  mechs.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return;
    const m = rowToMechanism(raw);
    const n = normalizeMechanismInput({ ...m, parentId: null, objectIds: [] }, {});
    if (!n.ok) return;
    // 從舊滑桿轉來的：換成新物件的 mlx_ / mly_ id（舊網站改滑桿時還找得到、不會多出一個）
    const legacyObj = raw.legacy_object_id && (raw.legacy_axis === 'x' || raw.legacy_axis === 'y')
      ? (objIdMap.get(raw.legacy_object_id) ?? null) : null;
    const id = legacyObj ? (raw.legacy_axis === 'x' ? 'mlx_' : 'mly_') + legacyObj : newId('mech_', i + 1);
    if (legacyObj && rows.some(r => r.id === id)) return;
    idMap.set(raw.id, id);
    rows.push({
      id, c: inputToColumns(n.value), order: m.order, parentOld: m.parentId,
      legacyObj, legacyAxis: legacyObj ? raw.legacy_axis : null,
      // 沒在新介面改過的舊滑桿機關照樣讓舊網站同步；其他一律算改過
      editedAt: legacyObj ? (raw.edited_at ?? null) : 'now',
    });
  });
  const stmts = rows.map(r => env.DB.prepare(
    `INSERT OR IGNORE INTO mechanisms (id, project_id, name, kind, axis, pivot, travel_min, travel_max, default_value, max_speed,
                             presets, parent_id, console_label, "order", metadata, legacy_object_id, legacy_axis, edited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, CASE WHEN ? = 'now' THEN datetime('now') ELSE ? END)`
  ).bind(r.id, projectId, r.c.name, r.c.kind, r.c.axis, r.c.pivot, r.c.travel_min, r.c.travel_max, r.c.default_value,
    r.c.max_speed, r.c.presets, r.c.console_label, r.order, r.c.metadata, r.legacyObj, r.legacyAxis, r.editedAt, r.editedAt));
  for (const r of rows) {
    const p = r.parentOld ? idMap.get(r.parentOld) : null;
    if (p && p !== r.id) stmts.push(env.DB.prepare(`UPDATE mechanisms SET parent_id = ? WHERE id = ?`).bind(p, r.id));
  }
  let objects = 0, positions = 0;
  const seenObj = new Set();
  for (const mo of Array.isArray(data.mechanismObjects) ? data.mechanismObjects : []) {
    const mid = idMap.get(mo?.mechanism_id);
    const oid = objIdMap.get(mo?.stage_object_id);
    if (!mid || !oid || seenObj.has(oid)) continue;
    seenObj.add(oid);
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO mechanism_objects (mechanism_id, stage_object_id) VALUES (?, ?)`).bind(mid, oid));
    objects++;
  }
  for (const p of Array.isArray(data.cueMechanismPositions) ? data.cueMechanismPositions : []) {
    const mid = idMap.get(p?.mechanism_id);
    const cid = cueIdMap.get(p?.cue_id);
    const v = Number(p?.value);
    if (!mid || !cid || !Number.isFinite(v)) continue;
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO cue_mechanism_positions (cue_id, mechanism_id, value) VALUES (?, ?, ?)`).bind(cid, mid, v));
    positions++;
  }
  for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
  return { mechanisms: rows.length, objects, positions };
}

/** 新 cue「沿用」另一個 cue：複製來源 cue 自己設的機關位置（同一個專案） */
export async function cloneCuePositions(env, fromCueId, toCueId) {
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO cue_mechanism_positions (cue_id, mechanism_id, value)
     SELECT ?, mechanism_id, value FROM cue_mechanism_positions WHERE cue_id = ?`
  ).bind(toCueId, fromCueId).run();
  return r?.meta?.changes || 0;
}

/**
 * 新 cue 從目前 3D 畫面建立：前端給每個機關現在的值 { [mechId]: value } → 存成這個 cue 自己的值
 * 不是這個專案的機關略過；夾進行程
 */
export async function snapshotCuePositions(env, projectId, cueId, snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return 0;
  const entries = Object.entries(snapshot).filter(([id, v]) => ID_RE.test(id) && Number.isFinite(Number(v))).slice(0, 500);
  if (!entries.length) return 0;
  const mechs = (await env.DB.prepare(`SELECT id, travel_min, travel_max FROM mechanisms WHERE project_id = ?`).bind(projectId).all()).results || [];
  const byId = new Map(mechs.map(m => [m.id, m]));
  const stmts = [];
  for (const [id, v] of entries) {
    const m = byId.get(id);
    if (!m) continue;
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO cue_mechanism_positions (cue_id, mechanism_id, value) VALUES (?, ?, ?)`)
      .bind(cueId, id, clampValue(Number(v), Number(m.travel_min), Number(m.travel_max))));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

/** 存成常用擺位：這個 cue 自己設的機關位置（用機關名稱存 → 別的專案也套得上） */
export async function templateMechanismPositions(env, cueId) {
  const r = await env.DB.prepare(
    `SELECT m.name, p.value FROM cue_mechanism_positions p JOIN mechanisms m ON m.id = p.mechanism_id WHERE p.cue_id = ?`
  ).bind(cueId).all();
  return (r.results || []).map(x => ({ name: x.name, value: Number(x.value) }));
}

/** 套用常用擺位 / 從別的專案匯入 cue：用機關名稱對到這個專案的機關（夾進行程）；對不到的略過 */
export async function applyNamedPositions(env, projectId, cueId, list) {
  if (!Array.isArray(list) || !list.length) return 0;
  const mechs = (await env.DB.prepare(`SELECT id, name, travel_min, travel_max FROM mechanisms WHERE project_id = ?`).bind(projectId).all()).results || [];
  const byName = new Map(mechs.map(m => [String(m.name).trim(), m]));
  const stmts = [];
  for (const p of list.slice(0, 500)) {
    const m = byName.get(String(p?.name ?? '').trim());
    const v = Number(p?.value);
    if (!m || !Number.isFinite(v)) continue;
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO cue_mechanism_positions (cue_id, mechanism_id, value) VALUES (?, ?, ?)`)
      .bind(cueId, m.id, clampValue(v, Number(m.travel_min), Number(m.travel_max))));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

/** 從別首歌匯入 cue：同一個專案用機關 id，別的專案用機關名稱 */
export async function copyCuePositionsAcross(env, { srcProjectId, dstProjectId, srcCueId, dstCueId }) {
  if (srcProjectId === dstProjectId) return cloneCuePositions(env, srcCueId, dstCueId);
  return applyNamedPositions(env, dstProjectId, dstCueId, await templateMechanismPositions(env, srcCueId));
}

/** 重置 cue：這個 cue 自己設的機關位置也清掉（回到沿用上一個 cue）；有清到的機關算改過 */
export async function clearCuePositions(env, cueId) {
  const [, r] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE mechanisms SET edited_at = datetime('now') WHERE id IN (SELECT mechanism_id FROM cue_mechanism_positions WHERE cue_id = ?)`
    ).bind(cueId),
    env.DB.prepare(`DELETE FROM cue_mechanism_positions WHERE cue_id = ?`).bind(cueId),
  ]);
  return r?.meta?.changes || 0;
}

/** 清除所有物件之前：這個專案有幾個「機關裡選的物件」會被清掉 */
export async function countMechanismObjects(env, projectId) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM mechanism_objects mo JOIN mechanisms m ON m.id = mo.mechanism_id WHERE m.project_id = ?`
  ).bind(projectId).first();
  return Number(r?.n) || 0;
}

// ─────────────────────────────────────────────
// 把現有 cue 裡物件的位置轉成這個機關的位置（升降台 / 轉台以前是一個 cue 一個 cue 手動擺的）
// ─────────────────────────────────────────────

/**
 * POST /mechanisms/:mechId/convert-cue-positions  body: { dryRun?: true }
 * 只有還沒有任何 cue 設過位置的機關可以轉（不然沿用的關係會亂掉）。
 * 每首歌照順序走：每個 cue 量「第一個物件」離預設位置差多少（沿著方向 / 繞著轉軸）→ 變成這個 cue 的機關位置，
 * 物件自己存的位置扣掉這一段；畫面上看起來一模一樣。物件動法不一致的 cue 不轉（列出來）。
 */
export async function convertCuePositions(request, env, ctx, mechId, log) {
  const body = (await readJson(request)) || {};
  const dryRun = body.dryRun === true;
  const [mech] = await loadMechanisms(env, ctx.projectId, mechId);
  if (!mech) return bad('這個專案裡找不到這個機關', 404);
  if (mech.cueCount > 0) return bad('這個機關已經有 cue 設了位置，只有還沒在 cue 裡設過位置的機關可以轉', 409);
  if (!mech.objectIds.length) return bad('這個機關還沒有選要帶的物件', 400);
  const pid = ctx.projectId;
  const ph = mech.objectIds.map(() => '?').join(',');
  const [projR, objR, songR, cueR, rowR] = await env.DB.batch([
    env.DB.prepare(`SELECT scale_correction FROM projects WHERE id = ?`).bind(pid),
    env.DB.prepare(`SELECT id, default_position, default_rotation FROM stage_objects WHERE project_id = ? AND id IN (${ph})`).bind(pid, ...mech.objectIds),
    env.DB.prepare(`SELECT id, name FROM songs WHERE project_id = ?`).bind(pid),
    env.DB.prepare(
      `SELECT c.id, c.song_id, c.name, c."order", c.status, c.created_at FROM cues c JOIN songs s ON s.id = c.song_id
        WHERE s.project_id = ? ORDER BY c."order" ASC, c.created_at ASC`
    ).bind(pid),
    env.DB.prepare(
      `SELECT cos.id, cos.cue_id, cos.stage_object_id, cos.position, cos.rotation, cos.scale, cos.visible, cos.custom_props
         FROM cue_object_states cos JOIN cues c ON c.id = cos.cue_id JOIN songs s ON s.id = c.song_id
        WHERE s.project_id = ? AND cos.stage_object_id IN (${ph})`
    ).bind(pid, ...mech.objectIds),
  ]);
  const scale = Number(projR.results?.[0]?.scale_correction) || 1;
  const objects = (objR.results || []).map(o => ({
    id: o.id,
    defaultPosition: parseJson(o.default_position, { x: 0, y: 0, z: 0 }),
    defaultRotation: parseJson(o.default_rotation, { pitch: 0, yaw: 0, roll: 0 }),
  }));
  // 照 mechanism.objectIds 的順序（第一個 = 參考物件）
  objects.sort((a, b) => mech.objectIds.indexOf(a.id) - mech.objectIds.indexOf(b.id));
  const songName = new Map((songR.results || []).map(s => [s.id, s.name]));
  const cues = (cueR.results || []).map(c => ({ id: c.id, songId: c.song_id, name: c.name, order: Number(c.order) || 0, status: c.status }));
  const rows = (rowR.results || []).map(r => ({
    id: r.id, cueId: r.cue_id, objectId: r.stage_object_id,
    position: parseJson(r.position, null), rotation: parseJson(r.rotation, null),
    scale: r.scale, visible: r.visible, customProps: r.custom_props,
  }));
  const plan = planCueConversion({ mechanism: mech, objects, cues, rows, scaleCorrection: scale });
  const cueName = new Map(cues.map(c => [c.id, `${songName.get(c.songId) || ''} · ${c.name}`]));
  const summary = {
    converted: plan.converted.length,
    skipped: plan.skipped.map(s => ({ cueId: s.cueId, name: cueName.get(s.cueId) || s.cueId, reason: s.reason })),
    positions: plan.positions.length,
    rowsChanged: plan.rowUpdates.length + plan.rowInserts.length,
  };
  if (dryRun) return ok({ ok: true, dryRun: true, ...summary });

  const stmts = [];
  for (const u of plan.rowUpdates) {
    stmts.push(env.DB.prepare(`UPDATE cue_object_states SET position = ?, rotation = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(JSON.stringify(u.position), JSON.stringify(u.rotation), u.rowId));
  }
  plan.rowInserts.forEach((r, i) => {
    stmts.push(env.DB.prepare(
      `INSERT INTO cue_object_states (id, cue_id, stage_object_id, position, rotation, scale, visible, custom_props)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(newId('cos_', i + 1), r.cueId, r.objectId, JSON.stringify(r.position), JSON.stringify(r.rotation),
      r.scale ?? null, r.visible ?? 1, r.customProps ?? null));
  });
  for (const p of plan.positions) {
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO cue_mechanism_positions (cue_id, mechanism_id, value) VALUES (?, ?, ?)`)
      .bind(p.cueId, mechId, p.value));
  }
  stmts.push(env.DB.prepare(`UPDATE mechanisms SET edited_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).bind(mechId));
  for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
  await log?.('update', 'mechanism', mechId, { name: mech.name, convertedCues: summary.converted, skippedCues: summary.skipped.length });
  return ok({ ok: true, ...summary });
}
