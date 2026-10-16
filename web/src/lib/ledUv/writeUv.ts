// 自動貼 UV：把算好的 UV 寫進模型（gltf-transform，只動 TEXCOORD_0；第 4 階段另外把「原本的 UV」存進 TEXCOORD_1）
//
// 原則：節點、位置 / 旋轉 / 縮放、名稱、材質（「LED」的名字）、貼圖、extras 一個字都不碰。
//   - 只做「新增一個 TEXCOORD_0 accessor 換上去」，原本的 accessor 不改內容（可能有別的 primitive 在用）；沒人用了才丟掉
//   - 幾個節點共用同一個形狀（instance）：這個節點自己複製一份 mesh / primitive（頂點、法線、索引、材質都還是共用同一份），
//     只有這份的 TEXCOORD_0 換掉；沒有被處理的節點照舊用原本的 mesh
//   - 每個頂點的 UV 由它的位置決定（surfaces.ts），一般不需要拆頂點、也不需要動索引；
//     只有整圈 360 度的圓柱，接縫上的頂點兩邊差一整圈，才複製那些頂點（附在最後面，每個屬性都複製同一份值）、改接縫另一側三角形的索引
//
// 第 4 階段 · 舊影片的保護：螢幕 primitive 原本的 UV（舊影片是照它輸出的）存進 TEXCOORD_1，accessor 取名 LED_ORIGINAL_UV 當記號：
//   - 沒有 TEXCOORD_1 → 新建一個，值 = 原本的 TEXCOORD_0（fresh：舊影片照這組 UV 取色，一個像素都不差，連跨過畫布邊緣、弧長不均勻的都是）
//   - 已經有我們寫的 TEXCOORD_1 → 原樣留著（carried）：重複套用時帶著「最原始」的 UV 往前走，不是中間那一版
//   - 有別人的 TEXCOORD_1（燈光貼圖等）→ 不動、不能保護（blocked），舊影片退回「舊版面」版型的長方形近似
// 沒有 TEXCOORD_0 的 primitive 沒有東西可存。外框、背板（不是螢幕的 primitive）不存：它們沒有 LED 畫面。

import type { Accessor, Document, Mesh, Node, Primitive } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { DRACO_ENCODER_OPTIONS } from '../modelCompress/settings';
import type { SceneObject } from './docRead';
import type { PrimUv, SplitPlan } from './place';

/** TEXCOORD_1 accessor 的記號名字（讀回來看到這個名字 = 這是我們存的「原本的 UV」） */
export const ORIGINAL_UV_NAME = 'LED_ORIGINAL_UV';

/** 一個物件的原本 UV 存得怎麼樣 */
export type Uv1Status =
  | 'fresh'     // 這次新存的：原本的 TEXCOORD_0 就是舊影片用的那一組 → 舊影片可以精確保護
  | 'carried'   // 之前就存過（更早的 UV）：留著不動，這次的舊影片（中間那一版的 UV）不能用它
  | 'mixed'     // 同一個物件裡有的新存、有的之前存過
  | 'blocked'   // 有別人的 TEXCOORD_1：不能存
  | 'none';     // 沒有原本的 UV 可以存

export interface WriteStats {
  /** 換掉 TEXCOORD_0 的 primitive 數 */
  primitives: number;
  /** 因為共用形狀而複製了 mesh 的次數 */
  clonedMeshes: number;
  /** 換掉 TEXCOORD_0 的位置：節點 + 它的 mesh 裡第幾組（第 1 關檢查用） */
  changed: { node: Node; primIndex: number }[];
  /** 物件 id → 原本的 UV 存得怎麼樣 */
  uv1: Record<string, Uv1Status>;
  /** 拆了接縫頂點的 primitive 數 */
  splitPrimitives: number;
}

export interface WriteOptions {
  /** 把原本的 UV 存進 TEXCOORD_1（預設 true） */
  keepOriginalUv?: boolean;
}

function nodeParents(mesh: Mesh): Node[] {
  return mesh.listParents().filter((p): p is Node => p.propertyType === 'Node');
}

/** accessor 的值（每個元素 size 個數字）讀成 Float32Array，後面接 origin 指定的元素的複本 */
function floatCopy(acc: Accessor, extra: Uint32Array | null): Float32Array {
  const size = acc.getElementSize(), n = acc.getCount();
  const total = n + (extra ? extra.length : 0);
  const out = new Float32Array(total * size);
  const src = acc.getArray();
  if (src instanceof Float32Array) out.set(src);
  else { const tmp = new Array<number>(size).fill(0); for (let i = 0; i < n; i++) { acc.getElement(i, tmp); for (let k = 0; k < size; k++) out[i * size + k] = tmp[k]; } }
  if (extra) for (let j = 0; j < extra.length; j++) for (let k = 0; k < size; k++) out[(n + j) * size + k] = out[extra[j] * size + k];
  return out;
}

/** 同樣型別的新 accessor：原本的值 + 複製的頂點（拆接縫用，每個屬性都要一樣長） */
function extendedAccessor(doc: Document, buffer: ReturnType<Document['createBuffer']>, acc: Accessor, extra: Uint32Array): Accessor {
  const size = acc.getElementSize(), n = acc.getCount();
  const src = acc.getArray()!;
  type Typed = { set(a: ArrayLike<number>): void; [i: number]: number };
  const out = new (src.constructor as new (len: number) => Typed)((n + extra.length) * size);
  out.set(src);
  for (let j = 0; j < extra.length; j++) for (let k = 0; k < size; k++) out[(n + j) * size + k] = out[extra[j] * size + k];
  return doc.createAccessor(acc.getName()).setType(acc.getType()).setArray(out as never).setNormalized(acc.getNormalized()).setBuffer(buffer);
}

/** uvs.get(物件 id)[i] 是 object.refs[i] 的新 UV（null = 不動） */
export function applyUvs(doc: Document, objects: ReadonlyMap<string, SceneObject>, uvs: ReadonlyMap<string, (PrimUv | null)[]>, opts: WriteOptions = {}): WriteStats {
  const keepOriginal = opts.keepOriginalUv ?? true;
  const stats: WriteStats = { primitives: 0, clonedMeshes: 0, changed: [], uv1: {}, splitPrimitives: 0 };
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  // (節點, 原本的 mesh) → 這個節點專用的複本
  const clones = new Map<Node, Map<Mesh, Mesh>>();
  const touchedOriginals = new Set<Mesh>();

  for (const [id, list] of uvs) {
    const obj = objects.get(id);
    if (!obj) continue;
    const seen = new Set<Uv1Status>();
    obj.refs.forEach((ref, i) => {
      const pu = list[i];
      if (!pu) return;
      let prim: Primitive = ref.prim;
      let copy = clones.get(ref.node)?.get(ref.mesh);
      if (!copy && nodeParents(ref.mesh).length > 1) {
        copy = doc.createMesh(ref.mesh.getName()).setExtras({ ...ref.mesh.getExtras() }).setWeights([...ref.mesh.getWeights()]);
        for (const p of ref.mesh.listPrimitives()) copy.addPrimitive(p.clone());
        ref.node.setMesh(copy);
        let byMesh = clones.get(ref.node);
        if (!byMesh) { byMesh = new Map(); clones.set(ref.node, byMesh); }
        byMesh.set(ref.mesh, copy);
        touchedOriginals.add(ref.mesh);
        stats.clonedMeshes++;
      }
      if (copy) prim = copy.listPrimitives()[ref.mesh.listPrimitives().indexOf(ref.prim)];

      const split: SplitPlan | undefined = pu.split;
      if (split && prim.listTargets().length > 0) throw new Error(`「${obj.meshName}」有變形目標（morph target），整圈圓柱的接縫要複製頂點，沒辦法處理`);
      const old0 = prim.getAttribute('TEXCOORD_0');
      const old1 = prim.getAttribute('TEXCOORD_1');
      const geomPrim = obj.geom.prims[i];

      // 原本的 UV → TEXCOORD_1（先決定，因為後面會把原本的 TEXCOORD_0 換掉）
      let status: Uv1Status = 'none';
      let uv1Acc: Accessor | null = null;
      if (keepOriginal && geomPrim.screen && old0) {
        if (old1 && old1.getName() === ORIGINAL_UV_NAME) status = 'carried';
        else if (old1) status = 'blocked';
        else {
          status = 'fresh';
          uv1Acc = doc.createAccessor(ORIGINAL_UV_NAME).setType('VEC2').setArray(floatCopy(old0, split ? split.origin : null) as Float32Array<ArrayBuffer>).setBuffer(buffer);
        }
        seen.add(status);
      }

      // 接縫的頂點：每個屬性都附上複製的頂點，索引換成改過的
      if (split) {
        const nv0 = prim.getAttribute('POSITION')!.getCount();
        for (const s of prim.listSemantics()) {
          if (s === 'TEXCOORD_0') continue;
          const acc = prim.getAttribute(s)!;
          const ext = extendedAccessor(doc, buffer, acc, split.origin);
          prim.setAttribute(s, ext);
          if (acc.listParents().every(p => p.propertyType === 'Root')) acc.dispose();
        }
        const total = nv0 + split.origin.length;
        const oldIdx = prim.getIndices();
        const idxArr = total > 65535 ? split.index : Uint16Array.from(split.index);
        prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(idxArr as Uint32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>).setBuffer(buffer));
        if (oldIdx && oldIdx.listParents().every(p => p.propertyType === 'Root')) oldIdx.dispose();
        stats.splitPrimitives++;
      }

      const acc = doc.createAccessor().setType('VEC2').setArray(pu.uv as Float32Array<ArrayBuffer>).setBuffer(buffer);
      prim.setAttribute('TEXCOORD_0', acc);
      if (old0 && old0.listParents().every(p => p.propertyType === 'Root')) old0.dispose();
      if (uv1Acc) prim.setAttribute('TEXCOORD_1', uv1Acc);   // 之前存的（carried）在上面拆接縫時已經跟著長出複製的頂點
      stats.primitives++;
      stats.changed.push({ node: ref.node, primIndex: (copy ?? ref.mesh).listPrimitives().indexOf(prim) });
    });
    stats.uv1[id] = summarizeUv1(seen);
  }
  for (const m of touchedOriginals) {
    if (nodeParents(m).length === 0) m.dispose();
  }
  return stats;
}

function summarizeUv1(seen: ReadonlySet<Uv1Status>): Uv1Status {
  if (seen.size === 0) return 'none';
  if (seen.has('blocked')) return 'blocked';
  if (seen.has('fresh') && seen.has('carried')) return 'mixed';
  return seen.has('fresh') ? 'fresh' : 'carried';
}

/** 輸出時要不要 Draco：原檔是 Draco 就壓（選項一律明確設定，不看原檔帶什麼），不是就不壓 */
export function prepareOutputCompression(doc: Document, sourceHadDraco: boolean): void {
  if (!sourceHadDraco) return;
  doc.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({ ...DRACO_ENCODER_OPTIONS });
}
