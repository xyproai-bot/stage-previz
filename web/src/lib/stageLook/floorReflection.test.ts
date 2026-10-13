import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyFloorReflection, computeMirrorCamera, createFloorReflectionUniforms, patchFloorShader, setFloorReflectionFor } from './floorReflection';

describe('patchFloorShader', () => {
  it('vertex 加世界座標 varying、fragment 在 aomap 前加倒影', () => {
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: 'void main() {\n#include <worldpos_vertex>\n}',
      fragmentShader: 'void main() {\n#include <lights_fragment_end>\n#include <aomap_fragment>\n}',
    };
    patchFloorShader(shader, createFloorReflectionUniforms());
    expect(shader.vertexShader).toContain('vReflWorldPos =');
    const refl = shader.fragmentShader.indexOf('uReflOn > 0.5');
    expect(refl).toBeGreaterThan(shader.fragmentShader.indexOf('#include <lights_fragment_end>'));
    expect(refl).toBeLessThan(shader.fragmentShader.indexOf('#include <aomap_fragment>'));
    expect(shader.uniforms.uReflMap).toBeDefined();
  });
});

describe('applyFloorReflection', () => {
  it('每個材質有自己的倒影開關', () => {
    const m = new THREE.MeshStandardMaterial();
    applyFloorReflection(m, createFloorReflectionUniforms());
    expect(m.userData.reflMaterialOn.value).toBe(1);
    setFloorReflectionFor(m, false);
    expect(m.userData.reflMaterialOn.value).toBe(0);
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: '#include <worldpos_vertex>',
      fragmentShader: '#include <aomap_fragment>',
    };
    m.onBeforeCompile(shader as never, null as never);
    expect(shader.fragmentShader).toContain('uReflMaterialOn > 0.5');
    expect(shader.uniforms.uReflMaterialOn).toBe(m.userData.reflMaterialOn);
  });

  it('冪等、cache key 固定', () => {
    const m = new THREE.MeshStandardMaterial();
    const u = createFloorReflectionUniforms();
    applyFloorReflection(m, u);
    const first = m.onBeforeCompile;
    applyFloorReflection(m, u);
    expect(m.onBeforeCompile).toBe(first);
    expect(m.customProgramCacheKey()).toBe('floor-refl-v1');
  });
});

describe('computeMirrorCamera', () => {
  function cam(pos: [number, number, number], look: [number, number, number]) {
    const c = new THREE.PerspectiveCamera(50, 1.5, 0.1, 100);
    c.position.set(...pos);
    c.lookAt(...look);
    c.updateMatrixWorld();
    c.updateProjectionMatrix();
    return c;
  }

  it('鏡像相機在地板下方對稱的位置', () => {
    const c = cam([0, 5, 10], [0, 0, 0]);
    const v = new THREE.PerspectiveCamera();
    const tm = new THREE.Matrix4();
    expect(computeMirrorCamera(c, 1, v, tm)).toBe(true);
    expect(v.position.x).toBeCloseTo(0);
    expect(v.position.y).toBeCloseTo(-3);
    expect(v.position.z).toBeCloseTo(10);
  });

  it('地板上看到 Q 倒影的那一點，取樣到的正是 Q 在倒影圖裡的位置', () => {
    const c = cam([2, 4, 8], [0, 0, 0]);
    const v = new THREE.PerspectiveCamera();
    const tm = new THREE.Matrix4();
    computeMirrorCamera(c, 0, v, tm);
    // 地板上方的點 Q，鏡像點 Q'；主相機往 Q' 看的視線跟地板交點 P = 看到 Q 倒影的位置
    const q = new THREE.Vector3(0.5, 1.5, -2);
    const qMirror = new THREE.Vector3(q.x, -q.y, q.z);
    const t = c.position.y / (c.position.y - qMirror.y);
    const p = c.position.clone().lerp(qMirror, t);
    expect(p.y).toBeCloseTo(0);
    const uv = (w: THREE.Vector3) => {
      const h = new THREE.Vector4(w.x, w.y, w.z, 1).applyMatrix4(tm);
      return [h.x / h.w, h.y / h.w];
    };
    const [pu, pv] = uv(p);
    const [qu, qv] = uv(q);
    expect(pu).toBeCloseTo(qu, 4);
    expect(pv).toBeCloseTo(qv, 4);
  });

  it('相機在地板下面 → 不畫', () => {
    const c = cam([0, -2, 5], [0, 0, 0]);
    expect(computeMirrorCamera(c, 0, new THREE.PerspectiveCamera(), new THREE.Matrix4())).toBe(false);
  });
});
