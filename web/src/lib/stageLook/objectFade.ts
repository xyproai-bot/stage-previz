// 物件淡入淡出（換 cue 時出現 / 消失）
//   模型 clone 出來的物件跟其他物件共用同一個 C4D 材質 → 不能直接改材質的透明度（別的物件也會一起淡）。
//   淡的時候這個物件暫時換成「自己的半透明複本」，淡完（全亮 / 全暗）換回原本共用的材質、複本丟掉，
//   不會留下半透明材質。
//   複本沿用原本材質的 shader 改寫（LED 像素格、地板倒影）和同一組 uniforms → 淡的過程中看起來跟原本一樣。
//
//   setObjectOpacity  — 每幀設透明度（0 = 隱藏、1 = 原本的樣子）
//   getObjectOpacity  — 現在的透明度（沒在淡 → 看得到 1、藏起來 0）
//   suspendObjectFade — 要改材質設定前先換回原本材質（下一次 setObjectOpacity 會讓複本跟上新設定）
//   endObjectFade     — 物件要移除時：換回原本材質、複本丟掉
//   createFadeWarmup  — 先把半透明複本的 shader 編好（第一次淡入淡出才不會卡一下）

import * as THREE from 'three';

type Mat = THREE.Material | THREE.Material[];

interface MeshFade {
  originals: Mat;
  copies: Mat;
}

const meshFades = new WeakMap<THREE.Mesh, MeshFade>();
const objectOpacity = new WeakMap<THREE.Object3D, number>();

const list = (m: Mat): THREE.Material[] => (Array.isArray(m) ? m : [m]);

/** 讓複本跟原本材質一樣（clone / copy 不會帶 shader 改寫，userData 會變成 JSON 複本 → 手動接回同一份） */
function syncCopy(copy: THREE.Material, original: THREE.Material) {
  copy.copy(original);
  copy.userData = original.userData;
  copy.onBeforeCompile = original.onBeforeCompile;
  copy.customProgramCacheKey = original.customProgramCacheKey;
  copy.transparent = true;
  copy.needsUpdate = true;
}

function makeCopy(original: THREE.Material): THREE.Material {
  const copy = original.clone();
  syncCopy(copy, original);
  return copy;
}

function forEachMesh(obj: THREE.Object3D, fn: (mesh: THREE.Mesh) => void) {
  obj.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) fn(c as THREE.Mesh);
  });
}

export function getObjectOpacity(obj: THREE.Object3D): number {
  return objectOpacity.get(obj) ?? (obj.visible ? 1 : 0);
}

export function setObjectOpacity(obj: THREE.Object3D, opacity: number) {
  const o = Math.min(Math.max(opacity, 0), 1);
  if (o >= 1 || o <= 0) {
    endObjectFade(obj);
    obj.visible = o > 0;
    return;
  }
  obj.visible = true;
  objectOpacity.set(obj, o);
  forEachMesh(obj, (mesh) => {
    if (!mesh.material) return;
    let fade = meshFades.get(mesh);
    if (fade && mesh.material !== fade.copies) {
      // 暫停過（材質設定改了）→ 現在掛著的是原本材質：同一份複本跟上新設定再掛回去
      const originals = list(mesh.material);
      const copies = list(fade.copies);
      if (originals.length === copies.length) {
        copies.forEach((c, i) => syncCopy(c, originals[i]));
        fade.originals = mesh.material;
      } else {
        copies.forEach((c) => c.dispose());
        fade = undefined;
      }
    }
    if (!fade) {
      const originals = mesh.material;
      fade = { originals, copies: Array.isArray(originals) ? originals.map(makeCopy) : makeCopy(originals) };
      meshFades.set(mesh, fade);
    }
    mesh.material = fade.copies;
    const originals = list(fade.originals);
    list(fade.copies).forEach((c, i) => {
      c.opacity = (originals[i]?.opacity ?? 1) * o;
    });
  });
}

export function suspendObjectFade(obj: THREE.Object3D) {
  forEachMesh(obj, (mesh) => {
    const fade = meshFades.get(mesh);
    if (fade && mesh.material === fade.copies) mesh.material = fade.originals;
  });
}

export function endObjectFade(obj: THREE.Object3D) {
  objectOpacity.delete(obj);
  forEachMesh(obj, (mesh) => {
    const fade = meshFades.get(mesh);
    if (!fade) return;
    if (mesh.material === fade.copies) mesh.material = fade.originals;
    list(fade.copies).forEach((c) => c.dispose());
    meshFades.delete(mesh);
  });
}

export interface FadeWarmup {
  /** 暫時的 mesh（共用原本的 geometry、掛半透明複本），不放進要畫的場景 */
  meshes: THREE.Mesh[];
  dispose(): void;
}

/**
 * 淡入淡出預熱：每種材質（同一個材質 + 同一種 geometry 只做一次）做一份跟淡的時候一模一樣的半透明複本，
 * 給 renderer.compile 先把 shader 編好。
 * 複本要一直留著（換模型 / 換模式再換一份）：three 的 shader 沒有材質在用就會被刪掉，
 * 淡完的複本一丟，下次淡又要重編。留著這份 → 每次淡入淡出都直接用編好的。
 */
export function createFadeWarmup(objects: Iterable<THREE.Object3D>): FadeWarmup {
  const seen = new Set<string>();
  const meshes: THREE.Mesh[] = [];
  const copies: THREE.Material[] = [];
  for (const obj of objects) {
    forEachMesh(obj, (mesh) => {
      if (!mesh.material) return;
      // 正在淡 → 掛著的是複本，拿原本的材質
      const fade = meshFades.get(mesh);
      const originals = list(fade && mesh.material === fade.copies ? fade.originals : mesh.material);
      const attrs = Object.keys(mesh.geometry.attributes).sort().join(',');
      for (const original of originals) {
        if (!original) continue;
        const key = `${original.uuid}|${attrs}|${mesh.layers.mask}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const copy = makeCopy(original);
        const warm = new THREE.Mesh(mesh.geometry, copy);
        warm.layers.mask = mesh.layers.mask;
        meshes.push(warm);
        copies.push(copy);
      }
    });
  }
  return {
    meshes,
    dispose() {
      for (const m of meshes) m.removeFromParent();
      for (const c of copies) c.dispose();
    },
  };
}
