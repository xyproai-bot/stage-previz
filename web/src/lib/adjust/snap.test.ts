import { describe, expect, it } from 'vitest';
import { snapValue } from './snap';

const lin = { kind: 'linear' as const, presets: [0, 2], min: -3, max: 4 };
const rot = { kind: 'rotary' as const, presets: [0, 180, -180], min: -360, max: 360 };

describe('snapValue：拖的時候自動對齊', () => {
  it('靠近常用位置 → 吸過去（直線 0.15 m 內）', () => {
    expect(snapValue(1.9, lin)).toBe(2);
    expect(snapValue(-0.12, lin)).toBe(0);
  });
  it('不靠近常用位置 → 對齊 0.1 m', () => {
    expect(snapValue(1.234, lin)).toBe(1.2);
    expect(snapValue(-1.26, lin)).toBe(-1.3);
  });
  it('旋轉：3° 內吸常用位置，其他對齊 1°', () => {
    expect(snapValue(177.6, rot)).toBe(180);
    expect(snapValue(-182.4, rot)).toBe(-180);
    expect(snapValue(44.6, rot)).toBe(45);
  });
  it('按住 Alt（free）→ 不對齊，只夾在行程內', () => {
    expect(snapValue(1.234, { ...lin, free: true })).toBe(1.234);
    expect(snapValue(9, { ...lin, free: true })).toBe(4);
  });
  it('不能超出行程', () => {
    expect(snapValue(5.5, lin)).toBe(4);
    expect(snapValue(-7, lin)).toBe(-3);
    expect(snapValue(400, rot)).toBe(360);
  });
  it('對齊 0.1 m 時不會跑出行程（行程端點不是 0.1 的倍數）', () => {
    expect(snapValue(2.96, { kind: 'linear', presets: [], min: 0, max: 2.95 })).toBe(2.95);
  });
  it('不是數字 → 夾到行程裡（不會變 NaN）', () => {
    expect(Number.isFinite(snapValue(NaN, lin))).toBe(true);
  });
});
