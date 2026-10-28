// 調整舞台的「看的角度」：觀眾看 / 正上方 / 側面，選到吊掛（提詞 LED）時看過去。
// 回傳的是 StageViewApi.flyTo 吃的 CameraView（場景座標）。

import type { CameraView } from '../api';
import type { MechVec3 } from '../mechanisms/model';

export type StageViewKind = 'audience' | 'top' | 'side';

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const vec = (x: number, y: number, z: number): [number, number, number] => [r4(x), r4(y), r4(z)];

/** 水平的正面方向（單位長度）；壞掉 → +z */
function flatFront(front: MechVec3): { x: number; z: number } {
  const len = Math.hypot(front.x, front.z);
  return len > 1e-9 ? { x: front.x / len, z: front.z / len } : { x: 0, z: 1 };
}

/** 看得到整個半徑 radius 的距離 */
function fitDistance(radius: number, fov: number): number {
  const half = (Math.max(10, Math.min(120, fov)) * Math.PI) / 360;
  return (Math.max(radius, 0.5) / Math.sin(half)) * 0.85;
}

export function stageView(kind: StageViewKind, bounds: { center: MechVec3; radius: number }, front: MechVec3, fov: number): CameraView {
  const c = bounds.center;
  const f = flatFront(front);
  const d = fitDistance(bounds.radius, fov);
  const target = vec(c.x, c.y, c.z);
  if (kind === 'top') {
    // 稍微偏觀眾那邊：鏡頭不會正好垂直（才不會翻），畫面下面是觀眾
    const off = d * 0.01;
    return { position: vec(c.x + f.x * off, c.y + d, c.z + f.z * off), target, fov };
  }
  if (kind === 'side') {
    // 觀眾看過去的右邊：(−正面) × 上 = (f.z, 0, −f.x)
    const rx = f.z, rz = -f.x;
    return { position: vec(c.x + rx * d, c.y + d * 0.15, c.z + rz * d), target, fov };
  }
  const el = (15 * Math.PI) / 180;
  return { position: vec(c.x + f.x * d * Math.cos(el), c.y + d * Math.sin(el), c.z + f.z * d * Math.cos(el)), target, fov };
}

/** 看一個物件（吊掛）：從舞台中心那一邊看過去、高一點；物件就在舞台中心 → 從後面（−正面）看 */
export function focusView(center: MechVec3, radius: number, stageCenter: MechVec3, front: MechVec3, fov: number): CameraView {
  let dx = stageCenter.x - center.x, dz = stageCenter.z - center.z;
  const len = Math.hypot(dx, dz);
  if (len > 1e-6) { dx /= len; dz /= len; } else { const f = flatFront(front); dx = -f.x; dz = -f.z; }
  const d = fitDistance(radius, fov) * 1.4;
  return {
    position: vec(center.x + dx * d, center.y + d * 0.3, center.z + dz * d),
    target: vec(center.x, center.y, center.z),
    fov,
  };
}
