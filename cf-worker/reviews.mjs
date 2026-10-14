// 審片 v2：讓「誰該做下一步」不會漏掉。
//   留言綁版本（V2 的留言）、回覆（一層）、「已改好（V3）」/ 重新打開
//   通過 / 需修改綁版本 → 審片紀錄（song_reviews）；需修改一定要寫原因，原因也發成一則留言
//   新版交上來：歌在「需修改」→ 自動回到「審查中」，通知導演
//   站內通知（notifications）：@你、你的歌被退、新版等你審、歌指派給你、你的歌通過了、有人回覆你
//
// 這裡的函式直接拿 D1（env.DB）做事，回傳 { status, body }，worker.js 只負責路由和包成 Response。
// 權限規則在 access.mjs；資料表在 migrations/0024_review_v2.sql。reviews.test.mjs 用 node:sqlite 跑真的 SQL。

import {
  sanitizeComment, commentToRow, rowToComment, commentPatch, MAX_COMMENTS_PER_SONG, COMMENT_ID_RE,
  commentExtrasInput, decodeThumbnail, commentThumbKey,
} from './comments.mjs';
import {
  commentPostDecision, commentResolveDecision, commentReopenDecision, canModifyComment, commentAuthorRole,
  projectRoleOf,
} from './access.mjs';

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const REVIEW_REASON_MAX = 500;
export const NOTIFICATION_KEEP_DAYS = 60;
export const NOTIFICATION_LIST_MAX = 50;
const EXCERPT_MAX = 140;

// guest_comment = 分享連結的訪客留言了（0026）
// director_video = 導演貼連結交了一版（通知這首歌的動畫師和製作；kind 欄位沒有限制，不用 migration）
export const NOTIFICATION_KINDS = ['mention', 'needs_changes', 'new_version', 'assigned', 'approved', 'reply', 'guest_comment', 'director_video'];
export const REVIEW_STATUSES = ['approved', 'needs_changes'];

const ok = (body, status = 200) => ({ status, body });
const fail = (status, error, extra = {}) => ({ status, body: { error, ...extra } });

function randHex(nBytes) {
  const b = new Uint8Array(nBytes);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
export const newId = (prefix) => `${prefix}_${randHex(8)}${Date.now().toString(36)}`;

export function versionLabel(v) {
  return Number.isInteger(v) && v > 0 ? `V${v}` : '';
}

/** 通知 / 紀錄裡放的一小段文字（一行、最多 140 字） */
export function excerptOf(text, max = EXCERPT_MAX) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// ─────────────────────────────────────────────
// 讀資料
// ─────────────────────────────────────────────

async function loadSong(db, songId) {
  return db.prepare(
    `SELECT id, project_id, name, code, status, animator_user_id FROM songs WHERE id = ? LIMIT 1`
  ).bind(songId).first();
}

/** 這首歌的某一版（可以播的） */
async function readyVideo(db, songId, videoId) {
  if (typeof videoId !== 'string' || !ID_RE.test(videoId)) return null;
  return db.prepare(
    `SELECT id, version, created_by, title, note FROM song_videos
      WHERE id = ? AND song_id = ? AND status = 'ready' AND deleted_at IS NULL AND version IS NOT NULL LIMIT 1`
  ).bind(videoId, songId).first();
}

/** 這首歌最新的可播版本 */
async function latestReadyVideo(db, songId) {
  return db.prepare(
    `SELECT id, version, created_by, title, note FROM song_videos
      WHERE song_id = ? AND status = 'ready' AND deleted_at IS NULL AND version IS NOT NULL
      ORDER BY version DESC LIMIT 1`
  ).bind(songId).first();
}

/**
 * 收得到這個專案通知的人（沒停用的）：專案成員 + 全站 admin（每個專案都看得到）
 * @returns {Promise<Array<{user_id: string, role: string, global_role: string}>>}
 */
async function projectMembers(db, projectId) {
  const r = await db.prepare(
    `SELECT pm.user_id, pm.role, u.role AS global_role
       FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = ?1 AND COALESCE(u.deactivated, 0) = 0
     UNION ALL
     SELECT u.id AS user_id, 'admin' AS role, u.role AS global_role
       FROM users u
      WHERE u.role = 'admin' AND COALESCE(u.deactivated, 0) = 0
        AND u.id NOT IN (SELECT user_id FROM project_members WHERE project_id = ?1)`
  ).bind(projectId).all();
  return r.results || [];
}

export async function listSongComments(db, songId) {
  const r = await db.prepare(`SELECT * FROM comments WHERE song_id = ? ORDER BY rowid ASC`).bind(songId).all();
  return (r.results || []).map(rowToComment);
}

// ─────────────────────────────────────────────
// 留言縮圖（R2；留言當下抓一次 3D 畫面 + 畫記）
// ─────────────────────────────────────────────

/** 存縮圖；存不進去 → null（留言照樣送出，只是沒有縮圖） */
export async function putCommentThumb(r2, projectId, commentId, bytes) {
  if (!r2 || !bytes || !bytes.length) return null;
  const key = commentThumbKey(projectId, commentId, randHex(16));
  try {
    await r2.put(key, bytes, {
      httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' },
    });
    return key;
  } catch (e) {
    console.error('[comment thumb]', e?.message || e);
    return null;
  }
}

/** 刪留言時一起清掉縮圖（失敗只記 log） */
export async function deleteCommentThumbs(r2, keys) {
  const list = (keys || []).filter(k => typeof k === 'string' && k.startsWith('comment-thumbs/'));
  if (!r2 || !list.length) return 0;
  try { await r2.delete(list); return list.length; } catch (e) { console.warn('[comment thumb delete]', e?.message || e); return 0; }
}

/** 專案成員（收通知用；guestComments.mjs 也用） */
export async function projectMemberIds(db, projectId) {
  const members = await projectMembers(db, projectId);
  return { members, memberIds: new Set(members.map(m => m.user_id)) };
}

export { insertNotifications };

// ─────────────────────────────────────────────
// 通知
// ─────────────────────────────────────────────

/**
 * 要通知誰（純函式）：去掉自己、重複的、不是專案成員的
 * @param {Array<{userId: string, kind: string}>} wants  依優先順序（同一個人只收第一個）
 * @param {Set<string>} memberIds
 * @param {string|null} actorId
 */
export function pickRecipients(wants, memberIds, actorId) {
  const seen = new Set();
  const out = [];
  for (const w of wants) {
    if (!w || typeof w.userId !== 'string' || !w.userId) continue;
    if (w.userId === actorId || seen.has(w.userId) || !memberIds.has(w.userId)) continue;
    if (!NOTIFICATION_KINDS.includes(w.kind)) continue;
    seen.add(w.userId);
    out.push(w);
  }
  return out;
}

/** 寫通知（一次寫好幾個人）；寫不進去不影響原本的動作（只記 log） */
async function insertNotifications(db, list, now) {
  const rows = list.filter(n => n && n.userId && NOTIFICATION_KINDS.includes(n.kind));
  if (!rows.length) return 0;
  const t = (now || new Date()).toISOString();
  try {
    await db.batch(rows.map(n => db.prepare(`
      INSERT INTO notifications (id, user_id, project_id, song_id, video_id, video_version, comment_id, kind,
                                 actor_user_id, actor_name, song_name, excerpt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      newId('n'), n.userId, n.projectId, n.songId ?? null, n.videoId ?? null, n.videoVersion ?? null,
      n.commentId ?? null, n.kind, n.actorUserId ?? null, String(n.actorName ?? '').slice(0, 80),
      String(n.songName ?? '').slice(0, 80), excerptOf(n.excerpt), t,
    )));
    return rows.length;
  } catch (e) {
    console.error('[notifications]', e?.message || e);
    return 0;
  }
}

/** 通知清單的一列 → API 格式 */
export function notificationToApi(row, globalRole) {
  return {
    id: row.id,
    kind: row.kind,
    projectId: row.project_id,
    projectName: row.project_name || '',
    // 我現在在這個專案的角色（點了要開導演頁還是動畫師工作站）
    projectRole: projectRoleOf(globalRole, row.member_role),
    songId: row.song_id || null,
    songName: row.cur_song_name || row.song_name || '',
    songCode: row.song_code || null,
    videoId: row.video_id || null,
    version: row.video_version ?? null,
    versionLabel: versionLabel(row.video_version),
    commentId: row.comment_id || null,
    actorName: row.actor_name || '',
    excerpt: row.excerpt || '',
    createdAt: row.created_at,
    read: !!row.read_at,
  };
}

// 只看得到：自己的、而且現在還是那個專案的成員（全站 admin 都看得到）、專案沒封存（admin 例外）
const VISIBLE_NOTIFICATIONS = `
  FROM notifications n
  JOIN projects p ON p.id = n.project_id
  LEFT JOIN project_members pm ON pm.project_id = n.project_id AND pm.user_id = n.user_id
  LEFT JOIN songs s ON s.id = n.song_id
 WHERE n.user_id = ?1
   AND (pm.user_id IS NOT NULL OR ?2 = 'admin')
   AND (p.status != 'archived' OR ?2 = 'admin')`;

/** GET /api/notifications：最新的在前 + 未讀數（一次查完） */
export async function listNotifications(db, me, { limit = 30 } = {}) {
  const n = Math.max(1, Math.min(NOTIFICATION_LIST_MAX, Number(limit) || 30));
  const [listR, countR] = await db.batch([
    db.prepare(`
      SELECT n.*, p.name AS project_name, pm.role AS member_role, s.code AS song_code, s.name AS cur_song_name
      ${VISIBLE_NOTIFICATIONS}
      ORDER BY n.created_at DESC, n.rowid DESC LIMIT ?3
    `).bind(me.id, me.role, n),
    db.prepare(`SELECT COUNT(*) AS c ${VISIBLE_NOTIFICATIONS} AND n.read_at IS NULL`).bind(me.id, me.role),
  ]);
  return ok({
    items: (listR.results || []).map(r => notificationToApi(r, me.role)),
    unreadCount: Number((countR.results || [])[0]?.c) || 0,
    generatedAt: new Date().toISOString(),
  });
}

/** POST /api/notifications/read：{ ids: [...] } 或 { all: true } */
export async function markNotificationsRead(db, me, body, now = new Date()) {
  const t = now.toISOString();
  if (body?.all === true) {
    await db.prepare(`UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`).bind(t, me.id).run();
  } else {
    const ids = Array.isArray(body?.ids) ? body.ids.filter(x => typeof x === 'string' && ID_RE.test(x)).slice(0, 200) : [];
    if (!ids.length) return fail(400, '要標成已讀的通知不正確');
    await db.prepare(
      `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`
    ).bind(t, me.id, ...ids).run();
  }
  const c = await db.prepare(`SELECT COUNT(*) AS c ${VISIBLE_NOTIFICATIONS} AND n.read_at IS NULL`).bind(me.id, me.role).first();
  return ok({ ok: true, unreadCount: Number(c?.c) || 0 });
}

/** 排程：清掉太舊的通知（預設 60 天） */
export async function pruneNotifications(db, now = new Date(), days = NOTIFICATION_KEEP_DAYS) {
  const cutoff = new Date(now.getTime() - days * 86400_000).toISOString();
  const r = await db.prepare(`DELETE FROM notifications WHERE created_at < ?`).bind(cutoff).run();
  return r?.meta?.changes ?? 0;
}

// ─────────────────────────────────────────────
// 留言（POST / PATCH / DELETE /api/comments?session=…；thread = worker.js resolveCommentThread 的結果）
// ─────────────────────────────────────────────

/**
 * 發留言 / 回覆。
 * body.comment 可以多帶（舊版前端不帶也照樣能留言）：
 *   videoId   留言時看的那一版 → 記下版本號（不是這首歌可以播的版本就當沒帶）
 *   parentId  回覆哪一則（只有一層：回覆的回覆會掛在最上面那則）；沒帶 videoId 就跟著那則的版本
 */
export async function postComment(db, { me, thread, body, now = new Date(), r2 = null }) {
  const raw = body?.comment;
  if (!raw || typeof raw !== 'object') return fail(400, 'Invalid comment');
  const song = await loadSong(db, thread.songId);
  if (!song) return fail(404, '這首歌不在了');
  const perm = commentPostDecision({ role: thread.role, userId: me.id, song });
  if (!perm.ok) return fail(perm.status, perm.error);

  // 作者、身分由後台依登入的人填；新留言一律「未解決」
  const c = sanitizeComment({
    ...raw,
    author: me.name,
    role: commentAuthorRole(me.role),
    authorUserId: me.id,
    status: 'open',
    resolvedBy: undefined,
    resolvedAt: undefined,
  });
  if (!c) return fail(400, 'Invalid comment');
  // 0026：區段、3D 視角、cue、畫記、縮圖（舊版前端不帶 → 跟以前一樣）
  const ex = commentExtrasInput(raw);
  if (!ex.ok) return fail(400, ex.error);
  Object.assign(c, ex.extras);
  const thumb = decodeThumbnail(raw.thumbnail);
  if (!thumb.ok) return fail(thumb.status, thumb.error);

  // 回覆：只有一層
  let parent = null;
  let repliedTo = null;  // 按「回覆」的那一則（可能是一則回覆；通知它的作者）
  if (raw.parentId !== undefined && raw.parentId !== null && raw.parentId !== '') {
    if (typeof raw.parentId !== 'string' || !COMMENT_ID_RE.test(raw.parentId)) return fail(400, '要回覆的留言不正確');
    parent = await db.prepare(`SELECT * FROM comments WHERE id = ? AND song_id = ? LIMIT 1`).bind(raw.parentId, song.id).first();
    if (!parent) return fail(404, '要回覆的留言已經被刪掉了');
    repliedTo = parent;
    if (parent.reply_to_comment_id) {
      const root = await db.prepare(`SELECT * FROM comments WHERE id = ? AND song_id = ? LIMIT 1`)
        .bind(parent.reply_to_comment_id, song.id).first();
      if (root) parent = root;
    }
  }

  // 綁版本
  let video = raw.videoId ? await readyVideo(db, song.id, raw.videoId) : null;
  if (!video && parent?.video_id) video = { id: parent.video_id, version: parent.video_version };

  const [countR, dupR] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM comments WHERE song_id = ?`).bind(song.id),
    db.prepare(`SELECT song_id FROM comments WHERE id = ? LIMIT 1`).bind(c.id),
  ]);
  const dup = (dupR.results || [])[0];
  if (dup && dup.song_id === song.id) {
    // 同一則重送（網路重試）→ 不重複新增、不重複通知
    return ok({ ok: true, duplicate: true, comments: await listSongComments(db, song.id) });
  }
  if (dup) c.id = newId('c');  // id 撞到別首歌的留言 → 換一個
  if ((Number((countR.results || [])[0]?.n) || 0) >= MAX_COMMENTS_PER_SONG) {
    return fail(429, `這首歌的留言已經太多了（上限 ${MAX_COMMENTS_PER_SONG} 則）`);
  }

  const thumbKey = thumb.bytes ? await putCommentThumb(r2, thread.projectId, c.id, thumb.bytes) : null;
  await insertCommentRow(db, {
    c, projectId: thread.projectId, songId: song.id,
    videoId: video?.id ?? null, videoVersion: video?.version ?? null,
    parentId: parent?.id ?? null, kind: null, thumbKey,
  });

  // 通知：@到的人；回覆 → 按回覆的那一則的作者、最上面那則的作者
  const members = await projectMembers(db, thread.projectId);
  const memberIds = new Set(members.map(m => m.user_id));
  const wants = (c.mentions || []).map(m => ({ userId: m.userId, kind: 'mention' }));
  if (repliedTo?.author_user_id) wants.push({ userId: repliedTo.author_user_id, kind: 'reply' });
  if (parent?.author_user_id) wants.push({ userId: parent.author_user_id, kind: 'reply' });
  const recipients = pickRecipients(wants, memberIds, me.id);
  await insertNotifications(db, recipients.map(r => ({
    userId: r.userId, kind: r.kind, projectId: thread.projectId, songId: song.id, songName: song.name,
    videoId: video?.id ?? null, videoVersion: video?.version ?? null,
    commentId: c.id,
    actorUserId: me.id, actorName: me.name, excerpt: c.text,
  })), now);

  return ok({ ok: true, id: c.id, comments: await listSongComments(db, song.id) });
}

/**
 * 寫一則留言（團隊的、訪客的都走這裡）。guest = { name, shareToken, shareLabel }（訪客才有）
 */
export async function insertCommentRow(db, { c, projectId, songId, videoId, videoVersion, parentId, kind, thumbKey = null, guest = null }) {
  const row = commentToRow(c);
  await db.prepare(`
    INSERT INTO comments (id, project_id, song_id, time_in_video, anchor_type, anchor_screen_xy, anchor_world_xyz,
      anchor_mesh_name, anchor_offset_xyz, text, mentions, status, resolved_by, resolved_at,
      author_user_id, author_name, author_role, author_email, created_at,
      video_id, video_version, reply_to_comment_id, kind,
      time_end, view_json, cue_id, annotation_json, thumb_key, guest_name, share_token, share_label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    row.id, projectId, songId, row.time_in_video, row.anchor_type, row.anchor_screen_xy, row.anchor_world_xyz,
    row.anchor_mesh_name, row.anchor_offset_xyz, row.text, row.mentions, row.status, row.resolved_by, row.resolved_at,
    row.author_user_id, row.author_name, row.author_role, row.author_email, row.created_at,
    videoId, videoVersion, parentId, kind,
    row.time_end, row.view_json, row.cue_id, row.annotation_json, thumbKey,
    guest?.name ?? null, guest?.shareToken ?? null, guest?.shareLabel ?? null,
  ).run();
}

/**
 * 改留言：
 *   text            留言的人或 admin
 *   status resolved 「已改好」：admin、負責的動畫師、留言的人自己；body.resolvedVideoId = 哪一版改好的（沒帶 = 最新一版）
 *   status open     重新打開：admin、導演、負責的動畫師、留言的人自己
 */
export async function patchComment(db, { me, thread, body, now = new Date() }) {
  const id = (body && typeof body.id === 'string') ? body.id : null;
  if (!id || !COMMENT_ID_RE.test(id)) return fail(400, 'Missing or invalid id');
  const row = await db.prepare(`SELECT * FROM comments WHERE id = ? AND song_id = ? LIMIT 1`).bind(id, thread.songId).first();
  if (!row) return fail(404, '這則留言已經被刪掉了');
  const comment = rowToComment(row);

  const p = commentPatch(body, me, now);
  if (!p.ok) return fail(400, p.error);
  if (p.touchesText && !canModifyComment(comment, me.id, thread.role)) {
    return fail(403, '只有留言的人或製作可以修改這則留言');
  }
  const changes = { ...p.changes };
  if ('status' in changes) {
    const song = await loadSong(db, thread.songId);
    const decide = changes.status === 'resolved' ? commentResolveDecision : commentReopenDecision;
    const d = decide({ role: thread.role, userId: me.id, song, comment });
    if (!d.ok) return fail(d.status, d.error);
    if (changes.status === 'resolved') {
      let video = null;
      if (body.resolvedVideoId !== undefined && body.resolvedVideoId !== null) {
        video = await readyVideo(db, thread.songId, body.resolvedVideoId);
        if (!video) return fail(400, '選的版本不在了，請重新整理後再標');
      } else {
        video = await latestReadyVideo(db, thread.songId);
      }
      changes.resolved_video_id = video?.id ?? null;
      changes.resolved_version = video?.version ?? null;
      changes.resolved_by_user_id = me.id;
    } else {
      changes.resolved_video_id = null;
      changes.resolved_version = null;
      changes.resolved_by_user_id = null;
    }
  }
  const keys = Object.keys(changes);
  await db.prepare(
    `UPDATE comments SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ? AND song_id = ?`
  ).bind(...keys.map(k => changes[k]), id, thread.songId).run();
  return ok({ ok: true, comments: await listSongComments(db, thread.songId) });
}

/** 刪留言（留言的人或 admin）；底下的回覆一起刪 */
export async function deleteComment(db, { me, thread, id, r2 = null }) {
  if (!id || !COMMENT_ID_RE.test(id)) return fail(400, 'Missing or invalid id');
  const row = await db.prepare(`SELECT * FROM comments WHERE id = ? AND song_id = ? LIMIT 1`).bind(id, thread.songId).first();
  if (row) {
    if (!canModifyComment(rowToComment(row), me.id, thread.role)) {
      return fail(403, '只有留言的人或製作可以刪除這則留言');
    }
    const thumbs = (await db.prepare(
      `SELECT thumb_key FROM comments WHERE (id = ?1 OR reply_to_comment_id = ?1) AND song_id = ?2 AND thumb_key IS NOT NULL`
    ).bind(id, thread.songId).all()).results || [];
    await db.batch([
      db.prepare(`DELETE FROM comments WHERE reply_to_comment_id = ? AND song_id = ?`).bind(id, thread.songId),
      db.prepare(`DELETE FROM comments WHERE id = ? AND song_id = ?`).bind(id, thread.songId),
    ]);
    await deleteCommentThumbs(r2, thumbs.map(t => t.thumb_key));
  }
  return ok({ ok: true, comments: await listSongComments(db, thread.songId) });
}

// ─────────────────────────────────────────────
// 通過 / 需修改（PATCH /songs/:id 改狀態時）
// ─────────────────────────────────────────────

/**
 * 改狀態之前先檢查（純函式）：需修改要寫原因、看的是哪一版。
 *   body.reason          需修改的原因（新版前端一定會帶 reason 這個欄位；舊版前端沒帶 → 照以前一樣可以改，原因空白）
 *   body.reviewVideoId   看的是哪一版（沒帶 = 最新一版）
 * @returns {{ok: true, reason: string, reviewVideoId: string|null} | {ok: false, status: number, error: string}}
 */
export function songDecisionInput(body, to) {
  let reason = '';
  if (body && 'reason' in body && body.reason !== null && body.reason !== undefined) {
    if (typeof body.reason !== 'string') return { ok: false, status: 400, error: '原因要是文字' };
    reason = body.reason.trim().slice(0, REVIEW_REASON_MAX);
  }
  if (to === 'needs_changes' && body && 'reason' in body && !reason) {
    return { ok: false, status: 400, error: '請寫一下要改什麼（「需修改」一定要寫原因，動畫師才知道從哪裡改）' };
  }
  let reviewVideoId = null;
  if (body && body.reviewVideoId !== undefined && body.reviewVideoId !== null && body.reviewVideoId !== '') {
    if (typeof body.reviewVideoId !== 'string' || !ID_RE.test(body.reviewVideoId)) {
      return { ok: false, status: 400, error: '看的版本不正確' };
    }
    reviewVideoId = body.reviewVideoId;
  }
  return { ok: true, reason, reviewVideoId };
}

/**
 * 改狀態之前：檢查原因、找出看的是哪一版（只有通過 / 需修改才要）
 * @returns {Promise<{ok: true, decision: null | {reason: string, video: object|null}} | {ok: false, status: number, error: string}>}
 */
export async function prepareStatusChange(db, { song, body, to }) {
  if (!REVIEW_STATUSES.includes(to)) return { ok: true, decision: null };
  const input = songDecisionInput(body, to);
  if (!input.ok) return input;
  let video = null;
  if (input.reviewVideoId) {
    video = await readyVideo(db, song.id, input.reviewVideoId);
    if (!video) return { ok: false, status: 400, error: '你看的那一版影片已經不在了（可能剛被刪掉），請重新整理後再按' };
  } else {
    video = await latestReadyVideo(db, song.id);
  }
  return { ok: true, decision: { reason: input.reason, video } };
}

/**
 * 狀態改成功之後：寫審片紀錄、需修改的原因發成留言、通知。
 *   通過 / 需修改 → 審片紀錄 + 通知這首歌的動畫師（沒指派 → 交這一版的人）
 *   提交審查（待製作 / 需修改 → 審查中）→ 通知專案的導演「新版等你審」
 * 寫不進去不影響狀態（已經改好了），只記 log。
 */
export async function afterSongStatusChange(db, { me, role, song, from, to, prepared, now = new Date() }) {
  const out = { reviewId: null, commentId: null, notified: 0 };
  try {
    const members = await projectMembers(db, song.project_id);
    const memberIds = new Set(members.map(m => m.user_id));
    if (REVIEW_STATUSES.includes(to)) {
      const d = prepared?.decision || { reason: '', video: await latestReadyVideo(db, song.id) };
      const video = d.video || null;
      const t = now.toISOString();
      const stmts = [];
      if (to === 'needs_changes' && d.reason) {
        out.commentId = newId('c');
        const c = sanitizeComment({
          id: out.commentId, text: `需修改：${d.reason}`, time: 0, x: 0.5, y: 0.5,
          author: me.name, role: commentAuthorRole(me.role), authorUserId: me.id, status: 'open', createdAt: t,
        });
        const row = commentToRow(c);
        stmts.push(db.prepare(`
          INSERT INTO comments (id, project_id, song_id, time_in_video, anchor_screen_xy, text, status,
            author_user_id, author_name, author_role, author_email, created_at, video_id, video_version, kind)
          VALUES (?, ?, ?, 0, ?, ?, 'open', ?, ?, ?, NULL, ?, ?, ?, 'needs_changes')
        `).bind(row.id, song.project_id, song.id, row.anchor_screen_xy, row.text,
          row.author_user_id, row.author_name, row.author_role, row.created_at, video?.id ?? null, video?.version ?? null));
      }
      out.reviewId = newId('rv');
      stmts.push(db.prepare(`
        INSERT INTO song_reviews (id, project_id, song_id, video_id, video_version, status, from_status, reason,
                                  comment_id, by_user_id, by_name, by_role, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(out.reviewId, song.project_id, song.id, video?.id ?? null, video?.version ?? null, to, from ?? null,
        d.reason || '', out.commentId, me.id, String(me.name || '').slice(0, 80), role || '', t));
      await db.batch(stmts);

      // 通知這首歌的動畫師（沒指派 → 交這一版的人）
      const wants = [];
      if (song.animator_user_id) wants.push({ userId: song.animator_user_id, kind: to });
      else if (video?.created_by) wants.push({ userId: video.created_by, kind: to });
      out.notified = await insertNotifications(db, pickRecipients(wants, memberIds, me.id).map(r => ({
        userId: r.userId, kind: r.kind, projectId: song.project_id, songId: song.id, songName: song.name,
        videoId: video?.id ?? null, videoVersion: video?.version ?? null, commentId: out.commentId,
        actorUserId: me.id, actorName: me.name, excerpt: d.reason,
      })), now);
    } else if (to === 'in_review' && (from === 'todo' || from === 'needs_changes')) {
      const video = await latestReadyVideo(db, song.id);
      out.notified = await notifyDirectorsNewVersion(db, { song, video, members, actor: { id: me.id, name: me.name }, now });
    }
  } catch (e) {
    console.error('[afterSongStatusChange]', e?.message || e);
  }
  return out;
}

/** 通知專案的導演「新版等你審」（帳號是全站 admin 的不算導演） */
async function notifyDirectorsNewVersion(db, { song, video, members, actor, now }) {
  const directorIds = members.filter(m => m.role === 'director' && m.global_role !== 'admin').map(m => m.user_id);
  const memberIds = new Set(members.map(m => m.user_id));
  const recipients = pickRecipients(directorIds.map(userId => ({ userId, kind: 'new_version' })), memberIds, actor?.id ?? null);
  return insertNotifications(db, recipients.map(r => ({
    userId: r.userId, kind: 'new_version', projectId: song.project_id, songId: song.id, songName: song.name,
    videoId: video?.id ?? null, videoVersion: video?.version ?? null,
    actorUserId: actor?.id ?? null, actorName: actor?.name || (video ? 'Drive 同步' : ''),
    excerpt: video?.note || video?.title || '',
  })), now);
}

/** 導演貼連結交的一版好了：通知這首歌的動畫師（有指派的話）和專案的製作（不改歌的狀態、不通知導演） */
async function notifyDirectorVideo(db, { song, video, members, actor, now }) {
  const memberIds = new Set(members.map(m => m.user_id));
  const wants = [];
  if (song.animator_user_id) wants.push({ userId: song.animator_user_id, kind: 'director_video' });
  for (const m of members) if (m.role === 'admin') wants.push({ userId: m.user_id, kind: 'director_video' });
  const recipients = pickRecipients(wants, memberIds, actor?.id ?? null);
  return insertNotifications(db, recipients.map(r => ({
    userId: r.userId, kind: 'director_video', projectId: song.project_id, songId: song.id, songName: song.name,
    videoId: video?.id ?? null, videoVersion: video?.version ?? null,
    actorUserId: actor?.id ?? null, actorName: actor?.name || '',
    excerpt: video?.note || video?.title || '',
  })), now);
}

/**
 * 新的一版好了（上傳完成 / 貼連結複製完 / Drive 同步複製完都會走到這裡）：
 *   導演自己貼連結交的 → 不改歌的狀態、不通知導演；通知這首歌的動畫師和製作「導演貼了一版」
 *   歌在「需修改」→ 自動改回「審查中」（動畫師交了新版 = 改好重新提交）
 *   歌在審查中（含剛剛自動改的）/ 已通過 → 通知導演「新版等你審」
 *   待製作 → 不動（動畫師自己按「提交審查」時才通知）
 * @returns {Promise<{autoSubmitted: boolean, notified: number, byDirector?: boolean, songId?: string, version?: number}>}
 */
export async function afterVideoReady(db, { videoId, now = new Date() }) {
  const out = { autoSubmitted: false, notified: 0 };
  try {
    const v = await db.prepare(`
      SELECT v.id, v.song_id, v.project_id, v.version, v.created_by, v.title, v.note, u.name AS created_by_name
        FROM song_videos v LEFT JOIN users u ON u.id = v.created_by
       WHERE v.id = ? AND v.status = 'ready' AND v.deleted_at IS NULL LIMIT 1
    `).bind(videoId).first();
    if (!v) return out;
    const song = await loadSong(db, v.song_id);
    if (!song) return out;
    out.songId = song.id;
    out.version = v.version;
    // 交的人在這個專案是導演（帳號是全站 admin 的算製作）
    if (v.created_by) {
      const members = await projectMembers(db, song.project_id);
      const creator = members.find(m => m.user_id === v.created_by);
      if (creator && creator.role === 'director' && creator.global_role !== 'admin') {
        out.byDirector = true;
        out.notified = await notifyDirectorVideo(db, {
          song, video: v, members, actor: { id: v.created_by, name: v.created_by_name || '' }, now,
        });
        return out;
      }
    }
    let status = song.status;
    if (status === 'needs_changes') {
      const r = await db.prepare(
        `UPDATE songs SET status = 'in_review' WHERE id = ? AND status = 'needs_changes'`
      ).bind(song.id).run();
      if (r?.meta?.changes) { out.autoSubmitted = true; status = 'in_review'; }
    }
    if (status === 'in_review' || status === 'approved') {
      const members = await projectMembers(db, song.project_id);
      out.notified = await notifyDirectorsNewVersion(db, {
        song, video: v, members,
        actor: v.created_by ? { id: v.created_by, name: v.created_by_name || '' } : null,
        now,
      });
    }
  } catch (e) {
    console.error('[afterVideoReady]', e?.message || e);
  }
  return out;
}

/** 指派動畫師之後：通知被指派的人（自己指派給自己不用） */
export async function afterAnimatorAssigned(db, { me, song, toUserId, now = new Date() }) {
  if (!toUserId || toUserId === song.animator_user_id) return 0;
  try {
    const members = await projectMembers(db, song.project_id);
    const memberIds = new Set(members.map(m => m.user_id));
    return await insertNotifications(db, pickRecipients([{ userId: toUserId, kind: 'assigned' }], memberIds, me.id).map(r => ({
      userId: r.userId, kind: 'assigned', projectId: song.project_id, songId: song.id, songName: song.name,
      actorUserId: me.id, actorName: me.name, excerpt: '',
    })), now);
  } catch (e) {
    console.error('[afterAnimatorAssigned]', e?.message || e);
    return 0;
  }
}

// ─────────────────────────────────────────────
// 審片紀錄（GET /songs/:id/reviews、歌單的「上次看過哪一版」）
// ─────────────────────────────────────────────

const STATUS_LABEL = { approved: '已通過', needs_changes: '需修改' };

export function reviewToApi(r) {
  return {
    id: r.id,
    songId: r.song_id,
    videoId: r.video_id || null,
    version: r.video_version ?? null,
    versionLabel: versionLabel(r.video_version),
    status: r.status,
    statusLabel: STATUS_LABEL[r.status] || r.status,
    fromStatus: r.from_status || null,
    reason: r.reason || '',
    commentId: r.comment_id || null,
    by: { id: r.by_user_id || null, name: r.by_name || '', role: r.by_role || '' },
    createdAt: r.created_at,
  };
}

export async function listSongReviews(db, songId, { limit = 100 } = {}) {
  const r = await db.prepare(
    `SELECT * FROM song_reviews WHERE song_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`
  ).bind(songId, Math.max(1, Math.min(200, Number(limit) || 100))).all();
  return ok({ reviews: (r.results || []).map(reviewToApi) });
}

/**
 * 歌單用：每首歌最近一次通過 / 需修改，和看過的最新版本號（有比這個新的版本 → 「有新版 V3」）
 * @returns {Promise<Map<string, {lastReview: object, reviewedVersion: number|null}>>}
 */
export async function reviewSummaryBySong(db, projectId) {
  const map = new Map();
  try {
    const r = await db.prepare(`
      SELECT r.*,
             (SELECT MAX(r3.video_version) FROM song_reviews r3 WHERE r3.song_id = r.song_id) AS max_version
        FROM song_reviews r
       WHERE r.project_id = ?
         AND r.rowid = (SELECT r2.rowid FROM song_reviews r2 WHERE r2.song_id = r.song_id
                         ORDER BY r2.created_at DESC, r2.rowid DESC LIMIT 1)
    `).bind(projectId).all();
    for (const row of (r.results || [])) {
      const api = reviewToApi(row);
      map.set(row.song_id, {
        lastReview: {
          videoId: api.videoId, version: api.version, versionLabel: api.versionLabel, status: api.status,
          reason: api.reason, byName: api.by.name, byRole: api.by.role, at: api.createdAt,
        },
        reviewedVersion: row.max_version ?? null,
      });
    }
  } catch (e) {
    // 還沒套 migration 0024 的資料庫（本機舊資料）→ 歌單照樣出來，只是沒有審片紀錄
    console.warn('[reviewSummaryBySong]', e?.message || e);
  }
  return map;
}
