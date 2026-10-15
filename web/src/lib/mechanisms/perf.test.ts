import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { compileRig, applyChain } from './pose';
import { buildMechanismTimeline, MechanismTweener } from './motion';
import type { Mechanism } from './model';

// 每一幀機關要花多少時間（設計：一幀 0.1 ms 以下）：20 個機關、每個 100 段移動、200 個物件
describe('每一幀的花費', () => {
  const mechs: Mechanism[] = Array.from({ length: 20 }, (_, i) => ({
    id: 'm' + i, name: 'm' + i, kind: i < 12 ? 'linear' : 'rotary',
    axis: i < 12 ? { x: 0, y: 1, z: 0 } : { x: 0, y: 1, z: 0 }, pivot: i < 12 ? null : { x: i, y: 0, z: 0 },
    travelMin: -180, travelMax: 180, defaultValue: 0, maxSpeed: i % 2 ? 5 : null, presets: [],
    parentId: i > 0 && i % 4 === 0 ? 'm' + (i - 1) : null,
    objectIds: Array.from({ length: 10 }, (_, k) => `o${i}_${k}`), consoleLabel: null, order: i, metadata: null, cueCount: 0, updatedAt: '',
  }));
  const cues = Array.from({ length: 101 }, (_, c) => ({ id: 'c' + c, videoTimeSec: c * 3, crossfadeSeconds: 2 }));
  const tl = buildMechanismTimeline(mechs, cues, id => {
    const c = Number(id.slice(1));
    return Object.fromEntries(mechs.map((m, i) => [m.id, ((c * 13 + i * 7) % 200) - 100]));
  })!;
  const rig = compileRig(mechs, 1.3);
  const objs = [...rig.chains.entries()];
  const base = objs.map(() => ({ p: new THREE.Vector3(1, 2, 3), q: new THREE.Quaternion() }));
  const outP = new THREE.Vector3(), outQ = new THREE.Quaternion();

  it('影片時間軸：20 個機關找位置 + 200 個物件套機關，一幀遠低於 0.1 ms', () => {
    const frame = (t: number) => {
      const v = tl.valuesAt(t);
      for (let i = 0; i < objs.length; i++) applyChain(objs[i][1], v, base[i].p, base[i].q, outP, outQ);
    };
    for (let i = 0; i < 2000; i++) frame(i * 0.15);  // 暖機
    const N = 20000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) frame((i * 0.0157) % 300);
    const perFrame = (performance.now() - t0) / N;
    console.log(`  影片時間軸：每幀 ${(perFrame * 1000).toFixed(1)} µs（20 個機關 × 100 段、${objs.length} 個物件）`);
    expect(perFrame).toBeLessThan(0.5);  // 很慢的 CI 也要過；設計目標 0.1 ms
  });

  it('點 cue（照走幾秒走）：一幀遠低於 0.1 ms', () => {
    const tw = new MechanismTweener();
    tw.retarget(mechs, Object.fromEntries(mechs.map(m => [m.id, 0])), 0, { animate: false, minSeconds: 0 });
    tw.retarget(mechs, Object.fromEntries(mechs.map(m => [m.id, 90])), 0, { animate: true, minSeconds: 30 });
    const N = 20000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      const v = tw.valuesAt(i);
      for (let k = 0; k < objs.length; k++) applyChain(objs[k][1], v, base[k].p, base[k].q, outP, outQ);
    }
    const perFrame = (performance.now() - t0) / N;
    console.log(`  點 cue：每幀 ${(perFrame * 1000).toFixed(1)} µs`);
    expect(perFrame).toBeLessThan(0.5);
  });
});
