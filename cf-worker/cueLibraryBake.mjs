// Cue 庫第 4 階段：在後台把「舊格式」的 cue 烤成 Cue 庫的 cue（匯入舊格式的匯出檔、從別的專案匯入 cue 時用）。
// 用跟搬家程式（scripts/migrate-cue-library.mjs）同一批純計算函式：舊算法算出每個 cue 現在看到的畫面 → bakeSlotLook → planProjectMigration。
// loadCueStates 由 worker.js 當參數傳進來（避免互相 import）。

import { loadMechanisms, loadSongPositions } from './mechanisms.mjs';
import { resolveSongMechanisms, ownValuesByCue, ownTimingsByCue } from './mechanismTrack.mjs';
import { bakeSlotLook, planProjectMigration, CUE_NAME_MAX, suggestLabel } from './cueLibrary.mjs';

const all = async (db, sql, ...binds) => (await db.prepare(sql).bind(...binds).all()).results || [];

/** 一首歌每個 cue（舊模式）現在的畫面，烤成 Cue 庫的列：Map cueId → { objects, mechanisms } */
export async function bakeSongLooks(env, projectId, songId, mechs, loadCueStates) {
  const cues = await all(env.DB, `SELECT id, name, "order", status, created_at FROM cues WHERE song_id = ? ORDER BY "order" ASC, created_at ASC`, songId);
  const positions = (await loadSongPositions(env, songId, { masterOnly: false, mech2: true, mech3: true }))
    .map(p => ({ cueId: p.cueId, mechanismId: p.mechanismId, value: p.value, delaySec: p.delaySec, durationSec: p.durationSec }));
  const resolved = resolveSongMechanisms(mechs, cues, ownValuesByCue(positions));
  const timings = ownTimingsByCue(positions);
  const out = new Map();
  for (const c of cues) {
    const states = await loadCueStates(env, projectId, c.id);
    out.set(c.id, bakeSlotLook({ states, mechs, resolved: resolved.get(c.id) || {}, timings: timings.get(c.id) || {} }));
  }
  return { cues, looks: out };
}

/**
 * 整個專案（舊模式的資料）烤成 Cue 庫並切成 Cue 庫模式。舊的資料原封不動（凍結）。
 * 用在匯入舊格式（v1）的匯出檔：資料先照舊匯進新專案，再呼叫這個。
 */
export async function bakeProjectToLibrary(env, projectId, loadCueStates, userId = null) {
  const songs = await all(env.DB, `SELECT id, name, code, "order" FROM songs WHERE project_id = ? ORDER BY "order" ASC, created_at ASC, id ASC`, projectId);
  const mechs = await loadMechanisms(env, projectId, null, { mech2: true, mech3: true });
  const slots = [];
  for (const s of songs) {
    const { cues, looks } = await bakeSongLooks(env, projectId, s.id, mechs, loadCueStates);
    for (const c of cues) slots.push({ id: c.id, songId: s.id, name: c.name, order: c.order, createdAt: c.created_at, look: looks.get(c.id) });
  }
  const plan = planProjectMigration({ projectId, songs, slots });
  const stmts = [];
  const objCols = `library_cue_id, stage_object_id, position, rotation, scale, visible, custom_props, own, own_fields, updated_at`;
  for (const l of plan.libraryCues) {
    stmts.push(env.DB.prepare(
      `INSERT INTO library_cues (id, project_id, label, name, migrated_from, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(l.id, projectId, l.label, l.name, JSON.stringify(l.migratedFrom), userId));
    for (const o of l.objects) {
      stmts.push(env.DB.prepare(`INSERT INTO library_cue_object_states (${objCols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`)
        .bind(l.id, o.stage_object_id, o.position, o.rotation, o.scale, o.visible, o.custom_props, o.own, o.own_fields, o.updated_at ?? null));
    }
    for (const m of l.mechanisms) {
      stmts.push(env.DB.prepare(
        `INSERT INTO library_cue_mechanism_positions (library_cue_id, mechanism_id, value, delay_sec, duration_sec, carried) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(l.id, m.mechanism_id, m.value, m.delay_sec, m.duration_sec, m.carried));
    }
  }
  for (const [slotId, libId] of Object.entries(plan.slotToLibrary)) {
    stmts.push(env.DB.prepare(`UPDATE cues SET library_cue_id = ? WHERE id = ?`).bind(libId, slotId));
  }
  stmts.push(env.DB.prepare(`UPDATE projects SET cue_library = 1 WHERE id = ?`).bind(projectId));
  for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
  return { libraryCues: plan.libraryCues.length, slots: slots.length };
}

/**
 * 從別的專案匯入 cue：來源 cue 現在的畫面（來源是舊模式就用舊算法算，是 Cue 庫模式就讀它的 Cue 庫）
 * → 用物件的 mesh 名稱、機關的名稱對到這個專案。回傳 Map 來源 cue id → { objects: [{meshName, ...列}], mechanisms: [{name, ...列}] }
 */
export async function sourceLooksByName(env, srcProjectId, srcSongId, srcCueIds, loadCueStates) {
  const srcProj = await env.DB.prepare(`SELECT cue_library FROM projects WHERE id = ?`).bind(srcProjectId).first();
  const mechs = await loadMechanisms(env, srcProjectId, null, { mech2: true, mech3: true });
  const objs = await all(env.DB, `SELECT id, mesh_name FROM stage_objects WHERE project_id = ?`, srcProjectId);
  const meshOf = new Map(objs.map(o => [o.id, o.mesh_name]));
  const nameOf = new Map(mechs.map(m => [m.id, m.name]));
  const out = new Map();
  const toNamed = (look) => ({
    objects: look.objects.filter(o => meshOf.has(o.stage_object_id)).map(o => ({ ...o, meshName: meshOf.get(o.stage_object_id) })),
    mechanisms: look.mechanisms.filter(m => nameOf.has(m.mechanism_id)).map(m => ({ ...m, name: nameOf.get(m.mechanism_id) })),
  });
  if (Number(srcProj?.cue_library) === 1) {
    for (const cueId of srcCueIds) {
      const c = await env.DB.prepare(`SELECT library_cue_id FROM cues WHERE id = ?`).bind(cueId).first();
      const lc = c?.library_cue_id;
      out.set(cueId, toNamed({
        objects: lc ? await all(env.DB, `SELECT * FROM library_cue_object_states WHERE library_cue_id = ?`, lc) : [],
        mechanisms: lc ? await all(env.DB, `SELECT * FROM library_cue_mechanism_positions WHERE library_cue_id = ?`, lc) : [],
      }));
    }
  } else {
    const { looks } = await bakeSongLooks(env, srcProjectId, srcSongId, mechs, loadCueStates);
    for (const cueId of srcCueIds) out.set(cueId, toNamed(looks.get(cueId) || { objects: [], mechanisms: [] }));
  }
  return out;
}

/** 這個專案的一個新的 Cue 庫的 cue（畫面來自 sourceLooksByName 的結果）：寫進資料庫，回傳 id */
export async function insertLibraryCueFromNamedLook(env, projectId, { name, labels, look, userId = null, meshToId, mechByName, slotId }) {
  const id = 'lc_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const label = suggestLabel(labels);
  labels.push(label);
  const stmts = [env.DB.prepare(`INSERT INTO library_cues (id, project_id, label, name, created_by_user_id) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, projectId, label, [...String(name ?? '').trim()].slice(0, CUE_NAME_MAX).join('') || '新的 cue', userId)];
  for (const o of look.objects) {
    const oid = meshToId.get(o.meshName);
    if (!oid) continue;
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO library_cue_object_states (library_cue_id, stage_object_id, position, rotation, scale, visible, custom_props, own, own_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, oid, o.position ?? null, o.rotation ?? null, o.scale ?? null, o.visible ?? null, o.custom_props ?? null, o.own, o.own_fields));
  }
  for (const m of look.mechanisms) {
    const t = mechByName.get(String(m.name).trim());
    if (!t || t.variant === 'hoist_rig') continue;
    const v = Math.min(Math.max(Number(m.value), Number(t.travel_min)), Number(t.travel_max));
    if (!Number.isFinite(v)) continue;
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO library_cue_mechanism_positions (library_cue_id, mechanism_id, value, delay_sec, duration_sec, carried) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, t.id, v, m.delay_sec ?? null, m.duration_sec ?? null, Number(m.carried) === 1 ? 1 : 0));
  }
  stmts.push(env.DB.prepare(`UPDATE cues SET library_cue_id = ? WHERE id = ?`).bind(id, slotId));
  for (let i = 0; i < stmts.length; i += 200) await env.DB.batch(stmts.slice(i, i + 200));
  return id;
}

