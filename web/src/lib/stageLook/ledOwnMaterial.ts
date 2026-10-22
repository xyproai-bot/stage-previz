// LED 物件各自一份材質
//   C4D / GLB 匯出的模型裡，所有 LED 通常共用同一個材質（例如叫「LED」）；StageScene 從模型 clone 物件時，材質也是同一個實例。
//   但 LED 的設定是「每個物件」的：版型（這塊螢幕去畫布哪裡取色）、亮度、色調、選取的提示色。
//   共用一個材質 = 每個物件都寫進同一組 uniforms，最後一個物件蓋掉前面所有的 → 其他螢幕的 UV 落在最後那塊的範圍外 → 整塊黑的。
//
//   作法：每個 LED 物件的 mesh 掛自己的材質複本（同一個物件裡共用同一個來源材質的 mesh 共用一份複本，因為設定是整個物件的）。
//   - 複本從 C4D 原值來：先 captureOriginal（原值跟著複本走，材質面板「回到原本」照常）、名字不變（材質面板依名稱的覆寫照常）
//   - 複本沒有 onBeforeCompile / customProgramCacheKey（clone 不帶）、userData.ledSurface 是 JSON 壞掉的樣子 → 丟掉，
//     之後 configureLedMaterial → applyLedSurface 會幫複本做一組全新的 uniforms
//   - shader 程式還是共用：customProgramCacheKey 是固定的字串（看貼圖種類），不是每個複本編一份；
//     three 的 program 快取依這個 key，所以 N 塊 LED = 一份 program、N 組 uniforms
//   - 來源材質（模型裡那個共用的）完全不動：非 LED 物件如果也用同一個材質，不會被 LED 的設定蓋到
//   - 複本是 mesh.material，換模型 / 移除物件時 StageScene 的 disposeObject3D 一起丟掉；淡入淡出的半透明複本（objectFade）
//     是從這份複本再做，userData 指向這份的 uniforms → 淡的時候一樣看得到自己的設定

import * as THREE from 'three';
import { captureOriginal } from './materialOverrides';
import { ledScreenMeshes } from '../ledScreen';

/** 我們做出來的 LED 專用複本（做過就不再複製） */
const owned = new WeakSet<THREE.Material>();

export function isOwnLedMaterial(m: THREE.Material | null | undefined): boolean {
  return !!m && owned.has(m);
}

/** 從模型裡共用的材質做一份 LED 專用的複本（原值照舊、名字照舊、沒有 LED shader 的東西） */
function cloneForLed(source: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  // 原值先記在來源上，clone 會把 userData 整份複製過去
  captureOriginal(source);
  const copy = source.clone();
  // clone 把 userData 轉成 JSON 再轉回來：LED 的 uniforms 會變成不能用的樣子，丟掉讓 configureLedMaterial 重做
  delete copy.userData.ledSurface;
  owned.add(copy);
  return copy;
}

/**
 * 讓這個 LED 物件底下每個 mesh 都掛自己的材質複本（已經是複本的不動，所以重複呼叫沒關係）。
 * 呼叫前淡入淡出要先 suspendObjectFade（mesh.material 不能是淡入淡出的半透明複本）。
 */
export function ensureOwnLedMaterials(obj: THREE.Object3D): void {
  const bySource = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  // 只有螢幕要複本（框架、台體照用模型的材質，lib/ledScreen.ts）
  const screens = ledScreenMeshes(obj);
  obj.traverse((c) => {
    const mesh = c as THREE.Mesh;
    if (!mesh.isMesh || !screens.has(mesh)) return;
    const cur = mesh.material;
    if (!cur || Array.isArray(cur) || !(cur as THREE.MeshStandardMaterial).isMeshStandardMaterial || owned.has(cur)) return;
    let own = bySource.get(cur);
    if (!own) {
      own = cloneForLed(cur as THREE.MeshStandardMaterial);
      bySource.set(cur, own);
    }
    mesh.material = own;
  });
}
