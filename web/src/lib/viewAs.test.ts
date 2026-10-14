import { describe, expect, it, vi } from 'vitest';
import {
  VIEW_AS_BLOCKED_MESSAGE, blockedWriteError, defaultAnimatorId, editorPath, installWriteGuard, isBlockedWrite,
  parseViewAs, pickClientShareLink, viewAsBannerShortText, viewAsBannerText, viewAsIdentity, viewAsPath, viewAsProjectRole,
} from './viewAs';
import { parseServerTime } from './serverTime';

describe('parseViewAs：只有製作的 ?as= 才算數', () => {
  it('製作 + ?as=director → 導演預覽，只能看', () => {
    expect(parseViewAs('?as=director', 'admin')).toEqual({ previewRole: 'director', previewUserId: null, readOnly: true });
  });

  it('製作 + ?as=animator&user= → 看那個動畫師', () => {
    expect(parseViewAs('as=animator&user=u_ming', 'admin')).toEqual({ previewRole: 'animator', previewUserId: 'u_ming', readOnly: true });
  });

  it('?as=animator 沒有 user → 還沒指派歌的動畫師', () => {
    expect(parseViewAs(new URLSearchParams({ as: 'animator' }), 'admin')).toEqual({ previewRole: 'animator', previewUserId: null, readOnly: true });
  });

  it('不是製作（動畫師、導演、沒登入）加 ?as= 一律沒有作用', () => {
    expect(parseViewAs('?as=director', 'animator')).toBeNull();
    expect(parseViewAs('?as=animator&user=u_x', 'director')).toBeNull();
    expect(parseViewAs('?as=director', null)).toBeNull();
    expect(parseViewAs('?as=director', undefined)).toBeNull();
  });

  it('看不懂的 ?as= / 沒有 ?as= → 照平常', () => {
    expect(parseViewAs('', 'admin')).toBeNull();
    expect(parseViewAs('?as=admin', 'admin')).toBeNull();
    expect(parseViewAs('?as=client', 'admin')).toBeNull();
    expect(parseViewAs('?as=Director', 'admin')).toBeNull();
  });

  it('導演不看 user；怪的 user 當沒給', () => {
    expect(parseViewAs('?as=director&user=u_ming', 'admin')?.previewUserId).toBeNull();
    expect(parseViewAs('?as=animator&user=' + encodeURIComponent('<script>'), 'admin')?.previewUserId).toBeNull();
    expect(parseViewAs('?as=animator&user=' + 'a'.repeat(65), 'admin')?.previewUserId).toBeNull();
    expect(parseViewAs('?as=animator&user=', 'admin')?.previewUserId).toBeNull();
  });

  it('其他參數（通知點進來的 song / video / comment）不影響', () => {
    expect(parseViewAs('?song=s1&as=director&comment=c1', 'admin')?.previewRole).toBe('director');
  });
});

describe('網址', () => {
  it('導演 → 導演頁；動畫師 → 工作站', () => {
    expect(viewAsPath('p1', 'director')).toBe('/preview/p1?as=director');
    expect(viewAsPath('p1', 'animator')).toBe('/studio/p1?as=animator');
    expect(viewAsPath('p1', 'animator', 'u_ming')).toBe('/studio/p1?as=animator&user=u_ming');
  });

  it('導演不帶 user；專案代號會跳脫', () => {
    expect(viewAsPath('p1', 'director', 'u_ming')).toBe('/preview/p1?as=director');
    expect(viewAsPath('p 1/x', 'director')).toBe('/preview/p%201%2Fx?as=director');
  });

  it('網址組出來再讀回去是同一個', () => {
    const url = new URL(viewAsPath('p1', 'animator', 'u_ming'), 'https://x');
    expect(parseViewAs(url.search, 'admin')).toEqual({ previewRole: 'animator', previewUserId: 'u_ming', readOnly: true });
  });

  it('回到編輯', () => {
    expect(editorPath('p1')).toBe('/admin/projects/p1');
  });
});

describe('預覽時的「我」', () => {
  const admin = { id: 'u_admin', name: '製作阿明', role: 'admin', avatarColor: '#111' };

  it('導演預覽：角色換成導演，還是自己的 id / 名字', () => {
    const me = viewAsIdentity(admin, { previewRole: 'director', previewUserId: null, readOnly: true });
    expect(me).toEqual({ ...admin, role: 'director' });
  });

  it('看某個動畫師：換成那個人', () => {
    const me = viewAsIdentity(admin, { previewRole: 'animator', previewUserId: 'u_ming', readOnly: true }, { id: 'u_ming', name: '小明', avatarColor: '#222' });
    expect(me).toEqual({ id: 'u_ming', name: '小明', role: 'animator', avatarColor: '#222' });
  });

  it('專案角色：預覽時換成預覽的角色；平常照舊', () => {
    expect(viewAsProjectRole({ previewRole: 'director', previewUserId: null, readOnly: true }, 'admin')).toBe('director');
    expect(viewAsProjectRole(null, 'admin')).toBe('admin');
    expect(viewAsProjectRole(null, null)).toBeNull();
  });
});

describe('橫幅的字', () => {
  it('導演 / 動畫師「小明」/ 還沒指派歌的動畫師', () => {
    expect(viewAsBannerText('director')).toBe('預覽：導演看到的畫面（只能看，不會改到資料）');
    expect(viewAsBannerText('animator', '小明')).toBe('預覽：動畫師「小明」看到的畫面（只能看，不會改到資料）');
    expect(viewAsBannerText('animator')).toContain('還沒指派歌的動畫師');
    expect(viewAsBannerShortText('animator', '小明')).toBe('預覽：動畫師「小明」（只能看）');
  });
});

describe('換成動畫師時預設看誰', () => {
  const animators = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }];
  it('原本看的人還在 → 還是他', () => {
    expect(defaultAnimatorId(animators, [], 'a3')).toBe('a3');
  });
  it('有指派歌的第一個動畫師', () => {
    expect(defaultAnimatorId(animators, [{ animatorUserId: null }, { animatorUserId: 'a2' }], 'gone')).toBe('a2');
  });
  it('都沒指派 → 第一個；沒有動畫師 → null', () => {
    expect(defaultAnimatorId(animators)).toBe('a1');
    expect(defaultAnimatorId([])).toBeNull();
  });
});

describe('客戶畫面要開哪個分享連結', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const link = (token: string, createdAt: string, extra: Partial<{ songId: string | null; expiresAt: string | null }> = {}) => ({
    token, slug: null, songId: null, expiresAt: null, createdAt, ...extra,
  });

  it('沒有連結 → null', () => {
    expect(pickClientShareLink([], now, parseServerTime)).toBeNull();
  });

  it('還沒過期的裡面最新的（伺服器時間沒寫時區也對）', () => {
    const got = pickClientShareLink([
      link('old', '2026-10-01 08:00:00'),
      link('new', '2026-10-10 08:00:00'),
      link('mid', '2026-10-05 08:00:00'),
    ], now, parseServerTime);
    expect(got?.token).toBe('new');
  });

  it('過期的不算', () => {
    const got = pickClientShareLink([
      link('expired', '2026-10-12 08:00:00', { expiresAt: '2026-10-13 00:00:00' }),
      link('ok', '2026-10-01 08:00:00', { expiresAt: '2026-11-01 00:00:00' }),
    ], now, parseServerTime);
    expect(got?.token).toBe('ok');
    expect(pickClientShareLink([link('expired', '2026-10-12', { expiresAt: '2026-10-13' })], now, parseServerTime)).toBeNull();
  });

  it('整個專案的連結優先；沒有才用單首歌的', () => {
    const song = link('song', '2026-10-12 08:00:00', { songId: 's1' });
    const whole = link('whole', '2026-10-02 08:00:00');
    expect(pickClientShareLink([song, whole], now, parseServerTime)?.token).toBe('whole');
    expect(pickClientShareLink([song], now, parseServerTime)?.token).toBe('song');
  });
});

describe('只能看：擋下寫入的請求', () => {
  it('讀資料放行、寫入擋下、登出和錯誤回報放行', () => {
    expect(isBlockedWrite('GET', 'https://api/x')).toBe(false);
    expect(isBlockedWrite(undefined, 'https://api/x')).toBe(false);
    expect(isBlockedWrite('head', 'https://api/x')).toBe(false);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) expect(isBlockedWrite(m, 'https://api/api/projects/p1/songs/s1')).toBe(true);
    expect(isBlockedWrite('POST', 'https://proxy.example/api/auth/logout')).toBe(false);
    expect(isBlockedWrite('POST', '/api/auth/logout')).toBe(false);
    expect(isBlockedWrite('POST', '/api/auth/login')).toBe(true);
    expect(isBlockedWrite('POST', '/api/notifications/read')).toBe(true);
    expect(isBlockedWrite('POST', 'https://proxy.example/api/client-errors')).toBe(false);
    expect(isBlockedWrite('POST', 'https://proxy.example/api/client-errors-x')).toBe(true);
  });

  it('被擋下的錯誤：中文說明、status 0', () => {
    const e = blockedWriteError();
    expect(e.message).toBe(VIEW_AS_BLOCKED_MESSAGE);
    expect(e.status).toBe(0);
  });

  it('fetch：寫入的不會送出去，讀的照常；拿掉之後恢復', async () => {
    const realFetch = vi.fn(async () => new Response('{}'));
    const target = { fetch: realFetch as unknown as typeof fetch };
    const blocked: string[] = [];
    const remove = installWriteGuard(target, (m, u) => blocked.push(`${m} ${u}`));

    await expect(target.fetch('https://api/api/projects/p1/songs/s1', { method: 'PATCH', body: '{}' })).rejects.toThrow(VIEW_AS_BLOCKED_MESSAGE);
    await expect(target.fetch(new Request('https://api/api/comments', { method: 'POST', body: 'x' }))).rejects.toThrow(VIEW_AS_BLOCKED_MESSAGE);
    expect(realFetch).not.toHaveBeenCalled();
    expect(blocked).toEqual(['PATCH https://api/api/projects/p1/songs/s1', 'POST https://api/api/comments']);

    await target.fetch('https://api/api/projects/p1/songs');
    await target.fetch('https://api/api/auth/logout', { method: 'POST' });
    expect(realFetch).toHaveBeenCalledTimes(2);

    remove();
    expect(target.fetch).toBe(realFetch);
  });

  it('XMLHttpRequest（分段上傳影片用的）：寫入的 send 會丟錯誤，不會送出去', () => {
    const sent: string[] = [];
    class FakeXhr {
      method = ''; url = '';
      open(method: string, url: string) { this.method = method; this.url = url; }
      send() { sent.push(`${this.method} ${this.url}`); }
    }
    const target = { XMLHttpRequest: FakeXhr as unknown as { prototype: XMLHttpRequest } };
    const origSend = FakeXhr.prototype.send;
    const remove = installWriteGuard(target);

    const put = new FakeXhr();
    put.open('PUT', 'https://api/api/projects/p1/songs/s1/videos/v1/parts/1');
    expect(() => put.send()).toThrow(VIEW_AS_BLOCKED_MESSAGE);

    const get = new FakeXhr();
    get.open('GET', 'https://api/api/x');
    get.send();
    expect(sent).toEqual(['GET https://api/api/x']);

    remove();
    expect(FakeXhr.prototype.send).toBe(origSend);
    const later = new FakeXhr();
    later.open('PUT', 'https://api/y');
    later.send();
    expect(sent).toEqual(['GET https://api/api/x', 'PUT https://api/y']);
  });
});
