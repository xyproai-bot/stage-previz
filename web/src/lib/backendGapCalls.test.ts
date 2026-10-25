// 「後台早就能做、畫面以前沒有入口」補上的入口：用到的後台呼叫、畫面用的小判斷（docs/backend-ui-gaps.md）
//   專案狀態（進行中 ⇄ 審查中）、用戶頭像顏色、最近活動多看幾筆、全部備份清單
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './api';
import { ACTIVITY_FIRST, ACTIVITY_MAX, atActivityLimit, canLoadEarlierActivity } from './activityPaging';
import { AVATAR_COLORS, DEFAULT_AVATAR_COLOR, avatarColorName, sameAvatarColor } from './avatarColors';
import { reviewToggle } from './projectStatus';
import { describeBackup, listBackups } from './systemStatusApi';

function mockFetch(status: number, body: unknown) {
  const f = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', f);
  return f;
}
const lastCall = (f: ReturnType<typeof mockFetch>) => {
  const [url, init] = f.mock.calls[f.mock.calls.length - 1] as unknown as [string, RequestInit | undefined];
  return { url: url.replace(/^https?:\/\/[^/]+/, ''), method: (init?.method || 'GET').toUpperCase(), body: init?.body ? JSON.parse(init.body as string) : undefined };
};

const store = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
beforeEach(() => {
  vi.stubGlobal('window', { localStorage: store, setTimeout, clearTimeout, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });
  vi.stubGlobal('localStorage', store);
});
afterEach(() => vi.unstubAllGlobals());

describe('專案狀態：進行中 ⇄ 審查中', () => {
  it('進行中 → 標成審查中；審查中 → 改回進行中；封存的沒有這個選項', () => {
    expect(reviewToggle('active')).toMatchObject({ next: 'in_review', menuLabel: '標成審查中' });
    expect(reviewToggle('in_review')).toMatchObject({ next: 'active', menuLabel: '改回進行中' });
    expect(reviewToggle('archived')).toBeNull();
  });

  it('通知的話有專案名字，說人話', () => {
    expect(reviewToggle('active')!.doneMessage('夏季巡迴')).toContain('「夏季巡迴」');
    expect(reviewToggle('in_review')!.doneMessage('夏季巡迴')).toBe('「夏季巡迴」改回進行中了');
  });

  it('按下去送的是 PATCH /api/projects/:id { status }', async () => {
    const f = mockFetch(200, { ok: true });
    await api.updateProject('p 1', { status: reviewToggle('active')!.next });
    expect(lastCall(f)).toMatchObject({ url: '/api/projects/p%201', method: 'PATCH', body: { status: 'in_review' } });
    await api.updateProject('p1', { status: reviewToggle('in_review')!.next });
    expect(lastCall(f).body).toEqual({ status: 'active' });
  });
});

describe('用戶頭像顏色', () => {
  it('清單有 6 個顏色、都有名字、預設是第一個', () => {
    expect(AVATAR_COLORS).toHaveLength(6);
    for (const c of AVATAR_COLORS) {
      expect(c.value).toMatch(/^#[0-9a-f]{6}$/);
      expect(c.name.length).toBeGreaterThan(0);
    }
    expect(new Set(AVATAR_COLORS.map(c => c.value)).size).toBe(6);
    expect(DEFAULT_AVATAR_COLOR).toBe(AVATAR_COLORS[0].value);
  });

  it('比顏色不分大小寫；不在清單裡的叫「自訂」', () => {
    expect(sameAvatarColor('#10C78A', '#10c78a')).toBe(true);
    expect(sameAvatarColor(' #10c78a ', '#10c78a')).toBe(true);
    expect(sameAvatarColor('#10c78a', '#ffaa44')).toBe(false);
    expect(sameAvatarColor(null, '#10c78a')).toBe(false);
    expect(avatarColorName('#5294ff')).toBe('藍');
    expect(avatarColorName('#123456')).toBe('自訂');
  });

  it('換顏色送的是 PATCH /api/users/:id { avatarColor }', async () => {
    const f = mockFetch(200, { ok: true });
    await api.updateUserAdmin('u_1', { avatarColor: '#c264ff' });
    expect(lastCall(f)).toMatchObject({ url: '/api/users/u_1', method: 'PATCH', body: { avatarColor: '#c264ff' } });
  });
});

describe('最近活動：看更早的', () => {
  it('一開始 50 筆；拿滿了才出現「看更早的」，讀過 200 筆就不再出現', () => {
    expect(ACTIVITY_FIRST).toBe(50);
    expect(ACTIVITY_MAX).toBe(200);
    expect(canLoadEarlierActivity(50, 50)).toBe(true);
    expect(canLoadEarlierActivity(12, 50)).toBe(false);   // 不到 50 筆 = 全部都在這裡了
    expect(canLoadEarlierActivity(200, 200)).toBe(false);
    expect(canLoadEarlierActivity(130, 200)).toBe(false);
  });

  it('讀滿 200 筆要告訴他「只列最近 200 筆」', () => {
    expect(atActivityLimit(200, 200)).toBe(true);
    expect(atActivityLimit(130, 200)).toBe(false);
    expect(atActivityLimit(50, 50)).toBe(false);
  });

  it('呼叫帶 limit，後台上限就是 200', async () => {
    const f = mockFetch(200, { activities: [] });
    await api.listActivity('p1', ACTIVITY_FIRST);
    expect(lastCall(f).url).toBe('/api/projects/p1/activity?limit=50');
    await api.listActivity('p1', ACTIVITY_MAX);
    expect(lastCall(f).url).toBe('/api/projects/p1/activity?limit=200');
  });
});

describe('全部備份清單', () => {
  const backups = [
    { day: '2026-10-26', file: '2026-10-26.sql.gz', size: 123456, createdAt: '2026-10-26T04:01:00.000Z', monthly: false },
    { day: '2026-10-01', file: '2026-10-01.sql.gz', size: 2 * 1024 * 1024, createdAt: '2026-10-01T04:01:00.000Z', monthly: true },
  ];

  it('GET /api/admin/backups，拿到清單（新的在前）', async () => {
    const f = mockFetch(200, { status: {}, backups });
    expect(await listBackups()).toEqual(backups);
    expect(lastCall(f)).toMatchObject({ url: '/api/admin/backups', method: 'GET' });
  });

  it('後台沒給清單 → 空的；不是製作 → 丟出中文錯誤', async () => {
    mockFetch(200, {});
    expect(await listBackups()).toEqual([]);
    mockFetch(403, { error: '只有製作可以看系統狀態' });
    await expect(listBackups()).rejects.toThrow('只有製作可以看系統狀態');
  });

  it('每一行：日期 · 大小，每月留存的另外標出來', () => {
    expect(describeBackup(backups[0])).toBe('2026-10-26 · 120.6 KB');
    expect(describeBackup(backups[1])).toBe('2026-10-01 · 2.0 MB · 每月留存');
  });
});
