// LED 物件 → 三角形的 UV（給 ledMap.ts 算位置用）
// 讀的是跟 LED 貼圖同一組 UV（第一組 uv，emissiveMap / map 的 channel 0）。

import * as THREE from 'three';
import type { LedPanelInput } from './ledMap';
import { ledScreenMeshes } from './ledScreen';

/** 一個 LED 物件底下螢幕 mesh 的三角形 UV（每 6 個數字一個三角形）；沒有 UV 的 mesh 跳過。框架、台體不算（lib/ledScreen.ts） */
export function collectUvTriangles(root: THREE.Object3D, only?: ReadonlySet<THREE.Mesh>): Float64Array {
  const out: number[] = [];
  const screens = ledScreenMeshes(root);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as unknown as THREE.Line).isLine || (mesh as unknown as THREE.Points).isPoints) return;
    if (!screens.has(mesh) || (only && !only.has(mesh))) return;
    const geo = mesh.geometry as THREE.BufferGeometry | undefined;
    const uv = geo?.getAttribute('uv') as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    if (!geo || !uv) return;
    const index = geo.getIndex();
    const count = index ? index.count : uv.count;
    for (let i = 0; i + 2 < count; i += 3) {
      for (let k = 0; k < 3; k++) {
        const vi = index ? index.getX(i + k) : i + k;
        out.push(uv.getX(vi), uv.getY(vi));
      }
    }
  });
  return Float64Array.from(out);
}

export interface LedSceneObject {
  id: string;
  name: string;
  order: number;
  root: THREE.Object3D;
}

/** 依物件順序整理成 ledMap 的輸入（同一個順序 → 每次顏色都一樣） */
export function ledPanelInputs(objects: readonly LedSceneObject[]): LedPanelInput[] {
  return [...objects]
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map(o => ({ id: o.id, name: o.name, tris: collectUvTriangles(o.root) }));
}
