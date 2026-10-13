import { describe, it, expect } from 'vitest';
import { createLiveRefresher } from './liveRefresh';

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
