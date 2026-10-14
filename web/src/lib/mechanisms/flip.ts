// 翻轉：沿著物件的某一個邊緣翻（上緣 / 下緣 / 左緣 / 右緣 / 前緣 / 後緣）。
// 它還是一個旋轉機關：這裡只負責「從物件的外框算出轉軸和轉軸中心」，算好存在機關原本的 axis / pivot。
// 設計：docs/superpowers/specs/2026-10-15-mechanism-v2-design.md（第 3 節 Flip hinge）
//
// 跟 model.ts 一樣只放純判斷（後端也會用到），不碰 DOM / React / three。
//
// 舞台座標系（右手）：右 R = 觀眾看過去的右手邊，上 U = +Y，前 F = 指向觀眾（R × U = F）。
// 轉軸 +R 轉正的角度：上面往觀眾（F）倒、前面往下壓、後面往上抬；
// 轉軸 +U 轉正的角度：右邊往後（−F）、左邊往觀眾。

import { audienceRight, horizontalFront, type MechVec3 } from './model';

export type FlipHinge = 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back';

/** 「正的角度」兩個選項的意思（positive[0] = 選了第一個、positive[1] = 第二個） */
export const FLIP_HINGES: { key: FlipHinge; label: string; positive: [string, string] }[] = [
  { key: 'top', label: '沿著上緣翻', positive: ['下緣往觀眾翻出來', '下緣往後翻'] },
  { key: 'bottom', label: '沿著下緣翻', positive: ['上緣往觀眾倒', '上緣往後倒'] },
  { key: 'left', label: '沿著左緣翻', positive: ['右緣往觀眾轉出來', '右緣往後轉'] },
  { key: 'right', label: '沿著右緣翻', positive: ['左緣往觀眾轉出來', '左緣往後轉'] },
  { key: 'front', label: '沿著前緣翻', positive: ['後面抬高', '後面壓低'] },
  { key: 'back', label: '沿著後緣翻', positive: ['前面抬高', '前面壓低'] },
];

export const FLIP_HINGE_KEYS: FlipHinge[] = FLIP_HINGES.map(h => h.key);

/** 場景座標裡的外框（軸向對齊） */
export interface StageBox { min: MechVec3; max: MechVec3 }

export interface FlipSetup { hinge: FlipHinge; positive: 'first' | 'second' }

const UP: MechVec3 = { x: 0, y: 1, z: 0 };
const dot = (a: MechVec3, b: MechVec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const scale = (v: MechVec3, k: number): MechVec3 => ({ x: v.x * k || 0, y: v.y * k || 0, z: v.z * k || 0 });
const add3 = (a: MechVec3, b: MechVec3, c: MechVec3): MechVec3 => ({ x: a.x + b.x + c.x, y: a.y + b.y + c.y, z: a.z + b.z + c.z });

/**
 * 外框（場景座標）+ 要沿著哪個邊緣翻 → 轉軸（單位向量）和轉軸中心（場景單位）。
 * 外框投影到舞台的右 / 上 / 前三個方向上量大小，所以舞台不是正對 X 或 Z 軸時也對（外框會稍微大一點）。
 *   上緣 / 下緣：轉軸 = 觀眾的右手邊，轉軸中心在上緣 / 下緣，深度的正中間
 *   左緣 / 右緣：轉軸 = 上，轉軸中心在左緣 / 右緣，高度的正中間、深度的正中間
 *   前緣 / 後緣（斜板）：轉軸 = 觀眾的右手邊，轉軸中心在前緣 / 後緣的最下面
 * positiveFirst = 選了「正的角度」的第一個選項（FLIP_HINGES[].positive[0]）
 */
export function hingeFromBox(box: StageBox, hinge: FlipHinge, front: MechVec3, positiveFirst = true): { axis: MechVec3; pivot: MechVec3 } {
  const f = horizontalFront(front);
  const r = audienceRight(f);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const p = { x, y, z };
    [dot(p, r), dot(p, UP), dot(p, f)].forEach((v, i) => { lo[i] = Math.min(lo[i], v); hi[i] = Math.max(hi[i], v); });
  }
  const [rMin, uMin, fMin] = lo, [rMax, uMax, fMax] = hi;
  const rMid = (rMin + rMax) / 2, uMid = (uMin + uMax) / 2, fMid = (fMin + fMax) / 2;
  const at = (rr: number, uu: number, ff: number): MechVec3 => add3(scale(r, rr), scale(UP, uu), scale(f, ff));
  // 每個邊緣：轉軸（第一個選項的那個方向）和轉軸中心
  let axis: MechVec3, pivot: MechVec3;
  switch (hinge) {
    case 'top': axis = scale(r, -1); pivot = at(rMid, uMax, fMid); break;
    case 'bottom': axis = r; pivot = at(rMid, uMin, fMid); break;
    case 'left': axis = scale(UP, -1); pivot = at(rMin, uMid, fMid); break;
    case 'right': axis = UP; pivot = at(rMax, uMid, fMid); break;
    case 'front': axis = r; pivot = at(rMid, uMin, fMax); break;
    case 'back': axis = scale(r, -1); pivot = at(rMid, uMin, fMin); break;
  }
  return { axis: positiveFirst ? axis : scale(axis, -1), pivot };
}

/** 機關的 metadata.setup → 翻轉的選擇（不是翻轉 / 壞資料 → null） */
export function flipSetupOf(metadata: Record<string, unknown> | null | undefined): FlipSetup | null {
  const s = metadata && typeof metadata === 'object' ? (metadata as { setup?: unknown }).setup : null;
  if (!s || typeof s !== 'object') return null;
  const { hinge, positive } = s as { hinge?: unknown; positive?: unknown };
  if (typeof hinge !== 'string' || !FLIP_HINGE_KEYS.includes(hinge as FlipHinge)) return null;
  return { hinge: hinge as FlipHinge, positive: positive === 'second' ? 'second' : 'first' };
}

/** 存進 metadata：加上（或拿掉）setup，其他欄位照舊 */
export function withFlipSetup(metadata: Record<string, unknown> | null | undefined, setup: FlipSetup | null): Record<string, unknown> | null {
  const rest: Record<string, unknown> = { ...(metadata ?? {}) };
  delete rest.setup;
  if (setup) rest.setup = { hinge: setup.hinge, positive: setup.positive };
  return Object.keys(rest).length ? rest : null;
}

/** 清單上的字：「沿著上緣翻」；不是翻轉 → null */
export function flipLabel(metadata: Record<string, unknown> | null | undefined): string | null {
  const s = flipSetupOf(metadata);
  return s ? FLIP_HINGES.find(h => h.key === s.hinge)!.label : null;
}
