// 留言跟著播放：影片播到哪裡，就把離播放頭最近的那則留言標出來——純函式（playhead.test.ts 有測）
//
//   有綁時間的才算（time > 0，或有區段）；沒綁時間的一般留言不會被標
//   播放頭在某個區段裡（0:12–0:18）→ 那則（好幾則都包住 → 開始最晚的、再來最短的）
//   不在任何區段裡 → 離得最近的（距離一樣 → 在播放頭前面的那則；區段算到最近的那一邊）

export interface TimedItem {
  id: string;
  time: number;
  timeEnd?: number | null;
}

const hasTime = (c: TimedItem) => (c.time > 0) || (c.timeEnd != null && c.timeEnd > c.time);

/** 離播放頭 t 最近的留言 id；沒有綁時間的留言 = null */
export function playheadCommentId(items: readonly TimedItem[], t: number): string | null {
  if (!Number.isFinite(t)) return null;
  let inside: TimedItem | null = null;
  for (const c of items) {
    if (!hasTime(c) || c.timeEnd == null || !(c.timeEnd > c.time)) continue;
    if (t < c.time || t > c.timeEnd) continue;
    if (!inside || c.time > inside.time || (c.time === inside.time && (c.timeEnd - c.time) < ((inside.timeEnd as number) - inside.time))) {
      inside = c;
    }
  }
  if (inside) return inside.id;
  let best: TimedItem | null = null;
  let bestD = Infinity;
  let bestBefore = false;
  for (const c of items) {
    if (!hasTime(c)) continue;
    const end = c.timeEnd != null && c.timeEnd > c.time ? c.timeEnd : c.time;
    const d = t < c.time ? c.time - t : t > end ? t - end : 0;
    const before = c.time <= t;
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && before && !bestBefore)) {
      best = c; bestD = d; bestBefore = before;
    }
  }
  return best?.id ?? null;
}

/** 下一則 / 上一則有綁時間的留言從幾秒開始（之後可以做「跳到下一則」） */
export function adjacentCommentTime(items: readonly TimedItem[], t: number, dir: 1 | -1): number | null {
  const times = items.filter(hasTime).map(c => c.time).sort((a, b) => a - b);
  if (dir > 0) return times.find(x => x > t + 0.05) ?? null;
  for (let i = times.length - 1; i >= 0; i--) if (times[i] < t - 0.05) return times[i];
  return null;
}

/** 區段循環：播到結束 → 回到開始（給一點點餘裕，避免剛好停在結束那一格又跳回去） */
export function loopSeekTarget(t: number, range: { start: number; end: number } | null): number | null {
  if (!range || !(range.end > range.start)) return null;
  if (t >= range.end - 0.02 || t < range.start - 0.25) return range.start;
  return null;
}

/** 使用者自己拉到區段外面 → 不再循環這一段 */
export function seekLeavesRange(t: number, range: { start: number; end: number } | null): boolean {
  if (!range) return false;
  return t < range.start - 0.3 || t > range.end + 0.3;
}

/** I / O 標的區段 → 要存的（倒過來標也可以；太短 = 不算區段） */
export function normalizeRange(a: number | null, b: number | null): { start: number; end: number } | null {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const start = Math.max(0, Math.min(a, b));
  const end = Math.max(a, b);
  if (end - start < 0.1) return null;
  return { start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 };
}
