// 審片紀錄（V2 需修改、V3 已通過…）和「有新版 V3」的判斷。純函式（reviewHistory.test.ts 有測）。

import type { Song } from './api';
import type { SongLastReview, SongReview } from './reviewApi';
import { parseServerTime } from './serverTime';
import { roleLabel } from './roleLabels';

/** 10/14 15:20（本地時間；不是今年加年份） */
export function shortDateTime(s: string | null | undefined, opts: { now?: number; timeZone?: string } = {}): string {
  const ms = parseServerTime(s ?? '');
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const now = new Date(opts.now ?? Date.now());
  const year = (x: Date) => x.toLocaleDateString('en-US', { year: 'numeric', timeZone: opts.timeZone });
  const date = d.toLocaleDateString('zh-TW', {
    ...(year(d) === year(now) ? {} : { year: 'numeric' as const }),
    month: 'numeric', day: 'numeric', timeZone: opts.timeZone,
  });
  const time = d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: opts.timeZone });
  return `${date} ${time}`;
}

/** 誰按的：「導演 王小明」「製作 小花」 */
export function reviewerLabel(by: { name: string; role: string }): string {
  return [by.role ? roleLabel(by.role) : '', by.name].filter(Boolean).join(' ');
}

/** 一行紀錄的前半：「V2 需修改 · 導演 王小明 · 10/14 15:20」（原因另外放） */
export function reviewLine(r: Pick<SongReview, 'versionLabel' | 'statusLabel' | 'createdAt'> & { by: { name: string; role: string } }, opts: { now?: number; timeZone?: string } = {}): string {
  return [
    `${r.versionLabel ? `${r.versionLabel} ` : ''}${r.statusLabel}`,
    reviewerLabel(r.by),
    shortDateTime(r.createdAt, opts),
  ].filter(Boolean).join(' · ');
}

/**
 * 有沒有比導演看過的更新的版本（「有新版 V3」）：
 *   導演按過通過 / 需修改，而且最新可以播的版本比看過的新 → 'V3'
 *   從沒審過、沒有影片、看的就是最新的 → null
 */
export function newVersionLabel(song: Pick<Song, 'latestVideoVersion' | 'lastReview' | 'reviewedVersion'>): string | null {
  const latest = song.latestVideoVersion;
  if (latest == null || !song.lastReview) return null;
  const seen = song.reviewedVersion ?? song.lastReview.version ?? null;
  if (seen != null && latest <= seen) return null;
  return `V${latest}`;
}

/** 按了通過 / 需修改之後的提示：誰會收到通知（沒指派、也沒有人交過影片 → 沒有人收到） */
export function decisionNotifyHint(song: Pick<Song, 'animatorUserId' | 'latestVideoId'>): string {
  if (song.animatorUserId) return '負責的動畫師會收到通知';
  if (song.latestVideoId) return '交這一版的動畫師會收到通知';
  return '這首歌還沒指派動畫師，目前沒有人會收到通知';
}

/** 動畫師工作站的一句：「導演看過 V2：需修改（原因…）」/「導演看過 V3：已通過」 */
export function lastReviewSentence(r: SongLastReview | null | undefined): string | null {
  if (!r) return null;
  const who = r.byRole === 'admin' ? '製作' : '導演';
  const label = r.status === 'needs_changes' ? '需修改' : '已通過';
  const ver = r.versionLabel ? ` ${r.versionLabel}` : '';
  return `${who}看過${ver}：${label}${r.status === 'needs_changes' && r.reason ? `（${r.reason}）` : ''}`;
}
