// 自動貼 UV：把排好的位置變成每個頂點的 UV（純函式）
//
// 平面螢幕片：頂點 → 片上的位置 (lx, ly)（0~1）→ 照版型編輯器同一套轉動 / 翻轉（ledTemplate.ts 的 localTransform）→
//   畫布像素 = 長方形左上角 + 位置 × 長方形大小 → UV = 像素 / 畫布。
//   這跟 LED 版型「畫布 → 螢幕」的對應是同一套數學的反方向，所以版型、對位圖、AE 腳本都不用改。
// 保留的物件（沒選、或第 1 階段還不能處理的弧面）：原本的 UV 整片平移到新位置，大小、方向、取樣的像素都不變。
//   平移量是整數像素，所以畫面上每個 LED 點還是對到原本畫布上的同一個像素。

import { applyLocalTransform, localTransform, type SrcSpan } from '../ledTemplate';
import type { CanvasSize } from '../ledMap';
import { assignVertices, type Piece, type PrimGeom } from './surfaces';
import { resolveSeamCorners } from './cylinder';
import type { Placed } from './pack';

/** 片上的位置 (lx, ly = 0~1) → 畫布像素 */
export function canvasPoint(p: Placed, lx: number, ly: number): [number, number] {
  const [tx, ty] = applyLocalTransform(localTransform(p.rotate, p.flipH, p.flipV), lx, ly);
  return [p.x + tx * p.w, p.y + ty * p.h];
}

/** 封閉圓柱的接縫：接縫上的頂點兩邊的 UV 差一整圈（一邊 0、一邊 1），所以每個接縫頂點要複製一份，接縫另一側的三角形改用複製的 */
export interface SplitPlan {
  /** 新增的頂點（接在原本的頂點後面，編號從原本的頂點數開始）各自複製哪一個原本的頂點 */
  origin: Uint32Array;
  /** 改過的索引（長度跟原本一樣）：接縫另一側的三角形改用新增的頂點 */
  index: Uint32Array;
}

/** 一個 primitive 要寫的 UV：每個頂點 2 個數字（有 split 的話，後面多出來的是複製的接縫頂點） */
export interface PrimUv { uv: Float32Array; split?: SplitPlan }

export interface FlatUvResult extends PrimUv {
  /** 沒落在螢幕面上、被夾進螢幕邊緣的頂點數（外框、背板） */
  clamped: number;
}

/** 螢幕片（平面、弧面、擠出曲面、自由曲面、整圈圓柱）：一個 primitive 的每個頂點的新 UV；整圈圓柱的接縫頂點要拆開 */
export function flatUvForPrim(prim: PrimGeom, pieces: readonly Piece[], placeOf: (pieceIndex: number) => Placed, canvas: CanvasSize): FlatUvResult {
  const a = assignVertices(prim, pieces);
  const nv = a.piece.length;
  const placed = pieces.map((_, i) => placeOf(i));
  const lx = a.lx, ly = a.ly;
  const extraOrigin: number[] = [], extraLx: number[] = [], extraLy: number[] = [];
  let newIndex: Uint32Array | null = null;

  if (a.seam.some(f => f === 1)) {
    // 整圈圓柱：接縫上的頂點，每個三角形看自己其他的角決定要 0 還是 1（resolveSeamCorners）。
    // 同一個頂點兩邊都有人用 → 複製一份（原本的留給自然落在的那一邊）；只有一邊用 → 直接用那一邊的值
    const nt = Math.floor(prim.index.length / 3);
    const used = new Uint8Array(nv);
    const side = new Int8Array(nt * 3).fill(-1);
    const arcCoord = (v: number): number => (pieces[a.piece[v]].arc!.arcVertical ? ly[v] : lx[v]);
    for (let t = 0; t < nt; t++) {
      const v0 = prim.index[t * 3], v1 = prim.index[t * 3 + 1], v2 = prim.index[t * 3 + 2];
      const pi = a.piece[v0];
      if (pi < 0 || !pieces[pi].arc?.closed || a.piece[v1] !== pi || a.piece[v2] !== pi) continue;
      if (!a.seam[v0] && !a.seam[v1] && !a.seam[v2]) continue;
      const r = resolveSeamCorners([arcCoord(v0), arcCoord(v1), arcCoord(v2)], [a.seam[v0] === 1, a.seam[v1] === 1, a.seam[v2] === 1]);
      [v0, v1, v2].forEach((v, k) => {
        if (!a.seam[v]) return;
        side[t * 3 + k] = r[k];
        used[v] |= 1 << r[k];
      });
    }
    const setCoord = (v: number, c: number, outLx: number[] | null, outLy: number[] | null) => {
      const vertical = pieces[a.piece[v]].arc!.arcVertical;
      if (outLx && outLy) { outLx.push(vertical ? lx[v] : c); outLy.push(vertical ? c : ly[v]); }
      else if (vertical) ly[v] = c; else lx[v] = c;
    };
    const extraOf = new Map<number, number>();   // 接縫頂點 → 複製的那個新編號
    const keepSide = new Map<number, number>();  // 接縫頂點 → 原本的頂點留給哪一邊
    for (let v = 0; v < nv; v++) {
      if (!a.seam[v]) continue;
      if (used[v] === 1) setCoord(v, 0, null, null);
      else if (used[v] === 2) setCoord(v, 1, null, null);
      else if (used[v] === 3) {
        const natural = arcCoord(v) > 0.5 ? 1 : 0;
        keepSide.set(v, natural);
        setCoord(v, natural, null, null);
        extraOf.set(v, nv + extraOrigin.length);
        extraOrigin.push(v);
        setCoord(v, 1 - natural, extraLx, extraLy);
      }
    }
    if (extraOrigin.length > 0) {
      newIndex = Uint32Array.from(prim.index);
      for (let t = 0; t < nt; t++) {
        for (let k = 0; k < 3; k++) {
          const v = prim.index[t * 3 + k];
          const keep = keepSide.get(v);
          if (keep !== undefined && side[t * 3 + k] >= 0 && side[t * 3 + k] !== keep) newIndex[t * 3 + k] = extraOf.get(v)!;
        }
      }
    }
  }

  const total = nv + extraOrigin.length;
  const uv = new Float32Array(total * 2);
  let clamped = 0;
  for (let v = 0; v < nv; v++) {
    const [px, py] = canvasPoint(placed[a.piece[v]], lx[v], ly[v]);
    uv[v * 2] = px / canvas.width;
    uv[v * 2 + 1] = py / canvas.height;
    if (a.dist[v] > pieces[a.piece[v]].tol) clamped++;
  }
  extraOrigin.forEach((o, i) => {
    const [px, py] = canvasPoint(placed[a.piece[o]], extraLx[i], extraLy[i]);
    uv[(nv + i) * 2] = px / canvas.width;
    uv[(nv + i) * 2 + 1] = py / canvas.height;
  });
  return { uv, clamped, ...(newIndex ? { split: { origin: Uint32Array.from(extraOrigin), index: newIndex } } : {}) };
}

/** 保留的物件：原本 UV 範圍 + 平移量 */
export interface KeepMap {
  span: SrcSpan;
  /** 原本畫布大小（算像素用） */
  oldCanvas: CanvasSize;
  /** 整數像素平移：新位置 - 原本範圍左上角（四捨五入後的像素） */
  shiftX: number;
  shiftY: number;
}

const EPS = 1e-5;

/** 保留的物件：一個 primitive 的每個頂點的新 UV；沒有 UV 的 primitive = null（不動） */
export function keepUvForPrim(prim: PrimGeom, map: KeepMap, canvas: CanvasSize): Float32Array | null {
  if (!prim.uv) return null;
  const nv = Math.floor(prim.pos.length / 3);
  const uv = new Float32Array(nv * 2);
  const { span, oldCanvas } = map;
  for (let v = 0; v < nv; v++) {
    let u = prim.uv[v * 2], w = prim.uv[v * 2 + 1];
    if (!Number.isFinite(u)) u = span.us;
    if (!Number.isFinite(w)) w = span.vs;
    const ku = Math.floor(u - span.us + EPS), kv = Math.floor(w - span.vs + EPS);
    uv[v * 2] = ((u - ku) * oldCanvas.width + map.shiftX) / canvas.width;
    uv[v * 2 + 1] = ((w - kv) * oldCanvas.height + map.shiftY) / canvas.height;
  }
  return uv;
}
