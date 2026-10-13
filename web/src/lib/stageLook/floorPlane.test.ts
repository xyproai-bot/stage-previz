import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { detectFloorPlane } from './floorPlane';

function floor(w: number, d: number, y: number) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial());
  m.rotation.x = -Math.PI / 2; // 朝上
  m.position.y = y;
  m.updateMatrixWorld(true);
  return m;
}

describe('detectFloorPlane', () => {
  it('單一朝上平面 → 它的高度', () => {
    const p = detectFloorPlane([floor(4, 4, 2)]);
    expect(p).not.toBeNull();
    expect(p!.y).toBeCloseTo(2);
    expect(p!.area).toBeCloseTo(16);
  });

  it('多個平面 → 面積最大的那個', () => {
    const p = detectFloorPlane([floor(10, 10, 0), floor(2, 2, 1)]);
    expect(p!.y).toBeCloseTo(0);
  });

  it('只有牆 / 朝下的天花板 → null', () => {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshStandardMaterial());
    const ceiling = floor(4, 4, 3);
    ceiling.rotation.x = Math.PI / 2; // 朝下
    ceiling.updateMatrixWorld(true);
    expect(detectFloorPlane([wall, ceiling])).toBeNull();
  });
});
