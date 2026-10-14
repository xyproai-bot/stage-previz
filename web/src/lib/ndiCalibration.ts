// 「校正 AE 即時顏色」：校正圖（畫出來）+ 在收到的畫面上找到校正圖、量每一格 + 擬合曲線。純邏輯，不碰 DOM，方便測試。
//
// 校正圖（固定 16:9，下載是 3840×2160 PNG；「格」= 高度的 1/54）：
//   - 黑底；四個角各一個定位記號（跟 QR code 角落一樣：黑框 1 格、白框 1 格、黑心 3 格，外面一圈 2 格白邊）
//   - 中間 4 排色塊 × 15 格：灰階、紅、綠、藍，值都是 GREY_PATCHES（0、8、16 … 255）
// 量：先找四個定位記號（一行一行掃，找「黑白黑白黑 = 1:1:3:1:1」，再直的確認一次），
//     所以校正圖在 AE 合成裡放大縮小、拉長、留黑邊都找得到；找不到再試「校正圖剛好填滿畫面」。
//     每一格取中間一塊、去掉最亮最暗的 10% 再平均（JPEG 的雜訊）。
// 擬合：每個色版用灰階那排 + 自己那排（紅 / 綠 / 藍）的量測點，fitCurve（只會往上的曲線）。

import { curveError, fitCurve, GREY_PATCHES, type ChannelLut, type CurveSample, type NdiColorLut } from './ndiColor';

/** 一張 RGBA 畫面（ImageData 的樣子） */
export interface RgbaFrame {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

// ─── 版面（單位：格；整張 96 × 54 格 = 16:9）───

export const CHART_UNITS_W = 96;
export const CHART_UNITS_H = 54;
/** 下載的校正圖大小（大合成放大也清楚） */
export const CHART_DOWNLOAD_SIZE = { width: 3840, height: 2160 } as const;
/** 定位記號中心離邊幾格（1 格邊 + 2 格白邊 + 3.5 格記號的一半） */
const MARKER_CENTER = 6.5;
/** 四個定位記號中心之間的距離（格） */
export const MARKER_SPAN_X = CHART_UNITS_W - 2 * MARKER_CENTER; // 83
export const MARKER_SPAN_Y = CHART_UNITS_H - 2 * MARKER_CENTER; // 41

export type PatchRow = 'grey' | 'red' | 'green' | 'blue';
export const PATCH_ROWS: readonly PatchRow[] = ['grey', 'red', 'green', 'blue'];

export interface PatchSpec {
  row: PatchRow;
  value: number;
  /** 色塊的 RGB */
  rgb: [number, number, number];
  /** 位置（格） */
  x: number;
  y: number;
  w: number;
  h: number;
}

const PATCH_TOP = 13;
const ROW_PITCH = 7;
const PATCH_LEFT = 1;
const COL_PITCH = (CHART_UNITS_W - 2 * PATCH_LEFT) / GREY_PATCHES.length;

export function chartPatches(): PatchSpec[] {
  const out: PatchSpec[] = [];
  PATCH_ROWS.forEach((row, k) => {
    GREY_PATCHES.forEach((v, j) => {
      const rgb: [number, number, number] =
        row === 'grey' ? [v, v, v] : row === 'red' ? [v, 0, 0] : row === 'green' ? [0, v, 0] : [0, 0, v];
      out.push({ row, value: v, rgb, x: PATCH_LEFT + j * COL_PITCH, y: PATCH_TOP + k * ROW_PITCH, w: COL_PITCH - 1, h: ROW_PITCH - 1 });
    });
  });
  return out;
}

/** 四個定位記號的中心（格）：左上、右上、左下、右下 */
export const MARKER_CENTERS: readonly [number, number][] = [
  [MARKER_CENTER, MARKER_CENTER],
  [CHART_UNITS_W - MARKER_CENTER, MARKER_CENTER],
  [MARKER_CENTER, CHART_UNITS_H - MARKER_CENTER],
  [CHART_UNITS_W - MARKER_CENTER, CHART_UNITS_H - MARKER_CENTER],
];

/** 畫校正圖（RGBA）。width/height 不是 16:9 也可以（會拉長，一樣量得到） */
export function renderChart(width: number = CHART_DOWNLOAD_SIZE.width, height: number = CHART_DOWNLOAD_SIZE.height): Uint8ClampedArray<ArrayBuffer> {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255; // 黑底、不透明
  const sx = width / CHART_UNITS_W;
  const sy = height / CHART_UNITS_H;
  const fill = (ux: number, uy: number, uw: number, uh: number, rgb: readonly number[]) => {
    const x0 = Math.round(ux * sx), x1 = Math.round((ux + uw) * sx);
    const y0 = Math.round(uy * sy), y1 = Math.round((uy + uh) * sy);
    for (let y = Math.max(0, y0); y < Math.min(height, y1); y++) {
      let o = (y * width + Math.max(0, x0)) * 4;
      for (let x = Math.max(0, x0); x < Math.min(width, x1); x++, o += 4) {
        data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2];
      }
    }
  };
  const W = [255, 255, 255], K = [0, 0, 0];
  for (const [cx, cy] of MARKER_CENTERS) {
    fill(cx - 5.5, cy - 5.5, 11, 11, W); // 白邊
    fill(cx - 3.5, cy - 3.5, 7, 7, K);   // 黑框
    fill(cx - 2.5, cy - 2.5, 5, 5, W);   // 白框
    fill(cx - 1.5, cy - 1.5, 3, 3, K);   // 黑心
  }
  for (const p of chartPatches()) fill(p.x, p.y, p.w, p.h, p.rgb);
  return data;
}

// ─── 找校正圖 ───

export interface Point { x: number; y: number }

export interface ChartLocation {
  /** 四個定位記號的中心（畫面像素）：左上、右上、左下、右下 */
  corners: [Point, Point, Point, Point];
  /** markers = 找到定位記號；fullFrame = 沒找到記號，但校正圖剛好填滿畫面 */
  method: 'markers' | 'fullFrame';
}

function luminance(f: RgbaFrame): Uint8Array {
  const n = f.width * f.height;
  const y = new Uint8Array(n);
  const d = f.data;
  for (let i = 0, o = 0; i < n; i++, o += 4) y[i] = (d[o] * 54 + d[o + 1] * 183 + d[o + 2] * 19) >> 8;
  return y;
}

/** Otsu：分成暗 / 亮兩群最好的門檻 */
function otsu(lum: Uint8Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < lum.length; i++) hist[lum[i]]++;
  const total = lum.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = -1, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr + 0.5;
}

/** 五段（暗亮暗亮暗）是不是 1:1:3:1:1 */
function finderRatio(r: readonly number[]): number | null {
  const total = r[0] + r[1] + r[2] + r[3] + r[4];
  if (total < 7) return null;
  const u = total / 7;
  const ok = (v: number, k: number) => Math.abs(v - k * u) <= 0.5 * u * Math.max(1, k * 0.75);
  return ok(r[0], 1) && ok(r[1], 1) && ok(r[2], 3) && ok(r[3], 1) && ok(r[4], 1) ? u : null;
}

/** 1 = 暗、0 = 亮、-1 = 出界 */
type Sampler = (x: number, y: number) => number;

/**
 * 從 (x, y)（黑心裡的一個像素）沿一個方向往兩邊數：黑心、白框、黑框 → 是 1:1:3:1:1 的話
 * 回傳 [黑心中心（像素座標，連續）, 一格幾像素]；不是記號 → null
 */
function crossCheck(sample: Sampler, x: number, y: number, dx: number, dy: number, limit: number): [number, number] | null {
  if (sample(x, y) !== 1) return null;
  const count = (sign: number): number[] | null => {
    const runs = [0, 0, 0];
    let state = 0; // 0 黑心 1 白框 2 黑框
    let px = x, py = y;
    for (let i = 0; i < limit; i++) {
      px += dx * sign; py += dy * sign;
      const d = sample(px, py);
      if (d < 0) return null;
      const want = state === 1 ? 0 : 1;
      if (d === want) { runs[state]++; continue; }
      if (state === 2) return runs; // 黑框結束（外面是白邊）
      state++;
      runs[state]++;
    }
    return null;
  };
  const a = count(-1), b = count(1);
  if (!a || !b) return null;
  const u = finderRatio([a[2], a[1], a[0] + 1 + b[0], b[1], b[2]]);
  if (u == null) return null;
  // 黑心是像素 [p − a0, p + b0] → 連續座標的中心 = p + 0.5 + (b0 − a0) / 2
  const p = dx ? x : y;
  return [p + 0.5 + (b[0] - a[0]) / 2, u];
}

interface Candidate { x: number; y: number; ux: number; uy: number; hits: number }

/** 找四個定位記號；找不到 → null */
export function findMarkers(frame: RgbaFrame): ChartLocation | null {
  const { width: w, height: h } = frame;
  if (w < 32 || h < 18) return null;
  const lum = luminance(frame);
  const thr = otsu(lum);
  const sample: Sampler = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : lum[y * w + x] < thr ? 1 : 0);
  const cands: Candidate[] = [];
  const maxRun = Math.max(w, h);
  for (let y = 0; y < h; y++) {
    // 一行的連續段（暗 / 亮）
    const runs: number[] = [];
    const colors: boolean[] = [];
    let cur = lum[y * w] < thr, len = 0;
    for (let x = 0; x <= w; x++) {
      const d = x < w ? lum[y * w + x] < thr : !cur;
      if (d === cur) { len++; continue; }
      runs.push(len); colors.push(cur);
      const n = runs.length;
      if (n >= 5 && colors[n - 1] && !colors[n - 2] && colors[n - 3] && !colors[n - 4] && colors[n - 5]) {
        const r = runs.slice(n - 5);
        const u = finderRatio(r);
        if (u != null) {
          // 黑心這一段是像素 [x − r4 − r3 − r2, x − r4 − r3)
          const centerX = x - r[4] - r[3] - r[2] / 2;
          const vc = crossCheck(sample, Math.floor(centerX), y, 0, 1, maxRun);
          if (vc) {
            const [cy, uy] = vc;
            const hc = crossCheck(sample, Math.floor(centerX), Math.floor(cy), 1, 0, maxRun);
            if (hc) {
              const [cx, ux] = hc;
              const hit = cands.find(c => Math.abs(c.x - cx) < 2 * Math.max(c.ux, ux) && Math.abs(c.y - cy) < 2 * Math.max(c.uy, uy));
              if (hit) {
                hit.x = (hit.x * hit.hits + cx) / (hit.hits + 1);
                hit.y = (hit.y * hit.hits + cy) / (hit.hits + 1);
                hit.ux = (hit.ux * hit.hits + ux) / (hit.hits + 1);
                hit.uy = (hit.uy * hit.hits + uy) / (hit.hits + 1);
                hit.hits++;
              } else {
                cands.push({ x: cx, y: cy, ux, uy, hits: 1 });
              }
            }
          }
        }
      }
      cur = d; len = 1;
    }
  }
  const good = cands.filter(c => c.hits >= 2);
  if (good.length < 4) return null;
  const pick = (score: (c: Candidate) => number) => good.reduce((a, b) => (score(b) > score(a) ? b : a));
  const tl = pick(c => -(c.x + c.y));
  const br = pick(c => c.x + c.y);
  const tr = pick(c => c.x - c.y);
  const bl = pick(c => c.y - c.x);
  const four = [tl, tr, bl, br];
  if (new Set(four).size < 4) return null;
  // 要排成長方形（差不多）
  const spanX = ((tr.x - tl.x) + (br.x - bl.x)) / 2;
  const spanY = ((bl.y - tl.y) + (br.y - tr.y)) / 2;
  if (spanX <= 0 || spanY <= 0) return null;
  if (Math.abs(tl.y - tr.y) > 0.06 * spanY || Math.abs(bl.y - br.y) > 0.06 * spanY) return null;
  if (Math.abs(tl.x - bl.x) > 0.06 * spanX || Math.abs(tr.x - br.x) > 0.06 * spanX) return null;
  // 間距（用記號的格子大小量）要跟校正圖一樣：橫 83 格、直 41 格（拉長、縮放都不會變）
  const ux = four.reduce((a, c) => a + c.ux, 0) / 4;
  const uy = four.reduce((a, c) => a + c.uy, 0) / 4;
  if (Math.abs(spanX / ux / MARKER_SPAN_X - 1) > 0.15 || Math.abs(spanY / uy / MARKER_SPAN_Y - 1) > 0.15) return null;
  return { corners: [pt(tl), pt(tr), pt(bl), pt(br)], method: 'markers' };
}

function pt(c: { x: number; y: number }): Point {
  return { x: c.x, y: c.y };
}

/** 校正圖剛好填滿畫面？（四個記號的位置點幾個點檢查：黑心、白框、黑框、白邊） */
function fullFrameLocation(frame: RgbaFrame): ChartLocation | null {
  const { width: w, height: h } = frame;
  const lum = luminance(frame);
  const thr = otsu(lum);
  const mx = w / CHART_UNITS_W, my = h / CHART_UNITS_H;
  const at = (ux: number, uy: number) => {
    const x = Math.min(w - 1, Math.max(0, Math.round(ux * mx))), y = Math.min(h - 1, Math.max(0, Math.round(uy * my)));
    return lum[y * w + x] < thr;
  };
  for (const [cx, cy] of MARKER_CENTERS) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (!at(cx, cy)) return null;
      if (at(cx + 2 * dx, cy + 2 * dy)) return null;      // 白框
      if (!at(cx + 3 * dx, cy + 3 * dy)) return null;     // 黑框
      if (at(cx + 4.5 * dx, cy + 4.5 * dy)) return null;  // 白邊
    }
  }
  const corners = MARKER_CENTERS.map(([cx, cy]) => ({ x: cx * mx, y: cy * my })) as [Point, Point, Point, Point];
  return { corners, method: 'fullFrame' };
}

export function locateChart(frame: RgbaFrame): ChartLocation | null {
  return findMarkers(frame) ?? fullFrameLocation(frame);
}

/** 校正圖上的位置（格）→ 畫面像素（四個角雙線性內插） */
export function chartToFrame(loc: ChartLocation, ux: number, uy: number): Point {
  const [tl, tr, bl, br] = loc.corners;
  const s = (ux - MARKER_CENTER) / MARKER_SPAN_X;
  const t = (uy - MARKER_CENTER) / MARKER_SPAN_Y;
  return {
    x: (1 - s) * (1 - t) * tl.x + s * (1 - t) * tr.x + (1 - s) * t * bl.x + s * t * br.x,
    y: (1 - s) * (1 - t) * tl.y + s * (1 - t) * tr.y + (1 - s) * t * bl.y + s * t * br.y,
  };
}

// ─── 量每一格 ───

export interface PatchReading extends PatchSpec {
  /** 量到的平均（RGB） */
  measured: [number, number, number];
  /** 量了幾個像素 */
  pixels: number;
}

/** 一塊裡面去掉最亮最暗的 10% 再平均（每個色版各自算） */
function trimmedMean(values: number[]): number {
  values.sort((a, b) => a - b);
  const cut = Math.floor(values.length * 0.1);
  const kept = values.slice(cut, values.length - cut);
  return kept.reduce((a, v) => a + v, 0) / Math.max(1, kept.length);
}

export function readPatches(frame: RgbaFrame, loc: ChartLocation): PatchReading[] | null {
  const out: PatchReading[] = [];
  for (const p of chartPatches()) {
    // 中間一半
    const a = chartToFrame(loc, p.x + p.w * 0.25, p.y + p.h * 0.25);
    const b = chartToFrame(loc, p.x + p.w * 0.75, p.y + p.h * 0.75);
    const x0 = Math.max(0, Math.ceil(Math.min(a.x, b.x))), x1 = Math.min(frame.width - 1, Math.floor(Math.max(a.x, b.x)));
    const y0 = Math.max(0, Math.ceil(Math.min(a.y, b.y))), y1 = Math.min(frame.height - 1, Math.floor(Math.max(a.y, b.y)));
    if (x1 < x0 || y1 < y0) return null;
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const o = (y * frame.width + x) * 4;
        rs.push(frame.data[o]); gs.push(frame.data[o + 1]); bs.push(frame.data[o + 2]);
      }
    }
    out.push({ ...p, measured: [trimmedMean(rs), trimmedMean(gs), trimmedMean(bs)], pixels: rs.length });
  }
  return out;
}

// ─── 擬合 + 前後比較 ───

export interface CalibrationResult {
  lut: NdiColorLut;
  readings: PatchReading[];
  location: ChartLocation;
  /** 灰階那排：原值、收到的（三色平均）、用原本的曲線、用新的曲線 */
  grey: { value: number; received: number; before: number; after: number }[];
  before: { max: number; mean: number };
  after: { max: number; mean: number };
}

export type CalibrationFailure =
  | { ok: false; reason: 'not_found'; message: string }
  | { ok: false; reason: 'too_small'; message: string }
  | { ok: false; reason: 'bad_range'; message: string };

const CHANNEL_INDEX = { r: 0, g: 1, b: 2 } as const;
const RAMP_FOR = { r: 'red', g: 'green', b: 'blue' } as const;

/** 每個色版的量測點：灰階那排 + 自己那排 */
export function channelSamples(readings: readonly PatchReading[], ch: 'r' | 'g' | 'b'): CurveSample[] {
  const i = CHANNEL_INDEX[ch];
  return readings
    .filter(p => p.row === 'grey' || p.row === RAMP_FOR[ch])
    .map(p => ({ input: p.value, measured: p.measured[i] }));
}

function lumOf(lut: NdiColorLut, rgb: readonly number[]): number {
  const c = (t: ChannelLut, v: number) => t[Math.min(255, Math.max(0, Math.round(v)))];
  return (c(lut.r, rgb[0]) + c(lut.g, rgb[1]) + c(lut.b, rgb[2])) / 3;
}

/**
 * 整套：找校正圖 → 量 → 每個色版擬合 → 算前後差幾階
 * current = 現在用的曲線（算「校正前」）
 */
export function calibrateFromFrame(frame: RgbaFrame, current: NdiColorLut): ({ ok: true } & CalibrationResult) | CalibrationFailure {
  const location = locateChart(frame);
  if (!location) {
    return { ok: false, reason: 'not_found', message: '畫面裡找不到校正圖（四個角的方形記號要看得到）' };
  }
  const readings = readPatches(frame, location);
  if (!readings || readings.some(r => r.pixels < 4)) {
    return { ok: false, reason: 'too_small', message: '校正圖在畫面裡太小，量不準：請放大到差不多填滿合成' };
  }
  const greyRow = readings.filter(r => r.row === 'grey');
  const black = greyRow[0].measured, white = greyRow[greyRow.length - 1].measured;
  const range = Math.min(white[0] - black[0], white[1] - black[1], white[2] - black[2]);
  if (range < 96) {
    return { ok: false, reason: 'bad_range', message: '校正圖的黑白差太少（被調過顏色或蓋了東西？）：請用原圖、不要加效果' };
  }
  const fits = (['r', 'g', 'b'] as const).map(ch => fitCurve(channelSamples(readings, ch)));
  if (fits.some(f => !f)) {
    return { ok: false, reason: 'bad_range', message: '量到的顏色不合理，請確認校正圖沒有被調過顏色' };
  }
  const lut: NdiColorLut = { r: fits[0]!, g: fits[1]!, b: fits[2]! };
  const grey = greyRow.map(p => ({
    value: p.value,
    received: (p.measured[0] + p.measured[1] + p.measured[2]) / 3,
    before: lumOf(current, p.measured),
    after: lumOf(lut, p.measured),
  }));
  const err = (key: 'before' | 'after') => {
    const d = grey.map(g => Math.abs(g[key] - g.value));
    return { max: Math.round(Math.max(...d)), mean: Math.round((d.reduce((a, v) => a + v, 0) / d.length) * 10) / 10 };
  };
  return { ok: true, lut, readings, location, grey, before: err('before'), after: err('after') };
}

/** 測試 / 顯示用：曲線在灰階量測點上差幾階（每個色版取最大） */
export function lutGreyError(lut: NdiColorLut, readings: readonly PatchReading[]): number {
  return Math.max(
    curveError(lut.r, channelSamples(readings, 'r')).max,
    curveError(lut.g, channelSamples(readings, 'g')).max,
    curveError(lut.b, channelSamples(readings, 'b')).max,
  );
}
