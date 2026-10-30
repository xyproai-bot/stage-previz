// 教學頁的短片：一頁十幾支，捲到才播、捲走就停；減少動態 / 沒有 IntersectionObserver 時只給封面和播放鍵
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import TutorialMedia, { CLIP_PLAY_RATIO, clipAutoplayMode, watchClipVisibility } from './TutorialMedia';

const clip = { kind: 'clip' as const, src: '/help/tutorial/a.mp4', poster: '/help/tutorial/a.jpg', alt: '示範', width: 1280, height: 720 };

/** 假的 IntersectionObserver：測試自己決定什麼時候「進畫面」 */
class FakeObserver {
  static last: FakeObserver | null = null;
  observed: unknown[] = [];
  disconnected = false;
  constructor(public cb: (e: { isIntersecting: boolean; intersectionRatio: number }[]) => void, public opts: { threshold: number[] }) { FakeObserver.last = this; }
  observe(el: unknown) { this.observed.push(el); }
  disconnect() { this.disconnected = true; }
  fire(isIntersecting: boolean, intersectionRatio: number) { this.cb([{ isIntersecting, intersectionRatio }]); }
}

const fakeVideo = () => ({ play: vi.fn(() => Promise.resolve()), pause: vi.fn() });

describe('watchClipVisibility：進畫面就播、離開就暫停', () => {
  it('有一半進畫面就播', () => {
    const v = fakeVideo();
    const target = {} as Element;
    watchClipVisibility(v, target, FakeObserver);
    expect(FakeObserver.last!.observed).toEqual([target]);
    FakeObserver.last!.fire(true, 0.5);
    expect(v.play).toHaveBeenCalledTimes(1);
    expect(v.pause).not.toHaveBeenCalled();
  });

  it('播的時候告訴畫面「要載了」（preload 才改成 auto）', () => {
    const onStart = vi.fn();
    watchClipVisibility(fakeVideo(), {} as Element, FakeObserver, onStart);
    FakeObserver.last!.fire(true, 0.8);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('還沒到一半、或已經離開畫面：不播，暫停', () => {
    const v = fakeVideo();
    const onStart = vi.fn();
    watchClipVisibility(v, {} as Element, FakeObserver, onStart);
    FakeObserver.last!.fire(true, CLIP_PLAY_RATIO - 0.2);   // 剛露出一點
    FakeObserver.last!.fire(false, 0);                      // 捲走了
    expect(v.play).not.toHaveBeenCalled();
    expect(v.pause).toHaveBeenCalledTimes(2);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('播了又捲走、再捲回來：再播一次', () => {
    const v = fakeVideo();
    watchClipVisibility(v, {} as Element, FakeObserver);
    FakeObserver.last!.fire(true, 0.9);
    FakeObserver.last!.fire(false, 0);
    FakeObserver.last!.fire(true, 0.7);
    expect(v.play).toHaveBeenCalledTimes(2);
    expect(v.pause).toHaveBeenCalledTimes(1);
  });

  it('門檻是「一點點」和「一半」，這樣捲過一半的兩個方向都會通知', () => {
    watchClipVisibility(fakeVideo(), {} as Element, FakeObserver);
    expect(FakeObserver.last!.opts.threshold).toEqual([0, CLIP_PLAY_RATIO]);
    expect(CLIP_PLAY_RATIO).toBe(0.5);
  });

  it('瀏覽器不讓播（play 被拒絕）不會丟錯誤', async () => {
    const rejected: unknown[] = [];
    const onRej = (e: unknown) => rejected.push(e);
    process.on('unhandledRejection', onRej);
    const v = { play: vi.fn(() => Promise.reject(new Error('NotAllowedError'))), pause: vi.fn() };
    watchClipVisibility(v, {} as Element, FakeObserver);
    FakeObserver.last!.fire(true, 1);
    await new Promise(r => setTimeout(r, 0));
    process.off('unhandledRejection', onRej);
    expect(v.play).toHaveBeenCalled();
    expect(rejected).toEqual([]);
  });

  it('舊瀏覽器 play() 沒有回傳東西也不會壞', () => {
    const v = { play: vi.fn(() => undefined), pause: vi.fn() };
    watchClipVisibility(v, {} as Element, FakeObserver);
    expect(() => FakeObserver.last!.fire(true, 1)).not.toThrow();
  });

  it('回傳的函式會關掉觀察', () => {
    const stop = watchClipVisibility(fakeVideo(), {} as Element, FakeObserver);
    expect(FakeObserver.last!.disconnected).toBe(false);
    stop();
    expect(FakeObserver.last!.disconnected).toBe(true);
  });
});

describe('clipAutoplayMode：什麼時候自動播', () => {
  it('一般瀏覽器（有 IntersectionObserver、沒設減少動態）：捲到才播', () => {
    expect(clipAutoplayMode({ reducedMotion: false, hasObserver: true })).toBe('visible');
  });
  it('設了「減少動態」：不自動播', () => {
    expect(clipAutoplayMode({ reducedMotion: true, hasObserver: true })).toBe('manual');
  });
  it('沒有 IntersectionObserver：不自動播', () => {
    expect(clipAutoplayMode({ reducedMotion: false, hasObserver: false })).toBe('manual');
    expect(clipAutoplayMode({ reducedMotion: true, hasObserver: false })).toBe('manual');
  });
});

describe('TutorialMedia 的短片畫面', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const fakeWindow = (o: { reduced?: boolean; observer?: boolean }) => vi.stubGlobal('window', {
    matchMedia: () => ({ matches: !!o.reduced, addEventListener() {}, removeEventListener() {} }),
    ...(o.observer ? { IntersectionObserver: FakeObserver } : {}),
  });

  it('一般瀏覽器：沒有播放鍵、不自動下載、沒有 autoplay（捲到才由程式播）', () => {
    fakeWindow({ observer: true });
    const html = renderToStaticMarkup(<TutorialMedia item={clip} />);
    expect(html).toContain('<video');
    expect(html).not.toContain('tut-media__play');
    expect(html).toContain('preload="none"');
    expect(html).not.toMatch(/autoplay/i);
    expect(html).toContain('poster="/help/tutorial/a.jpg"');
  });

  it('設了「減少動態」：不自動播，有播放鍵', () => {
    fakeWindow({ reduced: true, observer: true });
    const html = renderToStaticMarkup(<TutorialMedia item={clip} />);
    expect(html).not.toMatch(/autoplay/i);
    expect(html).toContain('tut-media__play');
    expect(html).toContain('播放這段短片');
    expect(html).toContain('preload="none"');
  });

  it('沒有 IntersectionObserver：顯示封面和播放鍵', () => {
    fakeWindow({ observer: false });
    const html = renderToStaticMarkup(<TutorialMedia item={clip} />);
    expect(html).toContain('poster="/help/tutorial/a.jpg"');
    expect(html).toContain('tut-media__play');
    expect(html).not.toMatch(/autoplay/i);
  });

  it('伺服器端（沒有 window）：封面和播放鍵，不會壞', () => {
    const html = renderToStaticMarkup(<TutorialMedia item={clip} />);
    expect(html).toContain('tut-media__play');
    expect(html).toContain('preload="none"');
  });

  it('圖片照舊：延遲載入', () => {
    const html = renderToStaticMarkup(<TutorialMedia item={{ kind: 'image', src: '/help/a.webp', alt: '圖', width: 10, height: 10 }} />);
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain('<video');
  });
});
