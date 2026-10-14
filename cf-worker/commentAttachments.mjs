// 留言的參考圖片（附件；migration 0028）
//
//   1. 先上傳：POST /api/comment-attachments?session=…（團隊）、POST <分享>/songs/:s/comment-attachments（訪客）
//      multipart/form-data：file = 圖片（前端已經縮到長邊 2560 px、重新畫過 = 拿掉 EXIF / GPS；GIF 原樣）、thumb = 小縮圖（約 480 px，可以沒有）
//      → { ok, attachment: { id, url, thumbUrl?, type, width, height, size } }（還沒掛到留言上 = 「還沒送出」）
//   2. 送出留言 / 回覆時帶 comment.attachmentIds: [...]（照順序）→ 掛到那則留言上；改留言時帶 attachmentIds = 新的整串（拿掉的會刪檔）
//   3. 拿掉還沒送出的：DELETE /api/comment-attachments?session=…&id=…（訪客：DELETE <分享>/songs/:s/comment-attachments/:id）
//   4. 看圖：GET /api/comment-attachments/<專案>/<32 個隨機 hex>.<副檔名>（不用登入，網址猜不到；跟留言縮圖一樣，可以快取一年）
//   刪留言（含底下的回覆）/ 刪歌：R2 的檔案一起清；上傳了一直沒送出的：排程一天後清掉。
//
// 誰可以傳：團隊跟發留言一樣（access.mjs commentPostDecision）；訪客要連結有開「允許看的人留言」（訪客的額度在 guestComments.mjs）。
// 規則（類型、大小、張數）跟前端共用 web/src/lib/review/attachmentRules.ts。
// 這裡的函式直接拿 D1 / R2 做事，回傳 { status, body }（跟 reviews.mjs 一樣）；commentAttachments.test.mjs 用 node:sqlite + 記憶體 R2 測。

import {
  ATTACHMENT_EXT, ATTACHMENT_MAX_BYTES, ATTACHMENT_THUMB_MAX_BYTES, ATTACHMENT_SERVER_MAX_EDGE, ATTACHMENT_GIF_MAX_EDGE,
  ATTACHMENT_THUMB_EDGE, ATTACHMENT_ID_RE, MEMBER_MAX_ATTACHMENTS, sniffImage,
} from '../web/src/lib/review/attachmentRules.ts';
import { commentPostDecision } from './access.mjs';

export { MEMBER_MAX_ATTACHMENTS, GUEST_MAX_ATTACHMENTS, IMAGE_ONLY_TEXT, ATTACHMENT_ID_RE } from '../web/src/lib/review/attachmentRules.ts';

export const ATTACHMENT_PREFIX = 'comment-attachments/';
export const ATTACHMENT_URL_PREFIX = '/api/comment-attachments/';
/** 團隊：一個人還沒送出的圖片最多幾張 / 一天最多傳幾張 */
export const MEMBER_PENDING_MAX = 24;
export const MEMBER_DAILY_MAX = 300;
/** 上傳了一直沒送出的，多久之後清掉 */
export const PENDING_KEEP_MS = 24 * 3600_000;
/** 一次送來最多多大（圖片 + 小縮圖 + multipart 的邊界） */
export const UPLOAD_BODY_MAX = ATTACHMENT_MAX_BYTES + ATTACHMENT_THUMB_MAX_BYTES + 64 * 1024;

const KEY_RE = /^comment-attachments\/[a-zA-Z0-9_-]{1,64}\/[0-9a-f]{32}(-t)?\.(png|jpg|webp|gif)$/;
const TYPE_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const CACHE_FOREVER = 'public, max-age=31536000, immutable';

const ok = (body, status = 200) => ({ status, body });
const fail = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

function randHex(nBytes) {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
export const newAttachmentId = () => `ca_${randHex(8)}${Date.now().toString(36)}`;

// ─────────────────────────────────────────────
// 網址 ↔ R2 位置
// ─────────────────────────────────────────────

/** R2 位置：comment-attachments/<專案>/<32 個隨機 hex>.<副檔名>（小縮圖多一個 -t） */
export function attachmentKey(projectId, rand32hex, ext, { thumb = false } = {}) {
  return `${ATTACHMENT_PREFIX}${projectId}/${rand32hex}${thumb ? '-t' : ''}.${ext}`;
}

/** 看圖的網址（相對路徑，前面接 API 網址）；不是我們存的位置 → null */
export function attachmentUrlFor(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) return null;
  return ATTACHMENT_URL_PREFIX + key.slice(ATTACHMENT_PREFIX.length);
}

/** /api/comment-attachments/<專案>/<檔名> → R2 位置；格式不對 → null */
export function attachmentKeyFromPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(ATTACHMENT_URL_PREFIX)) return null;
  const key = ATTACHMENT_PREFIX + pathname.slice(ATTACHMENT_URL_PREFIX.length);
  return KEY_RE.test(key) ? key : null;
}

/** 資料庫的一列 → API 格式 */
export function rowToAttachment(r) {
  const out = {
    id: r.id,
    url: attachmentUrlFor(r.r2_key),
    type: r.mime,
    size: Number(r.size) || 0,
  };
  const thumbUrl = attachmentUrlFor(r.thumb_key);
  if (thumbUrl) out.thumbUrl = thumbUrl;
  if (Number(r.width) > 0 && Number(r.height) > 0) { out.width = Number(r.width); out.height = Number(r.height); }
  return out;
}

/** 這一列在 R2 上有哪些檔案 */
export function attachmentObjectKeys(rows) {
  const out = [];
  for (const r of rows || []) for (const k of [r?.r2_key, r?.thumb_key]) if (typeof k === 'string' && k.startsWith(ATTACHMENT_PREFIX)) out.push(k);
  return out;
}

// ─────────────────────────────────────────────
// 上傳的內容（純判斷）
// ─────────────────────────────────────────────

/** 讀 body，超過 max 就停（不用等整個傳完） */
async function readBytesLimited(request, max) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { try { await reader.cancel(); } catch { /* 不管 */ } return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

const TOO_BIG = '這張圖片太大了（一張最多 15 MB）';
const NOT_IMAGE = '只能放 PNG、JPEG、WebP、GIF 圖片';

/**
 * 讀上傳的請求：multipart/form-data（file + thumb），或直接把圖片當 body（沒有小縮圖）
 * @returns {Promise<{ ok: true, file: Uint8Array, thumb: Uint8Array|null } | { ok: false, status: number, error: string }>}
 */
export async function readAttachmentUpload(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > UPLOAD_BODY_MAX) return { ok: false, status: 413, error: TOO_BIG };
  let bytes;
  try { bytes = await readBytesLimited(request, UPLOAD_BODY_MAX); } catch { return { ok: false, status: 400, error: '圖片沒有傳完整，請再試一次' }; }
  if (bytes === null) return { ok: false, status: 413, error: TOO_BIG };
  const ct = request.headers.get('content-type') || '';
  if (/^multipart\/form-data/i.test(ct)) {
    let form;
    try { form = await new Response(bytes, { headers: { 'content-type': ct } }).formData(); } catch { return { ok: false, status: 400, error: '圖片沒有傳完整，請再試一次' }; }
    const file = form.get('file');
    if (!file || typeof file === 'string') return { ok: false, status: 400, error: '沒有收到圖片' };
    const thumb = form.get('thumb');
    return {
      ok: true,
      file: new Uint8Array(await file.arrayBuffer()),
      thumb: thumb && typeof thumb !== 'string' ? new Uint8Array(await thumb.arrayBuffer()) : null,
    };
  }
  return { ok: true, file: bytes, thumb: null };
}

/**
 * 檢查圖片（看檔案開頭，不信副檔名）；小縮圖不對就當沒有（不擋上傳）
 * @returns {{ ok: true, image: { type, width, height }, thumb: { type, width, height }|null } | { ok: false, status: number, error: string }}
 */
export function checkAttachmentUpload(file, thumb) {
  if (!file || !file.length) return { ok: false, status: 400, error: '沒有收到圖片' };
  if (file.length > ATTACHMENT_MAX_BYTES) return { ok: false, status: 413, error: TOO_BIG };
  const image = sniffImage(file);
  if (!image) return { ok: false, status: 415, error: NOT_IMAGE };
  const long = Math.max(image.width, image.height);
  if (image.type === 'image/gif' ? long > ATTACHMENT_GIF_MAX_EDGE : long > ATTACHMENT_SERVER_MAX_EDGE) {
    return { ok: false, status: 400, error: `圖片的尺寸太大了（${image.width}×${image.height}），請重新加一次` };
  }
  let t = null;
  if (thumb && thumb.length && thumb.length <= ATTACHMENT_THUMB_MAX_BYTES) {
    const s = sniffImage(thumb);
    if (s && s.type !== 'image/gif' && Math.max(s.width, s.height) <= ATTACHMENT_THUMB_EDGE + 160) t = s;
  }
  return { ok: true, image, thumb: t };
}

// ─────────────────────────────────────────────
// 存 / 讀
// ─────────────────────────────────────────────

/**
 * 存一張圖（R2 + 一列，還沒掛到留言上）。uploader = { userId }（團隊）或 { shareToken }（訪客）
 */
export async function storeAttachment(db, r2, { projectId, songId, file, thumb, checked, uploader, now = new Date() }) {
  if (!r2) return fail(500, '圖片存不進去（儲存空間沒有設定）');
  const rand = randHex(16);
  const key = attachmentKey(projectId, rand, ATTACHMENT_EXT[checked.image.type]);
  const meta = (type) => ({ httpMetadata: { contentType: type, cacheControl: CACHE_FOREVER } });
  try {
    await r2.put(key, file, meta(checked.image.type));
  } catch (e) {
    console.error('[comment attachment put]', e?.message || e);
    return fail(500, '圖片存不進去，請再試一次');
  }
  let thumbKey = null;
  if (checked.thumb && thumb) {
    const k = attachmentKey(projectId, rand, ATTACHMENT_EXT[checked.thumb.type], { thumb: true });
    try { await r2.put(k, thumb, meta(checked.thumb.type)); thumbKey = k; } catch (e) { console.warn('[comment attachment thumb]', e?.message || e); }
  }
  const row = {
    id: newAttachmentId(), project_id: projectId, song_id: songId, comment_id: null,
    r2_key: key, thumb_key: thumbKey, mime: checked.image.type, size: file.length,
    width: checked.image.width, height: checked.image.height, sort_order: 0,
    uploaded_by_user_id: uploader?.userId ?? null, share_token: uploader?.shareToken ?? null,
    created_at: now.toISOString(), attached_at: null,
  };
  try {
    await db.prepare(`
      INSERT INTO comment_attachments (id, project_id, song_id, comment_id, r2_key, thumb_key, mime, size, width, height,
        sort_order, uploaded_by_user_id, share_token, created_at, attached_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL)
    `).bind(row.id, row.project_id, row.song_id, row.r2_key, row.thumb_key, row.mime, row.size, row.width, row.height,
      row.uploaded_by_user_id, row.share_token, row.created_at).run();
  } catch (e) {
    await deleteAttachmentObjects(r2, attachmentObjectKeys([row]));
    throw e;
  }
  return ok({ ok: true, attachment: rowToAttachment(row) });
}

/** 一首歌掛在留言上的圖片：留言 id → [附件]（照順序） */
export async function attachmentsBySong(db, songId) {
  const r = await db.prepare(
    `SELECT * FROM comment_attachments WHERE song_id = ? AND comment_id IS NOT NULL ORDER BY comment_id, sort_order, created_at`
  ).bind(songId).all();
  return groupAttachments(r.results || []);
}

export function groupAttachments(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row.comment_id) continue;
    const a = rowToAttachment(row);
    if (!a.url) continue;
    if (!map.has(row.comment_id)) map.set(row.comment_id, []);
    map.get(row.comment_id).push(a);
  }
  return map;
}

/** 留言清單補上 attachments（沒有圖片的留言不加這個欄位，格式跟以前一樣） */
export function withAttachments(comments, map) {
  if (!map || !map.size) return comments;
  for (const c of comments) {
    const list = map.get(c.id);
    if (list && list.length) c.attachments = list;
  }
  return comments;
}

/**
 * 讀一首歌的留言（含圖片）：一次往返拿留言和圖片；圖片的表還沒建（migration 還沒跑）→ 照以前只有留言
 * @param {(row: object) => object} mapRow  rowToComment / rowToGuestComment
 */
export async function listCommentsWithAttachments(db, commentsStmt, songId, mapRow) {
  let rows, attRows = [];
  try {
    const [cR, aR] = await db.batch([
      commentsStmt,
      db.prepare(`SELECT * FROM comment_attachments WHERE song_id = ? AND comment_id IS NOT NULL ORDER BY comment_id, sort_order, created_at`).bind(songId),
    ]);
    rows = cR.results || [];
    attRows = aR.results || [];
  } catch (e) {
    if (!/no such table/i.test(String(e?.message || e))) throw e;
    rows = (await commentsStmt.all()).results || [];
  }
  return withAttachments(rows.map(mapRow), groupAttachments(attRows));
}

// ─────────────────────────────────────────────
// 掛到留言上（發留言 / 回覆 / 改留言）
// ─────────────────────────────────────────────

function uploaderMatches(row, uploader) {
  if (uploader?.userId) return row.uploaded_by_user_id === uploader.userId;
  if (uploader?.shareToken) return row.share_token === uploader.shareToken && !row.uploaded_by_user_id;
  return false;
}

const GONE = '有圖片還沒傳好或已經不在了，請拿掉後重新加一次';

/**
 * 留言帶來的 attachmentIds → 檢查過的 id（照順序、去掉重複）
 *   沒帶 → { provided: false }（舊版前端；改留言時 = 圖片不動）
 *   每一張要是：這首歌的、還沒掛到別的留言上、是這個人（這條分享連結）傳的；或已經掛在這則留言上（改留言 / 網路重送）
 * @param {object} p
 * @param {string|null} [p.commentId]  這則留言（改留言、重送時已經掛上去的可以留著）
 * @param {{ userId?: string, shareToken?: string }} p.uploader
 * @returns {Promise<{ ok: true, provided: boolean, ids: string[], rows: object[] } | { ok: false, status: number, error: string }>}
 */
export async function resolveAttachmentIds(db, raw, { projectId, songId, commentId = null, uploader, max = MEMBER_MAX_ATTACHMENTS }) {
  if (raw === undefined || raw === null) return { ok: true, provided: false, ids: [], rows: [] };
  if (!Array.isArray(raw)) return { ok: false, status: 400, error: '圖片的格式不對' };
  const ids = [];
  for (const id of raw) {
    if (typeof id !== 'string' || !ATTACHMENT_ID_RE.test(id)) return { ok: false, status: 400, error: '圖片的格式不對' };
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > max) return { ok: false, status: 400, error: `一則留言最多 ${max} 張圖片` };
  if (!ids.length) return { ok: true, provided: true, ids, rows: [] };
  const r = await db.prepare(
    `SELECT * FROM comment_attachments WHERE id IN (${ids.map(() => '?').join(', ')})`
  ).bind(...ids).all();
  const byId = new Map((r.results || []).map(row => [row.id, row]));
  const rows = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row || row.project_id !== projectId || row.song_id !== songId) return { ok: false, status: 400, error: GONE };
    const mine = row.comment_id === null && uploaderMatches(row, uploader);
    const already = !!commentId && row.comment_id === commentId;
    if (!mine && !already) return { ok: false, status: 400, error: GONE };
    rows.push(row);
  }
  return { ok: true, provided: true, ids, rows };
}

/** 掛到留言上（照順序）。只掛還沒掛的、或本來就是這則的（兩個人同時拿同一張 → 只有一個會成功） */
export function attachStatements(db, ids, commentId, now = new Date()) {
  const at = now.toISOString();
  return ids.map((id, i) => db.prepare(
    `UPDATE comment_attachments SET comment_id = ?1, sort_order = ?2, attached_at = COALESCE(attached_at, ?3)
      WHERE id = ?4 AND (comment_id IS NULL OR comment_id = ?1)`
  ).bind(commentId, i, at, id));
}

/**
 * 改留言時：現在掛著的 vs 新的整串 → 要拿掉哪些（純函式）
 * @returns {{ remove: object[], keep: string[] }}
 */
export function planAttachmentEdit(currentRows, nextIds) {
  const next = new Set(nextIds || []);
  return {
    remove: (currentRows || []).filter(r => !next.has(r.id)),
    keep: (nextIds || []).slice(),
  };
}

/** 這則留言現在掛著的圖片 */
export async function commentAttachmentRows(db, commentId) {
  const r = await db.prepare(`SELECT * FROM comment_attachments WHERE comment_id = ? ORDER BY sort_order, created_at`).bind(commentId).all();
  return r.results || [];
}

// ─────────────────────────────────────────────
// 清掉
// ─────────────────────────────────────────────

/** R2 刪檔（一次最多 1000 個；失敗只記 log） */
export async function deleteAttachmentObjects(r2, keys) {
  const list = (keys || []).filter(k => typeof k === 'string' && k.startsWith(ATTACHMENT_PREFIX));
  if (!r2 || !list.length) return 0;
  let n = 0;
  for (let i = 0; i < list.length; i += 1000) {
    const part = list.slice(i, i + 1000);
    try { await r2.delete(part); n += part.length; } catch (e) { console.warn('[comment attachment delete]', e?.message || e); }
  }
  return n;
}

/** 刪留言前：這則 + 底下回覆的圖片在 R2 上的檔案（表還沒建 → 沒有） */
export async function attachmentKeysForThread(db, songId, commentId) {
  const r = await db.prepare(
    `SELECT r2_key, thumb_key FROM comment_attachments
      WHERE song_id = ?1 AND comment_id IN (SELECT id FROM comments WHERE song_id = ?1 AND (id = ?2 OR reply_to_comment_id = ?2))`
  ).bind(songId, commentId).all().catch(() => ({ results: [] }));
  return attachmentObjectKeys(r.results || []);
}

/** 刪歌前：這首歌所有圖片（含還沒送出的）在 R2 上的檔案 */
export async function songAttachmentKeys(db, songId) {
  const r = await db.prepare(`SELECT r2_key, thumb_key FROM comment_attachments WHERE song_id = ?`).bind(songId).all()
    .catch(() => ({ results: [] }));
  return attachmentObjectKeys(r.results || []);
}

/** 拿掉一張還沒送出的（只能拿掉自己傳的；已經在留言裡的要改那則留言） */
export async function discardPendingAttachment(db, r2, { id, songId, uploader, isAdmin = false }) {
  if (typeof id !== 'string' || !ATTACHMENT_ID_RE.test(id)) return fail(400, '圖片的格式不對');
  const row = await db.prepare(`SELECT * FROM comment_attachments WHERE id = ? AND song_id = ? LIMIT 1`).bind(id, songId).first();
  if (!row) return ok({ ok: true, removed: false });
  if (row.comment_id) return fail(409, '這張圖片已經在留言裡了，要拿掉請修改那則留言');
  if (!uploaderMatches(row, uploader) && !isAdmin) return fail(403, '只能拿掉自己加的圖片');
  await db.prepare(`DELETE FROM comment_attachments WHERE id = ? AND comment_id IS NULL`).bind(id).run();
  await deleteAttachmentObjects(r2, attachmentObjectKeys([row]));
  return ok({ ok: true, removed: true });
}

/** 排程：上傳了一天都沒送出的 → 刪掉（一次最多 300 張） */
export async function cleanupPendingAttachments(db, r2, now = new Date(), { keepMs = PENDING_KEEP_MS, limit = 300 } = {}) {
  const cutoff = new Date(now.getTime() - keepMs).toISOString();
  const r = await db.prepare(
    `SELECT id, r2_key, thumb_key FROM comment_attachments WHERE comment_id IS NULL AND created_at < ? ORDER BY created_at LIMIT ?`
  ).bind(cutoff, limit).all().catch(() => ({ results: [] }));
  const rows = r.results || [];
  if (!rows.length) return 0;
  await deleteAttachmentObjects(r2, attachmentObjectKeys(rows));
  for (let i = 0; i < rows.length; i += 90) {
    const part = rows.slice(i, i + 90).map(x => x.id);
    await db.prepare(`DELETE FROM comment_attachments WHERE comment_id IS NULL AND id IN (${part.map(() => '?').join(', ')})`).bind(...part).run();
  }
  return rows.length;
}

// ─────────────────────────────────────────────
// 團隊上傳 / 拿掉（worker.js 先確認登入、這首歌、角色 → thread）
// ─────────────────────────────────────────────

/**
 * POST /api/comment-attachments?session=…  跟發留言同樣的人可以傳（動畫師只能在自己的歌或還沒指派的歌）
 */
export async function uploadMemberAttachment(db, r2, { me, thread, request, now = new Date() }) {
  const song = await db.prepare(`SELECT id, project_id, animator_user_id FROM songs WHERE id = ? LIMIT 1`).bind(thread.songId).first();
  if (!song) return fail(404, '這首歌不在了');
  const perm = commentPostDecision({ role: thread.role, userId: me.id, song });
  if (!perm.ok) return fail(perm.status, perm.error);

  const dayAgo = new Date(now.getTime() - 86400_000).toISOString();
  const [pendingR, dayR] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM comment_attachments WHERE uploaded_by_user_id = ? AND comment_id IS NULL`).bind(me.id),
    db.prepare(`SELECT COUNT(*) AS n FROM comment_attachments WHERE uploaded_by_user_id = ? AND created_at > ?`).bind(me.id, dayAgo),
  ]);
  if ((Number((pendingR.results || [])[0]?.n) || 0) >= MEMBER_PENDING_MAX) {
    return fail(429, '還沒送出的圖片太多了，請先送出留言或拿掉一些');
  }
  if ((Number((dayR.results || [])[0]?.n) || 0) >= MEMBER_DAILY_MAX) {
    return fail(429, '今天傳的圖片已經到上限了，請明天再傳');
  }

  const up = await readAttachmentUpload(request);
  if (!up.ok) return fail(up.status, up.error);
  const checked = checkAttachmentUpload(up.file, up.thumb);
  if (!checked.ok) return fail(checked.status, checked.error);
  return storeAttachment(db, r2, {
    projectId: thread.projectId, songId: song.id, file: up.file, thumb: up.thumb, checked, uploader: { userId: me.id }, now,
  });
}

/** DELETE /api/comment-attachments?session=…&id=…（自己傳、還沒送出的；製作可以拿掉任何人還沒送出的） */
export async function discardMemberAttachment(db, r2, { me, thread, id }) {
  return discardPendingAttachment(db, r2, { id, songId: thread.songId, uploader: { userId: me.id }, isAdmin: thread.role === 'admin' });
}

// ─────────────────────────────────────────────
// 看圖
// ─────────────────────────────────────────────

/** GET /api/comment-attachments/<專案>/<檔名>（不用登入；網址有 128 bits 隨機碼） */
export async function serveCommentAttachment(request, r2, pathname, baseHeaders = {}) {
  const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { ...baseHeaders, 'Content-Type': 'application/json' } });
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed' }, 405);
  if (!r2) return json({ error: 'R2 not configured' }, 500);
  const key = attachmentKeyFromPath(pathname);
  if (!key) return json({ error: 'Not found' }, 404);
  const obj = await r2.get(key, { onlyIf: request.headers });
  if (!obj) return json({ error: 'Not found' }, 404);
  const headers = new Headers(baseHeaders);
  const ext = key.slice(key.lastIndexOf('.') + 1);
  headers.set('Content-Type', TYPE_BY_EXT[ext] || 'application/octet-stream');
  headers.set('Cache-Control', CACHE_FOREVER);
  // 只會是圖片：不讓瀏覽器猜類型、不能跑任何東西；別的網站可以拿來顯示（<img>）
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Content-Disposition', `inline; filename="${key.slice(key.lastIndexOf('/') + 1)}"`);
  if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
  if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers });
  if (typeof obj.size === 'number') headers.set('Content-Length', String(obj.size));
  return new Response(request.method === 'HEAD' ? null : obj.body, { status: 200, headers });
}
