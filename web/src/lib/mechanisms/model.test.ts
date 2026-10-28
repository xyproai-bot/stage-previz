import { describe, it, expect } from 'vitest';
import {
  normalizeMechanismInput, blankMechanismInput, mechanismToInput, parentCheck, parseCueValue,
  linearDirectionVector, rotaryAxisVector, matchLinearDirection, matchRotaryAxis, directionWord, audienceRight,
  standardPresets, presetAt, snapToPreset, legacyOffsetsToMechanisms, clampValue,
  MECH_MESSAGES, type MechanismInput, type MechVec3,
} from './model';

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
const lift = (over: Partial<MechanismInput> = {}): MechanismInput => ({
  ...blankMechanismInput(), name: '中央升降台', travelMin: 0, travelMax: 3.5, ...over,
});
const near = (a: MechVec3, b: MechVec3) => {
  expect(a.x).toBeCloseTo(b.x, 9); expect(a.y).toBeCloseTo(b.y, 9); expect(a.z).toBeCloseTo(b.z, 9);
};

describe('檢查機關設定（每一條規則和訊息）', () => {
  it('名稱：前後空白去掉、不能空白、最多 40 字、同專案不能重複（改名時不算自己）', () => {
    expect(ok(lift({ name: '  升降台  ' })).name).toBe('升降台');
    expect(err(lift({ name: '   ' })).error).toBe(MECH_MESSAGES.nameEmpty);
    expect(ok(lift({ name: 'a'.repeat(60) })).name).toHaveLength(40);
    const siblings = [{ id: 'm1', name: '旋轉舞台', parentId: null }];
    expect(err(lift({ name: '旋轉舞台' }), { siblings }).error).toBe('這個專案已經有叫「旋轉舞台」的機關');
    expect(ok(lift({ name: '旋轉舞台' }), { siblings, selfId: 'm1' }).name).toBe('旋轉舞台');
  });

  it('類型：只能 linear / rotary', () => {
    const r = err({ ...lift(), kind: 'spin' });
    expect(r.error).toBe('機關類型不正確');
    expect(r.field).toBe('kind');
  });

  it('方向：要是數字、不能是 0 向量；存成單位向量', () => {
    near(ok(lift({ axis: { x: 0, y: 5, z: 0 } })).axis, { x: 0, y: 1, z: 0 });
    near(ok(lift({ axis: { x: 3, y: 0, z: 4 } })).axis, { x: 0.6, y: 0, z: 0.8 });
    expect(err(lift({ axis: { x: 0, y: 0, z: 0 } })).error).toBe('方向不正確');
    expect(err({ ...lift(), axis: { x: 'a', y: 1, z: 0 } }).error).toBe('方向不正確');
    expect(err({ ...lift(), axis: null }).error).toBe('方向不正確');
  });

  it('轉軸中心：旋轉才有（沒給 = 原點）、要是數字、±1e5 以內；直線一律 null', () => {
    const rot = { ...lift(), kind: 'rotary', travelMin: -180, travelMax: 180 };
    expect(ok({ ...rot, pivot: { x: 1, y: 0, z: -2 } }).pivot).toEqual({ x: 1, y: 0, z: -2 });
    expect(ok({ ...rot, pivot: null }).pivot).toEqual({ x: 0, y: 0, z: 0 });
    expect(err({ ...rot, pivot: { x: 'x', y: 0, z: 0 } }).error).toBe('轉軸中心要是數字');
    expect(err({ ...rot, pivot: { x: 2e5, y: 0, z: 0 } }).error).toBe('轉軸中心要是數字');
    expect(ok({ ...lift(), pivot: { x: 1, y: 2, z: 3 } }).pivot).toBeNull();
  });

  it('行程：最高要比最低大；直線 ±1000 m、旋轉 ±36000° 以內（可以轉很多圈）；不是數字要說', () => {
    expect(err(lift({ travelMin: 2, travelMax: 2 })).error).toBe('行程的最高要比最低大');
    expect(err(lift({ travelMin: 3, travelMax: 1 })).field).toBe('travel');
    const big = ok(lift({ travelMin: -5000, travelMax: 5000 }));
    expect([big.travelMin, big.travelMax]).toEqual([-1000, 1000]);
    const turns = ok({ ...lift(), kind: 'rotary', travelMin: -720, travelMax: 99999 });
    expect([turns.travelMin, turns.travelMax]).toEqual([-720, 36000]);
    expect(err({ ...lift(), travelMin: 'abc' }).error).toBe('行程要填數字');
  });

  it('預設位置：夾在行程內', () => {
    expect(ok(lift({ defaultValue: 9 })).defaultValue).toBe(3.5);
    expect(ok(lift({ defaultValue: -1 })).defaultValue).toBe(0);
    expect(ok(lift({ defaultValue: 1.2 })).defaultValue).toBe(1.2);
  });

  it('最高速度（舊資料和舊版前端還會送，預覽不看它）：留空 = 沒有；要大於 0、直線 ≤ 100 m/秒、旋轉 ≤ 3600°/秒', () => {
    expect(ok(lift({ maxSpeed: null })).maxSpeed).toBeNull();
    expect(ok({ ...lift(), maxSpeed: '' }).maxSpeed).toBeNull();
    expect(ok(lift({ maxSpeed: 0.25 })).maxSpeed).toBe(0.25);
    expect(ok({ ...lift(), maxSpeed: '0.5' }).maxSpeed).toBe(0.5);
    for (const bad of [0, -1, 101, 'fast']) {
      expect(err({ ...lift(), maxSpeed: bad }).error).toBe('最高速度要是正的數字，或留空');
    }
    expect(ok({ ...lift(), kind: 'rotary', travelMin: -180, travelMax: 180, maxSpeed: 360 }).maxSpeed).toBe(360);
    expect(err({ ...lift(), kind: 'rotary', travelMin: -180, travelMax: 180, maxSpeed: 4000 }).field).toBe('maxSpeed');
  });

  it('常用位置：最多 12 個、名稱不能重複、名稱最多 20 字、數字夾在行程內、照數字排；空白的那一列略過', () => {
    const v = ok(lift({ presets: [
      { name: '全開', value: 99 }, { name: ' 收起 ', value: -3 }, { name: '半開', value: 1.75 }, { name: '', value: 1 },
    ] }));
    expect(v.presets).toEqual([{ name: '收起', value: 0 }, { name: '半開', value: 1.75 }, { name: '全開', value: 3.5 }]);
    expect(err(lift({ presets: [{ name: 'A', value: 1 }, { name: 'A', value: 2 }] })).error).toBe('常用位置的名稱重複了：「A」');
    const many = Array.from({ length: 13 }, (_, i) => ({ name: `P${i}`, value: i / 10 }));
    expect(err(lift({ presets: many })).error).toBe('常用位置最多 12 個');
    expect(ok(lift({ presets: [{ name: 'x'.repeat(30), value: 1 }] })).presets[0].name).toHaveLength(20);
  });

  it('物件：去掉重複和不合法的 id、最多 200 個、要在這個專案裡', () => {
    expect(ok(lift({ objectIds: ['a', 'a', 'b', 'bad id!'] })).objectIds).toEqual(['a', 'b']);
    const many = Array.from({ length: 201 }, (_, i) => 'o' + i);
    expect(err(lift({ objectIds: many })).error).toBe('一個機關最多帶 200 個物件');
    expect(err(lift({ objectIds: ['a', 'z'] }), { projectObjectIds: new Set(['a']) }).error).toBe('有物件不在這個專案裡');
  });

  it('裝在哪個機關上：不能選自己、不能繞圈、最多 4 層', () => {
    const sib = [
      { id: 'a', name: 'A', parentId: null },
      { id: 'b', name: 'B', parentId: 'a' },
      { id: 'c', name: 'C', parentId: 'b' },
      { id: 'd', name: 'D', parentId: 'c' },
    ];
    expect(err(lift({ parentId: 'a' }), { siblings: sib, selfId: 'a' }).error).toBe('不能選自己，或裝在自己上面的機關');
    // a 裝到 c 上 → c 在 a 底下 → 繞圈
    expect(err(lift({ parentId: 'c' }), { siblings: sib, selfId: 'a' }).error).toBe('不能選自己，或裝在自己上面的機關');
    // 新的裝在 d 上 = 第 5 層
    expect(err(lift({ parentId: 'd' }), { siblings: sib }).error).toBe('機關一層套一層最多 4 層');
    expect(ok(lift({ parentId: 'c' }), { siblings: sib }).parentId).toBe('c');
    // 自己底下還有兩層的機關，裝到第 2 層上 → 2 + 3 = 5 層
    const sib2 = [...sib, { id: 'x', name: 'X', parentId: null }, { id: 'y', name: 'Y', parentId: 'x' }, { id: 'z', name: 'Z', parentId: 'y' }];
    expect(parentCheck('x', 'b', sib2)).toBe('depth');
    expect(parentCheck('x', 'a', sib2)).toBeNull();
    expect(parentCheck(null, 'nope', sib2)).toBe('missing');
  });

  it('控台編號：最多 40 字、空白 = null', () => {
    expect(ok(lift({ consoleLabel: '  Axis 12 ' })).consoleLabel).toBe('Axis 12');
    expect(ok(lift({ consoleLabel: '  ' })).consoleLabel).toBeNull();
    expect(ok(lift({ consoleLabel: 'x'.repeat(50) })).consoleLabel).toHaveLength(40);
  });

  it('修改時只送一部分：其他用原本的，整個再檢查一次', () => {
    const existing = lift({ maxSpeed: 0.25, presets: [{ name: '全開', value: 3.5 }] });
    const v = ok({ travelMax: 2 }, { existing });
    expect(v.travelMax).toBe(2);
    expect(v.maxSpeed).toBe(0.25);
    expect(v.presets).toEqual([{ name: '全開', value: 2 }]);  // 夾進新的行程
    expect(err({ travelMin: 5 }, { existing }).error).toBe('行程的最高要比最低大');
  });

  it('每個 cue 的位置要是數字', () => {
    expect(parseCueValue(1.5)).toEqual({ ok: true, value: 1.5 });
    expect(parseCueValue('2')).toEqual({ ok: true, value: 2 });
    expect(parseCueValue('abc')).toEqual({ ok: false, error: '位置要是數字' });
    expect(parseCueValue(Infinity)).toEqual({ ok: false, error: '位置要是數字' });
  });

  it('clampValue：不是數字 → 0（夾進行程）', () => {
    expect(clampValue(NaN, 1, 3)).toBe(1);
    expect(clampValue(5, 1, 3)).toBe(3);
  });
});

describe('方向選項（舞台正面 = LED 朝的方向）', () => {
  const frontZ = { x: 0, y: 0, z: 1 };
  const frontX = { x: 1, y: 0, z: 0 };  // 假的舞台正面：朝 +X

  it('直線：上下、往觀眾 / 往後、左右（觀眾看過去）', () => {
    near(linearDirectionVector('up', frontZ), { x: 0, y: 1, z: 0 });
    near(linearDirectionVector('down', frontZ), { x: 0, y: -1, z: 0 });
    near(linearDirectionVector('toAudience', frontZ), frontZ);
    near(linearDirectionVector('upstage', frontZ), { x: 0, y: 0, z: -1 });
    // 觀眾在 +Z 往 -Z 看，右手邊是 +X
    near(linearDirectionVector('right', frontZ), { x: 1, y: 0, z: 0 });
    near(linearDirectionVector('left', frontZ), { x: -1, y: 0, z: 0 });
    // 正面朝 +X：觀眾在 +X 往 -X 看，右手邊是 -Z
    near(linearDirectionVector('right', frontX), { x: 0, y: 0, z: -1 });
    near(linearDirectionVector('toAudience', { x: 2, y: 5, z: 0 }), frontX);  // 正面只看水平
  });

  it('旋轉：右手定則 —— 從上面看逆時針 = +Y；前後翻往觀眾倒 = 觀眾右手邊；左右翻往左倒 = 正面', () => {
    near(rotaryAxisVector('yaw', false, frontZ), { x: 0, y: 1, z: 0 });
    near(rotaryAxisVector('yaw', true, frontZ), { x: 0, y: -1, z: 0 });
    near(rotaryAxisVector('pitch', true, frontZ), audienceRight(frontZ));
    near(rotaryAxisVector('pitch', false, frontX), { x: 0, y: 0, z: 1 });
    near(rotaryAxisVector('roll', true, frontZ), frontZ);
    near(rotaryAxisVector('roll', false, frontZ), { x: 0, y: 0, z: -1 });
  });

  it('存的方向 → 最接近的選項（編輯時）', () => {
    expect(matchLinearDirection({ x: 0, y: 1, z: 0 }, frontZ)).toEqual({ dir: 'up', exact: true });
    expect(matchLinearDirection({ x: -1, y: 0, z: 0 }, frontZ)).toEqual({ dir: 'left', exact: true });
    expect(matchLinearDirection({ x: 0.1, y: 0, z: 0.99 }, frontZ).dir).toBe('toAudience');
    expect(matchRotaryAxis({ x: 0, y: -1, z: 0 }, frontZ)).toEqual({ kind: 'yaw', positiveFirst: true, exact: true });
    expect(matchRotaryAxis({ x: 0, y: 0, z: -1 }, frontZ)).toEqual({ kind: 'roll', positiveFirst: false, exact: true });
  });

  it('清單上的方向字', () => {
    expect(directionWord({ kind: 'linear', axis: { x: 0, y: 1, z: 0 } })).toBe('上下');
    expect(directionWord({ kind: 'linear', axis: { x: 1, y: 0, z: 0 } })).toBe('左右');
    expect(directionWord({ kind: 'linear', axis: { x: 0, y: 0, z: -1 } })).toBe('前後');
    expect(directionWord({ kind: 'linear', axis: { x: 1, y: 0, z: 0 } }, frontX)).toBe('前後');
    expect(directionWord({ kind: 'rotary', axis: { x: 0, y: 1, z: 0 } })).toBe('轉台');
    expect(directionWord({ kind: 'rotary', axis: { x: 1, y: 0, z: 0 } })).toBe('前後翻');
    expect(directionWord({ kind: 'rotary', axis: { x: 0, y: 0, z: 1 } })).toBe('左右翻');
  });
});

describe('常用位置', () => {
  it('加入 收起 / 半開 / 全開 = 最低 / 中間 / 最高；已經有的不重複、照數字排', () => {
    expect(standardPresets(0, 3.5)).toEqual([
      { name: '收起', value: 0 }, { name: '半開', value: 1.75 }, { name: '全開', value: 3.5 },
    ]);
    expect(standardPresets(-180, 180, [{ name: '全開', value: 90 }]).map(p => p.name)).toEqual(['收起', '半開', '全開']);
    expect(standardPresets(-180, 180, [{ name: '全開', value: 90 }]).find(p => p.name === '全開')!.value).toBe(90);
  });
  it('這個值是哪個常用位置（差 1e-6 以內）', () => {
    const p = [{ name: '全開', value: 3.5 }];
    expect(presetAt(p, 3.5000000001)?.name).toBe('全開');
    expect(presetAt(p, 3.49)).toBeNull();
  });
  it('拖滑桿吸到常用位置：行程的 1% 以內', () => {
    const m = { presets: [{ name: '半開', value: 1.75 }], travelMin: 0, travelMax: 3.5 };
    expect(snapToPreset(1.78, m)).toBe(1.75);
    expect(snapToPreset(1.8, m)).toBe(1.8);
  });
});

describe('舊的全專案機關滑桿 → 機關', () => {
  const objs = [
    { id: 'led1', category: 'led_panel', order: 3, displayName: '主牆 LED-1', meshName: 'LED-1' },
    { id: 'led2', category: 'led_panel', order: 4, displayName: '  ', meshName: 'LED-2' },
    { id: 'led3', category: 'led_panel', order: 5, displayName: null, meshName: 'LED-3' },
    { id: 'lift', category: 'mechanism', order: 6, displayName: '升降台', meshName: 'LIFT' },
  ];

  it('只有左右 → 「<名稱> 左右」帶這片 LED', () => {
    const rows = legacyOffsetsToMechanisms({ led1: { x: 2, y: 0 } }, objs);
    expect(rows).toEqual([{
      id: 'mlx_led1', name: '主牆 LED-1 左右', kind: 'linear', axis: { x: 1, y: 0, z: 0 }, pivot: null,
      travelMin: -10, travelMax: 10, defaultValue: 2, maxSpeed: null, presets: [], parentId: null, order: 6,
      legacyObjectId: 'led1', legacyAxis: 'x', objectIds: ['led1'],
    }]);
  });

  it('只有上下 → 「<名稱> 上下」；顯示名稱空白用 mesh 名稱', () => {
    const rows = legacyOffsetsToMechanisms({ led2: { y: -1.5 } }, objs);
    expect(rows.map(r => [r.id, r.name, r.parentId, r.objectIds, r.order])).toEqual([['mly_led2', 'LED-2 上下', null, ['led2'], 9]]);
  });

  it('兩個都有 → 上下帶 LED、上下裝在左右上', () => {
    const rows = legacyOffsetsToMechanisms({ led3: { x: 1, y: 2 } }, objs);
    expect(rows.map(r => [r.id, r.parentId, r.objectIds])).toEqual([
      ['mlx_led3', null, []],
      ['mly_led3', 'mlx_led3', ['led3']],
    ]);
  });

  it('0 不轉、不是 LED 不轉、找不到的物件不轉；超過 10 公尺放寬行程', () => {
    expect(legacyOffsetsToMechanisms({ led1: { x: 0, y: 0 }, lift: { x: 1, y: 1 }, gone: { x: 1, y: 1 } }, objs)).toEqual([]);
    const [r] = legacyOffsetsToMechanisms({ led1: { y: 12 } }, objs);
    expect([r.travelMin, r.travelMax]).toEqual([-10, 12]);
    const [r2] = legacyOffsetsToMechanisms({ led1: { x: -14 } }, objs);
    expect([r2.travelMin, r2.travelMax]).toEqual([-14, 10]);
    expect(legacyOffsetsToMechanisms(null, objs)).toEqual([]);
  });
});

describe('沿弧形軌道（variant arc；圓心用 pivot、轉軸用 axis、半徑 arcRadius 公尺）', () => {
  // 圓心 (0,0,10)、轉軸朝下、半徑 5：值（公尺）變大沿弧線往 +x 走
  const arc = (over: Record<string, unknown> = {}) => ({
    ...lift(), name: '橫移', variant: 'arc', axis: { x: 0, y: -1, z: 0 }, pivot: { x: 0, y: 0, z: 10 }, arcRadius: 5,
    travelMin: -30, travelMax: 30, ...over,
  });

  it('直線 + 圓心 + 半徑 → 通過；圓心、轉軸、半徑原樣留著', () => {
    const v = ok(arc());
    expect(v.variant).toBe('arc');
    expect(v.kind).toBe('linear');
    expect(v.arcRadius).toBe(5);
    expect(v.pivot).toEqual({ x: 0, y: 0, z: 10 });
    near(v.axis, { x: 0, y: -1, z: 0 });
    expect(ok(arc({ arcRadius: '12.5' })).arcRadius).toBe(12.5);
  });

  it('只能用在直線機關', () => {
    const r = err(arc({ kind: 'rotary', travelMin: -90, travelMax: 90 }));
    expect(r.error).toBe('沿弧形軌道只能用在直線機關');
    expect(r.field).toBe('variant');
    expect(MECH_MESSAGES.arcKind).toBe('沿弧形軌道只能用在直線機關');
  });

  it('沒有圓心 → 要設圓心；圓心不是數字 / 太遠 → 轉軸中心的錯誤', () => {
    const none = err(arc({ pivot: null }));
    expect(none.error).toBe('沿弧形軌道要設圓心');
    expect(none.field).toBe('pivot');
    expect(err({ ...arc(), pivot: undefined }).error).toBe('沿弧形軌道要設圓心');
    expect(err(arc({ pivot: { x: 'x', y: 0, z: 0 } })).error).toBe('轉軸中心要是數字');
    expect(err(arc({ pivot: { x: 2e5, y: 0, z: 0 } })).error).toBe('轉軸中心要是數字');
  });

  it('半徑要大於 0、最多 1000 公尺；不是數字 / 沒填都不行', () => {
    for (const bad of [0, -3, 1000.5, 'abc', NaN, Infinity, null, '']) {
      const r = err(arc({ arcRadius: bad }));
      expect(r.error).toBe('軌道半徑要在 0 到 1000 公尺之間');
      expect(r.field).toBe('arcRadius');
    }
    expect(err({ ...arc(), arcRadius: undefined }).error).toBe('軌道半徑要在 0 到 1000 公尺之間');
    expect(ok(arc({ arcRadius: 1000 })).arcRadius).toBe(1000);
    expect(ok(arc({ arcRadius: 0.01 })).arcRadius).toBe(0.01);
  });

  it('不是弧形的機關帶了半徑 → 整理後是 null（直線、旋轉、對開都一樣）；直線的圓心照舊清掉', () => {
    expect(ok(lift({ arcRadius: 7 })).arcRadius).toBeNull();
    expect(ok({ ...lift(), arcRadius: 7, pivot: { x: 1, y: 2, z: 3 } }).pivot).toBeNull();
    expect(ok({ ...lift(), kind: 'rotary', travelMin: -90, travelMax: 90, arcRadius: 7 }).arcRadius).toBeNull();
    const split = ok({ ...lift(), variant: 'split', arcRadius: 7 });
    expect(split.variant).toBe('split');
    expect(split.arcRadius).toBeNull();
  });

  it('弧形自己不是對開：帶了 mirror / 物件邊也不留', () => {
    const v = ok(arc({ mirror: { axis: { x: 1, y: 0, z: 0 }, pivot: null, consoleLabel: null }, objectIds: ['o1'], objectSides: { o1: 'b' } }));
    expect(v.variant).toBe('arc');
    expect(v.mirror).toBeNull();
    expect(v.objectSides).toEqual({});
  });

  it('修改：只送半徑 → 其他用原本的；改回直線 → 半徑和圓心清掉、軸不動', () => {
    const existing = ok(arc());
    const r = ok({ arcRadius: 8 }, { existing });
    expect(r.variant).toBe('arc');
    expect(r.arcRadius).toBe(8);
    expect(r.pivot).toEqual({ x: 0, y: 0, z: 10 });
    const back = ok({ variant: null }, { existing });
    expect(back.variant).toBeNull();
    expect(back.arcRadius).toBeNull();
    expect(back.pivot).toBeNull();
    // 一般直線機關改成弧形：要一起送圓心和半徑
    const plain = lift();
    expect(err({ variant: 'arc' }, { existing: plain }).error).toBe('沿弧形軌道要設圓心');
    expect(ok({ variant: 'arc', pivot: { x: 1, y: 0, z: 2 }, arcRadius: 4 }, { existing: plain }).arcRadius).toBe(4);
  });

  it('弧形可以當別的機關的上層（它只是一個會轉的上層），也可以裝在一般機關上；對開 / 吊掛照舊不能當上層', () => {
    const sib = [
      { id: 'arc1', name: '弧形橫移', parentId: null, variant: 'arc' as const },
      { id: 'sp', name: '對開門', parentId: null, variant: 'split' as const },
      { id: 'rig', name: '吊掛', parentId: null, variant: 'hoist_rig' as const },
      { id: 'plain', name: '升降', parentId: null },
    ];
    expect(ok(lift({ parentId: 'arc1' }), { siblings: sib }).parentId).toBe('arc1');
    expect(ok({ ...lift(), kind: 'rotary', travelMin: -90, travelMax: 90, parentId: 'arc1' }, { siblings: sib }).parentId).toBe('arc1');
    expect(err(lift({ parentId: 'sp' }), { siblings: sib }).error).toBe('對開的機關不能當別的機關的上層');
    expect(err(lift({ parentId: 'rig' }), { siblings: sib }).error).toBe('吊掛的機關不能當別的機關的上層');
    // 弧形裝在一般機關上
    expect(ok(arc({ parentId: 'plain' }), { siblings: sib }).parentId).toBe('plain');
    // 底下裝著機關的一般機關改成弧形：沒問題（不像對開 / 吊掛）
    const withKid = [{ id: 'self', name: '自己', parentId: null }, { id: 'kid', name: '孩子', parentId: 'self' }];
    expect(ok(arc({ name: '自己' }), { siblings: withKid, selfId: 'self' }).variant).toBe('arc');
  });

  it('mechanismToInput：弧形的半徑和圓心帶著走；不是弧形的一律 null', () => {
    const v = ok(arc());
    const back = mechanismToInput({ ...v, arcRadius: v.arcRadius });
    expect(back.variant).toBe('arc');
    expect(back.arcRadius).toBe(5);
    expect(back.pivot).toEqual({ x: 0, y: 0, z: 10 });
    expect(mechanismToInput({ ...lift(), arcRadius: 9 }).arcRadius).toBeNull();
  });
});
