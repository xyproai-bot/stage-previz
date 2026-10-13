// 機關滑桿位移（公尺）跟 cue 存的位置之間的換算
//
// 3D 畫面上 LED 面板的位置 = cue 存的位置 + 機關位移（公尺 → 場景單位，看校準倍率）。
// 在 3D 畫面拖 LED 時拿到的是「畫面上的位置」，存回 cue 之前要先把機關位移扣掉，
// 不然存進去的已經含位移、顯示時又加一次 → LED 會跳走（位移被加兩次）。
//
// scenePosition（cueTimeline.ts）：cue 位置 → 畫面位置；cuePositionFromScene：畫面位置 → cue 位置（反過來）

import type { StageObjectCategory, Vec3 } from './api';

/** 畫面上的位置 → 要存進 cue 的位置：LED 面板扣掉機關位移，其他類別原樣（機關滑桿只動 LED 面板） */
export function cuePositionFromScene(
  p: Vec3,
  category: StageObjectCategory | undefined,
  objectId: string,
  mechanismOffsets: Record<string, { x: number; y: number }> | undefined,
  scaleCorrection: number,
): Vec3 {
  const moff = category === 'led_panel' ? mechanismOffsets?.[objectId] : undefined;
  if (!moff) return { x: p.x, y: p.y, z: p.z };
  return { x: p.x - moff.x / scaleCorrection, y: p.y - moff.y / scaleCorrection, z: p.z };
}
