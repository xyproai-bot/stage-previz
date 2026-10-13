// LED 照明燈組：每塊發光面（LedEmitter）一盞 RectAreaLight。
// - 位置 / 方向 / 大小：每幀跟著 LED 物件的 matrixWorld（cue、機關滑桿、crossfade 都會動）
// - 顏色 / 強度：由外部定時取色後呼叫 updateColors（跟著畫面內容變）
// - 燈太多時只亮面積最大的 maxLights 盞（效能）

import * as THREE from 'three';
import type { LedEmitter, UvRect } from './ledEmitters';

/** LED 亮度 1、照明強度 1、全白畫面時的燈強度（實機調過再改這個數字） */
export const LED_LIGHT_BASE_INTENSITY = 4;

export interface LedLightProps {
  brightness: number;
  castStrength: number;
  tint: THREE.Color;
}

export function emitterLightParams(
  avgLinear: [number, number, number], props: LedLightProps, strength: number,
): { color: THREE.Color; intensity: number } {
  const r = avgLinear[0] * props.tint.r;
  const g = avgLinear[1] * props.tint.g;
  const b = avgLinear[2] * props.tint.b;
  const peak = Math.max(r, g, b);
  if (!(peak > 1e-4)) return { color: new THREE.Color(1, 1, 1), intensity: 0 };
  return {
    color: new THREE.Color(r / peak, g / peak, b / peak),
    intensity: peak * props.brightness * props.castStrength * strength * LED_LIGHT_BASE_INTENSITY,
  };
}

interface Entry {
  objectId: string;
  emitter: LedEmitter;
  light: THREE.RectAreaLight;
}

export class LedLightRig {
  private entries: Entry[] = [];
  private emittersByObject = new Map<string, LedEmitter[]>();
  private maxLights = Infinity;
  private enabled = false;
  private visibleCount = 0;
  private readonly tmp = {
    pos: new THREE.Vector3(), n: new THREE.Vector3(), h: new THREE.Vector3(),
    s: new THREE.Vector3(), target: new THREE.Vector3(),
  };

  constructor(private scene: THREE.Scene) {}

  get lightCount() { return this.visibleCount; }

  /** 同一個陣列重複設定會略過（effect 每次跑都會呼叫） */
  setObjectEmitters(objectId: string, emitters: LedEmitter[]) {
    if (this.emittersByObject.get(objectId) === emitters) return;
    this.removeObject(objectId);
    this.emittersByObject.set(objectId, emitters);
    for (const emitter of emitters) {
      const light = new THREE.RectAreaLight(0xffffff, 0, emitter.width, emitter.height);
      light.visible = false;
      this.scene.add(light);
      this.entries.push({ objectId, emitter, light });
    }
    // 面積大的排前面 → 超過上限時先亮大的
    this.entries.sort((a, b) => b.emitter.area - a.emitter.area);
  }

  retainObjects(ids: Set<string>) {
    for (const id of [...this.emittersByObject.keys()]) {
      if (!ids.has(id)) this.removeObject(id);
    }
  }

  setMaxLights(n: number) { this.maxLights = Math.max(0, n); }

  setEnabled(on: boolean) { this.enabled = on; }

  updatePoses(objects: Map<string, THREE.Object3D>) {
    const { pos, n, h, s, target } = this.tmp;
    let shown = 0;
    for (const e of this.entries) {
      const obj = objects.get(e.objectId);
      if (!this.enabled || !obj || !obj.visible || shown >= this.maxLights) {
        e.light.visible = false;
        continue;
      }
      obj.updateWorldMatrix(true, false);
      const mw = obj.matrixWorld;
      pos.copy(e.emitter.center).applyMatrix4(mw);
      n.copy(e.emitter.normal).transformDirection(mw);
      h.copy(e.emitter.heightAxis).transformDirection(mw);
      obj.getWorldScale(s);
      const scale = (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3;
      e.light.width = e.emitter.width * scale;
      e.light.height = e.emitter.height * scale;
      // 稍微往前推，避免燈跟面板本身重疊
      e.light.position.copy(pos).addScaledVector(n, Math.min(e.light.width, e.light.height) * 0.01);
      e.light.up.copy(h);
      target.copy(e.light.position).add(n);
      e.light.lookAt(target);
      e.light.visible = e.light.intensity > 0;
      if (e.light.visible) shown++;
    }
    this.visibleCount = shown;
  }

  updateColors(
    sample: (objectId: string, uv: UvRect) => [number, number, number] | null,
    propsFor: (objectId: string) => LedLightProps,
    strength: number,
  ) {
    for (const e of this.entries) {
      const props = propsFor(e.objectId);
      // 沒 UV 或讀不到貼圖 → 用白色（只吃 tint / 亮度）
      const avg: [number, number, number] = (e.emitter.uv && sample(e.objectId, e.emitter.uv)) || [1, 1, 1];
      const { color, intensity } = emitterLightParams(avg, props, strength);
      e.light.color.copy(color);
      e.light.intensity = intensity;
    }
  }

  dispose() {
    for (const e of this.entries) {
      this.scene.remove(e.light);
      e.light.dispose();
    }
    this.entries = [];
    this.emittersByObject.clear();
  }

  private removeObject(objectId: string) {
    this.entries = this.entries.filter((e) => {
      if (e.objectId !== objectId) return true;
      this.scene.remove(e.light);
      e.light.dispose();
      return false;
    });
    this.emittersByObject.delete(objectId);
  }
}
