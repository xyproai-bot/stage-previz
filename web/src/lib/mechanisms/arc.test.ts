import { describe, it, expect } from 'vitest';
import { arcRadiusFor, arcAxisFor } from './arc';

describe('arcRadiusFor：物件中心到圓心的水平距離（公尺）', () => {
  const pivot = { x: 0, y: 0, z: 10 }, up = { x: 0, y: 1, z: 0 };
  it('校準倍率 1：距離 20 → 20 m；校準倍率 2（1 個場景單位 = 2 公尺）→ 40 m', () => {
    expect(arcRadiusFor(pivot, up, { x: 0, y: 0, z: -10 }, 1)).toBeCloseTo(20, 9);
    expect(arcRadiusFor(pivot, up, { x: 0, y: 0, z: -10 }, 2)).toBeCloseTo(40, 9);
  });
  it('物件高度不同不影響（只算垂直轉軸的平面上的距離）；轉軸正負不影響', () => {
    expect(arcRadiusFor(pivot, up, { x: 0, y: 7.5, z: -10 }, 1)).toBeCloseTo(20, 9);
    expect(arcRadiusFor({ x: 0, y: 3, z: 10 }, up, { x: 0, y: -4, z: -10 }, 1)).toBeCloseTo(20, 9);
    expect(arcRadiusFor(pivot, { x: 0, y: -1, z: 0 }, { x: 0, y: 7.5, z: -10 }, 1)).toBeCloseTo(20, 9);
    expect(arcRadiusFor(pivot, { x: 0, y: 5, z: 0 }, { x: 12, y: 1, z: 26 }, 1)).toBeCloseTo(20, 9);   // 相對圓心 (12, 16) 長 20
  });
  it('轉軸不是垂直也行：算垂直轉軸的平面上的距離', () => {
    // 轉軸朝 x：物件在 (5, 3, 4) 相對圓心 → 垂直 x 的平面上是 (3, 4) = 5
    expect(arcRadiusFor({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 5, y: 3, z: 4 }, 1)).toBeCloseTo(5, 9);
  });
  it('物件就在圓心上 → 0（畫面再決定怎麼提醒）；壞的倍率當 1', () => {
    expect(arcRadiusFor(pivot, up, { x: 0, y: 5, z: 10 }, 1)).toBeCloseTo(0, 9);
    expect(arcRadiusFor(pivot, up, { x: 0, y: 0, z: -10 }, 0)).toBeCloseTo(20, 9);
    expect(arcRadiusFor(pivot, up, { x: 0, y: 0, z: -10 }, NaN)).toBeCloseTo(20, 9);
  });
});

describe('arcAxisFor：挑轉軸的正負，讓「值變大」往原本直線的方向那一邊走', () => {
  const pivot = { x: 0, y: 0, z: 10 }, up = { x: 0, y: 1, z: 0 }, center = { x: 0, y: 0, z: -10 };
  it('想往 +x → 轉軸朝下；想往 -x → 轉軸朝上', () => {
    expect(arcAxisFor(pivot, up, center, { x: 1, y: 0, z: 0 })).toEqual({ x: 0, y: -1, z: 0 });
    expect(arcAxisFor(pivot, up, center, { x: -1, y: 0, z: 0 })).toEqual({ x: 0, y: 1, z: 0 });
  });
  it('給的 upAxis 已經朝下也一樣（只看結果）', () => {
    const down = { x: 0, y: -1, z: 0 };
    expect(arcAxisFor(pivot, down, center, { x: 1, y: 0, z: 0 })).toEqual({ x: 0, y: -1, z: 0 });
    expect(arcAxisFor(pivot, down, center, { x: -1, y: 0, z: 0 })).toEqual({ x: 0, y: 1, z: 0 });
  });
  it('物件在圓心另一邊 → 方向跟著反過來', () => {
    expect(arcAxisFor(pivot, up, { x: 0, y: 0, z: 30 }, { x: 1, y: 0, z: 0 })).toEqual({ x: 0, y: 1, z: 0 });
  });
  it('原本的方向斜斜的也行（取跟走向同一邊的）；方向跟走向垂直 / 沒方向 → 用 upAxis', () => {
    expect(arcAxisFor(pivot, up, center, { x: 0.8, y: 0.3, z: 0.4 })).toEqual({ x: 0, y: -1, z: 0 });
    expect(arcAxisFor(pivot, up, center, { x: 0, y: 1, z: 0 })).toEqual({ x: 0, y: 1, z: 0 });
    expect(arcAxisFor(pivot, up, center, { x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 1, z: 0 });
  });
  it('傳回單位向量（upAxis 長度不是 1 也行）', () => {
    expect(arcAxisFor(pivot, { x: 0, y: 4, z: 0 }, center, { x: -1, y: 0, z: 0 })).toEqual({ x: 0, y: 1, z: 0 });
  });
});
