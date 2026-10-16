import { describe, expect, it } from 'vitest';
import {
  decideSync, driftSeconds, FLIP_MAX_DRIFT_S, HARD_SEEK_S, ledBadgeText, PAUSED_TOLERANCE_S, planVersionSwitch, SEEK_LEAD_S, standbyAllowed,
  SYNC_INTERVAL_MS, SYNC_TOLERANCE_S, type SyncInput,
} from './abLedSync';

const base: SyncInput = {
  masterTime: 10, masterDuration: 120, masterPaused: false, masterRate: 1, loop: true,
  standbyTime: 10, standbyPaused: false, standbyRate: 1, standbyReady: true,
};

describe('後面那一版跟著前面（decideSync）', () => {
  it('同步（差在 2 格內、都在播、速度一樣）→ 什麼都不動', () => {
    expect(decideSync(base)).toEqual({});
    expect(decideSync({ ...base, standbyTime: 10 + SYNC_TOLERANCE_S - 0.001 })).toEqual({});
    expect(decideSync({ ...base, standbyTime: 10 - SYNC_TOLERANCE_S + 0.001 })).toEqual({});
  });

  it('後面還沒準備好 → 什麼都不動（等載好）', () => {
    expect(decideSync({ ...base, standbyReady: false, standbyTime: 50, standbyPaused: true })).toEqual({});
  });

  it('前面暫停：後面也暫停，時間差超過半格就跳到同一格', () => {
    const paused = { ...base, masterPaused: true };
    expect(decideSync({ ...paused, standbyPaused: true })).toEqual({});
    expect(decideSync({ ...paused, standbyPaused: true, standbyTime: 10 + PAUSED_TOLERANCE_S - 0.001 })).toEqual({});
    expect(decideSync({ ...paused, standbyPaused: true, standbyTime: 10.05 })).toEqual({ seekTo: 10 });
    expect(decideSync({ ...paused, standbyPaused: false })).toEqual({ pause: true });
    expect(decideSync({ ...paused, standbyPaused: false, standbyTime: 12 })).toEqual({ pause: true, seekTo: 10 });
  });

  it('前面暫停時速度也跟著前面（回到播放才不會差一截）', () => {
    expect(decideSync({ ...base, masterPaused: true, standbyPaused: true, masterRate: 2, standbyRate: 1 })).toEqual({ rate: 2 });
  });

  it('前面在播、後面停著（剛按播放）→ 後面也開始播', () => {
    expect(decideSync({ ...base, standbyPaused: true })).toEqual({ play: true });
  });

  it('差一點點：微調速度追（後面快就慢一點、慢就快一點），不跳', () => {
    const ahead = decideSync({ ...base, standbyTime: 10.1 });
    expect(ahead.seekTo).toBeUndefined();
    expect(ahead.rate).toBeLessThan(1);
    const behind = decideSync({ ...base, standbyTime: 9.9 });
    expect(behind.seekTo).toBeUndefined();
    expect(behind.rate).toBeGreaterThan(1);
    // 最多調一成
    expect(decideSync({ ...base, standbyTime: 10.2 }).rate).toBeCloseTo(0.9, 5);
    expect(decideSync({ ...base, standbyTime: 9.8 }).rate).toBeCloseTo(1.1, 5);
  });

  it('差很多：直接跳到前面的位置（多抓一點）', () => {
    const a = decideSync({ ...base, standbyTime: 10 + HARD_SEEK_S + 0.5 });
    expect(a.seekTo).toBeCloseTo(10 + SEEK_LEAD_S, 5);
    const b = decideSync({ ...base, standbyTime: 3 });
    expect(b.seekTo).toBeCloseTo(10 + SEEK_LEAD_S, 5);
  });

  it('前面 2 倍速：跳過去多抓的量、微調的基準都照倍速', () => {
    const r = decideSync({ ...base, masterRate: 2, standbyRate: 2, standbyTime: 30 });
    expect(r.seekTo).toBeCloseTo(10 + SEEK_LEAD_S * 2, 5);
    expect(decideSync({ ...base, masterRate: 2, standbyRate: 1 })).toEqual({ rate: 2 });
  });

  it('循環播放：前面剛跳回開頭、後面還在結尾，不算差很多（不要白跳一次）', () => {
    const justWrapped = { ...base, masterTime: 0.1, masterDuration: 100, standbyTime: 99.95 };
    expect(driftSeconds(0.1, 99.95, 100, true)).toBeCloseTo(-0.15, 5);
    expect(decideSync(justWrapped).seekTo).toBeUndefined();
    const nearWrap = { ...base, masterTime: 99.95, masterDuration: 100, standbyTime: 0.02 };
    expect(driftSeconds(99.95, 0.02, 100, true)).toBeCloseTo(0.07, 5);
    expect(decideSync(nearWrap).seekTo).toBeUndefined();
    // 不循環的就是真的差很多
    expect(decideSync({ ...justWrapped, loop: false }).seekTo).toBeDefined();
  });

  it('模擬：後面一開始差 0.2 秒（兩邊的時鐘一樣快），每 200 毫秒檢查一次，幾秒內追到 2 格以內且沒有跳', () => {
    let master = 10, standby = 10.2, rate = 1;
    let seeks = 0;
    let within: number | null = null;
    for (let t = 0; t < 10_000; t += SYNC_INTERVAL_MS) {
      const act = decideSync({ ...base, masterTime: master, standbyTime: standby, standbyRate: rate });
      if (act.seekTo !== undefined) { standby = act.seekTo; seeks++; }
      if (act.rate !== undefined) rate = act.rate;
      master += SYNC_INTERVAL_MS / 1000;
      standby += (SYNC_INTERVAL_MS / 1000) * rate;
      if (within === null && Math.abs(standby - master) <= SYNC_TOLERANCE_S) within = t;
    }
    expect(seeks).toBe(0);
    expect(within).not.toBeNull();
    expect(within as number).toBeLessThanOrEqual(2000);
    expect(Math.abs(standby - master)).toBeLessThanOrEqual(SYNC_TOLERANCE_S);
  });

  it('模擬：後面落後 5 秒（剛載好、被拖時間軸）→ 跳一次，之後在 2 格以內', () => {
    let master = 40, standby = 35, rate = 1;
    let seeks = 0;
    for (let t = 0; t < 5000; t += SYNC_INTERVAL_MS) {
      const act = decideSync({ ...base, masterTime: master, standbyTime: standby, standbyRate: rate });
      if (act.seekTo !== undefined) { standby = act.seekTo; seeks++; }
      if (act.rate !== undefined) rate = act.rate;
      master += SYNC_INTERVAL_MS / 1000;
      standby += (SYNC_INTERVAL_MS / 1000) * rate;
    }
    expect(seeks).toBe(1);
    expect(Math.abs(standby - master)).toBeLessThanOrEqual(SYNC_TOLERANCE_S);
  });
});

describe('怎麼換到另一版（planVersionSwitch）', () => {
  const o = { targetKey: 'v:2', activeKey: 'v:3', standbyKey: 'v:2', standbyReady: true, drift: 0.02 };
  it('另一版就在後面、載好了、跟上了 → 馬上換', () => {
    expect(planVersionSwitch(o)).toBe('instant');
    expect(planVersionSwitch({ ...o, drift: -FLIP_MAX_DRIFT_S })).toBe('instant');
  });
  it('已經是這一版 → 不用換', () => {
    expect(planVersionSwitch({ ...o, targetKey: 'v:3' })).toBe('none');
  });
  it('還沒載好 / 還沒跟上 / 後面是別版 / 沒有後面（手機）→ 照原本的作法重新載入', () => {
    expect(planVersionSwitch({ ...o, standbyReady: false })).toBe('reload');
    expect(planVersionSwitch({ ...o, drift: FLIP_MAX_DRIFT_S + 0.01 })).toBe('reload');
    expect(planVersionSwitch({ ...o, drift: NaN })).toBe('reload');
    expect(planVersionSwitch({ ...o, standbyKey: 'v:1' })).toBe('reload');
    expect(planVersionSwitch({ ...o, standbyKey: null })).toBe('reload');
  });
});

describe('手機不同時放兩支影片', () => {
  it('手機不要；記憶體 4 GB 以下不要；電腦、iPad（Safari 不回報記憶體）要', () => {
    expect(standbyAllowed({ isPhone: true })).toBe(false);
    expect(standbyAllowed({ isPhone: false, deviceMemoryGb: 2 })).toBe(false);
    expect(standbyAllowed({ isPhone: false, deviceMemoryGb: 4 })).toBe(false);
    expect(standbyAllowed({ isPhone: false, deviceMemoryGb: 8 })).toBe(true);
    expect(standbyAllowed({ isPhone: false })).toBe(true);
    expect(standbyAllowed({ isPhone: false, deviceMemoryGb: null })).toBe(true);
    expect(standbyAllowed({ isPhone: false, deviceMemoryGb: 0 })).toBe(true);
  });
});

describe('LED 徽章', () => {
  it('比較中才有，寫現在 LED 放的是哪一版', () => {
    expect(ledBadgeText(true, 'V2')).toBe('LED：V2');
    expect(ledBadgeText(true, ' V3 ')).toBe('LED：V3');
    expect(ledBadgeText(false, 'V2')).toBeNull();
    expect(ledBadgeText(true, '')).toBeNull();
    expect(ledBadgeText(true, null)).toBeNull();
  });
});
