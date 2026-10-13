import { describe, it, expect } from 'vitest';
import { AdaptiveQuality, QUALITY, QUALITY_LEVELS, detectQualityProfile, type QualityLevel } from './quality';

const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

describe('detectQualityProfile', () => {
  it('桌機多核心 → high', () => {
    expect(detectQualityProfile({ maxTouchPoints: 0, hardwareConcurrency: 16, userAgent: WIN })).toBe('high');
  });
  it('iPadOS（偽裝成 Mac + 有觸控）→ low', () => {
    expect(detectQualityProfile({ maxTouchPoints: 5, hardwareConcurrency: 8, userAgent: MAC })).toBe('low');
  });
  it('舊 iPad UA → low', () => {
    expect(detectQualityProfile({ maxTouchPoints: 5, hardwareConcurrency: 6, userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)' })).toBe('low');
  });
  it('4 核心以下 → low', () => {
    expect(detectQualityProfile({ maxTouchPoints: 0, hardwareConcurrency: 4, userAgent: WIN })).toBe('low');
  });
  it('低畫質檔不畫地板倒影', () => {
    expect(QUALITY.low.reflectionScale).toBe(0);
    expect(QUALITY.high.reflectionScale).toBeGreaterThan(0);
  });
  it('真 Mac（沒觸控）→ high', () => {
    expect(detectQualityProfile({ maxTouchPoints: 0, hardwareConcurrency: 10, userAgent: MAC })).toBe('high');
  });
});

describe('QUALITY 等級', () => {
  it('一級比一級省：燈越少、環境光越慢、解析度 / bloom / 倒影不會變高', () => {
    for (let i = 1; i < QUALITY_LEVELS.length; i++) {
      const a = QUALITY[QUALITY_LEVELS[i - 1]];
      const b = QUALITY[QUALITY_LEVELS[i]];
      expect(b.maxLights).toBeLessThan(a.maxLights);
      expect(b.envIntervalMs).toBeGreaterThan(a.envIntervalMs);
      expect(b.pixelRatioCap).toBeLessThanOrEqual(a.pixelRatioCap);
      expect(b.bloomScale).toBeLessThanOrEqual(a.bloomScale);
      expect(b.reflectionScale).toBeLessThanOrEqual(a.reflectionScale);
    }
  });
  it('最低：沒倒影、沒 bloom、解析度 1', () => {
    expect(QUALITY.minimal).toMatchObject({ reflectionScale: 0, bloomScale: 0, pixelRatioCap: 1 });
  });
});

/** 用固定 fps 跑一段時間；回傳每次換等級的 [時間, 新等級] */
function run(q: AdaptiveQuality, clock: { t: number }, fps: number, durationMs: number) {
  const changes: [number, QualityLevel][] = [];
  const dt = 1000 / fps;
  const end = clock.t + durationMs;
  while (clock.t < end) {
    clock.t += dt;
    const next = q.frame(clock.t, dt);
    if (next) changes.push([clock.t, next]);
  }
  return changes;
}

describe('AdaptiveQuality', () => {
  it('一直 60fps → 不動', () => {
    const q = new AdaptiveQuality('high');
    const clock = { t: 0 };
    expect(run(q, clock, 60, 60000)).toEqual([]);
    expect(q.level).toBe('high');
  });

  it('掉到 30fps：量滿 1 秒 + 持續 3 秒 → 降一級；一直卡就一路降到最低，不會再往下', () => {
    const q = new AdaptiveQuality('high');
    const clock = { t: 0 };
    const changes = run(q, clock, 30, 30000);
    expect(changes.map((c) => c[1])).toEqual(['medium', 'low', 'minimal']);
    // 第一次大約 4 秒（1 秒量 + 3 秒持續），之後每次再多等 1 秒（換完先等穩）
    expect(changes[0][0]).toBeGreaterThanOrEqual(4000);
    expect(changes[0][0]).toBeLessThan(4200);
    expect(changes[1][0] - changes[0][0]).toBeGreaterThanOrEqual(5000);
    expect(q.level).toBe('minimal');
  });

  it('40~55fps 之間 → 不動（緩衝區，不會跳來跳去）', () => {
    const q = new AdaptiveQuality('high');
    const clock = { t: 0 };
    expect(run(q, clock, 48, 60000)).toEqual([]);
  });

  it('卡一下（單一長幀）不會降', () => {
    const q = new AdaptiveQuality('high');
    const clock = { t: 0 };
    run(q, clock, 60, 3000);
    clock.t += 600;
    expect(q.frame(clock.t, 600)).toBeNull();
    expect(run(q, clock, 60, 10000)).toEqual([]);
  });

  it('變順了：高於 55fps 持續 10 秒 → 升一級，最多回到一開始的等級', () => {
    const q = new AdaptiveQuality('high');
    const clock = { t: 0 };
    run(q, clock, 30, 10000);
    expect(q.level).toBe('low');
    const smoothFrom = clock.t;
    const up = run(q, clock, 60, 60000);
    expect(up.map((c) => c[1])).toEqual(['medium', 'high']);
    expect(up[0][0] - smoothFrom).toBeGreaterThanOrEqual(10000);
    expect(q.level).toBe('high');
  });

  it('一開始是 low（iPad）→ 再順也不會升到 low 以上', () => {
    const q = new AdaptiveQuality('low');
    const clock = { t: 0 };
    expect(run(q, clock, 60, 60000)).toEqual([]);
    expect(q.level).toBe('low');
  });

  it('剛升級就又卡 → 那一級太重，之後不再升上去（不會一直跳來跳去）', () => {
    const q = new AdaptiveQuality('high');
    const clock = { t: 0 };
    run(q, clock, 30, 4500);
    expect(q.level).toBe('medium');
    // medium 很順 → 升回 high
    expect(run(q, clock, 60, 12000).map((c) => c[1])).toEqual(['high']);
    // high 又卡 → 降回 medium，high 被記成太重
    expect(run(q, clock, 30, 5000).map((c) => c[1])).toEqual(['medium']);
    expect(q.ceiling).toBe('medium');
    expect(run(q, clock, 60, 60000)).toEqual([]);
    expect(q.level).toBe('medium');
    // 切模式（情況變了）→ 可以再試
    q.resetCeiling();
    expect(run(q, clock, 60, 12000).map((c) => c[1])).toEqual(['high']);
  });

  it('hold 期間的幀不算（載入模型、切模式）', () => {
    const q = new AdaptiveQuality('high');
    const clock = { t: 0 };
    q.hold(0, 4000);
    expect(run(q, clock, 10, 4000)).toEqual([]);
    // hold 結束後才開始量 → 再 4 秒才降
    const changes = run(q, clock, 10, 5000);
    expect(changes.length).toBe(1);
    expect(changes[0][0]).toBeGreaterThanOrEqual(8000);
  });

  it('兩幀間隔很久（分頁藏起來又切回來）→ 重新量，不算卡', () => {
    const q = new AdaptiveQuality('high');
    const clock = { t: 0 };
    run(q, clock, 30, 3500);
    clock.t += 5000;
    expect(q.frame(clock.t, 5000)).toBeNull();
    // 重新量：要再 4 秒才降（而不是馬上）
    const changes = run(q, clock, 30, 3900);
    expect(changes).toEqual([]);
    expect(run(q, clock, 30, 300).map((c) => c[1])).toEqual(['medium']);
  });

  it('平均是看最近 2 秒：卡過一陣子又恢復 → 計時重來', () => {
    const q = new AdaptiveQuality('high');
    const clock = { t: 0 };
    run(q, clock, 30, 3000);   // 卡了 2 秒（量滿 1 秒後開始算）
    run(q, clock, 60, 3000);   // 恢復 → 平均回到 60
    expect(run(q, clock, 30, 3500)).toEqual([]);  // 又卡：要重新等滿 3 秒
    expect(q.level).toBe('high');
  });
});
