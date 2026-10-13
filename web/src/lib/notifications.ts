// 站內通知（小鈴鐺）：一則通知要怎麼說、點了去哪裡、依日子分組、未讀數字。純函式（notifications.test.ts 有測）。
// 資料從 reviewApi.ts 的 listNotifications 來（後台 cf-worker/reviews.mjs 在事情發生時寫進去）。

import type { AppNotification } from './reviewApi';
import type { ProjectRole } from './mockData';
import { parseServerTime } from './serverTime';

const songOf = (n: AppNotification) => `「${n.songCode ? `${n.songCode} ` : ''}${n.songName || '一首歌'}」`;
const v = (n: AppNotification) => (n.versionLabel ? ` ${n.versionLabel}` : '');

/** 一句話說發生什麼事（不含專案名，畫面上另外寫） */
export function notificationTitle(n: AppNotification): string {
  const who = n.actorName || '有人';
  switch (n.kind) {
    case 'mention': return `${who} 在${songOf(n)}提到你`;
    case 'reply': return `${who} 回覆了你在${songOf(n)}的留言`;
    case 'needs_changes': return `${songOf(n)}${v(n)} 需修改（${who}）`;
    case 'approved': return `${songOf(n)}${v(n)} 已通過（${who}）`;
    case 'new_version': return `${songOf(n)}有新版${v(n)} 等你審${n.actorName ? `（${n.actorName} 交的）` : ''}`;
    case 'assigned': return `${who} 把${songOf(n)}指派給你`;
    default: return `${songOf(n)}有新動態`;
  }
}

/** 第二行的小字（留言內容 / 需修改的原因 / 版本說明） */
export function notificationDetail(n: AppNotification): string {
  if (!n.excerpt) return '';
  if (n.kind === 'needs_changes') return `原因：${n.excerpt}`;
  return n.excerpt;
}

/** 點了開哪一頁：導演 / 製作 → 導演頁；動畫師 → 動畫師工作站。帶上歌、版本、留言 */
export function notificationHref(n: Pick<AppNotification, 'projectId' | 'projectRole' | 'songId' | 'videoId' | 'commentId'>): string {
  const page = n.projectRole === 'animator' ? 'studio' : 'preview';
  const q = new URLSearchParams();
  if (n.songId) q.set('song', n.songId);
  if (n.videoId) q.set('video', n.videoId);
  if (n.commentId) q.set('comment', n.commentId);
  const qs = q.toString();
  return `/${page}/${encodeURIComponent(n.projectId)}${qs ? `?${qs}` : ''}`;
}

/** 網址上的 ?song=&video=&comment=（通知點進來）→ 要打開哪首歌、哪一版、哪則留言 */
export interface DeepLink {
  songId: string | null;
  videoId: string | null;
  commentId: string | null;
}

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function parseDeepLink(search: string | URLSearchParams): DeepLink | null {
  const q = typeof search === 'string' ? new URLSearchParams(search) : search;
  const pick = (k: string) => {
    const x = q.get(k);
    return x && ID_RE.test(x) ? x : null;
  };
  const songId = pick('song');
  if (!songId) return null;
  return { songId, videoId: pick('video'), commentId: pick('comment') };
}

/** 角色 → 看這則通知用的頁面名字（「在導演頁打開」） */
export function pageLabel(role: ProjectRole | null): string {
  return role === 'animator' ? '動畫師工作站' : '導演頁';
}

/** 鈴鐺上的數字：0 不顯示，超過 99 寫 99+ */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  return count > 99 ? '99+' : String(Math.floor(count));
}

export interface NotificationGroup {
  label: string;
  items: AppNotification[];
}

function dayKey(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone });  // 2026-10-14
}

/** 依日子分組（今天 / 昨天 / 更早），每組裡面最新的在前 */
export function groupNotifications(items: readonly AppNotification[], now = Date.now(), timeZone?: string): NotificationGroup[] {
  const today = dayKey(now, timeZone);
  const yesterday = dayKey(now - 86400_000, timeZone);
  const groups: NotificationGroup[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '更早', items: [] },
  ];
  const sorted = [...items].sort((a, b) => (parseServerTime(b.createdAt) || 0) - (parseServerTime(a.createdAt) || 0));
  for (const n of sorted) {
    const ms = parseServerTime(n.createdAt);
    const k = Number.isNaN(ms) ? '' : dayKey(ms, timeZone);
    if (k === today) groups[0].items.push(n);
    else if (k === yesterday) groups[1].items.push(n);
    else groups[2].items.push(n);
  }
  return groups.filter(g => g.items.length > 0);
}

/** 自動更新時：新舊清單一樣就不換（畫面不閃） */
export function sameNotifications(a: readonly AppNotification[], b: readonly AppNotification[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.id === b[i].id && x.read === b[i].read && x.songName === b[i].songName);
}
