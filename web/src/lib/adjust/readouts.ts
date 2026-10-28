// 調整舞台面板上「導演不用自己算」的字：
//   自轉：從上一個 cue 轉過來，從上面看是逆時針還是順時針、轉幾度（幾圈）—— 180° 和 −180° 畫面一樣，差在轉的方向
//   沿弧形軌道：跟原本的位置（值 0）比，往觀眾靠近幾公尺、跟著軌道轉幾度

import * as THREE from 'three';
import type { MechVec3 } from '../mechanisms/model';

/** 最多 1 位小數、整數不帶 .0 */
export function fmt1(n: number): string {
  const r = Math.round(n * 10) / 10;
  return String(Object.is(r, -0) ? 0 : r);
}

/** 轉幾圈：整半圈 → 半圈 / 1 圈 / 1.5 圈…；超過一圈但不是整半圈 → 約幾圈；一圈以內又不是半圈 → null */
export function turnsText(absDeg: number): string | null {
  const a = Math.abs(absDeg);
  if (a < 0.5) return null;
  const halves = a / 180;
  const k = Math.round(halves);
  if (k >= 1 && Math.abs(halves - k) < 0.005) return k === 1 ? '半圈' : `${fmt1(k / 2)} 圈`;
  if (a > 360) return `約 ${(a / 360).toFixed(1)} 圈`;
  return null;
}

/**
 * 從上一個 cue 轉過來的字。prevName = null → 第一個 cue（從預設位置）。
 * axisY = 轉軸（場景座標）的 y：朝上時值變大 = 從上面看逆時針（右手定則）；|axisY| < 0.7 → 轉軸不是垂直，不講方向。
 */
export function spinFromPrevText(o: { prevName: string | null; prev: number; cur: number; axisY: number }): string {
  const from = o.prevName === null ? '預設位置' : `上一個 cue（${o.prevName}）`;
  const d = o.cur - o.prev;
  const ad = Math.abs(d);
  if (ad < 0.5) return `跟${from}一樣，不轉`;
  const turns = turnsText(ad);
  const tail = `轉 ${fmt1(ad)}°${turns ? `（${turns}）` : ''}`;
  if (Math.abs(o.axisY) < 0.7) return `從${from}轉過來：${tail}`;
  const ccw = d * Math.sign(o.axisY) > 0;
  return `從${from}轉過來：從上面看${ccw ? '逆時針' : '順時針'}${tail}`;
}

export interface ArcReadout {
  /** 往觀眾靠近幾公尺（負的 = 往後退） */
  towardM: number;
  /** 跟著軌道轉了幾度（正的） */
  turnDeg: number;
}

/**
 * 沿弧形軌道走到 value 公尺時，物件中心跟值 0 比移動了多少（只算這一個機關；圓心 / 轉軸 / 中心都是場景座標）。
 * 角度 = 值 ÷ 半徑（弧度，跟 pose.ts 一樣）；距離用 sceneToMeters 換成公尺。
 */
export function arcReadout(o: {
  pivot: MechVec3; axis: MechVec3; radiusM: number; center: MechVec3; front: MechVec3; sceneToMeters: number; value: number;
}): ArcReadout {
  if (!(o.radiusM > 0) || !Number.isFinite(o.value)) return { towardM: 0, turnDeg: 0 };
  const axis = new THREE.Vector3(o.axis.x, o.axis.y, o.axis.z);
  if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0);
  axis.normalize();
  const theta = o.value / o.radiusM;
  const rel = new THREE.Vector3(o.center.x - o.pivot.x, o.center.y - o.pivot.y, o.center.z - o.pivot.z);
  rel.addScaledVector(axis, -rel.dot(axis));
  const moved = rel.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, theta)).sub(rel);
  const front = new THREE.Vector3(o.front.x, 0, o.front.z);
  if (front.lengthSq() < 1e-12) front.set(0, 0, 1);
  front.normalize();
  const k = o.sceneToMeters > 0 && Number.isFinite(o.sceneToMeters) ? o.sceneToMeters : 1;
  return { towardM: moved.dot(front) * k, turnDeg: Math.abs(THREE.MathUtils.radToDeg(theta)) };
}

export function arcReadoutText(r: ArcReadout): string {
  const still = Math.abs(r.towardM) < 0.05;
  if (still && r.turnDeg < 0.5) return '在原本的位置';
  const move = still ? '前後不變' : r.towardM > 0 ? `往觀眾靠近 ${fmt1(r.towardM)} 公尺` : `往後退 ${fmt1(-r.towardM)} 公尺`;
  return `跟原本的位置比：${move}、轉 ${fmt1(r.turnDeg)} 度`;
}
