// 未讀留言追蹤（client-side, localStorage）
//
// 為何不上 server？KV 留言 API 沒有 read receipt，加 D1 schema 太重。
// 對單人 / 少人協作場景，client-only 已足夠（換瀏覽器 / 換裝置會 reset，但能接受）。
//
// Key 格式：`sp_seen:${userId}:${songCommentSession}` → 上次看的時間戳 ISO string

import type { SongComment } from './api';
import { songCommentSession } from './api';

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
export function unreadCount(comments: SongComment[], lastSeenIso: string | null, ownAuthor: string | null): number {
  if (comments.length === 0) return 0;
  if (!lastSeenIso) {
    // 從沒看過 → 都算未讀（但排除自己留的）
    return comments.filter(c => c.author !== ownAuthor).length;
  }
  return comments.filter(c => c.author !== ownAuthor && c.createdAt > lastSeenIso).length;
}

/** 算給定 song / 整個 comments map 的未讀（用 getLastSeen） */
export function songUnread(
  userId: string, projectId: string, songId: string, comments: SongComment[], ownAuthor: string | null
): number {
  return unreadCount(comments, getLastSeen(userId, projectId, songId), ownAuthor);
}
