// LED 版型編輯器的「複選」純邏輯（不碰 DOM / three / 網路）：Shift / Ctrl 點選、框選、整組一起移動（對整組的外框吸附）、整組微調、各自轉 90° / 翻轉。
// 畫面（滑鼠、鍵盤）在 components/LedTemplateCanvas.tsx；清單和數字欄位在 components/LedTemplatesDialog.tsx。這裡只算數字，所以可以單元測試。
//
// 選取 = 螢幕代號（key）的陣列，順序就是「選的先後」；沒有重複。
// 座標一律是版型畫布的像素（位置和大小是整數），框選的框是滑鼠算出來的畫布位置（可以有小數）。

import type { CanvasSize, PixelRect } from './ledMap';
import type { PlacementInput } from './ledTemplate';
import type { ItemPatchEntry } from './ledTemplateDraft';
import { nudgeRect, rectsOverlap, rotatePlacement90, snapMove, snapTargets, type SnapGuide, type SnapTargets } from './ledTemplateEdit';

export type Selection = readonly string[];

// ───────────────────────── Shift / Ctrl 點選 ─────────────────────────

/** 按著 Shift 或 Ctrl（Mac 的 Cmd）= 加選 / 取消選 */
export const isAdditive = (e: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): boolean => !!(e.shiftKey || e.ctrlKey || e.metaKey);

export const sameSelection = (a: Selection, b: Selection): boolean => a.length === b.length && a.every((k, i) => k === b[i]);

/** 放開滑鼠時才決定的事：'only' = 沒拖就只留這一塊；'toggle' = 沒拖就把這一塊從選取拿掉 */
export type PressPending = 'only' | 'toggle' | null;

/**
 * 在一塊螢幕上按下滑鼠：
 *   沒按 Shift / Ctrl、這塊還沒選 → 只選這一塊（可以直接拖）。
 *   沒按、這塊已經在選取裡 → 選取先不動（這樣才能抓著其中一塊拖整組），放開時沒拖才縮成只選這一塊。
 *   按著、這塊還沒選 → 加進選取（可以直接拖整組）。
 *   按著、這塊已經選了 → 選取先不動，放開時沒拖才把它拿掉。
 */
export function pressSelect(sel: Selection, key: string, additive: boolean): { selection: string[]; pending: PressPending } {
  const has = sel.includes(key);
  if (additive) return has ? { selection: [...sel], pending: 'toggle' } : { selection: [...sel, key], pending: null };
  if (has) return { selection: [...sel], pending: sel.length > 1 ? 'only' : null };
  return { selection: [key], pending: null };
}

/** 放開滑鼠：拖過（moved）就維持按下時的選取，沒拖才做 pressSelect 留下的事 */
export function releaseSelect(sel: Selection, key: string, pending: PressPending, moved: boolean): string[] {
  if (moved || !pending) return [...sel];
  return pending === 'only' ? [key] : sel.filter(k => k !== key);
}

/** 一次點下去就完成（螢幕清單的那一列）：按著 Shift / Ctrl = 加選或取消選，沒按 = 只選這一塊 */
export function clickSelect(sel: Selection, key: string, additive: boolean): string[] {
  if (!additive) return [key];
  return sel.includes(key) ? sel.filter(k => k !== key) : [...sel, key];
}

/** 拿掉不存在的代號（撤銷、換版型之後）；沒有要拿掉的就回傳原本那一個陣列 */
export function pruneSelection(sel: Selection, exists: (key: string) => boolean): Selection {
  return sel.every(exists) ? sel : sel.filter(exists);
}

/** Ctrl+A：版型裡所有螢幕 */
export const selectAllKeys = (items: readonly { key: string }[]): string[] => items.map(i => i.key);

// ───────────────────────── 框選 ─────────────────────────

/** 兩個拖曳點 → 框（不管從哪個角拖起；保留小數，因為是滑鼠的位置） */
export function marqueeBox(a: { x: number; y: number }, b: { x: number; y: number }): PixelRect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** 框碰到的螢幕（只要有一點點重疊就算，只是邊貼邊不算）；照 items 的順序 */
export function marqueeHits(box: PixelRect, items: readonly { key: string; dest: PixelRect }[]): string[] {
  if (box.w <= 0 || box.h <= 0) return [];
  return items.filter(i => rectsOverlap(box, i.dest)).map(i => i.key);
}

/** 框選的結果：加選（按著 Shift / Ctrl）= 原本選的 + 框到的；沒按 = 只有框到的 */
export function applyMarquee(base: Selection, hits: readonly string[], additive: boolean): string[] {
  if (!additive) return [...hits];
  const out = [...base];
  for (const k of hits) if (!out.includes(k)) out.push(k);
  return out;
}

// ───────────────────────── 整組移動 ─────────────────────────

/** 一組長方形的外框；沒有 = null */
export function boundsOf(rects: readonly PixelRect[]): PixelRect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 整組移動時可以吸的線：畫布的四條邊 + 「沒被選到」的螢幕的邊（選到的那幾塊自己的邊不算） */
export function groupTargets(canvas: CanvasSize, items: readonly { key: string; dest: PixelRect }[], selected: Selection): SnapTargets {
  const chosen = new Set(selected);
  return snapTargets(canvas, items.filter(i => !chosen.has(i.key)).map(i => i.dest));
}

export interface GroupMove { rects: PixelRect[]; dx: number; dy: number; guides: SnapGuide[] }

/**
 * 整組一起移動：dx / dy = 滑鼠從按下去到現在移了多少畫布像素（可以有小數）。
 * 一定先四捨五入成整數；snap = true 時，吸附的是「整組的外框」（左 / 右 / 上 / 下邊）對上別人的邊或畫布的邊，
 * 整組一起平移同樣的距離，所以組裡面每塊的相對位置不會變，位置也都還是整數。只選一塊時跟單塊移動一模一樣。
 */
export function snapGroupMove(
  startRects: readonly PixelRect[], dx: number, dy: number, targets: SnapTargets, opts: { threshold: number; snap: boolean },
): GroupMove {
  const box = boundsOf(startRects);
  if (!box) return { rects: [], dx: 0, dy: 0, guides: [] };
  const r = snapMove(box, box.x + dx, box.y + dy, targets, opts);
  const mx = r.rect.x - box.x, my = r.rect.y - box.y;
  return { rects: startRects.map(s => ({ x: s.x + mx, y: s.y + my, w: s.w, h: s.h })), dx: mx, dy: my, guides: r.guides };
}

/** 方向鍵微調整組 */
export const nudgeRects = (rects: readonly PixelRect[], dx: number, dy: number): PixelRect[] => rects.map(r => nudgeRect(r, dx, dy));

/** 數字欄位改整組外框的左 / 上：整組平移到那裡（只給一個就只動那個方向） */
export function moveGroupTo(rects: readonly PixelRect[], target: { x?: number; y?: number }): PixelRect[] {
  const box = boundsOf(rects);
  if (!box) return [];
  const dx = target.x === undefined ? 0 : Math.round(target.x) - box.x;
  const dy = target.y === undefined ? 0 : Math.round(target.y) - box.y;
  return nudgeRects(rects, dx, dy);
}

// ───────────────────────── 組成「一步」的修改 ─────────────────────────

type Placed = Pick<PlacementInput, 'key' | 'dest' | 'rotate' | 'flipH' | 'flipV'>;

/** 把 items 裡每一塊的新位置變成一批修改（rects 跟 items 一一對應）；交給 patchDraftItems 就是復原的一步 */
export const movePatches = (items: readonly { key: string }[], rects: readonly PixelRect[]): ItemPatchEntry[] =>
  items.map((it, i) => ({ key: it.key, patch: { dest: rects[i] } }));

/** 每一塊各自順時針（或逆時針）轉 90°，在原地轉（中心不動、寬高對調） */
export const rotatePatches = (items: readonly Placed[], dir: 1 | -1 = 1): ItemPatchEntry[] =>
  items.map(it => ({ key: it.key, patch: rotatePlacement90(it, dir) }));

/** 每一塊各自左右（或上下）翻轉，位置大小不動 */
export const flipPatches = (items: readonly Placed[], axis: 'h' | 'v'): ItemPatchEntry[] =>
  items.map(it => ({ key: it.key, patch: axis === 'h' ? { flipH: !it.flipH } : { flipV: !it.flipV } }));

/** 復原的「同一步」標籤：同一組螢幕連按微調 / 一直改同一個數字，合成一步（選的順序不同也算同一組） */
export const selectionTag = (prefix: string, keys: Selection): string => `${prefix}:${[...keys].sort().join(',')}`;
