// Cue 庫第 5 階段：給 Cue 庫用的新後台功能（Cue 庫的 cue 的列表 / 建立 / 另存 / 更新畫面 / 改名 / 改編號 / 誰在用 / 刪除，
// 以及這首歌的 slot：加一個指到 Cue 庫的 cue、換指向、改時間、照時間重排）。
// 設計：docs/superpowers/specs/2026-10-22-cue-library-design.md（4.1、4.2、4.5；第 10 節：編號是自己打的文字、每個 cue 是獨立快照）
//
// 全部只對 Cue 庫模式的專案（projects.cue_library = 1）；其他專案回 400「這個專案還沒有 Cue 庫」，舊路徑完全不碰。
// 權限在 access.mjs（讀 = 專案成員，寫 = 這個專案的製作）。handler 回 { status, body }（跟 mechanisms.mjs 一樣）。
// 不 import worker.js / mechanisms.mjs。

import {
  OWN_POSITION, OWN_ROTATION, OWN_SCALE, OWN_VISIBLE, OWN_CUSTOM, CUE_NAME_MAX, SLOT_TIME_MAX,
  suggestLabel, compareLabels, validateLabel, orderSlots, validateLook,
} from './cueLibrary.mjs';
import { resolveLibraryObjectStates } from './cueLibrary.mjs';

const ok = (body, status = 200) => ({ status, body });
const bad = (error, status = 400, extra = {}) => ({ status, body: { error, ...extra } });
const all = async (db, sql, ...binds) => (await db.prepare(sql).bind(...binds).all()).results || [];
const rid = (prefix) => prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const NOT_LIB = '這個專案還沒有 Cue 庫';
const NOTE_MAX = 500;
const DEFAULT_CROSSFADE = 1;
const ROWS_PER_STMT = 100;

async function readJson(request) {
  try { const b = await request.json(); return isObj(b) ? b : null; } catch { return null; }
}

/** 123.4 → 「2:03」（活動文字和錯誤訊息用） */
export function fmtTime(sec) {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

async function guardLibrary(env, ctx) {
  const r = await env.DB.prepare(`SELECT cue_library FROM projects WHERE id = ? LIMIT 1`).bind(ctx.projectId).first();
  return Number(r?.cue_library) === 1;
}

const isUniqueError = (e) => /UNIQUE|constraint/i.test(String(e?.message || e));

// ───────────────────────── 讀 ─────────────────────────

/** 專案裡所有 Cue 庫的 cue 的使用情形：lcId → [{cueId, songId, songName, songCode, videoTimeSec}] */
async function usageMap(env, projectId, lcId = null) {
  const rows = await all(env.DB,
    `SELECT c.id AS cue_id, c.library_cue_id, c.song_id, c.video_time_sec, s.name AS song_name, s.code AS song_code
       FROM cues c JOIN songs s ON s.id = c.song_id
      WHERE s.project_id = ? AND c.library_cue_id IS NOT NULL${lcId ? ' AND c.library_cue_id = ?' : ''}
      ORDER BY s."order" ASC, s.created_at ASC, c."order" ASC, c.created_at ASC, c.id ASC`,
    ...(lcId ? [projectId, lcId] : [projectId]));
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.library_cue_id)) map.set(r.library_cue_id, []);
    map.get(r.library_cue_id).push({
      cueId: r.cue_id, songId: r.song_id, songName: r.song_name, songCode: r.song_code ?? null,
      videoTimeSec: typeof r.video_time_sec === 'number' ? r.video_time_sec : null,
    });
  }
  return map;
}

const usageOf = (slots = []) => ({ songCount: new Set(slots.map(s => s.songId)).size, slotCount: slots.length, slots });

function libraryCueOut(r, slots, counts) {
  return {
    id: r.id, label: r.label, name: r.name, note: r.note || '', basedOnId: r.based_on_id || null, rev: Number(r.rev),
    crossfadeSeconds: r.crossfade_seconds == null ? DEFAULT_CROSSFADE : Number(r.crossfade_seconds),
    createdAt: r.created_at, updatedAt: r.updated_at,
    usage: usageOf(slots),
    counts: counts || { objects: 0, mechanisms: 0 },
  };
}

async function countsMap(env, projectId) {
  const o = await all(env.DB,
    `SELECT s.library_cue_id AS id, COUNT(*) AS n FROM library_cue_object_states s JOIN library_cues l ON l.id = s.library_cue_id
      WHERE l.project_id = ? GROUP BY s.library_cue_id`, projectId);
  const m = await all(env.DB,
    `SELECT p.library_cue_id AS id, COUNT(*) AS n FROM library_cue_mechanism_positions p JOIN library_cues l ON l.id = p.library_cue_id
      WHERE l.project_id = ? GROUP BY p.library_cue_id`, projectId);
  const map = new Map();
  for (const r of o) map.set(r.id, { objects: Number(r.n), mechanisms: 0 });
  for (const r of m) map.set(r.id, { objects: map.get(r.id)?.objects || 0, mechanisms: Number(r.n) });
  return map;
}

async function getRow(env, projectId, lcId) {
  return env.DB.prepare(`SELECT * FROM library_cues WHERE id = ? AND project_id = ? LIMIT 1`).bind(lcId, projectId).first();
}

/** GET library-cues：照編號排（自然排序，一樣就照建立順序） */
export async function listLibraryCues(env, ctx) {
  if (!(await guardLibrary(env, ctx))) return bad(NOT_LIB);
  const rows = await all(env.DB, `SELECT * FROM library_cues WHERE project_id = ? ORDER BY created_at ASC, id ASC`, ctx.projectId);
  rows.sort((a, b) => compareLabels(a.label, b.label));   // Array.sort 是穩定的 → 一樣的保持建立順序
  const usage = await usageMap(env, ctx.projectId);
  const counts = await countsMap(env, ctx.projectId);
  return ok({ libraryCues: rows.map(r => libraryCueOut(r, usage.get(r.id), counts.get(r.id))) });
}

/** GET library-cues/:lc */
export async function getLibraryCue(env, ctx, lcId) {
  if (!(await guardLibrary(env, ctx))) return bad(NOT_LIB);
  const r = await getRow(env, ctx.projectId, lcId);
  if (!r) return bad('這個專案裡找不到這個 Cue 庫的 cue', 404);
  const usage = await usageMap(env, ctx.projectId, lcId);
  const counts = await countsMap(env, ctx.projectId);
  return ok({ libraryCue: libraryCueOut(r, usage.get(lcId), counts.get(lcId)) });
}

// ───────────────────────── 畫面（look） ─────────────────────────

const OWN_NAMES = [['position', OWN_POSITION], ['rotation', OWN_ROTATION], ['scale', OWN_SCALE], ['visible', OWN_VISIBLE], ['customProps', OWN_CUSTOM]];
const parseJson = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } };
const secOrNull = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

function objRowOut(r) {
  const bits = Number(r.own_fields) || 0;
  return {
    objectId: r.stage_object_id, position: parseJson(r.position), rotation: parseJson(r.rotation), scale: parseJson(r.scale),
    visible: r.visible == null ? null : !!r.visible, customProps: parseJson(r.custom_props),
    own: Number(r.own) === 1, ownFields: OWN_NAMES.filter(([, b]) => bits & b).map(([n]) => n),
  };
}
const mechRowOut = (r) => ({
  mechanismId: r.mechanism_id, value: Number(r.value), delaySec: secOrNull(r.delay_sec), durationSec: secOrNull(r.duration_sec), carried: Number(r.carried) === 1,
});

async function readLook(env, lcId) {
  const objects = await all(env.DB, `SELECT * FROM library_cue_object_states WHERE library_cue_id = ? ORDER BY stage_object_id ASC`, lcId);
  const mechanisms = await all(env.DB, `SELECT * FROM library_cue_mechanism_positions WHERE library_cue_id = ? ORDER BY mechanism_id ASC`, lcId);
  return { objects: objects.map(objRowOut), mechanisms: mechanisms.map(mechRowOut) };
}

/** GET library-cues/:lc/look */
export async function getLook(env, ctx, lcId) {
  if (!(await guardLibrary(env, ctx))) return bad(NOT_LIB);
  const r = await getRow(env, ctx.projectId, lcId);
  if (!r) return bad('這個專案裡找不到這個 Cue 庫的 cue', 404);
  return ok({ rev: Number(r.rev), updatedAt: r.updated_at, ...(await readLook(env, lcId)) });
}

/** GET library-cues/:lc/states：跟 slot 的物件狀態同一個格式 */
export async function getLibraryStates(env, ctx, lcId) {
  if (!(await guardLibrary(env, ctx))) return bad(NOT_LIB);
  const r = await getRow(env, ctx.projectId, lcId);
  if (!r) return bad('這個專案裡找不到這個 Cue 庫的 cue', 404);
  const objectRows = await all(env.DB, `
    SELECT o.id AS object_id, o.mesh_name, o.display_name, o.category, o."order" AS object_order,
           o.default_position, o.default_rotation, o.default_scale, o.locked AS object_locked, o.default_hidden AS default_hidden
      FROM stage_objects o WHERE o.project_id = ? ORDER BY o."order" ASC, o.created_at ASC`, ctx.projectId);
  const libRows = await all(env.DB, `SELECT * FROM library_cue_object_states WHERE library_cue_id = ?`, lcId);
  return ok({ states: resolveLibraryObjectStates(objectRows, libRows) });
}

/** API 的畫面（objectId / ownFields 名稱…）→ 資料表格式的列（給 validateLook 和寫入） */
function lookToRows(look) {
  if (!isObj(look) || !Array.isArray(look.objects) || !Array.isArray(look.mechanisms)) return null;
  const objects = [];
  for (const o of look.objects) {
    if (!isObj(o) || typeof o.objectId !== 'string') return null;
    let bits = 0;
    if (o.own !== false && Array.isArray(o.ownFields)) for (const [n, b] of OWN_NAMES) if (o.ownFields.includes(n)) bits |= b;
    const js = (v) => (v == null ? null : JSON.stringify(v));
    for (const f of ['position', 'rotation', 'scale', 'customProps']) if (o[f] != null && typeof o[f] !== 'object') return null;
    objects.push({
      stage_object_id: o.objectId, position: js(o.position), rotation: js(o.rotation), scale: js(o.scale),
      visible: o.visible == null ? null : (o.visible === true ? 1 : o.visible === false ? 0 : 'x'),
      custom_props: js(o.customProps), own: o.own === false ? 0 : 1, own_fields: o.own === false ? 0 : bits,
    });
  }
  const mechanisms = [];
  for (const m of look.mechanisms) {
    if (!isObj(m) || typeof m.mechanismId !== 'string') return null;
    mechanisms.push({
      mechanism_id: m.mechanismId, value: m.value, delay_sec: m.delaySec ?? null, duration_sec: m.durationSec ?? null, carried: m.carried ? 1 : 0,
    });
  }
  return { objects, mechanisms };
}

async function lookContext(env, projectId) {
  const objs = await all(env.DB, `SELECT id FROM stage_objects WHERE project_id = ?`, projectId);
  const mechs = await all(env.DB, `SELECT id, variant FROM mechanisms WHERE project_id = ?`, projectId);
  return { objectIds: new Set(objs.map(o => o.id)), mechanisms: new Map(mechs.map(m => [m.id, { variant: m.variant || null }])) };
}

/**
 * 寫一個畫面進 Cue 庫的 cue 的陳述式。
 * guardRev：只有 Cue 庫的 cue 的 rev 還是這個值時才寫（同一個 batch 裡，每個陳述式自己檢查）；null = 不檢查（新建的 cue）
 */
function writeLookStmts(env, lcId, rows, guardRev, { replace }) {
  const stmts = [];
  const guard = guardRev == null ? '' : ` AND EXISTS (SELECT 1 FROM library_cues WHERE id = ? AND rev = ?)`;
  const gb = guardRev == null ? [] : [lcId, guardRev];
  if (replace) {
    stmts.push(env.DB.prepare(`DELETE FROM library_cue_object_states WHERE library_cue_id = ?${guard}`).bind(lcId, ...gb));
    stmts.push(env.DB.prepare(`DELETE FROM library_cue_mechanism_positions WHERE library_cue_id = ?${guard}`).bind(lcId, ...gb));
  }
  for (let i = 0; i < rows.objects.length; i += ROWS_PER_STMT) {
    const chunk = rows.objects.slice(i, i + ROWS_PER_STMT).map(o => ({
      o: o.stage_object_id, p: o.position, r: o.rotation, s: o.scale, v: o.visible, c: o.custom_props, w: o.own, f: o.own_fields,
    }));
    stmts.push(env.DB.prepare(
      `INSERT INTO library_cue_object_states (library_cue_id, stage_object_id, position, rotation, scale, visible, custom_props, own, own_fields, updated_at)
       SELECT ?, json_extract(value, '$.o'), json_extract(value, '$.p'), json_extract(value, '$.r'), json_extract(value, '$.s'),
              json_extract(value, '$.v'), json_extract(value, '$.c'), json_extract(value, '$.w'), json_extract(value, '$.f'), datetime('now')
         FROM json_each(?) WHERE 1 = 1${guard}`).bind(lcId, JSON.stringify(chunk), ...gb));
  }
  for (let i = 0; i < rows.mechanisms.length; i += ROWS_PER_STMT) {
    const chunk = rows.mechanisms.slice(i, i + ROWS_PER_STMT).map(m => ({ m: m.mechanism_id, v: m.value, d: m.delay_sec, u: m.duration_sec, c: m.carried }));
    stmts.push(env.DB.prepare(
      `INSERT INTO library_cue_mechanism_positions (library_cue_id, mechanism_id, value, delay_sec, duration_sec, carried, updated_at)
       SELECT ?, json_extract(value, '$.m'), json_extract(value, '$.v'), json_extract(value, '$.d'), json_extract(value, '$.u'),
              json_extract(value, '$.c'), datetime('now')
         FROM json_each(?) WHERE 1 = 1${guard}`).bind(lcId, JSON.stringify(chunk), ...gb));
  }
  return stmts;
}

/**
 * PUT library-cues/:lc/look  { ifRev?, objects, mechanisms }：整個畫面一次換掉（要嘛全寫進去，要嘛都沒動）
 * 帶 ifRev 且 rev 已經變了 → 409。rev 的處理：先把所有寫入都綁在「rev 還是 ifRev」上，最後一個陳述式才 rev + 1；
 * 所以舊的 rev 一個字都寫不進去（不會有「差一版剛好通過」的洞）
 */
export async function putLook(request, env, ctx, lcId, log) {
  if (!(await guardLibrary(env, ctx))) return bad(NOT_LIB);
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  const row = await getRow(env, ctx.projectId, lcId);
  if (!row) return bad('這個專案裡找不到這個 Cue 庫的 cue', 404);
  if (body.ifRev != null && (!Number.isInteger(body.ifRev) || body.ifRev < 0)) return bad('rev 不對');
  const expect = body.ifRev != null ? body.ifRev : Number(row.rev);
  const rows = lookToRows(body);
  if (!rows) return bad('畫面格式不對');
  const v = validateLook(rows, await lookContext(env, ctx.projectId));
  if (!v.ok) return bad(v.error);

  const previous = await readLook(env, lcId);
  const stmts = [
    ...writeLookStmts(env, lcId, rows, expect, { replace: true }),
    env.DB.prepare(`UPDATE library_cues SET rev = rev + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND rev = ?`).bind(lcId, expect),
  ];
  let res;
  try { res = await env.DB.batch(stmts); } catch (e) { return bad('沒有存進去（資料庫拒絕了）：' + String(e?.message || e).slice(0, 160)); }
  if (!Number(res[res.length - 1]?.meta?.changes)) {
    const cur = await getRow(env, ctx.projectId, lcId);
    return bad('這個 cue 剛剛被別人改過', 409, { rev: cur ? Number(cur.rev) : null });
  }
  const usage = await usageMap(env, ctx.projectId, lcId);
  await log?.('update', 'library_cue', lcId, {
    kind: 'look', label: row.label, name: row.name, songCount: usageOf(usage.get(lcId)).songCount,
  });
  return ok({ rev: expect + 1, previous });
}

// ───────────────────────── 新增 / 另存 ─────────────────────────

const cleanName = (s) => [...String(s ?? '').trim()].slice(0, CUE_NAME_MAX).join('');

async function songSlots(env, songId) {
  return all(env.DB, `SELECT id, "order", video_time_sec, library_cue_id FROM cues WHERE song_id = ? ORDER BY "order" ASC, created_at ASC, id ASC`, songId);
}

/** 時間檢查：回 { ok, value } 或 { ok:false, error } 。null / 沒給 = 不對應影片時間 */
function checkCrossfade(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 3600) return { ok: false, error: '淡入淡出秒數不對（0 到 3600）' };
  return { ok: true, value: v };
}

function checkTime(v) {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > SLOT_TIME_MAX) return { ok: false, error: `時間要在 0 到 ${SLOT_TIME_MAX} 秒之間` };
  return { ok: true, value: Math.round(v * 1000) / 1000 };
}

function tieError(slots, t, exceptCueId) {
  const hit = t != null && slots.find(s => s.id !== exceptCueId && typeof s.video_time_sec === 'number' && Math.abs(s.video_time_sec - t) < 0.0005);
  return hit ? bad(`這首歌 ${fmtTime(t)} 已經有 cue 了`, 409) : null;
}

/** 重排：回 UPDATE 陳述式（只更新 order 有變的）和新的順序 */
function reorderStmts(env, slots) {
  const sorted = orderSlots(slots.map(s => ({ id: s.id, order: s.order, videoTimeSec: typeof s.video_time_sec === 'number' ? s.video_time_sec : null })));
  const before = new Map(slots.map(s => [s.id, Number(s.order)]));
  const stmts = sorted.filter(s => before.get(s.id) !== s.order).map(s =>
    env.DB.prepare(`UPDATE cues SET "order" = ?, updated_at = datetime('now') WHERE id = ?`).bind(s.order, s.id));
  return { stmts, order: sorted.map(s => ({ id: s.id, order: s.order })) };
}

async function slotOut(env, cueId) {
  const c = await env.DB.prepare(
    `SELECT c.id, c.song_id, c.name, c."order", c.crossfade_seconds, c.crossfade_own, c.video_time_sec, c.status, c.library_cue_id, l.label, l.name AS lib_name, l.crossfade_seconds AS lib_crossfade
       FROM cues c LEFT JOIN library_cues l ON l.id = c.library_cue_id WHERE c.id = ? LIMIT 1`).bind(cueId).first();
  if (!c) return null;
  return {
    id: c.id, songId: c.song_id, name: c.name, order: Number(c.order), crossfadeSeconds: c.crossfade_seconds,
    crossfadeOwn: Number(c.crossfade_own) !== 0,
    libraryCrossfadeSeconds: c.library_cue_id && c.lib_crossfade != null ? Number(c.lib_crossfade) : null,
    videoTimeSec: typeof c.video_time_sec === 'number' ? c.video_time_sec : null, status: c.status,
    libraryCueId: c.library_cue_id || null,
    libraryCue: c.library_cue_id ? { id: c.library_cue_id, label: c.label, name: c.lib_name } : null,
  };
}

/**
 * POST library-cues：新增 / 另存 / 複製
 * body { label?, name?, note?, basedOnId?, look?, place? }
 *   label 沒給 → 用建議編號；name 沒給 → 用來源的名稱（沒有來源就一定要給）
 *   look 沒給 + basedOnId → 原樣複製來源的畫面；都沒有 → 空的畫面
 *   place：{ songId, replaceCueId }（把這首歌那個 cue 換成新的）或 { songId, videoTimeSec, crossfadeSeconds? }（加一個 cue）
 */
export async function createLibraryCue(request, env, ctx, log) {
  if (!(await guardLibrary(env, ctx))) return bad(NOT_LIB);
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  const projectId = ctx.projectId;

  let base = null;
  if (body.basedOnId != null) {
    if (typeof body.basedOnId !== 'string') return bad('來源 cue 不對');
    base = await getRow(env, projectId, body.basedOnId);
    if (!base) return bad('這個專案裡找不到來源的 cue', 404);
  }
  const existing = (await all(env.DB, `SELECT label FROM library_cues WHERE project_id = ?`, projectId)).map(r => r.label);
  const labelInput = body.label == null ? suggestLabel(existing) : body.label;
  const lv = validateLabel(labelInput, existing);
  if (!lv.ok) return bad(lv.error, lv.error === '這個編號已經有了' ? 409 : 400);
  const name = body.name == null ? cleanName(base?.name) : cleanName(body.name);
  if (!name) return bad('名稱不能空白');
  const note = body.note == null ? '' : String(body.note).slice(0, NOTE_MAX);
  let libCrossfade = base && base.crossfade_seconds != null ? Number(base.crossfade_seconds) : DEFAULT_CROSSFADE;
  if (body.crossfadeSeconds != null) {
    const cf = checkCrossfade(body.crossfadeSeconds);
    if (!cf.ok) return bad(cf.error);
    libCrossfade = cf.value;
  }

  let rows = null;
  if (body.look != null) {
    rows = lookToRows(body.look);
    if (!rows) return bad('畫面格式不對');
    const v = validateLook(rows, await lookContext(env, projectId));
    if (!v.ok) return bad(v.error);
  }

  // 放到哪裡
  let placement = null;
  let place = null;
  if (body.place != null) {
    place = body.place;
    if (!isObj(place) || typeof place.songId !== 'string') return bad('要放的歌不對');
    const song = await env.DB.prepare(`SELECT id, name FROM songs WHERE id = ? AND project_id = ? LIMIT 1`).bind(place.songId, projectId).first();
    if (!song) return bad('這個專案裡找不到這首歌', 404);
    const slots = await songSlots(env, place.songId);
    if (place.replaceCueId != null) {
      const target = slots.find(s => s.id === place.replaceCueId);
      if (!target) return bad('這首歌裡找不到要換掉的 cue', 404);
      placement = { kind: 'replace', song, target };
    } else {
      const t = checkTime(place.videoTimeSec);
      if (!t.ok) return bad(t.error);
      const tie = tieError(slots, t.value, null);
      if (tie) return tie;
      // 有給秒數 = 這首歌另外設；沒給 = 用 Cue 庫的
      let crossfade = null;
      if (place.crossfadeSeconds != null) {
        const cf = checkCrossfade(place.crossfadeSeconds);
        if (!cf.ok) return bad(cf.error);
        crossfade = cf.value;
      }
      placement = { kind: 'add', song, slots, time: t.value, crossfade };
    }
  }

  const id = rid('lc_');
  const stmts = [env.DB.prepare(
    `INSERT INTO library_cues (id, project_id, label, name, note, based_on_id, crossfade_seconds, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, projectId, lv.label, name, note, base ? base.id : null, libCrossfade, ctx.userId || ctx.me?.id || null)];
  if (rows) {
    stmts.push(...writeLookStmts(env, id, rows, null, { replace: false }));
  } else if (base) {
    stmts.push(env.DB.prepare(
      `INSERT INTO library_cue_object_states (library_cue_id, stage_object_id, position, rotation, scale, visible, custom_props, own, own_fields, updated_at)
       SELECT ?, stage_object_id, position, rotation, scale, visible, custom_props, own, own_fields, updated_at
         FROM library_cue_object_states WHERE library_cue_id = ?`).bind(id, base.id));
    stmts.push(env.DB.prepare(
      `INSERT INTO library_cue_mechanism_positions (library_cue_id, mechanism_id, value, delay_sec, duration_sec, carried, updated_at)
       SELECT ?, mechanism_id, value, delay_sec, duration_sec, carried, updated_at
         FROM library_cue_mechanism_positions WHERE library_cue_id = ?`).bind(id, base.id));
  }

  let slotId = null, orderOut = null;
  if (placement?.kind === 'replace') {
    stmts.push(env.DB.prepare(`UPDATE cues SET library_cue_id = ?, crossfade_seconds = CASE WHEN crossfade_own = 0 THEN ? ELSE crossfade_seconds END, updated_at = datetime('now') WHERE id = ?`).bind(id, libCrossfade, placement.target.id));
    slotId = placement.target.id;
  } else if (placement?.kind === 'add') {
    slotId = rid('c_');
    const maxOrder = placement.slots.reduce((m, s) => Math.max(m, Number(s.order)), -1);
    stmts.push(env.DB.prepare(
      `INSERT INTO cues (id, song_id, name, "order", crossfade_seconds, crossfade_own, video_time_sec, status, library_cue_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'master', ?)`
    ).bind(slotId, place.songId, name, maxOrder + 1, placement.crossfade ?? libCrossfade, placement.crossfade == null ? 0 : 1, placement.time, id));
    const re = reorderStmts(env, [...placement.slots, { id: slotId, order: maxOrder + 1, video_time_sec: placement.time }]);
    stmts.push(...re.stmts);
    orderOut = re.order;
  }
  try { await env.DB.batch(stmts); } catch (e) {
    if (isUniqueError(e) && /library_cues|label/i.test(String(e.message))) return bad('這個編號已經有了', 409);
    return bad('沒有存進去（資料庫拒絕了）：' + String(e?.message || e).slice(0, 160), 400);
  }

  const created = await getRow(env, projectId, id);
  const counts = (await countsMap(env, projectId)).get(id);
  const out = { libraryCue: libraryCueOut(created, slotId ? usageOf((await usageMap(env, projectId, id)).get(id)).slots : [], counts) };
  if (slotId) { out.slot = await slotOut(env, slotId); if (orderOut) out.order = orderOut; }
  await log?.('create', 'library_cue', id, {
    label: created.label, name: created.name,
    ...(base ? { basedOnLabel: base.label, basedOnName: base.name } : {}),
    ...(placement ? { songName: placement.song.name, placed: placement.kind } : {}),
  });
  if (placement?.kind === 'add') {
    await log?.('create', 'cue', slotId, { songName: placement.song.name, name, videoTimeSec: placement.time, libraryLabel: created.label, libraryName: created.name });
  } else if (placement?.kind === 'replace') {
    await log?.('update', 'cue', slotId, {
      kind: 'repoint', songName: placement.song.name, name: placement.target && created.name, videoTimeSec: secOrNull(placement.target.video_time_sec),
      libraryLabel: created.label, libraryName: created.name,
    });
  }
  return ok(out, 201);
}

// ───────────────────────── 改名 / 改編號 / 刪除 ─────────────────────────

/** PATCH library-cues/:lc  { name?, label?, note? } */
export async function patchLibraryCue(request, env, ctx, lcId, log) {
  if (!(await guardLibrary(env, ctx))) return bad(NOT_LIB);
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  const row = await getRow(env, ctx.projectId, lcId);
  if (!row) return bad('這個專案裡找不到這個 Cue 庫的 cue', 404);
  const sets = [], binds = [];
  let newName = null, newLabel = null;
  if ('name' in body) {
    newName = cleanName(body.name);
    if (!newName) return bad('名稱不能空白');
    if (newName !== row.name) { sets.push('name = ?'); binds.push(newName); } else newName = null;
  }
  if ('label' in body) {
    const others = (await all(env.DB, `SELECT label FROM library_cues WHERE project_id = ? AND id != ?`, ctx.projectId, lcId)).map(r => r.label);
    const v = validateLabel(body.label, others);
    if (!v.ok) return bad(v.error, v.error === '這個編號已經有了' ? 409 : 400);
    if (v.label !== row.label) { sets.push('label = ?'); binds.push(v.label); newLabel = v.label; }
  }
  if ('note' in body) { sets.push('note = ?'); binds.push(String(body.note ?? '').slice(0, NOTE_MAX)); }
  let newCrossfade = null;
  if ('crossfadeSeconds' in body) {
    const cf = checkCrossfade(body.crossfadeSeconds);
    if (!cf.ok) return bad(cf.error);
    if (cf.value !== Number(row.crossfade_seconds)) { sets.push('crossfade_seconds = ?'); binds.push(cf.value); newCrossfade = cf.value; }
  }
  if (!sets.length && !('note' in body)) {
    if (!('name' in body) && !('label' in body) && !('crossfadeSeconds' in body)) return bad('沒有可以改的欄位');
  }
  if (sets.length) {
    try {
      const stmts = [env.DB.prepare(`UPDATE library_cues SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND project_id = ?`)
        .bind(...binds, lcId, ctx.projectId)];
      // 用 Cue 庫轉場的那些歌的 cue，值跟著同步（其他讀轉場的地方不用改）
      if (newCrossfade != null) stmts.push(env.DB.prepare(`UPDATE cues SET crossfade_seconds = ?, updated_at = datetime('now') WHERE library_cue_id = ? AND crossfade_own = 0`).bind(newCrossfade, lcId));
      await env.DB.batch(stmts);
    } catch (e) {
      if (isUniqueError(e)) return bad('這個編號已經有了', 409);
      throw e;
    }
  }
  if (newName != null) await log?.('update', 'library_cue', lcId, { kind: 'rename', label: row.label, fromName: row.name, toName: newName, name: newName });
  if (newCrossfade != null) await log?.('update', 'library_cue', lcId, { kind: 'crossfade', label: row.label, name: row.name, fromSeconds: Number(row.crossfade_seconds), toSeconds: newCrossfade });
  if (newLabel != null) await log?.('update', 'library_cue', lcId, { kind: 'relabel', name: newName ?? row.name, fromLabel: row.label, toLabel: newLabel, label: newLabel });
  return getLibraryCue(env, ctx, lcId);
}

/** DELETE library-cues/:lc：還有歌在用就擋（409 + 在用的歌） */
export async function deleteLibraryCue(env, ctx, lcId, log) {
  if (!(await guardLibrary(env, ctx))) return bad(NOT_LIB);
  const row = await getRow(env, ctx.projectId, lcId);
  if (!row) return bad('這個專案裡找不到這個 Cue 庫的 cue', 404);
  const usage = usageOf((await usageMap(env, ctx.projectId, lcId)).get(lcId));
  const blocked = () => bad(`還有 ${usage.songCount} 首歌在用這個 cue，先從這些歌拿掉才能刪`, 409, { usage });
  if (usage.slotCount > 0) return blocked();
  // 刪的瞬間再檢查一次（剛好有人加進去就不刪）
  const r = await env.DB.prepare(
    `DELETE FROM library_cues WHERE id = ? AND project_id = ? AND NOT EXISTS (SELECT 1 FROM cues WHERE library_cue_id = ?)`
  ).bind(lcId, ctx.projectId, lcId).run();
  if (!r.meta.changes) {
    const u2 = usageOf((await usageMap(env, ctx.projectId, lcId)).get(lcId));
    return bad(`還有 ${u2.songCount} 首歌在用這個 cue，先從這些歌拿掉才能刪`, 409, { usage: u2 });
  }
  await log?.('delete', 'library_cue', lcId, { label: row.label, name: row.name });
  return ok({ ok: true });
}

/** GET library-cues/:lc/usage */
export async function libraryCueUsage(env, ctx, lcId) {
  if (!(await guardLibrary(env, ctx))) return bad(NOT_LIB);
  const row = await getRow(env, ctx.projectId, lcId);
  if (!row) return bad('這個專案裡找不到這個 Cue 庫的 cue', 404);
  return ok({ usage: usageOf((await usageMap(env, ctx.projectId, lcId)).get(lcId)) });
}

// ───────────────────────── 這首歌的 slot ─────────────────────────

/**
 * POST songs/:s/cues  { libraryCueId, videoTimeSec?, crossfadeSeconds? }：這首歌加一個指到 Cue 庫的 cue 的 slot
 * （只有 Cue 庫專案才收；呼叫的人先確認 body.libraryCueId 有給）
 */
export async function addSlot(env, ctx, songId, body, log) {
  if (!(await guardLibrary(env, ctx))) return bad(NOT_LIB);
  if (typeof body.libraryCueId !== 'string') return bad('Cue 庫的 cue 不對');
  const lc = await getRow(env, ctx.projectId, body.libraryCueId);
  if (!lc) return bad('這個專案裡找不到這個 Cue 庫的 cue', 404);
  const t = checkTime(body.videoTimeSec);
  if (!t.ok) return bad(t.error);
  const slots = await songSlots(env, songId);
  const tie = tieError(slots, t.value, null);
  if (tie) return tie;
  let crossfade = null;   // 有給秒數 = 這首歌另外設；沒給 = 用 Cue 庫的
  if (body.crossfadeSeconds != null) {
    const cf = checkCrossfade(body.crossfadeSeconds);
    if (!cf.ok) return bad(cf.error);
    crossfade = cf.value;
  }
  const id = rid('c_');
  const maxOrder = slots.reduce((m, s) => Math.max(m, Number(s.order)), -1);
  const re = reorderStmts(env, [...slots, { id, order: maxOrder + 1, video_time_sec: t.value }]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO cues (id, song_id, name, "order", crossfade_seconds, crossfade_own, video_time_sec, status, library_cue_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'master', ?)`
    ).bind(id, songId, lc.name, maxOrder + 1, crossfade ?? Number(lc.crossfade_seconds ?? DEFAULT_CROSSFADE), crossfade == null ? 0 : 1, t.value, lc.id),
    ...re.stmts,
  ]);
  await log?.('create', 'cue', id, { songName: ctx.song?.name, name: lc.name, videoTimeSec: t.value, libraryLabel: lc.label, libraryName: lc.name });
  return ok({ slot: await slotOut(env, id), order: re.order }, 201);
}

/**
 * PATCH songs/:s/cues/:c 裡 libraryCueId（換指向）和 videoTimeSec（改時間 → 重排）這兩個欄位。
 * 其他欄位（名稱、淡入淡出…）還是原本的 updateCue 處理。回 { status, body: { ok, slot, order? } }
 */
export async function patchSlot(env, ctx, songId, cueId, body, log) {
  if (!(await guardLibrary(env, ctx))) return bad(NOT_LIB);
  const slots = await songSlots(env, songId);
  const cur = slots.find(s => s.id === cueId);
  if (!cur) return bad('這首歌裡找不到這個 cue', 404);
  const stmts = [];
  let newLc = null, newTime;
  if ('libraryCueId' in body) {
    if (typeof body.libraryCueId !== 'string') return bad('Cue 庫的 cue 不對');
    newLc = await getRow(env, ctx.projectId, body.libraryCueId);
    if (!newLc) return bad('這個專案裡找不到這個 Cue 庫的 cue', 404);
  }
  if ('videoTimeSec' in body) {
    const t = checkTime(body.videoTimeSec);
    if (!t.ok) return bad(t.error);
    newTime = t.value;
    const tie = tieError(slots, newTime, cueId);
    if (tie) return tie;
  }
  let newCf;   // undefined = 不動；null = 改回用 Cue 庫的；數字 = 這首歌另外設
  if ('crossfadeSeconds' in body) {
    if (body.crossfadeSeconds === null) {
      if (!(newLc || cur.library_cue_id)) return bad('這個 cue 還沒指到 Cue 庫的 cue');
      newCf = null;
    } else {
      const cf = checkCrossfade(body.crossfadeSeconds);
      if (!cf.ok) return bad(cf.error);
      newCf = cf.value;
    }
  }
  const oldLc = cur.library_cue_id ? await env.DB.prepare(`SELECT label, name FROM library_cues WHERE id = ?`).bind(cur.library_cue_id).first() : null;
  if (newLc) stmts.push(env.DB.prepare(`UPDATE cues SET library_cue_id = ?, crossfade_seconds = CASE WHEN crossfade_own = 0 THEN ? ELSE crossfade_seconds END, updated_at = datetime('now') WHERE id = ?`).bind(newLc.id, Number(newLc.crossfade_seconds ?? DEFAULT_CROSSFADE), cueId));
  if (newCf !== undefined) {
    if (newCf === null) {
      const libCf = Number((newLc || await env.DB.prepare(`SELECT crossfade_seconds FROM library_cues WHERE id = ?`).bind(cur.library_cue_id).first())?.crossfade_seconds ?? DEFAULT_CROSSFADE);
      stmts.push(env.DB.prepare(`UPDATE cues SET crossfade_own = 0, crossfade_seconds = ?, updated_at = datetime('now') WHERE id = ?`).bind(libCf, cueId));
    } else {
      stmts.push(env.DB.prepare(`UPDATE cues SET crossfade_own = 1, crossfade_seconds = ?, updated_at = datetime('now') WHERE id = ?`).bind(newCf, cueId));
    }
  }
  let orderOut = null;
  const timeChanged = newTime !== undefined && newTime !== (typeof cur.video_time_sec === 'number' ? cur.video_time_sec : null);
  if (newTime !== undefined) {
    stmts.push(env.DB.prepare(`UPDATE cues SET video_time_sec = ?, updated_at = datetime('now') WHERE id = ?`).bind(newTime, cueId));
    const re = reorderStmts(env, slots.map(s => (s.id === cueId ? { ...s, video_time_sec: newTime } : s)));
    stmts.push(...re.stmts);
    orderOut = re.order;
  }
  if (stmts.length) await env.DB.batch(stmts);
  const shown = newLc || oldLc;
  const base = { songName: ctx.song?.name, libraryLabel: shown?.label, libraryName: shown?.name, name: shown?.name };
  const curTime = typeof cur.video_time_sec === 'number' ? cur.video_time_sec : null;
  if (newLc && newLc.id !== cur.library_cue_id) {
    await log?.('update', 'cue', cueId, { ...base, kind: 'repoint', videoTimeSec: newTime !== undefined ? newTime : curTime, fromLabel: oldLc?.label, fromName: oldLc?.name });
  }
  if (newCf !== undefined) await log?.('update', 'cue', cueId, { ...base, kind: 'crossfade', toSeconds: newCf, useLibrary: newCf === null });
  if (timeChanged) await log?.('update', 'cue', cueId, { ...base, kind: 'retime', fromTimeSec: curTime, toTimeSec: newTime });
  return ok({ ok: true, slot: await slotOut(env, cueId), ...(orderOut ? { order: orderOut } : {}) });
}
