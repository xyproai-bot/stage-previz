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
import type { Placed } from './pack';

/** 片上的位置 (lx, ly = 0~1) → 畫布像素 */
export function canvasPoint(p: Placed, lx: number, ly: number): [number, number] {
  const [tx, ty] = applyLocalTransform(localTransform(p.rotate, p.flipH, p.flipV), lx, ly);
  return [p.x + tx * p.w, p.y + ty * p.h];
}

export interface FlatUvResult {
  uv: Float32Array;
  /** 沒落在螢幕面上、被夾進螢幕邊緣的頂點數（外框、背板） */
  clamped: number;
}

/** 平面螢幕片：一個 primitive 的每個頂點的新 UV */
export function flatUvForPrim(prim: PrimGeom, pieces: readonly Piece[], placeOf: (pieceIndex: number) => Placed, canvas: CanvasSize): FlatUvResult {
  const a = assignVertices(prim, pieces);
  const nv = a.piece.length;
  const uv = new Float32Array(nv * 2);
  let clamped = 0;
  const placed = pieces.map((_, i) => placeOf(i));
  for (let v = 0; v < nv; v++) {
    const [px, py] = canvasPoint(placed[a.piece[v]], a.lx[v], a.ly[v]);
    uv[v * 2] = px / canvas.width;
    uv[v * 2 + 1] = py / canvas.height;
    if (a.dist[v] > 1e-6 * (pieces[a.piece[v]].widthU + pieces[a.piece[v]].heightU)) clamped++;
  }
  return { uv, clamped };
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
