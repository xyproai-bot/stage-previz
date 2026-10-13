import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildLedEmitters } from './ledEmitters';

function planeMesh(w = 2, h = 1) {
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial());
}

describe('buildLedEmitters', () => {
  it('平面 → 一盞燈，尺寸 / 中心 / 法線 / UV 正確', () => {
    const [e, ...rest] = buildLedEmitters(planeMesh(2, 1));
    expect(rest).toHaveLength(0);
    expect(e.width).toBeCloseTo(2);
    expect(e.height).toBeCloseTo(1);
    expect(e.center.length()).toBeCloseTo(0);
    expect(e.normal.z).toBeCloseTo(1);
    expect(e.heightAxis.y).toBeCloseTo(1);
    expect(e.uv).not.toBeNull();
    expect(e.uv!.u0).toBeCloseTo(0);
    expect(e.uv!.u1).toBeCloseTo(1);
    expect(e.uv!.v0).toBeCloseTo(0);
    expect(e.uv!.v1).toBeCloseTo(1);
  });

  it('L 形兩面 → 兩盞燈，法線各自朝外', () => {
    const root = new THREE.Group();
    const a = planeMesh();
    const b = planeMesh();
    b.rotation.y = Math.PI / 2;
    b.position.set(1, 0, -1);
    root.add(a, b);
    const ems = buildLedEmitters(root);
    expect(ems).toHaveLength(2);
    const normals = ems.map(e => e.normal);
    expect(normals.some(n => n.z > 0.99)).toBe(true);
    expect(normals.some(n => n.x > 0.99)).toBe(true);
  });

  it('半圓柱 → 切成幾段，數量不超過 maxPerObject', () => {
    const geo = new THREE.CylinderGeometry(1, 1, 2, 16, 1, true, 0, Math.PI);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    const many = buildLedEmitters(mesh, { maxPerObject: 10 });
    expect(many.length).toBeGreaterThanOrEqual(3);
    for (const e of many) expect(Math.abs(e.normal.y)).toBeLessThan(0.01);
    expect(buildLedEmitters(mesh, { maxPerObject: 2 })).toHaveLength(2);
  });

  it('結果在 root 的 local 座標（root 自己轉不影響）', () => {
    const root = new THREE.Group();
    root.rotation.y = 1;
    root.position.set(5, 0, 0);
    const child = planeMesh();
    child.rotation.y = Math.PI / 2;
    root.add(child);
    const [e] = buildLedEmitters(root);
    expect(e.normal.x).toBeCloseTo(1);
    expect(e.center.length()).toBeCloseTo(0);
  });

  it('朝下的面板 → 法線向下，高度軸改用 Z', () => {
    // 結果是 root 的 local 座標 → 旋轉要放在子物件上
    const root = new THREE.Group();
    const m = planeMesh();
    m.rotation.x = Math.PI / 2;
    root.add(m);
    const [e] = buildLedEmitters(root);
    expect(e.normal.y).toBeCloseTo(-1);
    expect(Math.abs(e.heightAxis.z)).toBeCloseTo(1);
  });

  it('UV 在負值 → 換算回 0~1 範圍', () => {
    const m = planeMesh();
    const uv = m.geometry.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * 0.45 - 0.45);
    const [e] = buildLedEmitters(m);
    expect(e.uv!.v0).toBeCloseTo(0.55);
    expect(e.uv!.v1).toBeCloseTo(1);
  });
});
