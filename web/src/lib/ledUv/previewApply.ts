// 自動貼 UV：把 3D 預覽的新 UV 暫時換到場景裡的 LED mesh 上（要 three；只在主執行緒用）
//
// 不改原本的 geometry：每個要換的 mesh 換成一個「淺複製」的 geometry（頂點、法線、索引都共用同一份，只有 uv 是新的），
// 還原時把原本的 geometry 放回去，淺複製丟掉（先把共用的資料拿掉再 dispose，不會把原本的 GPU 資料一起刪掉）。
// 對應：物件底下所有 mesh 照深度優先的順序，跟 worker 回來的 primitive 清單一個一個比（頂點數 + 第一個頂點的位置）。
// 對不上的物件整個不換（不會換到一半），並列在 missing 裡 → 預覽只是預覽，不影響套用。

import * as THREE from 'three';
import type { UvPreview } from './previewUv';

export interface AppliedUvPreview {
  /** 換成功的物件 */
  applied: string[];
  /** 對不上的物件（沒換） */
  missing: string[];
  restore(): void;
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-4 + 1e-5 * Math.abs(b);

function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as unknown as THREE.Line).isLine || (m as unknown as THREE.Points).isPoints) return;
    if (!(m.geometry as THREE.BufferGeometry | undefined)?.getAttribute('position')) return;
    out.push(m);
  });
  return out;
}

/** 淺複製：除了 uv 以外的資料都是共用的 */
function shallowWithUv(geo: THREE.BufferGeometry, uv: Float32Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of Object.keys(geo.attributes)) if (name !== 'uv') g.setAttribute(name, geo.attributes[name]);
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(geo.getIndex());
  for (const grp of geo.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
  if (geo.boundingBox) g.boundingBox = geo.boundingBox.clone();
  if (geo.boundingSphere) g.boundingSphere = geo.boundingSphere.clone();
  g.userData = geo.userData;
  return g;
}

/** 把預覽換上去。rootOf：物件 id → 場景裡那個物件（最上層的 Object3D） */
export function applyUvPreview(preview: UvPreview, rootOf: (objectId: string) => THREE.Object3D | undefined): AppliedUvPreview {
  const swaps: { mesh: THREE.Mesh; orig: THREE.BufferGeometry; tmp: THREE.BufferGeometry }[] = [];
  const applied: string[] = [], missing: string[] = [];
  for (const [id, prims] of Object.entries(preview.objects)) {
    const root = rootOf(id);
    if (!root) { missing.push(id); continue; }
    const meshes = meshesOf(root);
    const matched: (THREE.Mesh | null)[] = [];
    let ptr = 0;
    for (const m of meshes) {
      if (ptr >= prims.length) break;
      const pos = m.geometry.getAttribute('position');
      const want = prims[ptr];
      if (pos.count === want.count && near(pos.getX(0), want.first[0]) && near(pos.getY(0), want.first[1]) && near(pos.getZ(0), want.first[2])) {
        matched.push(m);
        ptr++;
      }
    }
    if (ptr !== prims.length) { missing.push(id); continue; }
    matched.forEach((m, i) => {
      const uv = prims[i].uv;
      if (!m || !uv) return;
      const orig = m.geometry;
      const tmp = shallowWithUv(orig, uv);
      m.geometry = tmp;
      swaps.push({ mesh: m, orig, tmp });
    });
    applied.push(id);
  }
  let restored = false;
  return {
    applied, missing,
    restore() {
      if (restored) return;
      restored = true;
      for (const s of swaps) {
        s.mesh.geometry = s.orig;
        // 共用的資料不能跟著 dispose（會把原本的 GPU 資料刪掉）
        for (const name of Object.keys(s.tmp.attributes)) if (name !== 'uv') s.tmp.deleteAttribute(name);
        s.tmp.setIndex(null);
        s.tmp.dispose();
      }
      swaps.length = 0;
    },
  };
}
