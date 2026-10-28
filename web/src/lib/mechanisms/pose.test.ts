import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { compileRig, applyChain, basePoseFromScene, rigValue, travelGeometry } from './pose';
import { legacyOffsetsToMechanisms, type LegacyMechanismRow, type Mechanism } from './model';

const mech = (over: Partial<Mechanism> & Pick<Mechanism, 'id'>): Mechanism => ({
  name: over.id, kind: 'linear', axis: { x: 0, y: 1, z: 0 }, pivot: null, travelMin: -100, travelMax: 100,
  defaultValue: 0, maxSpeed: null, presets: [], parentId: null, objectIds: [], consoleLabel: null, order: 0,
  metadata: null, cueCount: 0, updatedAt: '', ...over,
});

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const eul = (p: number, y: number, r: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(
  THREE.MathUtils.degToRad(p), THREE.MathUtils.degToRad(y), THREE.MathUtils.degToRad(r)));

function scene(rig: ReturnType<typeof compileRig>, id: string, values: Record<string, number>, pos: THREE.Vector3, quat = new THREE.Quaternion()) {
  const op = new THREE.Vector3(), oq = new THREE.Quaternion();
  applyChain(rig.chains.get(id), values, pos, quat, op, oq);
  return { pos: op, quat: oq };
}
function base(rig: ReturnType<typeof compileRig>, id: string, values: Record<string, number>, pos: THREE.Vector3, quat = new THREE.Quaternion()) {
  const op = new THREE.Vector3(), oq = new THREE.Quaternion();
  basePoseFromScene(rig.chains.get(id), values, pos, quat, op, oq);
  return { pos: op, quat: oq };
}
const expectVec = (a: THREE.Vector3, b: { x: number; y: number; z: number }, d = 9) => {
  expect(a.x).toBeCloseTo(b.x, d); expect(a.y).toBeCloseTo(b.y, d); expect(a.z).toBeCloseTo(b.z, d);
};
const expectQuat = (a: THREE.Quaternion, b: THREE.Quaternion) => {
  expect(Math.abs(a.dot(b))).toBeCloseTo(1, 9);
};

// 0023 把舊的全專案機關滑桿轉成的機關（mechanisms 表裡的 mlx_ / mly_）→ 畫面用的 Mechanism
const fromLegacyRow = (row: LegacyMechanismRow): Mechanism => mech({
  id: row.id, name: row.name, axis: row.axis, travelMin: row.travelMin, travelMax: row.travelMax,
  defaultValue: row.defaultValue, parentId: row.parentId, objectIds: row.objectIds, order: row.order,
});
// 舊滑桿的畫法（已經拿掉）：LED 面板的位置 + 位移（公尺 ÷ 校準倍率），其他類別不動
const oldSliderPos = (p: { x: number; y: number; z: number }, off: { x: number; y: number }, sc: number) =>
  ({ x: p.x + off.x / sc, y: p.y + off.y / sc, z: p.z });

describe('0023 從舊機關滑桿轉過來的機關：畫面跟以前一模一樣', () => {
  const offsets = { led: { x: 2, y: 1 } };
  const objects = [{ id: 'led', category: 'led_panel', order: 0, displayName: 'LED', meshName: 'LED' }];
  const legacy = legacyOffsetsToMechanisms(offsets, objects).map(fromLegacyRow);

  for (const sc of [1, 1.6, 2]) {
    it(`校準倍率 ×${sc}：畫面位置 = 舊滑桿的位置；拖完存回去、重畫還在放手的地方`, () => {
      const rig = compileRig(legacy, sc);
      for (const cue of [{ x: 1, y: 1, z: 3 }, { x: -4.25, y: 0.5, z: 7 }, { x: 0, y: 0, z: 0 }]) {
        const shown = scene(rig, 'led', {}, v3(cue.x, cue.y, cue.z));
        expectVec(shown.pos, oldSliderPos(cue, offsets.led, sc));
        // 往右拖 1 → 放手
        const dropped = { x: shown.pos.x + 1, y: shown.pos.y, z: shown.pos.z };
        const saved = base(rig, 'led', {}, v3(dropped.x, dropped.y, dropped.z));
        expectVec(saved.pos, { x: cue.x + 1, y: cue.y, z: cue.z });
        // 存完重畫：還是在放手的位置
        expectVec(scene(rig, 'led', {}, saved.pos).pos, dropped);
      }
    });
  }

  it('只有一個方向 / 不是 LED / 沒位移：跟舊的一樣', () => {
    const objs = [...objects, { id: 'lift', category: 'mechanism', order: 1, meshName: 'LIFT' }];
    const offs = { led: { x: 0, y: 1 }, lift: { x: 3, y: 3 } };
    const rig = compileRig(legacyOffsetsToMechanisms(offs, objs).map(fromLegacyRow), 2);
    expectVec(scene(rig, 'led', {}, v3(1, 1, 1)).pos, oldSliderPos({ x: 1, y: 1, z: 1 }, offs.led, 2));
    expectVec(scene(rig, 'lift', {}, v3(1, 1, 1)).pos, { x: 1, y: 1, z: 1 });
  });
});

describe('來回換算一定回到原點（拖到哪就停在哪）', () => {
  const rev = mech({ id: 'rev', kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: 2, y: 0, z: -1 }, travelMin: -36000, travelMax: 36000, objectIds: ['deck', 'person'] });
  const lift = mech({ id: 'lift', axis: { x: 0, y: 1, z: 0 }, travelMin: 0, travelMax: 3.5, parentId: 'rev', objectIds: ['lift'] });
  const track = mech({ id: 'track', axis: { x: 1, y: 0, z: 0 }, travelMin: -4, travelMax: 4, objectIds: ['wagon'] });
  const rig = compileRig([rev, lift, track], 1.6);

  const cases: [string, Record<string, number>][] = [
    ['直線', { track: 2.5 }],
    ['旋轉 90°（轉軸中心不在原點）', { rev: 90 }],
    ['旋轉 270°', { rev: 270 }],
    ['轉兩圈 720°', { rev: 720 }],
    ['轉台上的升降台', { rev: 37, lift: 2.2 }],
  ];
  for (const [name, values] of cases) {
    it(name, () => {
      for (const id of ['deck', 'person', 'lift', 'wagon']) {
        const p = v3(1.25, 0.5, -3), q = eul(10, 20, 30);
        const s = scene(rig, id, values, p, q);
        const b = base(rig, id, values, s.pos, s.quat);
        expectVec(b.pos, p);
        expectQuat(b.quat, q);
      }
    });
  }

  it('旋轉沿著圓弧走（距離轉軸中心不變）、角度也跟著轉', () => {
    const p = v3(5, 0, -1);  // 離中心 3
    const s = scene(rig, 'deck', { rev: 90 }, p);
    expect(s.pos.distanceTo(v3(2, 0, -1))).toBeCloseTo(3, 9);
    // 從上面看逆時針 90°（+Y 右手定則）：+X 方向轉到 -Z
    expectVec(s.pos, { x: 2, y: 0, z: -4 });
    expectQuat(s.quat, new THREE.Quaternion().setFromAxisAngle(v3(0, 1, 0), Math.PI / 2));
    // 45° 時在圓上（不是兩點連線的中間）
    const half = scene(rig, 'deck', { rev: 45 }, p);
    expect(half.pos.distanceTo(v3(2, 0, -1))).toBeCloseTo(3, 9);
  });

  it('720° 跟 0° 同一個位置', () => {
    const p = v3(5, 1, 2);
    expectVec(scene(rig, 'deck', { rev: 720 }, p).pos, p);
  });

  it('轉台上的升降台：升起來再一起繞轉軸中心轉', () => {
    const p = v3(5, 0, -1);
    const s = scene(rig, 'lift', { rev: 90, lift: 2 }, p);
    // 升 2 m（÷1.6 → 1.25 單位）再轉 90°
    expectVec(s.pos, { x: 2, y: 1.25, z: -4 });
  });

  it('直線：公尺 → 場景單位看校準倍率', () => {
    expectVec(scene(rig, 'wagon', { track: 1.6 }, v3(0, 0, 0)).pos, { x: 1, y: 0, z: 0 });
    expectVec(scene(compileRig([track], 1), 'wagon', { track: 1.6 }, v3(0, 0, 0)).pos, { x: 1.6, y: 0, z: 0 });
  });

  it('沒有機關的物件原樣；值超出行程夾在邊界；沒給值用預設位置', () => {
    const p = v3(1, 2, 3), q = eul(1, 2, 3);
    const s = scene(rig, 'nothing', { rev: 90 }, p, q);
    expectVec(s.pos, p); expectQuat(s.quat, q);
    expectVec(scene(rig, 'wagon', { track: 99 }, v3(0, 0, 0)).pos, { x: 4 / 1.6, y: 0, z: 0 });
    const withDefault = compileRig([{ ...track, defaultValue: 1.6 }], 1.6);
    expectVec(scene(withDefault, 'wagon', {}, v3(0, 0, 0)).pos, { x: 1, y: 0, z: 0 });
    expect(rigValue(withDefault.byId.get('track')!, { track: -10 })).toBe(-4);
  });

  it('繞圈的資料不會卡住、一個物件只算第一個機關', () => {
    const a = mech({ id: 'a', parentId: 'b', objectIds: ['o'] });
    const b = mech({ id: 'b', parentId: 'a', objectIds: ['o'] });
    const r = compileRig([a, b], 1);
    expect(r.chains.get('o')!.map(m => m.id)).toEqual(['a', 'b']);
  });

  it('拖完放手：用放手那一幀的值 → 存的位置重畫還在放手的地方（含旋轉）', () => {
    const values = { rev: 63.5, lift: 1.1 };
    const shown = scene(rig, 'lift', values, v3(4, 0, 0), eul(0, 15, 0));
    // 在 3D 拖：往前 0.7、轉 20°
    const dropPos = shown.pos.clone().add(v3(0, 0, 0.7));
    const dropQuat = shown.quat.clone().premultiply(new THREE.Quaternion().setFromAxisAngle(v3(0, 1, 0), THREE.MathUtils.degToRad(20)));
    const saved = base(rig, 'lift', values, dropPos, dropQuat);
    const again = scene(rig, 'lift', values, saved.pos, saved.quat);
    expectVec(again.pos, dropPos);
    expectQuat(again.quat, dropQuat);
  });
});

describe('行程的線（管理頁點到機關時畫在 3D 上）', () => {
  it('直線：從最低到最高（公尺 → 場景單位），常用位置有刻度', () => {
    const rig = compileRig([mech({ id: 'l', travelMin: 0, travelMax: 3.2, presets: [{ name: '半開', value: 1.6 }] })], 1.6);
    const g = travelGeometry(rig.byId.get('l')!, v3(1, 0, 0), 1, [1.6]);
    expectVec(g.path[0], { x: 1, y: 0, z: 0 });
    expectVec(g.path[1], { x: 1, y: 2, z: 0 });
    expect(g.ticks).toHaveLength(1);
    expect(g.ticks[0][0].y).toBeCloseTo(1, 9);
    expect(g.ends).toHaveLength(2);
  });
  it('旋轉：圓弧繞著轉軸，半徑 = 物件離轉軸多遠；轉超過一圈畫整個圓', () => {
    const rig = compileRig([mech({ id: 'r', kind: 'rotary', pivot: { x: 0, y: 0, z: 0 }, travelMin: -90, travelMax: 90 })], 1);
    const g = travelGeometry(rig.byId.get('r')!, v3(2, 1, 0), 1, [0]);
    for (const p of g.path) {
      expect(Math.hypot(p.x, p.z)).toBeCloseTo(2, 9);
      expect(p.y).toBeCloseTo(1, 9);
    }
    expect(g.ends).toHaveLength(2);
    const full = compileRig([mech({ id: 'r', kind: 'rotary', pivot: { x: 0, y: 0, z: 0 }, travelMin: 0, travelMax: 720 })], 1);
    const gf = travelGeometry(full.byId.get('r')!, v3(0, 0, 0), 1, []);
    expect(gf.ends).toHaveLength(0);
    expect(gf.path[0].distanceTo(gf.path[gf.path.length - 1])).toBeLessThan(1e-9);
  });
});

describe('沿弧形軌道（arc）', () => {
  // 圓心在 (0, 0, 10)，物件在 (0, 0, -10)：半徑 20；轉軸朝下 → 值變大往 +x 走
  const arc = mech({ id: 'a', kind: 'linear', variant: 'arc', axis: { x: 0, y: -1, z: 0 },
    pivot: { x: 0, y: 0, z: 10 }, arcRadius: 20, travelMin: -30, travelMax: 30, objectIds: ['led'] });
  const rig = compileRig([arc], 1);
  const p0 = v3(0, 0, -10);

  it('值 0 不動', () => { expectVec(scene(rig, 'led', { a: 0 }, p0).pos, p0); });
  it('值 s：在圓上、走過的弧長 = s、面向轉 s ÷ 半徑', () => {
    const s = 5, th = s / 20;
    const r = scene(rig, 'led', { a: s }, p0);
    expectVec(r.pos, { x: 20 * Math.sin(th), y: 0, z: 10 - 20 * Math.cos(th) });
    expect(r.pos.distanceTo(v3(0, 0, 10))).toBeCloseTo(20, 9);
    expectQuat(r.quat, new THREE.Quaternion().setFromAxisAngle(v3(0, -1, 0), th));
  });
  it('越往外越靠近觀眾（z 變大），左右對稱', () => {
    const l = scene(rig, 'led', { a: -8 }, p0).pos, rr = scene(rig, 'led', { a: 8 }, p0).pos;
    expect(rr.z).toBeGreaterThan(p0.z); expect(l.z).toBeCloseTo(rr.z, 9); expect(l.x).toBeCloseTo(-rr.x, 9);
  });
  it('跟裝在下面的自轉疊在一起：先自轉、再沿軌道帶走', () => {
    const spin = mech({ id: 's', kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: 0, y: 0, z: -10 },
      parentId: 'a', travelMin: -360, travelMax: 360, objectIds: ['led2'] });
    const rig2 = compileRig([{ ...arc, objectIds: [] }, spin], 1);
    const r = scene(rig2, 'led2', { a: 5, s: 90 }, p0);
    expect(r.pos.distanceTo(v3(0, 0, 10))).toBeCloseTo(20, 9);
    const want = new THREE.Quaternion().setFromAxisAngle(v3(0, -1, 0), 5 / 20)
      .multiply(new THREE.Quaternion().setFromAxisAngle(v3(0, 1, 0), Math.PI / 2));
    expectQuat(r.quat, want);
  });
  it('拖完還原剛好反過來', () => {
    const q = eul(0, 30, 0), r = scene(rig, 'led', { a: 7 }, p0, q), b = base(rig, 'led', { a: 7 }, r.pos, r.quat);
    expectVec(b.pos, p0); expectQuat(b.quat, q);
  });
  it('跟校準倍率無關（值和半徑都是公尺）', () => {
    const rig3 = compileRig([{ ...arc, pivot: { x: 0, y: 0, z: 5 } }], 2);   // 場景單位減半：圓心 (0,0,5)、物件 (0,0,-5)
    const r = scene(rig3, 'led', { a: 5 }, v3(0, 0, -5));
    expect(r.pos.distanceTo(v3(0, 0, 5))).toBeCloseTo(10, 9);
    expectQuat(r.quat, new THREE.Quaternion().setFromAxisAngle(v3(0, -1, 0), 5 / 20));
  });
  it('半徑 0 / 沒填：當一般直線', () => {
    const rig4 = compileRig([{ ...arc, arcRadius: null, axis: { x: 1, y: 0, z: 0 } }], 1);
    expectVec(scene(rig4, 'led', { a: 3 }, p0).pos, { x: 3, y: 0, z: -10 });
    const rig5 = compileRig([{ ...arc, arcRadius: 0, axis: { x: 1, y: 0, z: 0 } }], 1);
    expectVec(scene(rig5, 'led', { a: 3 }, p0).pos, { x: 3, y: 0, z: -10 });
    expect(rig4.byId.get('a')!.arcRadius).toBeUndefined();
  });
  it('旋轉機關帶了半徑也不理（只有直線的弧形才走圓）', () => {
    const rig6 = compileRig([mech({ id: 'r', kind: 'rotary', variant: 'arc', arcRadius: 20, axis: { x: 0, y: 1, z: 0 }, pivot: { x: 0, y: 0, z: 0 }, objectIds: ['led'] })], 1);
    expect(rig6.byId.get('r')!.arcRadius).toBeUndefined();
    expectVec(scene(rig6, 'led', { r: 90 }, v3(1, 0, 0)).pos, { x: 0, y: 0, z: -1 });
  });
  it('行程線畫成弧線（點都在圓上）', () => {
    const g = travelGeometry(rig.byId.get('a')!, p0, 1, [0]);
    expect(g.path.length).toBeGreaterThan(8);
    for (const p of g.path) expect(p.distanceTo(v3(0, 0, 10))).toBeCloseTo(20, 6);
  });
  it('行程線：起點在最低、終點在最高的位置；常用位置的刻度也在圓的徑向上', () => {
    const m = rig.byId.get('a')!;
    const g = travelGeometry(m, p0, 1, [10]);
    expectVec(g.path[0], scene(rig, 'led', { a: -30 }, p0).pos, 6);
    expectVec(g.path[g.path.length - 1], scene(rig, 'led', { a: 30 }, p0).pos, 6);
    const [t0, t1] = g.ticks[0];
    const at10 = scene(rig, 'led', { a: 10 }, p0).pos;
    // 刻度的兩端跟圓心在同一條線上（徑向），且夾著常用位置 10 m 的點
    const c = v3(0, 0, 10);
    expect(t0.clone().sub(c).normalize().dot(t1.clone().sub(c).normalize())).toBeCloseTo(1, 6);
    expect(t0.clone().add(t1).multiplyScalar(0.5).distanceTo(at10)).toBeLessThan(1e-6);
    expect(g.ends).toHaveLength(2);
  });
  it('行程線：校準倍率 ×2 時路徑一樣在以物件為半徑的圓上，角度還是 行程 ÷ 半徑（公尺）', () => {
    const rig7 = compileRig([{ ...arc, pivot: { x: 0, y: 0, z: 5 } }], 2);
    const g = travelGeometry(rig7.byId.get('a')!, v3(0, 0, -5), 1, []);
    for (const p of g.path) expect(p.distanceTo(v3(0, 0, 5))).toBeCloseTo(10, 6);
    const ang = (p: THREE.Vector3) => Math.atan2(p.x, -(p.z - 5));
    expect(ang(g.path[g.path.length - 1]) - ang(g.path[0])).toBeCloseTo(60 / 20, 6);
  });
});
