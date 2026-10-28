import { describe, expect, it } from 'vitest';
import { arcReadout, arcReadoutText, spinFromPrevText, turnsText } from './readouts';

describe('turnsText：轉幾圈', () => {
  it('半圈 / 1 圈 / 1.5 圈 / 2 圈', () => {
    expect(turnsText(180)).toBe('半圈');
    expect(turnsText(360)).toBe('1 圈');
    expect(turnsText(540)).toBe('1.5 圈');
    expect(turnsText(720)).toBe('2 圈');
  });
  it('超過一圈但不是整半圈 → 約幾圈；一圈以內不是半圈 → 不寫', () => {
    expect(turnsText(450)).toBe('約 1.3 圈');
    expect(turnsText(90)).toBeNull();
    expect(turnsText(0)).toBeNull();
  });
});

describe('spinFromPrevText：從上一個 cue 轉過來的方向', () => {
  it('轉軸朝上：值變大 = 從上面看逆時針；變小 = 順時針', () => {
    expect(spinFromPrevText({ prevName: '12', prev: 0, cur: 180, axisY: 1 }))
      .toBe('從上一個 cue（12）轉過來：從上面看逆時針轉 180°（半圈）');
    expect(spinFromPrevText({ prevName: '12', prev: 0, cur: -180, axisY: 1 }))
      .toBe('從上一個 cue（12）轉過來：從上面看順時針轉 180°（半圈）');
  });
  it('轉軸朝下：方向反過來', () => {
    expect(spinFromPrevText({ prevName: 'A', prev: 0, cur: 90, axisY: -1 }))
      .toBe('從上一個 cue（A）轉過來：從上面看順時針轉 90°');
  });
  it('一樣 → 不轉', () => {
    expect(spinFromPrevText({ prevName: '3', prev: 45, cur: 45.2, axisY: 1 })).toBe('跟上一個 cue（3）一樣，不轉');
  });
  it('沒有上一個 cue → 從預設位置', () => {
    expect(spinFromPrevText({ prevName: null, prev: 0, cur: 720, axisY: 1 }))
      .toBe('從預設位置轉過來：從上面看逆時針轉 720°（2 圈）');
  });
  it('轉軸不是垂直 → 不講從上面看的方向', () => {
    expect(spinFromPrevText({ prevName: '5', prev: 0, cur: 30.5, axisY: 0.1 }))
      .toBe('從上一個 cue（5）轉過來：轉 30.5°');
  });
});

describe('arcReadout：沿弧形軌道走了以後，往觀眾靠近幾公尺、轉幾度', () => {
  // 圓心在觀眾那邊（z = +10），物件在圓心後面 10 公尺（z = 0）；舞台面向 +z
  const base = { pivot: { x: 0, y: 0, z: 10 }, axis: { x: 0, y: 1, z: 0 }, radiusM: 10, center: { x: 0, y: 4, z: 0 }, front: { x: 0, y: 0, z: 1 }, sceneToMeters: 1 };
  it('值 0 → 不動', () => {
    const r = arcReadout({ ...base, value: 0 });
    expect(r.towardM).toBeCloseTo(0, 9);
    expect(r.turnDeg).toBeCloseTo(0, 9);
  });
  it('往左右走都會靠近觀眾；轉的角度 = 值 ÷ 半徑', () => {
    const v = 10 * Math.PI / 6;   // 30°
    for (const s of [1, -1]) {
      const r = arcReadout({ ...base, value: s * v });
      expect(r.turnDeg).toBeCloseTo(30, 6);
      expect(r.towardM).toBeCloseTo(10 * (1 - Math.cos(Math.PI / 6)), 6);
    }
  });
  it('校準倍率：1 個場景單位 = 2 公尺 → 距離乘 2（角度不變）', () => {
    const v = 10 * Math.PI / 6;
    const r = arcReadout({ ...base, center: { x: 0, y: 4, z: 5 }, sceneToMeters: 2, value: v });
    expect(r.turnDeg).toBeCloseTo(30, 6);
    expect(r.towardM).toBeCloseTo(2 * 5 * (1 - Math.cos(Math.PI / 6)), 6);
  });
  it('圓心在舞台後面 → 往外走是往後退（負的）', () => {
    const r = arcReadout({ ...base, pivot: { x: 0, y: 0, z: -10 }, value: 3 });
    expect(r.towardM).toBeLessThan(0);
  });
  it('字：往觀眾靠近 / 往後退 / 不動', () => {
    expect(arcReadoutText({ towardM: 1.234, turnDeg: 8.04 })).toBe('跟原本的位置比：往觀眾靠近 1.2 公尺、轉 8 度');
    expect(arcReadoutText({ towardM: -0.56, turnDeg: 12.5 })).toBe('跟原本的位置比：往後退 0.6 公尺、轉 12.5 度');
    expect(arcReadoutText({ towardM: 0.001, turnDeg: 0 })).toBe('在原本的位置');
  });
});
