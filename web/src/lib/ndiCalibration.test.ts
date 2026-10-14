import { describe, expect, it } from 'vitest';
import {
  CHART_UNITS_H, CHART_UNITS_W, MARKER_CENTERS, calibrateFromFrame, chartPatches, findMarkers, locateChart, lutGreyError,
  renderChart, type RgbaFrame,
} from './ndiCalibration';
import { GREY_PATCHES, aeRawChain, defaultAeLut, fitCurve, identityColorLut } from './ndiColor';

// ─── 做假的「收到的畫面」：縮放 / 放進合成 / 經過 AE→NDI 的顏色 / JPEG ───

function frame(width: number, height: number, data?: Uint8ClampedArray): RgbaFrame {
  const d = data ?? new Uint8ClampedArray(width * height * 4);
  if (!data) for (let i = 3; i < d.length; i += 4) d[i] = 255;
  return { data: d, width, height };
}

/** 雙線性縮放（AE 放大縮小、小程序縮小都差不多是這樣） */
function resize(src: RgbaFrame, dw: number, dh: number): RgbaFrame {
  const out = frame(dw, dh);
  const sx = src.width / dw, sy = src.height / dh;
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(src.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(src.height - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(src.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(src.width - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const p = (xx: number, yy: number) => src.data[(yy * src.width + xx) * 4 + c];
        const top = p(x0, y0) * (1 - tx) + p(x1, y0) * tx;
        const bot = p(x0, y1) * (1 - tx) + p(x1, y1) * tx;
        out.data[(y * dw + x) * 4 + c] = top * (1 - ty) + bot * ty;
      }
    }
  }
  return out;
}

/** 放進一張黑底的畫面（合成比校正圖寬 → 兩邊黑邊） */
function place(src: RgbaFrame, w: number, h: number, left: number, top: number): RgbaFrame {
  const out = frame(w, h);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const o = ((y + top) * w + (x + left)) * 4, i = (y * src.width + x) * 4;
      out.data[o] = src.data[i]; out.data[o + 1] = src.data[i + 1]; out.data[o + 2] = src.data[i + 2];
    }
  }
  return out;
}

/** 量到的 AE → NDI（黑抬到 16）：照 owner 量的那條內插 */
const aeChain = aeRawChain;

function mapColors(f: RgbaFrame, fn: (v: number) => number): RgbaFrame {
  const out = frame(f.width, f.height, new Uint8ClampedArray(f.data));
  for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c++) out.data[i + c] = fn(f.data[i + c]);
  return out;
}

/** 像 JPEG：YCbCr、8×8 DCT、照品質量化（4:4:4 或 4:2:0） */
const LUMA_Q = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const CHROMA_Q = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, ...Array(32).fill(99)];
function fakeJpeg(f: RgbaFrame, quality: number, chroma420: boolean): RgbaFrame {
  const { width: w, height: h } = f;
  const scale = quality < 50 ? 5000 / quality : 200 - quality * 2;
  const qt = (t: number[]) => t.map(v => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
  const lq = qt(LUMA_Q), cq = qt(CHROMA_Q);
  const planes = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
  for (let i = 0; i < w * h; i++) {
    const r = f.data[i * 4], g = f.data[i * 4 + 1], b = f.data[i * 4 + 2];
    planes[0][i] = 0.299 * r + 0.587 * g + 0.114 * b;
    planes[1][i] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
    planes[2][i] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
  }
  if (chroma420) {
    for (const p of [planes[1], planes[2]]) {
      for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
        const xs = [x, Math.min(w - 1, x + 1)], ys = [y, Math.min(h - 1, y + 1)];
        let s = 0; for (const yy of ys) for (const xx of xs) s += p[yy * w + xx];
        for (const yy of ys) for (const xx of xs) p[yy * w + xx] = s / 4;
      }
    }
  }
  const cos = Array.from({ length: 64 }, (_, k) => Math.cos(((2 * (k % 8) + 1) * Math.floor(k / 8) * Math.PI) / 16));
  const C = (u: number) => (u === 0 ? Math.SQRT1_2 : 1);
  const block = new Float32Array(64), tmp = new Float32Array(64), coef = new Float32Array(64);
  planes.forEach((p, pi) => {
    const q = pi === 0 ? lq : cq;
    for (let by = 0; by < h; by += 8) for (let bx = 0; bx < w; bx += 8) {
      for (let i = 0; i < 64; i++) {
        const x = Math.min(w - 1, bx + (i % 8)), y = Math.min(h - 1, by + Math.floor(i / 8));
        block[i] = p[y * w + x] - 128;
      }
      // 正轉換（先直的再橫的）
      for (let v = 0; v < 8; v++) for (let x = 0; x < 8; x++) {
        let s = 0; for (let y = 0; y < 8; y++) s += block[y * 8 + x] * cos[v * 8 + y]; tmp[v * 8 + x] = s;
      }
      for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) {
        let s = 0; for (let x = 0; x < 8; x++) s += tmp[v * 8 + x] * cos[u * 8 + x];
        const qq = q[v * 8 + u];
        coef[v * 8 + u] = Math.round((0.25 * C(u) * C(v) * s) / qq) * qq;
      }
      // 反轉換
      for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) {
        let s = 0; for (let v = 0; v < 8; v++) s += C(v) * coef[v * 8 + u] * cos[v * 8 + y]; tmp[y * 8 + u] = s;
      }
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
        let s = 0; for (let u = 0; u < 8; u++) s += C(u) * tmp[y * 8 + u] * cos[u * 8 + x];
        const xx = bx + x, yy = by + y;
        if (xx < w && yy < h) p[yy * w + xx] = 0.25 * s + 128;
      }
    }
  });
  const out = frame(w, h);
  for (let i = 0; i < w * h; i++) {
    const Y = planes[0][i], cb = planes[1][i] - 128, cr = planes[2][i] - 128;
    out.data[i * 4] = Y + 1.402 * cr;
    out.data[i * 4 + 1] = Y - 0.344136 * cb - 0.714136 * cr;
    out.data[i * 4 + 2] = Y + 1.772 * cb;
  }
  return out;
}

const CHART_SMALL = frame(960, 540, renderChart(960, 540));

function expectInverts(f: RgbaFrame, chain: (v: number) => number, tol = 3) {
  const r = calibrateFromFrame(f, identityColorLut());
  if (!r.ok) throw new Error(r.message);
  for (const v of GREY_PATCHES) {
    const b = Math.round(chain(v));
    for (const ch of ['r', 'g', 'b'] as const) {
      expect(Math.abs(r.lut[ch][b] - v), `${ch} patch ${v} (收到 ${b} → ${r.lut[ch][b]})`).toBeLessThanOrEqual(tol);
    }
  }
  return r;
}

describe('校正圖', () => {
  it('16:9、四個角有定位記號、色塊的顏色對', () => {
    const d = renderChart(960, 540);
    expect(d.length).toBe(960 * 540 * 4);
    const px = (ux: number, uy: number) => {
      const x = Math.floor((ux * 960) / CHART_UNITS_W), y = Math.floor((uy * 540) / CHART_UNITS_H);
      return Array.from(d.slice((y * 960 + x) * 4, (y * 960 + x) * 4 + 3));
    };
    for (const [cx, cy] of MARKER_CENTERS) {
      expect(px(cx, cy)).toEqual([0, 0, 0]);       // 黑心
      expect(px(cx + 2, cy)).toEqual([255, 255, 255]); // 白框
      expect(px(cx + 3, cy)).toEqual([0, 0, 0]);   // 黑框
      expect(px(cx + 4.5, cy)).toEqual([255, 255, 255]); // 白邊
    }
    const patches = chartPatches();
    expect(patches.length).toBe(4 * GREY_PATCHES.length);
    for (const p of patches) expect(px(p.x + p.w / 2, p.y + p.h / 2)).toEqual(p.rgb);
  });

  it('原圖：找到四個定位記號，位置對', () => {
    const loc = findMarkers(CHART_SMALL)!;
    expect(loc).not.toBeNull();
    expect(loc.method).toBe('markers');
    loc.corners.forEach((c, i) => {
      const [ux, uy] = MARKER_CENTERS[i];
      expect(Math.abs(c.x - (ux * 960) / CHART_UNITS_W)).toBeLessThan(1);
      expect(Math.abs(c.y - (uy * 540) / CHART_UNITS_H)).toBeLessThan(1);
    });
  });
});

describe('從收到的畫面校正', () => {
  it('縮小 + AE→NDI 的顏色 + JPEG q75 4:2:0 → 每一格校回 ±3 以內', () => {
    const f = fakeJpeg(mapColors(resize(CHART_SMALL, 800, 450), aeChain), 75, true);
    const r = expectInverts(f, aeChain);
    expect(r.location.method).toBe('markers');
    expect(r.before.max).toBeGreaterThan(10); // 沒校正：黑抬到 16
    expect(r.after.max).toBeLessThanOrEqual(3);
  });

  it('合成比較寬、校正圖被拉長填滿（AE「符合合成」）+ JPEG q90 → 一樣找得到', () => {
    const f = fakeJpeg(mapColors(resize(CHART_SMALL, 1466, 337), aeChain), 90, false);
    expectInverts(f, aeChain);
  });

  it('合成比較寬、校正圖等比例放中間（兩邊黑邊）→ 一樣找得到', () => {
    const chart = resize(CHART_SMALL, 600, 337);
    const f = fakeJpeg(mapColors(place(chart, 1466, 337, 433, 0), aeChain), 90, false);
    const loc = locateChart(f)!;
    expect(loc.method).toBe('markers');
    expect(loc.corners[0].x).toBeGreaterThan(433);
    expectInverts(f, aeChain);
  });

  it('放大的（像 AE 用 Quarter 再放大送出來）也找得到', () => {
    const blocky = resize(resize(CHART_SMALL, 480, 270), 1920, 1080);
    expectInverts(fakeJpeg(mapColors(blocky, aeChain), 90, false), aeChain);
  });

  it('很小的畫面（320×180，一格不到 4 像素）+ JPEG q75 4:2:0 → 還是找得到', () => {
    expectInverts(fakeJpeg(mapColors(resize(CHART_SMALL, 320, 180), aeChain), 75, true), aeChain);
  });

  it('糊到找不到記號、但校正圖剛好填滿畫面 → 改用「填滿畫面」的位置', () => {
    // 先縮很小再放大：邊都糊掉了
    const blurry = mapColors(resize(resize(CHART_SMALL, 120, 68), 960, 540), aeChain);
    const loc = locateChart(blurry);
    expect(loc).not.toBeNull();
    const r = calibrateFromFrame(blurry, identityColorLut());
    expect(r.ok).toBe(true);
  });

  it('本來就對的鏈（假的 NDI 來源）→ 曲線幾乎不變', () => {
    const r = expectInverts(fakeJpeg(resize(CHART_SMALL, 800, 450), 90, false), v => v);
    expect(r.before.max).toBeLessThanOrEqual(3);
  });

  it('「校正前」用目前的曲線算：已經是預設曲線 → 校正前就差不多對', () => {
    const f = fakeJpeg(mapColors(resize(CHART_SMALL, 800, 450), aeChain), 90, false);
    const r = calibrateFromFrame(f, defaultAeLut());
    if (!r.ok) throw new Error(r.message);
    expect(r.before.max).toBeLessThanOrEqual(4);
    expect(lutGreyError(r.lut, r.readings)).toBeLessThanOrEqual(2);
  });

  it('畫面裡沒有校正圖 → 說找不到', () => {
    const f = frame(640, 360);
    for (let y = 0; y < 360; y++) for (let x = 0; x < 640; x++) {
      const o = (y * 640 + x) * 4; f.data[o] = x % 256; f.data[o + 1] = y % 256; f.data[o + 2] = (x * y) % 256;
    }
    const r = calibrateFromFrame(f, identityColorLut());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
  });

  it('被調過顏色（黑白差太少）→ 說不合理', () => {
    const flat = mapColors(CHART_SMALL, v => 100 + v * 0.2);
    const r = calibrateFromFrame(flat, identityColorLut());
    expect(r.ok).toBe(false);
  });

  it('擬合的曲線跟直接從真的鏈算的一樣（灰階）', () => {
    const truth = fitCurve(GREY_PATCHES.map(v => ({ input: v, measured: aeChain(v) })))!;
    const f = fakeJpeg(mapColors(resize(CHART_SMALL, 800, 450), aeChain), 90, false);
    const r = calibrateFromFrame(f, identityColorLut());
    if (!r.ok) throw new Error(r.message);
    for (const v of GREY_PATCHES) {
      const b = Math.round(aeChain(v));
      expect(Math.abs(r.lut.g[b] - truth[b])).toBeLessThanOrEqual(3);
    }
  });
});
