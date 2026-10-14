// AE 即時的顏色校正：一條「收到的值 → 原本的值」曲線（紅綠藍各一條，256 格），只套在 AE 即時的畫面。
//
// 為什麼要：實測 AE → NDI → 小程序收到的像素不是原檔的值（黑大約 16、白大約 255，中間不是直線），
// 0.1.12 以前小程序硬把 16–235 拉成 0–255 → 235 以上全部變 255、灰 128 變 140。
// 0.1.13 起小程序送原始像素（colorPipeline = "raw"），由這裡校正：
//   - 預設：用量到的那條（owner 的電腦，灰階色卡，2026-10-14）反過來算（AE_RAW_MEASURED）
//   - 「校正 AE 即時顏色」：用這台電腦自己量的（ndiCalibration.ts 量、這裡擬合），存在瀏覽器（localStorage）
// 舊版小程序（沒有 colorPipeline）/ 設定成 limited_to_full → 照以前，不另外校正。
// 只有 AE 的來源才套（別的 NDI 來源送過來的像素本來就對，實測假的 NDI 來源 0…255 原樣收到）。

import type { NdiColorPipeline } from './ndiSteps';

/** 一條曲線：lut[收到的值 0..255] = 校正後的值 0..255 */
export type ChannelLut = Uint8Array;

export interface NdiColorLut {
  r: ChannelLut;
  g: ChannelLut;
  b: ChannelLut;
}

/** 一個量測點：送出去的值（原檔）、收到的值 */
export interface CurveSample {
  /** 原檔的值 0..255 */
  input: number;
  /** 收到的值（可以有小數：一塊平均起來） */
  measured: number;
}

/** 灰階色卡（校正圖和 owner 量的都是這幾格） */
export const GREY_PATCHES = [0, 8, 16, 24, 32, 48, 64, 128, 192, 216, 228, 235, 242, 250, 255] as const;

/**
 * owner 量的（2026-10-14，AE Full 解析度 → NDI → 0.1.12 小程序 → 網頁 LED 截圖）：
 * 截圖看到的值經過小程序的 16–235 拉伸，倒推回小程序收到的原始值（整數：拉伸表只有這個值會變成截圖的值）。
 *   0→0 8→7 16→15 24→23 32→32 48→50 64→65 128→140 192→207 216→235 228→247 235→255 242→255 250→255 255→255
 * 0 那格截圖是 0（原始 ≤ 16，當成 16）；235 以上截圖都是 255（被截掉，看不出原始值）→ 不放進來，
 * 最亮的當成 255 → 255（實測白還是白）
 */
export const AE_RAW_MEASURED: readonly CurveSample[] = [
  { input: 0, measured: 16 },
  { input: 8, measured: 22 },
  { input: 16, measured: 29 },
  { input: 24, measured: 36 },
  { input: 32, measured: 43.5 }, // 截圖 32：拉伸表沒有剛好變成 32 的值（43 → 31、44 → 33）
  { input: 48, measured: 59 },
  { input: 64, measured: 72 },
  { input: 128, measured: 136 },
  { input: 192, measured: 194 },
  { input: 216, measured: 218 },
  { input: 228, measured: 228 },
  { input: 255, measured: 255 },
];

/** 量到的 AE → NDI（正方向：原檔的值 → 小程序收到的值，點跟點之間直線內插）。測試 / 量測頁模擬 AE 用 */
export function aeRawChain(v: number): number {
  const pts = AE_RAW_MEASURED;
  if (v <= pts[0].input) return pts[0].measured;
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i].input) {
      const a = pts[i - 1], b = pts[i];
      return a.measured + ((v - a.input) * (b.measured - a.measured)) / (b.input - a.input);
    }
  }
  return pts[pts.length - 1].measured;
}

/** 一條直線的近似（黑 16、白 255）：v = (b − 16) · 255 / 239。只拿來比較（64 那格差 4 階，預設用量到的曲線） */
export function linearRawCorrection(b: number): number {
  return clamp255(Math.round(((b - 16) * 255) / 239));
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

export function identityLut(): ChannelLut {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = i;
  return t;
}

export function isIdentityLut(t: ChannelLut): boolean {
  for (let i = 0; i < 256; i++) if (t[i] !== i) return false;
  return true;
}

/**
 * 從量測點擬合「收到的值 → 原本的值」曲線（只會往上、不會倒退）：
 *   1. 收到的值一樣的點合併：最亮那一群取最大的原值（被截掉的白 → 白）、最暗那一群取最小的（被截掉的黑 → 黑），中間的取平均
 *   2. 保序回歸（PAVA）：照收到的值排好，原值如果倒退就跟前一段合併取平均 → 一定單調
 *   3. 點跟點之間直線內插；最暗的點以下 → 原值（通常是 0）往下延伸、最亮以上照最後一段的斜率延伸（夾在 0–255）
 * 量測點不夠（少於 2 個不同的收到值）→ null
 */
export function fitCurve(samples: readonly CurveSample[]): ChannelLut | null {
  const pts = samples
    .filter(s => Number.isFinite(s.input) && Number.isFinite(s.measured))
    .map(s => ({ x: s.measured, y: s.input }))
    .sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 2) return null;

  // 1. 收到的值（差不到 0.5 階）一樣的併成一群
  const groups: { x: number; ys: number[] }[] = [];
  for (const p of pts) {
    const last = groups[groups.length - 1];
    if (last && p.x - last.x < 0.5) last.ys.push(p.y);
    else groups.push({ x: p.x, ys: [p.y] });
  }
  if (groups.length < 2) return null;
  const knotsIn = groups.map((g, i) => {
    const y = i === groups.length - 1 ? Math.max(...g.ys) : i === 0 ? Math.min(...g.ys) : g.ys.reduce((a, b) => a + b, 0) / g.ys.length;
    const x = g.x;
    return { x, y, w: g.ys.length };
  });

  // 2. PAVA（原值照收到的值的順序只能變大或一樣）
  const blocks: { x: number; y: number; w: number; xs: number[] }[] = [];
  for (const k of knotsIn) {
    blocks.push({ x: k.x, y: k.y, w: k.w, xs: [k.x] });
    while (blocks.length >= 2 && blocks[blocks.length - 2].y > blocks[blocks.length - 1].y) {
      const b2 = blocks.pop()!;
      const b1 = blocks.pop()!;
      const w = b1.w + b2.w;
      blocks.push({ x: 0, y: (b1.y * b1.w + b2.y * b2.w) / w, w, xs: [...b1.xs, ...b2.xs] });
    }
  }
  // 合併成一段的：放在那幾個收到值的中間
  const knots = blocks.map(b => ({ x: b.xs.reduce((a, v) => a + v, 0) / b.xs.length, y: b.y }));
  if (knots.length < 2) return null;

  // 3. 內插成 256 格
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    let y: number;
    if (v <= knots[0].x) {
      // 最暗的點以下：最暗那格通常是黑（0）→ 全部 0；不是 0 的話照第一段斜率往下
      const [a, b] = [knots[0], knots[1]];
      const slope = (b.y - a.y) / Math.max(1e-6, b.x - a.x);
      y = a.y <= 0 ? 0 : a.y - (a.x - v) * slope;
    } else if (v >= knots[knots.length - 1].x) {
      const [a, b] = [knots[knots.length - 2], knots[knots.length - 1]];
      const slope = (b.y - a.y) / Math.max(1e-6, b.x - a.x);
      y = b.y >= 255 ? 255 : b.y + (v - b.x) * slope;
    } else {
      let i = 1;
      while (knots[i].x < v) i++;
      const [a, b] = [knots[i - 1], knots[i]];
      y = a.y + ((v - a.x) * (b.y - a.y)) / Math.max(1e-6, b.x - a.x);
    }
    lut[v] = clamp255(Math.round(y));
  }
  // 四捨五入不會倒退，但保險起見
  for (let v = 1; v < 256; v++) if (lut[v] < lut[v - 1]) lut[v] = lut[v - 1];
  return lut;
}

/** 預設（還沒自己校正）：用量到的那條反過來算，三個色版一樣 */
export const DEFAULT_AE_RAW_LUT: ChannelLut = fitCurve(AE_RAW_MEASURED) ?? identityLut();

export function defaultAeLut(): NdiColorLut {
  return { r: DEFAULT_AE_RAW_LUT, g: DEFAULT_AE_RAW_LUT, b: DEFAULT_AE_RAW_LUT };
}

export function identityColorLut(): NdiColorLut {
  const t = identityLut();
  return { r: t, g: t, b: t };
}

/** 曲線套在量測點上，跟原值差幾階（最多 / 平均） */
export function curveError(lut: ChannelLut, samples: readonly CurveSample[]): { max: number; mean: number } {
  if (samples.length === 0) return { max: 0, mean: 0 };
  let max = 0;
  let sum = 0;
  for (const s of samples) {
    const d = Math.abs(lut[clamp255(Math.round(s.measured))] - s.input);
    max = Math.max(max, d);
    sum += d;
  }
  return { max, mean: sum / samples.length };
}

// ─── 這台電腦的校正（存在瀏覽器）───

export const NDI_COLOR_STORAGE_KEY = 'sp_ndi_color_calibration_v1';

export interface NdiColorCalibration {
  version: 1;
  /** 什麼時候校正的（ISO） */
  createdAt: string;
  /** 校正時小程序的顏色處理（換了就不適用） */
  pipeline: NdiColorPipeline;
  /** 校正時的來源是不是 AE（只套在同一種來源） */
  afterEffects: boolean;
  /** 校正時的來源名稱（顯示用） */
  source: string | null;
  r: number[];
  g: number[];
  b: number[];
  /** 量的時候：灰階平均差幾階（校正前 = 當時用的曲線；校正後 = 新的） */
  before: { max: number; mean: number };
  after: { max: number; mean: number };
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function validChannel(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === 256 && v.every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255);
}

function validErr(v: unknown): v is { max: number; mean: number } {
  return !!v && typeof v === 'object' && typeof (v as { max?: unknown }).max === 'number' && typeof (v as { mean?: unknown }).mean === 'number';
}

/** 讀這台電腦的校正；沒有 / 壞掉 / 瀏覽器不准 → null */
export function loadCalibration(storage: StorageLike | null = defaultStorage()): NdiColorCalibration | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(NDI_COLOR_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<NdiColorCalibration>;
    if (!o || o.version !== 1) return null;
    if (o.pipeline !== 'raw' && o.pipeline !== 'limited_to_full') return null;
    if (!validChannel(o.r) || !validChannel(o.g) || !validChannel(o.b)) return null;
    return {
      version: 1,
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
      pipeline: o.pipeline,
      afterEffects: o.afterEffects !== false,
      source: typeof o.source === 'string' ? o.source : null,
      r: o.r, g: o.g, b: o.b,
      before: validErr(o.before) ? o.before : { max: 0, mean: 0 },
      after: validErr(o.after) ? o.after : { max: 0, mean: 0 },
    };
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();

/** 校正存了 / 清掉了 → 通知（同一個分頁的 3D 畫面馬上換曲線；別的分頁靠 storage 事件） */
export function subscribeCalibration(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => { if (e.key === NDI_COLOR_STORAGE_KEY) fn(); };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  };
}

function notify() {
  for (const fn of [...listeners]) {
    try { fn(); } catch { /* 一個壞掉不影響其他 */ }
  }
}

/** 存起來；瀏覽器不准存 → false */
export function saveCalibration(c: NdiColorCalibration, storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(NDI_COLOR_STORAGE_KEY, JSON.stringify(c));
  } catch {
    return false;
  }
  notify();
  return true;
}

/** 「回到預設」 */
export function clearCalibration(storage: StorageLike | null = defaultStorage()): void {
  try { storage?.removeItem(NDI_COLOR_STORAGE_KEY); } catch { /* 不准就算了 */ }
  notify();
}

export function calibrationLut(c: NdiColorCalibration): NdiColorLut {
  return { r: Uint8Array.from(c.r), g: Uint8Array.from(c.g), b: Uint8Array.from(c.b) };
}

export type NdiColorCurveKind = 'none' | 'default' | 'calibrated';

export interface NdiColorChoice {
  kind: NdiColorCurveKind;
  lut: NdiColorLut;
}

/**
 * 現在 AE 即時的畫面要用哪條曲線：
 *   - 舊版小程序（沒回報）/ limited_to_full → 不校正（照以前）
 *   - 這台電腦校正過（同一種顏色處理、同一種來源）→ 用校正的
 *   - 來源是 AE → 預設曲線；不是 AE（別的 NDI 程式）→ 不校正
 */
export function pickNdiColorCurve(
  pipeline: NdiColorPipeline | null,
  sourceIsAe: boolean,
  calibration: NdiColorCalibration | null,
): NdiColorChoice {
  if (pipeline !== 'raw') return { kind: 'none', lut: identityColorLut() };
  if (calibration && calibration.pipeline === pipeline && calibration.afterEffects === sourceIsAe) {
    return { kind: 'calibrated', lut: calibrationLut(calibration) };
  }
  if (sourceIsAe) return { kind: 'default', lut: defaultAeLut() };
  return { kind: 'none', lut: identityColorLut() };
}

/** 套一個像素（顏色取樣 / 測試用；LED 畫面在 shader 裡套） */
export function applyColorLut(lut: NdiColorLut, r: number, g: number, b: number): [number, number, number] {
  return [lut.r[clamp255(Math.round(r))], lut.g[clamp255(Math.round(g))], lut.b[clamp255(Math.round(b))]];
}
