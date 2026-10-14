import { describe, it, expect } from 'vitest';
import {
  ledDot1D, ledDotMean1D, ledGridFill, ledGridMultiplier, ledLiveDisplay, ledViewCurve, neutralToneMap, outputPassLinear,
  smoothstepIntegral, smoothstep, type Vec3,
} from './ledColorMath';
import { linearToSrgb, srgbToLinear } from './colorAccuracy';
import { LED_SURFACE } from './ledSurface';

const EXPOSURES = [0.2, 0.5, 0.95, 1, 1.6, 3];

/** 0..1 每格 1/16 的所有 RGB 組合（17³ 個） */
function* rgbGrid(step = 1 / 16): Generator<Vec3> {
  const n = Math.round(1 / step);
  for (let r = 0; r <= n; r++) for (let g = 0; g <= n; g++) for (let b = 0; b <= n; b++) yield [r * step, g * step, b * step];
}

const to8 = (v: number) => Math.round(Math.min(1, Math.max(0, linearToSrgb(v))) * 255);

describe('LED 顏色照原檔：原檔 → LED shader → 最後輸出，正面看 = 原檔', () => {
  it('沒有反光、沒有光暈：任何顏色、任何曝光都一模一樣回來（來回一趟）', () => {
    for (const e of EXPOSURES) {
      for (const c of rgbGrid()) {
        const stored = ledLiveDisplay(c, [0, 0, 0], e);
        const out = outputPassLinear(stored, 1, [0, 0, 0], e);
        for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(c[i], 12);
      }
    }
  });

  it('8 位元 sRGB 每一階（0~255 灰階、原色）都回到同一階', () => {
    for (let v = 0; v <= 255; v++) {
      for (const pick of [[1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0]]) {
        const c = pick.map(k => k * srgbToLinear(v / 255)) as Vec3;
        const out = outputPassLinear(ledLiveDisplay(c, [0, 0, 0], 0.95), 1, [0, 0, 0], 0.95);
        expect(out.map(to8)).toEqual(c.map(to8));
      }
    }
  });

  it('舞台其他地方（alpha 1）照舊：Neutral tone mapping + 曝光', () => {
    const c: Vec3 = [0.3, 0.6, 0.9];
    expect(outputPassLinear(c, 0, [0, 0, 0], 0.95)).toEqual(neutralToneMap(c, 0.95));
  });

  it('以前（全部壓色）：灰 64 → 33、白 → 238、紅的綠藍變 27（這就是畫面發灰的原因）', () => {
    const g64 = srgbToLinear(64 / 255);
    expect(to8(neutralToneMap([g64, g64, g64], 0.95)[0])).toBe(33);
    expect(to8(neutralToneMap([1, 1, 1], 0.95)[0])).toBe(238);
    const red = neutralToneMap([1, 0, 0], 0.95).map(to8);
    expect(red[0]).toBe(239);
    expect(red[1]).toBe(27);
  });

  it('為什麼不能在 LED shader 裡反算 Neutral：很亮的純紅不管送多亮進去，綠 / 藍都不是 0', () => {
    let bestPeak = 0;
    for (let r = 0.76; r < 1000; r *= 1.05) {
      const [R, G] = neutralToneMap([r, 0, 0], 1);
      // 要 R 夠亮（≥ 250/255）的時候，G 一定已經被拉起來
      if (to8(R) >= 250) expect(to8(G)).toBeGreaterThan(40);
      bestPeak = Math.max(bestPeak, R);
    }
    expect(bestPeak).toBeLessThan(1);
  });
});

describe('LED 表面反光：照相機曲線多亮了多少', () => {
  const surfaces: Vec3[] = [[0.002, 0.002, 0.002], [0.01, 0.02, 0.005], [0.05, 0.05, 0.05], [0.3, 0.1, 0.0]];

  it('只會變亮、加的光不會比反光本身多（相機曲線的斜率最多 = 曝光）', () => {
    for (const s of surfaces) {
      const sMax = Math.max(...s);
      for (const c of rgbGrid(1 / 8)) {
        const d = ledLiveDisplay(c, s, 0.95);
        for (let i = 0; i < 3; i++) {
          expect(d[i]).toBeGreaterThanOrEqual(c[i] - 1e-12);
          // 亮的地方相機曲線會把顏色往白拉，所以用最亮的那個色版的反光當上限
          expect(d[i] - c[i]).toBeLessThanOrEqual(sMax * 0.95 + 1e-9);
        }
      }
    }
  });

  it('黑畫面的反光 = 舞台其他地方看到同樣的光（跟以前一樣被相機曲線壓）', () => {
    for (const s of surfaces) {
      const d = ledLiveDisplay([0, 0, 0], s, 0.95);
      const stage = neutralToneMap(s, 0.95);
      for (let i = 0; i < 3; i++) expect(d[i]).toBeCloseTo(Math.max(stage[i], 0), 12);
    }
  });

  it('亮的畫面幾乎不會被反光墊高（灰 128 以上 + 一般反光 → 差不到 1 階）', () => {
    for (let v = 128; v <= 255; v += 16) {
      const c = srgbToLinear(v / 255);
      const d = ledLiveDisplay([c, c, c], [0.004, 0.004, 0.004], 0.95);
      expect(Math.abs(to8(d[0]) - v)).toBeLessThanOrEqual(1);
    }
  });

  it('光暈加在 LED 上 = 照相機曲線多亮了多少（黑的地方跟旁邊舞台一樣亮）', () => {
    const bloom: Vec3 = [0.02, 0.02, 0.02];
    const onLed = outputPassLinear([0, 0, 0], 1, bloom, 0.95);
    const onStage = outputPassLinear([0, 0, 0], 0, bloom, 0.95);
    for (let i = 0; i < 3; i++) expect(onLed[i]).toBeCloseTo(onStage[i], 12);
  });
});

describe('像素格：一格的平均 = 原檔', () => {
  /** 數值積分：一個方向在一格裡的平均 */
  const numericMean = (half: number, aa: number, n = 20000) => {
    let s = 0;
    for (let k = 0; k < n; k++) {
      const x = (k + 0.5) / n;
      s += ledDot1D(Math.abs(x - 0.5), half, aa);
    }
    return s / n;
  };

  it('smoothstep 的積分公式對（跟數值積分比）', () => {
    for (const [e0, e1] of [[0.1, 0.3], [-0.2, 0.4], [0.3, 0.9]]) {
      for (const x of [-1, 0, 0.15, 0.25, 0.5, 1]) {
        let s = 0;
        const n = 20000, lo = Math.min(e0, x) - 1;
        for (let k = 0; k < n; k++) {
          const t = lo + ((k + 0.5) / n) * (x - lo);
          s += smoothstep(e0, e1, t) * ((x - lo) / n);
        }
        expect(smoothstepIntegral(e0, e1, x)).toBeCloseTo(x <= lo ? 0 : s, 4);
      }
    }
  });

  it('解析的平均 = 數值積分（邊緣模糊從很細到超出格子邊）', () => {
    const half = 0.5 * LED_SURFACE.gridFill;
    for (const aa of [0.02, 0.05, 0.1, 0.14, 0.2, 0.3, 0.36, 0.45, 0.5]) {
      expect(ledDotMean1D(half, aa)).toBeCloseTo(numericMean(half, aa), 5);
    }
  });

  it('模糊沒超出格子邊時平均就是填滿比例（0.72）', () => {
    expect(ledDotMean1D(0.36, 0.02)).toBeCloseTo(0.72, 12);
    expect(ledDotMean1D(0.36, 0.14)).toBeCloseTo(0.72, 12);
  });

  it('倍數在一格裡平均 = 1、最亮那點不超過 1（亮的畫面縫裡補光，不會被截掉）', () => {
    const half = 0.5 * LED_SURFACE.gridFill;
    for (const aa of [0.02, 0.1, 0.3, 0.5]) {
      const m1 = ledDotMean1D(half, aa);
      const mean = m1 * m1;
      for (const peak of [0.01, 0.2, 0.5, mean, 0.6, 0.8, 0.95, 1]) {
        const n = 400;
        let s = 0, maxOut = 0;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
          const dot = ledDot1D(Math.abs((i + 0.5) / n - 0.5), half, aa) * ledDot1D(Math.abs((j + 0.5) / n - 0.5), half, aa);
          const k = ledGridMultiplier(dot, mean, peak);
          s += k;
          maxOut = Math.max(maxOut, k * peak);
        }
        expect(s / (n * n)).toBeCloseTo(1, 3);
        expect(maxOut).toBeLessThanOrEqual(Math.max(1, peak) + 1e-3);
      }
    }
  });

  it('暗的畫面不補光（格子最清楚），全亮時整格一樣亮', () => {
    expect(ledGridFill(0.1, 0.52)).toBe(0);
    expect(ledGridFill(0.52, 0.52)).toBe(0);
    expect(ledGridFill(1, 0.52)).toBeCloseTo(1, 12);
    expect(ledGridFill(2, 0.52)).toBe(1);
  });
});

describe('側看變暗', () => {
  it('正面 ±20° 以內完全不變', () => {
    for (const deg of [0, 5, 10, 15, 19.9]) expect(ledViewCurve(Math.cos((deg * Math.PI) / 180))).toBe(1);
  });
  it('越斜越暗', () => {
    let prev = 1;
    for (const deg of [25, 35, 45, 60, 75, 89]) {
      const v = ledViewCurve(Math.cos((deg * Math.PI) / 180));
      expect(v).toBeLessThan(prev);
      prev = v;
    }
  });
});
