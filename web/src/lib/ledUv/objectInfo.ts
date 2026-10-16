// 自動貼 UV：一個 LED 物件的完整資訊 = 螢幕片（surfaces.ts）+ 原本的 UV 在畫布上佔哪裡 + 原本的 UV 跟新的座標差幾度轉向
// （純函式；「舊版面」版型要用：舊影片的畫面是照原本的 UV 排的，要知道原本的方向才能貼對）

import type { CanvasSize } from '../ledMap';
import { uvToLocal, ROTATIONS, applyLocalTransform, localTransform, type Rotation } from '../ledTemplate';
import { analyzeObject, assignVertices, type ObjectAnalysis, type ObjectGeom, type PrimGeom } from './surfaces';
import { oldUvTriangles, uvRegion, type UvRegion } from './region';
import type { Vec3 } from './geometry';

export interface Orientation { rotate: Rotation; flipH: boolean; flipV: boolean }

export interface PieceOld {
  /** 這片原本在畫布上的範圍（單片物件 = 整個物件的範圍） */
  region: UvRegion;
  /** 新座標（片上的位置）→ 原本範圍裡的位置，要轉 / 翻成什麼樣 */
  rel: Orientation;
  /** 轉過去以後最大的誤差（0~1 的比例）：0 = 完全對得上；大 = 原本的 UV 不是整齊的長方形 */
  err: number;
}

export interface ObjectInfo extends ObjectAnalysis {
  /** 整個物件原本的 UV 範圍（沒有 UV = null） */
  oldRegion: UvRegion | null;
  /** 每一片的原本範圍（只有平面物件有） */
  oldPieces: (PieceOld | null)[];
}

const SAMPLE_CAP = 600;

/** 8 種方向裡，哪一種讓 samples（新位置 → 原本位置）誤差最小；平手選最簡單的（不轉、不翻） */
export function bestOrientation(samples: readonly (readonly [number, number, number, number])[]): { rel: Orientation; err: number } {
  let best: { rel: Orientation; err: number } | null = null;
  for (const rotate of ROTATIONS) {
    for (const flipH of [false, true]) {
      for (const flipV of [false, true]) {
        const t = localTransform(rotate, flipH, flipV);
        let err = 0;
        for (const s of samples) {
          const [x, y] = applyLocalTransform(t, s[0], s[1]);
          err = Math.max(err, Math.abs(x - s[2]), Math.abs(y - s[3]));
        }
        if (!best || err < best.err - 1e-9) best = { rel: { rotate, flipH, flipV }, err };
      }
    }
  }
  return best ?? { rel: { rotate: 0, flipH: false, flipV: false }, err: 0 };
}

function describePieces(geom: ObjectGeom, a: ObjectAnalysis, objectRegion: UvRegion | null, oldCanvas: CanvasSize): (PieceOld | null)[] {
  const assigns = geom.prims.map(p => assignVertices(p, a.pieces));
  const tolOf = (i: number) => 1e-6 * (a.pieces[i].widthU + a.pieces[i].heightU);
  return a.pieces.map((_, i): PieceOld | null => {
    // 這一片的三角形：三個頂點都屬於這一片
    const region = a.pieces.length === 1
      ? objectRegion
      : uvRegion(oldUvTriangles(geom.prims, (pi, t) => {
        const as = assigns[pi], idx = geom.prims[pi].index;
        return as.piece[idx[t * 3]] === i && as.piece[idx[t * 3 + 1]] === i && as.piece[idx[t * 3 + 2]] === i;
      }), oldCanvas);
    if (!region) return null;
    const samples: [number, number, number, number][] = [];
    const tol = tolOf(i);
    geom.prims.forEach((p: PrimGeom, pi) => {
      if (!p.uv) return;
      const as = assigns[pi];
      const nv = as.piece.length;
      const step = Math.max(1, Math.floor(nv / SAMPLE_CAP));
      for (let v = 0; v < nv; v += step) {
        if (as.piece[v] !== i || as.dist[v] > tol) continue;
        const l = uvToLocal(region.span, p.uv![v * 2], p.uv![v * 2 + 1]);
        if (l) samples.push([as.lx[v], as.ly[v], l[0], l[1]]);
      }
    });
    const best = bestOrientation(samples);
    return { region, rel: best.rel, err: samples.length ? best.err : 1 };
  });
}

export function describeObject(geom: ObjectGeom, front: Vec3, oldCanvas: CanvasSize): ObjectInfo {
  const a = analyzeObject(geom, front);
  const oldRegion = uvRegion(oldUvTriangles(geom.prims), oldCanvas);
  return { ...a, oldRegion, oldPieces: a.kind === 'flat' ? describePieces(geom, a, oldRegion, oldCanvas) : [] };
}
