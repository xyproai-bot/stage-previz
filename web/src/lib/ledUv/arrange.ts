// 自動貼 UV 第 3 階段：自己排整張畫布（純函式）
//
// 排版 = 每一塊（螢幕片，或「保留原本 UV」的物件）在整張畫布上的 位置 + 轉 90° + 翻轉。
//   大小不能改：點數是 LED 規格決定的（點距 / 總點數 / 箱體），所以這裡只存 x、y、轉動、翻轉，
//   寬高永遠是「規格的寬高（轉 90° / 270° 對調）」現算的，不會有存了一個不對的大小的機會。
//   「保留原本 UV」的物件只能搬位置（它的 UV 是平移過去的，不轉、不翻）。
//   畫布：自動（剛好包住全部，寬高進位到 8 的倍數）或製作自己填的寬 × 高。
//   「連在一起」：幾塊綁成一組，一起移動、一起轉 / 翻（像一個整體）。
// 編輯器是 LED 版型那一套（LedTemplateCanvas），草稿用它的 Draft；這裡負責「版型草稿 ↔ 排好的方案」的換算和規則。
//   排好的 → plan.ts 的 buildPlan（arrangement）→ UV / 預覽 / 舊版面 / 對位圖，後面全部不用改。

import type { CanvasSize } from '../ledMap';
import { rotatedDims, type PlacementInput, type Rotation, type SrcSpan } from '../ledTemplate';
import type { Draft, ItemPatchEntry } from '../ledTemplateDraft';
import { flaggedKeys, rotatePlacement90 } from '../ledTemplateEdit';
import { boundsOf } from '../ledTemplateSelect';
import type { PackResult, Placed } from './pack';
import { composeOrientation, IDENTITY_ORIENTATION, type Orientation } from './orient';

/** 排版時的一塊：大小是 LED 規格決定的，排版時不能改 */
export interface ArrangeNative {
  key: string;
  name: string;
  /** 規格的寬 / 高（點），沒轉過的樣子 */
  w: number;
  h: number;
  /** 保留原本 UV 的物件：只能搬位置，不能轉、不能翻 */
  fixed: boolean;
}

export interface ArrangeItem { key: string; x: number; y: number; rotate: Rotation; flipH: boolean; flipV: boolean }

/** auto = 剛好包住全部螢幕；custom = 製作自己填的寬 × 高 */
export type CanvasMode = 'auto' | 'custom';

/** 存起來、也交給 buildPlan 的排法 */
export interface Arrangement {
  v: 1;
  canvasMode: CanvasMode;
  /** custom 的畫布大小（auto 時是最後一次算出來的，只供參考） */
  canvas: CanvasSize;
  items: ArrangeItem[];
  /** 連在一起的螢幕（每組至少 2 塊、組與組不重複） */
  groups: string[][];
}

/** 畫布長寬進位到這個倍數（跟自動排版一樣：HEVC 喜歡偶數） */
export const CANVAS_ROUND = 8;
export const CANVAS_MIN = 16;
export const CANVAS_MAX = 32768;

const roundUp = (n: number, m: number): number => (m <= 1 ? n : Math.ceil(n / m) * m);

/** 這一塊現在的長方形大小：規格的寬高，轉 90° / 270° 對調 */
export function dimsOf(native: Pick<ArrangeNative, 'w' | 'h'>, rotate: Rotation): { w: number; h: number } {
  return rotatedDims(native.w, native.h, rotate);
}

export function placedOf(native: ArrangeNative, it: Pick<ArrangeItem, 'x' | 'y' | 'rotate' | 'flipH' | 'flipV'>): Placed {
  const o: Orientation = native.fixed ? IDENTITY_ORIENTATION : { rotate: it.rotate, flipH: it.flipH, flipV: it.flipV };
  const d = dimsOf(native, o.rotate);
  return { x: Math.round(it.x), y: Math.round(it.y), w: d.w, h: d.h, rotate: o.rotate, flipH: o.flipH, flipV: o.flipV };
}

/** 畫布剛好包住這些長方形（寬高進位到 8 的倍數，至少 16）；一塊都沒有 = 0 × 0 */
export function autoCanvasOf(rects: readonly { x: number; y: number; w: number; h: number }[]): CanvasSize {
  if (rects.length === 0) return { width: 0, height: 0 };
  const w = Math.max(...rects.map(r => r.x + r.w)), h = Math.max(...rects.map(r => r.y + r.h));
  return { width: Math.max(CANVAS_MIN, roundUp(Math.max(1, w), CANVAS_ROUND)), height: Math.max(CANVAS_MIN, roundUp(Math.max(1, h), CANVAS_ROUND)) };
}

const clampCanvasSide = (n: number): number => Math.min(CANVAS_MAX, Math.max(CANVAS_MIN, Math.round(Number.isFinite(n) ? n : CANVAS_MIN)));

// ───────────────────────── 方案 ↔ 排法 ─────────────────────────

/** 照舞台自動排出來的樣子（沒動過的預設排法） */
export function arrangementFromPack(natives: readonly ArrangeNative[], pack: Pick<PackResult, 'placed' | 'canvas'>): Arrangement {
  const items: ArrangeItem[] = [];
  for (const n of natives) {
    const p = pack.placed.get(n.key);
    items.push({ key: n.key, x: p?.x ?? 0, y: p?.y ?? 0, rotate: 0, flipH: false, flipV: false });
  }
  return { v: 1, canvasMode: 'auto', canvas: { ...pack.canvas }, items, groups: [] };
}

export function pruneGroups(groups: readonly (readonly string[])[], valid: ReadonlySet<string>): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const g of groups) {
    const keys: string[] = [];
    for (const k of g) if (valid.has(k) && !seen.has(k)) { seen.add(k); keys.push(k); }
    if (keys.length >= 2) out.push(keys);
  }
  return out;
}

const sameGroups = (a: readonly (readonly string[])[], b: readonly (readonly string[])[]): boolean =>
  a.length === b.length && a.every((g, i) => g.length === b[i].length && g.every((k, j) => k === b[i][j]));

/**
 * 把存起來 / 編輯到一半的排法對齊目前的螢幕清單：還在的保留位置、轉動和翻轉（大小一律照現在的規格）；
 * 新多出來的螢幕放在自動排的位置；不見的拿掉（連組也拿掉）。arr = null 就是自動排的樣子。
 * 內容沒變就回傳原本那一個物件。
 */
export function reconcileArrangement(arr: Arrangement | null, natives: readonly ArrangeNative[], pack: Pick<PackResult, 'placed' | 'canvas'>): Arrangement {
  if (!arr) return arrangementFromPack(natives, pack);
  const byKey = new Map(arr.items.map(i => [i.key, i]));
  const items: ArrangeItem[] = natives.map((n) => {
    const e = byKey.get(n.key);
    if (!e) {
      const p = pack.placed.get(n.key);
      return { key: n.key, x: p?.x ?? 0, y: p?.y ?? 0, rotate: 0, flipH: false, flipV: false };
    }
    const fixed = n.fixed;
    return { key: n.key, x: Math.round(e.x), y: Math.round(e.y), rotate: fixed ? 0 : e.rotate, flipH: fixed ? false : e.flipH, flipV: fixed ? false : e.flipV };
  });
  const groups = pruneGroups(arr.groups, new Set(natives.map(n => n.key)));
  const next: Arrangement = {
    v: 1, canvasMode: arr.canvasMode,
    canvas: arr.canvasMode === 'auto' ? autoCanvasOf(items.map((it, i) => ({ ...it, ...dimsOf(natives[i], it.rotate) }))) : { width: clampCanvasSide(arr.canvas.width), height: clampCanvasSide(arr.canvas.height) },
    items, groups,
  };
  const same = next.canvasMode === arr.canvasMode && next.canvas.width === arr.canvas.width && next.canvas.height === arr.canvas.height
    && sameGroups(next.groups, arr.groups) && next.items.length === arr.items.length
    && next.items.every((it, i) => { const o = arr.items[i]; return o.key === it.key && o.x === it.x && o.y === it.y && o.rotate === it.rotate && o.flipH === it.flipH && o.flipV === it.flipV; });
  return same ? arr : next;
}

export interface ArrangeProblems {
  /** 超出畫布的（左上角在負數、或右下角超過畫布） */
  outside: string[];
  /** 互相重疊的（每一對） */
  overlaps: [string, string][];
}

export function problemsOf(placed: ReadonlyMap<string, Placed>, canvas: CanvasSize): ArrangeProblems {
  const list = [...placed.entries()].map(([key, p]) => ({ key, dest: { x: p.x, y: p.y, w: p.w, h: p.h } }));
  const flagged = flaggedKeys(list, canvas);
  const outside: string[] = [];
  for (const [k, kinds] of flagged) if (kinds.has('outside')) outside.push(k);
  const overlaps: [string, string][] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i].dest, b = list[j].dest;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps.push([list[i].key, list[j].key]);
    }
  }
  return { outside, overlaps };
}

export interface ResolvedArrangement { placed: Map<string, Placed>; canvas: CanvasSize; problems: ArrangeProblems }

/** 排法 → 每一塊最後的長方形 + 畫布 + 問題（buildPlan 用；排法對不上螢幕清單也不會壞） */
export function resolveArrangement(natives: readonly ArrangeNative[], pack: Pick<PackResult, 'placed' | 'canvas'>, arr: Arrangement): ResolvedArrangement {
  const rec = reconcileArrangement(arr, natives, pack);
  const nativeByKey = new Map(natives.map(n => [n.key, n]));
  const placed = new Map<string, Placed>();
  for (const it of rec.items) placed.set(it.key, placedOf(nativeByKey.get(it.key)!, it));
  const canvas = rec.canvasMode === 'auto' ? autoCanvasOf([...placed.values()]) : { ...rec.canvas };
  return { placed, canvas, problems: problemsOf(placed, canvas) };
}

// ───────────────────────── 畫布編輯器用的草稿 ─────────────────────────

/** 編輯器裡的草稿：LED 版型的 Draft（items 的 dest 寬高 = 規格鎖死）+ 畫布模式 + 連在一起的組 */
export interface ArrangeDoc extends Draft {
  canvasMode: CanvasMode;
  groups: string[][];
}

const destOf = (n: ArrangeNative, it: ArrangeItem): PlacementInput => {
  const p = placedOf(n, it);
  return { key: n.key, dest: { x: p.x, y: p.y, w: p.w, h: p.h }, rotate: p.rotate, flipH: p.flipH, flipV: p.flipV };
};

export function docFromArrangement(arr: Arrangement, natives: readonly ArrangeNative[]): ArrangeDoc {
  const rec = reconcileArrangement(arr, natives, { placed: new Map(), canvas: arr.canvas });
  const byKey = new Map(rec.items.map(i => [i.key, i]));
  const items = natives.map(n => destOf(n, byKey.get(n.key)!));
  const canvas = rec.canvasMode === 'auto' ? autoCanvasOf(items.map(i => i.dest)) : rec.canvas;
  return { id: null, name: '', width: canvas.width, height: canvas.height, scalePct: 100, items, canvasMode: rec.canvasMode, groups: rec.groups };
}

export function arrangementFromDoc(doc: ArrangeDoc): Arrangement {
  return {
    v: 1, canvasMode: doc.canvasMode, canvas: { width: doc.width, height: doc.height },
    items: doc.items.map(i => ({ key: i.key, x: i.dest.x, y: i.dest.y, rotate: i.rotate, flipH: i.flipH, flipV: i.flipV })),
    groups: doc.groups.map(g => [...g]),
  };
}

const sameItem = (a: PlacementInput, b: PlacementInput): boolean =>
  a.key === b.key && a.dest.x === b.dest.x && a.dest.y === b.dest.y && a.dest.w === b.dest.w && a.dest.h === b.dest.h
  && a.rotate === b.rotate && a.flipH === b.flipH && a.flipV === b.flipV;

/**
 * 編輯器每改一次都過這一關：大小鎖回規格（轉 90° 對調）、保留的物件不轉不翻、自動畫布跟著長、不存在的組拿掉。
 * 什麼都不用改 = 回傳同一個物件（復原重做才不會多一步）。
 */
export function normalizeDoc(doc: ArrangeDoc, natives: readonly ArrangeNative[]): ArrangeDoc {
  const byKey = new Map(natives.map(n => [n.key, n]));
  let changed = false;
  const items: PlacementInput[] = [];
  for (const it of doc.items) {
    const n = byKey.get(it.key);
    if (!n) { changed = true; continue; }
    const fixed = destOf(n, { key: it.key, x: it.dest.x, y: it.dest.y, rotate: it.rotate, flipH: it.flipH, flipV: it.flipV });
    if (!sameItem(fixed, it)) changed = true;
    items.push(sameItem(fixed, it) ? it : fixed);
  }
  const groups = pruneGroups(doc.groups, new Set(items.map(i => i.key)));
  if (!sameGroups(groups, doc.groups)) changed = true;
  let { width, height } = doc;
  if (doc.canvasMode === 'auto') {
    const c = autoCanvasOf(items.map(i => i.dest));
    if (c.width !== width || c.height !== height) { width = c.width; height = c.height; changed = true; }
  } else {
    const w = clampCanvasSide(width), h = clampCanvasSide(height);
    if (w !== width || h !== height) { width = w; height = h; changed = true; }
  }
  return changed ? { ...doc, items, groups, width, height } : doc;
}

/** 編輯器的修改（Draft → Draft 的純函式，跟版型編輯器共用的）套在草稿上，再鎖回規格 */
export function patchDoc(doc: ArrangeDoc, fn: (d: Draft) => Draft, natives: readonly ArrangeNative[]): ArrangeDoc {
  const next = fn(doc);
  if (next === doc) return doc;
  return normalizeDoc({ ...doc, ...next } as ArrangeDoc, natives);
}

/** 草稿對齊目前的螢幕清單（螢幕多了少了、點數改了）：見 reconcileArrangement */
export function reconcileDoc(doc: ArrangeDoc, natives: readonly ArrangeNative[], pack: Pick<PackResult, 'placed' | 'canvas'>): ArrangeDoc {
  const arr = arrangementFromDoc(doc);
  const rec = reconcileArrangement(arr, natives, pack);
  if (rec === arr) return normalizeDoc(doc, natives);
  return normalizeDoc(docFromArrangement(rec, natives), natives);
}

/** 版型編輯器的螢幕清單（ScreenDef）要的來源範圍：這一塊在「自動排版那張測試圖」裡的位置，框裡的對位圖內容從那裡剪 */
export function sourceSpan(rect: { x: number; y: number; w: number; h: number }, canvas: CanvasSize): SrcSpan {
  const W = Math.max(1, canvas.width), H = Math.max(1, canvas.height);
  return { us: rect.x / W, ul: rect.w / W, vs: rect.y / H, vl: rect.h / H };
}

// ───────────────────────── 全部靠左上 / 自動排一次 ─────────────────────────

/** 全部靠左上：整組一起平移，讓最左、最上的螢幕貼著畫布的左上角（螢幕之間的相對位置完全不變，貼好的還是貼著） */
export function moveAllToTopLeft(doc: ArrangeDoc, natives: readonly ArrangeNative[]): ArrangeDoc {
  const box = boundsOf(doc.items.map(i => i.dest));
  if (!box || (box.x === 0 && box.y === 0)) return doc;
  const items = doc.items.map(i => ({ ...i, dest: { ...i.dest, x: i.dest.x - box.x, y: i.dest.y - box.y } }));
  return normalizeDoc({ ...doc, items }, natives);
}

/** 自動排一次：全部照舞台的樣子重排（位置、轉動、翻轉重來）；畫布模式、自己填的畫布大小、連在一起的組都保留 */
export function autoLayoutDoc(doc: ArrangeDoc, natives: readonly ArrangeNative[], pack: Pick<PackResult, 'placed' | 'canvas'>): ArrangeDoc {
  const base = arrangementFromPack(natives, pack);
  const arr: Arrangement = { ...base, canvasMode: doc.canvasMode, canvas: { width: doc.width, height: doc.height }, groups: doc.groups };
  return normalizeDoc(docFromArrangement(arr, natives), natives);
}

export function setCanvasMode(doc: ArrangeDoc, mode: CanvasMode, natives: readonly ArrangeNative[]): ArrangeDoc {
  if (doc.canvasMode === mode) return doc;
  return normalizeDoc({ ...doc, canvasMode: mode }, natives);
}

export function setCustomCanvas(doc: ArrangeDoc, size: Partial<CanvasSize>, natives: readonly ArrangeNative[]): ArrangeDoc {
  const width = size.width ?? doc.width, height = size.height ?? doc.height;
  if (doc.canvasMode === 'custom' && width === doc.width && height === doc.height) return doc;
  return normalizeDoc({ ...doc, canvasMode: 'custom', width, height }, natives);
}

// ───────────────────────── 連在一起 ─────────────────────────

/** 選到的螢幕補上同組的其他塊（點一塊就選到整組） */
export function expandSelection(keys: readonly string[], groups: readonly (readonly string[])[]): string[] {
  const out = [...keys];
  const have = new Set(out);
  for (const k of keys) {
    const g = groups.find(x => x.includes(k));
    if (!g) continue;
    for (const m of g) if (!have.has(m)) { have.add(m); out.push(m); }
  }
  return out;
}

/** 把選到的連成一組（跟它們原本在的組併成一大組）；少於 2 塊 = 不動 */
export function joinGroups(groups: readonly (readonly string[])[], keys: readonly string[]): string[][] {
  const want = new Set(expandSelection(keys, groups));
  if (want.size < 2) return groups.map(g => [...g]);
  const rest = groups.filter(g => !g.some(k => want.has(k))).map(g => [...g]);
  return [...rest, [...want]];
}

/** 選到的所有組都拆開 */
export function splitGroups(groups: readonly (readonly string[])[], keys: readonly string[]): string[][] {
  const hit = new Set(keys);
  return groups.filter(g => !g.some(k => hit.has(k))).map(g => [...g]);
}

export const isInGroup = (groups: readonly (readonly string[])[], key: string): boolean => groups.some(g => g.includes(key));

// ───────────────────────── 轉 90° / 翻轉（整組當一個整體）─────────────────────────

export type UnitOp = 'rotCW' | 'rotCCW' | 'flipH' | 'flipV';

const OP_ORIENTATION: Record<UnitOp, Orientation> = {
  rotCW: { rotate: 90, flipH: false, flipV: false },
  rotCCW: { rotate: 270, flipH: false, flipV: false },
  flipH: { rotate: 0, flipH: true, flipV: false },
  flipV: { rotate: 0, flipH: false, flipV: true },
};

/**
 * 幾塊當一個整體轉 90° / 翻轉：每一塊的位置跟著整組的外框一起轉（整組的中心不動，所以貼著的還是貼著），
 * 每一塊自己的擺法 = 這個動作 ∘ 自己原本的擺法（畫面上就是整組像一張畫一樣轉過去）。位置、大小都是整數。
 */
export function unitPatches(items: readonly PlacementInput[], op: UnitOp): ItemPatchEntry[] {
  const box = boundsOf(items.map(i => i.dest));
  if (!box) return [];
  const { x: bx, y: by, w: W, h: H } = box;
  const turned = op === 'rotCW' || op === 'rotCCW';
  // 轉過以後整組外框的左上角：中心不動
  const ox = turned ? bx + Math.round((W - H) / 2) : bx;
  const oy = turned ? by + Math.round((H - W) / 2) : by;
  return items.map((it) => {
    const rx = it.dest.x - bx, ry = it.dest.y - by, w = it.dest.w, h = it.dest.h;
    let nx: number, ny: number, nw = w, nh = h;
    if (op === 'rotCW') { nx = H - (ry + h); ny = rx; nw = h; nh = w; }
    else if (op === 'rotCCW') { nx = ry; ny = W - (rx + w); nw = h; nh = w; }
    else if (op === 'flipH') { nx = W - (rx + w); ny = ry; }
    else { nx = rx; ny = H - (ry + h); }
    const next = composeOrientation(OP_ORIENTATION[op], { rotate: it.rotate, flipH: it.flipH, flipV: it.flipV });
    return { key: it.key, patch: { dest: { x: ox + nx, y: oy + ny, w: nw, h: nh }, rotate: next.rotate, flipH: next.flipH, flipV: next.flipV } };
  });
}

/**
 * 編輯器的「轉 90°」「左右翻轉」「上下翻轉」：選到的整組（連在一起的）當一個整體轉 / 翻，其他的各自在原地轉 / 翻（跟版型編輯器一樣）。
 * 不能轉的（保留原本 UV 的物件）跳過；整組裡有一塊不能轉，整組都不動。
 */
export function arrangeTransformPatches(
  kind: 'rotate' | 'flipH' | 'flipV', selected: readonly PlacementInput[], groups: readonly (readonly string[])[], fixed: ReadonlySet<string>,
): ItemPatchEntry[] {
  const picked = new Set(selected.map(i => i.key));
  const out: ItemPatchEntry[] = [];
  const used = new Set<string>();
  for (const g of groups) {
    if (!g.every(k => picked.has(k))) continue;
    g.forEach(k => used.add(k));
    if (g.some(k => fixed.has(k))) continue;
    const unit = selected.filter(i => g.includes(i.key));
    out.push(...unitPatches(unit, kind === 'rotate' ? 'rotCW' : kind));
  }
  for (const it of selected) {
    if (used.has(it.key) || fixed.has(it.key)) continue;
    if (kind === 'rotate') out.push({ key: it.key, patch: rotatePlacement90(it, 1) });
    else out.push({ key: it.key, patch: kind === 'flipH' ? { flipH: !it.flipH } : { flipV: !it.flipV } });
  }
  return out;
}

/** 選到的裡面有沒有能轉 / 翻的（按鈕要不要亮） */
export function canTransformSelection(selected: readonly PlacementInput[], groups: readonly (readonly string[])[], fixed: ReadonlySet<string>): boolean {
  return arrangeTransformPatches('rotate', selected, groups, fixed).length > 0;
}

// ───────────────────────── 存起來 / 讀回來 ─────────────────────────

const ROT_OK = new Set([0, 90, 180, 270]);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6 && Math.round(v) === v;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 後台 / 瀏覽器存的排法讀回來：格式不對的丟掉（回傳 null），多的欄位忽略 */
export function parseArrangement(raw: unknown): Arrangement | null {
  if (!isObj(raw) || raw.v !== 1 || !Array.isArray(raw.items)) return null;
  const mode: CanvasMode = raw.canvasMode === 'custom' ? 'custom' : 'auto';
  const c = isObj(raw.canvas) ? raw.canvas : {};
  const items: ArrangeItem[] = [];
  const seen = new Set<string>();
  for (const e of raw.items) {
    if (!isObj(e) || typeof e.key !== 'string' || e.key.length === 0 || e.key.length > 120 || seen.has(e.key)) return null;
    if (!isInt(e.x) || !isInt(e.y) || !ROT_OK.has(e.rotate as number) || typeof e.flipH !== 'boolean' || typeof e.flipV !== 'boolean') return null;
    seen.add(e.key);
    items.push({ key: e.key, x: e.x, y: e.y, rotate: e.rotate as Rotation, flipH: e.flipH, flipV: e.flipV });
  }
  if (items.length > 400) return null;
  const groups: string[][] = [];
  if (Array.isArray(raw.groups)) {
    for (const g of raw.groups) if (Array.isArray(g) && g.every(k => typeof k === 'string') && g.length >= 2 && g.length <= 400) groups.push([...g] as string[]);
  }
  return {
    v: 1, canvasMode: mode,
    canvas: { width: isInt(c.width) ? clampCanvasSide(c.width) : CANVAS_MIN, height: isInt(c.height) ? clampCanvasSide(c.height) : CANVAS_MIN },
    items, groups: pruneGroups(groups, seen),
  };
}
