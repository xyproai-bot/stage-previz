import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../test/hookRunner';
import { SHARE_MUSIC_TEXT, useShareSongMusic } from './useShareSongMusic';
import { musicPlayerKey } from './useSongMusic';
import type { ShareMusicSummary, ShareSongMusic } from './shareMusicApi';
import type { ShareRef } from './api';

vi.mock('./localVideo', () => ({ parkVideo: () => {} }));
const getShareSongMusic = vi.fn();
vi.mock('./shareMusicApi', () => ({ getShareSongMusic: (...a: unknown[]) => getShareSongMusic(...a) }));
// 成員的路不會被呼叫到：分享頁沒有登入，成員的網址和通行證跟分享的完全分開
const getSongMusic = vi.fn();
vi.mock('./musicApi', async (orig) => ({ ...(await orig<typeof import('./musicApi')>()), getSongMusic: (...a: unknown[]) => getSongMusic(...a) }));

class FakeVideo extends EventTarget {
  attrs = new Map<string, string>();
  srcSets = 0;
  currentTime = 0; duration = NaN; paused = true; loop = true; muted = false; playbackRate = 1; playsInline = false; preload = '';
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  get src() { return this.attrs.get('src') ?? ''; }
  set src(v: string) { this.srcSets++; this.attrs.set('src', v); }
  load() {}
  remove() {}
  play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); }
  pause() { if (this.paused) return; this.paused = true; this.dispatchEvent(new Event('pause')); }
}

const summary = (id: string, filename = `${id}.mp3`): ShareMusicSummary => ({ id, filename, mime: 'audio/mpeg', sizeBytes: 100, durationSec: 215 });
const full = (id: string, token = 'a'): ShareSongMusic => ({ ...summary(id), streamUrl: `/api/share/tk/song-music/${id}/stream?play=${token}` });
const flush = () => new Promise<void>(r => setTimeout(r, 0));
const BASE = 'https://proxy.haimiaan.com';
const REF: ShareRef = { kind: 'token', key: 'tk' };

type Props = {
  accessToken: string | null;
  song: { id: string; music?: ShareMusicSummary | null } | null;
  hasVideo: boolean;
  videosLoaded: boolean;
};
let video: FakeVideo;
let authErrors: unknown[];
beforeEach(() => {
  video = new FakeVideo();
  authErrors = [];
  vi.stubGlobal('document', { createElement: () => video });
  getShareSongMusic.mockReset();
  getShareSongMusic.mockImplementation(async () => full('sm_1'));
  getSongMusic.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });

const mount = (p: Props) => renderHook((props: Props) => useShareSongMusic({ shareRef: REF, onAuthError: (e) => authErrors.push(e), ...props }), p);
const base: Props = { accessToken: null, song: { id: 's1', music: summary('sm_1') }, hasVideo: false, videosLoaded: true };

describe('useShareSongMusic：分享頁一首歌的音樂（訪客只能聽）', () => {
  it('沒選歌 / 歌沒有音樂：不是音樂模式，不去拿網址', async () => {
    const a = mount({ ...base, song: null });
    expect(a.result.source).toBe('none');
    expect(a.result.summary).toBeNull();
    const b = mount({ ...base, song: { id: 's1', music: null } });
    expect(b.result.musicMode).toBe(false);
    const c = mount({ ...base, song: { id: 's1' } });          // 舊版後台沒有 music 欄位
    expect(c.result.musicMode).toBe(false);
    await flush();
    expect(getShareSongMusic).not.toHaveBeenCalled();
  });

  it('沒影片、有音樂：音樂模式，用分享的路去拿播放網址（沒有密碼就不帶通行證），放進播放器（key 是 m:<音樂 id>，不會自己播）；成員的路完全沒碰', async () => {
    const h = mount(base);
    expect(h.result.source).toBe('music');
    expect(h.result.musicMode).toBe(true);
    expect(h.result.summary?.filename).toBe('sm_1.mp3');
    await flush();
    expect(getShareSongMusic).toHaveBeenCalledTimes(1);
    expect(getShareSongMusic).toHaveBeenCalledWith(REF, 's1', undefined);
    expect(getSongMusic).not.toHaveBeenCalled();
    expect(h.result.music?.id).toBe('sm_1');
    expect(video.src).toBe(`${BASE}/api/share/tk/song-music/sm_1/stream?play=a`);
    expect(h.result.player.srcKey).toBe(musicPlayerKey('sm_1'));
    expect(h.result.player.fileName).toBe('sm_1.mp3');
    expect(video.paused).toBe(true);
    expect(h.result.error).toBeNull();
  });

  it('有密碼的連結：問網址時帶通行證', async () => {
    const h = mount({ ...base, accessToken: 'acc.sig' });
    await flush();
    expect(getShareSongMusic).toHaveBeenCalledWith(REF, 's1', 'acc.sig');
    expect(h.result.musicMode).toBe(true);
  });

  it('有影片：放影片，音樂不放（不去拿網址，播放器是空的）；音樂簡述還在', async () => {
    const h = mount({ ...base, hasVideo: true });
    expect(h.result.source).toBe('video');
    expect(h.result.musicMode).toBe(false);
    expect(h.result.summary?.id).toBe('sm_1');
    await flush();
    expect(getShareSongMusic).not.toHaveBeenCalled();
    expect(video.getAttribute('src')).toBeNull();
  });

  it('影片版本還沒讀完：先不放音樂；讀完發現沒影片才放', async () => {
    const h = mount({ ...base, videosLoaded: false });
    expect(h.result.musicMode).toBe(false);
    await flush();
    expect(getShareSongMusic).not.toHaveBeenCalled();
    h.rerender({ ...base, videosLoaded: true });
    await flush();
    expect(h.result.musicMode).toBe(true);
    expect(video.src).toContain('/song-music/sm_1/stream');
  });

  it('音樂在播的時候這首歌有影片了（例如拖進本地影片）：停下來、清掉；影片沒了就接回音樂', async () => {
    const h = mount(base);
    await flush();
    h.result.player.play();
    expect(video.paused).toBe(false);
    h.rerender({ ...base, hasVideo: true });
    expect(video.paused).toBe(true);
    expect(video.getAttribute('src')).toBeNull();
    expect(h.result.musicMode).toBe(false);
    h.rerender(base);
    await flush();
    expect(h.result.musicMode).toBe(true);
    expect(video.src).toContain('/song-music/sm_1/stream');
  });

  it('換歌：上一首的音樂清掉，新的一首去拿；新的一首沒有音樂就空著', async () => {
    const h = mount(base);
    await flush();
    getShareSongMusic.mockImplementation(async () => full('sm_9', 'n'));
    h.rerender({ ...base, song: { id: 's2', music: summary('sm_9') } });
    await flush();
    expect(getShareSongMusic).toHaveBeenLastCalledWith(REF, 's2', undefined);
    expect(video.src).toBe(`${BASE}/api/share/tk/song-music/sm_9/stream?play=n`);
    expect(h.result.player.srcKey).toBe('m:sm_9');
    h.rerender({ ...base, song: { id: 's3', music: null } });
    await flush();
    expect(h.result.musicMode).toBe(false);
    expect(video.getAttribute('src')).toBeNull();
    expect(h.result.player.srcKey).toBeNull();
  });

  it('播放網址過期（reload）：重新拿網址，同一首換新網址、接著同一秒', async () => {
    const h = mount(base);
    await flush();
    h.result.player.play();
    video.currentTime = 61;
    getShareSongMusic.mockImplementation(async () => full('sm_1', 'fresh'));
    h.result.reload();
    await flush();
    expect(getShareSongMusic).toHaveBeenCalledTimes(2);
    expect(video.src).toBe(`${BASE}/api/share/tk/song-music/sm_1/stream?play=fresh`);
    video.duration = 215; video.currentTime = 0;
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(61);
  });

  it('重新載入、拿回來的網址一模一樣（通行證還沒過期，只是網路暫時斷掉）：照樣把網址重設一次；沒按重新載入就不會重載', async () => {
    const h = mount(base);
    await flush();
    expect(video.srcSets).toBe(1);
    h.rerender({ ...base });          // 只是頁面又 render 一次
    await flush();
    expect(video.srcSets).toBe(1);
    h.result.reload();
    await flush();
    expect(video.srcSets).toBe(2);
    h.result.reload();
    await flush();
    expect(video.srcSets).toBe(3);
  });

  it('拿播放網址失敗：寫中文說明，不丟錯，通知頁面（換通行證用）；按重新載入可以再試；說明不會帶到別首歌', async () => {
    const boom = Object.assign(new Error('Share link expired'), { status: 410 });
    getShareSongMusic.mockImplementation(async () => { throw boom; });
    const h = mount(base);
    await flush();
    expect(h.result.error).toBe(SHARE_MUSIC_TEXT.fetchFailed);
    expect(h.result.error).not.toMatch(/[A-Za-z]{4,}/);    // 畫面上的說明是中文，不是後台的英文訊息
    expect(authErrors).toEqual([boom]);
    expect(video.getAttribute('src')).toBeNull();
    // 換一首沒音樂的歌：不顯示上一首的失敗
    h.rerender({ ...base, song: { id: 's2', music: null } });
    expect(h.result.error).toBeNull();
    h.rerender(base);
    getShareSongMusic.mockImplementation(async () => full('sm_1'));
    h.result.reload();
    await flush();
    expect(h.result.error).toBeNull();
    expect(video.src).toContain('sm_1');
  });

  it('通行證過期（401）換了新的：自動再問一次，不用使用者再按', async () => {
    getShareSongMusic.mockImplementationOnce(async () => { throw Object.assign(new Error('通行證過期了'), { status: 401 }); });
    const h = mount({ ...base, accessToken: 'old.sig' });
    await flush();
    expect(h.result.error).toBe(SHARE_MUSIC_TEXT.fetchFailed);
    expect(authErrors.length).toBe(1);
    getShareSongMusic.mockImplementation(async () => full('sm_1', 'renewed'));
    h.rerender({ ...base, accessToken: 'new.sig' });
    await flush();
    expect(getShareSongMusic).toHaveBeenLastCalledWith(REF, 's1', 'new.sig');
    expect(h.result.error).toBeNull();
    expect(video.src).toBe(`${BASE}/api/share/tk/song-music/sm_1/stream?play=renewed`);
  });

  it('通行證換新、但音樂已經拿到了：不會多問一次（正在播的不受影響）', async () => {
    const h = mount({ ...base, accessToken: 'old.sig' });
    await flush();
    h.result.player.play();
    h.rerender({ ...base, accessToken: 'new.sig' });
    await flush();
    expect(getShareSongMusic).toHaveBeenCalledTimes(1);
    expect(video.srcSets).toBe(1);
    expect(video.paused).toBe(false);
  });

  it('後台說的跟 /data 不一樣（剛好又被換了）：以後台為準；已經被移除了：不再是音樂模式，也不報錯', async () => {
    getShareSongMusic.mockImplementation(async () => full('sm_8', 'n'));
    const h = mount(base);
    await flush();
    expect(h.result.summary?.id).toBe('sm_8');
    expect(video.src).toBe(`${BASE}/api/share/tk/song-music/sm_8/stream?play=n`);
    expect(getShareSongMusic).toHaveBeenCalledTimes(1);

    getShareSongMusic.mockImplementation(async () => null);
    const g = mount({ ...base, song: { id: 's5', music: summary('sm_5') } });
    await flush();
    expect(g.result.music).toBeNull();
    expect(g.result.summary).toBeNull();
    expect(g.result.musicMode).toBe(false);
    expect(g.result.error).toBeNull();
    expect(getShareSongMusic).toHaveBeenCalledTimes(2);
  });
});
