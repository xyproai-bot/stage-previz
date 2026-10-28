import { describe, it, expect } from 'vitest';
import { arcCenterChoices, arcMoveWord, resolveArcAxis } from './arcForm';
import { directionWord, type Mechanism } from './model';

const mech = (over: Partial<Mechanism> & Pick<Mechanism, 'id'>): Mechanism => ({
  name: over.id, kind: 'linear', axis: { x: 0, y: 1, z: 0 }, pivot: null, travelMin: 0, travelMax: 1,
  defaultValue: 0, maxSpeed: null, presets: [], parentId: null, objectIds: [], consoleLabel: null, order: 0,
  metadata: null, cueCount: 0, updatedAt: '', ...over,
});
const FRONT = { x: 0, y: 0, z: 1 };

describe('arcCenterChoices：挑「跟哪個機關同一個圓心」', () => {
  const door = mech({
    id: 'door', name: '對開門', kind: 'rotary', variant: 'split', pivot: { x: -4, y: 0, z: 2 },
    mirror: { axis: { x: 0, y: -1, z: 0 }, pivot: { x: 4, y: 0, z: 2 }, consoleLabel: null },
  });
  const spin = mech({ id: 'spin', name: '轉台', kind: 'rotary', pivot: { x: 0, y: 0, z: 0 } });
  const lift = mech({ id: 'lift', name: '升降台' });
  const arc = mech({ id: 'arc', name: '橫移 1', variant: 'arc', pivot: { x: 1, y: 0, z: 2 }, arcRadius: 5 });
  const hoist = mech({ id: 'rig', name: '吊掛', variant: 'hoist_rig' });

  it('旋轉機關、對開（A 邊、B 邊各一個）、別的弧形都列出來，有圓心才算；一般直線和吊掛不列', () => {
    const c = arcCenterChoices([door, spin, lift, arc, hoist], null);
    expect(c.map(x => x.label)).toEqual(['對開門（A 邊）', '對開門（B 邊）', '轉台', '橫移 1']);
    expect(c.map(x => x.pivot)).toEqual([{ x: -4, y: 0, z: 2 }, { x: 4, y: 0, z: 2 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 2 }]);
    expect(new Set(c.map(x => x.key)).size).toBe(4);
  });
  it('不列自己；列出來的是複製品（改它不會動到機關）', () => {
    expect(arcCenterChoices([door, arc], 'arc').map(x => x.label)).toEqual(['對開門（A 邊）', '對開門（B 邊）']);
    const c = arcCenterChoices([spin], null);
    c[0].pivot.x = 99;
    expect(spin.pivot!.x).toBe(0);
  });
  it('對開的 B 邊沒有圓心（壞資料）→ 只列 A 邊；沒有機關 → 空的', () => {
    expect(arcCenterChoices([{ ...door, mirror: null }], null).map(x => x.label)).toEqual(['對開門']);
    expect(arcCenterChoices([], null)).toEqual([]);
  });
});

describe('resolveArcAxis：轉軸正負', () => {
  const pivot = { x: 0, y: 0, z: 10 }, center = { x: 0, y: 0, z: -10 };
  const want = (x: number) => ({ x, y: 0, z: 0 });
  const st = (over = {}) => ({ keepAxis: null, touched: false, down: false, want: want(1), ...over });

  it('還沒手動改過：照原本直線的方向自動挑（想往 +x → 朝下，想往 -x → 朝上）', () => {
    expect(resolveArcAxis(st(), pivot, center)).toEqual({ x: 0, y: -1, z: 0 });
    expect(resolveArcAxis(st({ want: want(-1) }), pivot, center)).toEqual({ x: 0, y: 1, z: 0 });
  });
  it('圓心或物件還沒有 → 先朝上', () => {
    expect(resolveArcAxis(st(), null, center)).toEqual({ x: 0, y: 1, z: 0 });
    expect(resolveArcAxis(st(), pivot, null)).toEqual({ x: 0, y: 1, z: 0 });
  });
  it('手動改過 / 編輯舊的：用存的正負，圓心跟著動也不亂跳', () => {
    expect(resolveArcAxis(st({ touched: true, down: true }), pivot, center)).toEqual({ x: 0, y: -1, z: 0 });
    expect(resolveArcAxis(st({ touched: true, down: false, want: want(1) }), pivot, center)).toEqual({ x: 0, y: 1, z: 0 });
  });
  it('已經存的轉軸不是垂直 → 原樣留著', () => {
    const tilted = { x: 0.6, y: 0.8, z: 0 };
    expect(resolveArcAxis(st({ keepAxis: tilted, touched: true }), pivot, center)).toEqual(tilted);
  });
});

describe('arcMoveWord：值變大往哪邊走（白話）', () => {
  const pivot = { x: 0, y: 0, z: 10 }, center = { x: 0, y: 0, z: -10 };
  it('轉軸朝下 → 往 +x（觀眾看過去的右邊）；朝上 → 往左', () => {
    expect(arcMoveWord(pivot, { x: 0, y: -1, z: 0 }, center, FRONT)).toBe('往右（觀眾看過去）');
    expect(arcMoveWord(pivot, { x: 0, y: 1, z: 0 }, center, FRONT)).toBe('往左（觀眾看過去）');
  });
  it('舞台正面不是 +Z 時，左右跟著換', () => {
    expect(arcMoveWord(pivot, { x: 0, y: -1, z: 0 }, center, { x: 0, y: 0, z: -1 })).toBe('往左（觀眾看過去）');
  });
  it('物件在圓心上 / 沒有物件或圓心 → null（畫面另外說）', () => {
    expect(arcMoveWord(pivot, { x: 0, y: 1, z: 0 }, { x: 0, y: 3, z: 10 }, FRONT)).toBeNull();
    expect(arcMoveWord(null, { x: 0, y: 1, z: 0 }, center, FRONT)).toBeNull();
    expect(arcMoveWord(pivot, { x: 0, y: 1, z: 0 }, null, FRONT)).toBeNull();
  });
});

describe('弧形機關在清單上的方向字', () => {
  it('弧形不說「上下」（轉軸是垂直的，但它是橫著走的）', () => {
    expect(directionWord({ kind: 'linear', axis: { x: 0, y: -1, z: 0 }, variant: 'arc' })).toBe('弧形');
    expect(directionWord({ kind: 'linear', axis: { x: 0, y: 1, z: 0 } })).toBe('上下');
  });
});
