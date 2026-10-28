// 拖把手的數學：滑鼠的射線 → 線上哪一點 / 平面上的角度；挑把手用螢幕上的距離（px）。

import * as THREE from 'three';

const tw0 = new THREE.Vector3();
const tu = new THREE.Vector3();

/**
 * 射線（rayO + s·rayD）最靠近直線（lineO + t·û，û = lineD 單位化）的那一點的 t（用單位長度量）。
 * 兩條幾乎平行（夾角 < 約 6°）→ null（呼叫的人改用螢幕方向）。
 */
export function closestParamOnLine(rayO: THREE.Vector3, rayD: THREE.Vector3, lineO: THREE.Vector3, lineD: THREE.Vector3): number | null {
  const u = tu.copy(lineD);
  if (u.lengthSq() < 1e-18) return null;
  u.normalize();
  const vLen2 = rayD.lengthSq();
  if (vLen2 < 1e-18) return null;
  const w0 = tw0.subVectors(lineO, rayO);
  const b = u.dot(rayD), c = vLen2, d = u.dot(w0), e = rayD.dot(w0);
  const denom = c - b * b;   // a = 1
  if (denom / c < 0.01) return null;
  return (b * e - c * d) / denom;
}

const tp = new THREE.Vector3();
const tr = new THREE.Vector3();
const tx = new THREE.Vector3();

/**
 * 射線打到平面（過 center、法向 normal）上的點，繞 normal 從 ref 轉過去的角度（弧度，右手定則，(−π, π]）。
 * 側著看（射線跟平面夾角太小）、平面在鏡頭後面、正好打在中心 → null。
 */
export function angleOnPlane(rayO: THREE.Vector3, rayD: THREE.Vector3, center: THREE.Vector3, normal: THREE.Vector3, ref: THREE.Vector3): number | null {
  const n = normal.clone().normalize();
  const dir = rayD.clone().normalize();
  const denom = n.dot(dir);
  if (Math.abs(denom) < 0.08) return null;
  const s = n.dot(tp.subVectors(center, rayO)) / denom;
  if (!(s > 0)) return null;
  const p = tp.copy(rayO).addScaledVector(dir, s).sub(center);
  p.addScaledVector(n, -p.dot(n));
  if (p.lengthSq() < 1e-18) return null;
  const r = tr.copy(ref).addScaledVector(n, -ref.dot(n));
  if (r.lengthSq() < 1e-18) return null;
  r.normalize();
  return Math.atan2(n.dot(tx.crossVectors(r, p)), r.dot(p));
}

/** 角度收到 (−π, π] */
export function wrapPi(a: number): number {
  let x = a % (2 * Math.PI);
  if (x <= -Math.PI) x += 2 * Math.PI;
  else if (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

export interface P2 { x: number; y: number }

export function distToSegment2D(p: P2, a: P2, b: P2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 點到折線的距離；closed = 頭尾相連（圈）；沒有點 → Infinity；只有一點 → 到那一點 */
export function distToPolyline2D(p: P2, pts: P2[], closed: boolean): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y);
  let best = Infinity;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const d = distToSegment2D(p, pts[i], pts[(i + 1) % pts.length]);
    if (d < best) best = d;
  }
  return best;
}
