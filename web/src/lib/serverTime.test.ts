import { describe, it, expect } from 'vitest';
import { formatDate, formatDateTime, formatRelativeTime, parseServerTime, serverDate } from './serverTime';

const UTC_1021 = Date.UTC(2026, 9, 13, 10, 21, 30); // 2026-10-13 10:21:30 UTC = 台灣 18:21:30

describe('parseServerTime', () => {
  it('SQLite datetime 沒寫時區 → 當 UTC（不是本地時間）', () => {
    expect(parseServerTime('2026-10-13 10:21:30')).toBe(UTC_1021);
    expect(parseServerTime('2026-10-13T10:21:30')).toBe(UTC_1021);
    expect(parseServerTime('  2026-10-13 10:21:30  ')).toBe(UTC_1021);
  });
  it('有小數秒也讀得懂', () => {
    expect(parseServerTime('2026-10-13 10:21:30.250')).toBe(UTC_1021 + 250);
  });
  it('有 Z → 照 UTC 讀', () => {
    expect(parseServerTime('2026-10-13T10:21:30Z')).toBe(UTC_1021);
    expect(parseServerTime('2026-10-13T10:21:30.000Z')).toBe(UTC_1021);
    expect(parseServerTime('2026-10-13 10:21:30Z')).toBe(UTC_1021);
  });
  it('有時差 → 照寫的時差讀（不再加 Z）', () => {
    expect(parseServerTime('2026-10-13T18:21:30+08:00')).toBe(UTC_1021);
    expect(parseServerTime('2026-10-13T18:21:30+0800')).toBe(UTC_1021);
    expect(parseServerTime('2026-10-13T05:21:30-05:00')).toBe(UTC_1021);
  });
  it('只有日期 → 那天 UTC 0 點', () => {
    expect(parseServerTime('2026-10-13')).toBe(Date.UTC(2026, 9, 13));
  });
  it('數字當成毫秒', () => {
    expect(parseServerTime(UTC_1021)).toBe(UTC_1021);
  });
  it('空的 / 讀不懂 → NaN', () => {
    expect(parseServerTime('')).toBeNaN();
    expect(parseServerTime(null)).toBeNaN();
    expect(parseServerTime(undefined)).toBeNaN();
    expect(parseServerTime('不是時間')).toBeNaN();
    expect(parseServerTime(Number.NaN)).toBeNaN();
  });
  it('serverDate：讀不懂回 null', () => {
    expect(serverDate('2026-10-13 10:21:30')?.getTime()).toBe(UTC_1021);
    expect(serverDate('亂打')).toBeNull();
  });
});

describe('formatRelativeTime', () => {
  const now = UTC_1021;
  it('剛改的東西（UTC 字串）顯示「剛剛」，不是「8 小時前」', () => {
    expect(formatRelativeTime('2026-10-13 10:21:00', { now })).toBe('剛剛');
  });
  it('分鐘 / 小時 / 天', () => {
    expect(formatRelativeTime('2026-10-13 10:16:30', { now })).toBe('5 分鐘前');
    expect(formatRelativeTime('2026-10-13 07:21:30', { now })).toBe('3 小時前');
    expect(formatRelativeTime('2026-10-11 10:21:30', { now })).toBe('2 天前');
  });
  it('有時區的字串照樣算對', () => {
    expect(formatRelativeTime('2026-10-13T17:21:30+08:00', { now })).toBe('1 小時前');
    expect(formatRelativeTime('2026-10-13T09:21:30Z', { now })).toBe('1 小時前');
  });
  it('超過 7 天寫日期；不是今年加年份', () => {
    expect(formatRelativeTime('2026-10-01 10:00:00', { now, timeZone: 'Asia/Taipei' })).toBe('10/1');
    expect(formatRelativeTime('2025-12-25 10:00:00', { now, timeZone: 'Asia/Taipei' })).toBe('2025/12/25');
  });
  it('未來的時間（時鐘不準）→ 剛剛', () => {
    expect(formatRelativeTime('2026-10-13 10:30:00', { now })).toBe('剛剛');
  });
  it('讀不懂原樣回傳；空的回空字串', () => {
    expect(formatRelativeTime('亂打', { now })).toBe('亂打');
    expect(formatRelativeTime(null, { now })).toBe('');
  });
});

describe('formatDateTime / formatDate', () => {
  it('UTC 字串在台灣顯示 +8 小時', () => {
    expect(formatDateTime('2026-10-13 10:21:30', { timeZone: 'Asia/Taipei' })).toBe('2026/10/13 18:21');
    expect(formatDate('2026-10-13 20:00:00', { timeZone: 'Asia/Taipei' })).toBe('2026/10/14');
  });
  it('有時區的字串照寫的讀', () => {
    expect(formatDateTime('2026-10-13T18:21:30+08:00', { timeZone: 'Asia/Taipei' })).toBe('2026/10/13 18:21');
    expect(formatDateTime('2026-10-13T10:21:30Z', { timeZone: 'UTC' })).toBe('2026/10/13 10:21');
  });
  it('24 小時制：半夜是 00 不是 24', () => {
    expect(formatDateTime('2026-10-13 16:05:00', { timeZone: 'Asia/Taipei' })).toBe('2026/10/14 00:05');
  });
  it('讀不懂原樣回傳', () => {
    expect(formatDateTime('亂打')).toBe('亂打');
    expect(formatDate(undefined)).toBe('');
  });
});
