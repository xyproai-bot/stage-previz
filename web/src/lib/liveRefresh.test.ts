import { describe, it, expect } from 'vitest';
import { STOP_LIVE_REFRESH, createLiveRefresher, isProjectGoneError, liveRefreshWanted } from './liveRefresh';

function setup(visible = true) {
  let t = 1_000_000;
  let calls = 0;
  let release: (() => void) | null = null;
  let hold = false;
  const state = { visible };
  const r = createLiveRefresher(() => {
    calls++;
    if (!hold) return;
    return new Promise<void>(res => { release = res; });
  }, { now: () => t, isVisible: () => state.visible });
  return {
    r, state,
    advance: (ms: number) => { t += ms; },
    calls: () => calls,
    holdNext: () => { hold = true; },
    finish: () => { hold = false; release?.(); },
  };
}

describe('createLiveRefresher', () => {
  it('剛載入完不馬上再打；過了間隔才打', async () => {
    const s = setup();
    expect(await s.r.trigger()).toBe(false);
    s.advance(25_000);
    expect(await s.r.trigger()).toBe(true);
    expect(s.calls()).toBe(1);
  });

  it('分頁在背景不打；切回來就打', async () => {
    const s = setup(false);
    s.advance(25_000);
    expect(await s.r.trigger()).toBe(false);
    s.state.visible = true;
    expect(await s.r.trigger()).toBe(true);
  });

  it('切回分頁和計時器同時到 → 只打一次', async () => {
    const s = setup();
    s.advance(30_000);
    expect(await s.r.trigger()).toBe(true);
    s.advance(500);
    expect(await s.r.trigger()).toBe(false);
    expect(s.calls()).toBe(1);
  });

  it('上一次還沒回來就不打第二次', async () => {
    const s = setup();
    s.advance(30_000);
    s.holdNext();
    const first = s.r.trigger();
    s.advance(30_000);
    expect(await s.r.trigger()).toBe(false);
    s.finish();
    expect(await first).toBe(true);
    s.advance(30_000);
    expect(await s.r.trigger()).toBe(true);
    expect(s.calls()).toBe(2);
  });

  it('更新失敗不會卡住，下一輪照打', async () => {
    let n = 0;
    let t = 0;
    const r = createLiveRefresher(() => { n++; throw new Error('boom'); }, { now: () => t });
    t += 30_000;
    expect(await r.trigger()).toBe(true);
    t += 30_000;
    expect(await r.trigger()).toBe(true);
    expect(n).toBe(2);
  });
});

describe('專案看不到了就不再自動更新', () => {
  it('run 回 STOP_LIVE_REFRESH → 之後計時器到、切回分頁都不打', async () => {
    let t = 0;
    let n = 0;
    let gone = false;
    const r = createLiveRefresher(() => { n++; return gone ? STOP_LIVE_REFRESH : undefined; }, { now: () => t });
    t += 30_000;
    expect(await r.trigger()).toBe(true);
    expect(r.stopped).toBe(false);
    gone = true;  // 專案在這中間被封存了
    t += 30_000;
    expect(await r.trigger()).toBe(true);
    expect(r.stopped).toBe(true);
    for (let i = 0; i < 5; i++) {
      t += 30_000;
      expect(await r.trigger()).toBe(false);
    }
    expect(n).toBe(2);
  });

  it('stop() 之後不打；一般的失敗（網路 / 500）不會停', async () => {
    let t = 0;
    let n = 0;
    const r = createLiveRefresher(() => { n++; throw Object.assign(new Error('HTTP 500'), { status: 500 }); }, { now: () => t });
    t += 30_000;
    await r.trigger();
    t += 30_000;
    await r.trigger();
    expect(r.stopped).toBe(false);
    expect(n).toBe(2);
    r.stop();
    t += 30_000;
    expect(await r.trigger()).toBe(false);
    expect(n).toBe(2);
  });

  it('404（封存 / 刪除）、403（被移出專案）才算看不到了', () => {
    expect(isProjectGoneError(Object.assign(new Error('x'), { status: 404 }))).toBe(true);
    expect(isProjectGoneError(Object.assign(new Error('x'), { status: 403 }))).toBe(true);
    expect(isProjectGoneError(Object.assign(new Error('x'), { status: 500 }))).toBe(false);
    expect(isProjectGoneError(Object.assign(new Error('x'), { status: 401 }))).toBe(false);
    expect(isProjectGoneError(new Error('Failed to fetch'))).toBe(false);
    expect(isProjectGoneError(null)).toBe(false);
  });

  it('頁面要不要開自動更新：看不到了 / 已封存 / 還在第一次讀 → 不開', () => {
    expect(liveRefreshWanted({ gone: false })).toBe(true);
    expect(liveRefreshWanted({ gone: true })).toBe(false);
    expect(liveRefreshWanted({ gone: false, archived: true })).toBe(false);
    expect(liveRefreshWanted({ gone: false, loading: true })).toBe(false);
  });
});
