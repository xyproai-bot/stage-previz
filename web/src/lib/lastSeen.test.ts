import { describe, expect, it } from 'vitest';
import { formatLastLogin } from './lastSeen';

describe('上次登入', () => {
  const now = Date.UTC(2026, 9, 22, 6, 0, 0);
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it('從未登入 / 剛才 / 幾分鐘 / 幾小時 / 幾天前', () => {
    expect(formatLastLogin(null, now)).toBe('從未登入');
    expect(formatLastLogin('', now)).toBe('從未登入');
    expect(formatLastLogin(ago(20_000), now)).toBe('剛才');
    expect(formatLastLogin(ago(5 * 60_000), now)).toBe('5 分鐘前');
    expect(formatLastLogin(ago(3 * 3600_000), now)).toBe('3 小時前');
    expect(formatLastLogin(ago(2 * 86400_000), now)).toBe('2 天前');
  });
  it('超過一週顯示日期；後台的時間格式（中間是空白）也讀得懂', () => {
    expect(formatLastLogin(ago(30 * 86400_000), now)).toMatch(/2026/);
    expect(formatLastLogin('2026-10-22 05:55:00', now)).toBe('5 分鐘前');
  });
});
