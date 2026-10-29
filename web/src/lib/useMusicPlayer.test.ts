import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../test/hookRunner';
import { useMusicPlayer } from './useMusicPlayer';
import { MUSIC_TEXT } from './songMusic';
import type { LocalVideoState } from './localVideo';

vi.mock('./localVideo', () => ({ parkVideo: () => {} }));

/** 假的 <video>：記得 src、播放狀態，事件用 EventTarget 發 */
class FakeVideo extends EventTarget {
  attrs = new Map<string, string>();
  currentTime = 0;
  duration = NaN;
  paused = true;
  loop = true;
  muted = false;
  playbackRate = 1;
  playsInline = false;
  preload = '';
  plays = 0;
  pauses = 0;
  removed = false;
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  removeAttribute(k: string) { this.attrs.delete(k); }
  get src() { return this.attrs.get('src') ?? ''; }
  set src(v: string) { this.attrs.set('src', v); }
  load() {}
  remove() { this.removed = true; }
  play() { this.paused = false; this.plays++; this.dispatchEvent(new Event('play')); return Promise.resolve(); }
  pause() { if (this.paused) return; this.paused = true; this.pauses++; this.dispatchEvent(new Event('pause')); }
  fire(name: string) { this.dispatchEvent(new Event(name)); }
}

let video: FakeVideo;
beforeEach(() => {
  video = new FakeVideo();
  vi.stubGlobal('document', { createElement: () => video });
});
afterEach(() => { vi.unstubAllGlobals(); });

const mount = () => renderHook(() => useMusicPlayer(), undefined);
const loaded = (h: ReturnType<typeof mount>, duration = 215) => {
  h.result.loadUrl('https://x.test/a.mp3', { key: 'm:1', name: 'a.mp3' });
  video.duration = duration;
  video.fire('loadedmetadata');
};

describe('音樂播放器（介面跟影片播放器一樣）', () => {
  it('一開始：沒載入、沒在播、不循環；底下是一個只放聲音的 <video>（跟影片同型別，useVideoCueTimeline 才接得起來）', () => {
    const h = mount();
    const p: LocalVideoState = h.result;
    expect(p.video).toBe(video);
    expect([p.ready, p.playing, p.time, p.duration, p.loop, p.muted, p.error, p.srcKey, p.fileName]).toEqual([false, false, 0, 0, false, false, null, null, null]);
    expect(video.loop).toBe(false);
    expect(video.playsInline).toBe(true);
    expect(video.preload).toBe('auto');
    expect(p.standby.key).toBeNull();
    expect(p.load(new File([], 'x.mp3') as File)).toBe(false);        // 音樂只放上傳好的網址
    // 影片播放器有的函式都有
    for (const k of ['loadUrl', 'replaceUrl', 'clear', 'togglePlay', 'play', 'pause', 'seek', 'setLoop', 'setMuted', 'setRate', 'getSrcKey'] as const) {
      expect(typeof p[k], k).toBe('function');
    }
  });

  it('載入網址：記下是哪一首、檔名；不會自己播；載好了（loadedmetadata）才算 ready，並知道長度', () => {
    const h = mount();
    h.result.loadUrl('https://x.test/a.mp3', { key: 'm:1', name: 'a.mp3' });
    expect(video.src).toBe('https://x.test/a.mp3');
    expect(video.paused).toBe(true);
    expect(h.result.srcKey).toBe('m:1');
    expect(h.result.getSrcKey()).toBe('m:1');
    expect(h.result.fileName).toBe('a.mp3');
    expect(h.result.ready).toBe(false);
    video.duration = 215.4;
    video.fire('loadedmetadata');
    expect(h.result.ready).toBe(true);
    expect(h.result.duration).toBe(215.4);
  });

  it('同一首同一個網址再載一次 = 沒事（不會從頭播）；換網址 / 換一首才重載', () => {
    const h = mount();
    loaded(h);
    video.currentTime = 50;
    h.result.loadUrl('https://x.test/a.mp3', { key: 'm:1', name: 'a.mp3' });
    expect(video.currentTime).toBe(50);
    expect(h.result.ready).toBe(true);
    h.result.loadUrl('https://x.test/b.mp3', { key: 'm:2', name: 'b.mp3' });
    expect(video.src).toBe('https://x.test/b.mp3');
    expect(h.result.ready).toBe(false);
    expect(h.result.duration).toBe(0);
    expect(h.result.srcKey).toBe('m:2');
  });

  it('播放 / 暫停 / 時間：事件進來狀態就跟著；播放鍵切換；跳轉不超過長度', () => {
    const h = mount();
    loaded(h);
    h.result.togglePlay();
    expect(video.plays).toBe(1);
    expect(h.result.playing).toBe(true);
    video.currentTime = 12.34;
    video.fire('timeupdate');
    expect(h.result.time).toBe(12.34);
    h.result.togglePlay();
    expect(video.paused).toBe(true);
    expect(h.result.playing).toBe(false);
    h.result.seek(100);
    expect(video.currentTime).toBe(100);
    expect(h.result.time).toBe(100);
    h.result.seek(9999);
    expect(video.currentTime).toBe(215);
    h.result.seek(-5);
    expect(video.currentTime).toBe(0);
    h.result.seek(NaN);
    expect(video.currentTime).toBe(0);
    video.currentTime = 30;
    video.fire('seeked');
    expect(h.result.time).toBe(30);
  });

  it('播完（ended）：停下來、不循環', () => {
    const h = mount();
    loaded(h);
    h.result.play();
    expect(h.result.playing).toBe(true);
    video.paused = true;
    video.fire('ended');
    expect(h.result.playing).toBe(false);
  });

  it('載入失敗（網址過期 / 斷線 / 瀏覽器播不了）：寫說明、ready 收回；自己清掉來源時的錯誤不算', () => {
    const h = mount();
    loaded(h);
    video.fire('error');
    expect(h.result.error).toBe(MUSIC_TEXT.loadFailed);
    expect(h.result.ready).toBe(false);
    h.result.clear();
    video.fire('error');                       // 清掉之後瀏覽器可能再報一次錯
    expect(h.result.error).toBeNull();
  });

  it('換新網址（過期）：接著同一秒、播放狀態照舊，錯誤清掉', () => {
    const h = mount();
    loaded(h);
    h.result.play();
    video.currentTime = 80;
    video.fire('error');
    h.result.replaceUrl('https://x.test/a.mp3?pass=new', { key: 'm:1', name: 'a.mp3' });
    expect(video.src).toBe('https://x.test/a.mp3?pass=new');
    expect(h.result.error).toBeNull();
    expect(h.result.srcKey).toBe('m:1');
    const playsBefore = video.plays;
    video.currentTime = 0;                      // 新網址載入後從頭
    video.duration = 215;
    video.fire('loadedmetadata');
    expect(video.currentTime).toBe(80);
    expect(video.plays).toBe(playsBefore + 1);  // 本來在播（出錯時 paused 沒變）→ 接著播
    expect(h.result.ready).toBe(true);
  });

  it('startAt / autoplay：載好了跳到那一秒、要播才播', () => {
    const h = mount();
    h.result.loadUrl('https://x.test/a.mp3', { key: 'm:1', name: 'a.mp3', startAt: 33, autoplay: true });
    video.duration = 215;
    video.fire('loadedmetadata');
    expect(video.currentTime).toBe(33);
    expect(video.plays).toBe(1);
  });

  it('清掉：暫停、拿掉來源、狀態回到一開始', () => {
    const h = mount();
    loaded(h);
    h.result.play();
    h.result.clear();
    expect(video.paused).toBe(true);
    expect(video.getAttribute('src')).toBeNull();
    expect(h.result.srcKey).toBeNull();
    expect([h.result.ready, h.result.playing, h.result.time, h.result.duration, h.result.fileName]).toEqual([false, false, 0, 0, null]);
  });

  it('靜音、速度、循環：設到 <video> 上；換來源後速度照使用者選的', () => {
    const h = mount();
    h.result.setMuted(true);
    expect(video.muted).toBe(true);
    expect(h.result.muted).toBe(true);
    h.result.setRate(2);
    expect(video.playbackRate).toBe(2);
    h.result.setRate(100);
    expect(video.playbackRate).toBe(4);
    h.result.setRate(2);
    h.result.setLoop(true);
    expect(video.loop).toBe(true);
    expect(h.result.loop).toBe(true);
    h.result.loadUrl('https://x.test/c.mp3', { key: 'm:3', name: 'c.mp3' });
    video.playbackRate = 1;                    // 瀏覽器換來源時把速度改回 1
    video.duration = 10;
    video.fire('loadedmetadata');
    expect(video.playbackRate).toBe(2);
  });

  it('離開頁面：暫停、卸掉 <video>', () => {
    const h = mount();
    loaded(h);
    h.result.play();
    h.unmount();
    expect(video.paused).toBe(true);
    expect(video.getAttribute('src')).toBeNull();
    expect(video.removed).toBe(true);
  });
});
