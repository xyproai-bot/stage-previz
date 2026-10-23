import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  stageFrontDirection, fitDistance, computeFrontView, computePresetView, mainLedRoots, countBlockedSamples, FOH_EYE_HEIGHT,
} from './stageCamera';

/** 一片朝向 dir 的 LED（PlaneGeometry 預設朝 +Z） */
function ledFacing(dir: THREE.Vector3, at = new THREE.Vector3()) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(4, 2), new THREE.MeshBasicMaterial());
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
  m.position.copy(at);
  m.updateMatrixWorld(true);
  return m;
}

/** 點有沒有全部在畫面裡（透視投影後 -1..1） */
function allInView(points: THREE.Vector3[], pos: THREE.Vector3, target: THREE.Vector3, fov: number, aspect: number) {
  const cam = new THREE.PerspectiveCamera(fov, aspect, 0.01, 1000);
  cam.position.copy(pos);
  cam.lookAt(target);
  cam.updateMatrixWorld(true);
  return points.every(p => {
    const v = p.clone().project(cam);
    return Math.abs(v.x) <= 1.0001 && Math.abs(v.y) <= 1.0001 && v.z < 1;
  });
}

describe('stageFrontDirection', () => {
  it('LED 面朝 +X → 正面是 +X（水平）', () => {
    const d = stageFrontDirection([ledFacing(new THREE.Vector3(1, 0, 0))]);
    expect(d.x).toBeCloseTo(1);
    expect(d.y).toBeCloseTo(0);
    expect(d.z).toBeCloseTo(0);
  });
  it('有點往下斜的 LED → 只取水平方向', () => {
    const d = stageFrontDirection([ledFacing(new THREE.Vector3(0, -0.5, -1))]);
    expect(d.y).toBe(0);
    expect(d.z).toBeCloseTo(-1);
  });
  it('左右兩片斜對中間的 LED → 平均朝向中間', () => {
    const d = stageFrontDirection([ledFacing(new THREE.Vector3(1, 0, 1)), ledFacing(new THREE.Vector3(-1, 0, 1))]);
    expect(d.z).toBeCloseTo(1);
    expect(d.x).toBeCloseTo(0);
  });
  it('沒有 LED → 預設 +Z', () => {
    expect(stageFrontDirection([]).toArray()).toEqual([0, 0, 1]);
  });
});

describe('fitDistance', () => {
  const pts = [
    new THREE.Vector3(-10, 0, -2), new THREE.Vector3(10, 0, -2),
    new THREE.Vector3(-10, 6, 2), new THREE.Vector3(10, 6, 2),
    new THREE.Vector3(-14, 9, 0), new THREE.Vector3(14, 9, 0),  // 兩側高掛的螢幕
  ];
  const target = new THREE.Vector3(0, 4.5, 0);
  const dir = new THREE.Vector3(0, 0, 1);
  it('退這麼遠剛好全部入鏡，再近一點就有東西出去', () => {
    const d = fitDistance(pts, target, dir, 50, 16 / 9, 1);
    const at = (dist: number) => target.clone().addScaledVector(dir, dist);
    expect(allInView(pts, at(d), target, 50, 16 / 9)).toBe(true);
    expect(allInView(pts, at(d * 0.95), target, 50, 16 / 9)).toBe(false);
  });
  it('畫面越窄要退越遠', () => {
    expect(fitDistance(pts, target, dir, 50, 1, 1)).toBeGreaterThan(fitDistance(pts, target, dir, 50, 16 / 9, 1));
  });
});

describe('computeFrontView', () => {
  it('從 LED 正面、稍微高一點看，LED 全部在畫面裡', () => {
    const led = ledFacing(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 3, 0));
    const floor = new THREE.Mesh(new THREE.BoxGeometry(12, 0.5, 20), new THREE.MeshBasicMaterial());
    floor.updateMatrixWorld(true);
    const { position, target } = computeFrontView([led, floor], [led], 50, 16 / 9);
    expect(position.x).toBeGreaterThan(target.x);           // 在觀眾那一側（+X）
    expect(position.y).toBeGreaterThan(target.y);           // 稍微高一點
    expect(Math.abs(position.z - target.z)).toBeLessThan(1e-6);  // 正對中間，不斜
    const corners: THREE.Vector3[] = [];
    for (const m of [led]) {
      m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) corners.push(new THREE.Vector3(x, y, z));
    }
    expect(allInView(corners, position, target, 50, 16 / 9)).toBe(true);
  });
  it('以 LED 框：很大的地板不會讓鏡頭退很遠', () => {
    const led = ledFacing(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 3, 0));
    const hugeFloor = new THREE.Mesh(new THREE.BoxGeometry(200, 0.1, 200), new THREE.MeshBasicMaterial());
    const withFloor = computeFrontView([led, hugeFloor], [led], 50, 16 / 9);
    const ledOnly = computeFrontView([led], [led], 50, 16 / 9);
    expect(withFloor.position.distanceTo(ledOnly.position)).toBeLessThan(1e-6);
  });
});

describe('computePresetView', () => {
  it('front 與 computeFrontView 相同', () => {
    const led = ledFacing(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 3, 0));
    const vPreset = computePresetView('front', [led], [led], 50, 16 / 9);
    const vFront = computeFrontView([led], [led], 50, 16 / 9);
    expect(vPreset.position.distanceTo(vFront.position)).toBeLessThan(1e-6);
    expect(vPreset.target.distanceTo(vFront.target)).toBeLessThan(1e-6);
  });

  it('foh（控台）比正面全景退得更遠', () => {
    const led = ledFacing(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 3, 0));
    const front = computePresetView('front', [led], [led], 50, 16 / 9);
    const foh = computePresetView('foh', [led], [led], 50, 16 / 9);
    const distFront = front.position.distanceTo(front.target);
    const distFoh = foh.position.distanceTo(foh.target);
    expect(distFoh).toBeGreaterThan(distFront);
  });

  it('stands（二樓看台）俯角更高（Y 座標高於正面）', () => {
    const led = ledFacing(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 3, 0));
    const front = computePresetView('front', [led], [led], 50, 16 / 9);
    const stands = computePresetView('stands', [led], [led], 50, 16 / 9);
    expect(stands.position.y).toBeGreaterThan(front.position.y);
  });

  it('vip（特區）比正面全景更近且視角更低', () => {
    const led = ledFacing(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 3, 0));
    const front = computePresetView('front', [led], [led], 50, 16 / 9);
    const vip = computePresetView('vip', [led], [led], 50, 16 / 9);
    const distFront = front.position.distanceTo(front.target);
    const distVip = vip.position.distanceTo(vip.target);
    expect(distVip).toBeLessThan(distFront);
  });
});

describe('面向演出者的 LED（題詞）', () => {
  /** 主 LED 面向 +Z（觀眾在 +Z）、地板高度 0；題詞面向 -Z，懸吊在觀眾席上方 */
  function scene(promptZ: number, promptY: number) {
    const main = ledFacing(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 4, 0));
    main.scale.set(5, 5, 1);  // 20m x 10m 的主螢幕（比題詞大）
    main.updateMatrixWorld(true);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), new THREE.MeshBasicMaterial());
    floor.position.set(0, 0.1, 0);
    floor.updateMatrixWorld(true);
    const prompt = new THREE.Mesh(new THREE.PlaneGeometry(10, 2), new THREE.MeshBasicMaterial());
    prompt.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1));
    prompt.position.set(0, promptY, promptZ);
    prompt.updateMatrixWorld(true);
    return { main, floor, prompt };
  }

  it('mainLedRoots 排除面向演出者的 LED，其他留著', () => {
    const { main, prompt } = scene(30, 6);
    const side = ledFacing(new THREE.Vector3(1, 0, 0), new THREE.Vector3(-14, 3, 0));  // 側面的不排除
    expect(mainLedRoots([main, prompt, side])).toEqual([main, side]);
    expect(mainLedRoots([prompt])).toEqual([prompt]);
  });

  it('題詞不影響看向點和正面方向', () => {
    const { main, floor, prompt } = scene(30, 6);
    for (const preset of ['front', 'foh', 'stands', 'vip'] as const) {
      const a = computePresetView(preset, [main, floor, prompt], [main, prompt], 50, 16 / 9);
      const b = computePresetView(preset, [main, floor], [main], 50, 16 / 9);
      expect(a.target.distanceTo(b.target)).toBeLessThan(1e-6);
      expect(a.position.z).toBeGreaterThan(a.target.z);  // 還是在觀眾那一側
      expect(a.position.distanceTo(b.position)).toBeLessThan(1e-6);
    }
  });

  it('控台高度 = 地面 + 1.7m', () => {
    const { main, floor, prompt } = scene(30, 6);
    const v = computePresetView('foh', [main, floor, prompt], [main, prompt], 50, 16 / 9);
    expect(v.position.y).toBeCloseTo(0 + FOH_EYE_HEIGHT, 1);
    expect(Math.abs(v.position.x - v.target.x)).toBeLessThan(1e-6);  // 正對中間
  });

  it('射線沒被題詞擋住（題詞在鏡頭後面）', () => {
    const { main, floor, prompt } = scene(60, 5);
    const v = computePresetView('foh', [main, floor, prompt], [main, prompt], 50, 16 / 9);
    expect(countBlockedSamples(v.position, [main], [prompt])).toBe(0);
  });

  it('題詞掛在鏡頭和舞台中間時，會試著微調，最後不會比一開始更糟', () => {
    // 先算沒有題詞的控台位置，再把題詞掛在中間一點、略高於眼睛
    const base = scene(0, 0);
    const v0 = computePresetView('foh', [base.main, base.floor], [base.main], 50, 16 / 9);
    const z = (v0.position.z + v0.target.z) / 2;
    const { main, floor, prompt } = scene(z, FOH_EYE_HEIGHT + 0.5);
    const blockedAtStart = countBlockedSamples(v0.position, [main], [prompt]);
    expect(blockedAtStart).toBeGreaterThan(0);
    const v = computePresetView('foh', [main, floor, prompt], [main, prompt], 50, 16 / 9);
    expect(countBlockedSamples(v.position, [main], [prompt])).toBeLessThanOrEqual(blockedAtStart);
    expect(v.position.y).toBeGreaterThanOrEqual(0.8 + 0.2 - 1e-6);  // 不會鑽進地板
  });
});
