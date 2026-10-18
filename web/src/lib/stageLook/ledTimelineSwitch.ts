// 中途換版型：在「換版型的那一格」把每個 LED 物件的取色換成新一段版型的排法（StageScene 的每一幀都呼叫 sync）。
//
// 為什麼要預先算好：換版型的瞬間只能做「把算好的一小堆數字抄進 shader 的 uniform」，不能重算、不能重編 shader、
// 不能等下一次 React 更新（那會晚一格或兩格 → 閃一下）。所以 StageScene 在材質設定那一步把「每一段 × 每個物件」的
// uniform 資料全部算好（buildObjectUniforms），這裡只負責：這一幀該是第幾段？跟上一幀不一樣就整批換。
// 顏色路徑（shader 的取色那一行）完全沒動，換的只是 uLedTplSrc / Dst / Mat / Off 這些「去貼圖哪裡取色」的座標。

import type * as THREE from 'three';
import type { LedTemplatePlan, TemplateUniformData } from '../ledTemplate';
import type { UvRect } from './ledEmitters';
import { setLedOriginalUv, setLedTemplate } from './ledSurface';
import { planWantsOriginalUv } from './ledOriginalUv';

/** 某個物件在某一段用的取色資料 */
export interface SegmentRecord {
  plan: LedTemplatePlan;
  data: TemplateUniformData | null;
  /** 燈光顏色（環境光）取樣用的位置換算 */
  remap: (r: UvRect) => UvRect | null;
}

export interface SegmentObject {
  id: string;
  /** 這個物件上走版型取色的 LED 材質 */
  materials: THREE.MeshStandardMaterial[];
  /** 每一段一筆（跟時間線的段落同順序） */
  per: SegmentRecord[];
  /** 模型存了原本 UV（uv1）的材質（舊影片 / 自動貼 UV 的保護用）；沒有 = null */
  originalUvMaterials: ReadonlySet<THREE.Material> | null;
}

export interface SegmentSwitcher {
  /** 現在套用的是第幾段 */
  readonly applied: number;
  /** 這一幀該是第幾段；跟套用的不一樣就換掉，回傳有沒有換 */
  sync(): boolean;
  /** 強制套用某一段 */
  apply(index: number): void;
}

export interface SegmentSwitcherOptions {
  objects: readonly SegmentObject[];
  /** 這一幀的段落編號（StageScene：影片的畫面時鐘 / 選到的 Cue 的時間 → segmentIndexAt） */
  pick: () => number;
  startIndex: number;
  /** 換段落時把燈光取色的位置換算也換掉 */
  setRemap: (objectId: string, remap: (r: UvRect) => UvRect | null) => void;
  onApplied?: (index: number) => void;
}

export function createSegmentSwitcher(o: SegmentSwitcherOptions): SegmentSwitcher {
  let applied = o.startIndex;
  const apply = (index: number) => {
    for (const obj of o.objects) {
      const rec = obj.per[index];
      if (!rec) continue;
      o.setRemap(obj.id, rec.remap);
      const wantsOrig = planWantsOriginalUv(rec.plan, obj.id);
      for (const m of obj.materials) {
        const useOrig = wantsOrig && !!obj.originalUvMaterials && obj.originalUvMaterials.has(m);
        setLedTemplate(m, useOrig ? null : rec.data);
        setLedOriginalUv(m, useOrig);
      }
    }
    applied = index;
    o.onApplied?.(index);
  };
  return {
    get applied() { return applied; },
    sync() {
      const next = o.pick();
      if (next === applied) return false;
      apply(next);
      return true;
    },
    apply,
  };
}
