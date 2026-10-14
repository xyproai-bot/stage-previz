// 機關 v2 第 2 階段：對開（兩邊往反方向）— 檢查規則、B 邊的鏡像算法、畫面上的動法（A 邊 / B 邊同一個位置）、機關總表兩行
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  MECH_MESSAGES, blankMechanismInput, mechanismToInput, mirrorForSplit, normalizeMechanismInput, reflectAcross, splitSideName,
  type Mechanism, type MechanismInput, type MechVec3,
} from './model';
import { applyChain, basePoseFromScene, compileRig, travelGeometry } from './pose';
import { buildMechanismSheetCsv, sheetLegend } from './cueSheet';

const near = (a: MechVec3, b: MechVec3, d = 9) => {
  expect(a.x).toBeCloseTo(b.x, d); expect(a.y).toBeCloseTo(b.y, d); expect(a.z).toBeCloseTo(b.z, d);
};
const ok = (raw: unknown, ctx = {}) => {
  const r = normalizeMechanismInput(raw, ctx);
  if (!r.ok) throw new Error('expected ok: ' + r.error);
  return r.value;
};
const err = (raw: unknown, ctx = {}) => {
  const r = normalizeMechanismInput(raw, ctx);
  if (r.ok) throw new Error('expected error');
  return r;
};

const door = (over: Partial<MechanismInput> = {}): MechanismInput => ({
  ...blankMechanismInput(), name: '對開 LED 門', axis: { x: -1, y: 0, z: 0 }, travelMin: 0, travelMax: 4,
  objectIds: ['l1', 'l2', 'r1'], variant: 'split', ...over,
});

describe('檢查對開的設定', () => {
  it('直線對開：沒給 B 邊 → 反方向；每個物件在哪一邊（沒寫 = A 邊，不是帶的物件略過）', () => {
    const v = ok({ ...door(), objectSides: { r1: 'b', l2: 'x', nobody: 'b' } });
    expect(v.variant).toBe('split');
    expect(v.mirror).toEqual({ axis: { x: 1, y: 0, z: 0 }, pivot: null, consoleLabel: null });
    expect(v.objectSides).toEqual({ l1: 'a', l2: 'a', r1: 'b' });
  });

  it('B 邊的控台編號（前後空白去掉、最多 40 字）', () => {
    const v = ok(door({ mirror: { axis: { x: 2, y: 0, z: 0 }, pivot: null, consoleLabel: '  Axis 8 ' } }));
    expect(v.mirror).toEqual({ axis: { x: 1, y: 0, z: 0 }, pivot: null, consoleLabel: 'Axis 8' });
  });

  it('旋轉對開：一定要有 B 邊的轉軸和轉軸中心，不然 field = mirror', () => {
    const rot = door({ kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: -2, y: 0, z: 0 }, travelMin: -90, travelMax: 90 });
    const bad = err(rot);
    expect(bad.field).toBe('mirror');
    expect(bad.error).toBe(MECH_MESSAGES.mirror);
    const noPivot = err({ ...rot, mirror: { axis: { x: 0, y: -1, z: 0 } } });
    expect(noPivot.field).toBe('mirror');
    expect(noPivot.error).toBe(MECH_MESSAGES.mirrorPivot);
    const good = ok({ ...rot, mirror: { axis: { x: 0, y: -1, z: 0 }, pivot: { x: 2, y: 0, z: 0 } } });
    expect(good.mirror).toEqual({ axis: { x: 0, y: -1, z: 0 }, pivot: { x: 2, y: 0, z: 0 }, consoleLabel: null });
  });

  it('改回一般機關：B 邊、邊都清掉；沒送的欄位用原本的（改名字不會動到對開）', () => {
    const base = ok({ ...door(), objectSides: { r1: 'b' } });
    expect(ok({ variant: null }, { existing: base })).toMatchObject({ variant: null, mirror: null, objectSides: {} });
    const renamed = ok({ name: '新名字' }, { existing: base });
    expect(renamed).toMatchObject({ variant: 'split', objectSides: { r1: 'b' }, mirror: { axis: { x: 1, y: 0, z: 0 } } });
    expect(mechanismToInput({ ...renamed, id: 'x', order: 0, cueCount: 0, updatedAt: '' } as Mechanism)).toEqual(renamed);
  });

  it('變化類型只能是對開', () => {
    const r = err({ ...door(), variant: 'wobble' });
    expect(r.field).toBe('variant');
  });

  it('對開的機關不能當別人的上層，也不能裝了別人之後才改成對開', () => {
    const siblings = [{ id: 'sp', name: '對開', parentId: null, variant: 'split' as const }, { id: 'tt', name: '轉台', parentId: null }];
    expect(err(door({ name: '升降台', variant: null, parentId: 'sp' }), { siblings }).error).toBe(MECH_MESSAGES.splitAsParent);
    expect(ok(door({ name: '升降台', variant: null, parentId: 'tt' }), { siblings })).toMatchObject({ parentId: 'tt' });
    // 對開可以裝在別的機關上（例：轉台上的對開門）
    expect(ok(door({ name: '轉台上的門', parentId: 'tt' }), { siblings })).toMatchObject({ parentId: 'tt', variant: 'split' });
    const withKid = [...siblings, { id: 'kid', name: '小弟', parentId: 'self' }];
    const r = err(door(), { siblings: withKid, selfId: 'self' });
    expect(r.field).toBe('variant');
    expect(r.error).toBe(MECH_MESSAGES.splitHasChildren);
  });

  it('一般機關完全不受影響：沒有 variant / mirror / 邊', () => {
    const v = ok({ ...blankMechanismInput(), name: '升降台' });
    expect(v).toMatchObject({ variant: null, mirror: null, objectSides: {} });
  });
});

describe('B 邊怎麼鏡像（mirrorForSplit）', () => {
  it('直線：方向反過來', () => {
    expect(mirrorForSplit('linear', { x: 1, y: 0, z: 0 }, null, null, null)).toEqual({ axis: { x: -1, y: 0, z: 0 }, pivot: null });
  });

  it('旋轉：左右兩扇門，轉軸在外側邊緣 → B 的轉軸反過來、轉軸中心在另一邊的外側（跟設計文件的 n = normalize(B 轉軸中心 − A 轉軸中心) 一致）', () => {
    // A 門 x ∈ [-4, 0]，B 門 x ∈ [0, 4]；A 的轉軸在左邊外緣 x = -4，往上
    const centerA = { x: -2, y: 1, z: 0 }, centerB = { x: 2, y: 1, z: 0 };
    const m = mirrorForSplit('rotary', { x: 0, y: 1, z: 0 }, { x: -4, y: 1, z: 0 }, centerA, centerB);
    near(m.axis, { x: 0, y: -1, z: 0 });
    near(m.pivot!, { x: 4, y: 1, z: 0 });
    // 設計文件的算法：n = normalize(pivotB − pivotA) = +X；−reflect(上, X) = −上
    const n = { x: 1, y: 0, z: 0 };
    near(m.axis, (() => { const r = reflectAcross({ x: 0, y: 1, z: 0 }, n); return { x: -r.x, y: -r.y, z: -r.z }; })());
  });

  it('旋轉：轉軸跟鏡面平行的分量反過來、垂直的分量不變（鏡射 + 轉動方向反過來）', () => {
    // 轉軸 = 前後（Z），鏡面法向量 = X（左右兩邊）：reflect 不改 Z，再取負 → −Z
    const m = mirrorForSplit('rotary', { x: 0, y: 0, z: 1 }, { x: -4, y: 0, z: 0 }, { x: -2, y: 0, z: 0 }, { x: 2, y: 0, z: 0 });
    near(m.axis, { x: 0, y: 0, z: -1 });
    // 轉軸 = 左右（X，跟鏡面垂直）：reflect 把 X 變 −X，再取負 → +X（兩邊是同一條軸同一個方向，B 邊的物件在另一頭）
    const m2 = mirrorForSplit('rotary', { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: -2, y: 0, z: 0 }, { x: 2, y: 0, z: 0 });
    near(m2.axis, { x: 1, y: 0, z: 0 });
  });

  it('兩邊中心重疊 / 不知道中心 → 轉軸反過來、轉軸中心跟 A 邊一樣', () => {
    const m = mirrorForSplit('rotary', { x: 0, y: 1, z: 0 }, { x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    near(m.axis, { x: 0, y: -1, z: 0 });
    near(m.pivot!, { x: 1, y: 2, z: 3 });
    expect(mirrorForSplit('rotary', { x: 0, y: 1, z: 0 }, null, null, null).pivot).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('名稱：「名稱（A 邊）」「名稱（B 邊）」', () => {
    expect(splitSideName('升降門', 'a')).toBe('升降門（A 邊）');
    expect(splitSideName('升降門', 'b')).toBe('升降門（B 邊）');
  });
});

const mech = (over: Partial<Mechanism> & Pick<Mechanism, 'id'>): Mechanism => ({
  name: over.id, kind: 'linear', axis: { x: 0, y: 1, z: 0 }, pivot: null, travelMin: -100, travelMax: 100,
  defaultValue: 0, maxSpeed: null, presets: [], parentId: null, objectIds: [], consoleLabel: null, order: 0,
  metadata: null, cueCount: 0, updatedAt: '', ...over,
});
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const shown = (rig: ReturnType<typeof compileRig>, id: string, values: Record<string, number>, pos: THREE.Vector3, quat = new THREE.Quaternion()) => {
  const op = new THREE.Vector3(), oq = new THREE.Quaternion();
  applyChain(rig.chains.get(id), values, pos, quat, op, oq);
  return { pos: op, quat: oq };
};
const saved = (rig: ReturnType<typeof compileRig>, id: string, values: Record<string, number>, pos: THREE.Vector3, quat = new THREE.Quaternion()) => {
  const op = new THREE.Vector3(), oq = new THREE.Quaternion();
  basePoseFromScene(rig.chains.get(id), values, pos, quat, op, oq);
  return { pos: op, quat: oq };
};

describe('對開在畫面上：A 邊、B 邊同一個位置，往反方向動', () => {
  // 左邊一片（A，往左 = −X）、右邊一片（B，往右）；每邊走 2 公尺 → 中間開 4 公尺
  const split = mech({
    id: 'door', variant: 'split', axis: { x: -1, y: 0, z: 0 }, mirror: { axis: { x: 1, y: 0, z: 0 }, pivot: null, consoleLabel: 'Axis 8' },
    objectIds: ['left', 'right'], objectSides: { left: 'a', right: 'b' },
  });

  for (const sc of [1, 2]) {
    it(`校準倍率 ×${sc}：值 2 → A 邊往左 2 公尺、B 邊往右 2 公尺；值 0 → 都在 cue 的位置`, () => {
      const rig = compileRig([split], sc);
      near(shown(rig, 'left', { door: 0 }, v3(-1, 0, 0)).pos, { x: -1, y: 0, z: 0 });
      near(shown(rig, 'left', { door: 2 }, v3(-1, 0, 0)).pos, { x: -1 - 2 / sc, y: 0, z: 0 });
      near(shown(rig, 'right', { door: 2 }, v3(1, 0, 0)).pos, { x: 1 + 2 / sc, y: 0, z: 0 });
      // 兩邊的間隙增加 2 × 2 公尺
      const gap = shown(rig, 'right', { door: 2 }, v3(1, 0, 0)).pos.x - shown(rig, 'left', { door: 2 }, v3(-1, 0, 0)).pos.x;
      expect(gap).toBeCloseTo(2 + 4 / sc, 9);
    });
  }

  it('補間 / 補位用的清單只有一個（每個位置只算一次），B 邊零件另外放；沒有 B 邊的物件鏈跟一般機關一樣', () => {
    const rig = compileRig([split, mech({ id: 'plain', objectIds: ['led'] })], 1);
    expect(rig.mechanisms.map(m => m.id)).toEqual(['door', 'plain']);
    expect(rig.byId.get('door')!.side).toBeUndefined();
    expect(rig.mirrors.get('door')!.side).toBe('b');
    expect(rig.mirrors.has('plain')).toBe(false);
    expect(rig.chains.get('left')![0]).toBe(rig.byId.get('door'));
    expect(rig.chains.get('right')![0]).toBe(rig.mirrors.get('door'));
    expect(rig.chains.get('led')![0]).toBe(rig.byId.get('plain'));
  });

  it('拖完存回去：用放手那一幀的值倒回去，A 邊、B 邊都剛好反過來（不會加兩次）', () => {
    const rig = compileRig([split], 1.6);
    const values = { door: 1.25 };
    for (const [id, cue] of [['left', v3(-3, 2, 1)], ['right', v3(3, 2, 1)]] as const) {
      const s = shown(rig, id, values, cue);
      // 往上拖 0.5 → 放手 → 存回去 → 重畫還在放手的地方
      const dropped = v3(s.pos.x, s.pos.y + 0.5, s.pos.z);
      const b = saved(rig, id, values, dropped);
      near(b.pos, { x: cue.x, y: cue.y + 0.5, z: cue.z });
      near(shown(rig, id, values, b.pos).pos, dropped);
    }
  });

  it('旋轉對開（兩扇門，轉軸在外側）：B 邊鏡像，同一個值 → 兩扇門往兩邊張開；存回去剛好反過來', () => {
    // A 門 x ∈ [-4, 0]，轉軸在 x = -4；B 門 x ∈ [0, 4]，轉軸在 x = 4；轉軸都是上下
    const m = mirrorForSplit('rotary', { x: 0, y: 1, z: 0 }, { x: -4, y: 0, z: 0 }, { x: -2, y: 0, z: 0 }, { x: 2, y: 0, z: 0 });
    const hinged = mech({
      id: 'doors', variant: 'split', kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: -4, y: 0, z: 0 },
      mirror: { axis: m.axis, pivot: m.pivot, consoleLabel: null }, travelMin: -180, travelMax: 180,
      objectIds: ['A', 'B'], objectSides: { A: 'a', B: 'b' },
    });
    const rig = compileRig([hinged], 1);
    // 門的中間邊（A 的 x = 0、B 的 x = 0）轉 90 度：A 轉到哪、B 轉到另一邊鏡像的位置
    const a = shown(rig, 'A', { doors: 90 }, v3(0, 0, 0));
    const b = shown(rig, 'B', { doors: 90 }, v3(0, 0, 0));
    // 繞 x = -4 的上下軸轉 90 度：(0,0,0) 相對轉軸是 (4,0,0) → 轉到 (0,0,∓4)
    // 繞 x = +4 反方向轉 90 度：(0,0,0) 相對轉軸是 (-4,0,0) → 轉到 (0,0,∓4)，而且跟 A 在同一邊（鏡像）
    expect(Math.abs(a.pos.z)).toBeCloseTo(4, 9);
    near(a.pos, { x: -4, y: 0, z: a.pos.z });
    near(b.pos, { x: 4, y: 0, z: a.pos.z });
    // 轉的角度大小一樣、方向相反
    const yawA = new THREE.Euler().setFromQuaternion(a.quat, 'YXZ').y;
    const yawB = new THREE.Euler().setFromQuaternion(b.quat, 'YXZ').y;
    expect(yawA).toBeCloseTo(-yawB, 9);
    // 存回去
    for (const [id, s] of [['A', a], ['B', b]] as const) {
      const back = saved(rig, id, { doors: 90 }, s.pos, s.quat);
      near(back.pos, { x: 0, y: 0, z: 0 });
      expect(Math.abs(back.quat.w)).toBeCloseTo(1, 9);
    }
  });

  it('對開裝在轉台上（對開有上層機關）：A、B 邊的鏈都接到轉台', () => {
    const turn = mech({ id: 'turn', kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: 0, y: 0, z: 0 } });
    const rig = compileRig([turn, { ...split, parentId: 'turn' }], 1);
    expect(rig.chains.get('left')!.map(m => m.id)).toEqual(['door', 'turn']);
    expect(rig.chains.get('right')!.map(m => m.id)).toEqual(['door', 'turn']);
    const r = shown(rig, 'right', { door: 2, turn: 90 }, v3(1, 0, 0));
    // 先往右 2 公尺（x = 3），再繞轉台 90 度
    const expected = v3(3, 0, 0).applyAxisAngle(v3(0, 1, 0), Math.PI / 2);
    near(r.pos, expected);
  });

  it('管理頁畫行程：B 邊零件有自己的方向', () => {
    const rig = compileRig([split], 1);
    const a = travelGeometry(rig.byId.get('door')!, v3(-1, 0, 0), 1, []);
    const b = travelGeometry(rig.mirrors.get('door')!, v3(1, 0, 0), 1, []);
    expect(a.path[1].x).toBeLessThan(a.path[0].x);   // 往左
    expect(b.path[1].x).toBeGreaterThan(b.path[0].x); // 往右
  });
});

describe('機關總表：對開寫兩行（各自的名稱和控台編號）', () => {
  const door2 = mech({
    id: 'door', name: '升降門', variant: 'split', axis: { x: -1, y: 0, z: 0 }, travelMin: 0, travelMax: 4, maxSpeed: 0.5,
    consoleLabel: 'Axis 7', mirror: { axis: { x: 1, y: 0, z: 0 }, pivot: null, consoleLabel: 'Axis 8' },
    objectIds: ['a', 'b'], objectSides: { a: 'a', b: 'b' },
  });
  const song = { id: 's', name: '夜曲', code: null, order: 0, cues: [
    { id: 'c1', name: '關', order: 0, videoTimeSec: 0, crossfadeSeconds: 0 },
    { id: 'c2', name: '開', order: 1, videoTimeSec: 10, crossfadeSeconds: 10 },
  ] };
  const positions = [{ cueId: 'c2', mechanismId: 'door', value: 2, updatedAt: '' }];

  it('每個 cue 每個對開兩行；兩行的數字和檢查一樣', () => {
    const lines = buildMechanismSheetCsv({ songs: [song], positions, mechanisms: [door2], front: { x: 0, y: 0, z: 1 } })
      .replace(/^﻿/, '').split('\r\n');
    const rows = lines.filter(l => l.startsWith('夜曲,'));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain(',升降門（A 邊）,Axis 7,');
    expect(rows[1]).toContain(',升降門（B 邊）,Axis 8,');
    expect(rows[2]).toContain(',升降門（A 邊）,Axis 7,0.000,2.000,m,');
    expect(rows[3]).toContain(',升降門（B 邊）,Axis 8,0.000,2.000,m,');
    // 數字和檢查欄位一樣（只有名稱和控台編號不同）
    const strip = (r: string) => r.replace('（A 邊）,Axis 7', '').replace('（B 邊）,Axis 8', '');
    expect(strip(rows[2])).toBe(strip(rows[3]));
  });

  it('機關說明：A 邊、B 邊各一行，B 邊寫鏡像的方向；一般機關的說明不變', () => {
    const legend = sheetLegend([door2], { x: 0, y: 0, z: 1 });
    expect(legend).toHaveLength(4);
    expect(legend[1]).toContain('升降門（A 邊）（Axis 7）：直線，0 = cue 裡原本的位置，正的數字往左（觀眾看過去）');
    expect(legend[2]).toContain('升降門（B 邊）（Axis 8）：直線，0 = cue 裡原本的位置，正的數字往右（觀眾看過去）');
    expect(legend[1]).toContain('對開：A 邊、B 邊同一個數字，往反方向動');
    expect(legend[1]).toContain('行程 0 m ~ 4 m；最高 0.5 m/秒');
  });

  it('翻轉的說明寫選的邊緣和正的角度', () => {
    const flip = mech({
      id: 'flip', name: '翻板', kind: 'rotary', axis: { x: 1, y: 0, z: 0 }, pivot: { x: 0, y: 3, z: 0 }, travelMin: 0, travelMax: 90,
      metadata: { setup: { hinge: 'top', positive: 'second' } },
    });
    expect(sheetLegend([flip])[1]).toContain('翻板：旋轉・沿著上緣翻，0 = 模型原本的方向，正的角度下緣往後翻');
  });
});
