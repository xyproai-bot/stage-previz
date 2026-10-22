// Cue 庫第 4 階段：寫入路徑。只有「切成 Cue 庫模式」的專案（projects.cue_library = 1）會走這裡，其他專案原本的路徑完全不變。
// 設計：docs/superpowers/specs/2026-10-22-cue-library-design.md（4.2 相容寫入表、4.4 複製 / 匯出 / 匯入；第 10 節：每個 cue 是獨立快照、不沿用）
//
// 舊前端打的舊網址（改 cue 的物件、機關位置、重置、新增 cue、所有 cue 回到預設…）在 Cue 庫專案改成寫進
// 「這個 cue 指到的 Cue 庫的 cue」。改一個 cue 只動那個 cue（用同一個 Cue 庫 cue 的別的 cue 也會看到，那是 Cue 庫的設計）。
// 這個檔案不 import mechanisms.mjs / worker.js（mechanisms.mjs 會 import 這裡）。

import { clampValue } from '../web/src/lib/mechanisms/model.ts';
import {
  OWN_POSITION, OWN_ROTATION, OWN_SCALE, OWN_VISIBLE, OWN_CUSTOM, CUE_NAME_MAX, suggestLabel,
} from './cueLibrary.mjs';

const ok = (body, status = 200) => ({ status, body });
const bad = (error, status = 400, extra = {}) => ({ status, body: { error, ...extra } });
const rid = (prefix, i = 0) => prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + Math.random().toString(36).slice(2, 5) + (i ? String(i) : '');
const all = async (db, sql, ...binds) => (await db.prepare(sql).bind(...binds).all()).results || [];
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

async function runChunks(env, stmts, size = 100) {
  for (let i = 0; i < stmts.length; i += size) await env.DB.batch(stmts.slice(i, i + size));
}

const BUMP = (env, lcId) => env.DB.prepare(
  `UPDATE library_cues SET rev = rev + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).bind(lcId);

// ───────────────────────── 這個 cue（slot）指到哪個 Cue 庫的 cue ─────────────────────────

/** { library: 這個 cue 所屬專案是不是 Cue 庫模式, projectId, libraryCueId, name, songId } ；找不到 cue 回 { library: false } */
export async function slotLibrary(env, cueId) {
  const r = await env.DB.prepare(
    `SELECT p.id AS project_id, p.cue_library, c.library_cue_id, c.name, c.song_id
       FROM cues c JOIN songs s ON s.id = c.song_id JOIN projects p ON p.id = s.project_id WHERE c.id = ? LIMIT 1`
  ).bind(cueId).first();
  if (!r || Number(r.cue_library) !== 1) return { library: false };
  return { library: true, projectId: r.project_id, libraryCueId: r.library_cue_id || null, name: r.name, songId: r.song_id };
}

/** 專案目前所有的編號 */
async function projectLabels(env, projectId) {
  return (await all(env.DB, `SELECT label FROM library_cues WHERE project_id = ?`, projectId)).map(r => r.label);
}

const cueName = (s) => [...String(s ?? '').trim()].slice(0, CUE_NAME_MAX).join('') || '新的 cue';

/** 新增一個 Cue 庫的 cue（空的）的陳述式 */
function insertLibraryCue(env, { id, projectId, label, name, basedOnId = null, userId = null, note = '', crossfade = 1 }) {
  return env.DB.prepare(
    `INSERT INTO library_cues (id, project_id, label, name, note, based_on_id, crossfade_seconds, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, projectId, label, name, note, basedOnId, crossfade, userId);
}

/**
 * 這個 slot 要有 Cue 庫的 cue 才能寫：沒有就新建一個（編號 = 建議編號、名稱 = cue 名稱）並指過去。
 * 回傳 Cue 庫的 cue id。
 */
export async function ensureLibraryCue(env, sl, cueId) {
  if (sl.libraryCueId) return sl.libraryCueId;
  const id = rid('lc_');
  await env.DB.batch([
    insertLibraryCue(env, { id, projectId: sl.projectId, label: suggestLabel(await projectLabels(env, sl.projectId)), name: cueName(sl.name) }),
    env.DB.prepare(`UPDATE cues SET library_cue_id = ? WHERE id = ?`).bind(id, cueId),
  ]);
  return id;
}

// ───────────────────────── 物件狀態（PUT / DELETE cues/:c/states/:o、POST cues/:c/reset） ─────────────────────────

const FIELDS = [
  ['position', 'position', OWN_POSITION],
  ['rotation', 'rotation', OWN_ROTATION],
  ['scale', 'scale', OWN_SCALE],
  ['visible', 'visible', OWN_VISIBLE],
  ['customProps', 'custom_props', OWN_CUSTOM],
];

/** PUT cues/:c/states/:o（只動有送的欄位，其他欄位原樣；Cue 庫裡這一列變成「這個 cue 自己設的」） */
export async function putObjectState(env, sl, cueId, objId, body) {
  if (!isObj(body)) return bad('Invalid JSON');
  const lcId = await ensureLibraryCue(env, sl, cueId);
  const cur = await env.DB.prepare(`SELECT * FROM library_cue_object_states WHERE library_cue_id = ? AND stage_object_id = ?`).bind(lcId, objId).first();
  const next = {
    position: cur?.position ?? null, rotation: cur?.rotation ?? null, scale: cur?.scale ?? null,
    visible: cur?.visible ?? null, custom_props: cur?.custom_props ?? null,
  };
  let bits = cur && Number(cur.own) === 1 ? Number(cur.own_fields) : 0;
  let touched = false;
  for (const [key, col, bit] of FIELDS) {
    if (!(key in body)) continue;
    touched = true;
    const v = body[key];
    if (v === null || v === undefined) { next[col] = null; bits &= ~bit; continue; }
    next[col] = key === 'visible' ? (v ? 1 : 0) : JSON.stringify(v);
    bits |= bit;
  }
  if (!touched) return ok({ ok: true, noop: true });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO library_cue_object_states
         (library_cue_id, stage_object_id, position, rotation, scale, visible, custom_props, own, own_fields, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'))`
    ).bind(lcId, objId, next.position, next.rotation, next.scale, next.visible, next.custom_props, bits),
    BUMP(env, lcId),
  ]);
  return ok({ ok: true, id: `${lcId}:${objId}`, libraryCueId: lcId }, cur ? 200 : 201);
}

/** DELETE cues/:c/states/:o → 這一列刪掉（回到預設，不是「沿用」） */
export async function deleteObjectState(env, sl, objId) {
  if (!sl.libraryCueId) return { removed: 0 };
  const [r] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM library_cue_object_states WHERE library_cue_id = ? AND stage_object_id = ?`).bind(sl.libraryCueId, objId),
    BUMP(env, sl.libraryCueId),
  ]);
  return { removed: r?.meta?.changes || 0 };
}

/** POST cues/:c/reset → 這個 Cue 庫的 cue 的物件和機關列全部刪掉 */
export async function resetLibraryCue(env, sl) {
  if (!sl.libraryCueId) return { removed: 0, removedMechanismPositions: 0 };
  const [r, m] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM library_cue_object_states WHERE library_cue_id = ?`).bind(sl.libraryCueId),
    env.DB.prepare(`DELETE FROM library_cue_mechanism_positions WHERE library_cue_id = ?`).bind(sl.libraryCueId),
    BUMP(env, sl.libraryCueId),
  ]);
  return { removed: r?.meta?.changes || 0, removedMechanismPositions: m?.meta?.changes || 0 };
}

// ───────────────────────── 機關位置 ─────────────────────────

const secOrNull = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const touchMech = (env, mechId) => env.DB.prepare(`UPDATE mechanisms SET edited_at = datetime('now') WHERE id = ?`).bind(mechId);

/** PUT cues/:c/mechanism-positions/:m（寫進 Cue 庫的 cue，carried = 0；p 是 parseCuePositionBody 的結果） */
export async function putMechanismPosition(env, sl, cueId, m, p, messages) {
  const lcId = await ensureLibraryCue(env, sl, cueId);
  const setDelay = p.delaySec !== undefined ? 1 : 0;
  const setDuration = p.durationSec !== undefined ? 1 : 0;
  const delay = p.delaySec ?? null, duration = p.durationSec ?? null;
  let value = null;
  if (p.value !== undefined) {
    value = clampValue(p.value, Number(m.travel_min), Number(m.travel_max));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO library_cue_mechanism_positions (library_cue_id, mechanism_id, value, delay_sec, duration_sec, carried, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
         ON CONFLICT(library_cue_id, mechanism_id) DO UPDATE SET value = excluded.value, carried = 0,
           delay_sec = CASE WHEN ? THEN excluded.delay_sec ELSE delay_sec END,
           duration_sec = CASE WHEN ? THEN excluded.duration_sec ELSE duration_sec END,
           updated_at = excluded.updated_at`
      ).bind(lcId, m.id, value, delay, duration, setDelay, setDuration),
      touchMech(env, m.id), BUMP(env, lcId),
    ]);
  } else {
    const [r] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE library_cue_mechanism_positions SET
           delay_sec = CASE WHEN ? THEN ? ELSE delay_sec END,
           duration_sec = CASE WHEN ? THEN ? ELSE duration_sec END,
           updated_at = datetime('now')
         WHERE library_cue_id = ? AND mechanism_id = ? AND carried = 0`
      ).bind(setDelay, delay, setDuration, duration, lcId, m.id),
      touchMech(env, m.id), BUMP(env, lcId),
    ]);
    if (!(r?.meta?.changes > 0)) return bad(messages.timingNeedsValue, 400, { field: 'value' });
  }
  const row = await env.DB.prepare(
    `SELECT value, delay_sec, duration_sec FROM library_cue_mechanism_positions WHERE library_cue_id = ? AND mechanism_id = ?`
  ).bind(lcId, m.id).first();
  return ok({
    ok: true, value: Number(row?.value), clamped: p.value !== undefined && value !== p.value,
    delaySec: secOrNull(row?.delay_sec), durationSec: secOrNull(row?.duration_sec),
  });
}

/** PUT cues/:c/mechanism-positions（一批）：items 已經檢查過，byId = 這個專案的機關 */
export async function putMechanismPositionsBulk(env, sl, cueId, items, byId) {
  const lcId = await ensureLibraryCue(env, sl, cueId);
  const stmts = [];
  const clamped = new Map();
  for (const it of items) {
    if (it.value === null) {
      stmts.push(env.DB.prepare(`DELETE FROM library_cue_mechanism_positions WHERE library_cue_id = ? AND mechanism_id = ?`).bind(lcId, it.mechanismId));
      continue;
    }
    const m = byId.get(it.mechanismId);
    const value = clampValue(it.value, Number(m.travel_min), Number(m.travel_max));
    clamped.set(it.mechanismId, value !== it.value);
    stmts.push(env.DB.prepare(
      `INSERT INTO library_cue_mechanism_positions (library_cue_id, mechanism_id, value, delay_sec, duration_sec, carried, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
       ON CONFLICT(library_cue_id, mechanism_id) DO UPDATE SET value = excluded.value, carried = 0,
         delay_sec = CASE WHEN ? THEN excluded.delay_sec ELSE delay_sec END,
         duration_sec = CASE WHEN ? THEN excluded.duration_sec ELSE duration_sec END,
         updated_at = excluded.updated_at`
    ).bind(lcId, it.mechanismId, value, it.delaySec ?? null, it.durationSec ?? null,
      it.delaySec !== undefined ? 1 : 0, it.durationSec !== undefined ? 1 : 0));
  }
  stmts.push(BUMP(env, lcId));
  await env.DB.batch(stmts);
  const rows = await all(env.DB, `SELECT mechanism_id, value, delay_sec, duration_sec FROM library_cue_mechanism_positions WHERE library_cue_id = ?`, lcId);
  const byMech = new Map(rows.map(r => [r.mechanism_id, r]));
  return ok({
    ok: true,
    items: items.map(it => {
      const r = byMech.get(it.mechanismId);
      if (it.value === null || !r) return { mechanismId: it.mechanismId, removed: true };
      return {
        mechanismId: it.mechanismId, value: Number(r.value), clamped: clamped.get(it.mechanismId) === true,
        delaySec: secOrNull(r.delay_sec), durationSec: secOrNull(r.duration_sec),
      };
    }),
  });
}

/** DELETE cues/:c/mechanism-positions/:m → 這一列刪掉（回到機關預設位置） */
export async function deleteMechanismPosition(env, sl, mechId) {
  if (!sl.libraryCueId) return ok({ ok: true, removed: 0 });
  const [r] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM library_cue_mechanism_positions WHERE library_cue_id = ? AND mechanism_id = ?`).bind(sl.libraryCueId, mechId),
    touchMech(env, mechId), BUMP(env, sl.libraryCueId),
  ]);
  return ok({ ok: true, removed: r?.meta?.changes || 0 });
}

// ───────────────────────── 新增 cue（POST songs/:s/cues 的舊格式） ─────────────────────────

const ptr = (v) => (v == null ? null : JSON.stringify(v));

/**
 * 舊格式新增 cue：建一個 Cue 庫的 cue（編號 = 最大 + 1、名稱 = body.name）並讓這個 slot 指過去。
 *   cloneFrom → 完整複製來源 cue 的畫面；snapshotStates / snapshotMechanisms → 自己設的列；
 *   fromTemplateId → 常用擺位的列；什麼都沒給（空白）→ 複製前一個 cue 的畫面，全部標成「沿用」。
 * @param {object} p { slotId, songId, projectId, name, body, cloneSrcSlotId, projectObjIds, template, userId }
 */
export async function createSlotLook(env, p) {
  const { slotId, projectId, name, body } = p;
  const id = rid('lc_');
  const stmts = [
    insertLibraryCue(env, { id, projectId, label: suggestLabel(await projectLabels(env, projectId)), name: cueName(name), userId: p.userId || null }),
    env.DB.prepare(`UPDATE cues SET library_cue_id = ? WHERE id = ?`).bind(id, slotId),
  ];
  const objCols = `library_cue_id, stage_object_id, position, rotation, scale, visible, custom_props, own, own_fields, updated_at`;
  const mechs = (await all(env.DB, `SELECT id, name, travel_min, travel_max, variant FROM mechanisms WHERE project_id = ?`, projectId));
  const mechById = new Map(mechs.map(m => [m.id, m]));
  const putObj = (objId, o) => {
    let bits = OWN_VISIBLE;
    if (o.position) bits |= OWN_POSITION;
    if (o.rotation) bits |= OWN_ROTATION;
    if (o.scale) bits |= OWN_SCALE;
    stmts.push(env.DB.prepare(`INSERT OR REPLACE INTO library_cue_object_states (${objCols}) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, datetime('now'))`)
      .bind(id, objId, ptr(o.position), ptr(o.rotation), ptr(o.scale), o.visible === false ? 0 : 1, bits));
  };
  const putMech = (mechId, value, delay, duration) => {
    const m = mechById.get(mechId);
    if (!m || m.variant === 'hoist_rig' || !Number.isFinite(Number(value))) return;
    stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO library_cue_mechanism_positions (library_cue_id, mechanism_id, value, delay_sec, duration_sec, carried) VALUES (?, ?, ?, ?, ?, 0)`
    ).bind(id, mechId, clampValue(Number(value), Number(m.travel_min), Number(m.travel_max)), delay ?? null, duration ?? null));
  };

  if (p.cloneSrcSlotId) {
    const src = await env.DB.prepare(`SELECT library_cue_id FROM cues WHERE id = ?`).bind(p.cloneSrcSlotId).first();
    if (src?.library_cue_id) {
      stmts.push(env.DB.prepare(
        `INSERT INTO library_cue_object_states (${objCols})
         SELECT ?, stage_object_id, position, rotation, scale, visible, custom_props, own, own_fields, updated_at
           FROM library_cue_object_states WHERE library_cue_id = ?`).bind(id, src.library_cue_id));
      stmts.push(env.DB.prepare(
        `INSERT INTO library_cue_mechanism_positions (library_cue_id, mechanism_id, value, delay_sec, duration_sec, carried)
         SELECT ?, mechanism_id, value, delay_sec, duration_sec, carried FROM library_cue_mechanism_positions WHERE library_cue_id = ?`).bind(id, src.library_cue_id));
    }
  } else if (Array.isArray(body?.snapshotStates) && body.snapshotStates.length > 0) {
    for (const s of body.snapshotStates.slice(0, 1000)) {
      if (!s?.objectId || !p.projectObjIds?.has(s.objectId)) continue;
      putObj(s.objectId, s);
    }
  } else if (p.template) {
    const meshToId = p.meshToId || new Map();
    for (const s of (p.template.snapshotStates || [])) {
      const oid = meshToId.get(s.meshName);
      if (oid) putObj(oid, { ...s, visible: s.visible === false ? false : true });
    }
    const byName = new Map(mechs.map(m => [String(m.name).trim(), m]));
    for (const mp of (p.template.mechanismPositions || []).slice(0, 500)) {
      const m = byName.get(String(mp?.name ?? '').trim());
      if (m) putMech(m.id, mp.value, secOrNull(mp.delaySec), secOrNull(mp.durationSec));
    }
  } else if (!(Array.isArray(body?.snapshotStates) && body.snapshotStates.length > 0)) {
    // 空白 cue：複製前一個 cue（這首歌裡排在前面、最靠近的正式 cue）的畫面，全部標成「沿用」（舊介面的空白 cue 是「全部沿用前面」）
    const prev = await env.DB.prepare(
      `SELECT c.library_cue_id FROM cues c
        WHERE c.song_id = ? AND c.id != ? AND c.status = 'master' AND c.library_cue_id IS NOT NULL
          AND (c."order" < (SELECT "order" FROM cues WHERE id = ?))
        ORDER BY c."order" DESC, c.created_at DESC LIMIT 1`
    ).bind(p.songId, slotId, slotId).first();
    if (prev?.library_cue_id) {
      stmts.push(env.DB.prepare(
        `INSERT INTO library_cue_object_states (${objCols})
         SELECT ?, stage_object_id, position, rotation, scale, visible, custom_props, 0, 0, updated_at
           FROM library_cue_object_states WHERE library_cue_id = ?`).bind(id, prev.library_cue_id));
      stmts.push(env.DB.prepare(
        `INSERT INTO library_cue_mechanism_positions (library_cue_id, mechanism_id, value, delay_sec, duration_sec, carried)
         SELECT ?, mechanism_id, value, NULL, NULL, 1 FROM library_cue_mechanism_positions WHERE library_cue_id = ?`).bind(id, prev.library_cue_id));
    }
  }
  // 從目前 3D 畫面建立：每個機關現在的值，存成這個 cue 自己的
  if (!p.cloneSrcSlotId && !p.template && isObj(body?.snapshotMechanisms)) {
    for (const [mid, v] of Object.entries(body.snapshotMechanisms).slice(0, 500)) putMech(mid, Number(v), null, null);
  }
  await runChunks(env, stmts, 200);
  return id;
}

// ───────────────────────── 所有 cue 回到預設（cue-object-states 清單 / 清掉 / 寫回） ─────────────────────────

function parseJson(s) { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } }

/** 這首歌用到的 Cue 庫的 cue（一個只算一次；cueId = 這首歌裡第一個用它的 slot） */
async function songLibraryCues(env, songId) {
  return all(env.DB,
    `SELECT c.id AS cue_id, c.library_cue_id FROM cues c WHERE c.song_id = ? AND c.library_cue_id IS NOT NULL
      ORDER BY c."order" ASC, c.created_at ASC, c.id ASC`, songId);
}

function distinctFirst(slots) {
  const seen = new Map();
  for (const s of slots) if (!seen.has(s.library_cue_id)) seen.set(s.library_cue_id, s.cue_id);
  return seen;
}

function libRowToApi(r, firstSlot) {
  return {
    cueId: firstSlot, libraryCueId: r.library_cue_id, objectId: r.stage_object_id,
    position: parseJson(r.position), rotation: parseJson(r.rotation), scale: parseJson(r.scale),
    visible: r.visible == null ? null : !!r.visible, customProps: parseJson(r.custom_props),
    updatedAt: r.updated_at || null, own: Number(r.own) === 1, ownFields: Number(r.own_fields),
  };
}

async function songStateRows(env, songId) {
  const slots = await songLibraryCues(env, songId);
  const first = distinctFirst(slots);
  const ids = [...first.keys()];
  if (!ids.length) return { first, rows: [], ids };
  const rows = await all(env.DB,
    `SELECT * FROM library_cue_object_states WHERE library_cue_id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids));
  const pos = new Map(ids.map((x, i) => [x, i]));
  rows.sort((a, b) => (pos.get(a.library_cue_id) - pos.get(b.library_cue_id)) || (a.stage_object_id < b.stage_object_id ? -1 : 1));
  return { first, rows, ids };
}

export async function listSongStatesLibrary(env, songId) {
  const { first, rows, ids } = await songStateRows(env, songId);
  const cues = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM cues WHERE song_id = ?`).bind(songId).first())?.n || 0;
  // 別首歌也在用的 Cue 庫的 cue：改了會影響那些歌
  const shared = [];
  for (const lcId of ids) {
    const songs = await all(env.DB,
      `SELECT DISTINCT s.id, s.name FROM cues c JOIN songs s ON s.id = c.song_id WHERE c.library_cue_id = ? AND s.id != ? ORDER BY s."order" ASC`, lcId, songId);
    if (songs.length) shared.push({ libraryCueId: lcId, songs: songs.map(s => ({ id: s.id, name: s.name })) });
  }
  return ok({ cueCount: cues, states: rows.map(r => libRowToApi(r, first.get(r.library_cue_id))), shared });
}

export async function clearSongStatesLibrary(env, ctx, songId, log) {
  const { first, rows, ids } = await songStateRows(env, songId);
  if (ids.length) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM library_cue_object_states WHERE library_cue_id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)),
      env.DB.prepare(`UPDATE library_cues SET rev = rev + 1 WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)),
    ]);
  }
  const states = rows.map(r => libRowToApi(r, first.get(r.library_cue_id)));
  if (states.length > 0) {
    await log?.('reset', 'song_cue_states', songId, {
      songName: ctx.song?.name, removed: states.length, cues: new Set(states.map(s => s.libraryCueId)).size,
    });
  }
  return ok({ ok: true, removed: states.length, states });
}

/** 寫回：每列用 libraryCueId 或 cueId（這首歌的 slot）指到 Cue 庫的 cue。rows 已經由 cueStatesBatch 檢查過格式 */
export async function restoreSongStatesLibrary(env, ctx, songId, rows, log) {
  const slots = await songLibraryCues(env, songId);
  const slotToLib = new Map(slots.map(s => [s.cue_id, s.library_cue_id]));
  const libIds = new Set(slots.map(s => s.library_cue_id));
  const allSlots = new Set(((await all(env.DB, `SELECT id FROM cues WHERE song_id = ?`, songId))).map(r => r.id));
  const objIds = new Set((await all(env.DB, `SELECT id FROM stage_objects WHERE project_id = ?`, ctx.projectId)).map(r => r.id));
  const resolved = [];
  for (const r of rows) {
    let lc = r.libraryCueId && libIds.has(r.libraryCueId) ? r.libraryCueId : null;
    if (!lc && r.cueId && slotToLib.has(r.cueId)) lc = slotToLib.get(r.cueId);
    if (!lc) {
      if (r.cueId && allSlots.has(r.cueId)) {
        // 這個 cue 還沒指到 Cue 庫的 cue：先建一個
        const sl = await slotLibrary(env, r.cueId);
        lc = await ensureLibraryCue(env, sl, r.cueId);
        slotToLib.set(r.cueId, lc); libIds.add(lc);
      } else return bad('有 cue 不在這首歌裡（可能被刪掉了），沒有寫回', 404);
    }
    if (!objIds.has(r.objectId)) return bad('有物件不在這個專案裡（可能被刪掉了），沒有寫回', 404);
    let bits = r.ownFields;
    if (!Number.isInteger(bits) || bits < 0 || bits > 31) {
      bits = (r.position ? OWN_POSITION : 0) | (r.rotation ? OWN_ROTATION : 0) | (r.scale ? OWN_SCALE : 0)
        | (r.visible != null ? OWN_VISIBLE : 0) | (r.custom ? OWN_CUSTOM : 0);
    }
    const own = r.own === false ? 0 : 1;
    resolved.push({ lc, objectId: r.objectId, position: r.position, rotation: r.rotation, scale: r.scale, visible: r.visible, custom: r.custom,
      own, ownFields: own ? bits : 0, updatedAt: r.updatedAt });
  }
  const stmts = [];
  for (let i = 0; i < resolved.length; i += 50) {
    stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO library_cue_object_states
         (library_cue_id, stage_object_id, position, rotation, scale, visible, custom_props, own, own_fields, updated_at)
       SELECT json_extract(value, '$.lc'), json_extract(value, '$.objectId'), json_extract(value, '$.position'),
              json_extract(value, '$.rotation'), json_extract(value, '$.scale'), json_extract(value, '$.visible'),
              json_extract(value, '$.custom'), json_extract(value, '$.own'), json_extract(value, '$.ownFields'),
              COALESCE(json_extract(value, '$.updatedAt'), datetime('now'))
         FROM json_each(?)`
    ).bind(JSON.stringify(resolved.slice(i, i + 50))));
  }
  for (const lc of new Set(resolved.map(r => r.lc))) stmts.push(BUMP(env, lc));
  try { await env.DB.batch(stmts); } catch (e) {
    return bad('沒有寫回（資料庫拒絕了）：' + String(e?.message || e).slice(0, 160), 400);
  }
  await log?.('restore', 'song_cue_states', songId, { songName: ctx.song?.name, restored: rows.length, cues: new Set(resolved.map(r => r.lc)).size });
  return ok({ ok: true, restored: rows.length });
}

// ───────────────────────── 常用擺位 ─────────────────────────

/** 存成常用擺位：這個 Cue 庫的 cue 的完整畫面（用物件 mesh 名稱和機關名稱存） */
export async function templateLook(env, lcId) {
  const states = await all(env.DB,
    `SELECT s.position, s.rotation, s.scale, s.visible, o.mesh_name FROM library_cue_object_states s
       JOIN stage_objects o ON o.id = s.stage_object_id WHERE s.library_cue_id = ? ORDER BY o."order" ASC`, lcId);
  const mechs = await all(env.DB,
    `SELECT m.name, p.value, p.delay_sec, p.duration_sec, p.carried FROM library_cue_mechanism_positions p
       JOIN mechanisms m ON m.id = p.mechanism_id WHERE p.library_cue_id = ? ORDER BY m."order" ASC`, lcId);
  return {
    snapshotStates: states.map(r => ({
      meshName: r.mesh_name, position: parseJson(r.position), rotation: parseJson(r.rotation), scale: parseJson(r.scale),
      ...(r.visible != null ? { visible: !!r.visible } : {}),
    })),
    mechanismPositions: mechs.map(x => {
      const o = { name: x.name, value: Number(x.value) };
      if (secOrNull(x.delay_sec) !== null) o.delaySec = Number(x.delay_sec);
      if (secOrNull(x.duration_sec) !== null) o.durationSec = Number(x.duration_sec);
      return o;
    }),
  };
}

/**
 * 常用擺位的內容 → 這個專案的畫面（物件用 stage_object_id、機關用機關 id）。
 * 物件照 mesh 名稱、機關照名稱對應；這個專案沒有的略過並數出來。
 * 前端把它套進「還沒存的改動」（草稿）。
 */
export async function templateToProjectLook(env, projectId, payload) {
  const objs = await all(env.DB, `SELECT id, mesh_name FROM stage_objects WHERE project_id = ?`, projectId);
  const mechs = await all(env.DB, `SELECT id, name FROM mechanisms WHERE project_id = ?`, projectId);
  const meshToId = new Map(objs.map(o => [o.mesh_name, o.id]));
  const byName = new Map(mechs.map(m => [String(m.name).trim(), m.id]));
  const objects = [], mechanisms = [];
  let skippedObjects = 0, skippedMechanisms = 0;
  const seenO = new Set(), seenM = new Set();
  for (const s of (Array.isArray(payload?.snapshotStates) ? payload.snapshotStates : []).slice(0, 5000)) {
    const oid = meshToId.get(s?.meshName);
    if (!oid || seenO.has(oid)) { skippedObjects++; continue; }
    seenO.add(oid);
    const position = s.position ?? null, rotation = s.rotation ?? null, scale = s.scale ?? null;
    const visible = s.visible === false ? false : true;
    const ownFields = [];
    if (position) ownFields.push('position');
    if (rotation) ownFields.push('rotation');
    if (scale) ownFields.push('scale');
    ownFields.push('visible');
    objects.push({ objectId: oid, position, rotation, scale, visible, customProps: null, own: true, ownFields });
  }
  for (const mp of (Array.isArray(payload?.mechanismPositions) ? payload.mechanismPositions : []).slice(0, 500)) {
    const mid = byName.get(String(mp?.name ?? '').trim());
    if (!mid || seenM.has(mid) || !Number.isFinite(Number(mp.value))) { skippedMechanisms++; continue; }
    seenM.add(mid);
    mechanisms.push({ mechanismId: mid, value: Number(mp.value), delaySec: secOrNull(mp.delaySec), durationSec: secOrNull(mp.durationSec), carried: false });
  }
  return { objects, mechanisms, skipped: { objects: skippedObjects, mechanisms: skippedMechanisms } };
}

// ───────────────────────── 複製專案 / 匯入新格式：把 Cue 庫整份搬到新專案 ─────────────────────────

/**
 * 把 Cue 庫整份寫進新專案（複製專案和匯入 v2 檔共用）。
 * @param {object} d  { libraryCues: [{id,label,name,note,based_on_id}], objectStates: [...原樣的列], mechanismPositions: [...], slots: [{newCueId, oldLibraryCueId}] }
 * @param {Map} objIdMap 舊物件 id → 新物件 id；@param {Map} mechIdMap 舊機關 id → 新機關 id
 * 壞資料（對不到物件 / 機關 / 編號重複）略過。回傳 { libraryCues, objectRows, mechanismRows }
 */
export async function copyLibraryToProject(env, projectId, d, objIdMap, mechIdMap, userId = null) {
  const idMap = new Map();
  const stmts = [];
  const seenLabels = new Set();
  let n = 0;
  for (const l of (Array.isArray(d.libraryCues) ? d.libraryCues : []).slice(0, 5000)) {
    if (!l || typeof l.id !== 'string') continue;
    const label = String(l.label ?? '').trim();
    const key = label.toLowerCase();
    if (!label || [...label].length > 16 || seenLabels.has(key)) continue;
    seenLabels.add(key);
    const nid = rid('lc_', ++n);
    idMap.set(l.id, nid);
    stmts.push(insertLibraryCue(env, {
      id: nid, projectId, label, name: cueName(l.name), note: String(l.note ?? '').slice(0, 2000), userId,
      crossfade: Number.isFinite(Number(l.crossfade_seconds)) && Number(l.crossfade_seconds) >= 0 && Number(l.crossfade_seconds) <= 3600 ? Number(l.crossfade_seconds) : 1,
    }));
  }
  for (const l of (Array.isArray(d.libraryCues) ? d.libraryCues : [])) {
    const nid = idMap.get(l?.id), basedOn = l?.based_on_id ? idMap.get(l.based_on_id) : null;
    if (nid && basedOn) stmts.push(env.DB.prepare(`UPDATE library_cues SET based_on_id = ? WHERE id = ?`).bind(basedOn, nid));
  }
  let objectRows = 0, mechanismRows = 0;
  for (const r of (Array.isArray(d.objectStates) ? d.objectStates : [])) {
    const lc = idMap.get(r?.library_cue_id), oid = objIdMap.get(r?.stage_object_id);
    if (!lc || !oid) continue;
    const own = Number(r.own) === 0 ? 0 : 1;
    const bits = own ? Math.max(0, Math.min(31, Math.trunc(Number(r.own_fields) || 0))) : 0;
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO library_cue_object_states
         (library_cue_id, stage_object_id, position, rotation, scale, visible, custom_props, own, own_fields, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
    ).bind(lc, oid, r.position ?? null, r.rotation ?? null, r.scale ?? null,
      r.visible == null ? null : (Number(r.visible) ? 1 : 0), r.custom_props ?? null, own, bits, r.updated_at ?? null));
    objectRows++;
  }
  for (const r of (Array.isArray(d.mechanismPositions) ? d.mechanismPositions : [])) {
    const lc = idMap.get(r?.library_cue_id), mid = mechIdMap.get(r?.mechanism_id);
    const v = Number(r?.value);
    if (!lc || !mid || !Number.isFinite(v)) continue;
    const carried = Number(r.carried) === 1 ? 1 : 0;
    const t = (x) => (carried || x == null || !Number.isFinite(Number(x)) || Number(x) < 0 || Number(x) > 3600 ? null : Number(x));
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO library_cue_mechanism_positions (library_cue_id, mechanism_id, value, delay_sec, duration_sec, carried, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
    ).bind(lc, mid, v, t(r.delay_sec), t(r.duration_sec), carried, r.updated_at ?? null));
    mechanismRows++;
  }
  for (const s of (Array.isArray(d.slots) ? d.slots : [])) {
    const lc = s?.oldLibraryCueId ? idMap.get(s.oldLibraryCueId) : null;
    if (lc && s.newCueId) stmts.push(env.DB.prepare(`UPDATE cues SET library_cue_id = ? WHERE id = ?`).bind(lc, s.newCueId));
  }
  await runChunks(env, stmts, 200);
  return { libraryCues: idMap.size, objectRows, mechanismRows };
}
