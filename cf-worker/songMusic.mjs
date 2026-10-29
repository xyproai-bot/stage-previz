// 歌曲的音樂（沒有影片的歌，用音樂當「歌的時間」）— songMusic.test.mjs 有測。API 文件：docs/music-api.md
//
// 一首歌最多一首音樂，存在 R2：music/<專案>/<歌>/<音樂 id>.<mp3|wav|m4a|aac|flac>（bucket 跟影片同一個，binding MODELS）。
// 比影片簡單：音樂不大，一個請求直接傳完（PUT 檔案內容，後台把請求內容直接串進 R2），不用分段。
//
// 這裡有：
//   格式 / 大小   musicMimeFor / extForMusicMime / unsupportedMusicMessage / musicMaxBytes
//   權限          musicWriteDecision（寫 = 製作 + 導演；讀 = 專案成員，路由表 access.mjs 的 musicEditor / member）
//   播放通行證    signMusicPass / verifyMusicPass（跟影片同一套，簽名前面多一個 music: 跟影片分開）
//   資料庫 / R2   getSongMusic / putSongMusic / deleteSongMusic / loadMusicSummaries / loadMusicForStream / discardR2Files
//
// 寫入的 handler 回 { status, body }（worker.js 的 mechResp 轉成 JSON）；播放的 Range 回應在 worker.js（serveR2Video 共用）。

import { canEditStage, projectRoleOf } from './access.mjs';
import { MIB, fileExt, formatBytes, signVideoPass, verifyVideoPass } from './videos.mjs';

// ─────────────────────────────────────────────
// 大小
// ─────────────────────────────────────────────

/**
 * 上傳上限預設 90 MiB：4 分鐘的 WAV（44.1k/16bit 立體聲）約 40 MB、48k/24bit 約 70 MB 都放得下；
 * Cloudflare 一個請求的內容最多 100 MB，所以不管怎麼設都不超過 95 MiB。
 */
export const DEFAULT_MUSIC_MAX_BYTES = 90 * MIB;
export const MUSIC_MAX_CEILING = 95 * MIB;
export const MUSIC_FILENAME_MAX = 255;

/** 上限（bytes）：wrangler.toml 的 MUSIC_MAX_BYTES 可以改（1 MiB～95 MiB）；亂填就用預設 */
export function musicMaxBytes(env) {
  const n = Number(env?.MUSIC_MAX_BYTES);
  return Number.isFinite(n) && n >= MIB ? Math.min(Math.floor(n), MUSIC_MAX_CEILING) : DEFAULT_MUSIC_MAX_BYTES;
}

// ─────────────────────────────────────────────
// 格式
// ─────────────────────────────────────────────

// 瀏覽器都播得了的幾種（mp3、wav、m4a / aac、flac）
export const MUSIC_MIME_BY_EXT = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
};
export const ALLOWED_MUSIC_MIMES = ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/flac'];
const EXT_BY_MIME = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac' };
const MIME_ALIASES = {
  'audio/mp3': 'audio/mpeg', 'audio/x-mp3': 'audio/mpeg', 'audio/mpeg3': 'audio/mpeg', 'audio/x-mpeg': 'audio/mpeg', 'audio/x-mpeg-3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav',
  'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/mp4a-latm': 'audio/mp4',
  'audio/x-aac': 'audio/aac', 'audio/aacp': 'audio/aac',
  'audio/x-flac': 'audio/flac',
};
// 「看不出是什麼」的類型 → 改看副檔名
const GENERIC_MIMES = ['', 'application/octet-stream', 'binary/octet-stream', 'application/binary', 'application/x-download', 'application/force-download', 'application/download'];

function cleanMime(mime) {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  return MIME_ALIASES[m] || m;
}

/**
 * 這個檔案是我們收的音樂嗎？是 → 標準的 mime（audio/mpeg 等），不是 → null
 * 類型寫得清楚就看類型；類型是「一般檔案」（octet-stream）或沒寫 → 看副檔名
 * （有些瀏覽器把 .m4a 標成 video/mp4：副檔名是 m4a 就當 audio/mp4。影片檔 .mp4 一律不收，請去「加影片」）
 */
export function musicMimeFor({ mime, filename } = {}) {
  const m = cleanMime(mime);
  const ext = fileExt(filename);
  if (ALLOWED_MUSIC_MIMES.includes(m)) return m;
  if (GENERIC_MIMES.includes(m)) return MUSIC_MIME_BY_EXT[ext] || null;
  if (ext === 'm4a' && (m === 'video/mp4' || m === 'video/quicktime')) return 'audio/mp4';
  return null;
}

export function extForMusicMime(mime) {
  return EXT_BY_MIME[cleanMime(mime)] || 'mp3';
}

/** 不收的格式要跟人說什麼 */
export function unsupportedMusicMessage(filename, mime) {
  const ext = fileExt(filename);
  const what = ext ? `.${ext}` : (cleanMime(mime) || '這個格式');
  return `${what} 不是我們收的音樂格式，只收 MP3 / WAV / M4A / AAC / FLAC（影片請到「加影片」）`;
}

/** R2 上的位置：每次上傳一個新的音樂 id，換音樂不會蓋掉舊檔（舊檔排隊補刪） */
export function musicR2Key(projectId, songId, musicId, mime) {
  return `music/${projectId}/${songId}/${musicId}.${extForMusicMime(mime)}`;
}

/** 上傳時帶的檔名：去掉路徑和控制字元，最多 255 字；空的 → '' */
export function cleanMusicFilename(raw) {
  let s = String(raw ?? '');
  try { s = decodeURIComponent(s); } catch { /* 沒編碼過就照用 */ }
  s = s.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop().trim();
  return s.slice(0, MUSIC_FILENAME_MAX);
}

/** 瀏覽器量到的長度（秒）：正的、不超過一天才算，取到千分之一秒；不對 → null */
export function cleanMusicDuration(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 86400 ? Math.round(n * 1000) / 1000 : null;
}

// ─────────────────────────────────────────────
// 權限
// ─────────────────────────────────────────────

/**
 * 能不能上傳 / 換 / 移除音樂：這個專案的製作（含全站製作）和導演。動畫師、不是成員 → 不行。
 * 路由表（access.mjs 的 musicEditor）已經擋過一次，handler 再看一次，不靠呼叫的人記得。
 * @returns {{ok: true} | {ok: false, status: number, error: string}}
 */
export function musicWriteDecision(role) {
  if (!role) return { ok: false, status: 403, error: '沒有權限存取此專案' };
  if (canEditStage(role)) return { ok: true };
  return { ok: false, status: 403, error: '只有製作或導演可以上傳、換或移除音樂；動畫師可以聽' };
}

// ─────────────────────────────────────────────
// 播放通行證（<audio src> 帶不了登入 header → 網址上帶這個）
// ─────────────────────────────────────────────

// 跟影片的通行證同一套（每 6 小時換一次、有效 6～12 小時）。簽名裡的 id 前面加 music:，
// 影片的通行證拿來開音樂（或反過來）簽名對不上。
const passId = (musicId) => `music:${musicId}`;

export function signMusicPass(secret, { musicId, userId, now = Date.now() }) {
  return signVideoPass(secret, { videoId: passId(musicId), userId, now });
}

/** 通行證對不對（對 → 回 userId，不對 / 過期 → null） */
export function verifyMusicPass(secret, token, { musicId, now = Date.now() }) {
  return verifyVideoPass(secret, token, { videoId: passId(musicId), now });
}

/** 成員用的播放網址（相對路徑）：/api/music/:musicId/stream?pass=… */
export async function musicStreamUrl(secret, musicId, userId) {
  const pass = await signMusicPass(secret, { musicId, userId });
  return `/api/music/${encodeURIComponent(musicId)}/stream?pass=${encodeURIComponent(pass)}`;
}

// ─────────────────────────────────────────────
// 給畫面的樣子
// ─────────────────────────────────────────────

/** 這首歌的音樂（歌單上帶的簡短版，沒有播放網址）；沒有 → null */
export function musicSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    sizeBytes: row.size_bytes ?? null,
    durationSec: row.duration_sec ?? null,
    uploadedAt: row.uploaded_at,
  };
}

/** 單首歌的音樂（含誰傳的、播放網址） */
export function musicToApi(row, streamUrl) {
  return {
    ...musicSummary(row),
    songId: row.song_id,
    uploadedBy: row.uploaded_by ? { id: row.uploaded_by, name: row.uploaded_by_name || null } : null,
    streamUrl,
  };
}

// ─────────────────────────────────────────────
// 資料庫 / R2
// ─────────────────────────────────────────────

const nowIso = () => new Date().toISOString();
const err = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

function newMusicId() {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return 'sm_' + [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** 這個專案每首歌的音樂簡述：Map(songId → musicSummary)。表還沒建（後台先上線、migration 還沒套）→ 空的，歌單照常 */
export async function loadMusicSummaries(env, projectId) {
  try {
    const r = await env.DB.prepare(
      `SELECT song_id, id, filename, mime, size_bytes, duration_sec, uploaded_at FROM song_music WHERE project_id = ?`
    ).bind(projectId).all();
    return new Map((r.results || []).map(row => [row.song_id, musicSummary(row)]));
  } catch {
    return new Map();
  }
}

async function musicRowBySong(env, songId) {
  return env.DB.prepare(
    `SELECT m.*, u.name AS uploaded_by_name FROM song_music m LEFT JOIN users u ON u.id = m.uploaded_by WHERE m.song_id = ? LIMIT 1`
  ).bind(songId).first();
}

/** GET songs/:s/music（專案成員）→ { music: 音樂 | null } */
export async function getSongMusic(env, ctx, { secret }) {
  const row = await musicRowBySong(env, ctx.song.id);
  if (!row) return { status: 200, body: { music: null } };
  return { status: 200, body: { music: musicToApi(row, await musicStreamUrl(secret, row.id, ctx.me.id)) } };
}

/**
 * R2 檔案刪掉；沒刪成功的留在 r2_pending_deletes（要事先記進去），排程（storage.mjs runPendingR2Deletes）之後補刪。
 * 刪成功的從 r2_pending_deletes 拿掉。永遠不丟錯（使用者不用卡在這裡）。
 */
export async function discardR2Files(env, keys) {
  const list = [...new Set((keys || []).filter(k => typeof k === 'string' && k))];
  if (!list.length || !env.MODELS) return { deleted: 0, pending: list.length };
  try {
    await env.MODELS.delete(list);
  } catch (e) {
    console.warn('[song music] R2 沒刪成功，等排程補刪', e?.message || e);
    const msg = String(e?.message || e).slice(0, 200);
    try { await env.DB.batch(list.map(k => env.DB.prepare(`UPDATE r2_pending_deletes SET attempts = attempts + 1, last_error = ? WHERE r2_key = ?`).bind(msg, k))); } catch { /* 只是紀錄 */ }
    return { deleted: 0, pending: list.length };
  }
  try { await env.DB.batch(list.map(k => env.DB.prepare(`DELETE FROM r2_pending_deletes WHERE r2_key = ?`).bind(k))); } catch { /* 留著，排程再刪一次也沒關係 */ }
  return { deleted: list.length, pending: 0 };
}

/**
 * PUT songs/:s/music?filename=…&durationSec=…（製作、導演）：請求內容就是音樂檔，直接串進 R2。
 *   一定要帶 Content-Length（R2 要知道長度）；超過上限 413、格式不收 415、沒帶大小 411。
 *   這首歌已經有音樂 = 換掉：舊檔的 R2 位置先記進 r2_pending_deletes（跟資料庫的更新同一批），再試著刪。
 * @returns {Promise<{status: number, body: object}>}  201 = 新的，200 = 換掉舊的
 */
export async function putSongMusic(request, env, ctx, { secret, log }) {
  const { me, projectId, song, role } = ctx;
  const d = musicWriteDecision(role);
  if (!d.ok) return err(d.status, d.error);
  if (!env.MODELS) return err(500, 'R2 not configured');

  const url = new URL(request.url);
  const filename = cleanMusicFilename(url.searchParams.get('filename'));
  const lengthHeader = request.headers.get('content-length');
  const size = Number(lengthHeader);
  if (lengthHeader === null || lengthHeader === '') return err(411, '上傳要帶檔案大小，請用網頁上的「上傳音樂」');
  if (!Number.isInteger(size) || size < 0) return err(400, '檔案大小不正確');
  if (size === 0) return err(400, '這個檔案是空的');
  const max = musicMaxBytes(env);
  if (size > max) return err(413, `檔案太大（${formatBytes(size)}），上限是 ${formatBytes(max)}`, { maxBytes: max });
  const contentType = request.headers.get('content-type');
  const mime = musicMimeFor({ mime: contentType, filename });
  if (!mime) return err(415, unsupportedMusicMessage(filename, contentType));
  if (!request.body) return err(400, '這個檔案是空的');

  const id = newMusicId();
  const key = musicR2Key(projectId, song.id, id, mime);
  const dropNewFile = async () => { try { await env.MODELS.delete(key); } catch { /* 沒有就算了 */ } };

  let stored;
  try {
    stored = await env.MODELS.put(key, request.body, {
      httpMetadata: { contentType: mime },
      customMetadata: { musicId: id, songId: song.id, projectId },
    });
  } catch (e) {
    console.warn('[song music] 上傳失敗', song.id, String(e?.message || e).slice(0, 200));
    await dropNewFile();
    return err(502, '音樂沒有傳完（網路斷了？），請再試一次');
  }
  // 請求內容的長度跟 Content-Length 不一樣（理論上不會發生）→ 不收
  if (stored && Number.isFinite(stored.size) && stored.size !== size) {
    await dropNewFile();
    return err(stored.size > max ? 413 : 400, stored.size > max ? `檔案太大，上限是 ${formatBytes(max)}` : '上傳的內容跟檔案大小對不上，請再試一次');
  }

  const duration = cleanMusicDuration(url.searchParams.get('durationSec'));
  const t = nowIso();
  const name = filename || `音樂.${extForMusicMime(mime)}`;
  const prev = await env.DB.prepare(`SELECT r2_key FROM song_music WHERE song_id = ? LIMIT 1`).bind(song.id).first();
  try {
    await env.DB.batch([
      // 現在這一列放的舊檔先記進去（同一批，不會資料換了、舊檔的位置忘了）
      env.DB.prepare(`INSERT OR IGNORE INTO r2_pending_deletes (r2_key, created_at) SELECT r2_key, ? FROM song_music WHERE song_id = ?`).bind(t, song.id),
      env.DB.prepare(`
        INSERT INTO song_music (song_id, project_id, id, r2_key, filename, mime, size_bytes, duration_sec, uploaded_by, uploaded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(song_id) DO UPDATE SET
          id = excluded.id, r2_key = excluded.r2_key, filename = excluded.filename, mime = excluded.mime,
          size_bytes = excluded.size_bytes, duration_sec = excluded.duration_sec, uploaded_by = excluded.uploaded_by, uploaded_at = excluded.uploaded_at
      `).bind(song.id, projectId, id, key, name, mime, size, duration, me.id, t),
    ]);
  } catch (e) {
    console.warn('[song music] 寫資料庫失敗', song.id, String(e?.message || e).slice(0, 200));
    await dropNewFile();
    return err(500, '音樂存進去了但記錄失敗，請再試一次');
  }
  const replaced = !!prev?.r2_key;
  if (replaced && prev.r2_key !== key) await discardR2Files(env, [prev.r2_key]);

  await log?.(replaced ? 'update' : 'upload', 'song_music', song.id, { songName: song.name, filename: name, sizeBytes: size, replaced });
  const row = await musicRowBySong(env, song.id);
  return { status: replaced ? 200 : 201, body: { music: musicToApi(row, await musicStreamUrl(secret, row.id, me.id)) } };
}

/** DELETE songs/:s/music（製作、導演）：這一列拿掉，R2 檔案排隊刪 */
export async function deleteSongMusic(env, ctx, { log }) {
  const { projectId, song, role } = ctx;
  const d = musicWriteDecision(role);
  if (!d.ok) return err(d.status, d.error);
  const row = await env.DB.prepare(`SELECT id, r2_key, filename, size_bytes FROM song_music WHERE song_id = ? LIMIT 1`).bind(song.id).first();
  if (!row) return err(404, '這首歌還沒有音樂');
  const results = await env.DB.batch([
    // 只記「剛剛看到的這一首」：中間有人換了新的，就什麼都不做（不會把新的檔案當成舊的刪掉）
    env.DB.prepare(`INSERT OR IGNORE INTO r2_pending_deletes (r2_key, created_at) SELECT r2_key, ? FROM song_music WHERE song_id = ? AND id = ?`).bind(nowIso(), song.id, row.id),
    env.DB.prepare(`DELETE FROM song_music WHERE song_id = ? AND id = ?`).bind(song.id, row.id),
  ]);
  if (!results[1]?.meta?.changes) return err(409, '這首歌的音樂剛剛被換掉了，請重新整理再看');
  await discardR2Files(env, [row.r2_key]);
  await log?.('delete', 'song_music', song.id, { songName: song.name, filename: row.filename, sizeBytes: row.size_bytes, projectId });
  return { status: 200, body: { ok: true } };
}

/**
 * 播放用：用音樂 id + 看的人查出播放需要的資料，順便確認這個人能看這個專案
 * （帳號停用、不是成員、封存的專案只有全站製作看得到 → 都不給）。
 * @returns {Promise<{row: {id: string, r2_key: string, mime: string, size_bytes: number}} | {status: number, error: string}>}
 */
export async function loadMusicForStream(env, musicId, userId) {
  const row = await env.DB.prepare(`
    SELECT m.id, m.r2_key, m.mime, m.size_bytes, p.status AS project_status,
           u.role AS user_role, u.deactivated, pm.role AS member_role
      FROM song_music m
      JOIN projects p ON p.id = m.project_id
      LEFT JOIN users u ON u.id = ?
      LEFT JOIN project_members pm ON pm.project_id = m.project_id AND pm.user_id = ?
     WHERE m.id = ? LIMIT 1
  `).bind(userId, userId, musicId).first();
  if (!row) return { status: 404, error: '找不到這首音樂' };
  if (!row.user_role || row.deactivated) return { status: 401, error: '未登入' };
  if (!projectRoleOf(row.user_role, row.member_role)) return { status: 403, error: '沒有權限存取此專案' };
  if (row.project_status === 'archived' && row.user_role !== 'admin') return { status: 404, error: '找不到這首音樂' };
  return { row: { id: row.id, r2_key: row.r2_key, mime: row.mime, size_bytes: row.size_bytes } };
}

/** 專案內的播放（有登入 header）：這首歌的音樂 */
export async function loadSongMusicForStream(env, songId) {
  const row = await env.DB.prepare(`SELECT id, r2_key, mime, size_bytes FROM song_music WHERE song_id = ? LIMIT 1`).bind(songId).first();
  return row || null;
}
