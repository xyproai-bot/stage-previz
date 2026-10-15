// 編輯中的版型（還沒存的草稿）：編輯器裡所有改動都是「草稿 → 草稿」的純函式，所以可以復原重做、單元測試。
// 草稿存檔時才變成後台要的格式（lib/ledTemplate.ts 的 normalizeTemplateInput 會再檢查一次）。

import type { CanvasSize } from './ledMap';
import {
  defaultDestSize, placementsFromInputs,
  type LedTemplatePlan, type ManualScreen, type PlacementInput, type Rotation, type ScreenDef,
} from './ledTemplate';
import { findFreeSpot } from './ledTemplateEdit';
import type { LedTemplate, TemplateBody } from './ledTemplateApi';

export interface Draft {
  /** 已經存過的版型 id；新的（還沒存）= null */
  id: string | null;
  name: string;
  width: number;
  height: number;
  scalePct: number;
  items: PlacementInput[];
}

export function draftFromTemplate(t: LedTemplate): Draft {
  return {
    id: t.id, name: t.name, width: t.canvas.width, height: t.canvas.height, scalePct: t.scalePct,
    items: t.screens.map(p => ({ key: p.key, dest: { ...p.dest }, rotate: p.rotate, flipH: p.flipH, flipV: p.flipV })),
  };
}

export function emptyDraft(name: string, canvas: CanvasSize): Draft {
  return { id: null, name, width: canvas.width, height: canvas.height, scalePct: 100, items: [] };
}

/** 草稿的內容指紋（有沒有改過、要不要重新帶入） */
export function draftSignature(d: Draft): string {
  return JSON.stringify([d.id, d.name, d.width, d.height, d.scalePct, d.items.map(i => [i.key, i.dest.x, i.dest.y, i.dest.w, i.dest.h, i.rotate, i.flipH, i.flipV])]);
}

/** 草稿 → plan（畫面上算提醒、貼到 3D 用）；items 裡有 key 的才算 */
export function draftToPlan(d: Draft, manuals: readonly ManualScreen[]): LedTemplatePlan {
  return {
    v: 1, id: d.id, name: d.name, canvas: { width: d.width, height: d.height }, scalePct: d.scalePct,
    screens: placementsFromInputs(d.items, manuals),
  };
}

/** 草稿 → 存檔的內容；在模型裡找不到的螢幕（validKeys 以外）拿掉 */
export function draftToBody(d: Draft, validKeys: ReadonlySet<string>): TemplateBody {
  return {
    name: d.name,
    canvas: { width: d.width, height: d.height },
    scalePct: d.scalePct,
    screens: d.items.filter(i => validKeys.has(i.key)).map(i => ({ key: i.key, dest: { ...i.dest }, rotate: i.rotate, flipH: i.flipH, flipV: i.flipV })),
  };
}

/** 把一塊螢幕放進版型：真實點數 × 版型比例的大小，放在畫布裡的空位（放不下就放在最下面，畫面上會標紅） */
export function addScreenToDraft(d: Draft, def: Pick<ScreenDef, 'key' | 'nativeW' | 'nativeH'>): Draft {
  if (d.items.some(i => i.key === def.key)) return d;
  const size = defaultDestSize({ w: def.nativeW, h: def.nativeH }, d.scalePct > 0 ? d.scalePct : 100, 0);
  const pos = findFreeSpot(size, d.items.map(i => i.dest), { width: d.width, height: d.height });
  return { ...d, items: [...d.items, { key: def.key, dest: { x: pos.x, y: pos.y, w: size.w, h: size.h }, rotate: 0, flipH: false, flipV: false }] };
}

export function removeScreenFromDraft(d: Draft, key: string): Draft {
  return d.items.some(i => i.key === key) ? { ...d, items: d.items.filter(i => i.key !== key) } : d;
}

/** 對一塊螢幕的修改（只改有給的欄位） */
export type ItemPatch = Partial<Pick<PlacementInput, 'dest' | 'rotate' | 'flipH' | 'flipV'>>;
export interface ItemPatchEntry { key: string; patch: ItemPatch }

const sameRect = (a: PlacementInput['dest'], b: PlacementInput['dest']) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * 一次改好幾塊（複選一起拖、一起微調、各自轉 90°…）：回傳「一個」新草稿，所以記進復原就是一步。
 * 每一塊的內容都沒變（位置、大小、轉動、翻轉全一樣）= 回傳原本的草稿，不會多一步。
 */
export function patchDraftItems(d: Draft, patches: readonly ItemPatchEntry[]): Draft {
  if (patches.length === 0) return d;
  const byKey = new Map<string, ItemPatch>();
  for (const p of patches) byKey.set(p.key, { ...(byKey.get(p.key) ?? {}), ...p.patch });
  let changed = false;
  const items = d.items.map(i => {
    const patch = byKey.get(i.key);
    if (!patch) return i;
    const next = { ...i, ...patch };
    const same = sameRect(next.dest, i.dest) && next.rotate === i.rotate && next.flipH === i.flipH && next.flipV === i.flipV;
    if (same) return i;
    changed = true;
    return next;
  });
  return changed ? { ...d, items } : d;
}

/** 一次拿掉好幾塊：一個新草稿 = 復原一步 */
export function removeScreensFromDraft(d: Draft, keys: Iterable<string>): Draft {
  const gone = new Set(keys);
  return d.items.some(i => gone.has(i.key)) ? { ...d, items: d.items.filter(i => !gone.has(i.key)) } : d;
}

export function patchDraftItem(d: Draft, key: string, patch: ItemPatch): Draft {
  let changed = false;
  const items = d.items.map(i => {
    if (i.key !== key) return i;
    const next = { ...i, ...patch };
    if (next.dest !== i.dest || next.rotate !== i.rotate || next.flipH !== i.flipH || next.flipV !== i.flipV) changed = true;
    return next;
  });
  return changed ? { ...d, items } : d;
}

/** 標準大小：真實點數 × 比例（轉 90 / 270 度寬高對調），左上角位置不動 */
export function resetItemSize(d: Draft, def: Pick<ScreenDef, 'key' | 'nativeW' | 'nativeH'>): Draft {
  const it = d.items.find(i => i.key === def.key);
  if (!it) return d;
  const size = defaultDestSize({ w: def.nativeW, h: def.nativeH }, d.scalePct > 0 ? d.scalePct : 100, it.rotate as Rotation);
  return patchDraftItem(d, def.key, { dest: { x: it.dest.x, y: it.dest.y, w: size.w, h: size.h } });
}

/** 「版型 1」「版型 2」…，不跟現有的重複 */
export function nextTemplateName(taken: Iterable<string>): string {
  const names = new Set(taken);
  for (let i = 1; i < 100; i++) if (!names.has(`版型 ${i}`)) return `版型 ${i}`;
  return '新版型';
}

/** 複製版型的預設名字：「中間底幕 複本」「中間底幕 複本 2」…（最多 40 字，不跟現有的重複，不分大小寫） */
export function copyTemplateName(name: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map(n => n.toLowerCase()));
  const base = name.replace(/\s*複本(\s*\d+)?$/, '').trim() || name;
  const make = (n: number) => {
    const suffix = n === 1 ? ' 複本' : ` 複本 ${n}`;
    return base.slice(0, Math.max(1, 40 - suffix.length)) + suffix;
  };
  for (let n = 1; n < 1000; n++) if (!lower.has(make(n).toLowerCase())) return make(n);
  return make(1000);
}
