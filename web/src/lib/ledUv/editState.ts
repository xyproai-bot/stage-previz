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
  /** 物件 id → 選了「不放進畫布」（只存 true 的；舊版存的沒有這一欄 = 都沒選） */
  excluded: Record<string, boolean>;
  /** 物件裡有好幾塊 LED mesh 時，個別塊的選擇：「物件id~mesh 名稱」→ true。excludedPieces = 不放進畫布、keepPieces = 保留原本 UV（只存 true 的；舊版存的沒有這兩欄 = 都沒選，各塊跟著整個物件） */
  excludedPieces?: Record<string, boolean>;
  keepPieces?: Record<string, boolean>;
  /** 螢幕片的代號（pieceKey）→ 點數表單 */
  forms: Record<string, SizeForm>;
  /** 物件 id → 手動指定的類型（只存不是「自動辨識」的） */
  overrides: Record<string, SurfaceOverride>;
  /** 物件 id → 整圈圓柱的接縫位置（從背面往觀眾右手邊轉幾度；只存不是 0 的） */
  seams: Record<string, number>;
  /** 螢幕間隔（字，輸入框裡的樣子） */
  gutter: string;
  /** 自己排的排法；沒動過 = null（照舞台自動排） */
  arrangement: Arrangement | null;
  /**
   * 這個模型版本是「套用」出來的（不是只有自動存的草稿）：套用當下這份內容的指紋（appliedFingerprint）。
   * 有它 = 「調整排版」可以直接用；存的內容跟它對得上 = 上次套用之後沒再動過（「套用」是灰的：還沒改排版）。
   * 自動存草稿時一直帶著；editSignature 不算它。
   */
  appliedSig?: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const MODES = new Set(['pitch', 'perhalf', 'pixels', 'cabinets']);
const FORM_FIELDS = ['pitch', 'perHalf', 'pw', 'ph', 'cmmW', 'cmmH', 'cpxW', 'cpxH', 'cols', 'rows'] as const;
const MAX_ENTRIES = 600;
const MAX_KEY = 160;

/** 「物件id~mesh 名稱」的物件 id（物件 id 不會有「~」） */
export const pieceOwner = (key: string): string => key.split('~')[0];

function parseFlags(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (isObj(raw)) for (const [k, v] of Object.entries(raw).slice(0, MAX_ENTRIES)) if (k.length <= MAX_KEY && k.includes('~') && v === true) out[k] = true;
  return out;
}

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
  const excluded: Record<string, boolean> = {};
  if (isObj(raw.excluded)) {
    for (const [k, v] of Object.entries(raw.excluded).slice(0, MAX_ENTRIES)) if (k.length <= MAX_KEY && v === true) excluded[k] = true;
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
    for (const [k, v] of Object.entries(raw.overrides).slice(0, MAX_ENTRIES)) if (k.length <= MAX_KEY && (v === 'flat' || v === 'arc' || v === 'free')) overrides[k] = v;
  }
  const seams: Record<string, number> = {};
  if (isObj(raw.seams)) {
    for (const [k, v] of Object.entries(raw.seams).slice(0, MAX_ENTRIES)) if (k.length <= MAX_KEY && typeof v === 'number' && Number.isFinite(v) && v !== 0) seams[k] = Math.max(-180, Math.min(180, v));
  }
  const gutter = typeof raw.gutter === 'string' && /^\d{1,2}$/.test(raw.gutter) ? raw.gutter : '0';
  const arrangement = raw.arrangement === null || raw.arrangement === undefined ? null : parseArrangement(raw.arrangement);
  if (raw.arrangement !== null && raw.arrangement !== undefined && !arrangement) return null;
  const excludedPieces = parseFlags(raw.excludedPieces), keepPieces = parseFlags(raw.keepPieces);
  // 同一塊不會同時是兩種：兩邊都有 = 不放進畫布
  for (const k of Object.keys(excludedPieces)) delete keepPieces[k];
  const appliedSig = typeof raw.appliedSig === 'string' && /^[0-9a-f]{8,32}$/.test(raw.appliedSig) ? raw.appliedSig : undefined;
  return {
    v: 1, selected, excluded,
    ...(Object.keys(excludedPieces).length > 0 ? { excludedPieces } : {}),
    ...(Object.keys(keepPieces).length > 0 ? { keepPieces } : {}),
    forms, overrides, seams, gutter, arrangement,
    ...(appliedSig ? { appliedSig } : {}) };
}

/** 只留還在的物件 / 螢幕片（模型換過了、物件刪掉了） */
export function pruneEditSnapshot(s: UvEditSnapshot, objectIds: ReadonlySet<string>): UvEditSnapshot {
  const ownerOf = (key: string): string => key.replace(/^o:/, '').replace(/#\d+$/, '');
  return {
    ...s,
    selected: Object.fromEntries(Object.entries(s.selected).filter(([k]) => objectIds.has(k))),
    excluded: Object.fromEntries(Object.entries(s.excluded).filter(([k]) => objectIds.has(k))),
    ...(s.excludedPieces ? { excludedPieces: Object.fromEntries(Object.entries(s.excludedPieces).filter(([k]) => objectIds.has(pieceOwner(k)))) } : {}),
    ...(s.keepPieces ? { keepPieces: Object.fromEntries(Object.entries(s.keepPieces).filter(([k]) => objectIds.has(pieceOwner(k)))) } : {}),
    forms: Object.fromEntries(Object.entries(s.forms).filter(([k]) => objectIds.has(ownerOf(k)))),
    overrides: Object.fromEntries(Object.entries(s.overrides).filter(([k]) => objectIds.has(k))),
    seams: Object.fromEntries(Object.entries(s.seams).filter(([k]) => objectIds.has(k))),
  };
}

/** 內容指紋：跟上次存的比，沒變就不用再存 */
export const editSignature = (s: UvEditSnapshot): string => JSON.stringify({ ...s, appliedSig: undefined });

/** 內容指紋的短版（套用當下存進 appliedSig；cyrb53，只用來比「有沒有變」） */
export function appliedFingerprint(s: UvEditSnapshot): string {
  const str = editSignature(s);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** 套用時要存進 recipe.edit 的內容：照讀回來的樣子（parse）算指紋，下次讀回來才對得上 */
export function withAppliedSig(s: UvEditSnapshot): UvEditSnapshot {
  const norm = parseEditSnapshot(JSON.parse(JSON.stringify(s))) ?? s;
  return { ...s, appliedSig: appliedFingerprint(norm) };
}

/** 讀回來的 edit 是不是套用出來的、而且套用之後沒再動過 */
export const editIsApplied = (s: UvEditSnapshot | null): boolean => !!s && !!s.appliedSig;
export const editIsPristine = (s: UvEditSnapshot | null): boolean => !!s && !!s.appliedSig && s.appliedSig === appliedFingerprint(s);
