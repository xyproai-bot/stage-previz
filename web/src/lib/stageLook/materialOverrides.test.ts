import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyMaterialSettings, captureOriginal, hasMirrorFloor, normalizeMaterialOverrides } from './materialOverrides';

describe('normalizeMaterialOverrides', () => {
  it('壞資料 → 空物件', () => {
    expect(normalizeMaterialOverrides(null)).toEqual({});
    expect(normalizeMaterialOverrides([1, 2])).toEqual({});
  });
  it('夾範圍、丟掉不認識的欄位與壞顏色、空的覆寫不留', () => {
    const o = normalizeMaterialOverrides({
      霧銀: { roughness: 2, metalness: -1, envIntensity: 9, opacity: 0.5, color: '#AABBCC', junk: 1 },
      壞顏色: { color: 'red' },
      地板: { mirrorFloor: true },
    });
    expect(o.霧銀).toEqual({ roughness: 1, metalness: 0, envIntensity: 5, opacity: 0.5, color: '#aabbcc' });
    expect(o.壞顏色).toBeUndefined();
    expect(o.地板).toEqual({ mirrorFloor: true });
  });
});

describe('captureOriginal / applyMaterialSettings', () => {
  it('第一次記下原值，之後不會被覆寫', () => {
    const m = new THREE.MeshStandardMaterial({ color: 0x336699, roughness: 0.2, metalness: 0.8 });
    const o1 = captureOriginal(m);
    m.roughness = 0.9;
    const o2 = captureOriginal(m);
    expect(o2).toBe(o1);
    expect(o1.roughness).toBeCloseTo(0.2);
    expect(o1.color).toBe('336699');
  });
  it('沒覆寫 → 回到原值', () => {
    const m = new THREE.MeshStandardMaterial({ color: 0x336699, roughness: 0.2, metalness: 0.8 });
    captureOriginal(m);
    m.roughness = 0.9; m.color.set('#ff0000');
    applyMaterialSettings(m);
    expect(m.roughness).toBeCloseTo(0.2);
    expect(m.color.getHexString()).toBe('336699');
  });
  it('名稱覆寫蓋原值；單一物件設定再蓋名稱覆寫', () => {
    const m = new THREE.MeshStandardMaterial({ color: 0x336699, roughness: 0.2, metalness: 0.8 });
    captureOriginal(m);
    applyMaterialSettings(m, { roughness: 0.5, color: '#00ff00', opacity: 0.4 }, { roughness: 0.7 });
    expect(m.roughness).toBeCloseTo(0.7);
    expect(m.color.getHexString()).toBe('00ff00');
    expect(m.opacity).toBeCloseTo(0.4);
    expect(m.transparent).toBe(true);
    expect(m.metalness).toBeCloseTo(0.8);
  });
  it('hasMirrorFloor', () => {
    expect(hasMirrorFloor({ a: { roughness: 1 } })).toBe(false);
    expect(hasMirrorFloor({ a: { mirrorFloor: true } })).toBe(true);
  });
});
