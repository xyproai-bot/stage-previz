import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { planCueConversion, quatFromEuler, eulerFromQuat, twistDegrees, type ConvertCue, type ConvertRow, type ConvertObject, type CEuler, type CVec } from './convert';
import { compileRig, applyChain } from './pose';
import { resolveSongMechanisms, ownValuesByCue } from './track';
import type { Mechanism } from './model';

// 物件沿用規則（跟 cf-worker/cueStates.mjs 一樣）：自己的欄位 → 前面最近一筆（同順序不算）→ 預設
function effective(o: ConvertObject, cue: ConvertCue, cues: ConvertCue[], rows: ConvertRow[]) {
  const earlier = cues.filter(c => c.songId === cue.songId && c.order < cue.order).map(c => c.id);
  const orderOf = new Map(cues.map((c, i) => [c.id, { order: c.order, i }]));
  const track = rows
    .filter(r => r.objectId === o.id && earlier.includes(r.cueId))
    .sort((a, b) => (orderOf.get(a.cueId)!.order - orderOf.get(b.cueId)!.order) || (orderOf.get(a.cueId)!.i - orderOf.get(b.cueId)!.i));
  const tr = track[track.length - 1];
  const own = rows.find(r => r.objectId === o.id && r.cueId === cue.id);
  return {
    position: own?.position ?? tr?.position ?? o.defaultPosition,
    rotation: own?.rotation ?? tr?.rotation ?? o.defaultRotation,
  };
}

function applyPlan(rows: ConvertRow[], plan: ReturnType<typeof planCueConversion>): ConvertRow[] {
  const out = rows.map(r => ({ ...r }));
  for (const u of plan.rowUpdates) {
    const r = out.find(x => x.id === u.rowId)!;
    r.position = u.position; r.rotation = u.rotation;
  }
  plan.rowInserts.forEach((r, i) => out.push({ id: 'new' + i, cueId: r.cueId, objectId: r.objectId, position: r.position, rotation: r.rotation }));
  return out;
}

const q3 = (e: CEuler) => new THREE.Quaternion().setFromEuler(new THREE.Euler(e.pitch * Math.PI / 180, e.yaw * Math.PI / 180, e.roll * Math.PI / 180));

/** 每個 cue 每個物件在畫面上的位置（物件位置 + 機關） */
function display(mech: Mechanism, objects: ConvertObject[], cues: ConvertCue[], rows: ConvertRow[], positions: { cueId: string; value: number }[], sc: number) {
  const rig = compileRig([{ ...mech, objectIds: objects.map(o => o.id) }], sc);
  const own = ownValuesByCue(positions.map(p => ({ ...p, mechanismId: mech.id })));
  const resolved = new Map<string, ReturnType<typeof resolveSongMechanisms> extends Map<string, infer R> ? R : never>();
  for (const song of new Set(cues.map(c => c.songId))) {
    for (const [k, v] of resolveSongMechanisms([mech], cues.filter(c => c.songId === song), own)) resolved.set(k, v);
  }
  const out: Record<string, { p: THREE.Vector3; q: THREE.Quaternion }> = {};
  for (const c of cues) {
    for (const o of objects) {
      const e = effective(o, c, cues, rows);
      const p = new THREE.Vector3(e.position.x, e.position.y, e.position.z), q = q3(e.rotation);
      applyChain(rig.chains.get(o.id), { [mech.id]: resolved.get(c.id)![mech.id].value }, p, q, p, q);
      out[c.id + ':' + o.id] = { p, q };
    }
  }
  return out;
}

function expectSameDisplay(a: ReturnType<typeof display>, b: ReturnType<typeof display>) {
  for (const k of Object.keys(a)) {
    expect(a[k].p.distanceTo(b[k].p), k).toBeLessThan(1e-4);
    expect(Math.abs(a[k].q.dot(b[k].q)), k).toBeGreaterThan(1 - 1e-8);
  }
}

const mechBase: Mechanism = {
  id: 'm', name: '升降台', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, pivot: null, travelMin: 0, travelMax: 5,
  defaultValue: 0, maxSpeed: null, presets: [], parentId: null, objectIds: [], consoleLabel: null, order: 0, metadata: null,
  cueCount: 0, updatedAt: '',
};
const zeroRot = { pitch: 0, yaw: 0, roll: 0 };
const obj = (id: string, p: CVec, r: CEuler = zeroRot): ConvertObject => ({ id, defaultPosition: p, defaultRotation: r });
const cue = (id: string, order: number, status = 'master', songId = 's1'): ConvertCue => ({ id, songId, order, status });
const row = (id: string, cueId: string, objectId: string, position: CVec | null, rotation: CEuler | null = null): ConvertRow =>
  ({ id, cueId, objectId, position, rotation });

describe('四元數（跟 three.js 一樣）', () => {
  it('Euler ↔ 四元數', () => {
    for (const e of [{ pitch: 10, yaw: 20, roll: 30 }, { pitch: -80, yaw: 89.5, roll: 170 }, { pitch: 0, yaw: -135, roll: 0 }]) {
      const q = quatFromEuler(e);
      const t = q3(e);
      expect(Math.abs(q[0] * t.x + q[1] * t.y + q[2] * t.z + q[3] * t.w)).toBeCloseTo(1, 9);
      const back = eulerFromQuat(q);
      const te = new THREE.Euler().setFromQuaternion(t, 'XYZ');
      expect(back.pitch).toBeCloseTo(te.x * 180 / Math.PI, 6);
      expect(back.yaw).toBeCloseTo(te.y * 180 / Math.PI, 6);
      expect(back.roll).toBeCloseTo(te.z * 180 / Math.PI, 6);
    }
  });
  it('繞轉軸轉了幾度', () => {
    expect(twistDegrees(quatFromEuler({ pitch: 0, yaw: 90, roll: 0 }), { x: 0, y: 1, z: 0 })).toBeCloseTo(90, 9);
    expect(twistDegrees(quatFromEuler({ pitch: 0, yaw: -170, roll: 0 }), { x: 0, y: -1, z: 0 })).toBeCloseTo(170, 9);
  });
});

describe('把現有 cue 的位置轉成機關位置', () => {
  it('升降台 + 上面的 LED：每個 cue 的高度變成機關位置，物件回到原本的高度；畫面一模一樣', () => {
    const objects = [obj('lift', { x: 0, y: 0, z: 0 }), obj('led', { x: 0, y: 1, z: -1 })];
    const cues = [cue('c1', 0), cue('c2', 1), cue('c3', 2), cue('c4', 3)];
    const rows = [
      row('r1', 'c2', 'lift', { x: 0, y: 2, z: 0 }), row('r2', 'c2', 'led', { x: 0, y: 3, z: -1 }),
      row('r3', 'c4', 'lift', { x: 0, y: 0.5, z: 0 }), row('r4', 'c4', 'led', { x: 0, y: 1.5, z: -1 }),
    ];
    const before = display(mechBase, objects, cues, rows, [], 1);
    const plan = planCueConversion({ mechanism: mechBase, objects, cues, rows, scaleCorrection: 1 });
    expect(plan.converted).toEqual(['c2', 'c4']);
    expect(plan.skipped).toEqual([]);
    expect(plan.positions).toEqual([{ cueId: 'c2', value: 2 }, { cueId: 'c4', value: 0.5 }]);
    expect(plan.rowUpdates.find(u => u.rowId === 'r2')!.position).toEqual({ x: 0, y: 1, z: -1 });
    expect(plan.rowInserts).toEqual([]);
    const after = display(mechBase, objects, cues, applyPlan(rows, plan), plan.positions, 1);
    expectSameDisplay(before, after);
  });

  it('校準倍率：機關位置是公尺', () => {
    const objects = [obj('lift', { x: 0, y: 0, z: 0 })];
    const cues = [cue('c1', 0), cue('c2', 1)];
    const rows = [row('r1', 'c2', 'lift', { x: 0, y: 2, z: 0 })];
    const plan = planCueConversion({ mechanism: mechBase, objects, cues, rows, scaleCorrection: 1.5 });
    expect(plan.positions).toEqual([{ cueId: 'c2', value: 3 }]);
    expectSameDisplay(display(mechBase, objects, cues, rows, [], 1.5), display(mechBase, objects, cues, applyPlan(rows, plan), plan.positions, 1.5));
  });

  it('物件動法不一致的 cue 不轉、列出來；之後沿用它的 cue 畫面也不會變', () => {
    const objects = [obj('lift', { x: 0, y: 0, z: 0 }), obj('led', { x: 0, y: 1, z: -1 })];
    const cues = [cue('c1', 0), cue('c2', 1), cue('c3', 2), cue('c4', 3)];
    const rows = [
      row('r1', 'c2', 'lift', { x: 0, y: 2, z: 0 }), row('r2', 'c2', 'led', { x: 0, y: 3, z: -1 }),
      // c3：升降台到 1，LED 卻到 4（不是一起動）
      row('r3', 'c3', 'lift', { x: 0, y: 1, z: 0 }), row('r4', 'c3', 'led', { x: 0, y: 4, z: -1 }),
    ];
    const before = display(mechBase, objects, cues, rows, [], 1);
    const plan = planCueConversion({ mechanism: mechBase, objects, cues, rows, scaleCorrection: 1 });
    expect(plan.converted).toEqual(['c2']);
    expect(plan.skipped).toEqual([{ cueId: 'c3', reason: 'inconsistent' }, { cueId: 'c4', reason: 'inconsistent' }]);
    expectSameDisplay(before, display(mechBase, objects, cues, applyPlan(rows, plan), plan.positions, 1));
  });

  it('只有 LED 有存、升降台沿用前面的：LED 要跟著扣（補一筆或改那一筆），畫面不變', () => {
    const objects = [obj('lift', { x: 0, y: 0, z: 0 }), obj('led', { x: 0, y: 1, z: -1 })];
    const cues = [cue('c1', 0), cue('c2', 1), cue('c3', 2)];
    const rows = [
      row('r1', 'c2', 'lift', { x: 0, y: 2, z: 0 }), row('r2', 'c2', 'led', { x: 0, y: 3, z: -1 }),
      row('r3', 'c3', 'led', { x: 1, y: 3, z: -1 }),  // c3 只把 LED 往右移，高度跟著升降台
    ];
    const before = display(mechBase, objects, cues, rows, [], 1);
    const plan = planCueConversion({ mechanism: mechBase, objects, cues, rows, scaleCorrection: 1 });
    expect(plan.skipped).toEqual([]);
    expect(plan.rowUpdates.find(u => u.rowId === 'r3')!.position).toEqual({ x: 1, y: 1, z: -1 });
    expectSameDisplay(before, display(mechBase, objects, cues, applyPlan(rows, plan), plan.positions, 1));
  });

  it('提案 cue、同一個順序的 cue、空的欄位、超出行程：畫面都不變', () => {
    const objects = [obj('lift', { x: 0, y: 0, z: 0 }, { pitch: 0, yaw: 30, roll: 0 })];
    const cues = [cue('c1', 0), cue('p1', 1, 'proposal'), cue('c2', 1), cue('c3', 2), cue('c4', 3)];
    const rows = [
      row('r1', 'p1', 'lift', { x: 0, y: 4, z: 0 }),
      row('r2', 'c2', 'lift', { x: 0, y: 1, z: 0 }, null),
      row('r3', 'c3', 'lift', null, { pitch: 0, yaw: 45, roll: 0 }),
      row('r4', 'c4', 'lift', { x: 0, y: 9, z: 0 }),  // 9 m > 行程 5 m
    ];
    const before = display(mechBase, objects, cues, rows, [], 1);
    const plan = planCueConversion({ mechanism: mechBase, objects, cues, rows, scaleCorrection: 1 });
    expect(plan.skipped).toEqual([{ cueId: 'c4', reason: 'range' }]);
    expectSameDisplay(before, display(mechBase, objects, cues, applyPlan(rows, plan), plan.positions, 1));
  });

  it('轉台：每個 cue 轉的角度變成機關位置（繞轉軸中心），畫面不變', () => {
    const rev: Mechanism = { ...mechBase, kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: 1, y: 0, z: 0 }, travelMin: -180, travelMax: 180 };
    const objects = [obj('deck', { x: 1, y: 0, z: 0 }), obj('person', { x: 3, y: 0, z: 0 })];
    const cues = [cue('c1', 0), cue('c2', 1), cue('c3', 2)];
    // c2：整個轉 90°（person 沿著圓走到 (1,0,-2)）；c3：轉 -45°
    const q90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const pPerson = new THREE.Vector3(2, 0, 0).applyQuaternion(q90).add(new THREE.Vector3(1, 0, 0));
    const rows = [
      row('r1', 'c2', 'deck', { x: 1, y: 0, z: 0 }, { pitch: 0, yaw: 90, roll: 0 }),
      row('r2', 'c2', 'person', { x: pPerson.x, y: 0, z: pPerson.z }, { pitch: 0, yaw: 90, roll: 0 }),
      row('r3', 'c3', 'deck', { x: 1, y: 0, z: 0 }, { pitch: 0, yaw: -45, roll: 0 }),
      row('r4', 'c3', 'person', {
        x: 1 + 2 * Math.cos(Math.PI / 4), y: 0, z: 2 * Math.sin(Math.PI / 4),
      }, { pitch: 0, yaw: -45, roll: 0 }),
    ];
    const before = display(rev, objects, cues, rows, [], 1);
    const plan = planCueConversion({ mechanism: rev, objects, cues, rows, scaleCorrection: 1 });
    expect(plan.positions.map(p => [p.cueId, Math.round(p.value)])).toEqual([['c2', 90], ['c3', -45]]);
    // person 在 c2 回到原本的位置和角度
    const u = plan.rowUpdates.find(x => x.rowId === 'r2')!;
    expect(u.position.x).toBeCloseTo(3, 5);
    expect(u.position.z).toBeCloseTo(0, 5);
    expect(u.rotation.yaw).toBeCloseTo(0, 3);
    expectSameDisplay(before, display(rev, objects, cues, applyPlan(rows, plan), plan.positions, 1));
  });

  it('預設位置不是 0：機關位置 = 預設 + 量到的', () => {
    const m2 = { ...mechBase, defaultValue: 1 };
    const objects = [obj('lift', { x: 0, y: 0, z: 0 })];
    const cues = [cue('c1', 0), cue('c2', 1)];
    const rows = [row('r1', 'c2', 'lift', { x: 0, y: 2, z: 0 })];
    const before = display(m2, objects, cues, rows, [], 1);
    const plan = planCueConversion({ mechanism: m2, objects, cues, rows, scaleCorrection: 1 });
    expect(plan.positions).toEqual([{ cueId: 'c2', value: 3 }]);
    expectSameDisplay(before, display(m2, objects, cues, applyPlan(rows, plan), plan.positions, 1));
  });

  it('隨便亂擺的很多 cue（兩首歌、好幾種亂數、直線和轉台）：轉完畫面一定一樣', () => {
   for (const [startSeed, mech] of [[7, mechBase], [11, mechBase], [42, mechBase], [1234, mechBase],
     [99, { ...mechBase, kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: 0.5, y: 0, z: 0.2 }, travelMin: -180, travelMax: 180 }],
   ] as [number, Mechanism][]) {
    let seed = startSeed;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const objects = [obj('a', { x: 0, y: 0, z: 0 }), obj('b', { x: 1, y: 0.5, z: 0 }), obj('c', { x: -1, y: 0, z: 1 })];
    const cues: ConvertCue[] = [];
    const rows: ConvertRow[] = [];
    for (const song of ['s1', 's2']) {
      for (let i = 0; i < 12; i++) {
        const id = `${song}-c${i}`;
        // 有些 cue 順序一樣（彼此不沿用）
        cues.push(cue(id, rnd() < 0.15 && i > 0 ? i - 1 : i, rnd() < 0.15 ? 'proposal' : 'master', song));
        const lift = Math.round(rnd() * 4 * 100) / 100;
        const together = rnd() < 0.6;  // 整組一起動（大部分）/ 只動其中幾個
        for (const o of objects) {
          if (!together && rnd() < 0.5) continue;
          const jitter = rnd() < 0.2 ? rnd() : 0;
          rows.push(row(`${id}-${o.id}`, id, o.id,
            rnd() < 0.1 ? null : { x: o.defaultPosition.x + (rnd() < 0.3 ? rnd() : 0), y: o.defaultPosition.y + lift + jitter, z: o.defaultPosition.z },
            rnd() < 0.5 ? null : { pitch: 0, yaw: Math.round(rnd() * 90), roll: 0 }));
        }
      }
    }
    const before = display(mech, objects, cues, rows, [], 1.3);
    const plan = planCueConversion({ mechanism: mech, objects, cues, rows, scaleCorrection: 1.3 });
    expect(plan.converted.length + plan.skipped.length).toBeGreaterThan(0);
    expectSameDisplay(before, display(mech, objects, cues, applyPlan(rows, plan), plan.positions, 1.3));
   }
  });
});
