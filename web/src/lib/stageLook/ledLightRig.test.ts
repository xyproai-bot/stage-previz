import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { LED_LIGHT_BASE_INTENSITY, LedLightRig, emitterLightParams } from './ledLightRig';
import { buildLedEmitters } from './ledEmitters';

const white = { brightness: 1, castStrength: 1, tint: new THREE.Color(1, 1, 1) };

describe('emitterLightParams', () => {
  it('全黑 → 不發光', () => {
    expect(emitterLightParams([0, 0, 0], white, 1).intensity).toBe(0);
  });
  it('顏色正規化到最亮的通道，強度跟著最亮通道', () => {
    const { color, intensity } = emitterLightParams([0.5, 0.25, 0], white, 1);
    expect(color.r).toBeCloseTo(1);
    expect(color.g).toBeCloseTo(0.5);
    expect(color.b).toBeCloseTo(0);
    expect(intensity).toBeCloseTo(0.5 * LED_LIGHT_BASE_INTENSITY);
  });
  it('tint / 亮度 / 照明強度會乘上去', () => {
    const red = { brightness: 2, castStrength: 0.5, tint: new THREE.Color(1, 0, 0) };
    const { color, intensity } = emitterLightParams([0.5, 0.5, 0.5], red, 3);
    expect(color.g).toBeCloseTo(0);
    expect(intensity).toBeCloseTo(0.5 * 2 * 0.5 * 3 * LED_LIGHT_BASE_INTENSITY);
  });
});

describe('LedLightRig', () => {
  function setup() {
    const scene = new THREE.Scene();
    const rig = new LedLightRig(scene);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(2, 1), new THREE.MeshStandardMaterial());
    panel.position.set(3, 1, 0);
    scene.add(panel);
    return { scene, rig, panel };
  }

  it('每個發光面一盞燈，位置跟著物件走', () => {
    const { scene, rig, panel } = setup();
    rig.setObjectEmitters('a', buildLedEmitters(panel));
    rig.setEnabled(true);
    rig.updateColors(() => [1, 1, 1], () => white, 1);
    rig.updatePoses(new Map([['a', panel]]));
    const lights = scene.children.filter(c => (c as THREE.RectAreaLight).isRectAreaLight) as THREE.RectAreaLight[];
    expect(lights).toHaveLength(1);
    expect(lights[0].position.x).toBeCloseTo(3, 1);
    expect(lights[0].width).toBeCloseTo(2);
    expect(lights[0].visible).toBe(true);
  });

  it('超過上限時只亮面積大的', () => {
    const { rig, panel } = setup();
    const small = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), new THREE.MeshStandardMaterial());
    rig.setObjectEmitters('big', buildLedEmitters(panel));
    rig.setObjectEmitters('small', buildLedEmitters(small));
    rig.setMaxLights(1);
    rig.setEnabled(true);
    rig.updateColors(() => [1, 1, 1], () => white, 1);
    rig.updatePoses(new Map([['big', panel], ['small', small]]));
    expect(rig.lightCount).toBe(1);
  });

  it('retainObjects 會移掉不存在的物件的燈', () => {
    const { scene, rig, panel } = setup();
    rig.setObjectEmitters('a', buildLedEmitters(panel));
    rig.retainObjects(new Set());
    expect(scene.children.some(c => (c as THREE.RectAreaLight).isRectAreaLight)).toBe(false);
  });

  it('updateColors 用取到的顏色設燈色', () => {
    const { scene, rig, panel } = setup();
    rig.setObjectEmitters('a', buildLedEmitters(panel));
    rig.updateColors(() => [0, 0.5, 0], () => white, 1);
    const light = scene.children.find(c => (c as THREE.RectAreaLight).isRectAreaLight) as THREE.RectAreaLight;
    expect(light.color.g).toBeCloseTo(1);
    expect(light.color.r).toBeCloseTo(0);
    expect(light.intensity).toBeCloseTo(0.5 * LED_LIGHT_BASE_INTENSITY);
  });

  it('關閉時燈全部隱藏', () => {
    const { rig, panel } = setup();
    rig.setObjectEmitters('a', buildLedEmitters(panel));
    rig.setEnabled(false);
    rig.updatePoses(new Map([['a', panel]]));
    expect(rig.lightCount).toBe(0);
  });
});
