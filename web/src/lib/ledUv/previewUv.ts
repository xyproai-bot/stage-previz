// 自動貼 UV：3D 預覽用的新 UV（在 worker 裡算，不寫檔、不上傳）
//
// 照排好的方案算出每個被處理的 LED 物件、每個螢幕 primitive 的新 UV（跟之後真的寫進模型的是同一組數字，同一個函數算的），
// 3D 畫面把這組 UV 暫時換到 LED 的 mesh 上，測試圖就會長得跟套用以後一模一樣。
// 對到 three 的 mesh：照節點順序（深度優先）一個一個比，再用「頂點數 + 第一個頂點的位置」確認是同一個；對不上就不預覽。

import type { Document } from '@gltf-transform/core';
import type { CanvasSize } from '../ledMap';
import { readLedObjects } from './docRead';
import { computePlanUvs, type WantedObject } from './pipeline';
import { excludedIdsOf, type Plan } from './plan';

export interface PrimPreview {
  /** 頂點數 */
  count: number;
  /** 第一個頂點的位置（節點自己的座標，檔案裡原本的數字） */
  first: [number, number, number];
  /** 每個頂點 2 個數字；null = 這個 primitive 的 UV 不換（外框、背板，不是 LED 畫面）。有 split 的話，後面多出來的是複製的接縫頂點 */
  uv: Float32Array | null;
  /** 整圈圓柱的接縫：多出來的頂點各自複製哪一個原本的頂點、改過的索引（3D 預覽要換掉整個 geometry） */
  split?: { origin: Uint32Array; index: Uint32Array };
}

export interface UvPreview {
  canvas: CanvasSize;
  /** 物件 id → 每個 primitive（照模型裡的順序，所有三角形的都有）的新 UV */
  objects: Record<string, PrimPreview[]>;
  /** 選了「不放進畫布」的物件 id：套用以後它們不再是 LED，3D 畫面預覽時照一般物件顯示（沒有測試圖） */
  excluded: string[];
}

export type UvPreviewResult = { ok: true; preview: UvPreview } | { ok: false; reason: string };

export function buildUvPreview(doc: Document, objects: readonly WantedObject[], plan: Plan, oldCanvas: CanvasSize): UvPreviewResult {
  const read = readLedObjects(doc, objects);
  const computed = computePlanUvs(read, plan, oldCanvas);
  if (!computed.ok) return computed;
  const out: Record<string, PrimPreview[]> = {};
  for (const [id, list] of computed.uvs) {
    const so = read.objects.get(id)!;
    out[id] = list.map((uv, i) => {
      const pos = so.refs[i].prim.getAttribute('POSITION')!;
      const v = pos.getElement(0, [0, 0, 0]);
      // 不是螢幕的 primitive（外框、背板）沒有 LED 畫面，不用換（但還是要列出來，3D 那邊才對得上順序）
      const show = !!uv && so.geom.prims[i].screen;
      return { count: pos.getCount(), first: [v[0], v[1], v[2]] as [number, number, number], uv: show ? uv!.uv : null, ...(show && uv!.split ? { split: uv!.split } : {}) };
    });
  }
  return { ok: true, preview: { canvas: { width: plan.canvas.width, height: plan.canvas.height }, objects: out, excluded: excludedIdsOf(plan) } };
}
