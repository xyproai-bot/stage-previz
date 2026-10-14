import { describe, it, expect } from 'vitest';
import {
  FLIP_HINGES, FLIP_HINGE_KEYS, flipLabel, flipSetupOf, hingeFromBox, withFlipSetup, type FlipHinge, type StageBox,
} from './flip';
import { audienceRight, type MechVec3 } from './model';

// 舞台正面朝 +Z（觀眾站在 +Z 往 −Z 看），觀眾看過去的右手邊 = 上 × 正面 = +X
const FRONT: MechVec3 = { x: 0, y: 0, z: 1 };
const dot = (a: MechVec3, b: MechVec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: MechVec3, b: MechVec3): MechVec3 => ({
  x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x,
});
const sub = (a: MechVec3, b: MechVec3): MechVec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const near = (a: MechVec3, b: MechVec3, d = 9) => {
  expect(a.x).toBeCloseTo(b.x, d); expect(a.y).toBeCloseTo(b.y, d); expect(a.z).toBeCloseTo(b.z, d);
};
/** 右手定則轉一小步，看這個點往哪個方向走（= 轉軸 × 離轉軸中心的向量） */
const moveDirection = (axis: MechVec3, pivot: MechVec3, point: MechVec3): MechVec3 => cross(axis, sub(point, pivot));

// 一片寬 4、高 3、深 0.2 的板，中心在 (1, 2, 5)
const BOX: StageBox = { min: { x: -1, y: 0.5, z: 4.9 }, max: { x: 3, y: 3.5, z: 5.1 } };
const R = audienceRight(FRONT);
const UP: MechVec3 = { x: 0, y: 1, z: 0 };

describe('翻轉：從外框算轉軸和轉軸中心（舞台正面朝 +Z）', () => {
  it('舞台的右 / 上 / 前：右 × 上 = 前', () => {
    near(cross(R, UP), FRONT);
  });

  it('上緣 / 下緣：轉軸平行觀眾的右手邊，轉軸中心在上緣 / 下緣，左右和深度的正中間', () => {
    const top = hingeFromBox(BOX, 'top', FRONT);
    const bottom = hingeFromBox(BOX, 'bottom', FRONT);
    expect(Math.abs(dot(top.axis, R))).toBeCloseTo(1, 9);
    expect(Math.abs(dot(bottom.axis, R))).toBeCloseTo(1, 9);
    near(top.pivot, { x: 1, y: 3.5, z: 5 });
    near(bottom.pivot, { x: 1, y: 0.5, z: 5 });
  });

  it('左緣 / 右緣：轉軸 = 上，轉軸中心在左緣 / 右緣（觀眾看過去），高度和深度的正中間', () => {
    const left = hingeFromBox(BOX, 'left', FRONT);
    const right = hingeFromBox(BOX, 'right', FRONT);
    expect(Math.abs(left.axis.y)).toBeCloseTo(1, 9);
    expect(Math.abs(right.axis.y)).toBeCloseTo(1, 9);
    // 觀眾看過去的右手邊是 +X → 左緣是 x 小的那一邊
    expect(R.x).toBeCloseTo(1, 9);
    near(left.pivot, { x: -1, y: 2, z: 5 });
    near(right.pivot, { x: 3, y: 2, z: 5 });
  });

  it('前緣 / 後緣（斜板）：轉軸平行觀眾的右手邊，轉軸中心在前緣 / 後緣的最下面', () => {
    const front = hingeFromBox(BOX, 'front', FRONT);
    const back = hingeFromBox(BOX, 'back', FRONT);
    expect(Math.abs(dot(front.axis, R))).toBeCloseTo(1, 9);
    near(front.pivot, { x: 1, y: 0.5, z: 5.1 });
    near(back.pivot, { x: 1, y: 0.5, z: 4.9 });
  });

  it('「正的角度」兩個選項剛好反過來（轉軸反向，轉軸中心不變）', () => {
    for (const h of FLIP_HINGE_KEYS) {
      const a = hingeFromBox(BOX, h, FRONT, true), b = hingeFromBox(BOX, h, FRONT, false);
      near(b.axis, { x: -a.axis.x || 0, y: -a.axis.y || 0, z: -a.axis.z || 0 });
      near(b.pivot, a.pivot);
    }
  });

  it('正的角度的字真的是那個方向（每個邊緣、兩個選項，用右手定則轉一小步驗）', () => {
    const F = FRONT;
    const c = { x: 1, y: 2, z: 5 };
    // [邊緣, 選項] → 板子上哪一個點、會往哪走
    const expectations: [FlipHinge, boolean, (p: MechVec3) => MechVec3, (d: MechVec3) => boolean][] = [
      // 沿著上緣翻：下緣（板子最下面）往觀眾翻出來 / 往後翻
      ['top', true, () => ({ x: 1, y: 0.5, z: 5 }), d => dot(d, F) > 0],
      ['top', false, () => ({ x: 1, y: 0.5, z: 5 }), d => dot(d, F) < 0],
      // 沿著下緣翻：上緣往觀眾倒 / 往後倒
      ['bottom', true, () => ({ x: 1, y: 3.5, z: 5 }), d => dot(d, F) > 0],
      ['bottom', false, () => ({ x: 1, y: 3.5, z: 5 }), d => dot(d, F) < 0],
      // 沿著左緣翻（觀眾看過去的左邊 = x 小的那邊）：右緣（x 大的那邊）往觀眾轉出來 / 往後轉
      ['left', true, () => ({ x: 3, y: 2, z: 5 }), d => dot(d, F) > 0],
      ['left', false, () => ({ x: 3, y: 2, z: 5 }), d => dot(d, F) < 0],
      // 沿著右緣翻：左緣（x 小的那邊）往觀眾轉出來 / 往後轉
      ['right', true, () => ({ x: -1, y: 2, z: 5 }), d => dot(d, F) > 0],
      ['right', false, () => ({ x: -1, y: 2, z: 5 }), d => dot(d, F) < 0],
      // 沿著前緣翻：後面抬高 / 壓低
      ['front', true, () => ({ x: 1, y: 0.5, z: 4.9 }), d => d.y > 0],
      ['front', false, () => ({ x: 1, y: 0.5, z: 4.9 }), d => d.y < 0],
      // 沿著後緣翻：前面抬高 / 壓低
      ['back', true, () => ({ x: 1, y: 0.5, z: 5.1 }), d => d.y > 0],
      ['back', false, () => ({ x: 1, y: 0.5, z: 5.1 }), d => d.y < 0],
    ];
    for (const [hinge, first, pointOf, check] of expectations) {
      const { axis, pivot } = hingeFromBox(BOX, hinge, F, first);
      const d = moveDirection(axis, pivot, pointOf(c));
      expect(check(d), `${hinge} ${first ? '第一個' : '第二個'}選項：${JSON.stringify(d)}`).toBe(true);
    }
    expect(FLIP_HINGES.map(h => h.key)).toEqual(['top', 'bottom', 'left', 'right', 'front', 'back']);
  });

  it('舞台不是正對 Z 軸（正面朝 +X）：邊緣照舞台的方向找，不是照世界座標', () => {
    const front: MechVec3 = { x: 1, y: 0, z: 0 };
    const box: StageBox = { min: { x: 4.9, y: 0, z: -2 }, max: { x: 5.1, y: 3, z: 2 } };   // 板子薄的那一面朝 X
    const r = audienceRight(front);                       // 上 × 正面 = (0, 0, -1)
    expect(r.z).toBeCloseTo(-1, 9);
    const { pivot } = hingeFromBox(box, 'front', front);
    near(pivot, { x: 5.1, y: 0, z: 0 });                  // 前緣 = x 大的那一邊，最下面，左右的正中間
    const left = hingeFromBox(box, 'left', front);
    near(left.pivot, { x: 5, y: 1.5, z: 2 });             // 觀眾看過去的左邊 = z 大的那邊（右手邊是 −Z）
  });

  it('正面斜著（45 度）也算得出來：轉軸中心還在板子外框的邊上', () => {
    const s = Math.SQRT1_2;
    const front: MechVec3 = { x: s, y: 0, z: s };
    const box: StageBox = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 2 } };
    const { axis, pivot } = hingeFromBox(box, 'top', front);
    expect(Math.hypot(axis.x, axis.y, axis.z)).toBeCloseTo(1, 9);
    expect(pivot.y).toBeCloseTo(2, 9);
  });
});

describe('metadata.setup', () => {
  it('讀 / 寫：壞資料 → null，其他欄位照舊', () => {
    expect(flipSetupOf(null)).toBeNull();
    expect(flipSetupOf({ setup: { hinge: 'oops' } })).toBeNull();
    expect(flipSetupOf({ setup: { hinge: 'top' } })).toEqual({ hinge: 'top', positive: 'first' });
    expect(flipSetupOf({ setup: { hinge: 'left', positive: 'second' } })).toEqual({ hinge: 'left', positive: 'second' });
    expect(withFlipSetup({ note: 1 }, { hinge: 'back', positive: 'second' })).toEqual({ note: 1, setup: { hinge: 'back', positive: 'second' } });
    expect(withFlipSetup({ note: 1, setup: { hinge: 'top', positive: 'first' } }, null)).toEqual({ note: 1 });
    expect(withFlipSetup({ setup: { hinge: 'top', positive: 'first' } }, null)).toBeNull();
    expect(flipLabel({ setup: { hinge: 'front', positive: 'first' } })).toBe('沿著前緣翻');
    expect(flipLabel(null)).toBeNull();
  });
});
