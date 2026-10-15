// 比例尺的樂手和器材放進 3D 畫面：一個 Group 裝所有模型，依存檔的清單擺好位置 / 轉角、
// 選到的換成琥珀色 + 腳下一圈圈圈 + 前面一顆轉動把手；提供「滑鼠指到哪一個」「哪些頂面可以站」給拖動用。
// （模型本身在 stagePropModels.ts，存檔格式和算法在 stageProps.ts；拖動 / 選取的事件在 StageScene.tsx）

import * as THREE from 'three';
import { applyPropMaterials, buildStageProp, createPropMaterials, disposeStageProp } from './stagePropModels';
import { type StagePropItem, type StagePropType } from './stageProps';

export interface PropHit { id: string; distance: number }

export interface StagePropsLayer {
  /** 放進場景的 Group（名字 scale-reference-props） */
  readonly group: THREE.Group;
  /** 依清單擺好（新的建出來、不見的拿掉、位置 / 轉角更新），selectedId 那個換成選到的樣子 */
  sync(items: readonly StagePropItem[], selectedId: string | null): void;
  /** 滑鼠光線打到哪一個（最近的）；沒有 = null。光線要先 setFromCamera */
  pick(ray: THREE.Raycaster): PropHit | null;
  /** 自發光的強度：暗場（現場模式）要高一點才看得到，亮的場景（快速模式）低一點才不會一片白 */
  setBoost(k: number): void;
  /** 選到的那個的轉動把手有沒有被打到 */
  pickHandle(ray: THREE.Raycaster): PropHit | null;
  /** 可以站上去的頂面（樂手台）；exclude 裡的不算（正在拖的那個、站在它上面的） */
  walkables(exclude?: ReadonlySet<string>): THREE.Mesh[];
  dispose(): void;
}

interface Entry {
  root: THREE.Group;
  type: StagePropType;
  selected: boolean;
  decor: THREE.Group | null;
}

const DEG = Math.PI / 180;

export function createStagePropsLayer(unitsPerMeter: number): StagePropsLayer {
  const group = new THREE.Group();
  group.name = 'scale-reference-props';
  const mats = createPropMaterials();
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffd36e, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, fog: false,
  });
  const handleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
  const entries = new Map<string, Entry>();

  const place = (e: Entry, it: StagePropItem) => {
    e.root.scale.setScalar(unitsPerMeter);
    e.root.position.set(it.x * unitsPerMeter, it.y * unitsPerMeter, it.z * unitsPerMeter);
    e.root.rotation.y = it.rotY * DEG;
  };

  const removeDecor = (e: Entry) => {
    if (!e.decor) return;
    e.root.remove(e.decor);
    e.decor.traverse((o) => { (o as THREE.Mesh).geometry?.dispose?.(); });
    e.decor = null;
  };

  const addDecor = (e: Entry) => {
    const r = (e.root.userData.radius as number) + 0.14;
    const decor = new THREE.Group();
    decor.name = 'stage-prop-selection';
    const ring = new THREE.Mesh(new THREE.RingGeometry(r - 0.035, r, 64), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.025;
    ring.renderOrder = 8;
    ring.userData.noPick = true;
    ring.userData.keepMaterial = true;
    const handle = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), handleMat);
    handle.position.set(0, 0.06, r);
    handle.renderOrder = 9;
    handle.userData.noPick = true;
    handle.userData.rotateHandle = true;
    handle.userData.keepMaterial = true;
    decor.add(ring, handle);
    e.root.add(decor);
    e.decor = decor;
  };

  const idOf = (o: THREE.Object3D | null): string | null => {
    for (let p: THREE.Object3D | null = o; p; p = p.parent) {
      if (typeof p.userData.propId === 'string') return p.userData.propId;
    }
    return null;
  };

  return {
    group,

    sync(items, selectedId) {
      const keep = new Set(items.map(i => i.id));
      for (const [id, e] of entries) {
        if (keep.has(id)) continue;
        removeDecor(e);
        group.remove(e.root);
        disposeStageProp(e.root);
        entries.delete(id);
      }
      for (const it of items) {
        let e = entries.get(it.id);
        if (e && e.type !== it.type) {
          removeDecor(e);
          group.remove(e.root);
          disposeStageProp(e.root);
          entries.delete(it.id);
          e = undefined;
        }
        if (!e) {
          const root = buildStageProp(it.type, mats.normal);
          root.userData.propId = it.id;
          group.add(root);
          e = { root, type: it.type, selected: false, decor: null };
          entries.set(it.id, e);
        }
        place(e, it);
        const sel = it.id === selectedId;
        if (sel !== e.selected || (sel && !e.decor)) {
          e.selected = sel;
          applyPropMaterials(e.root, sel ? mats.selected : mats.normal);
          removeDecor(e);
          if (sel) addDecor(e);
        }
      }
      group.updateMatrixWorld(true);
    },

    setBoost(k) {
      for (const m of [mats.normal.main, mats.normal.accent, mats.selected.main, mats.selected.accent]) {
        (m as THREE.MeshStandardMaterial).emissiveIntensity = k;
      }
    },

    pick(ray) {
      const roots = [...entries.values()].map(e => e.root);
      if (roots.length === 0) return null;
      for (const h of ray.intersectObjects(roots, true)) {
        const o = h.object;
        if (o.userData.walkTop || o.userData.noPick) continue;
        const id = idOf(o);
        if (id) return { id, distance: h.distance };
      }
      return null;
    },

    pickHandle(ray) {
      for (const [id, e] of entries) {
        const handle = e.selected ? e.decor?.children.find(c => c.userData.rotateHandle) : undefined;
        if (!handle) continue;
        const hit = ray.intersectObject(handle, false)[0];
        if (hit) return { id, distance: hit.distance };
      }
      return null;
    },

    walkables(exclude) {
      const out: THREE.Mesh[] = [];
      for (const [id, e] of entries) {
        if (exclude?.has(id)) continue;
        e.root.traverse((o) => { if (o.userData.walkTop) out.push(o as THREE.Mesh); });
      }
      return out;
    },

    dispose() {
      for (const e of entries.values()) { removeDecor(e); disposeStageProp(e.root); }
      entries.clear();
      group.clear();
      mats.normal.main.dispose(); mats.normal.accent.dispose();
      mats.selected.main.dispose(); mats.selected.accent.dispose();
      ringMat.dispose(); handleMat.dispose();
    },
  };
}
