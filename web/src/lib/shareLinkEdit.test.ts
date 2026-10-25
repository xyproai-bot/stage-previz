// 分享連結建好以後改密碼 / 有效期 / 分享的歌，和用戶自己改名字 / 頭像顏色：
// 畫面用的小判斷、送給後台的呼叫、畫面上入口還在（守門）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './api';
import { AVATAR_COLORS } from './avatarColors';
import {
  EDIT_EXPIRY_LABEL, EDIT_PASSWORD_LABEL, EDIT_SONGS_LABEL, NEVER_EXPIRES_LABEL, REMOVE_PASSWORD_LABEL, SAVED_TOAST, SCOPE_ALL, SHARE_PASSWORD_MAX,
  expiryChoices, expiryPatch, expiryText, passwordPatch, scopeChoices, scopePatch, scopeText,
} from './shareLinkEdit';
import { USER_NAME_MAX, cleanAvatarColor, cleanUserName, planMyProfileUpdate, userNameProblem } from './userProfileRules';

const sources = import.meta.glob([
  '../components/{ShareLinksDialog,AccountMenu,AdminLayout}.tsx',
  '../components/dialogs/DialogHost.tsx',
  '../pages/{Settings,Studio,Preview}.tsx',
  './MyProjectsPage.tsx',
], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
function src(name: string): string {
  const hit = Object.entries(sources).find(([k]) => k.endsWith('/' + name));
  if (!hit) throw new Error(`找不到 ${name}`);
  return hit[1];
}

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

const SONGS = [
  { id: 's1', name: '開場', code: 'S01' },
  { id: 's2', name: '安可', code: null },
];

describe('分享連結：改有效期', () => {
  it('選項是 1 / 7 / 30 / 90 天 + 不會過期；現在不會過期的標「目前」', () => {
    const c = expiryChoices(null);
    expect(c.map(x => x.label)).toEqual(['1 天', '7 天', '30 天', '90 天', NEVER_EXPIRES_LABEL]);
    expect(c.filter(x => x.current).map(x => x.label)).toEqual([NEVER_EXPIRES_LABEL]);
    expect(expiryChoices('2027-01-01T00:00:00.000Z').some(x => x.current)).toBe(false);
  });

  it('選到的值 → 送給後台的內容（天數從今天算起 / null = 不會過期）；不認得的不送', () => {
    for (const c of expiryChoices(null)) {
      const p = expiryPatch(c.value);
      expect(p).not.toBeNull();
    }
    expect(expiryPatch(expiryChoices(null)[1].value)).toEqual({ expiresInDays: 7 });
    expect(expiryPatch(expiryChoices(null)[4].value)).toEqual({ expiresInDays: null });
    expect(expiryPatch(null)).toBeNull();
    expect(expiryPatch('')).toBeNull();
    expect(expiryPatch('days:0')).toBeNull();
    expect(expiryPatch('days:abc')).toBeNull();
  });

  it('現在的有效期說人話：不會過期 / 到哪天為止 / 已過期', () => {
    const now = Date.parse('2026-10-26T00:00:00.000Z');
    expect(expiryText(null, now)).toBe('不會過期');
    expect(expiryText('2026-11-03T00:00:00.000Z', now)).toMatch(/^到 .+ 為止$/);
    expect(expiryText('2026-10-01T00:00:00.000Z', now)).toMatch(/^已過期（.+）$/);
  });
});

describe('分享連結：改分享的歌', () => {
  it('選項 = 整個專案 + 這個專案的每一首（有代號就帶代號）；目前的標「目前」', () => {
    const c = scopeChoices(SONGS, 's2');
    expect(c.map(x => x.label)).toEqual(['整個專案', 'S01 開場', '安可']);
    expect(c.filter(x => x.current).map(x => x.value)).toEqual(['s2']);
    expect(scopeChoices(SONGS, null).filter(x => x.current).map(x => x.value)).toEqual([SCOPE_ALL]);
    expect(scopeChoices([], null)).toHaveLength(1);
  });

  it('選到的範圍 → 送給後台的內容；不是這個專案的歌 / 亂給的不送（至少要選一個）', () => {
    expect(scopePatch(SCOPE_ALL, SONGS)).toEqual({ songId: null });
    expect(scopePatch('s1', SONGS)).toEqual({ songId: 's1' });
    expect(scopePatch('x9', SONGS)).toBeNull();
    expect(scopePatch('', SONGS)).toBeNull();
    expect(scopePatch(null, SONGS)).toBeNull();
  });

  it('現在分享的是什麼', () => {
    expect(scopeText(null, SONGS)).toBe('整個專案');
    expect(scopeText('s1', SONGS)).toBe('S01 開場');
    expect(scopeText('gone', SONGS)).toBe('單首歌');
  });
});

describe('分享連結：改密碼', () => {
  it('新密碼不能全是空白；太長切到後台的上限', () => {
    expect(passwordPatch('sesame')).toEqual({ password: 'sesame' });
    expect(passwordPatch('   ')).toBeNull();
    expect(passwordPatch('')).toBeNull();
    expect(passwordPatch(null)).toBeNull();
    expect(passwordPatch('x'.repeat(100))!.password).toHaveLength(SHARE_PASSWORD_MAX);
  });

  it('畫面文字', () => {
    expect([EDIT_PASSWORD_LABEL, REMOVE_PASSWORD_LABEL, EDIT_EXPIRY_LABEL, NEVER_EXPIRES_LABEL, EDIT_SONGS_LABEL, SAVED_TOAST])
      .toEqual(['改密碼', '拿掉密碼', '改有效期', '不會過期', '改分享的歌', '已更新']);
  });
});

describe('送給後台的呼叫', () => {
  it('改密碼 / 拿掉密碼 / 改有效期 / 換歌都是 PATCH share-links/:token', async () => {
    const f = mockFetch(200, { ok: true });
    await api.updateShareLink('p 1', 'tk1', { password: 'new-pass' });
    expect(lastCall(f)).toEqual({ url: '/api/projects/p%201/share-links/tk1', method: 'PATCH', body: { password: 'new-pass' } });
    await api.updateShareLink('p1', 'tk1', { password: null });
    expect(lastCall(f).body).toEqual({ password: null });
    await api.updateShareLink('p1', 'tk1', { expiresInDays: 30 });
    expect(lastCall(f).body).toEqual({ expiresInDays: 30 });
    await api.updateShareLink('p1', 'tk1', { expiresInDays: null });
    expect(lastCall(f).body).toEqual({ expiresInDays: null });
    await api.updateShareLink('p1', 'tk1', { songId: 's1' });
    expect(lastCall(f).body).toEqual({ songId: 's1' });
    await api.updateShareLink('p1', 'tk1', { songId: null });
    expect(lastCall(f).body).toEqual({ songId: null });
  });

  it('改自己：PATCH /api/auth/me，只送名字和頭像顏色，回來的是改好的我', async () => {
    const f = mockFetch(200, { ok: true, user: { id: 'u1', name: '凱凱', role: 'animator', avatarColor: '#5294ff' } });
    const me = await api.updateMyProfile({ name: '凱凱', avatarColor: '#5294ff' });
    expect(lastCall(f)).toEqual({ url: '/api/auth/me', method: 'PATCH', body: { name: '凱凱', avatarColor: '#5294ff' } });
    expect(me).toMatchObject({ id: 'u1', name: '凱凱', avatarColor: '#5294ff' });
  });
});

describe('用戶自己的名字和頭像顏色（前後台共用的規則）', () => {
  it('名字：前後空白去掉、最多 80 字、不能是空的', () => {
    expect(cleanUserName('  凱凱 ')).toBe('凱凱');
    expect(cleanUserName('字'.repeat(100))).toHaveLength(USER_NAME_MAX);
    expect(userNameProblem('   ')).toBe('名字不能是空的');
    expect(userNameProblem('凱凱')).toBeNull();
  });

  it('頭像顏色選項的 6 個顏色，後台都收', () => {
    for (const c of AVATAR_COLORS) expect(cleanAvatarColor(c.value)).toBe(c.value);
    expect(cleanAvatarColor('red')).toBeNull();
  });

  it('改自己只收名字和頭像顏色：偷塞的角色等欄位略過', () => {
    expect(planMyProfileUpdate({ name: 'A', role: 'admin' })).toEqual({ ok: true, name: 'A' });
    expect(planMyProfileUpdate({ role: 'admin' })).toMatchObject({ ok: false });
  });
});

describe('守門：畫面上的入口還在', () => {
  it('公開分享連結面板每一條連結有「改密碼」「拿掉密碼」「改有效期」「改分享的歌」，存好提示「已更新」', () => {
    const s = src('ShareLinksDialog.tsx');
    expect(s).toContain('{EDIT_PASSWORD_LABEL}');
    expect(s).toContain('{REMOVE_PASSWORD_LABEL}');
    expect(s).toContain('{EDIT_EXPIRY_LABEL}');
    expect(s).toContain('{EDIT_SONGS_LABEL}');
    expect(s).toContain('toast.success(SAVED_TOAST)');
    // 「拿掉密碼」只有設了密碼的連結才有
    expect(s).toMatch(/\{l\.hasPassword && \(\s*<button[\s\S]{0,160}removePassword\(l\)/);
    // 用站內對話框，不是瀏覽器的
    expect(s).toContain('chooseDialog(');
    expect(s).toContain('promptDialog(');
    expect(s).not.toMatch(/\b(window\.)?(prompt|confirm|alert)\(/);
  });

  it('選項比較多的「選一個」對話框是直排（選哪一首歌、選顏色）', () => {
    expect(src('ShareLinksDialog.tsx')).toContain("layout: 'list'");
    expect(src('DialogHost.tsx')).toContain('sp-dialog__choices');
  });

  it('設定頁「我的帳號」有「改名字」「換顏色」；專案首頁、導演頁、工作站、非製作的上方列頭像 + 名字是帳號選單', () => {
    expect(src('Settings.tsx')).toContain('RENAME_ME_LABEL');
    expect(src('Settings.tsx')).toContain('RECOLOR_ME_LABEL');
    expect(src('Settings.tsx')).not.toContain('請找製作');
    expect(src('MyProjectsPage.tsx')).toContain('<AccountMenu');
    expect(src('Studio.tsx')).toContain('<AccountMenu');
    expect(src('Preview.tsx')).toContain('<AccountMenu');
    expect(src('AdminLayout.tsx')).toContain('<AccountMenu');
    // 窄畫面的「⋯」選單也有
    expect(src('Studio.tsx')).toContain('account.itemsAfterSeparator');
    expect(src('Preview.tsx')).toContain('account.itemsAfterSeparator');
    expect(src('AdminLayout.tsx')).toContain('account.itemsAfterSeparator');
    // 製作的左側欄：點自己的名字到設定頁
    expect(src('AdminLayout.tsx')).toContain('to="/settings"');
  });

  it('帳號選單的顏色用跟用戶頁同一組（avatarColors.ts）', () => {
    const s = src('AccountMenu.tsx');
    expect(s).toContain("from '../lib/avatarColors'");
    expect(s).toContain('AVATAR_COLORS.map');
    expect(s).toContain('updateProfile(');
  });

  it('「用其他身分看」時，被看的人的名字不能在這裡改（改的會是製作自己的帳號）', () => {
    expect(src('Studio.tsx')).toMatch(/va\.active \? \(/);
    expect(src('Preview.tsx')).toMatch(/va\.active \? \(/);
  });
});
