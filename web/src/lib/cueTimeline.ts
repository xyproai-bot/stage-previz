// 影片時間軸 → 舞台位置（分享頁播本地影片時用）
//   每個有「對應影片時間」的 cue：在那一秒剛好到位，提前「淡入淡出時間」秒開始等速移動。
//   位置是影片時間算出來的（不是時鐘），所以暫停會停在半路、拉回時間軸舞台也跟著退回去。
//
//   cueWindows   — 每個 cue 什麼時候開始動、什麼時候到
//   timelineAt   — 影片某一秒：停在哪個 cue，或正在從哪個 cue 走到哪個 cue、走了幾成
//   cuePoses / blendCuePoses / poseAtTime — 物件位置（位置直線走、旋轉走近路、顯示/隱藏）
//   cueQuaternion / scenePosition — cue 存的角度 / 位置 → 3D 場景用的（管理頁、分享頁共用）

import * as THREE from 'three';
import type { CueState, Euler, StageObjectCategory, Vec3 } from './api';
import { cueMoveProgress, cueTransitionSeconds } from './cueTiming';

export interface TimelineCue {
  id: string;
  videoTimeSec: number | null;
  crossfadeSeconds: number;
}

/** 一個 cue 的移動時段：start 開始動、arrive 剛好到位（= 對應影片時間） */
export interface CueWindow {
  cueId: string;
  start: number;
  arrive: number;
}

/**
 * 有影片時間的 cue 照時間排好，算出每個 cue 的移動時段。
 * 第一個 cue 不用移動；淡入淡出比兩個 cue 的間隔長 → 從上一個 cue 到的那一秒才開始（不會提早出發）。
 */
export function cueWindows(cues: TimelineCue[]): CueWindow[] {
  const timed = cues
    .filter(c => c.videoTimeSec != null)
    .sort((a, b) => (a.videoTimeSec as number) - (b.videoTimeSec as number));
  let prevArrive = -Infinity;
  return timed.map((c, i) => {
    const arrive = c.videoTimeSec as number;
    const start = i === 0 ? arrive : Math.max(arrive - cueTransitionSeconds(c), prevArrive);
    prevArrive = arrive;
    return { cueId: c.id, start, arrive };
  });
}

export type TimelinePosition =
  | { kind: 'hold'; cueId: string }
  | { kind: 'move'; fromCueId: string; toCueId: string; progress: number };

/** 影片第 t 秒：停在某個 cue，或正在移動（progress 0..1，等速） */
export function timelineAt(windows: CueWindow[], t: number): TimelinePosition | null {
  if (windows.length === 0) return null;
  for (let i = windows.length - 1; i >= 1; i--) {
    const w = windows[i];
    if (t >= w.arrive) return { kind: 'hold', cueId: w.cueId };
    if (t >= w.start) {
      return {
        kind: 'move',
        fromCueId: windows[i - 1].cueId,
        toCueId: w.cueId,
        progress: cueMoveProgress(t - w.start, w.arrive - w.start),
      };
    }
  }
  return { kind: 'hold', cueId: windows[0].cueId };
}

/** 一個物件在某個瞬間的位置（cue 存的位置，還沒加機關位移 / 校準） */
export interface CuePose {
  category: StageObjectCategory;
  position: Vec3;
  quaternion: THREE.Quaternion;
  visible: boolean;
}
export type CuePoseMap = Map<string, CuePose>;

/** cue 的角度（度，pitch/yaw/roll = X/Y/Z）→ 四元數 */
export function cueQuaternion(r: Euler): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(r.pitch),
    THREE.MathUtils.degToRad(r.yaw),
    THREE.MathUtils.degToRad(r.roll),
  ));
}

/** cue 存的位置 → 場景位置：LED 面板加上機關位移（公尺 → 場景單位），其他類別不受機關影響 */
export function scenePosition(
  p: Vec3,
  category: StageObjectCategory,
  objectId: string,
  mechanismOffsets: Record<string, { x: number; y: number }> | undefined,
  scaleCorrection: number,
): Vec3 {
  const moff = category === 'led_panel' ? mechanismOffsets?.[objectId] : undefined;
  if (!moff) return { x: p.x, y: p.y, z: p.z };
  return { x: p.x + moff.x / scaleCorrection, y: p.y + moff.y / scaleCorrection, z: p.z };
}

/** 一個 cue 的所有物件位置（先算好，每幀直接拿） */
export function cuePoses(states: CueState[]): CuePoseMap {
  const out: CuePoseMap = new Map();
  for (const s of states) {
    out.set(s.objectId, {
      category: s.category,
      position: { ...s.effective.position },
      quaternion: cueQuaternion(s.effective.rotation),
      visible: s.effective.visible,
    });
  }
  return out;
}

/**
 * 從 from 走到 to 走了 p（0..1）：位置直線走、旋轉走近路（四元數 slerp，不會繞一大圈）。
 * 移動中兩邊有一邊看得到就顯示；到了（p ≥ 1）照 to 的。只有一邊有的物件用有的那邊。
 */
export function blendCuePoses(from: CuePoseMap, to: CuePoseMap, p: number): CuePoseMap {
  const out: CuePoseMap = new Map();
  for (const [id, b] of to) {
    const a = from.get(id);
    if (!a) { out.set(id, b); continue; }
    out.set(id, {
      category: b.category,
      position: {
        x: a.position.x + (b.position.x - a.position.x) * p,
        y: a.position.y + (b.position.y - a.position.y) * p,
        z: a.position.z + (b.position.z - a.position.z) * p,
      },
      quaternion: new THREE.Quaternion().slerpQuaternions(a.quaternion, b.quaternion, p),
      visible: p >= 1 ? b.visible : (a.visible || b.visible),
    });
  }
  for (const [id, a] of from) {
    if (!to.has(id)) out.set(id, a);
  }
  return out;
}

/** 影片第 t 秒的所有物件位置；需要的 cue 位置還沒抓到 → null */
export function poseAtTime(windows: CueWindow[], posesByCue: Map<string, CuePoseMap>, t: number): CuePoseMap | null {
  const at = timelineAt(windows, t);
  if (!at) return null;
  if (at.kind === 'hold') return posesByCue.get(at.cueId) ?? null;
  const a = posesByCue.get(at.fromCueId);
  const b = posesByCue.get(at.toCueId);
  if (!a || !b) return null;
  return blendCuePoses(a, b, at.progress);
}
