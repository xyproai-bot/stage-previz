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

// ───────────────────────── 一個物件裡的好幾塊 LED ─────────────────────────
// 一個物件（例如曲線升降台：台體 + 正面 LED + 左側 LED + 右側 LED）裡有 2 塊以上 LED mesh 時，版型和自動貼 UV 把每一塊當成獨立的一塊
// （各自的位置、各自選「不放進畫布 / 保留 / 自動貼」）；3D 裡還是同一個物件（選取、移動、顯示 / 隱藏都不變）。
// 規則：
//   - 「一塊」= 一個 mesh（同一個節點底下的好幾個 primitive 算同一塊）；只算 screenFlags 判定是螢幕的 mesh
//   - 名稱 = mesh 的名稱（沒有名字用物件名稱 + 序號；同名的後面加 2、3…）
//   - 少於 2 塊、多於 MAX_LED_PARTS 塊、或整個物件都當螢幕（沒有任何材質名稱含 LED 的舊模型）→ 不拆，整個物件一塊（跟以前一模一樣）

/** 一個物件最多拆成幾塊（跟版型 shader 一個物件最多放的螢幕數一樣：ledTemplate.MAX_SCREENS_PER_OBJECT） */
export const MAX_LED_PARTS = 8;

/** 純函式：每塊的原始名稱（可能是空的）→ 不重複、不空白的名稱。同名的後面加 2、3…；沒有名字的叫「<fallback> <序號>」 */
export function partNames(raw: readonly (string | null | undefined)[], fallback: string): string[] {
  const used = new Set<string>();
  return raw.map((r, i) => {
    const base = (r ?? '').trim() || `${fallback} ${i + 1}`;
    let name = base, n = 2;
    while (used.has(name)) name = `${base} ${n++}`;
    used.add(name);
    return name;
  });
}

export interface LedPart { name: string; meshes: THREE.Mesh[] }

/** 這個物件底下的 LED 螢幕分成哪幾塊；不用拆（少於 2 塊、多於 MAX_LED_PARTS 塊）= 空陣列 */
export function ledScreenParts(root: THREE.Object3D, fallbackName = 'LED'): LedPart[] {
  const screens = ledScreenMeshes(root);
  const units = new Map<THREE.Object3D, THREE.Mesh[]>();
  let named = false;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !screens.has(m)) return;
    if ((Array.isArray(m.material) ? m.material : [m.material]).some(x => isLedMaterialName(x?.name))) named = true;
    // 多個 primitive 的 mesh，three 會變成一個 Group 底下好幾個 Mesh：算同一塊
    const p = m.parent;
    const unit = p && p !== root && (p as THREE.Group).isGroup && p.children.every(c => (c as THREE.Mesh).isMesh) ? p : m;
    const list = units.get(unit);
    if (list) list.push(m); else units.set(unit, [m]);
  });
  // 整個物件都當螢幕（沒有任何材質名稱含 LED）= 舊模型，不拆
  if (!named || units.size < 2 || units.size > MAX_LED_PARTS) return [];
  const entries = [...units.entries()];
  const names = partNames(entries.map(([u, ms]) => u.name || ms[0].name), fallbackName);
  return entries.map(([, meshes], i) => ({ name: names[i], meshes }));
}
