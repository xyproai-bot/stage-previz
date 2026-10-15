// LED 畫布版型編輯器的純邏輯（不碰 DOM / three / 網路）：吸附、縮放把手、轉 90°、重疊 / 超出檢查、空位、縮放平移、復原重做、切螢幕的範圍換算。
// 畫面（拖拉、鍵盤）在 components/LedTemplateCanvas.tsx / LedSplitCanvas.tsx；這裡只算數字，所以可以單元測試。
// 設計：docs/superpowers/specs/2026-10-15-led-canvas-templates-design.md 的 1b
//
// 座標一律是版型畫布（或整張畫布）的像素，原點在左上、y 朝下；位置和大小一定是整數（後台只收整數）。

import type { CanvasSize, PixelRect } from './ledMap';
import type { Rotation, SrcSpan, UvBox } from './ledTemplate';

// ───────────────────────── 吸附 ─────────────────────────

/** 離邊多近（螢幕上的像素）會吸過去 */
export const SNAP_SCREEN_PX = 8;

export interface SnapTargets { xs: number[]; ys: number[] }
export interface SnapGuide { axis: 'x' | 'y'; at: number }
export interface SnapResult { rect: PixelRect; guides: SnapGuide[] }

/** 可以吸附的線：畫布的四條邊 + 別的螢幕的四條邊（去掉重複） */
export function snapTargets(canvas: CanvasSize, others: readonly PixelRect[]): SnapTargets {
  const xs = new Set<number>([0, canvas.width]);
  const ys = new Set<number>([0, canvas.height]);
  for (const r of others) {
    xs.add(r.x); xs.add(r.x + r.w);
    ys.add(r.y); ys.add(r.y + r.h);
  }
  return { xs: [...xs].sort((a, b) => a - b), ys: [...ys].sort((a, b) => a - b) };
}

/** values 裡的哪個數字離 targets 裡的哪條線最近（在 threshold 以內）；沒有 = null。delta = 要平移多少 */
export function snapLine(values: readonly number[], targets: readonly number[], threshold: number): { delta: number; at: number } | null {
  let best: { delta: number; at: number } | null = null;
  for (const v of values) {
    for (const t of targets) {
      const d = t - v;
      if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, at: t };
    }
  }
  return best;
}

/**
 * 拖著整塊移動：rawX / rawY = 滑鼠算出來的左上角（可以有小數）。
 * 一定先四捨五入成整數；snap = true 時，左 / 右邊靠近別人的邊或畫布邊就吸過去，上 / 下邊一樣。
 */
export function snapMove(
  rect: PixelRect, rawX: number, rawY: number, targets: SnapTargets, opts: { threshold: number; snap: boolean },
): SnapResult {
  let x = Math.round(rawX);
  let y = Math.round(rawY);
  const guides: SnapGuide[] = [];
  if (opts.snap) {
    const sx = snapLine([x, x + rect.w], targets.xs, opts.threshold);
    if (sx) { x += sx.delta; guides.push({ axis: 'x', at: sx.at }); }
    const sy = snapLine([y, y + rect.h], targets.ys, opts.threshold);
    if (sy) { y += sy.delta; guides.push({ axis: 'y', at: sy.at }); }
  }
  return { rect: { x, y, w: rect.w, h: rect.h }, guides };
}

export type Handle = 'nw' | 'ne' | 'sw' | 'se';

/**
 * 拖著角落縮放：對角那一個角不動，被拖的角跟著滑鼠（rawX / rawY = 滑鼠在畫布上的位置，可以有小數）。
 * 寬高至少 1；不會翻過去（拖過對角就停在 1 px）。keepAspect = 鎖長寬比（以拉得比較多的那一邊為準，這時不吸附）。
 */
export function snapResize(
  start: PixelRect, handle: Handle, rawX: number, rawY: number, targets: SnapTargets,
  opts: { threshold: number; snap: boolean; keepAspect?: boolean },
): SnapResult {
  const west = handle === 'nw' || handle === 'sw';
  const north = handle === 'nw' || handle === 'ne';
  const fx = west ? start.x + start.w : start.x;      // 不動的角
  const fy = north ? start.y + start.h : start.y;
  let mx = Math.round(rawX);
  let my = Math.round(rawY);
  const guides: SnapGuide[] = [];
  const keep = !!opts.keepAspect && start.w > 0 && start.h > 0;
  if (opts.snap && !keep) {
    const sx = snapLine([mx], targets.xs, opts.threshold);
    if (sx) { mx += sx.delta; guides.push({ axis: 'x', at: sx.at }); }
    const sy = snapLine([my], targets.ys, opts.threshold);
    if (sy) { my += sy.delta; guides.push({ axis: 'y', at: sy.at }); }
  }
  // 不能翻過去
  mx = west ? Math.min(mx, fx - 1) : Math.max(mx, fx + 1);
  my = north ? Math.min(my, fy - 1) : Math.max(my, fy + 1);
  let w = Math.abs(mx - fx);
  let h = Math.abs(my - fy);
  if (keep) {
    const ratio = start.w / start.h;
    if (w / ratio >= h) h = Math.max(1, Math.round(w / ratio));
    else w = Math.max(1, Math.round(h * ratio));
  }
  const x = west ? fx - w : fx;
  const y = north ? fy - h : fy;
  return { rect: { x, y, w, h }, guides };
}

/** 鍵盤微調 */
export function nudgeRect(r: PixelRect, dx: number, dy: number): PixelRect {
  return { x: r.x + Math.round(dx), y: r.y + Math.round(dy), w: r.w, h: r.h };
}

// ───────────────────────── 轉 90° / 翻轉 ─────────────────────────

/**
 * 轉 90°（dir 1 = 順時針，-1 = 逆時針）：外框的寬高對調，中心不動（四捨五入成整數）。
 * dest 是轉完以後的外框，所以轉 90° 一定要對調寬高。
 */
export function rotatePlacement90(p: { dest: PixelRect; rotate: Rotation }, dir: 1 | -1 = 1): { dest: PixelRect; rotate: Rotation } {
  const { x, y, w, h } = p.dest;
  const nw = h, nh = w;
  const cx = x + w / 2, cy = y + h / 2;
  const rotate = ((((p.rotate + 90 * dir) % 360) + 360) % 360) as Rotation;
  return { dest: { x: Math.round(cx - nw / 2), y: Math.round(cy - nh / 2), w: nw, h: nh }, rotate };
}

/** 改成指定的轉動：從 90 / 270 換到 0 / 180（或反過來）要對調寬高（中心不動） */
export function setRotation(p: { dest: PixelRect; rotate: Rotation }, rotate: Rotation): { dest: PixelRect; rotate: Rotation } {
  const swap = (p.rotate === 90 || p.rotate === 270) !== (rotate === 90 || rotate === 270);
  if (!swap) return { dest: p.dest, rotate };
  const turned = rotatePlacement90({ dest: p.dest, rotate: p.rotate }, 1);
  return { dest: turned.dest, rotate };
}

// ───────────────────────── 重疊 / 超出畫布 ─────────────────────────

export const rectsOverlap = (a: PixelRect, b: PixelRect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export const rectOutside = (r: PixelRect, canvas: CanvasSize) =>
  r.x < 0 || r.y < 0 || r.x + r.w > canvas.width || r.y + r.h > canvas.height;

export type EdgeProblem = 'outside' | 'overlap';

/** 每一塊有什麼問題（超出畫布 / 跟別塊重疊）；兩塊重疊時兩塊都標。沒問題的不在裡面 */
export function flaggedKeys(items: readonly { key: string; dest: PixelRect }[], canvas: CanvasSize): Map<string, Set<EdgeProblem>> {
  const out = new Map<string, Set<EdgeProblem>>();
  const add = (key: string, kind: EdgeProblem) => {
    const s = out.get(key) ?? new Set<EdgeProblem>();
    s.add(kind);
    out.set(key, s);
  };
  for (const it of items) if (rectOutside(it.dest, canvas)) add(it.key, 'outside');
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (rectsOverlap(items[i].dest, items[j].dest)) { add(items[i].key, 'overlap'); add(items[j].key, 'overlap'); }
    }
  }
  return out;
}

// ───────────────────────── 放進版型 ─────────────────────────

/**
 * 空位：先找畫布裡放得下又不碰別人的位置（由上到下、由左到右）；都放不下 = 放在所有東西的下面（會超出畫布，畫面上標紅，製作再把畫布加大）
 * 候選位置：左上角，和每一塊的右邊 / 下面。
 */
export function findFreeSpot(size: { w: number; h: number }, existing: readonly PixelRect[], canvas: CanvasSize): { x: number; y: number } {
  const cand: { x: number; y: number }[] = [{ x: 0, y: 0 }];
  for (const r of existing) {
    cand.push({ x: r.x + r.w, y: r.y }, { x: r.x, y: r.y + r.h }, { x: 0, y: r.y + r.h }, { x: r.x + r.w, y: 0 }, { x: r.x + r.w, y: r.y + r.h });
  }
  cand.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const c of cand) {
    const r = { x: c.x, y: c.y, w: size.w, h: size.h };
    if (c.x < 0 || c.y < 0 || rectOutside(r, canvas)) continue;
    if (existing.some(e => rectsOverlap(e, r))) continue;
    return c;
  }
  return { x: 0, y: existing.reduce((m, e) => Math.max(m, e.y + e.h), 0) };
}

/** 畫布剛好包住這些放法（至少 16×16）；沒有任何一塊 = null */
export function fitCanvasToItems(items: readonly { dest: PixelRect }[]): CanvasSize | null {
  if (items.length === 0) return null;
  return {
    width: Math.max(16, ...items.map(i => i.dest.x + i.dest.w)),
    height: Math.max(16, ...items.map(i => i.dest.y + i.dest.h)),
  };
}

// ───────────────────────── 縮放 / 平移 ─────────────────────────

export interface View { zoom: number; panX: number; panY: number }
export const ZOOM_MIN = 0.004;
export const ZOOM_MAX = 64;

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** 整張畫布塞進畫面（留邊）；小畫布最多放大到 8 倍 */
export function fitView(canvas: CanvasSize, viewport: { w: number; h: number }, margin = 28): View {
  const vw = Math.max(1, viewport.w - margin * 2);
  const vh = Math.max(1, viewport.h - margin * 2);
  const zoom = clampZoom(Math.min(vw / canvas.width, vh / canvas.height, 8));
  return { zoom, panX: (viewport.w - canvas.width * zoom) / 2, panY: (viewport.h - canvas.height * zoom) / 2 };
}

/** 以畫面上的 anchor 為中心縮放（anchor 底下的畫布位置不動） */
export function zoomAt(view: View, factor: number, anchor: { x: number; y: number }): View {
  const zoom = clampZoom(view.zoom * factor);
  const k = zoom / view.zoom;
  return { zoom, panX: anchor.x - (anchor.x - view.panX) * k, panY: anchor.y - (anchor.y - view.panY) * k };
}

export const toScreen = (v: View, p: { x: number; y: number }) => ({ x: p.x * v.zoom + v.panX, y: p.y * v.zoom + v.panY });
export const toCanvas = (v: View, p: { x: number; y: number }) => ({ x: (p.x - v.panX) / v.zoom, y: (p.y - v.panY) / v.zoom });

/** 格線間距（畫布像素）：兩條線在畫面上至少隔 minScreen px */
export function gridStep(zoom: number, minScreen = 36): number {
  const steps = [1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 50000];
  for (const s of steps) if (s * zoom >= minScreen) return s;
  return steps[steps.length - 1];
}

// ───────────────────────── 復原 / 重做 ─────────────────────────

export interface History<T> { past: readonly T[]; present: T; future: readonly T[]; tag: string | null; at: number }
export const HISTORY_LIMIT = 100;

export const newHistory = <T>(present: T): History<T> => ({ past: [], present, future: [], tag: null, at: 0 });

/**
 * 記一步。同一個 tag 在 coalesceMs 內連續記（鍵盤連按微調、一直改同一個數字）合成一步。
 * 回傳新的歷史（不改舊的）。
 */
export function commit<T>(h: History<T>, next: T, opts: { tag?: string; now?: number; coalesceMs?: number } = {}): History<T> {
  const now = opts.now ?? Date.now();
  const tag = opts.tag ?? null;
  if (tag && h.tag === tag && now - h.at <= (opts.coalesceMs ?? 600)) {
    return { ...h, present: next, at: now, future: [] };
  }
  const past = [...h.past, h.present];
  if (past.length > HISTORY_LIMIT) past.shift();
  return { past, present: next, future: [], tag, at: now };
}

/** 拖的途中：只換現在的樣子，不記步（放開時用 settle 記一步） */
export function transient<T>(h: History<T>, next: T): History<T> {
  return { ...h, present: next, tag: null };
}

/** 拖完了：把「開始拖之前」的樣子記成一步 */
export function settle<T>(h: History<T>, base: T): History<T> {
  const past = [...h.past, base];
  if (past.length > HISTORY_LIMIT) past.shift();
  return { past, present: h.present, future: [], tag: null, at: Date.now() };
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const past = h.past.slice(0, -1);
  return { past, present: h.past[h.past.length - 1], future: [h.present, ...h.future], tag: null, at: 0 };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), tag: null, at: 0 };
}

// ───────────────────────── 在整張畫布上切螢幕 ─────────────────────────

/** 兩個拖曳點 → 整數長方形（不管從哪個角拖起） */
export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): PixelRect {
  const x0 = Math.round(Math.min(a.x, b.x)), x1 = Math.round(Math.max(a.x, b.x));
  const y0 = Math.round(Math.min(a.y, b.y)), y1 = Math.round(Math.max(a.y, b.y));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 長方形裁成在畫布裡面的部分；完全在外面或沒有面積 = null */
export function clipRectToCanvas(r: PixelRect, canvas: CanvasSize): PixelRect | null {
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
  const x1 = Math.min(canvas.width, r.x + r.w), y1 = Math.min(canvas.height, r.y + r.h);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 整張畫布上的像素長方形 → 後台要的 UV 長方形 */
export function rectToUv(r: PixelRect, full: CanvasSize): UvBox {
  const c = (n: number) => Math.min(1, Math.max(0, n));
  return [c(r.x / full.width), c(r.y / full.height), c((r.x + r.w) / full.width), c((r.y + r.h) / full.height)];
}

/** UV 長方形 → 整張畫布上的像素長方形 */
export function uvToRect(uv: UvBox, full: CanvasSize): PixelRect {
  const x0 = Math.round(uv[0] * full.width), y0 = Math.round(uv[1] * full.height);
  return { x: x0, y: y0, w: Math.max(1, Math.round(uv[2] * full.width) - x0), h: Math.max(1, Math.round(uv[3] * full.height) - y0) };
}

function axisPieces(start: number, length: number): [number, number][] {
  const end = start + length;
  if (end <= 1 + 1e-9) return [[start, Math.min(1, end)]];
  return [[start, 1], [0, end - 1]];   // 跨過 0 / 1 接縫：分成兩段
}

/** 一塊螢幕在整張畫布上的範圍（會繞回的範圍分成好幾個長方形，最多 4 個） */
export function spanRects(span: SrcSpan, full: CanvasSize): PixelRect[] {
  const out: PixelRect[] = [];
  for (const [u0, u1] of axisPieces(span.us, span.ul)) {
    for (const [v0, v1] of axisPieces(span.vs, span.vl)) {
      const x0 = Math.round(u0 * full.width), x1 = Math.round(u1 * full.width);
      const y0 = Math.round(v0 * full.height), y1 = Math.round(v1 * full.height);
      if (x1 - x0 < 1 || y1 - y0 < 1) continue;
      out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  }
  return out;
}

const intersectArea = (a: PixelRect, b: PixelRect) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/** 畫出來的長方形最像是在切哪個 LED 物件：跟哪個物件的範圍重疊最多；都沒碰到 = null */
export function pickObjectForRect(rect: PixelRect, objects: readonly { objectId: string; src: SrcSpan }[], full: CanvasSize): string | null {
  let best: string | null = null;
  let bestArea = 0;
  for (const o of objects) {
    let area = 0;
    for (const piece of spanRects(o.src, full)) area += intersectArea(rect, piece);
    if (area > bestArea) { bestArea = area; best = o.objectId; }
  }
  return best;
}

/** 切開的名字：「物件名 1」「物件名 2」…，不跟這個物件已經切的重複 */
export function nextSplitName(objectName: string, existingNames: readonly string[]): string {
  const taken = new Set(existingNames);
  for (let i = 1; i < 1000; i++) {
    const n = `${objectName} ${i}`;
    if (!taken.has(n)) return n.slice(0, 40);
  }
  return objectName.slice(0, 40);
}
