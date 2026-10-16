// 自動貼 UV：寫完以後的檢查（在 worker 裡跑；沒過就不上傳）
//
//   第 1 關 verifyUvEdit（原檔 vs 改完還沒壓縮的）：節點名稱 / 階層 / 位置 / 旋轉 / 縮放 / extras、材質、貼圖、場景，一模一樣；
//           每個 primitive 的頂點、法線、索引、其他所有資料逐個數字一樣，只有我們要換的那幾個 primitive 的 TEXCOORD_0 可以不一樣
//   第 2 關 verifyDocuments（既有的壓縮檢查：改完的 vs 輸出檔重新讀回來）：Draco 壓縮、寫出再讀回，頂點 / UV 在誤差內
//   第 3 關 verifyOutputUv（輸出檔重新讀回來）：自動貼的每個頂點的 UV = 依位置重新算一次的結果（誤差 0.01 像素以內）；
//           每個物件在畫布上的外框 = 排好的長方形（整數像素，一點都不差）

import type { Document, Node, Primitive, Property } from '@gltf-transform/core';
import type { CanvasSize, PixelRect } from '../ledMap';
import { uvRegion } from './region';
import { readLedObjects } from './docRead';
import { objectUvs, type Plan, type PlanObject } from './plan';
import type { ObjectInfo } from './objectInfo';
import { assignVertices, type PrimGeom } from './surfaces';

export const UV_PIXEL_TOLERANCE = 0.01;

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function sameArray(a: ArrayLike<number> | null | undefined, b: ArrayLike<number> | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function equalsSkipping(a: Property, b: Property, skip: string[]): boolean {
  return a.equals(b as never, new Set(skip));
}

/** changed = 「節點編號:第幾個 primitive」，這些 primitive 的 TEXCOORD_0 可以不一樣 */
export function verifyUvEdit(orig: Document, edit: Document, changed: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  const add = (m: string) => { if (issues.length < 20) issues.push(m); };
  const ra = orig.getRoot(), rb = edit.getRoot();
  const nodesA = ra.listNodes(), nodesB = rb.listNodes();
  if (nodesA.length !== nodesB.length) return [`節點數量不一樣（${nodesA.length} → ${nodesB.length}）`];
  const idxA = new Map<Node, number>(nodesA.map((n, i) => [n, i]));
  const idxB = new Map<Node, number>(nodesB.map((n, i) => [n, i]));
  const matsA = ra.listMaterials(), matsB = rb.listMaterials();
  if (matsA.length !== matsB.length) add(`材質數量不一樣（${matsA.length} → ${matsB.length}）`);
  else matsA.forEach((m, i) => { if (!m.equals(matsB[i])) add(`材質「${m.getName() || `#${i}`}」變了`); });
  const texA = ra.listTextures(), texB = rb.listTextures();
  if (texA.length !== texB.length) add(`貼圖數量不一樣（${texA.length} → ${texB.length}）`);
  else texA.forEach((t, i) => { if (!t.equals(texB[i])) add(`貼圖「${t.getName() || `#${i}`}」變了`); });
  if (ra.listScenes().length !== rb.listScenes().length) add('場景數量不一樣');
  if (ra.listAnimations().length !== rb.listAnimations().length) add('動畫數量不一樣');
  if (ra.listSkins().length !== rb.listSkins().length) add('骨架數量不一樣');
  if (ra.listCameras().length !== rb.listCameras().length) add('攝影機數量不一樣');
  if (!sameJson(ra.getExtras(), rb.getExtras())) add('檔案的 extras 變了');

  nodesA.forEach((a, i) => {
    const b = nodesB[i];
    const label = `節點「${a.getName() || `#${i}`}」`;
    if (a.getName() !== b.getName()) add(`第 ${i + 1} 個節點名稱變了（「${a.getName()}」→「${b.getName()}」）`);
    if (!sameJson(a.getTranslation(), b.getTranslation()) || !sameJson(a.getRotation(), b.getRotation()) || !sameJson(a.getScale(), b.getScale())) add(`${label} 的位置 / 旋轉 / 縮放變了`);
    if (!equalsSkipping(a, b, ['mesh', 'children', 'skin'])) add(`${label} 的其他設定變了`);
    if (!sameJson(a.listChildren().map(c => idxA.get(c)), b.listChildren().map(c => idxB.get(c)))) add(`${label} 底下的子節點不一樣`);
    const ma = a.getMesh(), mb = b.getMesh();
    if (!!ma !== !!mb) { add(`${label} 掛的形狀不一樣`); return; }
    if (!ma || !mb) return;
    if (ma.getName() !== mb.getName()) add(`${label} 的形狀名稱變了`);
    const pa = ma.listPrimitives(), pb = mb.listPrimitives();
    if (pa.length !== pb.length) { add(`${label} 形狀的組數不一樣`); return; }
    pa.forEach((x: Primitive, k) => {
      const y = pb[k];
      const where = `${label} 第 ${k + 1} 組`;
      if (!equalsSkipping(x, y, ['attributes', 'indices', 'targets'])) add(`${where}：材質或繪製方式變了`);
      const sx = x.listSemantics().slice().sort(), sy = y.listSemantics().slice().sort();
      const mayChange = changed.has(`${i}:${k}`);
      const norm = (list: string[]) => (mayChange ? list.filter(s => s !== 'TEXCOORD_0') : list);
      if (!sameJson(norm(sx), norm(sy))) { add(`${where}：頂點資料的種類變了`); return; }
      for (const s of norm(sx)) {
        const ax = x.getAttribute(s)!, ay = y.getAttribute(s)!;
        if (ax.getComponentType() !== ay.getComponentType() || ax.getElementSize() !== ay.getElementSize() || !sameArray(ax.getArray(), ay.getArray())) add(`${where}：${s} 的資料變了`);
      }
      if (mayChange) {
        const u = y.getAttribute('TEXCOORD_0');
        if (!u || u.getType() !== 'VEC2' || u.getCount() !== (x.getAttribute('POSITION')?.getCount() ?? -1)) add(`${where}：新的 TEXCOORD_0 格式不對`);
      }
      if (!sameArray(x.getIndices()?.getArray(), y.getIndices()?.getArray())) add(`${where}：三角形的索引變了`);
      if (x.listTargets().length !== y.listTargets().length) add(`${where}：變形目標變了`);
    });
  });
  return issues;
}

export interface OutputCheckReport {
  ok: boolean;
  issues: string[];
  /** 每個物件實際量到的外框（輸出檔重新讀回來） */
  rects: Record<string, PixelRect | null>;
  /** 自動貼的頂點 UV 跟重新算的最大差距（像素） */
  maxPixelError: number;
}

/** 預期的物件外框：自動貼 = 排好的每一片的外框聯集；保留 = 平移後的原本範圍 */
export function expectedRect(obj: PlanObject, canvas: CanvasSize): UvRegionLike | null {
  if (obj.mode === 'auto') {
    const tris: number[] = [];
    for (const p of obj.pieces) {
      if (!p.placed) return null;
      const { x, y, w, h } = p.placed;
      const [u0, v0, u1, v1] = [x / canvas.width, y / canvas.height, (x + w) / canvas.width, (y + h) / canvas.height];
      tris.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
    }
    return uvRegion(tris, canvas);
  }
  if (obj.mode === 'keep' && obj.keep) {
    const { placed, rect } = obj.keep;
    return { rect: { x: placed.x, y: placed.y, w: rect.w, h: rect.h } };
  }
  return null;
}
type UvRegionLike = { rect: PixelRect };

function trisOf(prims: readonly PrimGeom[]): Float64Array {
  const out: number[] = [];
  for (const p of prims) {
    if (!p.uv) continue;
    for (const ix of p.index) out.push(p.uv[ix * 2], p.uv[ix * 2 + 1]);
  }
  return Float64Array.from(out);
}

/** 輸出檔（重新讀回來的文件）：UV 對、外框剛好等於排好的長方形 */
export function verifyOutputUv(
  out: Document,
  wanted: readonly { id: string; meshName: string }[],
  plan: Plan,
  infos: Readonly<Record<string, ObjectInfo | null>>,
): OutputCheckReport {
  const issues: string[] = [];
  const add = (m: string) => { if (issues.length < 20) issues.push(m); };
  const read = readLedObjects(out, wanted);
  const rects: Record<string, PixelRect | null> = {};
  let maxPixelError = 0;
  for (const o of plan.objects) {
    if (o.mode !== 'auto' && o.mode !== 'keep') continue;
    const so = read.objects.get(o.id);
    if (!so) { add(`輸出檔裡找不到物件「${o.name}」`); continue; }
    const actual = uvRegion(trisOf(so.geom.prims), plan.canvas);
    rects[o.id] = actual?.rect ?? null;
    const want = expectedRect(o, plan.canvas);
    if (!actual || !want) { add(`「${o.name}」的 UV 讀不出來`); continue; }
    const r = actual.rect, w = want.rect;
    if (r.x !== w.x || r.y !== w.y || r.w !== w.w || r.h !== w.h) {
      add(`「${o.name}」在對位圖上的位置不對（要 ${w.x},${w.y} ${w.w}×${w.h}，實際 ${r.x},${r.y} ${r.w}×${r.h}）`);
    }
    const info = infos[o.id];
    if (o.mode === 'auto' && info && info.kind === 'flat') {
      // 每一片各自量：這一片的三角形（三個頂點都屬於它）的外框 == 排好的長方形
      const assigns = so.geom.prims.map(p => assignVertices(p, info.pieces));
      o.pieces.forEach((pp, i) => {
        if (!pp.placed) return;
        const tris: number[] = [];
        so.geom.prims.forEach((p, pi) => {
          if (!p.uv) return;
          const as = assigns[pi];
          for (let t = 0; t + 2 < p.index.length; t += 3) {
            const a = p.index[t], b = p.index[t + 1], c = p.index[t + 2];
            if (as.piece[a] !== i || as.piece[b] !== i || as.piece[c] !== i) continue;
            tris.push(p.uv[a * 2], p.uv[a * 2 + 1], p.uv[b * 2], p.uv[b * 2 + 1], p.uv[c * 2], p.uv[c * 2 + 1]);
          }
        });
        const pr = uvRegion(tris, plan.canvas);
        const w2 = pp.placed;
        if (!pr || pr.rect.x !== w2.x || pr.rect.y !== w2.y || pr.rect.w !== w2.w || pr.rect.h !== w2.h) {
          add(`「${pp.name}」這一片在對位圖上的位置不對（要 ${w2.x},${w2.y} ${w2.w}×${w2.h}）`);
        }
      });
      const expected = objectUvs(so.geom, o, info, plan.canvas);
      so.geom.prims.forEach((p, pi) => {
        const e = expected[pi];
        if (!e || !p.uv) { add(`「${o.name}」第 ${pi + 1} 組沒有 UV`); return; }
        for (let v = 0; v < e.length; v += 2) {
          const dx = Math.abs(e[v] - p.uv[v]) * plan.canvas.width, dy = Math.abs(e[v + 1] - p.uv[v + 1]) * plan.canvas.height;
          maxPixelError = Math.max(maxPixelError, dx, dy);
        }
      });
    }
  }
  if (maxPixelError > UV_PIXEL_TOLERANCE) add(`UV 跟算出來的差了 ${maxPixelError.toFixed(4)} 像素（最多 ${UV_PIXEL_TOLERANCE}）`);
  return { ok: issues.length === 0, issues, rects, maxPixelError };
}
