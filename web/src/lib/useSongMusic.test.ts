import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../test/hookRunner';
import { musicPlayerKey, useSongMusic } from './useSongMusic';
import type { SongMusic, SongMusicSummary } from './musicApi';

vi.mock('./localVideo', () => ({ parkVideo: () => {} }));
const getSongMusic = vi.fn();
vi.mock('./musicApi', async (orig) => ({ ...(await orig<typeof import('./musicApi')>()), getSongMusic: (...a: unknown[]) => getSongMusic(...a) }));

class FakeVideo extends EventTarget {
  attrs = new Map<string, string>();
  currentTime = 0; duration = NaN; paused = true; loop = true; muted = false; playbackRate = 1; playsInline = false; preload = '';
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  get src() { return this.attrs.get('src') ?? ''; }
  set src(v: string) { this.attrs.set('src', v); }
  load() {}
  remove() {}
  play() { this.paused = false; this.dispatchEvent(new Event('play')); return Promise.resolve(); }
  pause() { if (this.paused) return; this.paused = true; this.dispatchEvent(new Event('pause')); }
}

const summary = (id: string, filename = `${id}.mp3`): SongMusicSummary => ({ id, filename, mime: 'audio/mpeg', sizeBytes: 100, durationSec: 215, uploadedAt: 't' });
const full = (id: string, pass = 'a'): SongMusic => ({ ...summary(id), songId: 's1', uploadedBy: null, streamUrl: `/api/music/${id}/stream?pass=${pass}` });
const flush = () => new Promise<void>(r => setTimeout(r, 0));
const BASE = 'https://proxy.haimiaan.com';

type Props = { song: { id: string; music?: SongMusicSummary | null } | null; hasVideo: boolean; videosLoaded: boolean };
let video: FakeVideo;
beforeEach(() => {
  video = new FakeVideo();
  vi.stubGlobal('document', { createElement: () => video });
  getSongMusic.mockReset();
  getSongMusic.mockImplementation(async (_p: string, _s: string) => full('sm_1'));
});
afterEach(() => { vi.unstubAllGlobals(); });

const mount = (p: Props) => renderHook((props: Props) => useSongMusic({ projectId: 'p1', ...props }), p);
const base: Props = { song: { id: 's1', music: summary('sm_1') }, hasVideo: false, videosLoaded: true };

describe('useSongMusic：這首歌的音樂接到頁面', () => {
  it('沒選歌 / 歌沒有音樂：不是音樂模式，不去拿網址', async () => {
    const a = mount({ song: null, hasVideo: false, videosLoaded: true });
    expect(a.result.source).toBe('none');
    expect(a.result.summary).toBeNull();
    const b = mount({ song: { id: 's1', music: null }, hasVideo: false, videosLoaded: true });
    expect(b.result.musicMode).toBe(false);
    expect(b.result.source).toBe('none');
    await flush();
    expect(getSongMusic).not.toHaveBeenCalled();
  });

  it('沒影片、有音樂：音樂模式，去拿播放網址，放進播放器（key 是 m:<音樂 id>，不會自己播）', async () => {
    const h = mount(base);
    expect(h.result.source).toBe('music');
    expect(h.result.musicMode).toBe(true);
    expect(h.result.summary?.filename).toBe('sm_1.mp3');
    await flush();
    expect(getSongMusic).toHaveBeenCalledWith('p1', 's1');
    expect(h.result.music?.id).toBe('sm_1');
    expect(video.src).toBe(`${BASE}/api/music/sm_1/stream?pass=a`);
    expect(h.result.player.srcKey).toBe(musicPlayerKey('sm_1'));
    expect(h.result.player.fileName).toBe('sm_1.mp3');
    expect(video.paused).toBe(true);
  });

  it('有影片：放影片，音樂不放（不去拿網址，播放器是空的）', async () => {
    const h = mount({ ...base, hasVideo: true });
    expect(h.result.source).toBe('video');
    expect(h.result.musicMode).toBe(false);
    expect(h.result.summary?.id).toBe('sm_1');       // 音樂還在，只是不放
    await flush();
    expect(getSongMusic).not.toHaveBeenCalled();
    expect(video.getAttribute('src')).toBeNull();
  });

  it('影片版本還沒讀完、歌單上也沒有最新版本：先不放音樂；讀完發現沒影片才放', async () => {
    const h = mount({ ...base, videosLoaded: false });
    expect(h.result.musicMode).toBe(false);
    await flush();
    expect(getSongMusic).not.toHaveBeenCalled();
    h.rerender({ ...base, videosLoaded: true });
    await flush();
    expect(h.result.musicMode).toBe(true);
    expect(video.src).toContain('/api/music/sm_1/stream');
  });

  it('音樂在播的時候交了影片：停下來、清掉；影片又被刪光就接回音樂', async () => {
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
    expect(video.src).toContain('/api/music/sm_1/stream');
  });

  it('換歌：上一首的音樂清掉，新的一首去拿；新的一首沒有音樂就空著', async () => {
    const h = mount(base);
    await flush();
    getSongMusic.mockImplementation(async () => ({ ...full('sm_9'), songId: 's2' }));
    h.rerender({ ...base, song: { id: 's2', music: summary('sm_9') } });
    await flush();
    expect(video.src).toContain('/api/music/sm_9/stream');
    expect(h.result.player.srcKey).toBe('m:sm_9');
    h.rerender({ ...base, song: { id: 's3', music: null } });
    await flush();
    expect(h.result.musicMode).toBe(false);
    expect(video.getAttribute('src')).toBeNull();
    expect(h.result.player.srcKey).toBeNull();
  });

  it('上傳成功（apply 完整資料）：馬上換成新的，不用再問後台；播放器換新的一首', async () => {
    const h = mount({ song: { id: 's1', music: null }, hasVideo: false, videosLoaded: true });
    expect(h.result.musicMode).toBe(false);
    h.result.apply(full('sm_2'));
    expect(h.result.summary?.id).toBe('sm_2');
    expect(h.result.musicMode).toBe(true);
    await flush();
    expect(getSongMusic).not.toHaveBeenCalled();
    expect(video.src).toBe(`${BASE}/api/music/sm_2/stream?pass=a`);
    // 歌單還沒更新（還是 null）→ 還是顯示剛傳的；歌單跟上了（也是 sm_2）→ 一樣
    h.rerender({ song: { id: 's1', music: null }, hasVideo: false, videosLoaded: true });
    expect(h.result.summary?.id).toBe('sm_2');
    h.rerender({ song: { id: 's1', music: summary('sm_2') }, hasVideo: false, videosLoaded: true });
    expect(h.result.summary?.id).toBe('sm_2');
    expect(getSongMusic).not.toHaveBeenCalled();
  });

  it('換音樂：播放器載新的一首，舊的 key 不見', async () => {
    const h = mount(base);
    await flush();
    h.result.apply(full('sm_2'));
    await flush();
    expect(h.result.player.srcKey).toBe('m:sm_2');
    expect(video.src).toContain('sm_2');
  });

  it('移除（apply null）：馬上沒有音樂、播放器清掉；歌單還沒跟上也一樣；歌單跟上了還是沒有', async () => {
    const h = mount(base);
    await flush();
    h.result.apply(null);
    expect(h.result.summary).toBeNull();
    expect(h.result.musicMode).toBe(false);
    expect(video.getAttribute('src')).toBeNull();
    h.rerender({ ...base, song: { id: 's1', music: summary('sm_1') } });   // 歌單舊的資料又進來
    expect(h.result.summary).toBeNull();
    h.rerender({ ...base, song: { id: 's1', music: null } });             // 歌單跟上了
    expect(h.result.summary).toBeNull();
  });

  it('別人換了音樂（歌單上的音樂 id 變了）：蓋掉本機的暫時結果，去拿新的', async () => {
    const h = mount(base);
    await flush();
    h.result.apply(null);
    getSongMusic.mockImplementation(async () => full('sm_7', 'z'));
    h.rerender({ ...base, song: { id: 's1', music: summary('sm_7') } });
    expect(h.result.summary?.id).toBe('sm_7');
    await flush();
    expect(video.src).toBe(`${BASE}/api/music/sm_7/stream?pass=z`);
  });

  it('播放網址過期（reload）：重新拿網址，同一首換新網址、接著同一秒', async () => {
    const h = mount(base);
    await flush();
    h.result.player.play();
    video.currentTime = 61;
    getSongMusic.mockImplementation(async () => full('sm_1', 'fresh'));
    h.result.reload();
    await flush();
    expect(getSongMusic).toHaveBeenCalledTimes(2);
    expect(video.src).toBe(`${BASE}/api/music/sm_1/stream?pass=fresh`);
    expect(h.result.player.srcKey).toBe('m:sm_1');
    video.duration = 215; video.currentTime = 0;
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(video.currentTime).toBe(61);
  });

  it('拿播放網址失敗：寫說明（中文），不丟錯；之後 reload 可以再試', async () => {
    getSongMusic.mockImplementation(async () => { throw Object.assign(new Error('網路壞了'), { status: 502 }); });
    const h = mount(base);
    await flush();
    expect(h.result.error).toBe('網路壞了');
    expect(video.getAttribute('src')).toBeNull();
    getSongMusic.mockImplementation(async () => full('sm_1'));
    h.result.reload();
    await flush();
    expect(h.result.error).toBeNull();
    expect(video.src).toContain('sm_1');
  });

  it('歌單上的音樂跟後台說的不一樣（剛好又被換了）：以後台為準', async () => {
    getSongMusic.mockImplementation(async () => full('sm_8', 'n'));
    const h = mount(base);
    await flush();
    expect(h.result.summary?.id).toBe('sm_8');
    expect(video.src).toBe(`${BASE}/api/music/sm_8/stream?pass=n`);
    expect(getSongMusic).toHaveBeenCalledTimes(1);
  });

  it('已經被別人移除了（後台說沒有）：不再是音樂模式', async () => {
    getSongMusic.mockImplementation(async () => null);
    const h = mount(base);
    await flush();
    expect(h.result.music).toBeNull();
    expect(h.result.summary).toBeNull();
    expect(h.result.musicMode).toBe(false);
    expect(video.getAttribute('src')).toBeNull();
    expect(getSongMusic).toHaveBeenCalledTimes(1);
  });
});
