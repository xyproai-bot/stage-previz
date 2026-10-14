// 分享連結的訪客留言（migration 0026，每條連結預設關；製作在分享連結對話框勾「允許看的人留言」才開）
//
//   訪客寫一次名字（前端記在 localStorage），就能在影片時間上留言（含區段、畫記、3D 視角、縮圖）、回覆自己連結裡的留言串。
//   訪客看得到的（安全的預設）：從同一條連結留的留言串 + 團隊在那些串底下的回覆；看不到團隊自己的留言、別條連結的留言。
//   團隊看到「訪客：小李（給經紀人）」；小鈴鐺只通知：建這條連結的人、專案的導演、這首歌的動畫師（guest_comment），
//   訪客回覆一串留言時，這串裡團隊那邊留過言的人也收到（reply）；同一個人只收一則（guestCommentWants）。
//   防亂發：同一條連結 + 同一個 IP 10 分鐘最多 10 則；同一張通行證（有密碼的連結）1 小時 30 則；一條連結一天 200 則。
//   不收 HTML（名字、內容裡的標籤和角括號拿掉）；大小限制跟團隊留言一樣（畫記 / 縮圖），內容最多 1000 字。
//   密碼 / 有效期 / 封存：路由（worker.js handleShareRouter）先檢查過了才會走到這裡。
//
// 這裡的函式直接拿 D1 做事，回傳 { status, body }（跟 reviews.mjs 一樣）；純判斷另外 export 給 guestComments.test.mjs 測。

import {
  commentExtrasInput, decodeThumbnail, rowToGuestComment, guestAuthorLabel, COMMENT_ID_RE, MAX_COMMENTS_PER_SONG,
} from './comments.mjs';
import {
  insertCommentRow, putCommentThumb, projectMemberIds, insertNotifications, pickRecipients, newId,
} from './reviews.mjs';
import { guestCommentDecision, canToggleShareComments } from './access.mjs';

export const GUEST_NAME_MAX = 30;
export const GUEST_TEXT_MAX = 1000;
export const SHARE_LABEL_MAX = 40;
export const GUEST_IP_RATE = { windowMs: 10 * 60_000, max: 10 };     // 同一條連結 + 同一個 IP
export const GUEST_PASS_RATE = { windowMs: 60 * 60_000, max: 30 };   // 同一張通行證（有密碼的連結）
export const GUEST_LINK_DAILY_MAX = 200;                              // 一條連結一天
export const GUEST_BODY_MAX_BYTES = 400 * 1024;                       // 一次送來的 JSON（含縮圖）

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ok = (body, status = 200) => ({ status, body });
const fail = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

// ─────────────────────────────────────────────
// 純判斷
// ─────────────────────────────────────────────

/** 拿掉 HTML 標籤、角括號、控制字元（換行留著） */
export function stripHtml(s) {
  return String(s ?? '')
    .replace(/<\/?[a-zA-Z!?][^>]*>/g, '')
    .replace(/[<>]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '');
}

/** 訪客的名字：一行、拿掉 HTML 和引號、最多 30 字；不合格 → '' */
export function sanitizeGuestName(raw) {
  if (typeof raw !== 'string') return '';
  return stripHtml(raw).replace(/["'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, GUEST_NAME_MAX).trim();
}

/** 訪客的留言內容：拿掉 HTML、最多 1000 字；不合格 → '' */
export function sanitizeGuestText(raw) {
  if (typeof raw !== 'string') return '';
  return stripHtml(raw).replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, GUEST_TEXT_MAX).trim();
}

/** 分享連結的名稱（例：給經紀人）：一行、拿掉 HTML、最多 40 字；空的 → null */
export function sanitizeShareLabel(raw) {
  if (typeof raw !== 'string') return null;
  const s = stripHtml(raw).replace(/\s+/g, ' ').trim().slice(0, SHARE_LABEL_MAX).trim();
  return s || null;
}

/** 團隊看到的連結名稱：有取名用名稱，沒有用好讀網址名稱，再沒有 =「分享連結」 */
export function shareLinkDisplayName(link) {
  return (link?.label && String(link.label)) || (link?.slug && `/s/${link.slug}`) || '分享連結';
}

/**
 * 在一段時間內最多幾次（最舊的那一次過了時間就可以再發）
 * @param {number[]} times  之前發的時間（epoch ms）
 * @returns {{ allowed: boolean, retryAfterMs: number }}
 */
export function rateDecision(times, now, { windowMs, max }) {
  const inWin = (times || []).map(Number).filter(t => Number.isFinite(t) && t > now - windowMs && t <= now).sort((a, b) => a - b);
  if (inWin.length < max) return { allowed: true, retryAfterMs: 0 };
  return { allowed: false, retryAfterMs: Math.max(1000, inWin[inWin.length - max] + windowMs - now) };
}

export function guestRateMessage(retryAfterMs) {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60000));
  return `留言太快了，請 ${minutes} 分鐘後再試`;
}

/** login_attempts 表裡記錄用的 key（跟登入 / 分享密碼的分開：前綴不一樣） */
export function guestIpKey(linkToken, ipKey) {
  return `gc:${String(linkToken || '').slice(0, 64)}|${String(ipKey || 'unknown').slice(0, 64)}`;
}
export async function guestPassKey(accessToken) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(accessToken))));
  return 'gcp:' + [...d.slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 訪客留言要通知誰（純函式；之後交給 reviews.mjs pickRecipients 去掉重複的、不是專案成員的、停用的）
 *   回覆 → 先放這串裡團隊那邊留過言的人（kind = reply，跟團隊回覆的規則一樣）
 *   然後：建這條分享連結的人、專案的導演、這首歌的動畫師（kind = guest_comment）
 *   其他成員、全站製作（不是建連結的人）都不通知；訪客沒有帳號，不會收到
 * @param {object} p
 * @param {Array<string|null>} [p.threadUserIds]   這串留言（最上面那則 + 回覆）團隊那邊作者的帳號，依時間
 * @param {string|null} [p.linkCreatorId]          share_links.created_by_user_id
 * @param {Array<{user_id: string, role: string}>} [p.members]  reviews.mjs projectMemberIds 的 members
 * @param {string|null} [p.animatorUserId]         songs.animator_user_id
 * @returns {Array<{userId: string, kind: 'reply'|'guest_comment'}>}
 */
export function guestCommentWants({ threadUserIds = [], linkCreatorId = null, members = [], animatorUserId = null } = {}) {
  const wants = [];
  for (const id of threadUserIds || []) if (id) wants.push({ userId: id, kind: 'reply' });
  if (linkCreatorId) wants.push({ userId: linkCreatorId, kind: 'guest_comment' });
  for (const m of members || []) if (m?.role === 'director' && m.user_id) wants.push({ userId: m.user_id, kind: 'guest_comment' });
  if (animatorUserId) wants.push({ userId: animatorUserId, kind: 'guest_comment' });
  return wants;
}

/**
 * 建立 / 改分享連結時的「允許看的人留言」、名稱
 * @returns {{ ok: true, fields: { allow_comments?: 0|1, label?: string|null } } | { ok: false, status: number, error: string }}
 */
export function shareLinkCommentFields(body, role) {
  const fields = {};
  const b = body && typeof body === 'object' ? body : {};
  if ('allowComments' in b && b.allowComments !== undefined) {
    if (typeof b.allowComments !== 'boolean') return { ok: false, status: 400, error: '「允許看的人留言」要是開或關' };
    if (!canToggleShareComments(role, b.allowComments)) {
      return { ok: false, status: 403, error: '只有製作可以打開「允許看的人留言」' };
    }
    fields.allow_comments = b.allowComments ? 1 : 0;
  }
  if ('label' in b && b.label !== undefined) {
    if (b.label !== null && typeof b.label !== 'string') return { ok: false, status: 400, error: '連結名稱要是文字' };
    fields.label = sanitizeShareLabel(b.label);
  }
  return { ok: true, fields };
}

// ─────────────────────────────────────────────
// 讀 / 寫
// ─────────────────────────────────────────────

// 訪客看得到的：這條連結留的留言串（最上面那則）+ 那些串底下的回覆（誰回的都算）
const GUEST_VISIBLE_SQL = `
  SELECT * FROM comments
   WHERE song_id = ?1
     AND ((share_token = ?2 AND reply_to_comment_id IS NULL)
          OR reply_to_comment_id IN (SELECT id FROM comments WHERE song_id = ?1 AND share_token = ?2 AND reply_to_comment_id IS NULL))
   ORDER BY rowid ASC`;

async function guestVisible(db, songId, linkToken) {
  const r = await db.prepare(GUEST_VISIBLE_SQL).bind(songId, linkToken).all();
  return (r.results || []).map(rowToGuestComment);
}

/** 這首歌在不在這條連結的範圍裡 */
async function songInScope(db, link, songId) {
  if (typeof songId !== 'string' || !ID_RE.test(songId)) return { error: fail(400, 'Missing songId') };
  if (link.song_id && link.song_id !== songId) return { error: fail(403, 'Song not in scope') };
  const song = await db.prepare(`SELECT id, project_id, name, animator_user_id FROM songs WHERE id = ? LIMIT 1`).bind(songId).first();
  if (!song || song.project_id !== link.project_id) return { error: fail(404, 'Song not found') };
  return { song };
}

/** GET <分享>/songs/:songId/comments */
export async function listGuestComments(db, { link, songId }) {
  const d = guestCommentDecision(link);
  if (!d.ok) return fail(d.status, d.error, d.commentsDisabled ? { commentsDisabled: true } : {});
  const s = await songInScope(db, link, songId);
  if (s.error) return s.error;
  return ok({ comments: await guestVisible(db, songId, link.token) });
}

/**
 * POST <分享>/songs/:songId/comments
 *   body: { guestName, comment: { id, text, time, timeEnd?, view?, cueId?, annotation?, thumbnail?, parentId?, videoId? } }
 * @param {object} p
 * @param {object} p.link         share_links 那一列（含 allow_comments、label、slug、project_status）
 * @param {string} p.ipKey        loginClientKey(來源 IP)
 * @param {string|null} p.accessToken  有密碼的連結：這次用的通行證
 */
export async function postGuestComment(db, { link, songId, body, ipKey, accessToken = null, now = new Date(), r2 = null }) {
  const d = guestCommentDecision(link);
  if (!d.ok) return fail(d.status, d.error, d.commentsDisabled ? { commentsDisabled: true } : {});
  const raw = body?.comment;
  if (!raw || typeof raw !== 'object') return fail(400, 'Invalid comment');
  const name = sanitizeGuestName(body?.guestName ?? raw.guestName);
  if (!name) return fail(400, '請先寫你的名字（只要寫一次）');
  const text = sanitizeGuestText(raw.text);
  if (!text) return fail(400, '留言內容不能是空的');
  const ex = commentExtrasInput(raw);
  if (!ex.ok) return fail(400, ex.error);
  const thumb = decodeThumbnail(raw.thumbnail);
  if (!thumb.ok) return fail(thumb.status, thumb.error);

  const s = await songInScope(db, link, songId);
  if (s.error) return s.error;
  const song = s.song;
  const nowMs = now.getTime();
  let id = typeof raw.id === 'string' && COMMENT_ID_RE.test(raw.id) ? raw.id : newId('c');

  const ipK = guestIpKey(link.token, ipKey);
  const passK = accessToken ? await guestPassKey(accessToken) : null;
  const dayAgo = new Date(nowMs - 86400_000).toISOString();
  const [ipR, passR, dayR, countR, dupR] = await db.batch([
    db.prepare(`SELECT attempted_at FROM login_attempts WHERE ip = ? AND attempted_at > ?`).bind(ipK, nowMs - GUEST_IP_RATE.windowMs),
    db.prepare(`SELECT attempted_at FROM login_attempts WHERE ip = ? AND attempted_at > ?`).bind(passK || '-', nowMs - GUEST_PASS_RATE.windowMs),
    db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE share_token = ? AND created_at > ?`).bind(link.token, dayAgo),
    db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE song_id = ?`).bind(song.id),
    db.prepare(`SELECT song_id, share_token FROM comments WHERE id = ? LIMIT 1`).bind(id),
  ]);
  const dup = (dupR.results || [])[0];
  if (dup && dup.song_id === song.id && dup.share_token === link.token) {
    // 同一則重送（網路重試）→ 不重複新增、不重複通知
    return ok({ ok: true, duplicate: true, id, comments: await guestVisible(db, song.id, link.token) });
  }
  if (dup) id = newId('c');

  const times = (r) => (r.results || []).map(x => x.attempted_at);
  for (const [r, rule] of [[ipR, GUEST_IP_RATE], ...(passK ? [[passR, GUEST_PASS_RATE]] : [])]) {
    const g = rateDecision(times(r), nowMs, rule);
    if (!g.allowed) return fail(429, guestRateMessage(g.retryAfterMs), { retryAfterSec: Math.ceil(g.retryAfterMs / 1000) });
  }
  if ((Number((dayR.results || [])[0]?.n) || 0) >= GUEST_LINK_DAILY_MAX) {
    return fail(429, '這個分享連結今天的留言已經到上限了，請明天再留，或直接聯絡製作');
  }
  if ((Number((countR.results || [])[0]?.n) || 0) >= MAX_COMMENTS_PER_SONG) {
    return fail(429, `這首歌的留言已經太多了（上限 ${MAX_COMMENTS_PER_SONG} 則）`);
  }

  // 回覆：只能回覆這條連結裡的留言串（回覆的回覆掛在最上面那則）
  let parentId = null;
  let parentVideo = null;
  if (raw.parentId !== undefined && raw.parentId !== null && raw.parentId !== '') {
    if (typeof raw.parentId !== 'string' || !COMMENT_ID_RE.test(raw.parentId)) return fail(400, '要回覆的留言不正確');
    let parent = await db.prepare(`SELECT * FROM comments WHERE id = ? AND song_id = ? LIMIT 1`).bind(raw.parentId, song.id).first();
    if (parent?.reply_to_comment_id) {
      parent = await db.prepare(`SELECT * FROM comments WHERE id = ? AND song_id = ? LIMIT 1`).bind(parent.reply_to_comment_id, song.id).first();
    }
    if (!parent || parent.share_token !== link.token) return fail(404, '要回覆的留言已經不在了');
    parentId = parent.id;
    if (parent.video_id) parentVideo = { id: parent.video_id, version: parent.video_version };
  }

  // 綁版本：送來的那一版是這首歌可以播的就用它，不然用最新一版（分享連結看的是最新的）
  let video = null;
  if (typeof raw.videoId === 'string' && ID_RE.test(raw.videoId)) {
    video = await db.prepare(
      `SELECT id, version FROM song_videos WHERE id = ? AND song_id = ? AND status = 'ready' AND deleted_at IS NULL AND version IS NOT NULL LIMIT 1`
    ).bind(raw.videoId, song.id).first();
  }
  if (!video && parentVideo) video = parentVideo;
  if (!video) {
    video = await db.prepare(
      `SELECT id, version FROM song_videos WHERE song_id = ? AND status = 'ready' AND deleted_at IS NULL AND version IS NOT NULL
        ORDER BY version DESC LIMIT 1`
    ).bind(song.id).first();
  }

  // 記一次（算「太快了」用）；順手清掉一天以前的紀錄
  const stmts = [
    db.prepare(`DELETE FROM login_attempts WHERE attempted_at < ?`).bind(nowMs - 86400_000),
    db.prepare(`INSERT INTO login_attempts (ip, attempted_at) VALUES (?, ?)`).bind(ipK, nowMs),
  ];
  if (passK) stmts.push(db.prepare(`INSERT INTO login_attempts (ip, attempted_at) VALUES (?, ?)`).bind(passK, nowMs));
  await db.batch(stmts);

  const label = shareLinkDisplayName(link);
  const c = {
    id, time: Math.round((Number(raw.time) || 0) * 1000) / 1000, x: 0.5, y: 0.5, text,
    author: name, email: null, role: 'guest', status: 'open', createdAt: now.toISOString(),
    ...ex.extras,
  };
  const thumbKey = thumb.bytes ? await putCommentThumb(r2, link.project_id, id, thumb.bytes) : null;
  await insertCommentRow(db, {
    c, projectId: link.project_id, songId: song.id,
    videoId: video?.id ?? null, videoVersion: video?.version ?? null,
    parentId, kind: null, thumbKey,
    guest: { name, shareToken: link.token, shareLabel: label },
  });

  // 小鈴鐺：建這條連結的人、專案的導演、這首歌的動畫師；回覆 → 這串裡團隊那邊留過言的人也收到（guestCommentWants）
  try {
    const { members, memberIds } = await projectMemberIds(db, link.project_id);
    const stmts = [db.prepare(`SELECT created_by_user_id FROM share_links WHERE token = ? LIMIT 1`).bind(link.token)];
    if (parentId) {
      stmts.push(db.prepare(
        `SELECT author_user_id FROM comments
          WHERE song_id = ?1 AND (id = ?2 OR reply_to_comment_id = ?2) AND author_user_id IS NOT NULL
          ORDER BY rowid ASC`
      ).bind(song.id, parentId));
    }
    const [creatorR, threadR] = await db.batch(stmts);
    const wants = guestCommentWants({
      threadUserIds: (threadR?.results || []).map(r => r.author_user_id),
      linkCreatorId: (creatorR?.results || [])[0]?.created_by_user_id ?? null,
      members,
      animatorUserId: song.animator_user_id ?? null,
    });
    const recipients = pickRecipients(wants, memberIds, null);
    await insertNotifications(db, recipients.map(r => ({
      userId: r.userId, kind: r.kind, projectId: link.project_id, songId: song.id, songName: song.name,
      videoId: video?.id ?? null, videoVersion: video?.version ?? null, commentId: id,
      actorUserId: null, actorName: guestAuthorLabel(name, label), excerpt: text,
    })), now);
  } catch (e) {
    console.error('[guest comment notify]', e?.message || e);
  }

  return ok({ ok: true, id, comments: await guestVisible(db, song.id, link.token) });
}
