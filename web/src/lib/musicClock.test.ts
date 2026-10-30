import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../test/hookRunner';
import { createMusicPreviewFeed, hotkeyYields, musicTimelineClock, spaceBelongsToTarget, useMusicHotkeys, useMusicPreviewFeed, type PreviewMedia } from './musicClock';

/** 假的播放元素：會發 play / pause / seeked 事件 */
function fakeMedia(): PreviewMedia & { fire: (n: string) => void } {
  const et = new EventTarget();
  const m = {
    currentTime: 0,
    paused: true,
    pause() { this.paused = true; et.dispatchEvent(new Event('pause')); },
    addEventListener: et.addEventListener.bind(et),
    removeEventListener: et.removeEventListener.bind(et),
    dispatchEvent: et.dispatchEvent.bind(et),
    fire(n: string) { et.dispatchEvent(new Event(n)); },
  };
  return m as unknown as PreviewMedia & { fire: (n: string) => void };
}

/** 假的 requestAnimationFrame：手動跑一幀 */
function fakeRaf() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    request: (cb: () => void) => { const id = next++; pending.set(id, cb); return id; },
    cancel: (id: number) => { pending.delete(id); },
    tick() { const cbs = [...pending.values()]; pending.clear(); cbs.forEach(cb => cb()); },
    get size() { return pending.size; },
  };
}

describe('機關時間軸的時鐘：播放頭跟音樂走', () => {
  it('now 每次讀音樂現在幾秒；播放 / 跳轉都交給音樂播放器；沒有長度就不給', () => {
    const video = { currentTime: 12.5 } as HTMLVideoElement;
    const toggle = vi.fn(), seek = vi.fn();
    const clock = musicTimelineClock({ video, playing: true, togglePlay: toggle, seek, duration: 215 });
    expect(clock.now()).toBe(12.5);
    (video as { currentTime: number }).currentTime = 40;
    expect(clock.now()).toBe(40);
    expect(clock.playing).toBe(true);
    expect(clock.duration).toBe(215);
    clock.toggle();
    clock.seek(30);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(seek).toHaveBeenCalledWith(30);
    expect(musicTimelineClock({ video, playing: false, togglePlay: toggle, seek, duration: 0 }).duration).toBeUndefined();
  });
});

describe('編輯頁：音樂播的時候 3D 的機關跟著音樂時間', () => {
  it('還沒播過 → 不碰預覽（機關停在目前選的 cue）；開始播之後每幀寫進音樂的時間', () => {
    const m = fakeMedia(), raf = fakeRaf(), set = vi.fn();
    createMusicPreviewFeed(m, set, raf);
    expect(set).not.toHaveBeenCalled();
    m.paused = false; m.currentTime = 1.5;
    m.fire('play');
    raf.tick();
    expect(set).toHaveBeenLastCalledWith(1.5);
    m.currentTime = 1.6;
    raf.tick();
    expect(set).toHaveBeenLastCalledWith(1.6);
  });

  it('暫停：停在那一刻（寫最後一次），不再每幀寫', () => {
    const m = fakeMedia(), raf = fakeRaf(), set = vi.fn();
    createMusicPreviewFeed(m, set, raf);
    m.paused = false; m.currentTime = 3;
    m.fire('play');
    raf.tick();
    m.currentTime = 3.2;
    m.paused = true;
    m.fire('pause');
    expect(set).toHaveBeenLastCalledWith(3.2);
    expect(raf.size).toBe(0);
    const calls = set.mock.calls.length;
    raf.tick();
    expect(set.mock.calls.length).toBe(calls);
  });

  it('沒播就拖時間尺跳過去 → 3D 的機關跳到那個時間', () => {
    const m = fakeMedia(), raf = fakeRaf(), set = vi.fn();
    createMusicPreviewFeed(m, set, raf);
    m.currentTime = 42;
    m.fire('seeking');
    expect(set).toHaveBeenLastCalledWith(42);
    m.currentTime = 43;
    m.fire('seeked');
    expect(set).toHaveBeenLastCalledWith(43);
  });

  it('停止：暫停、回到開頭、預覽清掉（機關回到目前選的 cue）；回到開頭的跳轉不會又開始預覽', () => {
    const m = fakeMedia(), raf = fakeRaf(), set = vi.fn();
    const feed = createMusicPreviewFeed(m, set, raf);
    m.paused = false; m.currentTime = 9;
    m.fire('play');
    raf.tick();
    feed.stop();
    expect(m.paused).toBe(true);
    expect(m.currentTime).toBe(0);
    expect(set).toHaveBeenLastCalledWith(null);
    set.mockClear();
    m.fire('seeked');       // 回到開頭觸發的跳轉
    m.fire('pause');
    expect(set).not.toHaveBeenCalled();
    expect(raf.size).toBe(0);
  });

  it('拆掉（換歌、有影片了、音樂被移除）：預覽清掉、不再聽事件', () => {
    const m = fakeMedia(), raf = fakeRaf(), set = vi.fn();
    const feed = createMusicPreviewFeed(m, set, raf);
    m.paused = false; m.currentTime = 5;
    m.fire('play');
    raf.tick();
    feed.dispose();
    expect(set).toHaveBeenLastCalledWith(null);
    set.mockClear();
    m.fire('play');
    m.fire('seeked');
    raf.tick();
    expect(set).not.toHaveBeenCalled();
  });

  it('接上的時候音樂已經在播 → 馬上開始預覽', () => {
    const m = fakeMedia(), raf = fakeRaf(), set = vi.fn();
    m.paused = false; m.currentTime = 7;
    createMusicPreviewFeed(m, set, raf);
    raf.tick();
    expect(set).toHaveBeenLastCalledWith(7);
  });
});

describe('快捷鍵讓不讓給別人', () => {
  const key = (over: Partial<Parameters<typeof hotkeyYields>[0]> = {}) => ({ target: { tagName: 'DIV' } as unknown as EventTarget, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, ...over });
  it('打字的欄位、帶 Ctrl / Alt / Cmd、別人已經處理了 → 讓給別人；平常的畫面 → 自己處理', () => {
    expect(hotkeyYields(key())).toBe(false);
    expect(hotkeyYields(key({ target: { tagName: 'INPUT', type: 'text' } as unknown as EventTarget }))).toBe(true);
    expect(hotkeyYields(key({ target: { tagName: 'TEXTAREA' } as unknown as EventTarget }))).toBe(true);
    expect(hotkeyYields(key({ target: { tagName: 'SELECT' } as unknown as EventTarget }))).toBe(true);
    expect(hotkeyYields(key({ ctrlKey: true }))).toBe(true);
    expect(hotkeyYields(key({ metaKey: true }))).toBe(true);
    expect(hotkeyYields(key({ altKey: true }))).toBe(true);
    expect(hotkeyYields(key({ defaultPrevented: true }))).toBe(true);
    // 範圍滑桿、勾選框不是打字的欄位
    expect(hotkeyYields(key({ target: { tagName: 'INPUT', type: 'range' } as unknown as EventTarget }))).toBe(false);
  });
  it('空白鍵只讓給自己用空白鍵的東西（勾選 / 開關、選單選項、對話框、可展開的標題）；一般按鈕、分頁、連結不讓（影片也是這樣）', () => {
    /** 假的畫面元素：closest(選擇器) 看選擇器清單裡有沒有它符合的那一種 */
    const el = (...matches: string[]) => ({ closest: (sel: string) => (sel.split(',').map(x => x.trim()).some(x => matches.includes(x)) ? {} : null) }) as unknown as EventTarget;
    for (const m of ['[role="dialog"]', '[role="alertdialog"]', '[role="menuitem"]', '[role="option"]', '[role="checkbox"]', '[role="switch"]', '[role="radio"]', 'summary', 'input[type="checkbox"]', 'input[type="radio"]']) {
      expect(spaceBelongsToTarget(el(m)), m).toBe(true);
    }
    expect(spaceBelongsToTarget(el('button')), '一般按鈕（例：導演頁剛點過的 cue）').toBe(false);
    expect(spaceBelongsToTarget(el('[role="tab"]')), '分頁').toBe(false);
    expect(spaceBelongsToTarget(el('[role="button"]')), 'role=button').toBe(false);
    expect(spaceBelongsToTarget(el('a[href]')), '連結').toBe(false);
    expect(spaceBelongsToTarget(null)).toBe(false);
    expect(spaceBelongsToTarget({} as EventTarget)).toBe(false);
  });
});

describe('空白鍵 / M 鍵（useMusicHotkeys）', () => {
  type Handler = (e: Record<string, unknown>) => void;
  function fakeWindow() {
    const handlers: Handler[] = [];
    const upHandlers: Handler[] = [];
    vi.stubGlobal('window', {
      addEventListener: (type: string, fn: Handler) => { if (type === 'keydown') handlers.push(fn); else if (type === 'keyup') upHandlers.push(fn); },
      removeEventListener: (type: string, fn: Handler) => {
        const list = type === 'keydown' ? handlers : type === 'keyup' ? upHandlers : null;
        const i = list ? list.indexOf(fn) : -1;
        if (list && i >= 0) list.splice(i, 1);
      },
    });
    const fire = (list: Handler[], key: string, extra: Record<string, unknown>) => {
      const prevented = { v: false };
      const e = { key, code: key === ' ' ? 'Space' : `Key${key.toUpperCase()}`, target: { tagName: 'DIV' }, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, defaultPrevented: false, preventDefault: () => { prevented.v = true; }, ...extra };
      list.slice().forEach(h => h(e));
      return prevented.v;
    };
    const press = (key: string, extra: Record<string, unknown> = {}) => fire(handlers, key, extra);
    const release = (key: string, extra: Record<string, unknown> = {}) => fire(upHandlers, key, extra);
    return { press, release, count: () => handlers.length, upCount: () => upHandlers.length };
  }
  afterEach(() => { vi.unstubAllGlobals(); });

  it('空白鍵 = 播放 / 暫停；M = 設在現在這一秒（有給才算）；按下去的鍵不會再當成別的用途', () => {
    const w = fakeWindow();
    const toggle = vi.fn(), mark = vi.fn();
    renderHook((p: { onMark: (() => void) | null }) => useMusicHotkeys({ enabled: true, onToggle: toggle, onMark: p.onMark }), { onMark: mark });
    expect(w.press(' ')).toBe(true);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(w.press('m')).toBe(true);
    expect(w.press('M')).toBe(true);
    expect(mark).toHaveBeenCalledTimes(2);
    expect(w.press('m', { repeat: true })).toBe(false);          // 按住不放不會一直設
    expect(w.press('m', { shiftKey: true })).toBe(false);
    expect(w.press('j')).toBe(false);                            // 別的鍵（J / K 換歌換 cue）完全不碰
    expect(w.press('k')).toBe(false);
    expect(mark).toHaveBeenCalledTimes(2);
  });

  it('導演頁沒有 M（onMark 沒給）：M 不處理；空白鍵還是播放 / 暫停', () => {
    const w = fakeWindow();
    const toggle = vi.fn();
    renderHook(() => useMusicHotkeys({ enabled: true, onToggle: toggle }), undefined);
    expect(w.press('m')).toBe(false);
    expect(w.press(' ')).toBe(true);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('打字的時候、按著 Ctrl / Cmd / Alt、焦點在對話框 / 勾選框 / 選單上的空白鍵、已經有人處理了 → 讓給別人', () => {
    const w = fakeWindow();
    const toggle = vi.fn(), mark = vi.fn();
    renderHook(() => useMusicHotkeys({ enabled: true, onToggle: toggle, onMark: mark }), undefined);
    const input = { tagName: 'INPUT', type: 'text' };
    expect(w.press(' ', { target: input })).toBe(false);
    expect(w.press('m', { target: input })).toBe(false);
    expect(w.press('m', { target: { tagName: 'TEXTAREA' } })).toBe(false);
    expect(w.press('m', { target: { tagName: 'SELECT' } })).toBe(false);
    expect(w.press(' ', { ctrlKey: true })).toBe(false);
    expect(w.press('m', { metaKey: true })).toBe(false);
    expect(w.press('m', { altKey: true })).toBe(false);
    expect(w.press(' ', { defaultPrevented: true })).toBe(false);
    expect(w.press(' ', { target: { tagName: 'BUTTON', closest: () => ({}) } })).toBe(false);     // 對話框裡的按鈕：空白鍵是按那顆按鈕
    expect(w.release(' ', { target: { tagName: 'BUTTON', closest: () => ({}) } })).toBe(false);    // 放開時也不擋它的「按一下」
    expect(toggle).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
  });

  it('焦點在一般按鈕上（點了 cue、點了分頁之後）：空白鍵照樣播放 / 暫停，放開時不讓那顆按鈕再被按一次；按住不放不會一直切', () => {
    const w = fakeWindow();
    const toggle = vi.fn();
    renderHook(() => useMusicHotkeys({ enabled: true, onToggle: toggle }), undefined);
    const button = { tagName: 'BUTTON', closest: () => null };
    expect(w.press(' ', { target: button })).toBe(true);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(w.release(' ', { target: button })).toBe(true);             // 擋掉放開時的「按一下」
    expect(w.press(' ', { target: button, repeat: true })).toBe(true);  // 按住不放：不讓頁面捲動，但不再切
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(w.release(' ', { target: { tagName: 'DIV', closest: () => null } })).toBe(false);   // 不是按鈕就不碰
    expect(w.release('m', { target: button })).toBe(false);
    expect(w.release(' ', { target: button, ctrlKey: true })).toBe(false);
  });

  it('沒打開（有影片、沒音樂）不接；關掉時拆掉；用最新的 callback', () => {
    const w = fakeWindow();
    const a = vi.fn(), b = vi.fn();
    const h = renderHook((p: { on: boolean; fn: () => void }) => useMusicHotkeys({ enabled: p.on, onToggle: p.fn }), { on: false, fn: a });
    expect(w.count()).toBe(0);
    expect(w.press(' ')).toBe(false);
    h.rerender({ on: true, fn: a });
    expect(w.count()).toBe(1);
    h.rerender({ on: true, fn: b });          // 換了 callback 不用重接，也會用新的
    expect(w.count()).toBe(1);
    w.press(' ');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(w.upCount()).toBe(1);
    h.rerender({ on: false, fn: b });
    expect(w.count()).toBe(0);
    expect(w.upCount()).toBe(0);
    h.rerender({ on: true, fn: b });
    h.unmount();
    expect(w.count()).toBe(0);
    expect(w.upCount()).toBe(0);
  });
});

describe('useMusicPreviewFeed（編輯頁）', () => {
  it('enabled 才接；關掉（換歌、有影片了）預覽清掉；stop() 回到開頭並清掉', () => {
    const m = fakeMedia(), set = vi.fn();
    const raf = fakeRaf();
    vi.stubGlobal('requestAnimationFrame', raf.request);
    vi.stubGlobal('cancelAnimationFrame', raf.cancel);
    const h = renderHook((p: { enabled: boolean }) => useMusicPreviewFeed({ enabled: p.enabled, video: m as unknown as HTMLVideoElement, setPreviewTime: set }), { enabled: false });
    m.currentTime = 4;
    m.fire('seeked');
    expect(set).not.toHaveBeenCalled();                 // 沒打開不碰
    h.rerender({ enabled: true });
    m.currentTime = 6;
    m.fire('seeked');
    expect(set).toHaveBeenLastCalledWith(6);
    h.result.stop();
    expect(m.currentTime).toBe(0);
    expect(set).toHaveBeenLastCalledWith(null);
    m.currentTime = 9;
    m.fire('seeked');
    h.rerender({ enabled: false });
    expect(set).toHaveBeenLastCalledWith(null);
    set.mockClear();
    m.fire('seeked');
    expect(set).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('換成別的音樂（換歌、換音樂檔；enabled 一直是 true）：預覽清掉、重新接，不能還停在上一個音樂的時間', () => {
    const m = fakeMedia(), set = vi.fn();
    const raf = fakeRaf();
    vi.stubGlobal('requestAnimationFrame', raf.request);
    vi.stubGlobal('cancelAnimationFrame', raf.cancel);
    const h = renderHook((p: { key: string }) => useMusicPreviewFeed({ enabled: true, video: m as unknown as HTMLVideoElement, setPreviewTime: set, resetKey: p.key }), { key: 'sm_1' });
    m.currentTime = 2.9;
    m.fire('seeked');                                   // 在上一個音樂停在 2.9 秒
    expect(set).toHaveBeenLastCalledWith(2.9);
    h.rerender({ key: 'sm_2' });                        // 換歌 / 換音樂
    expect(set).toHaveBeenLastCalledWith(null);
    set.mockClear();
    m.currentTime = 0;
    m.fire('pause');                                    // 還沒按播放 / 跳轉 → 不碰預覽（機關回到目前選的 cue）
    expect(set).not.toHaveBeenCalled();
    m.currentTime = 1.5;
    m.fire('seeked');                                   // 在新的一首跳轉之後才開始預覽
    expect(set).toHaveBeenLastCalledWith(1.5);
    h.rerender({ key: 'sm_2' });                        // 同一個音樂重畫（或只是換了播放網址）不會重接
    expect(set).toHaveBeenLastCalledWith(1.5);
    vi.unstubAllGlobals();
  });
});
