// 自動貼 UV：把算好的 UV 寫進模型（gltf-transform，只動 TEXCOORD_0）
//
// 原則：節點、位置 / 旋轉 / 縮放、名稱、材質（「LED」的名字）、貼圖、TEXCOORD_1、extras 一個字都不碰。
//   - 只做「新增一個 TEXCOORD_0 accessor 換上去」，原本的 accessor 不改內容（可能有別的 primitive 在用）；沒人用了才丟掉
//   - 幾個節點共用同一個形狀（instance）：這個節點自己複製一份 mesh / primitive（頂點、法線、索引、材質都還是共用同一份），
//     只有這份的 TEXCOORD_0 換掉；沒有被處理的節點照舊用原本的 mesh
//   - 每個頂點的 UV 只由它的位置決定（surfaces.ts），所以不需要拆頂點、也不需要動索引

import type { Document, Mesh, Node } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { DRACO_ENCODER_OPTIONS } from '../modelCompress/settings';
import type { SceneObject } from './docRead';

export interface WriteStats {
  /** 換掉 TEXCOORD_0 的 primitive 數 */
  primitives: number;
  /** 因為共用形狀而複製了 mesh 的次數 */
  clonedMeshes: number;
  /** 換掉 TEXCOORD_0 的位置：節點 + 它的 mesh 裡第幾組（第 1 關檢查用） */
  changed: { node: Node; primIndex: number }[];
}

function nodeParents(mesh: Mesh): Node[] {
  return mesh.listParents().filter((p): p is Node => p.propertyType === 'Node');
}

/** uvs.get(物件 id)[i] 是 object.refs[i] 的新 UV（null = 不動） */
export function applyUvs(doc: Document, objects: ReadonlyMap<string, SceneObject>, uvs: ReadonlyMap<string, (Float32Array | null)[]>): WriteStats {
  const stats: WriteStats = { primitives: 0, clonedMeshes: 0, changed: [] };
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  // (節點, 原本的 mesh) → 這個節點專用的複本
  const clones = new Map<Node, Map<Mesh, Mesh>>();
  const touchedOriginals = new Set<Mesh>();

  for (const [id, list] of uvs) {
    const obj = objects.get(id);
    if (!obj) continue;
    obj.refs.forEach((ref, i) => {
      const uv = list[i];
      if (!uv) return;
      let prim = ref.prim;
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
      const old = prim.getAttribute('TEXCOORD_0');
      const acc = doc.createAccessor().setType('VEC2').setArray(uv as Float32Array<ArrayBuffer>).setBuffer(buffer);
      prim.setAttribute('TEXCOORD_0', acc);
      if (old && old.listParents().every(p => p.propertyType === 'Root')) old.dispose();
      stats.primitives++;
      stats.changed.push({ node: ref.node, primIndex: (copy ?? ref.mesh).listPrimitives().indexOf(prim) });
    });
  }
  for (const m of touchedOriginals) {
    if (nodeParents(m).length === 0) m.dispose();
  }
  return stats;
}

/** 輸出時要不要 Draco：原檔是 Draco 就壓（選項一律明確設定，不看原檔帶什麼），不是就不壓 */
export function prepareOutputCompression(doc: Document, sourceHadDraco: boolean): void {
  if (!sourceHadDraco) return;
  doc.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({ ...DRACO_ENCODER_OPTIONS });
}
