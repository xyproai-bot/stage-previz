import { describe, expect, it } from 'vitest';
import { focusView, stageView } from './views';

const bounds = { center: { x: 0, y: 2, z: 0 }, radius: 10 };
const front = { x: 0, y: 0, z: 1 };

const sub = (a: number[], b: { x: number; y: number; z: number }) => ({ x: a[0] - b.x, y: a[1] - b.y, z: a[2] - b.z });

describe('stageView：觀眾看 / 正上方 / 側面', () => {
  it('三個都看著舞台中心，距離夠看到整個舞台', () => {
    for (const k of ['audience', 'top', 'side'] as const) {
      const v = stageView(k, bounds, front, 50);
      expect(v.target).toEqual([0, 2, 0]);
      const d = sub(v.position, bounds.center);
      expect(Math.hypot(d.x, d.y, d.z)).toBeGreaterThan(bounds.radius * 1.5);
      expect(v.fov).toBe(50);
    }
  });
  it('觀眾看：在舞台正面（+z）、高一點', () => {
    const d = sub(stageView('audience', bounds, front, 50).position, bounds.center);
    expect(d.z).toBeGreaterThan(0);
    expect(d.y).toBeGreaterThan(0);
    expect(Math.abs(d.x)).toBeLessThan(1e-6);
  });
  it('正上方：幾乎垂直但不是正好垂直（鏡頭才不會翻），稍微偏觀眾那邊', () => {
    const d = sub(stageView('top', bounds, front, 50).position, bounds.center);
    expect(d.y).toBeGreaterThan(0);
    expect(d.z).toBeGreaterThan(0);
    expect(d.z / d.y).toBeLessThan(0.05);
  });
  it('側面：在觀眾看過去的右邊（舞台面向 +z → +x）', () => {
    const d = sub(stageView('side', bounds, front, 50).position, bounds.center);
    expect(d.x).toBeGreaterThan(bounds.radius);
    expect(Math.abs(d.z)).toBeLessThan(1e-6);
  });
  it('舞台面向別的方向也照著轉', () => {
    const d = sub(stageView('audience', bounds, { x: 1, y: 0, z: 0 }, 50).position, bounds.center);
    expect(d.x).toBeGreaterThan(0);
    expect(Math.abs(d.z)).toBeLessThan(1e-6);
  });
});

describe('focusView：選到吊掛時看過去（從舞台那一邊看）', () => {
  it('物件在觀眾那邊 → 鏡頭在物件跟舞台中心之間，看著物件', () => {
    const v = focusView({ x: 0, y: 8, z: 20 }, 2, bounds.center, front, 50);
    expect(v.target).toEqual([0, 8, 20]);
    expect(v.position[2]).toBeLessThan(20);
    expect(v.position[1]).toBeGreaterThan(8);
  });
  it('物件就在舞台中心 → 從後面（−正面）看', () => {
    const v = focusView({ x: 0, y: 2, z: 0 }, 1, bounds.center, front, 50);
    expect(v.position[2]).toBeLessThan(0);
  });
});
