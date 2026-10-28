import { describe, expect, it } from 'vitest';
import { driveIds, splitHalves, type ScopeDef } from './scope';

const front = { x: 0, y: 0, z: 1 };   // 舞台面向 +z（觀眾在 +z），觀眾看過去右邊 = +x

describe('splitHalves：照物件位置分左半 / 右半（觀眾看過去）', () => {
  it('偶數：各一半，照左到右排', () => {
    const m = [3, -1, 1, -3].map((x, i) => ({ id: `m${i}`, pos: { x, y: 0, z: 0 } }));
    expect(splitHalves(m, front)).toEqual({ left: ['m3', 'm1'], right: ['m2', 'm0'] });
  });
  it('奇數：正中間那個兩邊都不算', () => {
    const m = [-2, 0, 2].map((x, i) => ({ id: `m${i}`, pos: { x, y: 5, z: -3 } }));
    expect(splitHalves(m, front)).toEqual({ left: ['m0'], right: ['m2'] });
  });
  it('舞台面向 +x（觀眾在 +x）→ 觀眾看過去右邊是 -z', () => {
    const m = [{ id: 'a', pos: { x: 0, y: 0, z: -4 } }, { id: 'b', pos: { x: 0, y: 0, z: 4 } }];
    expect(splitHalves(m, { x: 1, y: 0, z: 0 })).toEqual({ left: ['b'], right: ['a'] });
  });
  it('正面方向壞掉（朝正上方）→ 當成面向 +z', () => {
    const m = [{ id: 'a', pos: { x: 1, y: 0, z: 0 } }, { id: 'b', pos: { x: -1, y: 0, z: 0 } }];
    expect(splitHalves(m, { x: 0, y: 1, z: 0 })).toEqual({ left: ['b'], right: ['a'] });
  });
});

describe('driveIds：一個把手 / 滑桿一次動哪些機關', () => {
  const defs: ScopeDef[] = [
    { id: 's2', groupId: 'g', groupIndex: 2 }, { id: 's0', groupId: 'g', groupIndex: 0 },
    { id: 's1', groupId: 'g', groupIndex: 1 }, { id: 's3', groupId: 'g', groupIndex: 3 },
    { id: 'solo' },
    { id: 'rig', variant: 'hoist_rig' },
    { id: 'hR', variant: 'hoist', rigId: 'rig', rigIndex: 1 }, { id: 'hL', variant: 'hoist', rigId: 'rig', rigIndex: 0 },
  ];
  const halves = () => ({ left: ['s0', 's1'], right: ['s2', 's3'] });
  const base = { defs, scope: {}, linked: () => true, halves };
  it('一般機關：只有自己', () => {
    expect(driveIds({ ...base, mechId: 'solo' })).toEqual(['solo']);
  });
  it('一排：預設只有這個；整排 = 照順序全部', () => {
    expect(driveIds({ ...base, mechId: 's1' })).toEqual(['s1']);
    expect(driveIds({ ...base, mechId: 's1', scope: { g: 'all' } })).toEqual(['s0', 's1', 's2', 's3']);
  });
  it('左半 / 右半', () => {
    expect(driveIds({ ...base, mechId: 's1', scope: { g: 'left' } })).toEqual(['s0', 's1']);
    expect(driveIds({ ...base, mechId: 's3', scope: { g: 'right' } })).toEqual(['s2', 's3']);
  });
  it('分不出左右 → 只有自己', () => {
    expect(driveIds({ ...base, halves: () => null, mechId: 's1', scope: { g: 'left' } })).toEqual(['s1']);
  });
  it('吊點：預設左右一起（照吊點編號）；取消 → 只有自己', () => {
    expect(driveIds({ ...base, mechId: 'hR' })).toEqual(['hL', 'hR']);
    expect(driveIds({ ...base, linked: () => false, mechId: 'hR' })).toEqual(['hR']);
  });
  it('找不到的機關 → 只有自己', () => {
    expect(driveIds({ ...base, mechId: 'nope' })).toEqual(['nope']);
  });
});
