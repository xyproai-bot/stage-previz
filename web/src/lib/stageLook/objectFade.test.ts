import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { endObjectFade, getObjectOpacity, setObjectOpacity, suspendObjectFade } from './objectFade';
import { applyLedSurface, updateLedSurface, type LedSurfaceUniforms } from './ledSurface';

// 兩個物件共用同一個 C4D 材質（模型 clone 出來就是這樣）
function makePair() {
  const shared = new THREE.MeshStandardMaterial({ color: 0x336699 });
  shared.name = 'C4D 材質';
  const a = new THREE.Group();
  const meshA = new THREE.Mesh(new THREE.BoxGeometry(), shared);
  a.add(meshA);
  const b = new THREE.Group();
  const meshB = new THREE.Mesh(new THREE.BoxGeometry(), shared);
  b.add(meshB);
  return { shared, a, meshA, b, meshB };
}

const matOf = (m: THREE.Mesh) => m.material as THREE.MeshStandardMaterial;

describe('setObjectOpacity', () => {
  it('淡到一半：只有這個物件換成自己的半透明材質，共用的材質和別的物件不受影響', () => {
    const { shared, a, meshA, meshB } = makePair();
    setObjectOpacity(a, 0.5);
    expect(matOf(meshA)).not.toBe(shared);
    expect(matOf(meshA).opacity).toBe(0.5);
    expect(matOf(meshA).transparent).toBe(true);
    expect(matOf(meshA).name).toBe('C4D 材質');
    expect(matOf(meshB)).toBe(shared);
    expect(shared.opacity).toBe(1);
    expect(shared.transparent).toBe(false);
    expect(a.visible).toBe(true);
    expect(getObjectOpacity(a)).toBe(0.5);
  });

  it('材質本來就半透明（材質面板調過）→ 照比例再淡', () => {
    const { shared, a, meshA } = makePair();
    shared.opacity = 0.8;
    shared.transparent = true;
    setObjectOpacity(a, 0.5);
    expect(matOf(meshA).opacity).toBeCloseTo(0.4);
  });

  it('同一個淡入過程中每幀更新 → 沿用同一份複本（不會每幀重做材質）', () => {
    const { a, meshA } = makePair();
    setObjectOpacity(a, 0.2);
    const copy = matOf(meshA);
    setObjectOpacity(a, 0.6);
    expect(matOf(meshA)).toBe(copy);
    expect(copy.opacity).toBeCloseTo(0.6);
  });

  it('淡完（1）→ 換回原本共用的材質、複本丟掉、不留半透明', () => {
    const { shared, a, meshA } = makePair();
    setObjectOpacity(a, 0.5);
    const copy = matOf(meshA);
    let disposed = false;
    copy.addEventListener('dispose', () => { disposed = true; });
    setObjectOpacity(a, 1);
    expect(matOf(meshA)).toBe(shared);
    expect(disposed).toBe(true);
    expect(a.visible).toBe(true);
    expect(getObjectOpacity(a)).toBe(1);
  });

  it('淡出完（0）→ 換回原本材質並隱藏', () => {
    const { shared, a, meshA } = makePair();
    setObjectOpacity(a, 0.3);
    setObjectOpacity(a, 0);
    expect(matOf(meshA)).toBe(shared);
    expect(a.visible).toBe(false);
    expect(getObjectOpacity(a)).toBe(0);
  });

  it('沒在淡的物件：看得到 = 1、藏起來 = 0', () => {
    const { a, b } = makePair();
    b.visible = false;
    expect(getObjectOpacity(a)).toBe(1);
    expect(getObjectOpacity(b)).toBe(0);
  });

  it('LED 面板的像素格 shader 跟著複本走（同一組 uniforms、同一個 shader key）', () => {
    const { shared, a, meshA } = makePair();
    applyLedSurface(shared);
    setObjectOpacity(a, 0.5);
    const copy = matOf(meshA);
    expect(copy.onBeforeCompile).toBe(shared.onBeforeCompile);
    expect(copy.customProgramCacheKey()).toBe(shared.customProgramCacheKey());
    expect(copy.userData.ledSurface).toBe(shared.userData.ledSurface);
    // 每幀更新原本材質的 LED 參數 → 複本一起變
    updateLedSurface(shared, { on: true, gridStrength: 0.7 });
    const u = copy.userData.ledSurface as LedSurfaceUniforms;
    expect(u.uLedOn.value).toBe(1);
    expect(u.uLedGridStrength.value).toBe(0.7);
  });
});

describe('suspendObjectFade（材質設定要改時先換回原本的，改完下一幀再接著淡）', () => {
  it('暫停 → 原本材質回到物件上；下一次設透明度 → 同一份複本跟上原本材質的新設定', () => {
    const { shared, a, meshA } = makePair();
    setObjectOpacity(a, 0.5);
    const copy = matOf(meshA);
    suspendObjectFade(a);
    expect(matOf(meshA)).toBe(shared);
    shared.color.setHex(0xff0000);
    shared.emissiveIntensity = 2;
    setObjectOpacity(a, 0.4);
    expect(matOf(meshA)).toBe(copy);
    expect(copy.color.getHex()).toBe(0xff0000);
    expect(copy.emissiveIntensity).toBe(2);
    expect(copy.opacity).toBeCloseTo(0.4);
    expect(copy.transparent).toBe(true);
  });
});

describe('endObjectFade', () => {
  it('物件要被移除時：換回原本材質、複本丟掉', () => {
    const { shared, a, meshA } = makePair();
    setObjectOpacity(a, 0.5);
    const copy = matOf(meshA);
    let disposed = false;
    copy.addEventListener('dispose', () => { disposed = true; });
    endObjectFade(a);
    expect(matOf(meshA)).toBe(shared);
    expect(disposed).toBe(true);
  });
});
