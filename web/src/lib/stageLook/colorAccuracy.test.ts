import { describe, it, expect } from 'vitest';
import {
  CHART_HEIGHT, CHART_PATCHES, CHART_WIDTH, averageRgbLinear, comparePatch, deltaE2000, helperLimitedToFull, linearToSrgb,
  patchCenterUv, patchIndex, simulateHelperFrame, srgb8ToLab, srgbToLinear, summarize, type Lab,
} from './colorAccuracy';

describe('ΔE2000（Sharma, Wu, Dalal 2005 的測試資料）', () => {
  const cases: [Lab, Lab, number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
    [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
    [[90.9257, -0.5406, -0.9208], [88.6381, -0.8985, -0.7239], 1.5381],
  ];
  it.each(cases)('%j vs %j = %d', (a, b, de) => {
    expect(deltaE2000(a, b)).toBeCloseTo(de, 3);
    expect(deltaE2000(b, a)).toBeCloseTo(de, 3);
  });
  it('一樣的顏色 = 0', () => {
    expect(deltaE2000([40, 10, -20], [40, 10, -20])).toBe(0);
  });
});

describe('sRGB / Lab', () => {
  it('sRGB ↔ linear 來回一樣', () => {
    for (let v = 0; v <= 255; v++) expect(linearToSrgb(srgbToLinear(v / 255)) * 255).toBeCloseTo(v, 9);
  });
  it('白 = L 100、黑 = L 0、灰 a b ≈ 0', () => {
    expect(srgb8ToLab([255, 255, 255])[0]).toBeCloseTo(100, 2);
    expect(srgb8ToLab([0, 0, 0])[0]).toBeCloseTo(0, 6);
    const g = srgb8ToLab([128, 128, 128]);
    expect(Math.abs(g[1])).toBeLessThan(0.01);
    expect(Math.abs(g[2])).toBeLessThan(0.01);
  });
});

describe('色卡', () => {
  it('50 格、灰階 0…240 每 16 一格 + 255', () => {
    expect(CHART_PATCHES.length).toBe(50);
    const greys = CHART_PATCHES.filter(p => p.group === 'grey').map(p => p.rgb[0]);
    expect(greys).toEqual([0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255]);
    expect(CHART_WIDTH / CHART_HEIGHT).toBe(2);
    expect(CHART_HEIGHT).toBeGreaterThanOrEqual(720);
  });
  it('名字不重複，找得到', () => {
    expect(new Set(CHART_PATCHES.map(p => p.name)).size).toBe(CHART_PATCHES.length);
    expect(patchIndex('灰 255')).toBe(16);
    expect(patchCenterUv(0)).toEqual([0.05, 0.1]);
  });
});

describe('NDI 小程序的處理（照 ndi-helper/src/ndi.rs）', () => {
  it('limited→full：16 → 0、235 → 255、中間拉開', () => {
    expect(helperLimitedToFull(0)).toBe(0);
    expect(helperLimitedToFull(16)).toBe(0);
    expect(helperLimitedToFull(235)).toBe(255);
    expect(helperLimitedToFull(255)).toBe(255);
    expect(helperLimitedToFull(128)).toBe(130);
    // 已經是 full range 的畫面再拉一次：0~16 全黑、235~255 全白（暗部和亮部的層次不見）
    expect(new Set([0, 4, 8, 12, 16].map(helperLimitedToFull)).size).toBe(1);
  });
  it('2 倍縮小 = 四格平均（無條件捨去），不拉的時候顏色不變', () => {
    const w = 4, h = 2;
    const src = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) src.set([10 + i, 20, 30, 255], i * 4);
    const out = simulateHelperFrame(src, w, h, { downsample: true, limitedToFull: false });
    expect(out.width).toBe(2);
    expect(out.height).toBe(1);
    expect([...out.data.slice(0, 4)]).toEqual([(10 + 11 + 14 + 15) >> 2, 20, 30, 255]);
    const same = simulateHelperFrame(src, w, h, { downsample: false, limitedToFull: false });
    expect([...same.data]).toEqual([...src]);
  });
});

describe('誤差摘要', () => {
  it('完全一樣 → 達標；灰階差 4 階 → 不達標', () => {
    const exact = CHART_PATCHES.map(p => comparePatch(p, p.rgb));
    expect(summarize(exact).pass).toBe(true);
    expect(summarize(exact).greyMaxAbs).toBe(0);
    const off = CHART_PATCHES.map(p => comparePatch(p, p.group === 'grey' ? p.rgb.map(v => Math.min(255, v + 4)) : p.rgb));
    expect(summarize(off).pass).toBe(false);
    expect(comparePatch(CHART_PATCHES[3], [44, 48, 48]).maxDiff).toBe(-4);
  });
  it('像素格的光平均：一半黑一半 255 → 不是 128，是 linear 的一半（188）', () => {
    const d = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    expect(Math.round(averageRgbLinear(d, 2, 0, 0, 2, 1)[0])).toBe(188);
  });
});
