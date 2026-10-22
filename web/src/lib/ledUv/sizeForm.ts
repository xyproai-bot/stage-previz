// 自動貼 UV：點數表單（畫面上的輸入框，都是字）→ SizeSpec（純函式，有測試）

import { parseNumber, type SizeMode, type SizeSpec } from './size';

export interface SizeForm {
  mode: SizeMode;
  /** 點距（mm），可以寫 3.9 或 P3.9 */
  pitch: string;
  /** 每 0.5 m 幾點（預設 128） */
  perHalf: string;
  /** 總點數 寬 / 高 */
  pw: string;
  ph: string;
  /** 箱體：實體寬 / 高（mm）、每箱點數寬 / 高、幾箱（空白 = 照模型量到的尺寸算） */
  cmmW: string;
  cmmH: string;
  cpxW: string;
  cpxH: string;
  cols: string;
  rows: string;
}

export const EMPTY_FORM: SizeForm = { mode: 'pitch', pitch: '', perHalf: '128', pw: '', ph: '', cmmW: '', cmmH: '', cpxW: '', cpxH: '', cols: '', rows: '' };

const num = (s: string): number | null => parseNumber(s);
const int = (s: string): number | null => {
  const m = /^\s*(\d{1,6})\s*$/.exec(s);
  return m ? Number(m[1]) : null;
};

/** 欄位還沒填完整 / 寫不出數字 = undefined（畫面上顯示「還沒填點數」） */
export function formToSpec(f: SizeForm): SizeSpec | undefined {
  if (f.mode === 'pitch') {
    const p = num(f.pitch);
    return p === null ? undefined : { mode: 'pitch', pitchMm: p };
  }
  if (f.mode === 'perhalf') {
    const n = int(f.perHalf);
    return n === null ? undefined : { mode: 'perhalf', perHalf: n };
  }
  if (f.mode === 'pixels') {
    const w = int(f.pw), h = int(f.ph);
    return w === null || h === null ? undefined : { mode: 'pixels', pixels: { w, h } };
  }
  const mmW = num(f.cmmW), mmH = num(f.cmmH), pxW = int(f.cpxW), pxH = int(f.cpxH);
  if (mmW === null || mmH === null || pxW === null || pxH === null) return undefined;
  const cols = f.cols.trim() === '' ? undefined : int(f.cols);
  const rows = f.rows.trim() === '' ? undefined : int(f.rows);
  if (cols === null || rows === null) return undefined;
  return { mode: 'cabinets', cabinet: { mmW, mmH, pxW, pxH, ...(cols !== undefined ? { cols } : {}), ...(rows !== undefined ? { rows } : {}) } };
}

/** 一個表單有沒有填完整（空白 = 還沒填） */
export const formIsEmpty = (f: SizeForm | undefined): boolean => !f || formToSpec(f) === undefined;

export const MODE_LABEL: Record<SizeMode, string> = {
  pitch: '點距（mm）',
  perhalf: '每 0.5 m 幾點',
  pixels: '總點數（寬 × 高）',
  cabinets: '箱體（每箱點數 × 箱數）',
};
