// LED 版型編輯器的「複選」純邏輯（不碰 DOM / three / 網路）：Shift / Ctrl 點選、框選、整組一起移動（對整組的外框吸附）、整組微調、整組縮放、各自轉 90° / 翻轉。
// 畫面（滑鼠、鍵盤）在 components/LedTemplateCanvas.tsx；清單和數字欄位在 components/LedTemplatesDialog.tsx。這裡只算數字，所以可以單元測試。
//
// 選取 = 螢幕代號（key）的陣列，順序就是「選的先後」；沒有重複。
// 座標一律是版型畫布的像素（位置和大小是整數），框選的框是滑鼠算出來的畫布位置（可以有小數）。

import type { CanvasSize, PixelRect } from './ledMap';
import type { PlacementInput } from './ledTemplate';
import type { ItemPatchEntry } from './ledTemplateDraft';
import { nudgeRect, rectsOverlap, rotatePlacement90, snapLine, snapMove, snapTargets, type SnapGuide, type SnapTargets } from './ledTemplateEdit';

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

/** 工具列旁那一行：選了幾塊、外框多大（沒選 = 全部的外框） */
export interface SelectionInfo { all: boolean; count: number; box: PixelRect }
export function selectionInfo(items: readonly { key: string; dest: PixelRect }[], selected: Selection): SelectionInfo | null {
  const set = new Set(selected);
  const picked = items.filter(i => set.has(i.key));
  const use = picked.length > 0 ? picked : items;
  const box = boundsOf(use.map(i => i.dest));
  return box ? { all: picked.length === 0, count: use.length, box } : null;
}
const fmtN = (n: number): string => Math.round(n).toLocaleString('en-US');
export function selectionInfoText(info: SelectionInfo): string {
  const size = `寬 ${fmtN(info.box.w)} × 高 ${fmtN(info.box.h)} 點`;
  return info.all ? `全部 ${info.count} 塊：${size}` : `選了 ${info.count} 塊：${size} · 左上 ${fmtN(info.box.x)}, ${fmtN(info.box.y)}`;
}

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

/** 置中：整組外框放到畫布正中間（axis = 'x' 左右置中、'y' 上下置中）；整組一起平移、相對位置不變 */
export function centerGroupOnCanvas(rects: readonly PixelRect[], canvas: { width: number; height: number }, axis: 'x' | 'y'): PixelRect[] {
  const box = boundsOf(rects);
  if (!box) return [];
  return axis === 'x'
    ? moveGroupTo(rects, { x: Math.round((canvas.width - box.w) / 2) })
    : moveGroupTo(rects, { y: Math.round((canvas.height - box.h) / 2) });
}

export type GapMode = 'x' | 'y' | 'both';

/** 把垂直方向有重疊的塊分成「排」（照目前位置）；回傳每排的塊序號，排由上到下 */
export function groupIntoRows(rects: readonly PixelRect[]): number[][] {
  const order = rects.map((_, i) => i).sort((a, b) => rects[a].y - rects[b].y || rects[a].x - rects[b].x);
  const rows: number[][] = [];
  let bottom = -Infinity;
  for (const i of order) {
    if (rows.length > 0 && rects[i].y < bottom) {
      rows[rows.length - 1].push(i);
      bottom = Math.max(bottom, rects[i].y + rects[i].h);
    } else {
      rows.push([i]);
      bottom = rects[i].y + rects[i].h;
    }
  }
  return rows;
}

/** 移除縫隙：左右靠緊（每排第一塊不動、後面的緊貼前一塊右邊）、上下靠緊（第一排不動、後面整排往上貼）；'both' = 先左右再上下 */
export function closeGaps(rects: readonly PixelRect[], mode: GapMode = 'both'): PixelRect[] {
  const out = rects.map(r => ({ ...r }));
  if (out.length === 0) return out;
  if (mode !== 'y') {
    for (const row of groupIntoRows(out)) {
      const byX = [...row].sort((a, b) => out[a].x - out[b].x);
      for (let k = 1; k < byX.length; k++) out[byX[k]].x = out[byX[k - 1]].x + out[byX[k - 1]].w;
    }
  }
  if (mode !== 'x') {
    const rows = groupIntoRows(out);
    let prevBottom: number | null = null;
    for (const row of rows) {
      const top = Math.min(...row.map(i => out[i].y));
      const bottom = Math.max(...row.map(i => out[i].y + out[i].h));
      const dy: number = prevBottom === null ? 0 : prevBottom - top;
      for (const i of row) out[i].y += dy;
      prevBottom = bottom + dy;
    }
  }
  return out;
}

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

// ───────────────────────── 整組縮放 ─────────────────────────

/** 整組外框上的八個把手：四個角（預設等比例縮放）和四條邊（只縮那一個方向） */
export type GroupHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export const GROUP_HANDLES: readonly GroupHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export const isCornerHandle = (h: GroupHandle): boolean => h.length === 2;

/**
 * 以 anchor 為不動點，每一塊的位置（離 anchor 多遠）和大小都乘上同樣的倍數（sx 橫向、sy 直向，要大於 0）。
 * 用「邊」四捨五入成整數（不是用寬高），所以原本貼在一起的兩塊縮完還是貼在一起，不會出現 1 像素的縫；
 * 每一塊的寬高至少 1 像素。
 */
export function scaleRects(start: readonly PixelRect[], anchor: { x: number; y: number }, sx: number, sy: number): PixelRect[] {
  const X = (v: number) => Math.round(anchor.x + (v - anchor.x) * sx);
  const Y = (v: number) => Math.round(anchor.y + (v - anchor.y) * sy);
  return start.map(r => {
    const x0 = X(r.x), x1 = X(r.x + r.w), y0 = Y(r.y), y1 = Y(r.y + r.h);
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  });
}

export interface GroupScale { rects: PixelRect[]; box: PixelRect; guides: SnapGuide[]; sx: number; sy: number }

/**
 * 拖著整組外框的把手縮放：對面的那個角（或那條邊）不動，整組每一塊的位置和大小都乘上同樣的倍數。
 * rawX / rawY = 滑鼠在畫布上的位置（可以有小數）。
 *   角落：keepAspect = true（預設的樣子）鎖整組的長寬比，以拉得比較多的那一邊為準；false（按住 Shift）橫直各縮各的。
 *   邊：只縮那一個方向。
 *   不會翻過去（拖過對面就停在 1 像素），每一塊至少 1 像素，位置和大小都是整數。
 *   snap = true：被拖的那條邊靠近「沒被選到的螢幕的邊」或畫布的邊就吸過去（鎖長寬比時，吸到的那一邊決定倍數，另一邊跟著算）。
 */
export function snapGroupScale(
  start: readonly PixelRect[], handle: GroupHandle, rawX: number, rawY: number, targets: SnapTargets,
  opts: { threshold: number; snap: boolean; keepAspect: boolean },
): GroupScale {
  const box = boundsOf(start);
  if (!box) return { rects: [], box: { x: 0, y: 0, w: 0, h: 0 }, guides: [], sx: 1, sy: 1 };
  const west = handle.includes('w'), east = handle.includes('e'), north = handle.includes('n'), south = handle.includes('s');
  const movesX = west || east, movesY = north || south;
  const lock = movesX && movesY && opts.keepAspect;
  const ax = west ? box.x + box.w : box.x;        // 不動的那一側
  const ay = north ? box.y + box.h : box.y;
  // 被拖的那條邊離不動的那一側多遠（至少 1，不翻過去）
  const lenX = (edge: number) => Math.max(1, west ? ax - edge : edge - ax);
  const lenY = (edge: number) => Math.max(1, north ? ay - edge : edge - ay);
  const mx = Math.round(rawX), my = Math.round(rawY);
  const trySnap = (v: number, lines: readonly number[]) => {
    if (!opts.snap) return null;
    const s = snapLine([v], lines, opts.threshold);
    return s ? { edge: v + s.delta, at: s.at, dist: Math.abs(s.delta) } : null;
  };
  const guides: SnapGuide[] = [];
  let newW = box.w, newH = box.h;
  if (!lock) {
    if (movesX) {
      const s = trySnap(mx, targets.xs);
      if (s) guides.push({ axis: 'x', at: s.at });
      newW = lenX(s ? s.edge : mx);
    }
    if (movesY) {
      const s = trySnap(my, targets.ys);
      if (s) guides.push({ axis: 'y', at: s.at });
      newH = lenY(s ? s.edge : my);
    }
  } else {
    const sxs = trySnap(mx, targets.xs), sys = trySnap(my, targets.ys);
    let drive: 'x' | 'y';
    if (sxs && sys) drive = sxs.dist <= sys.dist ? 'x' : 'y';
    else if (sxs) drive = 'x';
    else if (sys) drive = 'y';
    else drive = lenX(mx) / box.w >= lenY(my) / box.h ? 'x' : 'y';
    if (drive === 'x') {
      newW = lenX(sxs ? sxs.edge : mx);
      newH = Math.max(1, Math.round(box.h * (newW / box.w)));
      if (sxs) guides.push({ axis: 'x', at: sxs.at });
    } else {
      newH = lenY(sys ? sys.edge : my);
      newW = Math.max(1, Math.round(box.w * (newH / box.h)));
      if (sys) guides.push({ axis: 'y', at: sys.at });
    }
  }
  const sx = newW / box.w, sy = newH / box.h;
  const anchor = { x: movesX ? ax : box.x, y: movesY ? ay : box.y };
  const nb = { x: movesX && west ? ax - newW : box.x, y: movesY && north ? ay - newH : box.y, w: newW, h: newH };
  return { rects: scaleRects(start, anchor, sx, sy), box: nb, guides, sx, sy };
}

/** 數字欄位改整組外框的寬 / 高：左上角不動；lockAspect = 只給一邊時另一邊照長寬比跟著變 */
export function scaleGroupTo(start: readonly PixelRect[], target: { w?: number; h?: number }, lockAspect: boolean): PixelRect[] {
  const box = boundsOf(start);
  if (!box) return [];
  let w = target.w === undefined ? box.w : Math.max(1, Math.round(target.w));
  let h = target.h === undefined ? box.h : Math.max(1, Math.round(target.h));
  if (lockAspect && target.w !== undefined && target.h === undefined) h = Math.max(1, Math.round(box.h * (w / box.w)));
  else if (lockAspect && target.h !== undefined && target.w === undefined) w = Math.max(1, Math.round(box.w * (h / box.h)));
  return scaleRects(start, { x: box.x, y: box.y }, w / box.w, h / box.h);
}

/** 「整組縮放 %」：50 = 縮成一半大、200 = 放大一倍，以整組外框的左上角為準；不合理的百分比（0、負的、不是數字）= 不動 */
export function scaleGroupPct(start: readonly PixelRect[], pct: number): PixelRect[] {
  const box = boundsOf(start);
  if (!box) return [];
  if (!Number.isFinite(pct) || pct <= 0) return start.map(r => ({ ...r }));
  const f = pct / 100;
  return scaleRects(start, { x: box.x, y: box.y }, f, f);
}
