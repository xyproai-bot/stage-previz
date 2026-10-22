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
  normalizeMechanismInput, mechanismToInput, parseCuePositionBody, parseTimingSeconds, clampValue, MECH_MESSAGES,
} from '../web/src/lib/mechanisms/model.ts';
import { planCueConversion } from '../web/src/lib/mechanisms/convert.ts';
import { planBatch, planGroupPatch, groupMembers, parseBulkPositions, isNumbering } from '../web/src/lib/mechanisms/group.ts';
import { planHoistRig } from '../web/src/lib/mechanisms/hoistRig.ts';
import { hoistGeometryProblem, hoistsOfRig } from '../web/src/lib/mechanisms/hoist.ts';

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

/**
 * mechanisms 一列 → API 的 Mechanism
 * sides：{ [物件 id]: 'a' | 'b' }（mechanism_objects.side；只有對開的機關用，沒寫 = A 邊）
 */
export function rowToMechanism(row, objectIds = [], cueCount = 0, sides = {}) {
  const vec = (v, fb) => {
    const o = typeof v === 'string' ? parseJson(v, null) : v;
    return o && Number.isFinite(Number(o.x)) && Number.isFinite(Number(o.y)) && Number.isFinite(Number(o.z))
      ? { x: Number(o.x), y: Number(o.y), z: Number(o.z) } : fb;
  };
  // 對開（0030）：B 邊的方向 / 轉軸中心 / 控台編號；壞掉的 mirror → 直線用反方向，旋轉當一般機關
  const isRotary = row.kind === 'rotary';
  const axisA = vec(row.axis, { x: 0, y: 1, z: 0 });
  const mraw = row.variant === 'split' ? parseJson(row.mirror, null) : null;
  let variant = row.variant === 'split' || row.variant === 'hoist_rig' || row.variant === 'hoist' ? row.variant : null;
  // 吊掛（0032）：吊點要有所屬的整組和位置，不然當一般機關（沒有物件，不會動到任何東西）
  const attach = vec(row.attach, null);
  if (variant === 'hoist' && (!attach || !row.rig_id)) variant = null;
  let mirror = null;
  if (variant === 'split') {
    const mAxis = mraw ? vec(mraw.axis, null) : null;
    const mPivot = mraw ? vec(mraw.pivot, null) : null;
    if (!isRotary) {
      mirror = { axis: mAxis ?? { x: -axisA.x || 0, y: -axisA.y || 0, z: -axisA.z || 0 }, pivot: null, consoleLabel: null };
    } else if (mAxis && mPivot) {
      mirror = { axis: mAxis, pivot: mPivot, consoleLabel: null };
    } else variant = null;
    if (mirror && mraw && typeof mraw.consoleLabel === 'string' && mraw.consoleLabel.trim()) mirror.consoleLabel = mraw.consoleLabel.trim();
  }
  const objectSides = {};
  if (variant === 'split') for (const id of objectIds) objectSides[id] = sides[id] === 'b' ? 'b' : 'a';
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
    variant,
    mirror,
    objectSides,
    // 吊掛（0032）：只有吊點有；舊資料 / 舊後台沒有 → null
    rigId: variant === 'hoist' ? row.rig_id : null,
    rigIndex: variant === 'hoist' && row.rig_index != null && Number.isFinite(Number(row.rig_index)) ? Number(row.rig_index) : null,
    attach: variant === 'hoist' ? attach : null,
    // 一排（0031）：舊資料 / 舊後台沒有 → null
    groupId: row.group_id || null,
    groupIndex: Number.isFinite(Number(row.group_index)) && row.group_index !== null ? Number(row.group_index) : null,
  };
}

/** mechanism_groups 一列 → API 的 MechanismGroup */
export function rowToGroup(row) {
  const st = parseJson(row.settings, null);
  const settings = {};
  if (st && typeof st === 'object' && !Array.isArray(st)) {
    if (typeof st.namePrefix === 'string' && st.namePrefix.trim()) settings.namePrefix = st.namePrefix.trim().slice(0, 40);
    if (isNumbering(st.numbering)) settings.numbering = st.numbering;
  }
  return {
    id: row.id, name: row.name, order: Number(row.order) || 0,
    settings: Object.keys(settings).length ? settings : null, updatedAt: row.updated_at,
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
    variant: v.variant === 'split' || v.variant === 'hoist_rig' || v.variant === 'hoist' ? v.variant : null,
    mirror: v.variant === 'split' && v.mirror ? JSON.stringify(v.mirror) : null,
    rig_id: v.variant === 'hoist' ? v.rigId ?? null : null,
    rig_index: v.variant === 'hoist' ? v.rigIndex ?? null : null,
    attach: v.variant === 'hoist' && v.attach ? JSON.stringify(v.attach) : null,
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

/**
 * 這個專案的機關（照順序；含帶哪些物件、幾個 cue 有設定）
 * mech2：呼叫的畫面看得懂機關 v2（網址帶 ?mech=2）。false（還在跑的舊版前端）→ 不給對開這類 variant 不是空的機關，
 *   它帶的零件在舊版畫面是靜止的，不會往錯的方向動；只查一個 id（新增 / 修改後回傳）一律給
 */
export async function loadMechanisms(env, projectId, onlyId = null, { mech2 = true, mech3 = mech2 } = {}) {
  const cond = variantCond('m', { mech2, mech3 });
  const where = (onlyId ? 'm.project_id = ? AND m.id = ?' : 'm.project_id = ?') + (cond && !onlyId ? ` AND ${cond}` : '');
  const binds = onlyId ? [projectId, onlyId] : [projectId];
  const [mr, or] = await env.DB.batch([
    env.DB.prepare(
      `SELECT m.*, (SELECT COUNT(*) FROM cue_mechanism_positions p WHERE p.mechanism_id = m.id) AS cue_count
         FROM mechanisms m WHERE ${where} ORDER BY m."order" ASC, m.created_at ASC, m.id ASC`
    ).bind(...binds),
    env.DB.prepare(
      `SELECT mo.mechanism_id, mo.stage_object_id, mo.side
         FROM mechanism_objects mo
         JOIN mechanisms m ON m.id = mo.mechanism_id
         JOIN stage_objects o ON o.id = mo.stage_object_id
        WHERE ${where}
        ORDER BY o."order" ASC, o.created_at ASC`
    ).bind(...binds),
  ]);
  const objs = new Map();
  const sides = new Map();
  for (const r of or.results || []) {
    const list = objs.get(r.mechanism_id) || [];
    list.push(r.stage_object_id);
    objs.set(r.mechanism_id, list);
    if (r.side === 'b') {
      const m = sides.get(r.mechanism_id) || {};
      m[r.stage_object_id] = 'b';
      sides.set(r.mechanism_id, m);
    }
  }
  // Cue 庫模式的專案：「幾個 cue 有設定」數 Cue 庫的列（舊模式的專案照舊數 cue_mechanism_positions；還沒有 0042 的資料庫整段略過）
  const libCounts = await libraryCueCounts(env, projectId);
  return (mr.results || []).map(r => rowToMechanism(r, objs.get(r.id) || [], libCounts ? (libCounts.get(r.id) || 0) : r.cue_count, sides.get(r.id) || {}));
}

/** Cue 庫模式的專案：機關 id → 幾個 Cue 庫的 cue 有設定它；舊模式（或還沒有 0042）回 null */
async function libraryCueCounts(env, projectId) {
  try {
    const p = await env.DB.prepare(`SELECT cue_library FROM projects WHERE id = ? LIMIT 1`).bind(projectId).first();
    if (Number(p?.cue_library) !== 1) return null;
    const r = await env.DB.prepare(
      `SELECT lp.mechanism_id, COUNT(*) AS n FROM library_cue_mechanism_positions lp
         JOIN mechanisms m ON m.id = lp.mechanism_id WHERE m.project_id = ? GROUP BY lp.mechanism_id`
    ).bind(projectId).all();
    return new Map((r.results || []).map(x => [x.mechanism_id, Number(x.n)]));
  } catch { return null; }
}

/** 網址帶 ?mech=N → 這個畫面看得懂機關 v2 的第幾級（沒帶 / 不是數字 = 0） */
export function mechLevel(request) {
  try { const n = Number(new URL(request.url).searchParams.get('mech')); return Number.isFinite(n) ? n : 0; } catch { return 0; }
}
/** ?mech=2 以上 → 看得懂對開 */
export function wantsMech2(request) { return mechLevel(request) >= 2; }
/** ?mech=3 以上 → 看得懂吊掛（正式站上 ?mech=2 的版本看不懂 'hoist_rig' / 'hoist'，不給它） */
export function wantsMech3(request) { return mechLevel(request) >= 3; }

/**
 * 讀機關 / 位置時 variant 的條件（SQL，沒有條件 = ''）：
 *   沒有 mech2 → 只給一般機關；mech2 沒有 mech3 → 一般 + 對開；都有 → 全部
 */
function variantCond(alias, { mech2, mech3 }) {
  if (!mech2) return `${alias}.variant IS NULL`;
  if (!mech3) return `(${alias}.variant IS NULL OR ${alias}.variant = 'split')`;
  return '';
}

/** 這個專案的「一排」機關（照順序） */
export async function loadMechanismGroups(env, projectId) {
  const r = await env.DB.prepare(
    `SELECT id, name, "order", settings, updated_at FROM mechanism_groups WHERE project_id = ? ORDER BY "order" ASC, created_at ASC, id ASC`
  ).bind(projectId).all();
  return (r.results || []).map(rowToGroup);
}

export async function listMechanisms(env, ctx, { mech2 = true, mech3 = mech2 } = {}) {
  // groups：只給新版畫面（網址帶 ?mech=2）；舊版前端的回應跟以前一模一樣
  const mechanisms = await loadMechanisms(env, ctx.projectId, null, { mech2, mech3 });
  return ok(mech2 ? { mechanisms, groups: await loadMechanismGroups(env, ctx.projectId) } : { mechanisms });
}

/** 一首歌每個 cue 自己設的機關位置；masterOnly = 分享連結（只看得到正式 cue） */
export async function loadSongPositions(env, songId, { masterOnly = false, mech2 = true, mech3 = mech2 } = {}) {
  const cond = variantCond('m', { mech2, mech3 });
  const r = await env.DB.prepare(
    `SELECT p.cue_id, p.mechanism_id, p.value, p.delay_sec, p.duration_sec, p.updated_at
       FROM cue_mechanism_positions p
       JOIN cues c ON c.id = p.cue_id
       ${cond ? `JOIN mechanisms m ON m.id = p.mechanism_id AND ${cond}` : ''}
      WHERE c.song_id = ?${masterOnly ? ` AND c.status = 'master'` : ''}
      ORDER BY c."order" ASC`
  ).bind(songId).all();
  return (r.results || []).map(rowToPosition);
}

const secOrNull = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

/** 一列 → API（v2：多 delaySec / durationSec，null = 跟著 cue） */
function rowToPosition(r) {
  return {
    cueId: r.cue_id, mechanismId: r.mechanism_id, value: Number(r.value),
    delaySec: secOrNull(r.delay_sec), durationSec: secOrNull(r.duration_sec), updatedAt: r.updated_at,
  };
}

export async function listSongPositions(env, ctx, songId, { mech2 = true, mech3 = mech2 } = {}) {
  return ok({ positions: await loadSongPositions(env, songId, { mech2, mech3 }) });
}

/** 機關總表：整個專案每首歌的正式 cue + 每個 cue 自己設的位置（一次拿完） */
export async function mechanismSheet(env, ctx, { mech2 = true, mech3 = mech2 } = {}) {
  const pid = ctx.projectId;
  const cond = variantCond('m', { mech2, mech3 });
  const [songsR, cuesR, posR] = await env.DB.batch([
    env.DB.prepare(`SELECT id, name, code, "order" FROM songs WHERE project_id = ? ORDER BY "order" ASC, created_at ASC`).bind(pid),
    env.DB.prepare(
      `SELECT c.id, c.song_id, c.name, c."order", c.video_time_sec, c.crossfade_seconds
         FROM cues c JOIN songs s ON s.id = c.song_id
        WHERE s.project_id = ? AND c.status = 'master'
        ORDER BY c."order" ASC, c.created_at ASC`
    ).bind(pid),
    env.DB.prepare(
      `SELECT p.cue_id, p.mechanism_id, p.value, p.delay_sec, p.duration_sec, p.updated_at
         FROM cue_mechanism_positions p
         JOIN cues c ON c.id = p.cue_id JOIN songs s ON s.id = c.song_id
         ${cond ? `JOIN mechanisms m ON m.id = p.mechanism_id AND ${cond}` : ''}
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
    mechanisms: await loadMechanisms(env, pid, null, { mech2, mech3 }),
  });
}

// ─────────────────────────────────────────────
// 新增 / 修改 / 刪除 / 排序
// ─────────────────────────────────────────────

async function projectFacts(env, projectId) {
  const [sibR, objR, memR] = await env.DB.batch([
    env.DB.prepare(`SELECT id, name, parent_id, variant, rig_id FROM mechanisms WHERE project_id = ?`).bind(projectId),
    env.DB.prepare(`SELECT id, display_name, mesh_name FROM stage_objects WHERE project_id = ?`).bind(projectId),
    env.DB.prepare(
      `SELECT mo.stage_object_id, mo.mechanism_id, m.name AS mechanism_name
         FROM mechanism_objects mo JOIN mechanisms m ON m.id = mo.mechanism_id
        WHERE m.project_id = ?`
    ).bind(projectId),
  ]);
  const objects = objR.results || [];
  return {
    siblings: (sibR.results || []).map(s => ({
      id: s.id, name: s.name, parentId: s.parent_id || null,
      variant: s.variant === 'split' || s.variant === 'hoist_rig' || s.variant === 'hoist' ? s.variant : null, rigId: s.rig_id || null,
    })),
    projectObjectIds: new Set(objects.map(o => o.id)),
    objectNames: new Map(objects.map(o => [o.id, (o.display_name && String(o.display_name).trim()) || o.mesh_name])),
    memberships: memR.results || [],
  };
}

/** 新增或修改共用：檢查 → 物件衝突 → 寫進資料庫的語句 */
function membershipStatements(env, mechId, objectIds, conflicts, sides = {}) {
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
    // side：只有對開的機關有（'a' / 'b'）；一般機關 NULL
    stmts.push(env.DB.prepare(`INSERT INTO mechanism_objects (mechanism_id, stage_object_id, side) VALUES (?, ?, ?)`).bind(mechId, oid, sides[oid] ?? null));
  }
  return stmts;
}

export async function createMechanism(request, env, ctx, log) {
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  // 吊掛（0032）：整組 + 吊點一次建立；吊點不能單獨新增
  if (body.variant === 'hoist') return bad(MECH_MESSAGES.hoistVariantLocked, 400, { field: 'variant' });
  if (body.variant === 'hoist_rig') return createHoistRig(body, env, ctx, log);
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
                               presets, parent_id, console_label, "order", metadata, variant, mirror, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(id, ctx.projectId, c.name, c.kind, c.axis, c.pivot, c.travel_min, c.travel_max, c.default_value, c.max_speed,
      c.presets, c.parent_id, c.console_label, order, c.metadata, c.variant, c.mirror),
    ...membershipStatements(env, id, v.objectIds, conflicts, v.variant === 'split' ? v.objectSides : {}),
  ];
  await env.DB.batch(stmts);
  await log?.('create', 'mechanism', id, { name: v.name, objects: v.objectIds.length, moved: conflicts.length || undefined, variant: v.variant || undefined });
  const [mechanism] = await loadMechanisms(env, ctx.projectId, id);
  return ok({ mechanism }, 201);
}

/** 吊點的這些欄位不能從單獨修改改（位置、屬於哪一組、整組的樣子要用「編輯吊掛」整組一起改） */
const HOIST_LOCKED_KEYS = ['variant', 'rigId', 'rigIndex', 'attach', 'kind', 'axis', 'pivot', 'objectIds', 'parentId', 'mirror', 'objectSides'];
const isHoistVariant = (v) => v === 'hoist' || v === 'hoist_rig';

export async function updateMechanism(request, env, ctx, mechId, log) {
  let body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  const [existing] = await loadMechanisms(env, ctx.projectId, mechId);
  if (!existing) return bad('這個專案裡找不到這個機關', 404);
  // 吊掛（0032）：一般機關不能改成吊掛、吊掛也不能改回一般
  if (body.variant !== undefined && (body.variant ?? null) !== (existing.variant ?? null)
    && (isHoistVariant(body.variant) || isHoistVariant(existing.variant))) {
    return bad(MECH_MESSAGES.hoistVariantLocked, 400, { field: 'variant' });
  }
  if (existing.variant === 'hoist_rig') return updateHoistRig(body, env, ctx, existing, log);
  if (existing.variant === 'hoist') {
    body = { ...body };
    for (const k of HOIST_LOCKED_KEYS) delete body[k];
  }
  const facts = await projectFacts(env, ctx.projectId);
  const n = normalizeMechanismInput(body, {
    existing: mechanismToInput(existing), selfId: mechId, siblings: facts.siblings, projectObjectIds: facts.projectObjectIds,
  });
  if (!n.ok) return bad(n.error, 400, { field: n.field });
  const v = n.value;
  // 換成對開 / 改回一般 / 換邊，也要重寫物件那一列（side 在 mechanism_objects 上）
  const touchesObjects = Array.isArray(body.objectIds) || body.objectSides !== undefined || body.variant !== undefined;
  const conflicts = touchesObjects ? findObjectConflicts(v.objectIds, facts.memberships, facts.objectNames, mechId) : [];
  if (conflicts.length && body.moveObjects !== true) return bad(conflictMessage(conflicts[0]), 409, { conflicts });

  const c = inputToColumns(v);
  const stmts = [
    env.DB.prepare(
      `UPDATE mechanisms SET name = ?, kind = ?, axis = ?, pivot = ?, travel_min = ?, travel_max = ?, default_value = ?,
              max_speed = ?, presets = ?, parent_id = ?, console_label = ?, metadata = ?, variant = ?, mirror = ?,
              edited_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND project_id = ?`
    ).bind(c.name, c.kind, c.axis, c.pivot, c.travel_min, c.travel_max, c.default_value, c.max_speed, c.presets,
      c.parent_id, c.console_label, c.metadata, c.variant, c.mirror, mechId, ctx.projectId),
    ...(touchesObjects ? membershipStatements(env, mechId, v.objectIds, conflicts, v.variant === 'split' ? v.objectSides : {}) : []),
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
    `SELECT m.name, m.group_id, m.variant, (SELECT COUNT(*) FROM cue_mechanism_positions p WHERE p.mechanism_id = m.id) AS n
       FROM mechanisms m WHERE m.id = ? AND m.project_id = ?`
  ).bind(mechId, ctx.projectId).first();
  if (!before) return bad('這個專案裡找不到這個機關', 404);
  // 吊掛（0032）：吊點不能單獨刪（整組至少要 2 個吊點）；刪整組 = 連吊點和它們每個 cue 的位置一起刪
  if (before.variant === 'hoist') return bad(MECH_MESSAGES.hoistDeleteOne, 400);
  const stmts = [];
  let hoistPositions = 0;
  if (before.variant === 'hoist_rig') {
    const hp = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM cue_mechanism_positions p JOIN mechanisms x ON x.id = p.mechanism_id WHERE x.rig_id = ?`
    ).bind(mechId).first();
    hoistPositions = Number(hp?.n) || 0;
    stmts.push(env.DB.prepare(`DELETE FROM mechanisms WHERE rig_id = ? AND project_id = ?`).bind(mechId, ctx.projectId));
  }
  stmts.push(env.DB.prepare(`DELETE FROM mechanisms WHERE id = ? AND project_id = ?`).bind(mechId, ctx.projectId));
  // 一排裡最後一個機關刪掉了 → 這一排也不留空殼（舊版前端刪機關也走這裡）
  if (before.group_id) {
    stmts.push(env.DB.prepare(
      `DELETE FROM mechanism_groups WHERE id = ? AND project_id = ? AND NOT EXISTS (SELECT 1 FROM mechanisms WHERE group_id = mechanism_groups.id)`
    ).bind(before.group_id, ctx.projectId));
  }
  await env.DB.batch(stmts);
  const removedPositions = (Number(before.n) || 0) + hoistPositions;
  await log?.('delete', 'mechanism', mechId, { name: before.name, removedPositions, variant: before.variant || undefined });
  return ok({ ok: true, removedPositions });
}

// ─────────────────────────────────────────────
// 吊掛（0032）：整組 + 2～4 個吊點一次新增 / 修改
// ─────────────────────────────────────────────

const insertMechanismRow = (env, id, projectId, c, order, rigId = null) => env.DB.prepare(
  `INSERT INTO mechanisms (id, project_id, name, kind, axis, pivot, travel_min, travel_max, default_value, max_speed,
                           presets, parent_id, console_label, "order", metadata, variant, mirror, rig_id, rig_index, attach, edited_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, datetime('now'))`
).bind(id, projectId, c.name, c.kind, c.axis, c.pivot, c.travel_min, c.travel_max, c.default_value, c.max_speed,
  c.presets, c.parent_id, c.console_label, order, c.metadata, c.variant, rigId, c.rig_index, c.attach);

async function nextMechanismOrder(env, projectId) {
  const maxRow = await env.DB.prepare(`SELECT COALESCE(MAX("order"), -1) AS m FROM mechanisms WHERE project_id = ?`).bind(projectId).first();
  const maxOrder = Number(maxRow?.m);
  return Number.isFinite(maxOrder) ? maxOrder + 1 : 0;
}

/**
 * POST …/mechanisms  body: { variant: 'hoist_rig', name, objectIds, parentId?, hoists: [{ name?, attach, travelMin?, travelMax?, maxSpeed?, consoleLabel?, defaultValue?, presets? }], moveObjects? }
 * 一個交易建好整組和 2～4 個吊點；物件已經在別的機關 → 409（跟單獨新增一樣，問使用者後帶 moveObjects: true 再送）。
 * 回 201 { mechanism（整組）, hoists }
 */
async function createHoistRig(body, env, ctx, log) {
  const facts = await projectFacts(env, ctx.projectId);
  const plan = planHoistRig(body, { siblings: facts.siblings, projectObjectIds: facts.projectObjectIds });
  if (!plan.ok) return bad(plan.error, 400, { field: plan.field });
  const { rig, hoists } = plan.value;
  const conflicts = findObjectConflicts(rig.objectIds, facts.memberships, facts.objectNames, null);
  if (conflicts.length && body.moveObjects !== true) return bad(conflictMessage(conflicts[0]), 409, { conflicts });
  const first = await nextMechanismOrder(env, ctx.projectId);
  const rigId = newId('mech_');
  const stmts = [
    insertMechanismRow(env, rigId, ctx.projectId, inputToColumns(rig), first),
    ...membershipStatements(env, rigId, rig.objectIds, conflicts, {}),
  ];
  const hoistIds = hoists.map((h, i) => {
    const id = newId('mech_', i + 1);
    stmts.push(insertMechanismRow(env, id, ctx.projectId, inputToColumns(h.input), first + 1 + i, rigId));
    return id;
  });
  await env.DB.batch(stmts);
  await log?.('create', 'mechanism', rigId, { name: rig.name, variant: 'hoist_rig', objects: rig.objectIds.length, hoists: hoists.length, moved: conflicts.length || undefined });
  const all = await loadMechanisms(env, ctx.projectId);
  return ok({ mechanism: all.find(m => m.id === rigId), hoists: hoistsOfRig(all, rigId) }, 201);
}

/**
 * PATCH …/mechanisms/:rig  body: { name?, objectIds?, parentId?, metadata?, hoists? }
 * hoists 有送 = 整個換成這份清單：有 id 的改那個吊點、沒有 id 的新增、原本有卻沒列出來的刪掉（連同每個 cue 的位置）。
 * 回 { mechanism, hoists, outOfRangeCount }
 */
async function updateHoistRig(body, env, ctx, existing, log) {
  const all = await loadMechanisms(env, ctx.projectId);
  const facts = await projectFacts(env, ctx.projectId);
  const plan = planHoistRig(body, {
    existing: { rig: existing, hoists: hoistsOfRig(all, existing.id) },
    siblings: facts.siblings, projectObjectIds: facts.projectObjectIds,
  });
  if (!plan.ok) return bad(plan.error, 400, { field: plan.field });
  const { rig, hoists, removeIds, hoistsTouched } = plan.value;
  const touchesObjects = Array.isArray(body.objectIds);
  const conflicts = touchesObjects ? findObjectConflicts(rig.objectIds, facts.memberships, facts.objectNames, existing.id) : [];
  if (conflicts.length && body.moveObjects !== true) return bad(conflictMessage(conflicts[0]), 409, { conflicts });

  const rc = inputToColumns(rig);
  const stmts = [
    env.DB.prepare(
      `UPDATE mechanisms SET name = ?, parent_id = ?, metadata = ?, edited_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND project_id = ?`
    ).bind(rc.name, rc.parent_id, rc.metadata, existing.id, ctx.projectId),
    ...(touchesObjects ? membershipStatements(env, existing.id, rig.objectIds, conflicts, {}) : []),
  ];
  if (hoistsTouched) {
    for (const id of removeIds) stmts.push(env.DB.prepare(`DELETE FROM mechanisms WHERE id = ? AND rig_id = ? AND project_id = ?`).bind(id, existing.id, ctx.projectId));
    let next = await nextMechanismOrder(env, ctx.projectId);
    hoists.forEach((h, i) => {
      const c = inputToColumns(h.input);
      if (h.id) {
        stmts.push(env.DB.prepare(
          `UPDATE mechanisms SET name = ?, travel_min = ?, travel_max = ?, default_value = ?, max_speed = ?, presets = ?, console_label = ?,
                  attach = ?, rig_index = ?, edited_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ? AND rig_id = ? AND project_id = ?`
        ).bind(c.name, c.travel_min, c.travel_max, c.default_value, c.max_speed, c.presets, c.console_label, c.attach, i, h.id, existing.id, ctx.projectId));
      } else {
        stmts.push(insertMechanismRow(env, newId('mech_', i + 1), ctx.projectId, c, next++, existing.id));
      }
    });
  }
  await env.DB.batch(stmts);
  const out = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM cue_mechanism_positions p JOIN mechanisms m ON m.id = p.mechanism_id
      WHERE m.rig_id = ? AND (p.value < m.travel_min OR p.value > m.travel_max)`
  ).bind(existing.id).first();
  const changes = {};
  for (const k of Object.keys(body)) if (k !== 'moveObjects') changes[k] = k === 'hoists' ? `${hoists.length} 個吊點` : body[k];
  await log?.('update', 'mechanism', existing.id, { name: rig.name, changes });
  const fresh = await loadMechanisms(env, ctx.projectId);
  return ok({ mechanism: fresh.find(m => m.id === existing.id), hoists: hoistsOfRig(fresh, existing.id), outOfRangeCount: Number(out?.n) || 0 });
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
// 一排機關（0031）：一次建立 N 個、改名 / 共用設定、解散 / 刪掉
// ─────────────────────────────────────────────

/**
 * POST /mechanisms/batch  body: { base, objectIds, namePrefix, groupName?, numbering?, overrides?, moveObjects? }
 * 一個物件一個機關（照 objectIds 的順序編 1、2、3…），放進同一排；每個機關都是普通機關，用單獨新增一樣的規則檢查。
 * 物件已經在別的機關 → 409（跟單獨新增一樣，問使用者後帶 moveObjects: true 再送）。
 * 回 201 { group, mechanisms }
 */
export async function createMechanismBatch(request, env, ctx, log) {
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  const facts = await projectFacts(env, ctx.projectId);
  const groups = await loadMechanismGroups(env, ctx.projectId);
  const plan = planBatch(body, {
    siblings: facts.siblings, projectObjectIds: facts.projectObjectIds, groupNames: groups.map(g => g.name),
  });
  if (!plan.ok) return bad(plan.error, 400, { field: plan.field });
  const { groupName, settings, members } = plan.value;
  const allObjects = members.flatMap(m => m.objectIds);
  const conflicts = findObjectConflicts(allObjects, facts.memberships, facts.objectNames, null);
  if (conflicts.length && body.moveObjects !== true) return bad(conflictMessage(conflicts[0]), 409, { conflicts });

  const maxM = Number((await env.DB.prepare(`SELECT COALESCE(MAX("order"), -1) AS m FROM mechanisms WHERE project_id = ?`).bind(ctx.projectId).first())?.m);
  const maxG = Number((await env.DB.prepare(`SELECT COALESCE(MAX("order"), -1) AS m FROM mechanism_groups WHERE project_id = ?`).bind(ctx.projectId).first())?.m);
  const firstOrder = Number.isFinite(maxM) ? maxM + 1 : 0;
  const groupId = newId('mgrp_');
  const stmts = [
    env.DB.prepare(`INSERT INTO mechanism_groups (id, project_id, name, "order", settings) VALUES (?, ?, ?, ?, ?)`)
      .bind(groupId, ctx.projectId, groupName, Number.isFinite(maxG) ? maxG + 1 : 0, JSON.stringify(settings)),
  ];
  // 從別的機關移過來：那些機關算「在新介面改過」
  for (const c of conflicts) {
    stmts.push(env.DB.prepare(`DELETE FROM mechanism_objects WHERE stage_object_id = ? AND mechanism_id = ?`).bind(c.objectId, c.mechanismId));
  }
  for (const mid of new Set(conflicts.map(c => c.mechanismId))) {
    stmts.push(env.DB.prepare(`UPDATE mechanisms SET edited_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).bind(mid));
  }
  members.forEach((v, i) => {
    const id = newId('mech_', i + 1);
    const c = inputToColumns(v);
    stmts.push(env.DB.prepare(
      `INSERT INTO mechanisms (id, project_id, name, kind, axis, pivot, travel_min, travel_max, default_value, max_speed,
                               presets, parent_id, console_label, "order", metadata, variant, mirror, group_id, group_index, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).bind(id, ctx.projectId, c.name, c.kind, c.axis, c.pivot, c.travel_min, c.travel_max, c.default_value, c.max_speed,
      c.presets, c.parent_id, c.console_label, firstOrder + i, c.metadata, null, null, groupId, i));
    for (const oid of v.objectIds) {
      stmts.push(env.DB.prepare(`INSERT INTO mechanism_objects (mechanism_id, stage_object_id, side) VALUES (?, ?, NULL)`).bind(id, oid));
    }
  });
  await env.DB.batch(stmts);
  await log?.('bulk_create', 'mechanism', groupId, { name: groupName, count: members.length, moved: conflicts.length || undefined });
  const [group] = (await loadMechanismGroups(env, ctx.projectId)).filter(g => g.id === groupId);
  const mechanisms = groupMembers(await loadMechanisms(env, ctx.projectId), groupId);
  return ok({ group, mechanisms }, 201);
}

/**
 * PATCH /mechanism-groups/:g  body: { name?, travelMin?, travelMax?, defaultValue?, maxSpeed?, presets? }
 * name = 這一排的名字；其他是共用設定 → 這一排每個機關都改成一樣（每個都用單獨修改的規則檢查）
 * 回 { group, mechanisms, outOfRangeCount }（有幾個 cue 存的位置超出新的行程）
 */
export async function updateMechanismGroup(request, env, ctx, groupId, log) {
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  const groups = await loadMechanismGroups(env, ctx.projectId);
  const group = groups.find(g => g.id === groupId);
  if (!group) return bad('這個專案裡找不到這一排機關', 404);
  const members = groupMembers(await loadMechanisms(env, ctx.projectId), groupId);
  const facts = await projectFacts(env, ctx.projectId);
  const plan = planGroupPatch(body, members, { siblings: facts.siblings, otherGroupNames: groups.filter(g => g.id !== groupId).map(g => g.name) });
  if (!plan.ok) return bad(plan.error, 400, { field: plan.field });
  const { name, shared, members: updates } = plan.value;
  const stmts = [];
  if (name !== null) {
    stmts.push(env.DB.prepare(`UPDATE mechanism_groups SET name = ?, updated_at = datetime('now') WHERE id = ? AND project_id = ?`).bind(name, groupId, ctx.projectId));
  }
  for (const u of updates) {
    const c = inputToColumns(u.input);
    stmts.push(env.DB.prepare(
      `UPDATE mechanisms SET travel_min = ?, travel_max = ?, default_value = ?, max_speed = ?, presets = ?,
              edited_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ? AND project_id = ?`
    ).bind(c.travel_min, c.travel_max, c.default_value, c.max_speed, c.presets, u.id, ctx.projectId));
  }
  if (stmts.length) await env.DB.batch(stmts);
  const out = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM cue_mechanism_positions p JOIN mechanisms m ON m.id = p.mechanism_id
      WHERE m.group_id = ? AND (p.value < m.travel_min OR p.value > m.travel_max)`
  ).bind(groupId).first();
  const changes = {};
  for (const k of Object.keys(body)) changes[k] = body[k];
  await log?.('update', 'mechanism_group', groupId, { name: name ?? group.name, shared: shared || undefined, changes });
  const [fresh] = (await loadMechanismGroups(env, ctx.projectId)).filter(g => g.id === groupId);
  return ok({ group: fresh, mechanisms: groupMembers(await loadMechanisms(env, ctx.projectId), groupId), outOfRangeCount: Number(out?.n) || 0 });
}

/**
 * DELETE /mechanism-groups/:g[?dissolve=1]
 *   dissolve → 只解散這一排：機關都留著（變成一個一個普通機關），位置和時間不動
 *   沒帶     → 這一排和裡面所有機關一起刪掉（連同每個 cue 的位置）
 */
export async function deleteMechanismGroup(request, env, ctx, groupId, log, { dissolve = false } = {}) {
  const g = await env.DB.prepare(`SELECT name FROM mechanism_groups WHERE id = ? AND project_id = ?`).bind(groupId, ctx.projectId).first();
  if (!g) return bad('這個專案裡找不到這一排機關', 404);
  const cnt = await env.DB.prepare(
    `SELECT COUNT(*) AS m, (SELECT COUNT(*) FROM cue_mechanism_positions p JOIN mechanisms x ON x.id = p.mechanism_id WHERE x.group_id = ?) AS p
       FROM mechanisms WHERE group_id = ? AND project_id = ?`
  ).bind(groupId, groupId, ctx.projectId).first();
  const members = Number(cnt?.m) || 0, positions = Number(cnt?.p) || 0;
  const stmts = dissolve
    ? [env.DB.prepare(`UPDATE mechanisms SET group_id = NULL, group_index = NULL WHERE group_id = ? AND project_id = ?`).bind(groupId, ctx.projectId)]
    : [env.DB.prepare(`DELETE FROM mechanisms WHERE group_id = ? AND project_id = ?`).bind(groupId, ctx.projectId)];
  stmts.push(env.DB.prepare(`DELETE FROM mechanism_groups WHERE id = ? AND project_id = ?`).bind(groupId, ctx.projectId));
  await env.DB.batch(stmts);
  await log?.(dissolve ? 'update' : 'delete', 'mechanism_group', groupId, { name: g.name, dissolved: dissolve || undefined, mechanisms: members });
  return ok(dissolve ? { ok: true, dissolved: true, mechanisms: members } : { ok: true, removedMechanisms: members, removedPositions: positions });
}

// ─────────────────────────────────────────────
// 每個 cue 的機關位置（不寫活動紀錄：拖滑桿不洗版，跟物件位置一樣）
// ─────────────────────────────────────────────

/**
 * PUT …/cues/:c/mechanisms/:m  body: { value?, delaySec?, durationSec? }
 *   value 有送 → 存位置（夾進行程）；沒送的欄位不動（舊版前端只送 value → 時間照舊）
 *   只送時間 → 這個 cue 要已經有自己的位置（不然 400，前端會一起送位置）
 * ctx.mechanism = { id, kind, travel_min, travel_max }（router 已經確認屬於這個專案）
 */
export async function putCuePosition(request, env, ctx, cueId) {
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  const p = parseCuePositionBody(body);
  if (!p.ok) return bad(p.error, 400, { field: p.field });
  const m = ctx.mechanism;
  if (m.variant === 'hoist_rig') return bad(MECH_MESSAGES.hoistRigValue, 400, { field: 'value' });
  const setDelay = p.delaySec !== undefined ? 1 : 0;
  const setDuration = p.durationSec !== undefined ? 1 : 0;
  const delay = p.delaySec ?? null, duration = p.durationSec ?? null;
  const touch = env.DB.prepare(`UPDATE mechanisms SET edited_at = datetime('now') WHERE id = ?`).bind(m.id);
  let value = null;
  if (p.value !== undefined) {
    value = clampValue(p.value, Number(m.travel_min), Number(m.travel_max));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO cue_mechanism_positions (cue_id, mechanism_id, value, delay_sec, duration_sec, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(cue_id, mechanism_id) DO UPDATE SET value = excluded.value,
           delay_sec = CASE WHEN ? THEN excluded.delay_sec ELSE delay_sec END,
           duration_sec = CASE WHEN ? THEN excluded.duration_sec ELSE duration_sec END,
           updated_at = excluded.updated_at`
      ).bind(cueId, m.id, value, delay, duration, setDelay, setDuration),
      touch,
    ]);
  } else {
    const [r] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE cue_mechanism_positions SET
           delay_sec = CASE WHEN ? THEN ? ELSE delay_sec END,
           duration_sec = CASE WHEN ? THEN ? ELSE duration_sec END,
           updated_at = datetime('now')
         WHERE cue_id = ? AND mechanism_id = ?`
      ).bind(setDelay, delay, setDuration, duration, cueId, m.id),
      touch,
    ]);
    if (!(r?.meta?.changes > 0)) return bad(MECH_MESSAGES.timingNeedsValue, 400, { field: 'value' });
  }
  const row = await env.DB.prepare(
    `SELECT value, delay_sec, duration_sec FROM cue_mechanism_positions WHERE cue_id = ? AND mechanism_id = ?`
  ).bind(cueId, m.id).first();
  return ok({
    ok: true, value: Number(row?.value), clamped: p.value !== undefined && value !== p.value,
    delaySec: secOrNull(row?.delay_sec), durationSec: secOrNull(row?.duration_sec),
  });
}

/**
 * PUT …/cues/:c/mechanism-positions  body: { items: [{ mechanismId, value, delaySec?, durationSec? }] }（1~200 列）
 * 一次寫很多個機關在這個 cue 的位置和時間（套用花樣、復原花樣），一個交易：要嘛全部寫進去，要嘛都不動。
 *   value 是數字 → 存位置（夾進各自的行程）；value 是 null → 刪掉這個 cue 自己的那一列（回到沿用）
 *   delaySec / durationSec：沒放 = 不改；null = 跟著 cue；數字 = 設定（跟單獨寫一樣）
 * 機關要都在這個專案裡，不然整批 400。
 * 回 { ok, items: [{ mechanismId, value, clamped, delaySec, durationSec } | { mechanismId, removed: true }] }
 */
export async function putCuePositionsBulk(request, env, ctx, cueId) {
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  const p = parseBulkPositions(body);
  if (!p.ok) return bad(p.error, 400, { field: p.field });
  const mechs = (await env.DB.prepare(`SELECT id, travel_min, travel_max, variant FROM mechanisms WHERE project_id = ?`).bind(ctx.projectId).all()).results || [];
  const byId = new Map(mechs.map(m => [m.id, m]));
  if (p.items.some(it => !byId.has(it.mechanismId))) return bad(MECH_MESSAGES.bulkForeign, 400, { field: 'items' });
  if (p.items.some(it => byId.get(it.mechanismId).variant === 'hoist_rig')) return bad(MECH_MESSAGES.hoistRigValue, 400, { field: 'items' });
  const touch = () => env.DB.prepare(
    `UPDATE mechanisms SET edited_at = datetime('now') WHERE id IN (SELECT mechanism_id FROM cue_mechanism_positions WHERE cue_id = ?)`
  ).bind(cueId);
  const stmts = [touch()];
  const clamped = new Map();
  for (const it of p.items) {
    if (it.value === null) {
      stmts.push(env.DB.prepare(`DELETE FROM cue_mechanism_positions WHERE cue_id = ? AND mechanism_id = ?`).bind(cueId, it.mechanismId));
      continue;
    }
    const m = byId.get(it.mechanismId);
    const value = clampValue(it.value, Number(m.travel_min), Number(m.travel_max));
    clamped.set(it.mechanismId, value !== it.value);
    stmts.push(env.DB.prepare(
      `INSERT INTO cue_mechanism_positions (cue_id, mechanism_id, value, delay_sec, duration_sec, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(cue_id, mechanism_id) DO UPDATE SET value = excluded.value,
         delay_sec = CASE WHEN ? THEN excluded.delay_sec ELSE delay_sec END,
         duration_sec = CASE WHEN ? THEN excluded.duration_sec ELSE duration_sec END,
         updated_at = excluded.updated_at`
    ).bind(cueId, it.mechanismId, value, it.delaySec ?? null, it.durationSec ?? null,
      it.delaySec !== undefined ? 1 : 0, it.durationSec !== undefined ? 1 : 0));
  }
  stmts.push(touch());
  await env.DB.batch(stmts);
  const rows = (await env.DB.prepare(
    `SELECT mechanism_id, value, delay_sec, duration_sec FROM cue_mechanism_positions WHERE cue_id = ?`
  ).bind(cueId).all()).results || [];
  const byMech = new Map(rows.map(r => [r.mechanism_id, r]));
  return ok({
    ok: true,
    items: p.items.map(it => {
      const r = byMech.get(it.mechanismId);
      if (it.value === null || !r) return { mechanismId: it.mechanismId, removed: true };
      return {
        mechanismId: it.mechanismId, value: Number(r.value), clamped: clamped.get(it.mechanismId) === true,
        delaySec: secOrNull(r.delay_sec), durationSec: secOrNull(r.duration_sec),
      };
    }),
  });
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
  const [mr, or, pr, gr] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM mechanisms WHERE project_id = ? ORDER BY "order" ASC`).bind(projectId),
    env.DB.prepare(
      `SELECT mo.mechanism_id, mo.stage_object_id, mo.side FROM mechanism_objects mo
         JOIN mechanisms m ON m.id = mo.mechanism_id WHERE m.project_id = ?`
    ).bind(projectId),
    env.DB.prepare(
      `SELECT p.cue_id, p.mechanism_id, p.value, p.delay_sec, p.duration_sec FROM cue_mechanism_positions p
         JOIN mechanisms m ON m.id = p.mechanism_id WHERE m.project_id = ?`
    ).bind(projectId),
    env.DB.prepare(`SELECT id, name, "order", settings FROM mechanism_groups WHERE project_id = ? ORDER BY "order" ASC`).bind(projectId),
  ]);
  return {
    mechanisms: mr.results || [],
    mechanismObjects: or.results || [],
    cueMechanismPositions: pr.results || [],
    // 一排機關（0031；每個機關列上的 group_id / group_index 指到這裡；舊的匯出檔沒有 → 都是一般機關）
    mechanismGroups: gr.results || [],
  };
}

/**
 * 匯入（或複製）：重新給 id；物件 / cue 對不到的略過；舊的匯出檔沒有這些欄位 → 什麼都不做
 * 定義先全部檢查一次（壞資料略過），parent 等全部建好再接上
 */
export async function importMechanisms(env, projectId, data, objIdMap, cueIdMap) {
  const mechs = Array.isArray(data?.mechanisms) ? data.mechanisms.slice(0, 500) : [];
  if (!mechs.length) return { mechanisms: 0, objects: 0, positions: 0, groups: 0 };
  const idMap = new Map();
  const rows = [];
  const splitIds = new Set();   // 新 id：對開的機關（帶的物件要記哪一邊）
  mechs.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return;
    const m = rowToMechanism(raw);
    const n = normalizeMechanismInput({ ...m, parentId: null, objectIds: [] }, { pendingRigId: m.rigId });
    if (!n.ok) return;
    // 從舊滑桿轉來的：換成新物件的 mlx_ / mly_ id（舊網站改滑桿時還找得到、不會多出一個）
    const legacyObj = raw.legacy_object_id && (raw.legacy_axis === 'x' || raw.legacy_axis === 'y')
      ? (objIdMap.get(raw.legacy_object_id) ?? null) : null;
    const id = legacyObj ? (raw.legacy_axis === 'x' ? 'mlx_' : 'mly_') + legacyObj : newId('mech_', i + 1);
    if (legacyObj && rows.some(r => r.id === id)) return;
    idMap.set(raw.id, id);
    if (n.value.variant === 'split') splitIds.add(id);
    rows.push({
      id, c: inputToColumns(n.value), order: m.order, parentOld: m.parentId,
      oldId: raw.id, variant: n.value.variant, rigOld: n.value.rigId, attach: n.value.attach, rigIndex: n.value.rigIndex,
      groupOld: typeof raw.group_id === 'string' && raw.group_id ? raw.group_id : null,
      groupIndex: Number.isInteger(raw.group_index) && raw.group_index >= 0 ? raw.group_index : null,
      legacyObj, legacyAxis: legacyObj ? raw.legacy_axis : null,
      // 沒在新介面改過的舊滑桿機關照樣讓舊網站同步；其他一律算改過
      editedAt: legacyObj ? (raw.edited_at ?? null) : 'now',
    });
  });
  // 吊掛（0032）：整組要有 2～4 個位置分得開的吊點才匯入；不完整的整組連同吊點一起略過（舊的匯出檔沒有吊掛）
  const goodRigs = new Set();
  for (const rr of rows.filter(r => r.variant === 'hoist_rig')) {
    const hs = rows.filter(r => r.variant === 'hoist' && r.rigOld === rr.oldId);
    if (hs.length >= 2 && hs.length <= 4 && !hoistGeometryProblem(hs.sort((a, b) => (a.rigIndex ?? 0) - (b.rigIndex ?? 0)).map(h => h.attach))) goodRigs.add(rr.oldId);
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const keep = r.variant === 'hoist_rig' ? goodRigs.has(r.oldId) : r.variant === 'hoist' ? goodRigs.has(r.rigOld) : true;
    if (!keep) { idMap.delete(r.oldId); rows.splice(i, 1); }
  }
  if (!rows.length) return { mechanisms: 0, objects: 0, positions: 0, groups: 0 };
  // 一排機關（0031）：有成員被匯入的才建，新 id；先建一排、再建機關（機關指到一排）
  const groupMap = new Map();
  const stmts = [];
  let groups = 0;
  for (const g of Array.isArray(data.mechanismGroups) ? data.mechanismGroups.slice(0, 500) : []) {
    if (!g || typeof g.id !== 'string' || !rows.some(r => r.groupOld === g.id)) continue;
    const name = String(g.name ?? '').trim().slice(0, 40);
    if (!name) continue;
    const gid = newId('mgrp_', groupMap.size + 1);
    groupMap.set(g.id, gid);
    const settings = rowToGroup({ id: gid, name, order: g.order, settings: g.settings }).settings;
    stmts.push(env.DB.prepare(`INSERT INTO mechanism_groups (id, project_id, name, "order", settings) VALUES (?, ?, ?, ?, ?)`)
      .bind(gid, projectId, name, Number(g.order) || 0, settings ? JSON.stringify(settings) : null));
    groups++;
  }
  for (const r of rows) {
    const gid = r.groupOld && groupMap.has(r.groupOld) ? groupMap.get(r.groupOld) : null;
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO mechanisms (id, project_id, name, kind, axis, pivot, travel_min, travel_max, default_value, max_speed,
                               presets, parent_id, console_label, "order", metadata, variant, mirror, group_id, group_index, rig_index, attach, legacy_object_id, legacy_axis, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'now' THEN datetime('now') ELSE ? END)`
    ).bind(r.id, projectId, r.c.name, r.c.kind, r.c.axis, r.c.pivot, r.c.travel_min, r.c.travel_max, r.c.default_value,
      r.c.max_speed, r.c.presets, r.c.console_label, r.order, r.c.metadata, r.c.variant, r.c.mirror,
      gid, gid ? r.groupIndex : null, r.c.rig_index, r.c.attach, r.legacyObj, r.legacyAxis, r.editedAt, r.editedAt));
  }
  for (const r of rows) {
    const p = r.parentOld ? idMap.get(r.parentOld) : null;
    if (p && p !== r.id) stmts.push(env.DB.prepare(`UPDATE mechanisms SET parent_id = ? WHERE id = ?`).bind(p, r.id));
    // 吊點接回它的整組（整組都建好了才接）
    if (r.variant === 'hoist' && idMap.get(r.rigOld)) stmts.push(env.DB.prepare(`UPDATE mechanisms SET rig_id = ? WHERE id = ?`).bind(idMap.get(r.rigOld), r.id));
  }
  let objects = 0, positions = 0;
  const seenObj = new Set();
  for (const mo of Array.isArray(data.mechanismObjects) ? data.mechanismObjects : []) {
    const mid = idMap.get(mo?.mechanism_id);
    const oid = objIdMap.get(mo?.stage_object_id);
    if (!mid || !oid || seenObj.has(oid)) continue;
    seenObj.add(oid);
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO mechanism_objects (mechanism_id, stage_object_id, side) VALUES (?, ?, ?)`)
      .bind(mid, oid, splitIds.has(mid) ? (mo?.side === 'b' ? 'b' : 'a') : null));
    objects++;
  }
  for (const p of Array.isArray(data.cueMechanismPositions) ? data.cueMechanismPositions : []) {
    const mid = idMap.get(p?.mechanism_id);
    const cid = cueIdMap.get(p?.cue_id);
    const v = Number(p?.value);
    if (!mid || !cid || !Number.isFinite(v)) continue;
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO cue_mechanism_positions (cue_id, mechanism_id, value, delay_sec, duration_sec) VALUES (?, ?, ?, ?, ?)`)
      .bind(cid, mid, v, timingOrNull(p?.delay_sec), timingOrNull(p?.duration_sec)));
    positions++;
  }
  for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
  return { mechanisms: rows.length, objects, positions, groups };
}

/** 匯入 / 常用擺位的秒數：不合法 → null（跟著 cue） */
function timingOrNull(v) {
  const t = parseTimingSeconds(v);
  return t.ok ? t.value : null;
}

/** 新 cue「沿用」另一個 cue：複製來源 cue 自己設的機關位置和時間（同一個專案） */
export async function cloneCuePositions(env, fromCueId, toCueId) {
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO cue_mechanism_positions (cue_id, mechanism_id, value, delay_sec, duration_sec)
     SELECT ?, mechanism_id, value, delay_sec, duration_sec FROM cue_mechanism_positions WHERE cue_id = ?`
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
  const mechs = (await env.DB.prepare(`SELECT id, travel_min, travel_max, variant FROM mechanisms WHERE project_id = ?`).bind(projectId).all()).results || [];
  const byId = new Map(mechs.map(m => [m.id, m]));
  const stmts = [];
  for (const [id, v] of entries) {
    const m = byId.get(id);
    if (!m || m.variant === 'hoist_rig') continue;
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO cue_mechanism_positions (cue_id, mechanism_id, value) VALUES (?, ?, ?)`)
      .bind(cueId, id, clampValue(Number(v), Number(m.travel_min), Number(m.travel_max))));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

/** 存成常用擺位：這個 cue 自己設的機關位置和時間（用機關名稱存 → 別的專案也套得上；沒設時間就不放） */
export async function templateMechanismPositions(env, cueId) {
  const r = await env.DB.prepare(
    `SELECT m.name, p.value, p.delay_sec, p.duration_sec FROM cue_mechanism_positions p JOIN mechanisms m ON m.id = p.mechanism_id WHERE p.cue_id = ?`
  ).bind(cueId).all();
  return (r.results || []).map(x => {
    const o = { name: x.name, value: Number(x.value) };
    if (secOrNull(x.delay_sec) !== null) o.delaySec = Number(x.delay_sec);
    if (secOrNull(x.duration_sec) !== null) o.durationSec = Number(x.duration_sec);
    return o;
  });
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
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO cue_mechanism_positions (cue_id, mechanism_id, value, delay_sec, duration_sec) VALUES (?, ?, ?, ?, ?)`)
      .bind(cueId, m.id, clampValue(v, Number(m.travel_min), Number(m.travel_max)), timingOrNull(p?.delaySec), timingOrNull(p?.durationSec)));
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
  if (mech.variant === 'split') return bad(MECH_MESSAGES.splitConvert, 400);
  if (isHoistVariant(mech.variant)) return bad(MECH_MESSAGES.hoistConvert, 400);
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
