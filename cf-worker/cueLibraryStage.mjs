// 導演頁「調整舞台」第 3 段：存起來（Cue 庫模式的專案）。
// 設計：docs/superpowers/specs/2026-10-29-director-stage-control-design.md 第 5、6 節。
//
// 權限（access.mjs 的 directorStage）：這個專案的導演、專案的製作、全站製作；動畫師 403。
// 導演不能用製作那條「整個畫面一次換掉 / 改物件」的路（PUT library-cues/:lc/look 還是只有製作）；
// 這裡每個 handler 自己再檢查 body：只收允許的欄位，多送別的（物件、編號、備註…）= 400，不會偷偷被改。
//
//   PUT   library-cues/:lc/mechanism-positions   存回 Cue 庫：只換這個 cue 的機關位置（值、延遲、走幾秒、carried，整份換掉）
//         { ifRev, mechanisms: [{ mechanismId, value, delaySec, durationSec, carried }], songId?, undo? }
//         ifRev = 拿到這個 cue 的時候的 rev；現在的 rev 不一樣 → 409「這個 cue 剛剛被 ○○ 改過」。
//         回 { rev, previous: { rev, mechanisms }, songs, changed, notified }；復原 = 把 previous 用新的 rev 再存一次（undo: true）
//   POST  library-cues/:lc/stage-save-as         另存成新 cue（編號自動給下一個、物件設定照抄、機關位置用導演調的），
//         { name?, mechanisms, songId, cueId }   並且只把「這首歌的這個 cue」換成新的
//   POST  library-cues/:lc/stage-copy            從現有 cue 複製一個新的放進 Cue 庫（不放進任何歌）{ name? }
//   PATCH library-cues/:lc/stage                 改名字（編號不動）、改 Cue 庫的轉場秒數 { name?, crossfadeSeconds?, songId? }
//   PUT   songs/:s/cues/:c/stage-crossfade       改「這首歌的這個 cue 自己設的」轉場秒數 { crossfadeSeconds }
//
// 存回 / 另存 / 改秒數之後：寫活動紀錄、通知這個專案的製作 + 用到這個 cue 的歌的負責動畫師（不通知自己、同一人一則）。
// handler 回 { status, body }（跟 cueLibraryCrud.mjs 一樣）；log 是 worker.js 的 mechLog。

import { CUE_NAME_MAX, nextVariantLabel, validateLook } from './cueLibrary.mjs';
import { patchLibraryCue, patchSlot } from './cueLibraryCrud.mjs';
import { insertNotifications, pickRecipients, projectMemberIds } from './reviews.mjs';

const ok = (body, status = 200) => ({ status, body });
const bad = (error, status = 400, extra = {}) => ({ status, body: { error, ...extra } });
const all = async (db, sql, ...binds) => (await db.prepare(sql).bind(...binds).all()).results || [];
const rid = (prefix) => prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const NOT_LIB = '這個專案還沒有 Cue 庫';
const NOT_FOUND = '這個專案裡找不到這個 Cue 庫的 cue';
const ROWS_PER_STMT = 100;
const EPS = 1e-6;
/** 導演不能送的欄位被擋下時的說明 */
export const STAGE_FIELD_MESSAGE = '調整舞台只能改機關位置、名字和轉場秒數，不能送別的欄位';

async function readJson(request) {
  try { const b = await request.json(); return isObj(b) ? b : null; } catch { return null; }
}

const cleanName = (s) => [...String(s ?? '').trim()].slice(0, CUE_NAME_MAX).join('');
const uidOf = (ctx) => ctx.me?.id ?? ctx.userId ?? null;
const secOrNull = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const isUniqueError = (e) => /UNIQUE|constraint/i.test(String(e?.message || e));

/** body 裡有沒有不在名單上的欄位 → 回第一個多出來的欄位名 */
function extraKey(obj, allowed) {
  return Object.keys(obj).find(k => !allowed.includes(k)) ?? null;
}
const notAllowed = (field) => bad(STAGE_FIELD_MESSAGE, 400, { field });

async function guardLibrary(env, ctx) {
  const r = await env.DB.prepare(`SELECT cue_library FROM projects WHERE id = ? LIMIT 1`).bind(ctx.projectId).first();
  return Number(r?.cue_library) === 1;
}
async function getRow(env, projectId, lcId) {
  return env.DB.prepare(`SELECT * FROM library_cues WHERE id = ? AND project_id = ? LIMIT 1`).bind(lcId, projectId).first();
}

// ───────────────────────── 通知文字（純函式，有測試） ─────────────────────────

const songTag = (s) => String(s?.code || s?.name || '一首歌');
const fmtSec = (n) => String(Math.round(Number(n) * 100) / 100);

/** 「S05、S12、S17」；超過 max 首寫「S05、S12、S17、S20、S21 等 7 首」 */
export function songListText(songs, max = 5) {
  const tags = (songs || []).map(songTag);
  return tags.length <= max ? tags.join('、') : `${tags.slice(0, max).join('、')} 等 ${tags.length} 首`;
}

/**
 * 通知上「導演 ○○」後面接的那句話（前端：導演 ${名字} ${這句話}）。
 * kind：save 存回、undo 復原、save_as 另存、crossfade 改 Cue 庫的轉場秒數、slot_crossfade 改這首歌自己的轉場秒數
 */
export function stageNotifyText(kind, o) {
  const cue = `cue ${o.label}`;
  const together = o.songs?.length ? `（${songListText(o.songs)} 會一起變）` : '';
  switch (kind) {
    case 'save': return `改了 ${cue} 的舞台${together}`;
    case 'undo': return `復原了 ${cue} 的舞台調整${together}`;
    case 'save_as': return `另存了 cue ${o.newLabel}（從 ${cue}），${songTag(o.song)} 改用新的`;
    case 'crossfade': return `把 ${cue} 的轉場改成 ${fmtSec(o.seconds)} 秒${together}`;
    case 'slot_crossfade': return `把 ${cue} 在 ${songTag(o.song)} 的轉場改成 ${fmtSec(o.seconds)} 秒`;
    default: return `改了 ${cue} 的舞台${together}`;
  }
}

// ───────────────────────── 讀 ─────────────────────────

/** 用到這個 Cue 庫的 cue 的歌（照歌單順序、每首歌一筆） */
async function usageSongs(env, projectId, lcId) {
  return all(env.DB,
    `SELECT DISTINCT s.id, s.name, s.code, s.animator_user_id, s."order", s.created_at
       FROM cues c JOIN songs s ON s.id = c.song_id
      WHERE s.project_id = ? AND c.library_cue_id = ?
      ORDER BY s."order" ASC, s.created_at ASC, s.id ASC`, projectId, lcId);
}
const songOut = (s) => ({ id: s.id, name: s.name, code: s.code ?? null });

async function readMechRows(env, lcId) {
  return all(env.DB, `SELECT * FROM library_cue_mechanism_positions WHERE library_cue_id = ? ORDER BY mechanism_id ASC`, lcId);
}
const mechRowOut = (r) => ({
  mechanismId: r.mechanism_id, value: Number(r.value), delaySec: secOrNull(r.delay_sec), durationSec: secOrNull(r.duration_sec), carried: Number(r.carried) === 1,
});

async function loadMechanisms(env, projectId) {
  const rows = await all(env.DB, `SELECT id, name, variant, travel_min, travel_max, default_value FROM mechanisms WHERE project_id = ?`, projectId);
  return new Map(rows.map(m => [m.id, m]));
}

// ───────────────────────── 檢查送來的機關位置 ─────────────────────────

const ROW_KEYS = ['mechanismId', 'value', 'delaySec', 'durationSec', 'carried'];
const timeOk = (v) => v === undefined || v === null || (typeof v === 'number' && Number.isFinite(v));

/** API 格式的機關位置 → 資料表格式的列；多送欄位 / 格式不對 → { ok: false, error, field? } */
function parseMechRows(list) {
  if (!Array.isArray(list)) return { ok: false, error: '機關位置的格式不對', field: 'mechanisms' };
  const rows = [];
  for (const m of list) {
    if (!isObj(m)) return { ok: false, error: '機關位置的格式不對', field: 'mechanisms' };
    const extra = extraKey(m, ROW_KEYS);
    if (extra) return { ok: false, error: STAGE_FIELD_MESSAGE, field: extra };
    if (typeof m.mechanismId !== 'string') return { ok: false, error: '機關位置的格式不對', field: 'mechanismId' };
    if (typeof m.value !== 'number' || !Number.isFinite(m.value)) return { ok: false, error: '機關位置不是數字', field: 'value' };
    if (!timeOk(m.delaySec) || !timeOk(m.durationSec)) return { ok: false, error: '機關的延遲 / 走幾秒要是數字', field: 'delaySec' };
    if (m.carried !== undefined && m.carried !== null && typeof m.carried !== 'boolean') return { ok: false, error: '機關的「沿用」標記不對', field: 'carried' };
    rows.push({ mechanism_id: m.mechanismId, value: m.value, delay_sec: m.delaySec ?? null, duration_sec: m.durationSec ?? null, carried: m.carried ? 1 : 0 });
  }
  return { ok: true, rows };
}

/**
 * 整份機關位置的檢查：格式 → 都是這個專案的機關（validateLook）→ 改過的值沒超出行程。
 * 沒改的列（跟現在存的一樣）不檢查行程，舊資料裡本來就超出行程的不會讓整個存不了。
 * @param {object[]|null} prevRows 現在存的列（資料表格式；另存時是原本那個 cue 的列）；傳 null = 每一列都要在行程內
 */
async function checkMechRows(env, projectId, list, prevRows) {
  const parsed = parseMechRows(list);
  if (!parsed.ok) return parsed;
  const mechs = await loadMechanisms(env, projectId);
  const v = validateLook(
    { objects: [], mechanisms: parsed.rows },
    { objectIds: new Set(), mechanisms: new Map([...mechs].map(([id, m]) => [id, { variant: m.variant || null }])) },
  );
  if (!v.ok) return { ok: false, error: v.error, field: 'mechanisms' };
  const prev = prevRows ? new Map(prevRows.map(r => [r.mechanism_id, r])) : null;
  for (const r of parsed.rows) {
    const meta = mechs.get(r.mechanism_id);
    if (prev) {
      const before = prev.has(r.mechanism_id) ? Number(prev.get(r.mechanism_id).value) : Number(meta.default_value);
      if (Math.abs(r.value - before) < 1e-9) continue;
    }
    if (r.value < Number(meta.travel_min) - EPS || r.value > Number(meta.travel_max) + EPS) {
      return { ok: false, error: `機關「${meta.name}」的位置超出它能走的行程`, field: 'value' };
    }
  }
  return { ok: true, rows: parsed.rows };
}

const rowKey = (r) => `${r.mechanism_id}|${Number(r.value)}|${secOrNull(r.delay_sec)}|${secOrNull(r.duration_sec)}|${Number(r.carried) === 1 ? 1 : 0}`;
/** 新舊兩份有幾個機關不一樣（值、時間、沿用任何一個不同，或多了 / 少了一列） */
function changedMechanisms(prevRows, nextRows) {
  const a = new Map(prevRows.map(r => [r.mechanism_id, rowKey(r)]));
  const b = new Map(nextRows.map(r => [r.mechanism_id, rowKey(r)]));
  let n = 0;
  for (const [id, k] of b) if (a.get(id) !== k) n++;
  for (const id of a.keys()) if (!b.has(id)) n++;
  return n;
}

// ───────────────────────── 寫 ─────────────────────────

/** 把機關位置寫進某個 Cue 庫的 cue 的陳述式（guardRev 有給 = 每一個陳述式都綁在「rev 還是這個值」上） */
function mechRowStmts(env, lcId, rows, { replace, guardRev }) {
  const guard = guardRev == null ? '' : ` AND EXISTS (SELECT 1 FROM library_cues WHERE id = ? AND rev = ?)`;
  const gb = guardRev == null ? [] : [lcId, guardRev];
  const stmts = [];
  if (replace) {
    stmts.push(env.DB.prepare(`DELETE FROM library_cue_mechanism_positions WHERE library_cue_id = ?${guard}`).bind(lcId, ...gb));
  }
  for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
    const chunk = rows.slice(i, i + ROWS_PER_STMT).map(m => ({ m: m.mechanism_id, v: m.value, d: m.delay_sec, u: m.duration_sec, c: m.carried }));
    stmts.push(env.DB.prepare(
      `INSERT INTO library_cue_mechanism_positions (library_cue_id, mechanism_id, value, delay_sec, duration_sec, carried, updated_at)
       SELECT ?, json_extract(value, '$.m'), json_extract(value, '$.v'), json_extract(value, '$.d'), json_extract(value, '$.u'),
              json_extract(value, '$.c'), datetime('now')
         FROM json_each(?) WHERE 1 = 1${guard}`).bind(lcId, JSON.stringify(chunk), ...gb));
  }
  return stmts;
}

/** 最後一次改這個 cue 的人（跟現在的 rev 對得上才算；對不上 = 後來有沒記人的寫入 → 不亂指名） */
async function lastEditor(env, lcId) {
  let r;
  try {
    r = await env.DB.prepare(
      `SELECT l.rev, l.updated_by_user_id AS uid, l.updated_by_rev AS urev, u.name AS name
         FROM library_cues l LEFT JOIN users u ON u.id = l.updated_by_user_id WHERE l.id = ? LIMIT 1`).bind(lcId).first();
  } catch (e) {
    if (!/no such column/i.test(String(e?.message || e))) throw e;
    r = await env.DB.prepare(`SELECT rev FROM library_cues WHERE id = ? LIMIT 1`).bind(lcId).first();   // 還沒跑 0048
  }
  const known = !!(r && r.uid && r.name && r.urev != null && Number(r.urev) === Number(r.rev));
  return { rev: r ? Number(r.rev) : null, known, id: known ? r.uid : null, name: known ? r.name : null };
}

async function conflict(env, ctx, lcId) {
  const e = await lastEditor(env, lcId);
  const msg = !e.known ? '這個 cue 剛剛被別人改過'
    : e.id === uidOf(ctx) ? '這個 cue 剛剛在你的另一個畫面被改過'
    : `這個 cue 剛剛被 ${e.name} 改過`;
  return bad(msg, 409, { conflict: true, rev: e.rev, changedBy: e.known ? { id: e.id, name: e.name } : null });
}

/** 通知：製作（這個專案的製作 + 全站製作）+ 用到這個 cue 的歌的負責動畫師；不通知自己、同一人一則（動畫師的優先：點了開自己的歌） */
async function notifyStage(env, ctx, { songs, linkSongId, text }) {
  try {
    const actorId = uidOf(ctx);
    const { members, memberIds } = await projectMemberIds(env.DB, ctx.projectId);
    const link = songs.find(s => s.id === linkSongId) || songs[0] || null;
    const wants = [];
    for (const s of songs) {
      if (s.animator_user_id) wants.push({ userId: s.animator_user_id, kind: 'director_stage', songId: s.id, songName: s.name });
    }
    for (const m of members) {
      if (m.role === 'admin') wants.push({ userId: m.user_id, kind: 'director_stage', songId: link?.id ?? null, songName: link?.name ?? '' });
    }
    const recipients = pickRecipients(wants, memberIds, actorId);
    return await insertNotifications(env.DB, recipients.map(r => ({
      ...r, projectId: ctx.projectId, actorUserId: actorId, actorName: ctx.me?.name || '', excerpt: text,
    })));
  } catch (e) {
    console.error('[stage notify]', e?.message || e);
    return 0;
  }
}

// ───────────────────────── 存回 Cue 庫 ─────────────────────────

/** PUT library-cues/:lc/mechanism-positions */
export async function putStagePositions(request, env, ctx, lcId, log) {
  if (!(await guardLibrary(env, ctx))) return bad(NOT_LIB);
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  const extra = extraKey(body, ['ifRev', 'mechanisms', 'songId', 'undo']);
  if (extra) return notAllowed(extra);
  if (!Number.isInteger(body.ifRev) || body.ifRev < 0) return bad('要帶這個 cue 拿到的時候的版本（ifRev）', 400, { field: 'ifRev' });
  if (body.songId != null && typeof body.songId !== 'string') return bad('歌不對', 400, { field: 'songId' });
  if (body.undo != null && typeof body.undo !== 'boolean') return bad('復原的標記不對', 400, { field: 'undo' });
  const row = await getRow(env, ctx.projectId, lcId);
  if (!row) return bad(NOT_FOUND, 404);

  const prevRows = await readMechRows(env, lcId);
  const checked = await checkMechRows(env, ctx.projectId, body.mechanisms, prevRows);
  if (!checked.ok) return bad(checked.error, 400, { field: checked.field });
  const rows = checked.rows;

  const expect = body.ifRev;
  if (Number(row.rev) !== expect) return conflict(env, ctx, lcId);

  const changed = changedMechanisms(prevRows, rows);
  if (changed === 0) return ok({ ok: true, unchanged: true, rev: expect, songs: [], changed: 0, notified: 0 });

  const uid = uidOf(ctx);
  // 最後一個陳述式才 rev + 1（順便記是誰改的，0048）；還沒跑 0048 的資料庫 → 不記人，其他照舊
  const buildStmts = (stamp) => [
    ...mechRowStmts(env, lcId, rows, { replace: true, guardRev: expect }),
    stamp
      ? env.DB.prepare(
        `UPDATE library_cues SET rev = rev + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), updated_by_user_id = ?, updated_by_rev = ?
          WHERE id = ? AND rev = ?`).bind(uid, expect + 1, lcId, expect)
      : env.DB.prepare(
        `UPDATE library_cues SET rev = rev + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND rev = ?`).bind(lcId, expect),
  ];
  let res;
  try {
    try { res = await env.DB.batch(buildStmts(true)); } catch (e) {
      if (!/no such column/i.test(String(e?.message || e))) throw e;
      res = await env.DB.batch(buildStmts(false));
    }
  } catch (e) { return bad('沒有存進去（資料庫拒絕了）：' + String(e?.message || e).slice(0, 160)); }
  // 這中間剛好被別人改了：每個寫入都綁在舊的 rev 上，所以什麼都沒寫進去
  if (!Number(res[res.length - 1]?.meta?.changes)) return conflict(env, ctx, lcId);

  const songs = await usageSongs(env, ctx.projectId, lcId);
  const undo = body.undo === true;
  await log?.('update', 'library_cue', lcId, {
    kind: undo ? 'stage_undo' : 'stage_save', label: row.label, name: row.name, changed, songCount: songs.length, songs: songs.slice(0, 8).map(songTag),
  });
  const notified = await notifyStage(env, ctx, {
    songs, linkSongId: body.songId ?? null, text: stageNotifyText(undo ? 'undo' : 'save', { label: row.label, songs }),
  });
  return ok({ ok: true, rev: expect + 1, previous: { rev: expect, mechanisms: prevRows.map(mechRowOut) }, songs: songs.map(songOut), changed, notified });
}

// ───────────────────────── 另存成新 cue / 複製 ─────────────────────────

/** 新的 Cue 庫的 cue 的陳述式（物件設定照抄來源）；mechRows 有給 = 機關位置用這份，沒給 = 也照抄來源 */
function newCueStmts(env, { id, projectId, label, name, base, mechRows, userId }) {
  const stmts = [env.DB.prepare(
    `INSERT INTO library_cues (id, project_id, label, name, note, based_on_id, crossfade_seconds, created_by_user_id) VALUES (?, ?, ?, ?, '', ?, ?, ?)`
  ).bind(id, projectId, label, name, base.id, base.crossfade_seconds == null ? 1 : Number(base.crossfade_seconds), userId)];
  stmts.push(env.DB.prepare(
    `INSERT INTO library_cue_object_states (library_cue_id, stage_object_id, position, rotation, scale, visible, custom_props, own, own_fields, updated_at)
     SELECT ?, stage_object_id, position, rotation, scale, visible, custom_props, own, own_fields, updated_at
       FROM library_cue_object_states WHERE library_cue_id = ?`).bind(id, base.id));
  if (mechRows) {
    stmts.push(...mechRowStmts(env, id, mechRows, { replace: false, guardRev: null }));
  } else {
    stmts.push(env.DB.prepare(
      `INSERT INTO library_cue_mechanism_positions (library_cue_id, mechanism_id, value, delay_sec, duration_sec, carried, updated_at)
       SELECT ?, mechanism_id, value, delay_sec, duration_sec, carried, updated_at
         FROM library_cue_mechanism_positions WHERE library_cue_id = ?`).bind(id, base.id));
  }
  return stmts;
}

/** 編號被搶先用掉（同時有人另存）→ 重新算一次，最多試幾次 */
async function insertWithFreshLabel(env, ctx, { base, build }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const labels = (await all(env.DB, `SELECT label FROM library_cues WHERE project_id = ?`, ctx.projectId)).map(r => r.label);
    const label = nextVariantLabel(base.label, labels);
    const { stmts, id } = build(label);
    try { await env.DB.batch(stmts); return { ok: true, id, label }; } catch (e) {
      if (isUniqueError(e) && /library_cues|label/i.test(String(e.message))) continue;
      return { ok: false, error: bad('沒有存進去（資料庫拒絕了）：' + String(e?.message || e).slice(0, 160)) };
    }
  }
  return { ok: false, error: bad('編號剛好被別人用掉了，請再按一次', 409) };
}

/** POST library-cues/:lc/stage-save-as */
export async function stageSaveAs(request, env, ctx, lcId, log) {
  if (!(await guardLibrary(env, ctx))) return bad(NOT_LIB);
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  const extra = extraKey(body, ['name', 'mechanisms', 'songId', 'cueId']);
  if (extra) return notAllowed(extra);
  if (typeof body.songId !== 'string' || typeof body.cueId !== 'string') return bad('要說明是哪一首歌的哪一個 cue', 400, { field: 'cueId' });
  if (body.name != null && typeof body.name !== 'string') return bad('名稱不對', 400, { field: 'name' });
  const base = await getRow(env, ctx.projectId, lcId);
  if (!base) return bad(NOT_FOUND, 404);
  const name = body.name == null ? cleanName(`${base.name}（導演改）`) : cleanName(body.name);
  if (!name) return bad('名稱不能空白', 400, { field: 'name' });

  const slot = await env.DB.prepare(
    `SELECT c.id, c.library_cue_id, c.video_time_sec, s.id AS song_id, s.name AS song_name, s.code AS song_code, s.animator_user_id
       FROM cues c JOIN songs s ON s.id = c.song_id WHERE c.id = ? AND c.song_id = ? AND s.project_id = ? LIMIT 1`
  ).bind(body.cueId, body.songId, ctx.projectId).first();
  if (!slot) return bad('這個專案裡找不到這首歌的這個 cue', 404);
  if (slot.library_cue_id !== lcId) return bad('這首歌的這個 cue 剛剛換成別的 cue 了，請重新載入再另存', 409, { conflict: true });

  // 跟原本的 cue 一樣的列不檢查行程（舊資料裡本來就超出行程的不會讓整個存不了），導演改過的才檢查
  const checked = await checkMechRows(env, ctx.projectId, body.mechanisms, await readMechRows(env, lcId));
  if (!checked.ok) return bad(checked.error, 400, { field: checked.field });
  const uid = uidOf(ctx);

  const made = await insertWithFreshLabel(env, ctx, {
    base,
    build: (label) => {
      const id = rid('lc_');
      return {
        id,
        stmts: [
          ...newCueStmts(env, { id, projectId: ctx.projectId, label, name, base, mechRows: checked.rows, userId: uid }),
          // 只把這首歌的這個 cue 換成新的（別首歌照舊用原本的）；用 Cue 庫轉場的，秒數跟著新 cue 的
          env.DB.prepare(
            `UPDATE cues SET library_cue_id = ?, crossfade_seconds = CASE WHEN crossfade_own = 0 THEN ? ELSE crossfade_seconds END, updated_at = datetime('now') WHERE id = ?`
          ).bind(id, base.crossfade_seconds == null ? 1 : Number(base.crossfade_seconds), slot.id),
        ],
      };
    },
  });
  if (!made.ok) return made.error;

  const created = await getRow(env, ctx.projectId, made.id);
  await log?.('create', 'library_cue', made.id, {
    kind: 'stage_save_as', label: created.label, name: created.name, basedOnLabel: base.label, basedOnName: base.name, songName: slot.song_name, placed: 'replace',
  });
  await log?.('update', 'cue', slot.id, {
    kind: 'repoint', songName: slot.song_name, name: created.name, videoTimeSec: secOrNull(slot.video_time_sec), libraryLabel: created.label, libraryName: created.name,
  });
  const song = { id: slot.song_id, name: slot.song_name, code: slot.song_code, animator_user_id: slot.animator_user_id };
  const notified = await notifyStage(env, ctx, {
    songs: [song], linkSongId: song.id, text: stageNotifyText('save_as', { label: base.label, newLabel: created.label, song }),
  });
  return ok({
    libraryCue: { id: created.id, label: created.label, name: created.name, basedOnId: base.id, rev: Number(created.rev), crossfadeSeconds: Number(created.crossfade_seconds) },
    slot: { id: slot.id, songId: slot.song_id, libraryCueId: created.id },
    song: songOut(song), notified,
  }, 201);
}

/** POST library-cues/:lc/stage-copy */
export async function stageCopy(request, env, ctx, lcId, log) {
  if (!(await guardLibrary(env, ctx))) return bad(NOT_LIB);
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  const extra = extraKey(body, ['name']);
  if (extra) return notAllowed(extra);
  if (body.name != null && typeof body.name !== 'string') return bad('名稱不對', 400, { field: 'name' });
  const base = await getRow(env, ctx.projectId, lcId);
  if (!base) return bad(NOT_FOUND, 404);
  const name = body.name == null ? cleanName(`${base.name}（複製）`) : cleanName(body.name);
  if (!name) return bad('名稱不能空白', 400, { field: 'name' });

  const made = await insertWithFreshLabel(env, ctx, {
    base,
    build: (label) => {
      const id = rid('lc_');
      return { id, stmts: newCueStmts(env, { id, projectId: ctx.projectId, label, name, base, mechRows: null, userId: uidOf(ctx) }) };
    },
  });
  if (!made.ok) return made.error;
  const created = await getRow(env, ctx.projectId, made.id);
  await log?.('create', 'library_cue', made.id, {
    kind: 'stage_copy', label: created.label, name: created.name, basedOnLabel: base.label, basedOnName: base.name,
  });
  return ok({
    libraryCue: { id: created.id, label: created.label, name: created.name, basedOnId: base.id, rev: Number(created.rev), crossfadeSeconds: Number(created.crossfade_seconds) },
  }, 201);
}

// ───────────────────────── 改名 / 轉場秒數 ─────────────────────────

/** PATCH library-cues/:lc/stage { name?, crossfadeSeconds?, songId? } —— 編號不能改（label 一送就 400） */
export async function stagePatch(request, env, ctx, lcId, log) {
  if (!(await guardLibrary(env, ctx))) return bad(NOT_LIB);
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  const extra = extraKey(body, ['name', 'crossfadeSeconds', 'songId']);
  if (extra) return notAllowed(extra);
  if (!('name' in body) && !('crossfadeSeconds' in body)) return bad('沒有可以改的欄位');
  if (body.songId != null && typeof body.songId !== 'string') return bad('歌不對', 400, { field: 'songId' });
  if ('name' in body && typeof body.name !== 'string') return bad('名稱不對', 400, { field: 'name' });
  if ('crossfadeSeconds' in body && (typeof body.crossfadeSeconds !== 'number' || !Number.isFinite(body.crossfadeSeconds))) {
    return bad('淡入淡出秒數不對（0 到 3600）', 400, { field: 'crossfadeSeconds' });
  }
  const row = await getRow(env, ctx.projectId, lcId);
  if (!row) return bad(NOT_FOUND, 404);

  // 交給原本改名 / 改秒數的邏輯（用到 Cue 庫轉場的那些歌的 cue 秒數一起同步、寫活動紀錄），只轉交允許的兩個欄位
  const allowed = {};
  if ('name' in body) allowed.name = body.name;
  if ('crossfadeSeconds' in body) allowed.crossfadeSeconds = body.crossfadeSeconds;
  const inner = new Request('https://stage.invalid/', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(allowed) });
  const res = await patchLibraryCue(inner, env, ctx, lcId, log);
  if (res.status >= 400) return res;

  const secondsChanged = 'crossfadeSeconds' in body && Number(row.crossfade_seconds) !== body.crossfadeSeconds;
  let notified = 0;
  if (secondsChanged) {
    const songs = await usageSongs(env, ctx.projectId, lcId);
    notified = await notifyStage(env, ctx, {
      songs, linkSongId: body.songId ?? null, text: stageNotifyText('crossfade', { label: row.label, songs, seconds: body.crossfadeSeconds }),
    });
  }
  return { status: res.status, body: { ...res.body, notified } };
}

/** PUT songs/:s/cues/:c/stage-crossfade { crossfadeSeconds } —— 這首歌的這個 cue 自己設的秒數（沒另外設的不能用這條改） */
export async function putStageSlotCrossfade(request, env, ctx, songId, cueId, log) {
  if (!(await guardLibrary(env, ctx))) return bad(NOT_LIB);
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  const extra = extraKey(body, ['crossfadeSeconds']);
  if (extra) return notAllowed(extra);
  const sec = body.crossfadeSeconds;
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0 || sec > 3600) return bad('淡入淡出秒數不對（0 到 3600）', 400, { field: 'crossfadeSeconds' });
  const slot = await env.DB.prepare(
    `SELECT c.id, c.crossfade_own, c.library_cue_id, l.label, s.id AS song_id, s.name AS song_name, s.code AS song_code, s.animator_user_id
       FROM cues c JOIN songs s ON s.id = c.song_id LEFT JOIN library_cues l ON l.id = c.library_cue_id
      WHERE c.id = ? AND c.song_id = ? AND s.project_id = ? LIMIT 1`
  ).bind(cueId, songId, ctx.projectId).first();
  if (!slot) return bad('這首歌裡找不到這個 cue', 404);
  if (Number(slot.crossfade_own) !== 1) return bad('這首歌的這個 cue 沒有另外設轉場秒數，要改請改 Cue 庫的秒數', 409, { field: 'crossfadeSeconds' });

  const res = await patchSlot(env, ctx, songId, cueId, { crossfadeSeconds: sec }, log);
  if (res.status >= 400) return res;
  const song = { id: slot.song_id, name: slot.song_name, code: slot.song_code, animator_user_id: slot.animator_user_id };
  const notified = await notifyStage(env, ctx, {
    songs: [song], linkSongId: song.id, text: stageNotifyText('slot_crossfade', { label: slot.label || '', song, seconds: sec }),
  });
  return { status: res.status, body: { ...res.body, notified } };
}
