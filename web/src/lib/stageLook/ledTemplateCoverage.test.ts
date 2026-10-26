// 沒有影片、只顯示測試圖時的版型：放了的螢幕原位置取色（不搬、不轉），沒放的物件 count = 0（shader 畫黑）、燈光不取色
import { describe, expect, it } from 'vitest';
import { buildCoverageUniforms, coverageRemap } from './ledTemplateCoverage';
import type { LedTemplatePlan, Placement, SrcSpan } from '../ledTemplate';

const plc = (objectId: string, over: Partial<Placement> = {}): Placement => ({
  key: `o:${objectId}`, objectId, uv: null, dest: { x: 100, y: 0, w: 200, h: 50 }, rotate: 90, flipH: true, flipV: false, ...over,
});
const PLAN: LedTemplatePlan = {
  v: 1, id: 'main', name: 'Main LED', canvas: { width: 400, height: 100 }, scalePct: 100,
  screens: [plc('wall')],
};
const WALL: SrcSpan = { us: 0.1, ul: 0.3, vs: 0.5, vl: 0.25 };
const srcFor = (): SrcSpan => WALL;

describe('buildCoverageUniforms', () => {
  it('版型放了的螢幕：目的地 = 自己原本的範圍、不轉不翻（測試圖不搬位置）', () => {
    const d = buildCoverageUniforms(PLAN, 'wall', srcFor);
    expect(d.count).toBe(1);
    expect(d.src.slice(0, 4)).toEqual([0.1, 0.5, 0.3, 0.25]);
    expect(d.dst.slice(0, 4)).toEqual([0.1, 0.5, 0.1 + 0.3, 0.5 + 0.25]);
    expect(d.mat.slice(0, 4)).toEqual([1, 0, 0, 1]);
    expect(d.off.slice(0, 2)).toEqual([0, 0]);
    expect(d.half).toEqual([0, 0]);
  });

  it('照 shader 的算法取色：螢幕上每一點取到的還是原本的 UV（測試圖一個像素都不動）', () => {
    const d = buildCoverageUniforms(PLAN, 'wall', srcFor);
    // ledSurface.ts LED_EMISSIVE_MAP 的版型那段（第一塊）
    const sample = (u: number, v: number) => {
      const [sx, sy, sw, sh] = d.src;
      const dx = u - sx - Math.floor(u - sx + 1e-5), dy = v - sy - Math.floor(v - sy + 1e-5);
      const lx = Math.min(1, Math.max(0, dx / sw)), ly = Math.min(1, Math.max(0, dy / sh));
      const [a, b, c, e] = d.mat;
      const tx = a * lx + b * ly + d.off[0], ty = c * lx + e * ly + d.off[1];
      const [x0, y0, x1, y1] = d.dst;
      return [x0 + (x1 - x0) * tx, y0 + (y1 - y0) * ty];
    };
    for (const [u, v] of [[0.1, 0.5], [0.25, 0.6], [0.4, 0.75], [0.33, 0.51]]) {
      const [su, sv] = sample(u, v);
      expect(su).toBeCloseTo(u, 9);
      expect(sv).toBeCloseTo(v, 9);
    }
  });

  it('版型沒放的物件（例如地板）：count = 0 → 整個黑', () => {
    expect(buildCoverageUniforms(PLAN, 'floor', srcFor).count).toBe(0);
  });

  it('找不到範圍的螢幕不算', () => {
    expect(buildCoverageUniforms(PLAN, 'wall', () => null).count).toBe(0);
  });
});

describe('coverageRemap', () => {
  it('螢幕上的一小塊照原位置取色；螢幕外 / 沒放的物件 = null（不打光）', () => {
    const r = { u0: 0.2, v0: 0.6, u1: 0.25, v1: 0.65 };
    expect(coverageRemap(PLAN, 'wall', srcFor)(r)).toEqual(r);
    expect(coverageRemap(PLAN, 'wall', srcFor)({ u0: 0.8, v0: 0.1, u1: 0.85, v1: 0.15 })).toBeNull();
    expect(coverageRemap(PLAN, 'floor', srcFor)(r)).toBeNull();
  });
});
