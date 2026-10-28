// 對開拆成兩個各自動的機關（docs/superpowers/specs/2026-10-29-director-stage-control-design.md 3.4）：
//   最重要的一條：拆完每個 cue 的畫面一模一樣 —— 拆之前（compileRig 對開，A / B 邊同一個 id）和拆之後（兩個機關，B 邊的值抄 A 邊的），
//   對同一組 values，每個物件的 applyChain 位置 / 角度一樣。
//   另外：預設名字、改名字的檢查、B 邊的定義（方向 / 轉軸中心用 mirror 的，其他照抄）。
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { Mechanism, MechanismSibling } from './model';
import { compileRig, applyChain } from './pose';
import { defaultUnsplitNames, planUnsplit, unsplitMechanisms, UNSPLIT_MESSAGES } from './unsplit';

const mech = (over: Partial<Mechanism> & Pick<Mechanism, 'id'>): Mechanism => ({
  name: over.id, kind: 'linear', axis: { x: 0, y: 1, z: 0 }, pivot: null, travelMin: -100, travelMax: 100,
  defaultValue: 0, maxSpeed: null, presets: [], parentId: null, objectIds: [], consoleLabel: null, order: 0,
  metadata: null, cueCount: 0, updatedAt: '', ...over,
});

const turntable = mech({
  id: 'turn', name: '轉台', kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: 1, y: 0, z: -2 }, travelMin: -360, travelMax: 360, objectIds: ['stage'],
});
/** 直線對開：A 邊往 -X、B 邊往 +X，裝在轉台上，行程 0~4 */
const linearSplit = mech({
  id: 'doors', name: '側面 LED', kind: 'linear', variant: 'split', axis: { x: -1, y: 0, z: 0 }, travelMin: 0, travelMax: 4, defaultValue: 1,
  presets: [{ name: '半開', value: 2 }, { name: '全開', value: 4 }], parentId: 'turn', consoleLabel: 'Axis 7',
  mirror: { axis: { x: 1, y: 0, z: 0 }, pivot: null, consoleLabel: 'Axis 8' },
  objectIds: ['l1', 'l2', 'r1', 'r2'], objectSides: { l1: 'a', l2: 'a', r1: 'b', r2: 'b' },
});
/** 旋轉對開（兩片門繞各自的門軸）：B 邊的轉軸中心在另一邊、轉軸反過來 */
const rotarySplit = mech({
  id: 'gate', name: '對開門', kind: 'rotary', variant: 'split', axis: { x: 0, y: 1, z: 0 }, pivot: { x: -4, y: 0, z: 2 }, travelMin: -90, travelMax: 90,
  presets: [{ name: '全開', value: 90 }], parentId: 'turn',
  mirror: { axis: { x: 0, y: -1, z: 0 }, pivot: { x: 4, y: 0, z: 2 }, consoleLabel: null },
  objectIds: ['gl', 'gr', 'gl2'], objectSides: { gl: 'a', gr: 'b', gl2: 'a' },
});

const sibs = (list: Mechanism[]): MechanismSibling[] => list.map(m => ({ id: m.id, name: m.name, parentId: m.parentId, variant: m.variant ?? null }));

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const eul = (p: number, y: number, r: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(
  THREE.MathUtils.degToRad(p), THREE.MathUtils.degToRad(y), THREE.MathUtils.degToRad(r)));
const BASES = [
  { pos: v3(0, 0, 0), quat: new THREE.Quaternion() },
  { pos: v3(-3.2, 1.5, 4), quat: eul(10, 20, 30) },
  { pos: v3(5, -0.25, -7.5), quat: eul(-40, 135, 5) },
];

function shown(rig: ReturnType<typeof compileRig>, id: string, values: Record<string, number>, base: typeof BASES[number]) {
  const op = new THREE.Vector3(), oq = new THREE.Quaternion();
  applyChain(rig.chains.get(id), values, base.pos.clone(), base.quat.clone(), op, oq);
  return { pos: op, quat: oq };
}

describe('拆開：每個 cue 的畫面一模一樣（compileRig 對開 vs 兩個機關）', () => {
  const cases: { title: string; split: Mechanism; sets: Record<string, number>[] }[] = [
    {
      title: '直線對開（裝在轉台上）',
      split: linearSplit,
      // 空的 = 都用預設位置；其他的 = 這個 cue 存的位置（含超出行程要夾住的、0、負的），轉台轉到不同角度
      sets: [{}, { doors: 0 }, { doors: 3.5 }, { doors: 4, turn: 90 }, { doors: 99, turn: -135.5 }, { doors: -2 }, { turn: 45 }],
    },
    {
      title: '旋轉對開（兩片門各繞各的門軸，裝在轉台上）',
      split: rotarySplit,
      sets: [{}, { gate: 0 }, { gate: 90 }, { gate: -37.5, turn: 20 }, { gate: 500, turn: 360 }, { turn: -200 }],
    },
  ];

  for (const sc of [1, 1.6]) {
    for (const c of cases) {
      it(`${c.title}，測距校準 ×${sc}`, () => {
        const all = [turntable, c.split];
        const before = compileRig(all, sc);
        const plan = planUnsplit(c.split, {}, sibs(all));
        if (!plan.ok) throw new Error(plan.error);
        const { a, b } = unsplitMechanisms(c.split, plan.value, 'new_b');
        // 拆完是兩個一般機關
        expect(a.variant ?? null).toBeNull();
        expect(b.variant ?? null).toBeNull();
        const after = compileRig([turntable, a, b], sc);
        const objects = [...c.split.objectIds, 'stage'];
        for (const values of c.sets) {
          // 每個 cue 存的位置：A 的值原樣抄一份給 B（沒設 = 兩個都用預設位置，預設也抄了）
          const afterValues = { ...values };
          if (c.split.id in values) afterValues['new_b'] = values[c.split.id];
          for (const id of objects) {
            for (const base of BASES) {
              const s0 = shown(before, id, values, base);
              const s1 = shown(after, id, afterValues, base);
              expect(s1.pos.distanceTo(s0.pos), `${id} ${JSON.stringify(values)} 位置`).toBeLessThan(1e-9);
              expect(Math.abs(s1.quat.dot(s0.quat)), `${id} ${JSON.stringify(values)} 角度`).toBeGreaterThan(1 - 1e-12);
            }
          }
        }
      });
    }
  }

  it('B 邊的物件掛在 B、A 邊的物件掛在 A，沒有物件掉了或重複', () => {
    const plan = planUnsplit(linearSplit, {}, sibs([turntable, linearSplit]));
    if (!plan.ok) throw new Error(plan.error);
    const { a, b } = unsplitMechanisms(linearSplit, plan.value, 'new_b');
    expect(a.objectIds).toEqual(['l1', 'l2']);
    expect(b.objectIds).toEqual(['r1', 'r2']);
    expect([...a.objectIds, ...b.objectIds].sort()).toEqual([...linearSplit.objectIds].sort());
    const rig = compileRig([turntable, a, b], 1);
    expect(rig.chains.get('l1')?.map(m => m.id)).toEqual(['doors', 'turn']);
    expect(rig.chains.get('r2')?.map(m => m.id)).toEqual(['new_b', 'turn']);
  });
});

describe('拆開的內容', () => {
  it('B 邊：方向 / 轉軸中心用 mirror 的，行程 / 預設 / 常用位置 / 上層照抄，控台編號用 mirror 的；A 邊去掉對開、改名「原名 A」', () => {
    const plan = planUnsplit(linearSplit, {}, sibs([turntable, linearSplit]));
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.nameA).toBe('側面 LED A');
    expect(plan.value.nameB).toBe('側面 LED B');
    const { a, b } = unsplitMechanisms(linearSplit, plan.value, 'new_b');
    expect(a).toMatchObject({ id: 'doors', name: '側面 LED A', variant: null, mirror: null, objectSides: {}, axis: { x: -1, y: 0, z: 0 }, consoleLabel: 'Axis 7', parentId: 'turn' });
    expect(b).toMatchObject({
      id: 'new_b', name: '側面 LED B', kind: 'linear', variant: null, mirror: null, objectSides: {}, axis: { x: 1, y: 0, z: 0 }, pivot: null,
      travelMin: 0, travelMax: 4, defaultValue: 1, maxSpeed: null, parentId: 'turn', consoleLabel: 'Axis 8',
    });
    expect(b.presets).toEqual(linearSplit.presets);
    // 旋轉：轉軸和轉軸中心
    const rp = planUnsplit(rotarySplit, {}, sibs([turntable, rotarySplit]));
    if (!rp.ok) throw new Error(rp.error);
    const r = unsplitMechanisms(rotarySplit, rp.value, 'new_b');
    expect(r.a.pivot).toEqual({ x: -4, y: 0, z: 2 });
    expect(r.b.axis).toEqual({ x: 0, y: -1, z: 0 });
    expect(r.b.pivot).toEqual({ x: 4, y: 0, z: 2 });
    expect(r.b.kind).toBe('rotary');
  });

  it('翻轉的設定（metadata.setup）只留在 A 邊，B 邊不抄（B 的轉軸是 mirror 的，不能被照外框重新算）', () => {
    const withSetup = mech({ ...rotarySplit, metadata: { setup: { hinge: 'left', positive: 'first' }, note: 'x' } });
    const plan = planUnsplit(withSetup, {}, sibs([turntable, withSetup]));
    if (!plan.ok) throw new Error(plan.error);
    const { a, b } = unsplitMechanisms(withSetup, plan.value, 'new_b');
    expect(a.metadata).toEqual({ setup: { hinge: 'left', positive: 'first' }, note: 'x' });
    expect(b.metadata).toEqual({ note: 'x' });
    expect(plan.value.b.metadata).toEqual({ note: 'x' });
    const onlySetup = mech({ ...rotarySplit, metadata: { setup: { hinge: 'top', positive: 'second' } } });
    const p2 = planUnsplit(onlySetup, {}, sibs([turntable, onlySetup]));
    if (!p2.ok) throw new Error(p2.error);
    expect(p2.value.b.metadata).toBeNull();
  });

  it('不是對開 → 「這個機關不是對開」', () => {
    const plain = mech({ id: 'p', name: '升降台', objectIds: ['o'] });
    const r = planUnsplit(plain, {}, sibs([plain]));
    expect(r).toEqual({ ok: false, error: UNSPLIT_MESSAGES.notSplit, field: 'variant' });
    expect(UNSPLIT_MESSAGES.notSplit).toBe('這個機關不是對開');
    const arc = mech({ id: 'arc', name: '橫移', variant: 'arc', pivot: { x: 0, y: 0, z: 1 }, arcRadius: 5 });
    expect(planUnsplit(arc, {}, sibs([arc]))).toMatchObject({ ok: false, error: '這個機關不是對開' });
    // 對開但 B 邊資料壞掉（讀不到 mirror）也不是對開
    const broken = mech({ ...linearSplit, mirror: null });
    expect(planUnsplit(broken, {}, sibs([broken]))).toMatchObject({ ok: false, error: '這個機關不是對開' });
  });
});

describe('名字', () => {
  const all = [turntable, linearSplit];
  it('預設「原名 A」「原名 B」；原名太長就把原名縮短（整個名字最多 40 字）', () => {
    expect(defaultUnsplitNames('側面 LED')).toEqual({ a: '側面 LED A', b: '側面 LED B' });
    expect(defaultUnsplitNames('  對開門  ')).toEqual({ a: '對開門 A', b: '對開門 B' });
    const long = 'x'.repeat(40);
    const d = defaultUnsplitNames(long);
    expect(d.a.length).toBe(40);
    expect(d.a.endsWith(' A')).toBe(true);
    expect(d.b.endsWith(' B')).toBe(true);
  });

  it('可以自己改名字（前後空白去掉）；也可以只改一邊', () => {
    const r = planUnsplit(linearSplit, { nameA: ' 左門 ', nameB: '右門' }, sibs(all));
    expect(r.ok && [r.value.nameA, r.value.nameB]).toEqual(['左門', '右門']);
    const one = planUnsplit(linearSplit, { nameB: '右邊那組' }, sibs(all));
    expect(one.ok && [one.value.nameA, one.value.nameB]).toEqual(['側面 LED A', '右邊那組']);
    // 有給 null 當作沒給
    const nul = planUnsplit(linearSplit, { nameA: null, nameB: null }, sibs(all));
    expect(nul.ok && nul.value.nameA).toBe('側面 LED A');
  });

  it('空白 / 不是文字 / 太長 / 兩個一樣 / 跟別的機關重複 → 錯誤和欄位；A 的名字可以沿用自己原本的', () => {
    expect(planUnsplit(linearSplit, { nameA: '  ' }, sibs(all))).toEqual({ ok: false, error: '機關名稱不能空白', field: 'nameA' });
    expect(planUnsplit(linearSplit, { nameB: '' }, sibs(all))).toEqual({ ok: false, error: '機關名稱不能空白', field: 'nameB' });
    expect(planUnsplit(linearSplit, { nameA: 5 }, sibs(all))).toMatchObject({ ok: false, field: 'nameA' });
    expect(planUnsplit(linearSplit, { nameA: '門', nameB: '門' }, sibs(all))).toEqual({ ok: false, error: '這個專案已經有叫「門」的機關', field: 'nameB' });
    expect(planUnsplit(linearSplit, { nameA: '轉台' }, sibs(all))).toEqual({ ok: false, error: '這個專案已經有叫「轉台」的機關', field: 'nameA' });
    expect(planUnsplit(linearSplit, { nameB: '轉台' }, sibs(all))).toEqual({ ok: false, error: '這個專案已經有叫「轉台」的機關', field: 'nameB' });
    const tooLong = planUnsplit(linearSplit, { nameA: 'y'.repeat(60) }, sibs(all));
    expect(tooLong.ok && tooLong.value.nameA.length).toBe(40);
    // 沿用自己原本的名字當 A
    const keep = planUnsplit(linearSplit, { nameA: '側面 LED', nameB: '側面 LED 右' }, sibs(all));
    expect(keep.ok && keep.value.nameA).toBe('側面 LED');
  });
});
