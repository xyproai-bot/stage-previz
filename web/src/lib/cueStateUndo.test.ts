import { describe, it, expect } from 'vitest';
import type { CueState } from './api';
import { applyCueStatePatch, cueStateRestorePlan, overridePatch } from './cueStateUndo';

type Override = NonNullable<CueState['override']>;
const ov = (o: Partial<Override>): Override => ({
  position: null, rotation: null, scale: null, visible: null, customProps: null, updatedAt: '2026-01-01', ...o,
});
const P = { x: 1, y: 2, z: 3 };
const R = { pitch: 0, yaw: 90, roll: 0 };

function state(override: Override | null): CueState {
  return {
    objectId: 'o1', meshName: 'LED_1', displayName: 'LED 1', category: 'led_panel', order: 0, locked: false,
    default: { position: { x: 0, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0, roll: 0 }, scale: { x: 1, y: 1, z: 1 } },
    override,
    effective: {
      position: override?.position ?? { x: 0, y: 0, z: 0 },
      rotation: override?.rotation ?? { pitch: 0, yaw: 0, roll: 0 },
      scale: { x: 1, y: 1, z: 1 },
      visible: override?.visible ?? true,
    },
  };
}

describe('overridePatch', () => {
  it('只拿這個 cue 自己有設的欄位', () => {
    expect(overridePatch(ov({ position: P, visible: false }))).toEqual({ position: P, visible: false });
    expect(overridePatch(null)).toEqual({});
  });
});

describe('cueStateRestorePlan（復原要怎麼把 cue 改回去）', () => {
  it('原本這個 cue 沒有自己的設定 → 整個清掉', () => {
    expect(cueStateRestorePlan(null, ['position'])).toEqual({ reset: true, put: null });
    expect(cueStateRestorePlan(undefined, ['visible'])).toEqual({ reset: true, put: null });
  });
  it('改的欄位原本都有值 → 只把那些欄位寫回去（別的欄位不動）', () => {
    expect(cueStateRestorePlan(ov({ position: P, rotation: R }), ['position']))
      .toEqual({ reset: false, put: { position: P } });
    expect(cueStateRestorePlan(ov({ position: P, rotation: R }), ['position', 'rotation']))
      .toEqual({ reset: false, put: { position: P, rotation: R } });
  });
  it('原本「顯示 = 隱藏」也算有值：寫回 false，不會變成清掉', () => {
    expect(cueStateRestorePlan(ov({ visible: false }), ['visible'])).toEqual({ reset: false, put: { visible: false } });
  });
  it('改到原本沒設的欄位（例：原本只有位置、這次切了顯示）→ 先清掉再寫回原本的位置', () => {
    // 以前只寫回位置 / 角度，顯示 / 隱藏會留著改過的值，復原不乾淨
    expect(cueStateRestorePlan(ov({ position: P }), ['visible'])).toEqual({ reset: true, put: { position: P } });
    expect(cueStateRestorePlan(ov({ position: P }), ['position', 'rotation'])).toEqual({ reset: true, put: { position: P } });
  });
  it('有一列但什麼都沒設 → 清掉就好', () => {
    expect(cueStateRestorePlan(ov({}), ['position'])).toEqual({ reset: true, put: null });
  });
});

describe('applyCueStatePatch（存好先套到畫面上，不用等重新讀取）', () => {
  it('原本沒設定 → 變成這個 cue 自己的設定，看到的位置跟著換', () => {
    const next = applyCueStatePatch(state(null), { position: P });
    expect(next.override?.position).toEqual(P);
    expect(next.override?.rotation).toBeNull();
    expect(next.effective.position).toEqual(P);
    expect(next.effective.rotation).toEqual({ pitch: 0, yaw: 0, roll: 0 });
  });
  it('只改帶到的欄位；隱藏也套得上', () => {
    const s = state(ov({ position: P, rotation: R }));
    const next = applyCueStatePatch(s, { visible: false });
    expect(next.override?.position).toEqual(P);
    expect(next.override?.rotation).toEqual(R);
    expect(next.override?.visible).toBe(false);
    expect(next.effective.visible).toBe(false);
    expect(next.effective.position).toEqual(P);
  });
  it('不改到原本的資料', () => {
    const s = state(ov({ position: P }));
    applyCueStatePatch(s, { position: { x: 9, y: 9, z: 9 }, visible: false });
    expect(s.override?.position).toEqual(P);
    expect(s.effective.visible).toBe(true);
  });
});
