import { describe, it, expect } from 'vitest';
import { averageUvRect, srgb8ToLinear } from './ledColorSampler';

/** 建 w×h RGBA 影像；fill(x, y) 回傳 [r,g,b]（0~255），y = 0 是最上面一排 */
function img(w: number, h: number, fill: (x: number, y: number) => [number, number, number]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fill(x, y);
    const o = (y * w + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
  }
  return px;
}
const full = { u0: 0, v0: 0, u1: 1, v1: 1 };

describe('averageUvRect', () => {
  it('單色 → 那個顏色（線性）', () => {
    const c = averageUvRect(img(4, 2, () => [255, 0, 0]), 4, 2, full, false);
    expect(c[0]).toBeCloseTo(1);
    expect(c[1]).toBeCloseTo(0);
    expect(c[2]).toBeCloseTo(0);
  });

  it('只取 UV 範圍內：左半紅、右半藍，取左半 → 紅', () => {
    const px = img(4, 2, x => (x < 2 ? [255, 0, 0] : [0, 0, 255]));
    const c = averageUvRect(px, 4, 2, { u0: 0, v0: 0, u1: 0.5, v1: 1 }, false);
    expect(c[0]).toBeCloseTo(1);
    expect(c[2]).toBeCloseTo(0);
  });

  it('flipY：false 時 v=0 是最上排，true 時 v=0 是最下排', () => {
    const px = img(2, 2, (_x, y) => (y === 0 ? [0, 255, 0] : [0, 0, 0]));
    const topHalf = { u0: 0, v0: 0, u1: 1, v1: 0.5 };
    expect(averageUvRect(px, 2, 2, topHalf, false)[1]).toBeCloseTo(1);
    expect(averageUvRect(px, 2, 2, topHalf, true)[1]).toBeCloseTo(0);
  });

  it('跨邊界的範圍會繞回來', () => {
    const px = img(4, 1, x => (x === 0 || x === 3 ? [255, 255, 255] : [0, 0, 0]));
    const c = averageUvRect(px, 4, 1, { u0: 0.875, v0: 0, u1: 1.125, v1: 1 }, false);
    expect(c[0]).toBeCloseTo(1);
  });

  it('sRGB 轉線性', () => {
    expect(srgb8ToLinear(0)).toBe(0);
    expect(srgb8ToLinear(255)).toBeCloseTo(1);
    expect(srgb8ToLinear(128)).toBeCloseTo(0.2158, 3);
  });
});
