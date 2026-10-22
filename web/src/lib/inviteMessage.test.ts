import { describe, it, expect } from 'vitest';
import {
  buildInviteMessage, buildLoginCodeMessage, formatLoginCodeForDisplay, inviteExpiryText, inviteUsesText,
  inviteValidityText, loginCodeDisplay, INVITE_ROLE_OPTIONS, INVITE_ROLE_CHOICES, INVITE_ADMIN_MAX_DAYS,
  inviteDayChoices, inviteMustBeSingleUse, clampInviteDays,
} from './inviteMessage';
import { inviteUrl, loginPageUrl } from './siteUrl';

describe('邀請連結的訊息', () => {
  it('跟範例一樣：名字、專案名、連結、有效期限', () => {
    expect(buildInviteMessage({
      personName: '王小明', projectName: '金馬 2026', url: 'https://previz.haimiaan.com/invite/abc', days: 7, maxUses: 1,
    })).toBe('王小明你好，這是「金馬 2026」的 Stage Previz 連結，點開就能進去看：https://previz.haimiaan.com/invite/abc（7 天內有效，只能用一次）');
  });
  it('可以用好幾次、天數不一樣', () => {
    expect(inviteValidityText(3, 10)).toBe('3 天內有效，最多可以用 10 次');
    expect(inviteValidityText(1, 1)).toBe('1 天內有效，只能用一次');
    expect(buildInviteMessage({ personName: 'Ann', projectName: 'Tour', url: 'u', days: 14, maxUses: 10 }))
      .toContain('（14 天內有效，最多可以用 10 次）');
  });
  it('名字 / 專案名空的也不會怪', () => {
    expect(buildInviteMessage({ personName: '  ', projectName: '', url: 'u', days: 7, maxUses: 1 }))
      .toBe('你好，這是「專案」的 Stage Previz 連結，點開就能進去看：u（7 天內有效，只能用一次）');
  });
  it('連結後面接全形括號：LINE / 微信會把網址跟括號分開', () => {
    const msg = buildInviteMessage({ personName: 'A', projectName: 'B', url: 'https://x/invite/t', days: 7, maxUses: 1 });
    expect(msg).toContain('https://x/invite/t（');
  });
});

describe('登入碼的訊息', () => {
  it('名字、登入碼、登入頁', () => {
    expect(buildLoginCodeMessage({ name: '王小明', code: 'K7MNP3XQ2R', loginUrl: 'https://previz.haimiaan.com/login' }))
      .toBe('王小明你好，這是你的 Stage Previz 登入碼：K7MNP3XQ2R，打開 https://previz.haimiaan.com/login 輸入就能登入。登入碼請不要給別人。');
  });
  it('顯示時每 5 個字空一格；舊的自訂號碼照原樣', () => {
    expect(formatLoginCodeForDisplay('K7MNP3XQ2R')).toBe('K7MNP 3XQ2R');
    expect(formatLoginCodeForDisplay('ABCD2345')).toBe('ABCD2 345');
    expect(formatLoginCodeForDisplay('PHANG-001')).toBe('PHANG-001');
    expect(formatLoginCodeForDisplay('ABC')).toBe('ABC');
  });
});

describe('用戶清單上的登入碼', () => {
  it('後台還回明文 → 照以前顯示', () => {
    expect(loginCodeDisplay({ accessCode: 'ABCDEFGHJK', hasAccessCode: true })).toEqual({ kind: 'plain', code: 'ABCDEFGHJK' });
    // 舊版後台沒有 hasAccessCode
    expect(loginCodeDisplay({ accessCode: 'ABCDEFGHJK' })).toEqual({ kind: 'plain', code: 'ABCDEFGHJK' });
  });
  it('雜湊存法 → 只說只在建立時顯示', () => {
    expect(loginCodeDisplay({ accessCode: null, hasAccessCode: true })).toEqual({ kind: 'hidden' });
  });
  it('沒有登入碼（邀請連結進來的）', () => {
    expect(loginCodeDisplay({ accessCode: null, hasAccessCode: false })).toEqual({ kind: 'none' });
    expect(loginCodeDisplay({ accessCode: null })).toEqual({ kind: 'none' });
    expect(loginCodeDisplay({ accessCode: '' })).toEqual({ kind: 'none' });
  });
});

describe('邀請清單', () => {
  const now = Date.UTC(2026, 9, 14, 0, 0, 0);
  it('還有幾天 / 小時 / 過期', () => {
    expect(inviteExpiryText(new Date(now + 7 * 86400_000).toISOString(), now)).toBe('還有 7 天');
    expect(inviteExpiryText(new Date(now + 6.2 * 86400_000).toISOString(), now)).toBe('還有 7 天');
    expect(inviteExpiryText(new Date(now + 5 * 3600_000).toISOString(), now)).toBe('還有 5 小時');
    expect(inviteExpiryText(new Date(now - 1).toISOString(), now)).toBe('已過期');
    expect(inviteExpiryText(null, now)).toBe('');
  });
  it('使用次數', () => {
    expect(inviteUsesText(0, 1)).toBe('還沒用');
    expect(inviteUsesText(1, 1)).toBe('已經用過');
    expect(inviteUsesText(0, 10)).toBe('還沒用（最多 10 次）');
    expect(inviteUsesText(2, 10)).toBe('用了 2 次，還剩 8 次');
  });
  it('舊的兩個選項照舊：導演、動畫師（用畫面上的名稱）', () => {
    expect(INVITE_ROLE_OPTIONS.map(o => o.label)).toEqual(['導演', '動畫師']);
  });
  it('邀請可以選製作、導演、動畫師；製作只限這個專案', () => {
    expect(INVITE_ROLE_CHOICES.map(o => o.label)).toEqual(['製作', '導演', '動畫師']);
    expect(INVITE_ROLE_CHOICES[0].role).toBe('admin');
    expect(INVITE_ROLE_CHOICES[0].hint).toContain('只限這個專案');
  });
  it('製作的邀請：最長 7 天、一律只能用一次；導演 / 動畫師照舊', () => {
    expect(inviteDayChoices('admin')).toEqual([1, 3, 7]);
    expect(inviteDayChoices('director')).toEqual([1, 3, 7, 14, 30]);
    expect(inviteMustBeSingleUse('admin')).toBe(true);
    expect(inviteMustBeSingleUse('animator')).toBe(false);
    expect(clampInviteDays('admin', 30)).toBe(7);
    expect(clampInviteDays('admin', 3)).toBe(3);
    expect(clampInviteDays('director', 30)).toBe(30);
    expect(INVITE_ADMIN_MAX_DAYS).toBe(7);
  });
});

describe('邀請連結 / 登入頁網址', () => {
  it('正式站 → 新網域；測試站 → 測試站', () => {
    expect(inviteUrl('tok_123', 'https://stage-previz.vercel.app')).toBe('https://previz.haimiaan.com/invite/tok_123');
    expect(inviteUrl('tok_123', 'https://test.previz.haimiaan.com')).toBe('https://test.previz.haimiaan.com/invite/tok_123');
    expect(inviteUrl('tok_123', 'http://localhost:5173')).toBe('http://localhost:5173/invite/tok_123');
    expect(loginPageUrl('https://previz.haimiaan.com')).toBe('https://previz.haimiaan.com/login');
    expect(loginPageUrl('https://test.previz.haimiaan.com')).toBe('https://test.previz.haimiaan.com/login');
  });
});
