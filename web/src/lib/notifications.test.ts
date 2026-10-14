import { describe, expect, it } from 'vitest';
import type { AppNotification } from './reviewApi';
import {
  notificationTitle, notificationDetail, notificationHref, parseDeepLink, badgeText, groupNotifications, sameNotifications, songPageHref,
} from './notifications';

function n(p: Partial<AppNotification> = {}): AppNotification {
  return {
    id: 'n1', kind: 'mention', projectId: 'p1', projectName: '金馬', projectRole: 'animator',
    songId: 's1', songName: '開場', songCode: 'S01', videoId: 'sv2', version: 2, versionLabel: 'V2',
    commentId: 'c9', actorName: '王小明', excerpt: '第二段太亮', createdAt: '2026-10-14T07:00:00.000Z', read: false, ...p,
  };
}

describe('通知文字', () => {
  it('每一種事都有一句白話', () => {
    expect(notificationTitle(n())).toBe('王小明 在「S01 開場」提到你');
    expect(notificationTitle(n({ kind: 'reply' }))).toBe('王小明 回覆了你在「S01 開場」的留言');
    expect(notificationTitle(n({ kind: 'needs_changes' }))).toBe('「S01 開場」 V2 需修改（王小明）');
    expect(notificationTitle(n({ kind: 'approved', versionLabel: 'V3' }))).toBe('「S01 開場」 V3 已通過（王小明）');
    expect(notificationTitle(n({ kind: 'new_version', actorName: '阿凱' }))).toBe('「S01 開場」有新版 V2 等你審（阿凱 交的）');
    expect(notificationTitle(n({ kind: 'assigned', actorName: '小花', songCode: null }))).toBe('小花 把「開場」指派給你');
    expect(notificationTitle(n({ kind: 'director_video', actorName: '王導', versionLabel: 'V3', songCode: null, songName: '夜曲' }))).toBe('導演 王導 貼了一版影片 V3 到「夜曲」');
    expect(notificationDetail(n({ kind: 'needs_changes' }))).toBe('原因：第二段太亮');
    expect(notificationDetail(n({ excerpt: '' }))).toBe('');
  });
});

describe('點了去哪裡', () => {
  it('動畫師 → 工作站；導演 / 製作 → 導演頁；帶上歌、版本、留言', () => {
    expect(notificationHref(n())).toBe('/studio/p1?song=s1&video=sv2&comment=c9');
    expect(notificationHref(n({ projectRole: 'director', videoId: null, commentId: null }))).toBe('/preview/p1?song=s1');
    expect(notificationHref(n({ projectRole: 'admin', songId: null, videoId: null, commentId: null }))).toBe('/preview/p1');
  });
  it('網址讀回來；沒有歌、亂寫的 id → 不算', () => {
    expect(parseDeepLink('?song=s1&video=sv2&comment=c9')).toEqual({ songId: 's1', videoId: 'sv2', commentId: 'c9' });
    expect(parseDeepLink('?song=s1&comment=../x')).toEqual({ songId: 's1', videoId: null, commentId: null });
    expect(parseDeepLink('?video=sv2')).toBeNull();
    expect(parseDeepLink(new URLSearchParams('song=s1'))).toEqual({ songId: 's1', videoId: null, commentId: null });
  });
  it('編輯頁「到導演頁播放」：導演頁打開那首歌、那一版，讀回來是同一首、同一版', () => {
    const href = songPageHref('preview', 'p 1', { songId: 's1', videoId: 'sv3' });
    expect(href).toBe('/preview/p%201?song=s1&video=sv3');
    expect(parseDeepLink(href.slice(href.indexOf('?')))).toEqual({ songId: 's1', videoId: 'sv3', commentId: null });
    expect(songPageHref('studio', 'p1', {})).toBe('/studio/p1');
  });
});

describe('數字 / 分組', () => {
  it('鈴鐺數字', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(3)).toBe('3');
    expect(badgeText(150)).toBe('99+');
  });
  it('今天 / 昨天 / 更早，最新的在前；空的組不出現', () => {
    const now = Date.parse('2026-10-14T10:00:00.000Z');
    const g = groupNotifications([
      n({ id: 'old', createdAt: '2026-10-01T10:00:00.000Z' }),
      n({ id: 't1', createdAt: '2026-10-14T03:00:00.000Z' }),
      n({ id: 'y', createdAt: '2026-10-13T09:00:00.000Z' }),
      n({ id: 't2', createdAt: '2026-10-14T09:00:00.000Z' }),
    ], now, 'Asia/Taipei');
    expect(g.map(x => [x.label, x.items.map(i => i.id)])).toEqual([
      ['今天', ['t2', 't1']], ['昨天', ['y']], ['更早', ['old']],
    ]);
    expect(groupNotifications([n({ createdAt: '2026-10-14T03:00:00.000Z' })], now, 'Asia/Taipei').map(x => x.label)).toEqual(['今天']);
  });
  it('一樣的清單不換', () => {
    const a = [n()];
    expect(sameNotifications(a, [n()])).toBe(true);
    expect(sameNotifications(a, [n({ read: true })])).toBe(false);
  });
});
