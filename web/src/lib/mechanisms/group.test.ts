// 一排機關（機關 v2 第 3 階段）：編號順序、一次建立的檢查、共用設定、清單怎麼排、一次寫很多個位置的內容檢查
import { describe, expect, it } from 'vitest';
import {
  flattenLayout, groupMembers, layoutMechanisms, maxPrefixLength, memberName, moveLayoutItem, orderForNumbering, parseBulkPositions,
  planBatch, planGroupPatch, valueRange,
} from './group';
import { blankMechanismInput, mechanismToInput, type Mechanism, type MechanismGroup, type MechVec3 } from './model';
import { parseGroup, parseMechanism } from './mechanismApi';

const front: MechVec3 = { x: 0, y: 0, z: 1 };   // 觀眾在 +Z；觀眾看過去的右手邊 = +X 的相反（上 × 正面）
const mech = (patch: Partial<Mechanism> & { id: string; name: string }): Mechanism => ({
  ...mechanismToInput({ ...blankMechanismInput(), travelMax: 3 }), cueCount: 0, order: 0, updatedAt: '', groupId: null, groupIndex: null, ...patch,
});
const group = (id: string, name: string): MechanismGroup => ({ id, name, order: 0, settings: null, updatedAt: '' });

describe('編號順序', () => {
  // 觀眾看過去的右手邊 = up × front = (0,1,0)×(0,0,1) = (1,0,0)
  const c = (x: number, z = 0): MechVec3 => ({ x, y: 0, z });
  const centers = { a: c(2), b: c(-1), d: c(0.5), e: undefined };

  it('從左到右 / 從右到左', () => {
    expect(orderForNumbering(['a', 'b', 'd'], centers, 'leftToRight', front)).toEqual(['b', 'd', 'a']);
    expect(orderForNumbering(['a', 'b', 'd'], centers, 'rightToLeft', front)).toEqual(['a', 'd', 'b']);
  });
  it('從前到後：最靠近觀眾（+Z）的是 1', () => {
    const cs = { a: c(0, 1), b: c(0, 5), d: c(0, -3) };
    expect(orderForNumbering(['a', 'b', 'd'], cs, 'frontToBack', front)).toEqual(['b', 'a', 'd']);
  });
  it('照選取順序不動；位置一樣、找不到位置的照選取順序排在後面', () => {
    expect(orderForNumbering(['a', 'b', 'd'], centers, 'selection', front)).toEqual(['a', 'b', 'd']);
    expect(orderForNumbering(['e', 'a', 'b'], centers, 'leftToRight', front)).toEqual(['b', 'a', 'e']);
    expect(orderForNumbering(['x', 'y', 'z'], { x: c(1), y: c(1), z: c(0) }, 'leftToRight', front)).toEqual(['z', 'x', 'y']);
  });
  it('名稱：開頭 + 空格 + 編號；開頭最多幾個字', () => {
    expect(memberName('LED 升降', 0)).toBe('LED 升降 1');
    expect(memberName('  LED  ', 7)).toBe('LED 8');
    expect(maxPrefixLength(8)).toBe(38);
    expect(maxPrefixLength(64)).toBe(37);
  });
});

describe('一次建立 N 個機關（planBatch）', () => {
  const base = { kind: 'linear', axis: { x: 0, y: 1, z: 0 }, travelMin: 0, travelMax: 3, maxSpeed: 0.5 };
  const objs = new Set(['o1', 'o2', 'o3', 'o4']);
  const ok = (raw: unknown, ctx = {}) => {
    const r = planBatch(raw, { projectObjectIds: objs, ...ctx });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const err = (raw: unknown, ctx = {}) => {
    const r = planBatch(raw, { projectObjectIds: objs, ...ctx });
    if (r.ok) throw new Error('應該要失敗');
    return r;
  };

  it('一個物件一個機關，照順序編號，共用同一份設定', () => {
    const v = ok({ base, objectIds: ['o3', 'o1', 'o2'], namePrefix: 'LED 升降', numbering: 'rightToLeft' });
    expect(v.groupName).toBe('LED 升降');
    expect(v.settings).toEqual({ namePrefix: 'LED 升降', numbering: 'rightToLeft' });
    expect(v.members.map(m => m.name)).toEqual(['LED 升降 1', 'LED 升降 2', 'LED 升降 3']);
    expect(v.members.map(m => m.objectIds)).toEqual([['o3'], ['o1'], ['o2']]);
    expect(v.members.every(m => m.travelMax === 3 && m.maxSpeed === 0.5 && m.variant === null && m.consoleLabel === null)).toBe(true);
  });
  it('沒給排名 → 用名稱開頭；不認得的編號順序不記', () => {
    const v = ok({ base, objectIds: ['o1', 'o2'], namePrefix: '前緣', numbering: '亂寫' });
    expect(v.groupName).toBe('前緣');
    expect(v.settings).toEqual({ namePrefix: '前緣' });
  });
  it('每個物件可以有自己的轉軸（沿著邊緣翻）；沒給的用共用的', () => {
    const rot = { kind: 'rotary', axis: { x: 1, y: 0, z: 0 }, pivot: { x: 0, y: 0, z: 0 }, travelMin: 0, travelMax: 90, metadata: { setup: { hinge: 'top', positive: 'first' } } };
    const v = ok({ base: rot, objectIds: ['o1', 'o2', 'o3'], namePrefix: '翻板', overrides: { o1: { pivot: { x: 1, y: 3, z: 0 } }, o2: { axis: { x: -1, y: 0, z: 0 }, pivot: { x: 2, y: 3, z: 0 } } } });
    expect(v.members.map(m => m.pivot)).toEqual([{ x: 1, y: 3, z: 0 }, { x: 2, y: 3, z: 0 }, { x: 0, y: 0, z: 0 }]);
    expect(v.members.map(m => m.axis.x)).toEqual([1, -1, 1]);
    expect(v.members.every(m => (m.metadata as { setup: { hinge: string } }).setup.hinge === 'top')).toBe(true);
  });
  it('至少 2 個、最多 64 個、物件要在這個專案裡', () => {
    expect(err({ base, objectIds: ['o1'], namePrefix: 'x' }).error).toBe('一排至少要 2 個機關，請多選幾個物件');
    expect(err({ base, objectIds: [], namePrefix: 'x' }).field).toBe('objectIds');
    expect(err({ base, objectIds: ['o1', 'o1'], namePrefix: 'x' }).field).toBe('objectIds');   // 重複的算一個
    const many = Array.from({ length: 65 }, (_, i) => `o${i}`);
    expect(err({ base, objectIds: many, namePrefix: 'x' }, { projectObjectIds: new Set(many) }).error).toBe('一次最多建立 64 個機關');
    expect(err({ base, objectIds: ['o1', 'zz'], namePrefix: 'x' }).error).toBe('有物件不在這個專案裡');
  });
  it('名稱：不能空白、太長、跟現有機關或現有的一排重複', () => {
    expect(err({ base, objectIds: ['o1', 'o2'], namePrefix: '  ' }).field).toBe('namePrefix');
    expect(err({ base, objectIds: ['o1', 'o2'], namePrefix: '長'.repeat(39) }).error).toBe('名稱開頭太長了（最多 38 個字，後面還要接編號）');
    const sibs = [{ id: 'x', name: 'LED 1', parentId: null }];
    expect(err({ base, objectIds: ['o1', 'o2'], namePrefix: 'LED' }, { siblings: sibs }).error).toBe('這個專案已經有叫「LED 1」的機關');
    expect(err({ base, objectIds: ['o1', 'o2'], namePrefix: 'LED', groupName: '前排' }, { groupNames: ['前排'] }).error).toBe('這個專案已經有叫「前排」的一排機關');
    expect(err({ base, objectIds: ['o1', 'o2'], namePrefix: 'LED', groupName: '長'.repeat(41) }).field).toBe('groupName');
  });
  it('不能是對開；設定不合理的話跟單獨新增同樣的訊息', () => {
    expect(err({ base: { ...base, variant: 'split' }, objectIds: ['o1', 'o2'], namePrefix: 'x' }).error).toBe('一次建立的機關不能是對開，請一個一個設定');
    expect(err({ base: { ...base, travelMax: -1 }, objectIds: ['o1', 'o2'], namePrefix: 'x' }).error).toBe('行程的最高要比最低大');
    expect(err({ base: { ...base, maxSpeed: -2 }, objectIds: ['o1', 'o2'], namePrefix: 'x' }).field).toBe('maxSpeed');
    expect(err({ base: { ...base, parentId: 'nope' }, objectIds: ['o1', 'o2'], namePrefix: 'x' }).field).toBe('parentId');
  });
  it('可以裝在一個轉台上（跟著另一個機關動）', () => {
    const v = ok({ base: { ...base, parentId: 'deck' }, objectIds: ['o1', 'o2'], namePrefix: 'x' }, { siblings: [{ id: 'deck', name: '轉台', parentId: null }] });
    expect(v.members.every(m => m.parentId === 'deck')).toBe(true);
  });
});

describe('這一排的共用設定（planGroupPatch）', () => {
  const members = [mech({ id: 'a', name: 'L1', groupId: 'g', groupIndex: 0 }), mech({ id: 'b', name: 'L2', groupId: 'g', groupIndex: 1, travelMax: 2 })];
  it('共用設定每個成員都改成一樣；沒送的欄位各自保留', () => {
    const r = planGroupPatch({ travelMax: 5, maxSpeed: 0.25 }, members);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.name).toBeNull();
    expect(r.value.shared).toBe(true);
    expect(r.value.members.map(m => [m.id, m.input.travelMax, m.input.maxSpeed, m.input.travelMin])).toEqual([['a', 5, 0.25, 0], ['b', 5, 0.25, 0]]);
    expect(r.value.members.map(m => m.input.name)).toEqual(['L1', 'L2']);   // 名字不跟著改
  });
  it('只改名字 → 不動成員；名字不能空白、重複', () => {
    const r = planGroupPatch({ name: '  前排  ' }, members);
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toEqual({ name: '前排', shared: false, members: [] });
    expect(planGroupPatch({ name: ' ' }, members)).toMatchObject({ ok: false, field: 'groupName' });
    expect(planGroupPatch({ name: '後排' }, members, { otherGroupNames: ['後排'] })).toMatchObject({ ok: false, error: '這個專案已經有叫「後排」的一排機關' });
  });
  it('行程不合理 → 整批不改', () => {
    expect(planGroupPatch({ travelMin: 4, travelMax: 1 }, members)).toMatchObject({ ok: false, field: 'travel' });
  });
  it('常用位置 / 預設位置夾在行程內', () => {
    const r = planGroupPatch({ travelMax: 1, defaultValue: 2, presets: [{ name: '全開', value: 9 }] }, members);
    if (!r.ok) throw new Error(r.error);
    expect(r.value.members[0].input.defaultValue).toBe(1);
    expect(r.value.members[0].input.presets).toEqual([{ name: '全開', value: 1 }]);
  });
});

describe('清單怎麼排', () => {
  const g1 = group('g1', '前排'), g2 = group('g2', '後排');
  const list = [
    mech({ id: 's1', name: '轉台' }),
    mech({ id: 'a2', name: 'F2', groupId: 'g1', groupIndex: 1 }),
    mech({ id: 'a1', name: 'F1', groupId: 'g1', groupIndex: 0 }),
    mech({ id: 's2', name: '布幕' }),
    mech({ id: 'b1', name: 'B1', groupId: 'g2', groupIndex: 0 }),
    mech({ id: 'a3', name: 'F3', groupId: 'g1', groupIndex: 2 }),
  ];
  it('一排排在第一個成員的位置，成員接在後面、照編號排', () => {
    const items = layoutMechanisms(list, [g1, g2]);
    expect(items.map(i => (i.type === 'single' ? i.mech.id : `${i.group.id}[${i.members.map(m => m.id).join(',')}]`)))
      .toEqual(['s1', 'g1[a1,a2,a3]', 's2', 'g2[b1]']);
    expect(flattenLayout(items)).toEqual(['s1', 'a1', 'a2', 'a3', 's2', 'b1']);
    expect(groupMembers(list, 'g1').map(m => m.id)).toEqual(['a1', 'a2', 'a3']);
  });
  it('舊後台（沒有 groups）、指到不存在的一排 → 當一個一個普通機關', () => {
    expect(layoutMechanisms(list, []).every(i => i.type === 'single')).toBe(true);
    expect(layoutMechanisms(list, []).length).toBe(6);
    expect(layoutMechanisms(list, [g2]).map(i => i.type)).toEqual(['single', 'single', 'single', 'single', 'group', 'single']);
  });
  it('上移 / 下移一項：整排一起移，不會被拆開；最上 / 最下 → null', () => {
    const items = layoutMechanisms(list, [g1, g2]);
    expect(moveLayoutItem(items, 1, 1)).toEqual(['s1', 's2', 'a1', 'a2', 'a3', 'b1']);
    expect(moveLayoutItem(items, 2, -1)).toEqual(['s1', 's2', 'a1', 'a2', 'a3', 'b1']);
    expect(moveLayoutItem(items, 0, -1)).toBeNull();
    expect(moveLayoutItem(items, 3, 1)).toBeNull();
  });
  it('位置範圍', () => {
    expect(valueRange([1.5, 0.5, 2])).toEqual({ min: 0.5, max: 2 });
    expect(valueRange([])).toBeNull();
  });
});

describe('一次寫很多個 cue 位置的內容（parseBulkPositions）', () => {
  it('位置 + 延遲 + 走幾秒；null = 回到沿用 / 跟著 cue；沒放 = 不改', () => {
    const r = parseBulkPositions({ items: [
      { mechanismId: 'a', value: 1.5, delaySec: 0.5 },
      { mechanismId: 'b', value: '2' },
      { mechanismId: 'c', value: null },
      { mechanismId: 'd', value: 0, delaySec: null, durationSec: 8 },
    ] });
    expect(r).toEqual({ ok: true, items: [
      { mechanismId: 'a', value: 1.5, delaySec: 0.5 },
      { mechanismId: 'b', value: 2 },
      { mechanismId: 'c', value: null },
      { mechanismId: 'd', value: 0, delaySec: null, durationSec: 8 },
    ] });
  });
  it('壞內容：沒有列、太多列、重複、不是數字、秒數超出', () => {
    const bad = (raw: unknown) => { const r = parseBulkPositions(raw); return r.ok ? null : r; };
    expect(bad({})).toMatchObject({ field: 'items' });
    expect(bad({ items: [] })).toMatchObject({ field: 'items' });
    expect(bad({ items: Array.from({ length: 201 }, (_, i) => ({ mechanismId: `m${i}`, value: 0 })) })?.error).toBe('一次最多設定 200 個機關的位置');
    expect(bad({ items: Array.from({ length: 200 }, (_, i) => ({ mechanismId: `m${i}`, value: 0 })) })).toBeNull();
    expect(bad({ items: [{ mechanismId: 'a', value: 1 }, { mechanismId: 'a', value: 2 }] })?.error).toBe('同一個機關在這一次只能出現一次');
    expect(bad({ items: [{ mechanismId: 'a', value: 'x' }] })).toMatchObject({ field: 'value', error: '位置要是數字' });
    expect(bad({ items: [{ mechanismId: 'a' }] })).toMatchObject({ field: 'value' });   // 沒給 value 不是「不改」，要明確 null
    expect(bad({ items: [{ mechanismId: 'a', value: 1, delaySec: 3601 }] })).toMatchObject({ field: 'delaySec' });
    expect(bad({ items: [{ mechanismId: 'a', value: 1, durationSec: -1 }] })).toMatchObject({ field: 'durationSec' });
    expect(bad({ items: [{ mechanismId: '壞 id', value: 1 }] })).toMatchObject({ field: 'items' });
    expect(bad({ items: ['a'] })).toMatchObject({ field: 'items' });
  });
});

describe('讀後台回來的一排（舊後台沒有這兩欄）', () => {
  it('機關沒有 groupId / groupIndex → 不在任何一排裡', () => {
    const m = parseMechanism({ id: 'm', name: 'x', kind: 'linear', travelMin: 0, travelMax: 1 });
    expect(m.groupId).toBeNull();
    expect(m.groupIndex).toBeNull();
    const g = parseMechanism({ id: 'm', name: 'x', kind: 'linear', travelMin: 0, travelMax: 1, groupId: 'g1', groupIndex: 2 });
    expect([g.groupId, g.groupIndex]).toEqual(['g1', 2]);
  });
  it('一排：壞掉的 settings 不會讓畫面掛掉', () => {
    expect(parseGroup({ id: 'g', name: '前排', order: 1, settings: { namePrefix: 'LED', numbering: 'selection' } }).settings)
      .toEqual({ namePrefix: 'LED', numbering: 'selection' });
    expect(parseGroup({ id: 'g', name: '前排', settings: { numbering: '亂寫' } }).settings).toBeNull();
    expect(parseGroup({ id: 'g', name: '前排', settings: 'not an object' }).settings).toBeNull();
    expect(parseGroup(null).id).toBe('');
  });
});
