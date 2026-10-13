import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { CueState } from './api';
import {
  cueWindows, timelineAt, cuePoses, blendCuePoses, poseAtTime, cueQuaternion, scenePosition,
  fadeOpacity, lerpOpacity, type CuePoseMap,
} from './cueTimeline';
import { DEFAULT_CUE_TRANSITION_SECONDS } from './cueTiming';

// 用戶的例子：Cue 0 在 0 秒、Cue 1 在 30 秒、淡入淡出 20 秒 → 10 秒開始動、30 秒剛好到
const userCues = [
  { id: 'c0', videoTimeSec: 0, crossfadeSeconds: 0 },
  { id: 'c1', videoTimeSec: 30, crossfadeSeconds: 20 },
];

function state(objectId: string, x: number, yaw: number, visible = true, category: CueState['category'] = 'led_panel'): CueState {
  const position = { x, y: 0, z: 0 };
  const rotation = { pitch: 0, yaw, roll: 0 };
  const scale = { x: 1, y: 1, z: 1 };
  return {
    objectId, meshName: objectId, displayName: objectId, category, order: 0, locked: false,
    default: { position, rotation, scale },
    override: null,
    effective: { position, rotation, scale, visible },
  } as CueState;
}

describe('cueWindows', () => {
  it('每個 cue 的移動時段 = [影片時間 − 淡入淡出, 影片時間]；第一個 cue 不用移動', () => {
    expect(cueWindows(userCues)).toEqual([
      { cueId: 'c0', start: 0, arrive: 0 },
      { cueId: 'c1', start: 10, arrive: 30 },
    ]);
  });
  it('淡入淡出比兩個 cue 的間隔長 → 從上一個 cue 到的時間才開始（時間變短，不會提早出發）', () => {
    const w = cueWindows([
      { id: 'a', videoTimeSec: 5, crossfadeSeconds: 0 },
      { id: 'b', videoTimeSec: 8, crossfadeSeconds: 10 },
    ]);
    expect(w[1]).toEqual({ cueId: 'b', start: 5, arrive: 8 });
  });
  it('淡入淡出 0 → 直接切換：到那一秒才一次換過去（不提早出發）', () => {
    const w = cueWindows([
      { id: 'a', videoTimeSec: 0, crossfadeSeconds: 0 },
      { id: 'b', videoTimeSec: 30, crossfadeSeconds: 0 },
    ]);
    expect(w[1]).toEqual({ cueId: 'b', start: 30, arrive: 30 });
    expect(timelineAt(w, 29.99)).toEqual({ kind: 'hold', cueId: 'a' });
    expect(timelineAt(w, 30)).toEqual({ kind: 'hold', cueId: 'b' });
  });
  it('淡入淡出用 cue 的秒數（新 cue 預設 1 秒）', () => {
    const w = cueWindows([
      { id: 'a', videoTimeSec: 0, crossfadeSeconds: 0 },
      { id: 'b', videoTimeSec: 30, crossfadeSeconds: DEFAULT_CUE_TRANSITION_SECONDS },
    ]);
    expect(w[1]).toEqual({ cueId: 'b', start: 30 - DEFAULT_CUE_TRANSITION_SECONDS, arrive: 30 });
  });
  it('沒設影片時間的 cue 不算；順序亂的照時間排', () => {
    const w = cueWindows([
      { id: 'late', videoTimeSec: 60, crossfadeSeconds: 5 },
      { id: 'none', videoTimeSec: null, crossfadeSeconds: 5 },
      { id: 'early', videoTimeSec: 10, crossfadeSeconds: 5 },
    ]);
    expect(w.map(x => x.cueId)).toEqual(['early', 'late']);
    expect(w[1]).toEqual({ cueId: 'late', start: 55, arrive: 60 });
  });
});

describe('timelineAt（用戶的例子）', () => {
  const w = cueWindows(userCues);
  it('5 秒 → 還在 Cue 0', () => {
    expect(timelineAt(w, 5)).toEqual({ kind: 'hold', cueId: 'c0' });
  });
  it('10 秒 → 剛開始動（0%）', () => {
    expect(timelineAt(w, 10)).toEqual({ kind: 'move', fromCueId: 'c0', toCueId: 'c1', progress: 0 });
  });
  it('20 秒 → 走一半（50%，等速）', () => {
    expect(timelineAt(w, 20)).toEqual({ kind: 'move', fromCueId: 'c0', toCueId: 'c1', progress: 0.5 });
    expect(timelineAt(w, 15)).toMatchObject({ kind: 'move', progress: 0.25 });
  });
  it('30 秒 → 剛好到 Cue 1；40 秒 → 停在 Cue 1', () => {
    expect(timelineAt(w, 30)).toEqual({ kind: 'hold', cueId: 'c1' });
    expect(timelineAt(w, 40)).toEqual({ kind: 'hold', cueId: 'c1' });
  });
  it('第一個 cue 的時間還沒到 → 第一個 cue', () => {
    const w2 = cueWindows([{ id: 'a', videoTimeSec: 12, crossfadeSeconds: 3 }]);
    expect(timelineAt(w2, 2)).toEqual({ kind: 'hold', cueId: 'a' });
  });
  it('沒有任何有時間的 cue → null', () => {
    expect(timelineAt([], 5)).toBeNull();
  });
});

describe('blendCuePoses / poseAtTime', () => {
  const posesByCue = new Map<string, CuePoseMap>([
    ['c0', cuePoses([state('led', 0, 0), state('only0', 1, 0), state('hidden1', 0, 0, true), state('appear', 0, 0, false)])],
    ['c1', cuePoses([state('led', 10, 90), state('hidden1', 4, 0, false), state('appear', 0, 0, true)])],
  ]);
  const w = cueWindows(userCues);

  it('位置照時間等速走', () => {
    expect(poseAtTime(w, posesByCue, 5)!.get('led')!.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(poseAtTime(w, posesByCue, 10)!.get('led')!.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(poseAtTime(w, posesByCue, 20)!.get('led')!.position.x).toBeCloseTo(5);
    expect(poseAtTime(w, posesByCue, 30)!.get('led')!.position).toEqual({ x: 10, y: 0, z: 0 });
    expect(poseAtTime(w, posesByCue, 40)!.get('led')!.position).toEqual({ x: 10, y: 0, z: 0 });
  });
  it('旋轉走一半 → 轉一半', () => {
    const q = poseAtTime(w, posesByCue, 20)!.get('led')!.quaternion;
    expect(q.angleTo(cueQuaternion({ pitch: 0, yaw: 45, roll: 0 }))).toBeLessThan(1e-6);
  });
  it('旋轉走近路：170° → −170° 中間是 180°，不是繞一大圈經過 0°', () => {
    const a = cuePoses([state('x', 0, 170)]);
    const b = cuePoses([state('x', 0, -170)]);
    const q = blendCuePoses(a, b, 0.5).get('x')!.quaternion;
    expect(q.angleTo(cueQuaternion({ pitch: 0, yaw: 180, roll: 0 }))).toBeLessThan(1e-6);
  });
  it('移動中：兩個 cue 有一邊看得到就看得到；到了 → 照新 cue', () => {
    expect(poseAtTime(w, posesByCue, 20)!.get('hidden1')!.visible).toBe(true);
    expect(poseAtTime(w, posesByCue, 30)!.get('hidden1')!.visible).toBe(false);
  });
  it('新 cue 藏起來的物件：跟著移動等速淡出（10 秒 1 → 20 秒 0.5 → 30 秒 0 並隱藏）', () => {
    const at = (t: number) => poseAtTime(w, posesByCue, t)!.get('hidden1')!;
    expect(at(5).opacity).toBe(1);
    expect(at(10).opacity).toBe(1);
    expect(at(15).opacity).toBeCloseTo(0.75);
    expect(at(20).opacity).toBeCloseTo(0.5);
    expect(at(30)).toMatchObject({ opacity: 0, visible: false });
  });
  it('新 cue 才出現的物件：等速淡入（10 秒 0 → 25 秒 0.75 → 30 秒 1）', () => {
    const at = (t: number) => poseAtTime(w, posesByCue, t)!.get('appear')!;
    expect(at(5)).toMatchObject({ opacity: 0, visible: false });
    expect(at(10)).toMatchObject({ opacity: 0, visible: false });
    expect(at(25)).toMatchObject({ visible: true });
    expect(at(25).opacity).toBeCloseTo(0.75);
    expect(at(30)).toMatchObject({ opacity: 1, visible: true });
  });
  it('兩邊都看得到 → 一直是 1', () => {
    expect(poseAtTime(w, posesByCue, 20)!.get('led')!.opacity).toBe(1);
  });
  it('只有一邊有的物件 → 用有的那邊', () => {
    expect(poseAtTime(w, posesByCue, 20)!.get('only0')!.position.x).toBe(1);
  });
  it('需要的 cue 位置還沒抓到 → null', () => {
    expect(poseAtTime(w, new Map([['c0', posesByCue.get('c0')!]]), 20)).toBeNull();
  });
});

describe('fadeOpacity / lerpOpacity', () => {
  it('只有舊 cue 看得到 → 1−p；只有新 cue 看得到 → p；兩邊都看得到 → 1；都看不到 → 0', () => {
    expect(fadeOpacity(true, false, 0.25)).toBe(0.75);
    expect(fadeOpacity(false, true, 0.25)).toBe(0.25);
    expect(fadeOpacity(true, true, 0.25)).toBe(1);
    expect(fadeOpacity(false, false, 0.25)).toBe(0);
  });
  it('p 超出 0..1 → 夾住', () => {
    expect(fadeOpacity(false, true, 2)).toBe(1);
    expect(fadeOpacity(false, true, -1)).toBe(0);
  });
  it('從現在的透明度等速走到目標（換 cue 中途又換 cue 時從半路接著淡）', () => {
    expect(lerpOpacity(0, 1, 0.5)).toBe(0.5);
    expect(lerpOpacity(1, 0, 0.25)).toBe(0.75);
    expect(lerpOpacity(0.4, 1, 0.5)).toBeCloseTo(0.7);
    expect(lerpOpacity(0, 1, 3)).toBe(1);
  });
});

describe('scenePosition / cueQuaternion（管理頁、分享頁共用的算法）', () => {
  it('LED 面板加上機關位移（公尺 → 場景單位）', () => {
    const offsets = { led: { x: 2, y: 1 } };
    expect(scenePosition({ x: 1, y: 1, z: 3 }, 'led_panel', 'led', offsets, 2)).toEqual({ x: 2, y: 1.5, z: 3 });
  });
  it('不是 LED 面板 → 不加機關位移', () => {
    const offsets = { mech: { x: 2, y: 1 } };
    expect(scenePosition({ x: 1, y: 1, z: 3 }, 'mechanism', 'mech', offsets, 2)).toEqual({ x: 1, y: 1, z: 3 });
  });
  it('角度（度）→ 四元數，跟 three.js 的 XYZ 順序一樣', () => {
    const q = cueQuaternion({ pitch: 10, yaw: 20, roll: 30 });
    const ref = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(10), THREE.MathUtils.degToRad(20), THREE.MathUtils.degToRad(30),
    ));
    expect(q.angleTo(ref)).toBeLessThan(1e-6);
  });
});
