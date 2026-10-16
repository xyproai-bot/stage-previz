// LED 畫布版型（像 d3 的 feed map）：純函式（不碰 three / 網路 / canvas），前端和後台共用同一份。
// 設計：docs/superpowers/specs/2026-10-15-led-canvas-templates-design.md；API：docs/led-templates-api.md
//
//   名詞
//   - 螢幕（screen）：一塊 LED。整個模型物件一塊（key = 'o:<物件 id>'，位置從模型的 UV 外框算）；
//                     一個物件裡有好幾塊的，在整張畫布上手動框出來（key = 's:<螢幕 id>'，位置是整張畫布的 UV 比例）
//   - 整張畫布（全部版型）：專案的 LED 畫布，每塊螢幕在裡面的位置 = 它真實的點數
//   - 版型：挑幾塊螢幕，各自放到版型畫布（像素）的某個長方形裡，可以轉 90° 的倍數、翻轉；沒挑到的螢幕顯示黑的
//
//   座標：跟 LED 貼圖一樣，原點在左上、y 朝下（flipY = false）。
//   轉動：以版型畫布上看到的樣子順時針轉；轉完再在目的地長方形裡翻（左右 / 上下）。dest 的 w × h 是轉完以後的外框。
//
// 這個檔案會被 cf-worker 直接 import（node / wrangler 都吃 .ts）：只用「抹掉型別就能跑」的語法（不用 enum / namespace）。

import { spanToPixels, type AxisSpan, type CanvasSize, type PixelRect } from './ledMap.ts';
import { normalizeLedCanvas } from './ledCanvas.ts';

export const TEMPLATE_VERSION = 1;
export const TEMPLATE_NAME_MAX = 40;
/** 系統預設的版型名稱（整張畫布）：自己建的版型不能叫這個名字 */
export const FULL_TEMPLATE_NAME = '全部';
export const SCALE_RANGE: [number, number] = [1, 400];
/** 一個物件（一個材質）最多同時放幾塊螢幕（shader 的陣列大小） */
export const MAX_SCREENS_PER_OBJECT = 8;
/** 一個版型最多放幾塊螢幕 */
export const MAX_PLACEMENTS = 200;
const COORD_LIMIT = 65536;
/** 兩個尺寸差在這個比例以內算「一樣」（拉伸提醒用） */
const STRETCH_TOLERANCE = 0.02;

export type Rotation = 0 | 90 | 180 | 270;
export const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];
/** 整張畫布的 UV 長方形：[u0, v0, u1, v1]，0 <= u0 < u1 <= 1 */
export type UvBox = [number, number, number, number];

/** 一塊螢幕在版型裡的放法（plan 裡的一筆，也是影片版本快照裡的一筆） */
export interface Placement {
  key: string;
  /** 這塊螢幕屬於哪個模型物件（stage_objects.id） */
  objectId: string;
  /** 手動切的螢幕（'s:' key）才有：整張畫布的 UV 長方形；整個物件一塊的 = null（從模型的 UV 外框算） */
  uv: UvBox | null;
  dest: PixelRect;
  rotate: Rotation;
  flipH: boolean;
  flipV: boolean;
}

/** 版型的完整排法（後台給的格式，也存在每一版影片裡當快照） */
export interface LedTemplatePlan {
  v: 1;
  id: string | null;
  name: string;
  canvas: CanvasSize;
  /** LED 真實點數 → 這個版型的比例（100 / 50 / 自訂） */
  scalePct: number;
  screens: Placement[];
  /**
   * 自動貼 UV 的「舊版面」快照才有：這些物件（stage_objects.id）的原本 UV 存在模型的第二組 UV（TEXCOORD_1），
   * 套用以前做的影片取色改用它（lib/stageLook/ledOriginalUv.ts），一個像素都不差。沒有 = 照 screens 的長方形取色（舊版前端也只看 screens）
   */
  originalUv?: string[];
}

/** 螢幕在整張畫布裡的範圍（UV 單位）：u / v 各一段，start 在 [0, 1)，length 在 (0, 1]，可以跨過 0 / 1 接縫 */
export interface SrcSpan { us: number; ul: number; vs: number; vl: number }

// ───────────────────────── key ─────────────────────────

export const objectKey = (objectId: string) => `o:${objectId}`;
export const manualKey = (screenId: string) => `s:${screenId}`;

const KEY_RE = /^([os]):([A-Za-z0-9_-]{1,64})$/;

export function parseScreenKey(key: unknown): { kind: 'object' | 'manual'; id: string } | null {
  if (typeof key !== 'string') return null;
  const m = KEY_RE.exec(key);
  if (!m) return null;
  return { kind: m[1] === 'o' ? 'object' : 'manual', id: m[2] };
}

// ───────────────────────── 輸入檢查（後台 / 前端表單共用）─────────────────────────

export interface PlacementInput {
  key: string;
  dest: PixelRect;
  rotate: Rotation;
  flipH: boolean;
  flipV: boolean;
}

export interface TemplateInput {
  name?: string;
  canvas?: CanvasSize;
  scalePct?: number;
  screens?: PlacementInput[];
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function wholeNumber(v: unknown): number | null {
  if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) v = Number(v);
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function flag(v: unknown): boolean | null {
  if (v === true || v === 1 || v === '1') return true;
  if (v === false || v === 0 || v === '0' || v === undefined || v === null) return false;
  return null;
}

export function normalizeTemplateName(raw: unknown): Parsed<string> {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!name) return { ok: false, error: '版型名稱不能是空的' };
  if (name.length > TEMPLATE_NAME_MAX) return { ok: false, error: `版型名稱最多 ${TEMPLATE_NAME_MAX} 個字` };
  if (name.toLowerCase() === FULL_TEMPLATE_NAME.toLowerCase()) {
    return { ok: false, error: `「${FULL_TEMPLATE_NAME}」是整張畫布的預設版型，請換一個名字` };
  }
  return { ok: true, value: name };
}

export function normalizeScalePct(raw: unknown): Parsed<number> {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < SCALE_RANGE[0] || n > SCALE_RANGE[1]) {
    return { ok: false, error: `比例要在 ${SCALE_RANGE[0]}% ~ ${SCALE_RANGE[1]}% 之間` };
  }
  return { ok: true, value: Math.round(n * 100) / 100 };
}

export function normalizePlacementInputs(raw: unknown): Parsed<PlacementInput[]> {
  if (!Array.isArray(raw)) return { ok: false, error: '螢幕清單格式不對' };
  if (raw.length > MAX_PLACEMENTS) return { ok: false, error: `一個版型最多放 ${MAX_PLACEMENTS} 塊螢幕` };
  const out: PlacementInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isObj(item)) return { ok: false, error: '螢幕清單格式不對' };
    const key = typeof item.key === 'string' ? item.key : '';
    if (!parseScreenKey(key)) return { ok: false, error: `螢幕代號不對：${String(item.key).slice(0, 40)}` };
    if (seen.has(key)) return { ok: false, error: '同一塊螢幕只能在版型裡放一次' };
    seen.add(key);
    const d = isObj(item.dest) ? item.dest : item;
    const x = wholeNumber(d.x), y = wholeNumber(d.y), w = wholeNumber(d.w), h = wholeNumber(d.h);
    if (x === null || y === null || w === null || h === null
      || Math.abs(x) > COORD_LIMIT || Math.abs(y) > COORD_LIMIT || w < 1 || h < 1 || w > COORD_LIMIT || h > COORD_LIMIT) {
      return { ok: false, error: '螢幕的位置和大小要是整數（寬、高至少 1）' };
    }
    const rotate = item.rotate === undefined || item.rotate === null ? 0 : wholeNumber(item.rotate);
    if (rotate === null || !ROTATIONS.includes(rotate as Rotation)) return { ok: false, error: '轉動只能是 0、90、180、270 度' };
    const flipH = flag(item.flipH), flipV = flag(item.flipV);
    if (flipH === null || flipV === null) return { ok: false, error: '翻轉格式不對' };
    out.push({ key, dest: { x, y, w, h }, rotate: rotate as Rotation, flipH, flipV });
  }
  return { ok: true, value: out };
}

/** 新增 / 修改版型的內容檢查；partial = 修改（沒給的欄位不動） */
export function normalizeTemplateInput(body: unknown, opts: { partial: boolean }): Parsed<TemplateInput> {
  if (!isObj(body)) return { ok: false, error: 'Invalid JSON' };
  const out: TemplateInput = {};
  if (!opts.partial || 'name' in body) {
    const n = normalizeTemplateName(body.name);
    if (!n.ok) return n;
    out.name = n.value;
  }
  if (!opts.partial || 'canvas' in body) {
    const c = normalizeLedCanvas(body.canvas);
    if (!c) return { ok: false, error: '版型畫布大小不對（寬高要是 16 ~ 32768 的整數）' };
    out.canvas = c;
  }
  if ('scalePct' in body || (!opts.partial && body.scalePct !== undefined)) {
    const s = normalizeScalePct(body.scalePct);
    if (!s.ok) return s;
    out.scalePct = s.value;
  } else if (!opts.partial) {
    out.scalePct = 100;
  }
  if ('screens' in body || !opts.partial) {
    const p = normalizePlacementInputs(body.screens === undefined ? [] : body.screens);
    if (!p.ok) return p;
    out.screens = p.value;
  }
  return { ok: true, value: out };
}

/** 手動切的螢幕：名字 + 整張畫布 UV 長方形（或像素長方形 + 畫布大小） */
export function normalizeManualScreenInput(body: unknown, opts: { partial: boolean; fullCanvas: CanvasSize | null }):
  Parsed<{ name?: string; objectId?: string; uv?: UvBox }> {
  if (!isObj(body)) return { ok: false, error: 'Invalid JSON' };
  const out: { name?: string; objectId?: string; uv?: UvBox } = {};
  if (!opts.partial || 'name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) return { ok: false, error: '螢幕名稱不能是空的' };
    if (name.length > TEMPLATE_NAME_MAX) return { ok: false, error: `螢幕名稱最多 ${TEMPLATE_NAME_MAX} 個字` };
    out.name = name;
  }
  if (!opts.partial || 'objectId' in body) {
    const id = typeof body.objectId === 'string' ? body.objectId : '';
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { ok: false, error: '要指定這塊螢幕屬於哪個 LED 物件' };
    out.objectId = id;
  }
  if (!opts.partial || 'uv' in body || 'rect' in body) {
    let uv: UvBox | null = null;
    if (Array.isArray(body.uv) && body.uv.length === 4 && body.uv.every(n => typeof n === 'number' && Number.isFinite(n))) {
      uv = body.uv.map(Number) as UvBox;
    } else if (isObj(body.rect) && opts.fullCanvas) {
      const r = body.rect;
      const x = wholeNumber(r.x), y = wholeNumber(r.y), w = wholeNumber(r.w), h = wholeNumber(r.h);
      if (x !== null && y !== null && w !== null && h !== null) {
        uv = [x / opts.fullCanvas.width, y / opts.fullCanvas.height, (x + w) / opts.fullCanvas.width, (y + h) / opts.fullCanvas.height];
      }
    }
    if (!uv) return { ok: false, error: '要給整張畫布上的範圍（uv 四個數字，或 rect 的 x、y、w、h）' };
    const [u0, v0, u1, v1] = uv;
    if (!(u0 >= 0 && v0 >= 0 && u1 <= 1 + 1e-9 && v1 <= 1 + 1e-9 && u1 > u0 && v1 > v0)) {
      return { ok: false, error: '這塊螢幕的範圍要在整張畫布裡，而且寬高大於 0' };
    }
    out.uv = [u0, v0, Math.min(1, u1), Math.min(1, v1)];
  }
  return { ok: true, value: out };
}

// ───────────────────────── 螢幕範圍 / 大小 ─────────────────────────

export const spanFromAxes = (u: AxisSpan, v: AxisSpan): SrcSpan => ({ us: u.start, ul: u.length, vs: v.start, vl: v.length });
export const spanFromUv = ([u0, v0, u1, v1]: UvBox): SrcSpan => ({ us: u0, ul: u1 - u0, vs: v0, vl: v1 - v0 });

/** 螢幕在整張畫布上的真實點數（寬, 高） */
export function nativeSize(span: SrcSpan, full: CanvasSize): { w: number; h: number } {
  const x = spanToPixels({ start: span.us, length: span.ul, wraps: false }, full.width);
  const y = spanToPixels({ start: span.vs, length: span.vl, wraps: false }, full.height);
  return { w: Math.max(1, x.len), h: Math.max(1, y.len) };
}

/** 轉動 90 / 270 度寬高對調 */
export function rotatedDims(w: number, h: number, rotate: Rotation): { w: number; h: number } {
  return rotate === 90 || rotate === 270 ? { w: h, h: w } : { w, h };
}

/** 從真實點數和比例算出放進版型的預設大小（四捨五入、至少 1；轉 90 / 270 度寬高對調） */
export function defaultDestSize(native: { w: number; h: number }, scalePct: number, rotate: Rotation = 0): { w: number; h: number } {
  const k = scalePct / 100;
  const r = rotatedDims(native.w, native.h, rotate);
  return { w: Math.max(1, Math.round(r.w * k)), h: Math.max(1, Math.round(r.h * k)) };
}

// ───────────────────────── 對應數學 ─────────────────────────

/** 螢幕本地座標 (0~1) → 目的地長方形本地座標 (0~1)： t = A·l + b，A = [a00 a01; a10 a11] */
export interface LocalTransform { a: [number, number, number, number]; b: [number, number] }

export function localTransform(rotate: Rotation, flipH: boolean, flipV: boolean): LocalTransform {
  // 先轉（順時針）：0 (x, y)；90 (1-y, x)；180 (1-x, 1-y)；270 (y, 1-x)
  let a: [number, number, number, number];
  let b: [number, number];
  switch (rotate) {
    case 90: a = [0, -1, 1, 0]; b = [1, 0]; break;
    case 180: a = [-1, 0, 0, -1]; b = [1, 1]; break;
    case 270: a = [0, 1, -1, 0]; b = [0, 1]; break;
    default: a = [1, 0, 0, 1]; b = [0, 0];
  }
  // 再翻（在目的地裡）
  if (flipH) { a = [-a[0], -a[1], a[2], a[3]]; b = [1 - b[0], b[1]]; }
  if (flipV) { a = [a[0], a[1], -a[2], -a[3]]; b = [b[0], 1 - b[1]]; }
  return { a, b };
}

export function applyLocalTransform(t: LocalTransform, lx: number, ly: number): [number, number] {
  return [t.a[0] * lx + t.a[1] * ly + t.b[0], t.a[2] * lx + t.a[3] * ly + t.b[1]];
}

const EDGE_EPS = 1e-5;

/** 整張畫布 UV → 螢幕本地座標 (0~1)；不在這塊螢幕裡 = null（會繞回，跨接縫的螢幕也算） */
export function uvToLocal(span: SrcSpan, u: number, v: number): [number, number] | null {
  let du = u - span.us;
  let dv = v - span.vs;
  du -= Math.floor(du + EDGE_EPS);
  dv -= Math.floor(dv + EDGE_EPS);
  if (du > span.ul + EDGE_EPS || dv > span.vl + EDGE_EPS) return null;
  return [Math.min(1, Math.max(0, du / span.ul)), Math.min(1, Math.max(0, dv / span.vl))];
}

/** 取到版型貼圖時往裡縮半個像素，雙線性過濾才不會讀到隔壁那塊螢幕 */
export function halfTexel(canvas: CanvasSize): [number, number] {
  return [0.5 / canvas.width, 0.5 / canvas.height];
}

/** 一塊螢幕上的一點（整張畫布 UV）→ 版型貼圖上的 UV；不在這塊螢幕裡 = null */
export function mapUvToTemplate(p: Placement, span: SrcSpan, canvas: CanvasSize, u: number, v: number): [number, number] | null {
  const l = uvToLocal(span, u, v);
  if (!l) return null;
  const [tx, ty] = applyLocalTransform(localTransform(p.rotate, p.flipH, p.flipV), l[0], l[1]);
  const [hx, hy] = halfTexel(canvas);
  const x0 = p.dest.x / canvas.width, x1 = (p.dest.x + p.dest.w) / canvas.width;
  const y0 = p.dest.y / canvas.height, y1 = (p.dest.y + p.dest.h) / canvas.height;
  const clampTo = (val: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, val)));
  return [
    clampTo(x0 + tx * (x1 - x0), x0 + hx, x1 - hx),
    clampTo(y0 + ty * (y1 - y0), y0 + hy, y1 - hy),
  ];
}

/** 某個物件的一點 → 版型貼圖上的 UV；srcFor 回傳每塊螢幕的範圍；物件沒有任何一塊包住這點 = null（顯示黑的） */
export function mapObjectUv(
  plan: LedTemplatePlan, objectId: string, srcFor: (p: Placement) => SrcSpan | null, u: number, v: number,
): [number, number] | null {
  for (const p of plan.screens) {
    if (p.objectId !== objectId) continue;
    const span = srcFor(p);
    if (!span) continue;
    const r = mapUvToTemplate(p, span, plan.canvas, u, v);
    if (r) return r;
  }
  return null;
}

/** 一塊 LED 取色用的 UV 長方形（燈光顏色用整塊螢幕的平均）：中心點在哪塊螢幕就用那塊，換成版型貼圖上的長方形；沒蓋到 = null（黑的） */
export function mapUvRectToTemplate(
  plan: LedTemplatePlan, objectId: string, srcFor: (p: Placement) => SrcSpan | null,
  rect: { u0: number; v0: number; u1: number; v1: number },
): { u0: number; v0: number; u1: number; v1: number } | null {
  const cu = (rect.u0 + rect.u1) / 2, cv = (rect.v0 + rect.v1) / 2;
  for (const p of plan.screens) {
    if (p.objectId !== objectId) continue;
    const span = srcFor(p);
    if (!span) continue;
    const c = uvToLocal(span, cu, cv);
    if (!c) continue;
    const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
    const a = [clamp01(c[0] + (rect.u0 - cu) / span.ul), clamp01(c[1] + (rect.v0 - cv) / span.vl)];
    const b = [clamp01(c[0] + (rect.u1 - cu) / span.ul), clamp01(c[1] + (rect.v1 - cv) / span.vl)];
    const t = localTransform(p.rotate, p.flipH, p.flipV);
    const ta = applyLocalTransform(t, a[0], a[1]);
    const tb = applyLocalTransform(t, b[0], b[1]);
    const canvas = plan.canvas;
    const toU = (n: number) => (p.dest.x + n * p.dest.w) / canvas.width;
    const toV = (n: number) => (p.dest.y + n * p.dest.h) / canvas.height;
    return {
      u0: toU(Math.min(ta[0], tb[0])), u1: toU(Math.max(ta[0], tb[0])),
      v0: toV(Math.min(ta[1], tb[1])), v1: toV(Math.max(ta[1], tb[1])),
    };
  }
  return null;
}

// ───────────────────────── 給 shader 的資料 ─────────────────────────

export interface TemplateUniformData {
  /** 這個物件放了幾塊（0 = 整個物件黑的） */
  count: number;
  /** 每塊 4 個數字：us, vs, ul, vl */
  src: number[];
  /** 每塊 4 個數字：x0, y0, x1, y1（版型貼圖的 UV） */
  dst: number[];
  /** 每塊 4 個數字：a00, a01, a10, a11 */
  mat: number[];
  /** 每塊 2 個數字：bx, by */
  off: number[];
  half: [number, number];
}

const padTo = (arr: number[], n: number) => { while (arr.length < n) arr.push(0); return arr; };

export function buildObjectUniforms(
  plan: LedTemplatePlan, objectId: string, srcFor: (p: Placement) => SrcSpan | null,
): TemplateUniformData {
  const src: number[] = [], dst: number[] = [], mat: number[] = [], off: number[] = [];
  let count = 0;
  for (const p of plan.screens) {
    if (p.objectId !== objectId || count >= MAX_SCREENS_PER_OBJECT) continue;
    const s = srcFor(p);
    if (!s) continue;
    const t = localTransform(p.rotate, p.flipH, p.flipV);
    src.push(s.us, s.vs, s.ul, s.vl);
    dst.push(p.dest.x / plan.canvas.width, p.dest.y / plan.canvas.height,
      (p.dest.x + p.dest.w) / plan.canvas.width, (p.dest.y + p.dest.h) / plan.canvas.height);
    mat.push(...t.a);
    off.push(...t.b);
    count++;
  }
  return {
    count,
    src: padTo(src, MAX_SCREENS_PER_OBJECT * 4),
    dst: padTo(dst, MAX_SCREENS_PER_OBJECT * 4),
    mat: padTo(mat, MAX_SCREENS_PER_OBJECT * 4),
    off: padTo(off, MAX_SCREENS_PER_OBJECT * 2),
    half: halfTexel(plan.canvas),
  };
}

// ───────────────────────── 螢幕清單 ─────────────────────────

export interface AutoScreenInput { objectId: string; name: string; order: number; src: SrcSpan }
export interface ManualScreen { id: string; objectId: string; name: string; uv: UvBox }

export interface ScreenDef {
  key: string;
  objectId: string;
  name: string;
  manual: boolean;
  uv: UvBox | null;
  src: SrcSpan;
  /** 在整張畫布上的真實點數 */
  nativeW: number;
  nativeH: number;
}

/**
 * 可以放進版型的螢幕：每個 LED 物件一塊（範圍從模型的 UV 外框來）；物件有手動切的螢幕時，只列手動切的
 * 排序：物件順序 → 手動切的依建立順序
 */
export function buildScreenList(autos: readonly AutoScreenInput[], manuals: readonly ManualScreen[], full: CanvasSize): ScreenDef[] {
  const splitObjects = new Set(manuals.map(m => m.objectId));
  const out: ScreenDef[] = [];
  const sorted = [...autos].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  for (const a of sorted) {
    const manualOfObject = manuals.filter(m => m.objectId === a.objectId);
    if (splitObjects.has(a.objectId)) {
      for (const m of manualOfObject) {
        const src = spanFromUv(m.uv);
        const n = nativeSize(src, full);
        out.push({ key: manualKey(m.id), objectId: m.objectId, name: m.name, manual: true, uv: m.uv, src, nativeW: n.w, nativeH: n.h });
      }
      continue;
    }
    const src = a.src;
    const n = nativeSize(src, full);
    out.push({ key: objectKey(a.objectId), objectId: a.objectId, name: a.name, manual: false, uv: null, src, nativeW: n.w, nativeH: n.h });
  }
  return out;
}

/** 把表單 / 後台的 screens（只有 key + 放法）補上 objectId / uv，變成 plan 裡的 Placement；對不到的螢幕丟掉 */
export function placementsFromInputs(inputs: readonly PlacementInput[], manuals: readonly ManualScreen[]): Placement[] {
  const byId = new Map(manuals.map(m => [m.id, m]));
  const out: Placement[] = [];
  for (const i of inputs) {
    const k = parseScreenKey(i.key);
    if (!k) continue;
    if (k.kind === 'object') out.push({ key: i.key, objectId: k.id, uv: null, dest: i.dest, rotate: i.rotate, flipH: i.flipH, flipV: i.flipV });
    else {
      const m = byId.get(k.id);
      if (m) out.push({ key: i.key, objectId: m.objectId, uv: m.uv, dest: i.dest, rotate: i.rotate, flipH: i.flipH, flipV: i.flipV });
    }
  }
  return out;
}

// ───────────────────────── 排法檢查（畫面上的提醒；不擋存檔）─────────────────────────

export type PlacementIssueKind = 'outside' | 'overlap' | 'stretch' | 'unknown';
export interface PlacementIssue { key: string; kind: PlacementIssueKind; text: string }

const rectsOverlap = (a: PixelRect, b: PixelRect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

export function checkPlacements(plan: LedTemplatePlan, screens: readonly ScreenDef[]): PlacementIssue[] {
  const byKey = new Map(screens.map(s => [s.key, s]));
  const issues: PlacementIssue[] = [];
  const nameOf = (key: string) => byKey.get(key)?.name ?? key;
  for (const p of plan.screens) {
    const def = byKey.get(p.key);
    if (!def) {
      issues.push({ key: p.key, kind: 'unknown', text: `「${nameOf(p.key)}」在模型裡找不到這塊螢幕（模型換過或物件刪掉了），播放時不會顯示` });
      continue;
    }
    const d = p.dest;
    if (d.x < 0 || d.y < 0 || d.x + d.w > plan.canvas.width || d.y + d.h > plan.canvas.height) {
      issues.push({ key: p.key, kind: 'outside', text: `「${def.name}」超出版型畫布（${plan.canvas.width}×${plan.canvas.height}）` });
    }
    const exp = defaultDestSize({ w: def.nativeW, h: def.nativeH }, plan.scalePct, p.rotate);
    const sx = d.w / exp.w, sy = d.h / exp.h;
    if (Math.abs(sx - 1) > STRETCH_TOLERANCE || Math.abs(sy - 1) > STRETCH_TOLERANCE) {
      issues.push({ key: p.key, kind: 'stretch', text: `「${def.name}」被拉伸了：${screenSizeLabel(def, p)}（比例應該是 ${formatPct(plan.scalePct)}，現在是橫 ${formatPct(sx * plan.scalePct)}、直 ${formatPct(sy * plan.scalePct)}）` });
    }
  }
  for (let i = 0; i < plan.screens.length; i++) {
    for (let j = i + 1; j < plan.screens.length; j++) {
      if (rectsOverlap(plan.screens[i].dest, plan.screens[j].dest)) {
        issues.push({ key: plan.screens[i].key, kind: 'overlap', text: `「${nameOf(plan.screens[i].key)}」和「${nameOf(plan.screens[j].key)}」重疊了` });
      }
    }
  }
  return issues;
}

export function formatPct(n: number): string {
  return `${Number(n.toFixed(1))}%`;
}

/** 「實際 8800×400 → 這個版型 4400×200」 */
export function screenSizeLabel(def: Pick<ScreenDef, 'nativeW' | 'nativeH'>, p: Pick<Placement, 'dest'>): string {
  return `實際 ${def.nativeW}×${def.nativeH} → 這個版型 ${p.dest.w}×${p.dest.h}`;
}

// ───────────────────────── 影片大小 vs 版型 ─────────────────────────

export type TemplateVideoFit =
  | { kind: 'exact' }
  /** 比例對、整體縮放一個倍數（放大貼回，LED 像素格照真實點數畫） */
  | { kind: 'scaled'; factor: number; pct: number }
  /** 比例不一樣：畫面會被拉寬 / 拉長 */
  | { kind: 'stretch'; how: '左右拉寬' | '上下拉長' };

/** 影片大小跟版型畫布比：一樣；剛好等比例縮放（差 1 個像素內算四捨五入）；比例不一樣 */
export function compareVideoToTemplate(video: CanvasSize, canvas: CanvasSize): TemplateVideoFit {
  if (video.width === canvas.width && video.height === canvas.height) return { kind: 'exact' };
  const kx = video.width / canvas.width;
  const ky = video.height / canvas.height;
  // 有一個倍數 k 讓寬、高都跟「版型 × k」差不到 1 個像素（輸出時四捨五入）→ 等比例
  const lo = Math.max((video.width - 1) / canvas.width, (video.height - 1) / canvas.height);
  const hi = Math.min((video.width + 1) / canvas.width, (video.height + 1) / canvas.height);
  if (lo <= hi) {
    const factor = (lo + hi) / 2;
    return { kind: 'scaled', factor, pct: Math.round(factor * 1000) / 10 };
  }
  // 放到 LED 上一律撐滿版型畫布：橫的放大比較多 = 左右拉寬
  return { kind: 'stretch', how: 1 / kx > 1 / ky ? '左右拉寬' : '上下拉長' };
}

export interface TemplateVideoNote { level: 'info' | 'warn'; kind: 'scaled' | 'stretch'; text: string }

/** 上傳前 / 版本列上要說的話；剛好一樣大 = null */
export function templateVideoNote(video: CanvasSize, plan: Pick<LedTemplatePlan, 'name' | 'canvas'>): TemplateVideoNote | null {
  const fit = compareVideoToTemplate(video, plan.canvas);
  const v = `${video.width}×${video.height}`;
  const c = `${plan.canvas.width}×${plan.canvas.height}`;
  if (fit.kind === 'exact') return null;
  if (fit.kind === 'scaled') {
    return {
      level: 'info', kind: 'scaled',
      text: `影片是版型「${plan.name}」的 ${formatPct(fit.pct)}（${v}，版型是 ${c}）：播放時自動${fit.factor < 1 ? '放大' : '縮小'}貼回，LED 像素格照真實點數畫`,
    };
  }
  return {
    level: 'warn', kind: 'stretch',
    text: `影片是 ${v}，版型「${plan.name}」是 ${c}，比例不一樣：畫面會被${fit.how}（變形）。請用 ${c} 的合成輸出`,
  };
}

/** 版本列上的一行：「版型「中間底幕」」或「版型「中間底幕」· 影片是版型的 50%」 */
export function versionTemplateLabel(plan: Pick<LedTemplatePlan, 'name' | 'canvas'> | null, video: { width: number | null; height: number | null }): string | null {
  if (!plan) return null;
  if (!video.width || !video.height) return `版型「${plan.name}」`;
  const fit = compareVideoToTemplate({ width: video.width, height: video.height }, plan.canvas);
  if (fit.kind === 'scaled') return `版型「${plan.name}」· 影片是版型的 ${formatPct(fit.pct)}`;
  if (fit.kind === 'stretch') return `版型「${plan.name}」· 影片比例跟版型不一樣（會變形）`;
  return `版型「${plan.name}」`;
}

// ───────────────────────── 讀 API 傳來的 plan（壞資料 = null）─────────────────────────

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 後台的 template 欄位（版本的快照 / 版型清單裡的一個）→ plan；任何地方不對 = null（當整張畫布） */
export function parsePlan(raw: unknown): LedTemplatePlan | null {
  let obj: unknown = raw;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return null; } }
  if (!isObj(obj)) return null;
  const canvas = normalizeLedCanvas(obj.canvas);
  if (!canvas || !Array.isArray(obj.screens)) return null;
  const screens: Placement[] = [];
  for (const s of obj.screens) {
    if (!isObj(s)) continue;
    const key = typeof s.key === 'string' ? s.key : '';
    const k = parseScreenKey(key);
    const objectId = typeof s.objectId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s.objectId) ? s.objectId : (k?.kind === 'object' ? k.id : '');
    const d = isObj(s.dest) ? s.dest : null;
    if (!k || !objectId || !d) continue;
    const x = num(d.x), y = num(d.y), w = num(d.w), h = num(d.h);
    if (x === null || y === null || w === null || h === null || w < 1 || h < 1) continue;
    const rotate = ROTATIONS.includes(s.rotate as Rotation) ? (s.rotate as Rotation) : 0;
    let uv: UvBox | null = null;
    if (Array.isArray(s.uv) && s.uv.length === 4 && s.uv.every(n => num(n) !== null)) {
      const [u0, v0, u1, v1] = s.uv as number[];
      if (u1 > u0 && v1 > v0) uv = [u0, v0, u1, v1];
    }
    if (k.kind === 'manual' && !uv) continue;
    screens.push({ key, objectId, uv, dest: { x, y, w, h }, rotate, flipH: s.flipH === true, flipV: s.flipV === true });
  }
  const scale = num(obj.scalePct);
  const originalUv = Array.isArray(obj.originalUv)
    ? [...new Set(obj.originalUv.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x)))].slice(0, MAX_PLACEMENTS)
    : [];
  return {
    v: 1,
    id: typeof obj.id === 'string' ? obj.id : null,
    name: typeof obj.name === 'string' && obj.name ? obj.name : '版型',
    canvas,
    scalePct: scale !== null && scale >= SCALE_RANGE[0] && scale <= SCALE_RANGE[1] ? scale : 100,
    screens,
    ...(originalUv.length > 0 ? { originalUv } : {}),
  };
}
