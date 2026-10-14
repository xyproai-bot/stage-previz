// 審片 v2 的前端呼叫：審片紀錄（V2 需修改、V3 已通過…）、站內通知。
//   後台：cf-worker/reviews.mjs（路由在 worker.js；權限在 access.mjs）；資料表 migrations/0024_review_v2.sql
//   留言綁版本 / 回覆 / 已改好：照舊用 api.ts 的 postSongComment / patchSongComment（多帶 videoId、parentId、resolvedVideoId）
//   通過 / 需修改：api.ts 的 updateSong 多帶 reason（需修改一定要寫）、reviewVideoId（看的是哪一版）

import { apiBase, getSessionToken } from './api';
import type { ProjectRole } from './mockData';

/** GET /songs 每首歌多的欄位 */
export interface SongReviewFields {
  /** 最近一次通過 / 需修改（沒有 = null） */
  lastReview: SongLastReview | null;
  /** 導演看過（按過通過 / 需修改）的最新版本號；有比這個新的版本 → 「有新版 V3」 */
  reviewedVersion: number | null;
}

export interface SongLastReview {
  videoId: string | null;
  version: number | null;
  versionLabel: string;
  status: 'approved' | 'needs_changes';
  reason: string;
  byName: string;
  byRole: string;
  at: string;
}

/** 一筆審片紀錄 */
export interface SongReview {
  id: string;
  songId: string;
  videoId: string | null;
  version: number | null;
  /** 'V2'；當時沒有版本 = '' */
  versionLabel: string;
  status: 'approved' | 'needs_changes';
  statusLabel: string;
  fromStatus: string | null;
  reason: string;
  /** 原因同時發成的那則留言 */
  commentId: string | null;
  by: { id: string | null; name: string; role: string };
  createdAt: string;
}

export type NotificationKind = 'mention' | 'needs_changes' | 'new_version' | 'assigned' | 'approved' | 'reply' | 'guest_comment' | 'director_video';

/** 一則站內通知 */
export interface AppNotification {
  id: string;
  kind: NotificationKind;
  projectId: string;
  projectName: string;
  /** 我現在在這個專案的角色（決定點了開導演頁還是動畫師工作站） */
  projectRole: ProjectRole | null;
  songId: string | null;
  songName: string;
  songCode: string | null;
  videoId: string | null;
  version: number | null;
  versionLabel: string;
  commentId: string | null;
  actorName: string;
  excerpt: string;
  createdAt: string;
  read: boolean;
}

export interface NotificationList {
  items: AppNotification[];
  unreadCount: number;
  generatedAt: string;
}

interface ApiErr extends Error { status?: number; data?: Record<string, unknown> }

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getSessionToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (typeof init.body === 'string') headers['Content-Type'] = 'application/json';
  const resp = await fetch(apiBase() + path, { credentials: 'include', ...init, headers });
  if (!resp.ok) {
    let data: Record<string, unknown> = {};
    try { data = await resp.json(); } catch { /* 不是 JSON */ }
    const e = new Error(typeof data.error === 'string' ? data.error : `HTTP ${resp.status}`) as ApiErr;
    e.status = resp.status;
    e.data = data;
    throw e;
  }
  return resp.json() as Promise<T>;
}

const enc = encodeURIComponent;

/** 一首歌的審片紀錄（新的在前） */
export async function listSongReviews(projectId: string, songId: string): Promise<SongReview[]> {
  return (await call<{ reviews: SongReview[] }>(`/api/projects/${enc(projectId)}/songs/${enc(songId)}/reviews`)).reviews;
}

/** 我的通知（最新的在前）+ 未讀數；一個請求 */
export function listNotifications(limit = 30): Promise<NotificationList> {
  return call(`/api/notifications?limit=${limit}`);
}

/** 標成已讀：給 ids，或 all = true（全部標為已讀） */
export async function markNotificationsRead(opts: { ids?: string[]; all?: boolean }): Promise<number> {
  const body = opts.all ? { all: true } : { ids: opts.ids || [] };
  return (await call<{ unreadCount: number }>('/api/notifications/read', { method: 'POST', body: JSON.stringify(body) })).unreadCount;
}
