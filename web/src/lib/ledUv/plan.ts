// 自動貼 UV：把「每個物件的分析 + 製作填的點數」變成排版方案（純函式）
//
// 每個 LED 物件最後是三種狀態之一：
//   自動貼（auto）  勾了、而且全是平面 → 每一片螢幕照點數排進畫布，UV 全部重算
//   保留（keep）    沒勾、或這個物件第 1 階段還不能處理（弧面、已經手動切過）→ 原本的 UV 整片平移到新位置，大小、方向不變
//                   （畫布整張重排，所以沒處理的螢幕也要搬過去，不然會壓到別人）
//   不處理（none）  沒有 UV 又不能自動貼 → 不動
//   不放進畫布（excluded）  製作選了「不放進畫布」→ 完全不進排版（畫布大小、對位圖、AE 腳本、座標表、舊版面都沒有它），模型裡它的 UV 不動；
//                           套用時後台把它的類型從 LED 面板改成「其他」（之後不再有影片）
// 一個物件有好幾片分開的平面 → 每一片各自是一塊螢幕，分開排（每片各建一個手動螢幕，版型裡才能分開放）。

import type { CanvasSize, PixelRect } from '../ledMap';
import { partNames } from '../ledScreen';
import type { UvBox } from '../ledTemplate';
import { dot, WORLD_UP, type Vec3 } from './geometry';
import { packStageShaped, type PackItem, type Placed, type PackResult } from './pack';
import { resolveArrangement, type ArrangeNative, type ArrangeProblems, type Arrangement } from './arrange';
import { composeOrientation, IDENTITY_ORIENTATION, invertOrientation, isIdentity } from './orient';
import { resolveSize, type Measured, type SizeResult, type SizeSpec } from './size';
import type { ObjectInfo } from './objectInfo';
import { flatUvForPrim, keepUvForPrim, type KeepMap, type PrimUv } from './place';
import { audienceRight, type DistortionStat, type ObjectGeom, type Piece, type SurfaceOverride } from './surfaces';
import { BLOCKED_TEXT, EXCLUDED_REASON, KEEP_TEXT, MISSING_TEXT, NO_UV_TEXT, SPLITS_TEXT, UNSUPPORTED_TEXT, WARN_TEXT } from './text';

export interface ManualBox { id: string; name: string; uv: UvBox }

export interface PlanObjectIn {
  id: string;
  name: string;
  order: number;
  /** 模型裡找不到這個物件 = null */
  info: ObjectInfo | null;
  /** 製作勾了要自動貼 */
  selected: boolean;
  /** 製作選了「不放進畫布」：蓋過 selected（不排版、不算進畫布，套用後類型改成「其他」） */
  excluded?: boolean;
  /** 每一片螢幕的點數（片的編號 → 輸入）；沒填 = 還沒填 */
  sizes: Record<number, SizeSpec | undefined>;
  /** 這個物件已經手動切出來的螢幕 */
  manuals: ManualBox[];
  /** 製作手動指定的類型（平面 / 弧面 / 自由曲面）；沒指定 = 自動辨識。info 要是照同一個指定分析出來的 */
  override?: SurfaceOverride;
  /** 封閉圓柱的接縫：從背面往觀眾右手邊轉幾度（沒指定 = 0）。info 要是照同一個設定分析出來的 */
  seamDeg?: number;
  /** 物件裡有好幾塊 LED mesh 時，個別塊的選擇（mesh 名稱 → 保留原本 UV / 不放進畫布）；沒列 = 跟著整個物件（自動貼）。只有整個物件是「自動貼」才看這個 */
  pieceChoices?: Record<string, PieceChoice>;
}

/** 物件裡某一塊 LED mesh 不跟著自動貼：保留原本 UV（搬到新位置）、或不放進畫布（它的 UV 不動，也沒有螢幕） */
export type PieceChoice = 'keep' | 'exclude';

export type ObjectMode = 'auto' | 'keep' | 'excluded' | 'none' | 'missing';

export interface PlanPiece {
  index: number;
  key: string;
  name: string;
  /** 平面 / 弧面 / 擠出曲面（波浪、折角）/ 自由曲面（弧面的 measured.w 是真正的弧長，擠出曲面是側面形狀的弧長） */
  surface: 'flat' | 'arc' | 'ext' | 'free';
  /** 弧面：凸（觀眾在圓柱外面看）= true、凹 = false；其他沒有 */
  convex?: boolean;
  /** 弧面的角度範圍（度） */
  spanDeg?: number;
  /** 整圈 360 度的封閉圓柱（接縫會拆頂點） */
  closed?: boolean;
  /** 封閉圓柱：接縫實際落在離背面多遠（度，往觀眾右手邊為正） */
  seamDeg?: number;
  /** 攤平的變形 */
  distortion: DistortionStat;
  measured: Measured;
  size: SizeResult | null;
  placed: Placed | null;
  /** 物件裡有好幾塊 LED mesh 時：這一片的 mesh 名稱和編號（PrimGeom.group） */
  label?: string;
  group?: number;
  /** 這一塊自己選了保留 / 不放進畫布（沒有 = 自動貼）。exclude 沒有位置；keep 的位置是原本的大小 */
  choice?: PieceChoice;
  /** choice = 'keep'：原本的範圍和搬動的量 */
  keepRect?: PixelRect;
  keepMap?: KeepMap;
}

export interface PlanKeep {
  map: KeepMap;
  /** 原本的範圍（原本畫布的像素） */
  rect: PixelRect;
  placed: Placed;
  /** 手動切的螢幕的新 UV 範圍 */
  manualUpdates: { id: string; uv: UvBox }[];
}

export interface PlanObject {
  id: string;
  name: string;
  mode: ObjectMode;
  /** 為什麼是這個狀態（白話） */
  reason: string;
  pieces: PlanPiece[];
  keep: PlanKeep | null;
  warnings: string[];
  /** 製作手動指定的類型（沒指定 = 自動） */
  override: SurfaceOverride;
  /** 製作設定的封閉圓柱接縫位置（度；沒設 = 0） */
  seamDeg: number;
  /** 不能貼的曲面：硬貼會變形多少（給製作看為什麼保留原本的 UV） */
  freeform?: { distortion: DistortionStat; via: 'flat' | 'arc' };
}

export interface Plan {
  objects: PlanObject[];
  canvas: { width: number; height: number };
  /** 擋住「套用」的問題（白話） */
  blockers: string[];
  warnings: string[];
  rows: number;
  /** 照舞台自動排出來的結果（沒套用自己排的排法時，畫布和位置就是它；「自動排一次」也是它） */
  pack: PackResult;
  /** 排版時的每一塊（螢幕片或保留的物件）：大小是規格決定的，排版時不能改 */
  items: ArrangeNative[];
  /** 這個方案用的是製作自己排的排法（不是自動排的） */
  arranged: boolean;
  /** 自己排的排法有什麼問題（超出畫布、重疊）；沒套用自己排的 = null */
  problems: ArrangeProblems | null;
  /** blockers 裡面，是自己排的排法造成的那幾條（超出畫布）；3D 預覽只被「點數還沒填」擋住，不被這幾條擋住 */
  arrangeBlockers: string[];
}

export interface PlanContext {
  front: Vec3;
  /** 每個文件單位是幾公尺（自動縮放 × 測距校準） */
  metersPerUnit: number;
  /** 算原本範圍用的畫布（專案沒設定 = 預設大小） */
  oldCanvas: CanvasSize;
  gutter?: number;
  roundTo?: number;
  /** 製作自己排的排法（位置 / 轉 90° / 翻轉 / 畫布大小）；沒有 = 照舞台自動排。對不上螢幕清單的部分會被忽略或補上自動排的位置 */
  arrangement?: Arrangement | null;
}

const MAX_CANVAS_SIDE = 32768;

export const pieceKey = (id: string, count: number, i: number): string => (count > 1 ? `o:${id}#${i}` : `o:${id}`);
export const pieceName = (name: string, count: number, i: number): string => (count > 1 ? `${name} ${i + 1}` : name);

function cornersOf(p: Piece): Vec3[] {
  // 弧面、擠出曲面、自由曲面：用螢幕頂點的外框八個角算舞台上的位置
  if (p.kind !== 'flat') return boxPoints(p.bbox.min, p.bbox.max);
  const f = p.frame;
  const out: Vec3[] = [];
  for (const x of [f.minX, f.maxX]) for (const y of [f.minY, f.maxY]) {
    out.push([
      f.origin[0] + f.right[0] * x + f.down[0] * y,
      f.origin[1] + f.right[1] * x + f.down[1] * y,
      f.origin[2] + f.right[2] * x + f.down[2] * y,
    ]);
  }
  return out;
}

function stageBox(points: Vec3[], front: Vec3, right: Vec3): Pick<PackItem, 'x' | 'y' | 'd' | 'yRange' | 'dRange'> {
  let x = 0, y = 0, d = 0;
  let y0 = Infinity, y1 = -Infinity, d0 = Infinity, d1 = -Infinity;
  for (const p of points) {
    x += dot(p, right); y += p[1]; d += dot(p, front);
    y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
    const dd = dot(p, front);
    d0 = Math.min(d0, dd); d1 = Math.max(d1, dd);
  }
  const n = points.length || 1;
  return { x: x / n, y: y / n, d: d / n, yRange: [y0, y1], dRange: [d0, d1] };
}

function boxPoints(min: Vec3, max: Vec3): Vec3[] {
  const out: Vec3[] = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push([x, y, z]);
  return out;
}

export function buildPlan(inputs: readonly PlanObjectIn[], ctx: PlanContext): Plan {
  const right = audienceRight(ctx.front);
  const sorted = [...inputs].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const objects: PlanObject[] = [];
  const items: PackItem[] = [];
  const natives: ArrangeNative[] = [];
  /** 自己排的排法造成的擋住套用的問題（超出畫布）：預覽不受影響 */
  const arrangeBlockers: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  for (const inp of sorted) {
    const info = inp.info;
    const obj: PlanObject = { id: inp.id, name: inp.name, mode: 'none', reason: '', pieces: [], keep: null, warnings: [], override: inp.override ?? 'auto', seamDeg: inp.seamDeg ?? 0, freeform: info?.freeform };
    objects.push(obj);
    if (inp.excluded) { obj.mode = 'excluded'; obj.reason = EXCLUDED_REASON; continue; }
    if (!info) { obj.mode = 'missing'; obj.reason = MISSING_TEXT; continue; }
    obj.warnings.push(...info.warnings);

    // 勾了、全是平面、沒有手動切過 → 自動貼
    const canAuto = info.kind === 'ok' && inp.manuals.length === 0;
    if (inp.selected && canAuto) {
      obj.mode = 'auto';
      obj.reason = '';
      const count = info.pieces.length;
      // 物件裡有好幾塊 LED mesh：每一片用 mesh 名稱；沒有（或有的片沒有名稱）= 照舊「物件名 1、2…」
      const labels = count > 1 && info.pieces.every(p => !!p.label) ? partNames(info.pieces.map(p => p.label), inp.name) : null;
      // 個別塊的選擇要每一塊都有不重複的 mesh 名稱和編號才能用
      const grouped = !!labels && new Set(info.pieces.map(p => p.label)).size === count && info.pieces.every(p => p.group !== undefined && !!p.label);
      info.pieces.forEach((piece, i) => {
        const measured = { w: piece.widthU * ctx.metersPerUnit, h: piece.heightU * ctx.metersPerUnit };
        const spec = inp.sizes[i];
        const key = pieceKey(inp.id, count, i);
        const name = labels ? labels[i] : pieceName(inp.name, count, i);
        const size = spec ? resolveSize(spec, measured) : null;
        let choice: PieceChoice | undefined = grouped ? inp.pieceChoices?.[piece.label!] : undefined;
        const groupRegion = choice === 'keep' ? info.groupRegions?.[piece.group!] ?? null : null;
        if (choice === 'keep' && !groupRegion) { obj.warnings.push(`${name}：原本沒有 UV，沒辦法保留，這一塊不放進畫布`); choice = 'exclude'; }
        const pp: PlanPiece = { index: i, key: choice === 'keep' ? `o:${inp.id}~${piece.label}` : key, name, ...(grouped ? { label: piece.label, group: piece.group } : {}), ...(choice ? { choice } : {}), surface: piece.kind, ...(piece.arc ? { convex: piece.arc.convex, spanDeg: (piece.arc.span * 180) / Math.PI, ...(piece.arc.closed ? { closed: true, seamDeg: piece.arc.seamDeg } : {}) } : {}), distortion: piece.distortion, measured, size, placed: null };
        obj.pieces.push(pp);
        if (choice === 'exclude') return;
        if (choice === 'keep' && groupRegion) {
          pp.keepRect = groupRegion.rect;
          const kbox = stageBox(cornersOf(piece), ctx.front, right);
          items.push({ key: pp.key, name, w: Math.max(1, groupRegion.rect.w), h: Math.max(1, groupRegion.rect.h), ...kbox, floor: Math.abs(dot(piece.frame.normal, WORLD_UP)) >= 0.9 });
          natives.push({ key: pp.key, name, w: Math.max(1, groupRegion.rect.w), h: Math.max(1, groupRegion.rect.h), fixed: true });
          return;
        }
        if (!size) { blockers.push(BLOCKED_TEXT.size(name, '還沒填點數')); return; }
        if (!size.ok) { blockers.push(BLOCKED_TEXT.size(name, size.error || '點數不能用')); return; }
        for (const w of size.warnings) obj.warnings.push(`${name}：${w}`);
        const box = stageBox(cornersOf(piece), ctx.front, right);
        items.push({ key, name, w: size.w, h: size.h, ...box, floor: Math.abs(dot(piece.frame.normal, WORLD_UP)) >= 0.9 });
        natives.push({ key, name, w: size.w, h: size.h, fixed: false });
      });
      continue;
    }

    // 其他 = 保留原本的 UV（搬到新位置）
    const region = info.oldRegion;
    if (inp.selected && !canAuto) {
      obj.reason = info.kind === 'unsupported' ? UNSUPPORTED_TEXT[info.unsupported ?? 'other'] : SPLITS_TEXT;
    } else if (!inp.selected) {
      obj.reason = region ? KEEP_TEXT : NO_UV_TEXT;
    }
    if (!region) {
      obj.mode = 'none';
      if (!obj.reason) obj.reason = NO_UV_TEXT;
      else obj.reason += `；${NO_UV_TEXT}`;
      continue;
    }
    if (region.wraps && inp.manuals.length > 0) {
      blockers.push(BLOCKED_TEXT.wrapKeep(inp.name));
    }
    obj.mode = 'keep';
    const box = stageBox(boxPoints(info.bbox.min, info.bbox.max), ctx.front, right);
    const flatHeight = info.bbox.max[1] - info.bbox.min[1];
    const horiz = Math.max(info.bbox.max[0] - info.bbox.min[0], info.bbox.max[2] - info.bbox.min[2]);
    items.push({ key: `o:${inp.id}`, name: inp.name, w: Math.max(1, region.rect.w), h: Math.max(1, region.rect.h), ...box, floor: flatHeight <= 0.15 * horiz });
    natives.push({ key: `o:${inp.id}`, name: inp.name, w: Math.max(1, region.rect.w), h: Math.max(1, region.rect.h), fixed: true });
  }

  const pack = packStageShaped(items, { gutter: ctx.gutter, roundTo: ctx.roundTo });
  // 製作自己排的排法（有的話）蓋過自動排的位置和畫布；沒有 = 自動排的
  const resolved = ctx.arrangement ? resolveArrangement(natives, pack, ctx.arrangement) : null;
  const placedMap = resolved ? resolved.placed : pack.placed;
  const canvas = resolved ? resolved.canvas : pack.canvas;
  if (canvas.width > MAX_CANVAS_SIDE || canvas.height > MAX_CANVAS_SIDE) blockers.push(BLOCKED_TEXT.canvasTooBig(canvas.width, canvas.height));
  if (!objects.some(o => o.mode === 'auto' && o.pieces.some(p => p.choice !== 'exclude'))) blockers.unshift(BLOCKED_TEXT.noSelection);
  if (resolved) {
    const nameOf = new Map(natives.map(n => [n.key, n.name]));
    if (resolved.problems.outside.length > 0) {
      const t = BLOCKED_TEXT.outside(resolved.problems.outside.map(k => nameOf.get(k) ?? k));
      blockers.push(t);
      arrangeBlockers.push(t);
    }
    if (resolved.problems.overlaps.length > 0) {
      const [a, b] = resolved.problems.overlaps[0];
      warnings.push(WARN_TEXT.overlap(resolved.problems.overlaps.length, nameOf.get(a) ?? a, nameOf.get(b) ?? b));
    }
  }

  // 位置填回各物件
  for (const o of objects) {
    if (o.mode === 'auto') {
      for (const p of o.pieces) {
        p.placed = placedMap.get(p.key) ?? null;
        if (p.choice === 'keep' && p.placed && p.keepRect) {
          const g = inputs.find(i => i.id === o.id)!.info!.groupRegions![p.group!]!;
          p.keepMap = { span: g.span, oldCanvas: ctx.oldCanvas, shiftX: p.placed.x - p.keepRect.x, shiftY: p.placed.y - p.keepRect.y };
        }
      }
    } else if (o.mode === 'keep') {
      const inp = inputs.find(i => i.id === o.id)!;
      const region = inp.info!.oldRegion!;
      const placed = placedMap.get(`o:${o.id}`)!;
      const shiftX = placed.x - region.rect.x, shiftY = placed.y - region.rect.y;
      const manualUpdates = inp.manuals.map(m => ({
        id: m.id,
        uv: [
          (m.uv[0] * ctx.oldCanvas.width + shiftX) / canvas.width, (m.uv[1] * ctx.oldCanvas.height + shiftY) / canvas.height,
          (m.uv[2] * ctx.oldCanvas.width + shiftX) / canvas.width, (m.uv[3] * ctx.oldCanvas.height + shiftY) / canvas.height,
        ] as UvBox,
      }));
      o.keep = { map: { span: region.span, oldCanvas: ctx.oldCanvas, shiftX, shiftY }, rect: region.rect, placed, manualUpdates };
    }
  }
  return { objects, canvas, blockers, warnings, rows: pack.rows, pack, items: natives, arranged: !!resolved, problems: resolved ? resolved.problems : null, arrangeBlockers };
}

/** 這個物件裡選了「不放進畫布」的那幾塊 LED mesh 的編號（PrimGeom.group） */
export function excludedGroupsOf(obj: PlanObject): Set<number> {
  return new Set(obj.pieces.filter(p => p.choice === 'exclude' && p.group !== undefined).map(p => p.group!));
}

/** 套用時要把類型改成「其他」的物件 id（製作選了「不放進畫布」的） */
export function excludedIdsOf(plan: Plan): string[] {
  return plan.objects.filter(o => o.mode === 'excluded').map(o => o.id);
}

/** 一個物件所有 primitive 的新 UV（null = 這個 primitive 不動）。auto 沒排好 / none / missing = 全部 null。整圈圓柱的接縫頂點會有 split */
export function objectUvs(geom: ObjectGeom, obj: PlanObject, info: ObjectInfo, canvas: CanvasSize): (PrimUv | null)[] {
  if (obj.mode === 'auto' && obj.pieces.some(p => p.choice) && obj.pieces.every(p => p.choice === 'exclude' || p.placed)) {
    // 有幾塊自己選了保留 / 不放進畫布：不放進畫布的塊 UV 不動，保留的塊整塊搬，其他照自動貼
    const alive = obj.pieces.map((_, i) => i).filter(i => obj.pieces[i].choice !== 'exclude');
    return geom.prims.map((p): PrimUv | null => {
      const owner = p.screen && p.group !== undefined ? obj.pieces.find(x => x.group === p.group) : undefined;
      if (owner?.choice === 'exclude') return null;
      if (owner?.choice === 'keep') {
        const uv = owner.keepMap ? keepUvForPrim(p, owner.keepMap, canvas) : null;
        return uv ? { uv } : null;
      }
      // 自動貼的塊：只在同一塊裡找；不屬於任何一塊的（外框、背板）只在還在畫布上的塊裡找
      const use = owner ? obj.pieces.map((_, i) => i) : alive;
      if (use.length === 0) return null;
      const r = flatUvForPrim(p, use.map(i => info.pieces[i]), j => obj.pieces[use[j]].placed ?? obj.pieces[alive[0] ?? 0].placed!, canvas);
      return r.split ? { uv: r.uv, split: r.split } : { uv: r.uv };
    });
  }
  if (obj.mode === 'auto' && obj.pieces.every(p => p.placed)) {
    const placed = obj.pieces.map(p => p.placed!);
    return geom.prims.map((p): PrimUv => {
      const r = flatUvForPrim(p, info.pieces, i => placed[i], canvas);
      return r.split ? { uv: r.uv, split: r.split } : { uv: r.uv };
    });
  }
  if (obj.mode === 'keep' && obj.keep) {
    const keep = obj.keep.map;
    return geom.prims.map((p): PrimUv | null => {
      const uv = keepUvForPrim(p, keep, canvas);
      return uv ? { uv } : null;
    });
  }
  return geom.prims.map(() => null);
}

// ───────────────────────── 舊版面（舊影片照舊貼對）─────────────────────────

export interface LegacyScreen {
  /** 'o:<物件 id>'（整個物件一塊）、's:<手動螢幕 id>'（原本就切過的）、's:@<ref>'（這次新切出來的，後台換成真的 id） */
  key: string;
  objectId: string;
  name: string;
  dest: PixelRect;
  rotate: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
}

export interface LegacyPlan {
  canvas: CanvasSize;
  screens: LegacyScreen[];
  /** 沒辦法放進舊版面的螢幕（原本的畫面橫跨畫布邊緣），而且原本的 UV 也存不進模型：舊影片在這幾塊會貼不對 */
  unprotected: string[];
  /** 放進去了，但原本的 UV 不是整齊的長方形（又存不進模型），貼出來可能有點歪 */
  approximate: string[];
  /** 原本的 UV 會存進模型的第二組 UV（TEXCOORD_1）的物件 id：這些物件的舊影片一個像素都不差（長方形版型只是備援） */
  originalUv: string[];
}

/** 這次新切出來的螢幕（一個物件有好幾片分開的平面）：後台建手動螢幕用 */
export interface PieceScreen { ref: string; objectId: string; name: string; uv: UvBox }

const EXACT = 0.02;

/**
 * 舊版面：版型畫布 = 套用前的整張畫布；每塊螢幕放在它原本的像素位置，方向用「新座標 → 原本範圍」找出來的。
 * 版型的來源範圍是看「現在模型的 UV 外框」（新的位置），目的地是原本的位置 → 舊影片的畫面照原樣貼回新的 UV 上。
 */
export function buildLegacy(plan: Plan, inputs: readonly PlanObjectIn[], oldCanvas: CanvasSize, exactIds: ReadonlySet<string> = new Set()): LegacyPlan {
  const screens: LegacyScreen[] = [];
  const unprotected: string[] = [], approximate: string[] = [];
  const originalUv: string[] = [];
  for (const o of plan.objects) {
    const inp = inputs.find(i => i.id === o.id);
    const info = inp?.info;
    if (!inp || !info) continue;
    const exact = exactIds.has(o.id) && (o.mode === 'keep' || o.mode === 'auto');
    if (exact) originalUv.push(o.id);
    if (o.mode === 'keep' && o.keep) {
      if (inp.manuals.length > 0) {
        for (const m of inp.manuals) {
          const x0 = Math.round(m.uv[0] * oldCanvas.width), x1 = Math.round(m.uv[2] * oldCanvas.width);
          const y0 = Math.round(m.uv[1] * oldCanvas.height), y1 = Math.round(m.uv[3] * oldCanvas.height);
          screens.push({ key: `s:${m.id}`, objectId: o.id, name: m.name, dest: { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }, rotate: 0, flipH: false, flipV: false });
        }
      } else if (info.oldRegion!.wraps) {
        if (!exact) unprotected.push(o.name);
      } else {
        screens.push({ key: `o:${o.id}`, objectId: o.id, name: o.name, dest: info.oldRegion!.rect, rotate: 0, flipH: false, flipV: false });
      }
    } else if (o.mode === 'auto') {
      o.pieces.forEach((p, i) => {
        if (p.choice === 'exclude') return;   // 不放進畫布的塊：舊版面也沒有它
        if (p.choice === 'keep') {
          const reg = p.group !== undefined ? info.groupRegions?.[p.group] : null;
          if (!reg) return;
          if (reg.wraps) { if (!exact) unprotected.push(p.name); return; }
          screens.push({ key: `s:@${o.id}#${i}`, objectId: o.id, name: p.name, dest: reg.rect, rotate: 0, flipH: false, flipV: false });
          return;
        }
        const old = info.oldPieces[i];
        if (!old) return;  // 原本就沒有 UV：舊影片本來就沒有畫面可以保護
        if (old.region.wraps) { if (!exact) unprotected.push(p.name); return; }
        if (old.err > EXACT && !exact) approximate.push(p.name);
        const key = o.pieces.length > 1 ? `s:@${o.id}#${i}` : `o:${o.id}`;
        // 版型的方向 = 原本的方向 ∘ 新排法方向的反方向（新排法轉過 / 翻過，舊影片的畫面才貼得回原本的樣子）
        const now = p.placed ? { rotate: p.placed.rotate, flipH: p.placed.flipH, flipV: p.placed.flipV } : IDENTITY_ORIENTATION;
        const rel = isIdentity(now) ? old.rel : composeOrientation(old.rel, invertOrientation(now));
        screens.push({ key, objectId: o.id, name: p.name, dest: old.region.rect, ...rel });
      });
    }
  }
  return { canvas: oldCanvas, screens, unprotected, approximate, originalUv };
}

/** 一個物件有好幾片分開的平面 → 每一片建一個手動螢幕（範圍 = 排好的長方形） */
export function pieceScreensOf(plan: Plan): PieceScreen[] {
  const out: PieceScreen[] = [];
  const cw = plan.canvas.width, ch = plan.canvas.height;
  for (const o of plan.objects) {
    if (o.mode !== 'auto' || o.pieces.length < 2) continue;
    o.pieces.forEach((p, i) => {
      if (!p.placed) return;
      out.push({ ref: `${o.id}#${i}`, objectId: o.id, name: p.name, uv: [p.placed.x / cw, p.placed.y / ch, (p.placed.x + p.placed.w) / cw, (p.placed.y + p.placed.h) / ch] });
    });
  }
  return out;
}

