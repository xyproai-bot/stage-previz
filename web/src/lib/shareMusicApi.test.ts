import { afterEach, describe, expect, it, vi } from 'vitest';
import { getShareSongMusic } from './shareMusicApi';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const music = { id: 'sm_1', filename: 'S01 開場.mp3', mime: 'audio/mpeg', sizeBytes: 100, durationSec: 215.5, streamUrl: '/api/share/tk/song-music/sm_1/stream?play=x.y' };

function stubFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }));
  return calls;
}

describe('getShareSongMusic：分享連結的訪客拿這首歌的音樂（含播放網址）', () => {
  it('舊式網址 /api/share/<連結碼>，沒密碼的連結不帶通行證，也不帶登入（不是成員）', async () => {
    const calls = stubFetch(200, { music });
    expect(await getShareSongMusic({ kind: 'token', key: 'tk' }, 's1')).toEqual(music);
    expect(calls[0].url).toBe('https://proxy.haimiaan.com/api/share/tk/songs/s1/music');
    expect(calls[0].init.headers).toEqual({});
    expect(JSON.stringify(calls[0].init)).not.toMatch(/Authorization|credentials/i);
  });

  it('好讀網址 /api/s/<名稱>；有密碼的連結帶通行證 header（不放網址上）；歌 id 會編碼', async () => {
    const calls = stubFetch(200, { music });
    await getShareSongMusic({ kind: 'slug', key: 'jinma-wm' }, 's 1/2', 'acc.sig');
    expect(calls[0].url).toBe('https://proxy.haimiaan.com/api/s/jinma-wm/songs/s%201%2F2/music');
    expect(calls[0].init.headers).toEqual({ 'x-share-access': 'acc.sig' });
    expect(calls[0].url).not.toContain('acc.sig');
  });

  it('沒有音樂 → null；資料不對（缺網址）→ null', async () => {
    stubFetch(200, { music: null });
    expect(await getShareSongMusic({ kind: 'token', key: 'tk' }, 's1')).toBeNull();
    stubFetch(200, {});
    expect(await getShareSongMusic({ kind: 'token', key: 'tk' }, 's1')).toBeNull();
    stubFetch(200, { music: { id: 'sm_1', filename: 'x' } });
    expect(await getShareSongMusic({ kind: 'token', key: 'tk' }, 's1')).toBeNull();
  });

  it('通行證過期 401 → 丟出來（status 401，分享頁拿去換新的）；不在分享範圍 403、過期 410 也丟', async () => {
    for (const status of [401, 403, 404, 410]) {
      stubFetch(status, { error: 'x', requiresPassword: status === 401 });
      const e = await getShareSongMusic({ kind: 'token', key: 'tk' }, 's1').then(() => null, (err: unknown) => err as { status: number; requiresPassword: boolean });
      expect(e?.status).toBe(status);
      expect(e?.requiresPassword).toBe(status === 401);
    }
  });
});
