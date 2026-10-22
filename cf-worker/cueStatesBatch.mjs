// 一首歌所有 cue 的「物件位置 / 角度 / 顯示」（cue_object_states）一次看、一次清、一次寫回。
// 給編輯頁 Cue 分頁「所有 cue 的物件回到預設位置」用（可以一次復原）：
//   GET  /songs/:songId/cue-object-states          → 這首歌每個 cue 自己設過的物件（跟 PUT /cues/:cueId/states/:objId 同一份資料）
//   POST /songs/:songId/cue-object-states/clear    → 全部清掉（= 每個 cue 的每個物件都 DELETE …/states/:objId），回傳被清掉的內容（復原用）
//   POST /songs/:songId/cue-object-states/restore  → 把清掉的內容寫回去（同一個 cue 同一個物件已經有的就蓋掉）
// 只動 cue_object_states：cue 的名字、時間、轉場、機關的位置（mechanism_positions）、機關時間軸都不碰。
// 全部只有製作（access.mjs）。一個交易：要嘛全做、要嘛全不做；不會逐一呼叫上百次。

import * as cueLibW from './cueLibraryWrites.mjs';

// Cue 庫模式的專案：處理「這首歌用到的 Cue 庫的 cue」的物件列（改了會影響也用它的別首歌，清單的 shared 會列出來）
const isLibraryProject = async (env, projectId) =>
  Number((await env.DB.prepare(`SELECT cue_library FROM projects WHERE id = ? LIMIT 1`).bind(projectId).first())?.cue_library) === 1;

const ok = (body, status = 200) => ({ status, body });
const bad = (error, status = 400) => ({ status, body: { error } });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const newId = () => 'cos_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

export const MAX_RESTORE_ROWS = 5000;
/** 一個陳述式寫幾列（用 json_each，只綁 1 個參數；一段約 50 列、十幾 KB） */
const WRITE_CHUNK = 50;

function parseJson(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

const SELECT_SQL = `
  SELECT cos.cue_id, cos.stage_object_id, cos.position, cos.rotation, cos.scale, cos.visible, cos.custom_props, cos.updated_at
    FROM cue_object_states cos
    JOIN cues c ON c.id = cos.cue_id
   WHERE c.song_id = ?
   ORDER BY c."order" ASC, c.created_at ASC, cos.stage_object_id ASC`;

function rowToApi(r) {
  return {
    cueId: r.cue_id,
    objectId: r.stage_object_id,
    position: parseJson(r.position),
    rotation: parseJson(r.rotation),
    scale: parseJson(r.scale),
    visible: r.visible == null ? null : !!r.visible,
    customProps: parseJson(r.custom_props),
    updatedAt: r.updated_at || null,
  };
}

export async function listSongStates(env, ctx, songId) {
  if (await isLibraryProject(env, ctx.projectId)) return cueLibW.listSongStatesLibrary(env, songId);
  const rows = (await env.DB.prepare(SELECT_SQL).bind(songId).all()).results || [];
  const cues = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM cues WHERE song_id = ?`).bind(songId).first())?.n || 0;
  return ok({ cueCount: cues, states: rows.map(rowToApi) });
}

export async function clearSongStates(env, ctx, songId, log) {
  if (await isLibraryProject(env, ctx.projectId)) return cueLibW.clearSongStatesLibrary(env, ctx, songId, log);
  // 同一個批次：先讀、再刪（D1 的 batch 是一個交易），回傳的就是刪掉的那些
  const [sel] = await env.DB.batch([
    env.DB.prepare(SELECT_SQL).bind(songId),
    env.DB.prepare(`DELETE FROM cue_object_states WHERE cue_id IN (SELECT id FROM cues WHERE song_id = ?)`).bind(songId),
  ]);
  const states = (sel.results || []).map(rowToApi);
  if (states.length > 0) {
    await log?.('reset', 'song_cue_states', songId, {
      songName: ctx.song?.name,
      removed: states.length,
      cues: new Set(states.map(s => s.cueId)).size,
    });
  }
  return ok({ ok: true, removed: states.length, states });
}

/** 一列要寫回去的內容（格式不對 = null） */
function normalizeRow(raw) {
  if (!isObj(raw) || typeof raw.objectId !== 'string') return null;
  if (typeof raw.cueId !== 'string' && typeof raw.libraryCueId !== 'string') return null;
  const vec = (v, keys) => {
    if (v === null || v === undefined) return { ok: true, value: null };
    if (!isObj(v) || !keys.every(k => typeof v[k] === 'number' && Number.isFinite(v[k]))) return { ok: false };
    return { ok: true, value: JSON.stringify(Object.fromEntries(keys.map(k => [k, v[k]]))) };
  };
  const pos = vec(raw.position, ['x', 'y', 'z']);
  const rot = vec(raw.rotation, ['pitch', 'yaw', 'roll']);
  const scl = vec(raw.scale, ['x', 'y', 'z']);
  if (!pos.ok || !rot.ok || !scl.ok) return null;
  let visible = null;
  if (raw.visible !== null && raw.visible !== undefined) {
    if (typeof raw.visible !== 'boolean') return null;
    visible = raw.visible ? 1 : 0;
  }
  let custom = null;
  if (raw.customProps !== null && raw.customProps !== undefined) {
    if (!isObj(raw.customProps)) return null;
    custom = JSON.stringify(raw.customProps);
    if (custom.length > 20000) return null;
  }
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt.length <= 40 ? raw.updatedAt : null;
  return {
    cueId: typeof raw.cueId === 'string' ? raw.cueId : null, libraryCueId: typeof raw.libraryCueId === 'string' ? raw.libraryCueId : null,
    objectId: raw.objectId, position: pos.value, rotation: rot.value, scale: scl.value, visible, custom, updatedAt,
    own: typeof raw.own === 'boolean' ? raw.own : undefined, ownFields: Number.isInteger(raw.ownFields) ? raw.ownFields : undefined,
  };
}

export async function restoreSongStates(request, env, ctx, songId, log) {
  let body;
  try { body = await request.json(); } catch { return bad('Invalid JSON'); }
  if (!isObj(body) || !Array.isArray(body.states)) return bad('要附上 states（要寫回去的內容）');
  if (body.states.length > MAX_RESTORE_ROWS) return bad(`一次最多寫回 ${MAX_RESTORE_ROWS} 筆`, 413);
  const rows = [];
  const seen = new Set();
  for (const raw of body.states) {
    const r = normalizeRow(raw);
    if (!r) return bad('要寫回去的內容格式不對');
    const k = (r.libraryCueId || r.cueId) + '\n' + r.objectId;
    if (seen.has(k)) return bad('同一個 cue 的同一個物件重複了');
    seen.add(k);
    rows.push(r);
  }
  if (rows.length === 0) return ok({ ok: true, restored: 0 });
  if (await isLibraryProject(env, ctx.projectId)) return cueLibW.restoreSongStatesLibrary(env, ctx, songId, rows, log);

  // cue 要是這首歌的、物件要是這個專案的
  const cueIds = new Set(((await env.DB.prepare(`SELECT id FROM cues WHERE song_id = ?`).bind(songId).all()).results || []).map(r => r.id));
  const objIds = new Set(((await env.DB.prepare(`SELECT id FROM stage_objects WHERE project_id = ?`).bind(ctx.projectId).all()).results || []).map(r => r.id));
  for (const r of rows) {
    if (!cueIds.has(r.cueId)) return bad('有 cue 不在這首歌裡（可能被刪掉了），沒有寫回', 404);
    if (!objIds.has(r.objectId)) return bad('有物件不在這個專案裡（可能被刪掉了），沒有寫回', 404);
  }

  const stmts = [];
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const payload = rows.slice(i, i + WRITE_CHUNK).map(r => ({
      id: newId(), cueId: r.cueId, objectId: r.objectId, position: r.position, rotation: r.rotation, scale: r.scale,
      visible: r.visible, custom: r.custom, updatedAt: r.updatedAt,
    }));
    stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO cue_object_states (id, cue_id, stage_object_id, position, rotation, scale, visible, custom_props, updated_at)
       SELECT json_extract(value, '$.id'), json_extract(value, '$.cueId'), json_extract(value, '$.objectId'),
              json_extract(value, '$.position'), json_extract(value, '$.rotation'), json_extract(value, '$.scale'),
              json_extract(value, '$.visible'), json_extract(value, '$.custom'),
              COALESCE(json_extract(value, '$.updatedAt'), datetime('now'))
         FROM json_each(?)`
    ).bind(JSON.stringify(payload)));
  }
  try {
    await env.DB.batch(stmts);
  } catch (e) {
    return bad('沒有寫回（資料庫拒絕了）：' + String(e?.message || e).slice(0, 160), 400);
  }
  await log?.('restore', 'song_cue_states', songId, { songName: ctx.song?.name, restored: rows.length, cues: new Set(rows.map(r => r.cueId)).size });
  return ok({ ok: true, restored: rows.length });
}
