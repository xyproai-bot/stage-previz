import { describe, it, expect } from 'vitest';
import { autoSplitSides, countSides } from './split';
import type { MechVec3 } from './model';

describe('對開：照位置自動分兩邊', () => {
  const FRONT: MechVec3 = { x: 0, y: 0, z: 1 };   // 觀眾的右手邊 = +X
  const c = (x: number, y = 0, z = 0) => ({ x, y, z });

  it('直線：兩排左右的 LED，數字變大往左 → 左邊（x 小）是 A 邊', () => {
    const centers = { l1: c(-3), l2: c(-2), r1: c(2), r2: c(3) };
    expect(autoSplitSides(['l1', 'l2', 'r1', 'r2'], centers, 'linear', { x: -1, y: 0, z: 0 }, FRONT))
      .toEqual({ l1: 'a', l2: 'a', r1: 'b', r2: 'b' });
    // 數字變大往右 → 右邊是 A 邊
    expect(autoSplitSides(['l1', 'l2', 'r1', 'r2'], centers, 'linear', { x: 1, y: 0, z: 0 }, FRONT))
      .toEqual({ l1: 'b', l2: 'b', r1: 'a', r2: 'a' });
  });

  it('直線往上：上面那一半是 A 邊；方向跟排列垂直時照排列切（左邊 A）', () => {
    expect(autoSplitSides(['t', 'b'], { t: c(0, 5), b: c(0, 1) }, 'linear', { x: 0, y: 1, z: 0 }, FRONT)).toEqual({ t: 'a', b: 'b' });
    expect(autoSplitSides(['l', 'r'], { l: c(-2), r: c(2) }, 'linear', { x: 0, y: 1, z: 0 }, FRONT)).toEqual({ l: 'a', r: 'b' });
  });

  it('旋轉：觀眾看過去的左邊 / 上面 / 前面是 A 邊', () => {
    expect(autoSplitSides(['l', 'r'], { l: c(-2), r: c(2) }, 'rotary', { x: 0, y: 1, z: 0 }, FRONT)).toEqual({ l: 'a', r: 'b' });
    expect(autoSplitSides(['t', 'b'], { t: c(0, 5), b: c(0, 1) }, 'rotary', { x: 1, y: 0, z: 0 }, FRONT)).toEqual({ t: 'a', b: 'b' });
    expect(autoSplitSides(['f', 'k'], { f: c(0, 0, 4), k: c(0, 0, 1) }, 'rotary', { x: 1, y: 0, z: 0 }, FRONT)).toEqual({ f: 'a', k: 'b' });
  });

  it('找不到位置 / 只有一個有位置 / 全部疊在一起 → 都放 A 邊；中心在切線上的算 A 邊', () => {
    expect(autoSplitSides(['a', 'b'], {}, 'linear', c(1), FRONT)).toEqual({ a: 'a', b: 'a' });
    expect(autoSplitSides(['a', 'b'], { a: c(1) }, 'linear', c(1), FRONT)).toEqual({ a: 'a', b: 'a' });
    expect(autoSplitSides(['a', 'b'], { a: c(1), b: c(1) }, 'linear', c(1), FRONT)).toEqual({ a: 'a', b: 'a' });
    expect(autoSplitSides(['x', 'm', 'y'], { x: c(-2), m: c(0), y: c(2) }, 'rotary', c(0, 1), FRONT)).toEqual({ x: 'a', m: 'a', y: 'b' });
    expect(countSides(['x', 'm', 'y'], { x: 'a', m: 'a', y: 'b' })).toEqual({ a: 2, b: 1 });
  });
});
