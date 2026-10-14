import { describe, expect, it } from 'vitest';
import { adjacentCommentTime, loopSeekTarget, normalizeRange, playheadCommentId, seekLeavesRange } from './playhead';

const items = [
  { id: 'a', time: 5 },
  { id: 'b', time: 12, timeEnd: 18 },
  { id: 'c', time: 14, timeEnd: 16 },
  { id: 'd', time: 30 },
  { id: 'none', time: 0 },          // 沒綁時間：不算
];

describe('留言跟著播放：離播放頭最近的那則', () => {
  it('在區段裡 → 那一段；好幾段都包住 → 開始最晚的', () => {
    expect(playheadCommentId(items, 13)).toBe('b');
    expect(playheadCommentId(items, 15)).toBe('c');
    expect(playheadCommentId(items, 17)).toBe('b');
  });
  it('不在區段裡 → 最近的（區段算最近的那一邊）', () => {
    expect(playheadCommentId(items, 4)).toBe('a');
    expect(playheadCommentId(items, 8)).toBe('a');
    expect(playheadCommentId(items, 9)).toBe('b');      // 離 b 的開始 3 秒，離 a 4 秒
    expect(playheadCommentId(items, 20)).toBe('b');     // 離 b 的結束 2 秒
    expect(playheadCommentId(items, 25)).toBe('d');
  });
  it('一樣近 → 播放頭前面的那則', () => {
    expect(playheadCommentId([{ id: 'x', time: 10 }, { id: 'y', time: 20 }], 15)).toBe('x');
  });
  it('沒有綁時間的留言不會被標；沒有留言 = null', () => {
    expect(playheadCommentId([{ id: 'none', time: 0 }], 3)).toBeNull();
    expect(playheadCommentId([], 3)).toBeNull();
    expect(playheadCommentId(items, NaN)).toBeNull();
  });
  it('上一則 / 下一則的時間', () => {
    expect(adjacentCommentTime(items, 12, 1)).toBe(14);
    expect(adjacentCommentTime(items, 12, -1)).toBe(5);
    expect(adjacentCommentTime(items, 40, 1)).toBeNull();
  });
});

describe('區段循環、I / O', () => {
  const r = { start: 12, end: 18 };
  it('播到結束 → 回到開始；在中間不動', () => {
    expect(loopSeekTarget(18, r)).toBe(12);
    expect(loopSeekTarget(17.99, r)).toBe(12);
    expect(loopSeekTarget(15, r)).toBeNull();
    expect(loopSeekTarget(15, null)).toBeNull();
  });
  it('自己拉到區段外面 → 不再循環', () => {
    expect(seekLeavesRange(5, r)).toBe(true);
    expect(seekLeavesRange(30, r)).toBe(true);
    expect(seekLeavesRange(12, r)).toBe(false);
    expect(seekLeavesRange(18.1, r)).toBe(false);
  });
  it('倒過來標也可以；太短不算區段', () => {
    expect(normalizeRange(18, 12)).toEqual({ start: 12, end: 18 });
    expect(normalizeRange(12, 12.05)).toBeNull();
    expect(normalizeRange(null, 3)).toBeNull();
    expect(normalizeRange(-2, 3)).toEqual({ start: 0, end: 3 });
  });
});
