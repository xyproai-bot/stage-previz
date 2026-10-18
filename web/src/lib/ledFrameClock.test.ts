// 畫面時鐘：播放中用每一格回報的時間、拉時間軸用 seeked、換影片清掉、沒有 requestVideoFrameCallback 就用 currentTime
import { describe, expect, it } from 'vitest';
import { createFrameClock, type FrameCallbackMeta, type VideoLike } from './ledFrameClock';

class FakeVideo implements VideoLike {
  currentTime = 0;
  private listeners = new Map<string, Set<() => void>>();
  private cb: ((now: number, meta: FrameCallbackMeta) => void) | null = null;
  private nextHandle = 1;
  cancelled: number[] = [];
  constructor(withRvfc = true) {
    if (!withRvfc) {
      (this as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback = undefined;
    }
  }
  requestVideoFrameCallback = (cb: (now: number, meta: FrameCallbackMeta) => void) => { this.cb = cb; return this.nextHandle++; };
  cancelVideoFrameCallback = (h: number) => { this.cancelled.push(h); this.cb = null; };
  addEventListener(t: string, l: () => void) { if (!this.listeners.has(t)) this.listeners.set(t, new Set()); this.listeners.get(t)!.add(l); }
  removeEventListener(t: string, l: () => void) { this.listeners.get(t)?.delete(l); }
  emit(t: string) { this.listeners.get(t)?.forEach(l => l()); }
  listenerCount() { return [...this.listeners.values()].reduce((n, s) => n + s.size, 0); }
  /** 瀏覽器送出新的一格（回呼在 requestAnimationFrame 之前跑） */
  present(mediaTime: number, clock = this.currentTime) {
    this.currentTime = clock;
    const cb = this.cb;
    this.cb = null;
    cb?.(0, { mediaTime });
  }
}

describe('createFrameClock', () => {
  it('播放中：用每一格回報的時間，不用 currentTime（currentTime 可能比正在畫的那一格早或晚）', () => {
    const v = new FakeVideo();
    const c = createFrameClock(v);
    expect(c.precise).toBe(true);
    expect(c.time()).toBe(0);                         // 還沒有任何一格 → currentTime
    v.present(82.9667, 83.05);                        // currentTime 已經跑到下一格了，畫的還是 82.9667
    expect(c.time()).toBeCloseTo(82.9667, 4);
    v.present(83, 83.0);
    expect(c.time()).toBe(83);
    c.dispose();
  });

  it('拉時間軸：seeking 時 currentTime 先跳到新位置，但畫面還是舊的那一格 → 時鐘不動；seeked 之後才換', () => {
    const v = new FakeVideo();
    const c = createFrameClock(v);
    v.present(10, 10);
    v.currentTime = 90;                               // 使用者拉到 90 秒，新的那一格還沒好
    expect(c.time()).toBe(10);
    v.emit('seeked');                                 // 新的一格準備好了
    expect(c.time()).toBe(90);
    v.present(90.0333, 90.0333);                      // 接著 requestVideoFrameCallback 也報一次
    expect(c.time()).toBeCloseTo(90.0333, 4);
    // 往回拉
    v.currentTime = 5;
    expect(c.time()).toBeCloseTo(90.0333, 4);
    v.emit('seeked');
    expect(c.time()).toBe(5);
  });

  it('換影片（emptied / loadstart）：舊的時間作廢，回到 currentTime', () => {
    const v = new FakeVideo();
    const c = createFrameClock(v);
    v.present(120, 120);
    v.currentTime = 0;
    v.emit('emptied');
    expect(c.time()).toBe(0);
    v.present(1, 1);
    v.emit('loadstart');
    v.currentTime = 0;
    expect(c.time()).toBe(0);
  });

  it('瀏覽器沒有 requestVideoFrameCallback：一律用 currentTime（seeked 也不會壞）', () => {
    const v = new FakeVideo(false);
    const c = createFrameClock(v);
    expect(c.precise).toBe(false);
    v.currentTime = 7.5;
    expect(c.time()).toBe(7.5);
    v.emit('seeked');
    v.currentTime = 8;
    expect(c.time()).toBe(8);                         // 沒有逐格回報的瀏覽器永遠看 currentTime
    c.dispose();
  });

  it('dispose：取消回呼、拿掉事件；之後的回報不再改時鐘', () => {
    const v = new FakeVideo();
    const c = createFrameClock(v);
    expect(v.listenerCount()).toBe(3);
    v.present(3, 3);
    c.dispose();
    expect(v.listenerCount()).toBe(0);
    expect(v.cancelled.length).toBe(1);
    v.present(50, 50);
    expect(c.time()).toBe(3);
  });

  it('不合理的 mediaTime（NaN）略過', () => {
    const v = new FakeVideo();
    const c = createFrameClock(v);
    v.present(4, 4);
    v.present(Number.NaN, 9);
    expect(c.time()).toBe(4);
  });
});
