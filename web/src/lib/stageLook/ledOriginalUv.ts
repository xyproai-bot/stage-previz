// 舊影片用「模型存的原本 UV」取色（自動貼 UV 第 4 階段）
//
// 自動貼 UV 套用時，每個 LED 螢幕原本的 UV 存進新模型版本的 TEXCOORD_1（three 載入後是 geometry 的 uv1）。
// 套用以前做的影片（後台寫了「舊版面」快照的那些版本；快照多一個 originalUv 清單）取色改用 uv1，
// 所以跟套用前一個像素都不差，連原本的 UV 橫跨畫布邊緣、弧長不均勻的物件也是；「舊版面」的長方形版型只是備援。
//
// 什麼時候用（缺一個就退回版型的長方形，不會壞）：
//   1. 這個影片的快照把這個物件列在 originalUv 裡（套用當下，這個物件的 TEXCOORD_0 就是這個影片做的時候的 UV）
//   2. 這個材質用到的每一個 mesh 都有 uv1（模型真的存了；換成別的模型、壓縮時丟了都會退回）
// 其他情況（新的影片、測試圖、沒存原本 UV 的物件）取色完全不變。

import * as THREE from 'three';
import type { LedTemplatePlan } from '../ledTemplate';

/** 這個影片（版型快照）要不要用這個物件存的原本 UV 取色 */
export function planWantsOriginalUv(plan: Pick<LedTemplatePlan, 'originalUv'> | null | undefined, objectId: string): boolean {
  return !!plan?.originalUv && plan.originalUv.includes(objectId);
}

/**
 * 這個物件底下，「用到的每一個 mesh 都有 uv1」的材質。一個材質只要有一個 mesh 沒有 uv1 就不算
 * （LED 物件每個來源材質各自一份複本，螢幕是 LED 材質、外框是別的材質，外框沒有 uv1 不影響螢幕）。
 */
export function materialsWithOriginalUv(root: THREE.Object3D): Set<THREE.Material> {
  const all = new Map<THREE.Material, boolean>();
  root.traverse((c) => {
    const mesh = c as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const has = !!(mesh.geometry as THREE.BufferGeometry | undefined)?.getAttribute('uv1');
    for (const m of mats) if (m) all.set(m, (all.get(m) ?? true) && has);
  });
  return new Set([...all].filter(([, ok]) => ok).map(([m]) => m));
}
