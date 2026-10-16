// 自動貼 UV：一個物件（或一片螢幕）原本的 UV 在畫布上佔哪裡（純函式）
// 跟 ledMap.layoutPanel / verifyScene.ledPanelRect 同一套（同樣的三角形篩選、axisSpan、spanToPixels）：
// 不管用哪個方法算，位置都一樣（測試會比對）。

import { axisSpan, spanToPixels, type AxisSpan, type CanvasSize, type PixelRect } from '../ledMap';
import { spanFromAxes, type SrcSpan } from '../ledTemplate';
import type { PrimGeom } from './surfaces';

const MIN_UV_AREA = 1e-10;

export interface UvRegion {
  rect: PixelRect;
  u: AxisSpan;
  v: AxisSpan;
  span: SrcSpan;
  /** 外框壓在畫布邊緣（左右或上下繞過去）：版型的長方形裝不下 */
  wraps: boolean;
}

/** 三角形的 UV（每 6 個數字一個三角形）→ 範圍；沒有能用的三角形 = null */
export function uvRegion(tris: ArrayLike<number>, canvas: CanvasSize): UvRegion | null {
  const uSeen = new Map<number, Set<number>>(), vSeen = new Map<number, Set<number>>();
  const uR: [number, number][] = [], vR: [number, number][] = [];
  const addUnique = (seen: Map<number, Set<number>>, out: [number, number][], lo: number, hi: number) => {
    let set = seen.get(lo);
    if (!set) { set = new Set(); seen.set(lo, set); }
    if (set.has(hi)) return;
    set.add(hi);
    out.push([lo, hi]);
  };
  const n = Math.floor(tris.length / 6);
  let kept = 0;
  for (let t = 0; t < n; t++) {
    const o = t * 6;
    const u0 = tris[o], v0 = tris[o + 1], u1 = tris[o + 2], v1 = tris[o + 3], u2 = tris[o + 4], v2 = tris[o + 5];
    if (!(Number.isFinite(u0) && Number.isFinite(v0) && Number.isFinite(u1) && Number.isFinite(v1) && Number.isFinite(u2) && Number.isFinite(v2))) continue;
    const area = Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)) / 2;
    if (area < MIN_UV_AREA) continue;
    kept++;
    addUnique(uSeen, uR, Math.min(u0, u1, u2), Math.max(u0, u1, u2));
    addUnique(vSeen, vR, Math.min(v0, v1, v2), Math.max(v0, v1, v2));
  }
  const u = axisSpan(uR), v = axisSpan(vR);
  if (!u || !v || kept === 0) return null;
  const px = spanToPixels(u, canvas.width), py = spanToPixels(v, canvas.height);
  const rect = { x: px.pos, y: py.pos, w: px.len, h: py.len };
  return { rect, u, v, span: spanFromAxes(u, v), wraps: rect.x + rect.w > canvas.width || rect.y + rect.h > canvas.height };
}

/** 物件裡（部分）三角形的原本 UV，每 6 個數字一個三角形；沒有 UV 的 primitive 跳過 */
export function oldUvTriangles(prims: readonly PrimGeom[], include?: (primIndex: number, tri: number) => boolean): Float64Array {
  const out: number[] = [];
  prims.forEach((p, pi) => {
    if (!p.uv) return;
    for (let t = 0; t + 2 < p.index.length; t += 3) {
      if (include && !include(pi, t / 3)) continue;
      for (let k = 0; k < 3; k++) {
        const vi = p.index[t + k];
        out.push(p.uv[vi * 2], p.uv[vi * 2 + 1]);
      }
    }
  });
  return Float64Array.from(out);
}
