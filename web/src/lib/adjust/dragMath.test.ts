import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { angleOnPlane, closestParamOnLine, distToPolyline2D, distToSegment2D, wrapPi } from './dragMath';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('closestParamOnLine：滑鼠的射線最靠近線上哪一點', () => {
  it('從正面看一條左右的線：射線打在 x = 3 → t = 3', () => {
    const t = closestParamOnLine(V(3, 1, 10), V(0, 0, -1), V(0, 1, 0), V(1, 0, 0));
    expect(t).toBeCloseTo(3, 9);
  });
  it('線的方向不是單位長度也照算（t 用單位長度量）', () => {
    const t = closestParamOnLine(V(0, 5, 10), V(0, 0, -1), V(0, 0, 0), V(0, 2, 0));
    expect(t).toBeCloseTo(5, 9);
  });
  it('射線跟線幾乎平行 → null', () => {
    expect(closestParamOnLine(V(0, 0, 10), V(0, 0, -1), V(0, 0, 0), V(0, 0.01, 1))).toBeNull();
  });
});

describe('angleOnPlane：射線打到平面上，繞著中心的角度', () => {
  const center = V(0, 0, 0), up = V(0, 1, 0), ref = V(0, 0, 1);
  it('從上面往下看：打在 +x → +90°（繞 +y 從 +z 轉到 +x）', () => {
    const a = angleOnPlane(V(5, 10, 0), V(0, -1, 0), center, up, ref);
    expect(a).toBeCloseTo(Math.PI / 2, 9);
  });
  it('打在 −x → −90°；打在 +z → 0', () => {
    expect(angleOnPlane(V(-5, 10, 0), V(0, -1, 0), center, up, ref)).toBeCloseTo(-Math.PI / 2, 9);
    expect(angleOnPlane(V(0, 10, 5), V(0, -1, 0), center, up, ref)).toBeCloseTo(0, 9);
  });
  it('側著看（射線跟平面幾乎平行）→ null；平面在後面 → null', () => {
    expect(angleOnPlane(V(5, 0.1, 10), V(0, -0.01, -1).normalize(), center, up, ref)).toBeNull();
    expect(angleOnPlane(V(5, 10, 0), V(0, 1, 0), center, up, ref)).toBeNull();
  });
});

describe('wrapPi / 螢幕上的距離', () => {
  it('wrapPi 收到 (−π, π]', () => {
    expect(wrapPi(3 * Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 9);
    expect(wrapPi(-3 * Math.PI / 2)).toBeCloseTo(Math.PI / 2, 9);
    expect(wrapPi(Math.PI)).toBeCloseTo(Math.PI, 9);
  });
  it('點到線段：在線段旁邊 / 超過端點', () => {
    expect(distToSegment2D({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3, 9);
    expect(distToSegment2D({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5, 9);
    expect(distToSegment2D({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(Math.SQRT2, 9);
  });
  it('點到折線（可以頭尾相連）', () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(distToPolyline2D({ x: -2, y: 5 }, sq, false)).toBeCloseTo(Math.hypot(2, 5), 9);
    expect(distToPolyline2D({ x: -2, y: 5 }, sq, true)).toBeCloseTo(2, 9);
    expect(distToPolyline2D({ x: 0, y: 0 }, [], true)).toBe(Infinity);
  });
});
