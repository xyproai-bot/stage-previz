// LED 物件裡哪些部分是「螢幕」（3D 畫面的 LED 材質 / 影片 / 測試圖 / 版型取色、LED 對位圖、舞台正面方向、
// 現場模式的 LED 照明、自動貼 UV 都用這一條規則）：
//   - 物件裡至少有一個材質名稱含「LED」（不分大小寫）→ 只有這些是螢幕；框架、台體、燈牆面…照原本的材質畫
//   - 一個都沒有 → 整個物件都是螢幕（舊模型的螢幕材質可能叫「Screen」之類，照舊全亮，不會變黑）
// 自動貼 UV 讀 GLB 時（ledUv/docRead.ts）用的也是這裡的 LED_MATERIAL_RE。

import type * as THREE from 'three';

export const LED_MATERIAL_RE = /LED/i;

export const isLedMaterialName = (name: string | null | undefined): boolean => LED_MATERIAL_RE.test(name ?? '');

/**
 * 純函式：一個 LED 物件裡每個 mesh 的材質名稱（一個 mesh 可能有好幾個材質）→ 每個 mesh 是不是螢幕。
 * 有任何一個名稱含 LED → 只有含 LED 的那些 mesh 是螢幕；一個都沒有 → 全部都是。
 */
export function screenFlags(materialNames: readonly (readonly (string | null | undefined)[])[]): boolean[] {
  const named = materialNames.map(names => names.some(isLedMaterialName));
  if (!named.some(Boolean)) return materialNames.map(() => true);
  return named;
}

/** 這個 LED 物件底下哪些 mesh 是螢幕（規則見 screenFlags） */
export function ledScreenMeshes(root: THREE.Object3D): Set<THREE.Mesh> {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) meshes.push(m);
  });
  const flags = screenFlags(meshes.map(m => (Array.isArray(m.material) ? m.material : [m.material]).map(x => x?.name)));
  return new Set(meshes.filter((_, i) => flags[i]));
}
