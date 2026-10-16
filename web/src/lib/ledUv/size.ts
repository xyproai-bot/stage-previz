// 自動貼 UV：實體尺寸 → LED 點數（純函式）
//
// 三種輸入（每一片螢幕各選一種）：
//   點距：P3.9 → 每格 3.9 mm → 點數 = 實體毫米 / 點距（四捨五入）
//   總點數：直接填 寬 × 高（例如客戶給的 3072 × 1024），不管模型量到多大
//   箱體：每箱 寬 × 高 點、箱體實體 寬 × 高 mm、幾箱（預設 = 量到的尺寸 / 箱體實體，四捨五入）→ 一定是整數箱
// 實體尺寸 = 模型量到的距離 × 自動縮放 × 測距校準（metersPerUnit）；模型的縮放這裡只讀，不改。

import type { Rotation } from '../ledTemplate';

export type SizeMode = 'pitch' | 'pixels' | 'cabinets';

export interface CabinetSpec {
  /** 箱體實體大小（毫米） */
  mmW: number;
  mmH: number;
  /** 每箱的點數 */
  pxW: number;
  pxH: number;
  /** 幾箱；沒填 = 量到的尺寸 / 箱體實體（四捨五入，至少 1） */
  cols?: number;
  rows?: number;
}

export interface SizeSpec {
  mode: SizeMode;
  pitchMm?: number;
  pixels?: { w: number; h: number };
  cabinet?: CabinetSpec;
}

export interface SizeResult {
  ok: boolean;
  /** 不能用的原因（白話）；ok 才有 w、h */
  error?: string;
  w: number;
  h: number;
  /** 一行結果：「P3.9 → 3077 × 1026 點（12.00 × 4.00 m）」 */
  line: string;
  /** 黃色提醒（不擋） */
  warnings: string[];
}

/** 一邊最多幾個點（跟 LED 畫布一樣 32768） */
export const MAX_SIDE_PX = 32768;
export const WARN_SIDE_PX = 30000;
export const PITCH_PRESETS = [1.2, 1.5, 1.9, 2.5, 2.6, 2.9, 3.0, 3.9, 4.8, 5.0, 6.0, 6.67, 8.0, 10.0] as const;
const MIN_PITCH_MM = 0.3;
const MAX_PITCH_MM = 100;

export interface Measured { w: number; h: number }

const fmtNum = (n: number): string => String(Number(n.toFixed(2)));
const fmtM = (n: number): string => n.toFixed(2);
export const pitchLabel = (mm: number): string => `P${fmtNum(mm)}`;

const wholeNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 1 ? v : null;

/** 把一個欄位的字（可以是 3.9、「P3.9」）變成數字；不是數字 = null */
export function parseNumber(text: string): number | null {
  const m = /^\s*[Pp]?\s*(\d+(?:\.\d+)?)\s*(?:mm)?\s*$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** 算一片螢幕的點數。measured = 模型量到的實體大小（公尺） */
export function resolveSize(spec: SizeSpec, measured: Measured): SizeResult {
  const warnings: string[] = [];
  const physical = `${fmtM(measured.w)} × ${fmtM(measured.h)} m`;
  const fail = (error: string): SizeResult => ({ ok: false, error, w: 0, h: 0, line: error, warnings });
  if (!(measured.w > 0) || !(measured.h > 0)) return fail('量不到這片螢幕的大小');

  let w = 0, h = 0, label = '';
  if (spec.mode === 'pitch') {
    const p = spec.pitchMm;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < MIN_PITCH_MM || p > MAX_PITCH_MM) {
      return fail(`點距要在 ${MIN_PITCH_MM} ~ ${MAX_PITCH_MM} mm 之間（例如 3.9）`);
    }
    w = Math.max(1, Math.round((measured.w * 1000) / p));
    h = Math.max(1, Math.round((measured.h * 1000) / p));
    label = pitchLabel(p);
  } else if (spec.mode === 'pixels') {
    const px = spec.pixels;
    const pw = wholeNum(px?.w), ph = wholeNum(px?.h);
    if (pw === null || ph === null) return fail('總點數的寬、高要是 1 以上的整數');
    w = pw; h = ph;
    label = '總點數';
  } else {
    const c = spec.cabinet;
    if (!c || !(c.mmW > 0) || !(c.mmH > 0)) return fail('箱體的實體大小（毫米）要填大於 0 的數字');
    const bw = wholeNum(c.pxW), bh = wholeNum(c.pxH);
    if (bw === null || bh === null) return fail('每箱的點數要是 1 以上的整數');
    const cols = c.cols !== undefined ? wholeNum(c.cols) : Math.max(1, Math.round((measured.w * 1000) / c.mmW));
    const rows = c.rows !== undefined ? wholeNum(c.rows) : Math.max(1, Math.round((measured.h * 1000) / c.mmH));
    if (cols === null || rows === null) return fail('箱數要是 1 以上的整數');
    w = cols * bw; h = rows * bh;
    label = `${cols} × ${rows} 箱`;
    const sizeW = (cols * c.mmW) / 1000, sizeH = (rows * c.mmH) / 1000;
    const dw = (sizeW - measured.w) / measured.w, dh = (sizeH - measured.h) / measured.h;
    if (Math.abs(dw) > 0.03 || Math.abs(dh) > 0.03) {
      const pct = Math.max(Math.abs(dw), Math.abs(dh)) * 100;
      const bigger = Math.abs(dw) >= Math.abs(dh) ? dw > 0 : dh > 0;
      warnings.push(`模型比 ${cols} × ${rows} 個箱體${bigger ? '小' : '大'} ${pct.toFixed(1)}%（箱體實體 ${fmtM(sizeW)} × ${fmtM(sizeH)} m，模型量到 ${physical}）`);
    }
  }

  if (w > MAX_SIDE_PX || h > MAX_SIDE_PX) {
    return { ok: false, error: `這片會有 ${w} × ${h} 點，一邊超過 ${MAX_SIDE_PX}（畫布的上限）`, w, h, line: `${label} → ${w} × ${h} 點`, warnings };
  }
  if (w > WARN_SIDE_PX || h > WARN_SIDE_PX) warnings.push(`一邊超過 ${WARN_SIDE_PX} 點，AE 的合成最大只有 30000`);

  if (measured.w > 80 || measured.w < 0.2 || measured.h > 80 || measured.h < 0.2) {
    warnings.push('尺寸看起來不對，先到 3D 畫面做測距校準，或改用「總點數」');
  }
  const pxAspect = w / h, physAspect = measured.w / measured.h;
  const stretch = pxAspect / physAspect - 1;
  if (spec.mode !== 'pitch' && Math.abs(stretch) > 0.01) {
    warnings.push(`這塊的點不是正方形，畫面會被拉${stretch > 0 ? '長' : '寬'}約 ${(Math.abs(stretch) * 100).toFixed(1)}%（點數的長寬比跟模型量到的不一樣）`);
  }
  return { ok: true, w, h, line: `${label} → ${w} × ${h} 點（${physical}）`, warnings };
}

/** 兩個尺寸讀到的 90 度轉向（寬高對調） */
export function rotatedSize(w: number, h: number, rotate: Rotation): { w: number; h: number } {
  return rotate === 90 || rotate === 270 ? { w: h, h: w } : { w, h };
}
