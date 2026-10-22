// 自動貼 UV「不放進畫布」的 LED：3D 上一律顯示黑色（像沒通電的 LED），不管有沒有選版型、有沒有畫面
//
// 清單（後台 projects.led_off_pieces，0045；跟著模型版本走）的每一項：
//   - 「物件id」           整個物件不放進畫布（套用後類型是「其他」）→ 物件裡的螢幕全黑
//   - 「物件id~mesh 名稱」 物件裡某一塊 LED 不放進畫布（物件還是 LED 面板）→ 只有那一塊黑，其他塊照常
// 製作之後手動把整個物件改回 LED 面板 → 照常顯示（整個物件那一項只在它不是 LED 面板時才算）。
// 沒有清單（舊專案、沒排除過）= 什麼都不變。

import * as THREE from 'three';
import { ledScreenMeshes, ledScreenParts } from './ledScreen';
import { captureOriginal } from './stageLook/materialOverrides';

/** 清單裡「物件id~mesh 名稱」的寫法（跟自動貼 UV 的塊名稱同一條規則：LedPart.name） */
export const offPieceKey = (objectId: string, partName: string): string => `${objectId}~${partName}`;

/** 把任何東西讀成清單（不是字串陣列 = 空） */
export function normalizeOffPieces(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.length > 0))];
}

/**
 * 這個物件底下哪些螢幕 mesh 要顯示成黑色。
 * isLed = 物件現在的類型是不是 LED 面板。清單是空的 / 這個物件不在清單裡 = 空集合。
 */
export function offScreenMeshes(root: THREE.Object3D, objectId: string, isLed: boolean, list: readonly string[] | ReadonlySet<string>): Set<THREE.Mesh> {
  const has = (k: string) => (list instanceof Set ? list.has(k) : (list as readonly string[]).includes(k));
  const out = new Set<THREE.Mesh>();
  if (!isLed && has(objectId)) {
    for (const m of ledScreenMeshes(root)) out.add(m);
    return out;
  }
  if (!isLed) return out;
  // 只有物件裡 2 塊以上 LED mesh 才分得出「某一塊」（不拆的物件沒有塊的名字）
  for (const part of ledScreenParts(root, root.name || 'LED')) {
    if (has(offPieceKey(objectId, part.name))) for (const m of part.meshes) out.add(m);
  }
  return out;
}

/** 沒通電的 LED 面：黑色、不發光、沒有貼圖（材質要是這個 mesh 自己的，不能是跟別塊共用的） */
export function blackenMaterial(m: THREE.MeshStandardMaterial): void {
  m.color.set(0x000000);
  m.map = null;
  m.emissiveMap = null;
  m.metalness = 0;
  m.roughness = 0.35;
  m.needsUpdate = true;
}

/** 換掉之前的原本材質（不放在 userData：場景複製時 userData 會被轉成 JSON，材質會壞掉） */
const prevMaterial = new WeakMap<THREE.Mesh, THREE.Material>();

/** 上次換成黑色專用複本的 mesh 全部還原成原本的材質（物件重新整理材質之前先呼叫；沒換過的不動） */
export function restoreOffMaterials(root: THREE.Object3D): void {
  root.traverse((c) => {
    const mesh = c as THREE.Mesh;
    const prev = mesh.isMesh ? prevMaterial.get(mesh) : undefined;
    if (!prev) return;
    (mesh.material as THREE.Material).dispose();
    mesh.material = prev;
    prevMaterial.delete(mesh);
  });
}

/**
 * 要黑的 mesh 換成自己專用的材質複本（跟別塊共用的材質不動）。要先 restoreOffMaterials。
 * 呼叫前淡入淡出要先 suspendObjectFade（mesh.material 不能是淡入淡出的半透明複本）。
 */
export function swapOffMaterials(off: ReadonlySet<THREE.Mesh>): void {
  for (const mesh of off) {
    if (prevMaterial.has(mesh)) continue;
    const cur = mesh.material;
    if (!cur || Array.isArray(cur) || !(cur as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue;
    captureOriginal(cur as THREE.MeshStandardMaterial);   // C4D 原值先記在來源上，複本跟著走（材質面板「回到原本」照常）
    const copy = (cur as THREE.MeshStandardMaterial).clone();
    delete copy.userData.ledSurface;
    prevMaterial.set(mesh, cur);
    mesh.material = copy;
  }
}

export const isOffMesh = (mesh: THREE.Mesh): boolean => prevMaterial.has(mesh);
