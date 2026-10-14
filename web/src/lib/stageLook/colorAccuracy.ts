// LED 顏色準不準的量測工具（給 web/scripts/led-color-accuracy.mjs + src/dev/ledColorHarness.tsx 用，也有單元測試）
//   - 色卡：灰階 0, 16, 32 … 240, 255、原色 / 補色、75% 彩條、膚色、Macbeth 色票
//   - sRGB ↔ linear、sRGB → CIELAB（D65）、ΔE2000（Sharma 2005）
//   - NDI 小程序的處理（2 倍縮小 + limited→full 查表），照 ndi-helper/src/ndi.rs 一模一樣算
//   - 每一格的誤差、整體摘要（灰階最大差幾階、彩色 ΔE 最大 / 平均）
// 這裡不碰 three / DOM（畫色卡的函式只要一個 2D context），可以直接測。

export type Rgb8 = [number, number, number];

export type PatchGroup = 'grey' | 'primary' | 'bar75' | 'skin' | 'macbeth';

export interface ChartPatch {
  name: string;
  group: PatchGroup;
  rgb: Rgb8;
}

const grey = (v: number): ChartPatch => ({ name: `灰 ${v}`, group: 'grey', rgb: [v, v, v] });

/** 10 × 5 = 50 格。灰階 17 格（0…240 每 16 一格 + 255） */
export const CHART_PATCHES: readonly ChartPatch[] = [
  ...[0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240, 255].map(grey),
  { name: '紅', group: 'primary', rgb: [255, 0, 0] },
  { name: '綠', group: 'primary', rgb: [0, 255, 0] },
  { name: '藍', group: 'primary', rgb: [0, 0, 255] },
  { name: '青', group: 'primary', rgb: [0, 255, 255] },
  { name: '洋紅', group: 'primary', rgb: [255, 0, 255] },
  { name: '黃', group: 'primary', rgb: [255, 255, 0] },
  { name: '75% 白', group: 'bar75', rgb: [191, 191, 191] },
  { name: '75% 黃', group: 'bar75', rgb: [191, 191, 0] },
  { name: '75% 青', group: 'bar75', rgb: [0, 191, 191] },
  { name: '75% 綠', group: 'bar75', rgb: [0, 191, 0] },
  { name: '75% 洋紅', group: 'bar75', rgb: [191, 0, 191] },
  { name: '75% 紅', group: 'bar75', rgb: [191, 0, 0] },
  { name: '75% 藍', group: 'bar75', rgb: [0, 0, 191] },
  { name: '淺膚色', group: 'skin', rgb: [194, 150, 130] },
  { name: '深膚色', group: 'skin', rgb: [115, 82, 68] },
  { name: '亞洲膚色', group: 'skin', rgb: [224, 172, 140] },
  { name: '古銅膚色', group: 'skin', rgb: [160, 110, 80] },
  { name: '天空藍', group: 'macbeth', rgb: [98, 122, 157] },
  { name: '葉綠', group: 'macbeth', rgb: [87, 108, 67] },
  { name: '藍花', group: 'macbeth', rgb: [133, 128, 177] },
  { name: '藍綠', group: 'macbeth', rgb: [103, 189, 170] },
  { name: '橘', group: 'macbeth', rgb: [214, 126, 44] },
  { name: '紫藍', group: 'macbeth', rgb: [80, 91, 166] },
  { name: '中紅', group: 'macbeth', rgb: [193, 90, 99] },
  { name: '紫', group: 'macbeth', rgb: [94, 60, 108] },
  { name: '黃綠', group: 'macbeth', rgb: [157, 188, 64] },
  { name: '橘黃', group: 'macbeth', rgb: [224, 163, 46] },
  { name: '深藍', group: 'macbeth', rgb: [56, 61, 150] },
  { name: '正綠', group: 'macbeth', rgb: [70, 148, 73] },
  { name: '正紅', group: 'macbeth', rgb: [175, 54, 60] },
  { name: '正黃', group: 'macbeth', rgb: [231, 199, 31] },
  { name: '正洋紅', group: 'macbeth', rgb: [187, 86, 149] },
  { name: '正青', group: 'macbeth', rgb: [8, 133, 161] },
];

export const CHART_COLS = 10;
export const CHART_ROWS = 5;
/** 一格幾個像素（色卡 = 1440 × 720：高 720 以上瀏覽器才會把沒標色彩空間的影片當 HD / BT.709） */
export const CHART_PATCH_PX = 144;
export const CHART_WIDTH = CHART_COLS * CHART_PATCH_PX;
export const CHART_HEIGHT = CHART_ROWS * CHART_PATCH_PX;

/** 第 i 格中心在畫面上的位置（0~1，左上角是 0,0） */
export function patchCenterUv(i: number): [number, number] {
  const col = i % CHART_COLS;
  const row = Math.floor(i / CHART_COLS);
  return [(col + 0.5) / CHART_COLS, (row + 0.5) / CHART_ROWS];
}

/** 色卡的第 (col, row) 格（給畫面上指定一格用，例：拿白色那格給「對面的 LED」） */
export function patchUvRect(i: number): { u0: number; v0: number; u1: number; v1: number } {
  const col = i % CHART_COLS;
  const row = Math.floor(i / CHART_COLS);
  return { u0: col / CHART_COLS, v0: row / CHART_ROWS, u1: (col + 1) / CHART_COLS, v1: (row + 1) / CHART_ROWS };
}

export function patchIndex(name: string): number {
  return CHART_PATCHES.findIndex(p => p.name === name);
}

interface FillCtx {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
}

/** 畫色卡（每格純色，不畫字：影片壓縮、取樣都只看純色） */
export function drawChart(ctx: FillCtx, scale = 1) {
  const s = CHART_PATCH_PX * scale;
  CHART_PATCHES.forEach((p, i) => {
    const col = i % CHART_COLS;
    const row = Math.floor(i / CHART_COLS);
    ctx.fillStyle = `rgb(${p.rgb[0]}, ${p.rgb[1]}, ${p.rgb[2]})`;
    ctx.fillRect(col * s, row * s, s, s);
  });
}

// ─── sRGB / CIELAB / ΔE2000 ───

export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

export type Lab = [number, number, number];

const D65 = [0.95047, 1.0, 1.08883];

/** 8 位元 sRGB（可以有小數，平均出來的值）→ CIELAB（D65） */
export function srgb8ToLab(rgb: readonly number[]): Lab {
  const [r, g, b] = rgb.map(v => srgbToLinear(Math.min(255, Math.max(0, v)) / 255));
  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x / D65[0]), fy = f(y / D65[1]), fz = f(z / D65[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const deg = (rad: number) => (rad * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

/** CIEDE2000（kL = kC = kH = 1） */
export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hp = (a: number, b: number) => {
    if (a === 0 && b === 0) return 0;
    const h = deg(Math.atan2(b, a));
    return h >= 0 ? h : h + 360;
  };
  const h1p = hp(a1p, b1), h2p = hp(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
    else if (h1p + h2p < 360) hbarp = (h1p + h2p + 360) / 2;
    else hbarp = (h1p + h2p - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos(rad(hbarp - 30)) + 0.24 * Math.cos(rad(2 * hbarp))
    + 0.32 * Math.cos(rad(3 * hbarp + 6)) - 0.2 * Math.cos(rad(4 * hbarp - 63));
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

export function deltaE2000Rgb8(expected: readonly number[], measured: readonly number[]): number {
  return deltaE2000(srgb8ToLab(expected), srgb8ToLab(measured));
}

// ─── NDI 小程序的處理（ndi-helper/src/ndi.rs 的 encode_frame）───

/** ndi.rs 的 limited_to_full：把 16~235 拉成 0~255 */
export function helperLimitedToFull(v: number): number {
  const f = Math.min(219, Math.max(0, v - 16));
  return Math.min(255, Math.floor((f * 255 + 110) / 219));
}

/**
 * 小程序送出前的處理：RGBA → 2 倍縮小（四格平均，>> 2）→（選擇性）limited→full。回傳 RGBA（alpha 255）。
 * downsample = false 時只做查表。
 */
export function simulateHelperFrame(
  rgba: Uint8ClampedArray | Uint8Array, w: number, h: number,
  opts: { downsample: boolean; limitedToFull: boolean },
): { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
  const ds = opts.downsample && w >= 2 && h >= 2;
  const ow = ds ? Math.floor(w / 2) : w;
  const oh = ds ? Math.floor(h / 2) : h;
  const out = new Uint8ClampedArray(ow * oh * 4);
  const conv = (v: number) => (opts.limitedToFull ? helperLimitedToFull(v) : v);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let r = 0, g = 0, b = 0;
      if (ds) {
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const o = ((y * 2 + dy) * w + (x * 2 + dx)) * 4;
            r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2];
          }
        }
        r >>= 2; g >>= 2; b >>= 2;
      } else {
        const o = (y * w + x) * 4;
        r = rgba[o]; g = rgba[o + 1]; b = rgba[o + 2];
      }
      const d = (y * ow + x) * 4;
      out[d] = conv(r); out[d + 1] = conv(g); out[d + 2] = conv(b); out[d + 3] = 255;
    }
  }
  return { data: out, width: ow, height: oh };
}

// ─── 誤差摘要 ───

export interface PatchResult {
  name: string;
  group: PatchGroup;
  expected: Rgb8;
  /** 量到的平均（8 位元 sRGB，可能有小數） */
  measured: [number, number, number];
  /** 三個色版裡差最多的那個（8 位元階數，有正負：正 = 比原檔亮） */
  maxDiff: number;
  deltaE: number;
}

export function comparePatch(p: { name: string; group: PatchGroup; rgb: Rgb8 }, measured: readonly number[]): PatchResult {
  const m: [number, number, number] = [measured[0], measured[1], measured[2]];
  let maxDiff = 0;
  for (let c = 0; c < 3; c++) {
    const d = m[c] - p.rgb[c];
    if (Math.abs(d) > Math.abs(maxDiff)) maxDiff = d;
  }
  return { name: p.name, group: p.group, expected: p.rgb, measured: m, maxDiff, deltaE: deltaE2000Rgb8(p.rgb, m) };
}

export interface AccuracySummary {
  /** 灰階最大差幾階（絕對值） */
  greyMaxAbs: number;
  /** 灰階平均差幾階（有正負：正 = 整體偏亮） */
  greyMeanDiff: number;
  /** 彩色格（非灰階）ΔE2000 最大 / 平均 */
  colourDeMax: number;
  colourDeMean: number;
  /** 全部格 ΔE2000 最大 */
  allDeMax: number;
  worstColour: string | null;
  /** 目標：灰階 ±3/255 以內、彩色 ΔE < 2 */
  pass: boolean;
}

export const TARGET_GREY_MAX = 3;
export const TARGET_DE_MAX = 2;

export function summarize(results: readonly PatchResult[]): AccuracySummary {
  const greys = results.filter(r => r.group === 'grey');
  const colours = results.filter(r => r.group !== 'grey');
  const greyMaxAbs = greys.reduce((m, r) => Math.max(m, Math.abs(r.maxDiff)), 0);
  const greyMeanDiff = greys.length ? greys.reduce((s, r) => s + (r.measured[0] + r.measured[1] + r.measured[2]) / 3 - r.expected[0], 0) / greys.length : 0;
  let colourDeMax = 0, worstColour: string | null = null;
  for (const r of colours) {
    if (r.deltaE > colourDeMax) { colourDeMax = r.deltaE; worstColour = r.name; }
  }
  const colourDeMean = colours.length ? colours.reduce((s, r) => s + r.deltaE, 0) / colours.length : 0;
  const allDeMax = results.reduce((m, r) => Math.max(m, r.deltaE), 0);
  return {
    greyMaxAbs, greyMeanDiff, colourDeMax, colourDeMean, allDeMax, worstColour,
    pass: greyMaxAbs <= TARGET_GREY_MAX && colourDeMax < TARGET_DE_MAX,
  };
}

/** 一整塊像素的平均（RGBA，x0..x1 / y0..y1 含頭不含尾） */
export function averageRgb(data: Uint8ClampedArray, width: number, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * width + x) * 4;
      r += data[o]; g += data[o + 1]; b += data[o + 2]; n++;
    }
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

/** 一整塊像素在 linear 光的平均，再轉回 8 位元 sRGB（看 LED 像素格時，眼睛 / 鏡頭在遠處平均的是光） */
export function averageRgbLinear(data: Uint8ClampedArray, width: number, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * width + x) * 4;
      r += srgbToLinear(data[o] / 255); g += srgbToLinear(data[o + 1] / 255); b += srgbToLinear(data[o + 2] / 255); n++;
    }
  }
  if (!n) return [0, 0, 0];
  return [linearToSrgb(r / n) * 255, linearToSrgb(g / n) * 255, linearToSrgb(b / n) * 255];
}
