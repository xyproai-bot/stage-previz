// 未讀留言追蹤（client-side, localStorage）
//
// 為何不上 server？KV 留言 API 沒有 read receipt，加 D1 schema 太重。
// 對單人 / 少人協作場景，client-only 已足夠（換瀏覽器 / 換裝置會 reset，但能接受）。
//
// Key 格式：`sp_seen:${userId}:${songCommentSession}` → 上次看的時間戳 ISO string

import type { SongComment } from './api';
import { songCommentSession } from './api';
import { isOwnComment } from './songReview';

/** 我是誰：有 id 就用 id 比（後台會在留言記 authorUserId）；只有名字的舊寫法也還能用 */
type Me = { id: string; name: string } | string | null;
const isMine = (c: SongComment, me: Me) =>
  typeof me === 'string' ? c.author === me : isOwnComment(c, me);

function key(userId: string, projectId: string, songId: string): string {
  return `sp_seen:${userId}:${songCommentSession(projectId, songId)}`;
}

/** 標記某首歌「已看到此時刻」（通常用 max(comment.createdAt)） */
export function markSeen(userId: string, projectId: string, songId: string, atIso?: string): void {
  try {
    localStorage.setItem(key(userId, projectId, songId), atIso || new Date().toISOString());
  } catch { /* ignore */ }
}

/** 拿某首歌的「上次看到時間」 */
export function getLastSeen(userId: string, projectId: string, songId: string): string | null {
  try { return localStorage.getItem(key(userId, projectId, songId)); } catch { return null; }
}

/** 算未讀數：comments 中 createdAt > lastSeen 且作者不是自己（自己留言不算未讀） */
export function unreadCount(comments: SongComment[], lastSeenIso: string | null, me: Me): number {
  if (comments.length === 0) return 0;
  if (!lastSeenIso) {
    // 從沒看過 → 都算未讀（但排除自己留的）
    return comments.filter(c => !isMine(c, me)).length;
  }
  return comments.filter(c => !isMine(c, me) && c.createdAt > lastSeenIso).length;
}

/** 算給定 song / 整個 comments map 的未讀（用 getLastSeen） */
export function songUnread(
  userId: string, projectId: string, songId: string, comments: SongComment[], me: Me
): number {
  return unreadCount(comments, getLastSeen(userId, projectId, songId), me);
}

// ─── 用留言摘要算未讀（docs/comments-api.md；工作站每 25 秒只叫一次摘要，不用一首一首抓留言）───

/** 摘要裡一首歌的資料（videoApi.ts 的 CommentSummary） */
export interface SummaryLike {
  songId: string;
  count: number;
  openCount: number;
  latestAt: string | null;
  fromOthersCount: number;
  latestFromOthersAt: string | null;
}

/**
 * 一首歌的未讀數：
 *   從沒看過 → 別人留的都算（fromOthersCount）
 *   別人最新一則沒有比上次看的新 → 0
 *   比較新 → 用那首歌的留言算準的（還沒抓到 / 抓到的是舊的 → 至少 1）
 */
export function unreadFromSummary(
  s: SummaryLike | undefined, lastSeenIso: string | null, comments: SongComment[] | undefined, me: Me,
): number {
  if (!s) return comments ? unreadCount(comments, lastSeenIso, me) : 0;
  if (!lastSeenIso) return s.fromOthersCount;
  if (!s.latestFromOthersAt || s.latestFromOthersAt <= lastSeenIso) return 0;
  return comments ? Math.max(1, unreadCount(comments, lastSeenIso, me)) : 1;
}

/**
 * 這次要抓哪幾首歌的留言（其他的只看摘要就夠了）：
 *   - always（正在看的那首：審查分頁要顯示整串，留言改字 / 解決摘要看不出來，每次都抓）
 *   - 有別人的新留言、比上次看的還新，而且摘要變了或還沒抓過（要算準未讀）
 *   - 跟上一次摘要比，多了別人的新留言（跳提示要知道內容）
 */
export function songsToFetch(
  curr: SummaryLike[],
  prev: Map<string, SummaryLike> | null,
  lastSeenFor: (songId: string) => string | null,
  loaded: (songId: string) => boolean,
  always: string | null,
): string[] {
  const out: string[] = [];
  for (const s of curr) {
    const p = prev?.get(s.songId);
    const changed = !p || p.count !== s.count || p.openCount !== s.openCount || p.latestAt !== s.latestAt;
    const ls = lastSeenFor(s.songId);
    const unseenNew = !!s.latestFromOthersAt && !!ls && s.latestFromOthersAt > ls;
    const newSincePrev = !!p && (s.latestFromOthersAt ?? '') > (p.latestFromOthersAt ?? '');
    if (s.songId === always || (unseenNew && (changed || !loaded(s.songId))) || newSincePrev) out.push(s.songId);
  }
  return out;
}

/** 上一次摘要之後別人新留的（跳提示用）；sinceIso = 上一次摘要的 latestFromOthersAt */
export function newFromOthersSince(comments: SongComment[], sinceIso: string | null, me: Me): SongComment[] {
  return comments
    .filter(c => !isMine(c, me) && (!sinceIso || c.createdAt > sinceIso))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
