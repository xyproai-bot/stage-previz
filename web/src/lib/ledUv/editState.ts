// 自動貼 UV：製作填的東西（勾了哪些螢幕、每片的點數、辨識類型、螢幕間隔、自己排的排法）存起來、下次打開接著做（純函式）
//
// 存在後台 model_uv_layouts 這張表的 recipe 裡（每個模型版本一筆），放在 recipe.edit：
//   - 排到一半就存（停手 1.5 秒，PUT /led-uv/layout）：重新整理、關掉再開，同一個模型版本從上次的樣子繼續
//   - 套用的時候跟著新的模型版本一起存：下次打開自動貼 UV（現在的模型版本就是套用出來的那一版），排法、點數、勾的螢幕都還在
// 格式只有這個檔讀寫；讀回來一定重新檢查（後台、別人、舊版本寫的都不能信），讀不懂的整份丟掉，從頭開始。

import { parseArrangement, type Arrangement } from './arrange';
import { EMPTY_FORM, type SizeForm } from './sizeForm';
import type { SurfaceOverride } from './surfaces';

export const EDIT_VERSION = 1;

export interface UvEditSnapshot {
  v: 1;
  /** 物件 id → 勾了要自動貼 */
  selected: Record<string, boolean>;
  /** 螢幕片的代號（pieceKey）→ 點數表單 */
  forms: Record<string, SizeForm>;
  /** 物件 id → 手動指定的類型（只存不是「自動辨識」的） */
  overrides: Record<string, SurfaceOverride>;
  /** 螢幕間隔（字，輸入框裡的樣子） */
  gutter: string;
  /** 自己排的排法；沒動過 = null（照舞台自動排） */
  arrangement: Arrangement | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const MODES = new Set(['pitch', 'pixels', 'cabinets']);
const FORM_FIELDS = ['pitch', 'pw', 'ph', 'cmmW', 'cmmH', 'cpxW', 'cpxH', 'cols', 'rows'] as const;
const MAX_ENTRIES = 600;
const MAX_KEY = 160;

function parseForm(raw: unknown): SizeForm | null {
  if (!isObj(raw) || typeof raw.mode !== 'string' || !MODES.has(raw.mode)) return null;
  const f: SizeForm = { ...EMPTY_FORM, mode: raw.mode as SizeForm['mode'] };
  for (const k of FORM_FIELDS) {
    const v = raw[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length > 40) return null;
    f[k] = v;
  }
  return f;
}

/** 後台給的 edit 讀回來；格式不對 = null（整份丟掉，從頭開始）。多的欄位忽略，壞掉的單筆跳過 */
export function parseEditSnapshot(raw: unknown): UvEditSnapshot | null {
  if (!isObj(raw) || raw.v !== EDIT_VERSION) return null;
  const selected: Record<string, boolean> = {};
  if (isObj(raw.selected)) {
    for (const [k, v] of Object.entries(raw.selected).slice(0, MAX_ENTRIES)) if (k.length <= MAX_KEY && typeof v === 'boolean') selected[k] = v;
  }
  const forms: Record<string, SizeForm> = {};
  if (isObj(raw.forms)) {
    for (const [k, v] of Object.entries(raw.forms).slice(0, MAX_ENTRIES)) {
      if (k.length > MAX_KEY) continue;
      const f = parseForm(v);
      if (f) forms[k] = f;
    }
  }
  const overrides: Record<string, SurfaceOverride> = {};
  if (isObj(raw.overrides)) {
    for (const [k, v] of Object.entries(raw.overrides).slice(0, MAX_ENTRIES)) if (k.length <= MAX_KEY && (v === 'flat' || v === 'arc')) overrides[k] = v;
  }
  const gutter = typeof raw.gutter === 'string' && /^\d{1,2}$/.test(raw.gutter) ? raw.gutter : '0';
  const arrangement = raw.arrangement === null || raw.arrangement === undefined ? null : parseArrangement(raw.arrangement);
  if (raw.arrangement !== null && raw.arrangement !== undefined && !arrangement) return null;
  return { v: 1, selected, forms, overrides, gutter, arrangement };
}

/** 只留還在的物件 / 螢幕片（模型換過了、物件刪掉了） */
export function pruneEditSnapshot(s: UvEditSnapshot, objectIds: ReadonlySet<string>): UvEditSnapshot {
  const ownerOf = (key: string): string => key.replace(/^o:/, '').replace(/#\d+$/, '');
  return {
    ...s,
    selected: Object.fromEntries(Object.entries(s.selected).filter(([k]) => objectIds.has(k))),
    forms: Object.fromEntries(Object.entries(s.forms).filter(([k]) => objectIds.has(ownerOf(k)))),
    overrides: Object.fromEntries(Object.entries(s.overrides).filter(([k]) => objectIds.has(k))),
  };
}

/** 內容指紋：跟上次存的比，沒變就不用再存 */
export const editSignature = (s: UvEditSnapshot): string => JSON.stringify(s);
