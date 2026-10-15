// 機關 v2 第 4 階段：吊掛 — 2 / 3 / 4 個吊點的姿勢、共面檢查（含沿著移動）、傾斜字、吊點位置選項、
// 整組吊掛的檢查規則、畫面上的動法（整組一個姿勢、還原剛好反過來）、機關總表
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  HOIST_SPOTS, analyzeHoist, buildHoistRigs, checkHoistRigs, compileHoistSolver, hoistGeometryProblem, hoistLegAt, hoistMoveSamples,
  hoistWarnings, hoistWorst, hoistsOfRig, newHoistPose, nextHoistSpot, solveHoist, spotFromBox, tiltText, tiltWord,
} from './hoist';
import { PENDING_RIG_ID, planHoistRig } from './hoistRig';
import { MECH_MESSAGES, mechanismToInput, normalizeMechanismInput, valueAxes, type Mechanism, type MechVec3 } from './model';
import { applyChain, basePoseFromScene, compileRig, hoistPoseOf } from './pose';
import { buildMechanismSheetCsv, sheetLegend, sheetRows } from './cueSheet';

const P = (x: number, y: number, z: number): MechVec3 => ({ x, y, z });
const deg = (rad: number) => (rad * 180) / Math.PI;

function pose(attach: MechVec3[], h: number[]) {
  const s = compileHoistSolver(attach)!;
  expect(s).not.toBeNull();
  return { s, p: solveHoist(s, h, newHoistPose()) };
}

describe('吊點的位置檢查', () => {
  it('兩個吊點不能疊在一起；三個以上不能排成一直線；數量只能 2 到 4', () => {
    expect(hoistGeometryProblem([P(0, 3, 0), P(0, 5, 0)])).toBe('same');   // 只有高度不同 = 同一個水平位置
    expect(hoistGeometryProblem([P(0, 3, 0), P(2, 3, 0)])).toBeNull();
    expect(hoistGeometryProblem([P(0, 3, 0), P(1, 3, 1), P(2, 3, 2)])).toBe('line');
    expect(hoistGeometryProblem([P(0, 3, 0), P(2, 3, 0), P(1, 3, 1)])).toBeNull();
    expect(hoistGeometryProblem([P(0, 3, 0), P(1, 3, 0), P(2, 3, 0), P(3, 3, 0)])).toBe('line');
    expect(hoistGeometryProblem([P(0, 3, 0)])).toBe('count');
    expect(hoistGeometryProblem([P(0, 0, 0), P(1, 0, 0), P(0, 0, 1), P(1, 0, 1), P(2, 0, 2)])).toBe('count');
    expect(compileHoistSolver([P(0, 3, 0), P(0, 3, 0)])).toBeNull();
  });
});

describe('兩個吊點：沿著兩點的連線，繞著水平軸轉', () => {
  const a = [P(-1, 3, 0), P(1, 3, 0)];

  it('一樣高 → 沒有轉，整個往上平移', () => {
    const { p } = pose(a, [0.5, 0.5]);
    expect(p.ty).toBeCloseTo(0.5, 12);
    expect(Math.abs(p.qx) + Math.abs(p.qy) + Math.abs(p.qz)).toBeLessThan(1e-12);
    expect(p.unreachable).toBe(false);
  });

  it('第 2 個吊點拉高 0.2：轉 asin(0.2 / 2)，兩個吊點拉到的高度剛好是 h（桿子是硬的）', () => {
    const { s, p } = pose(a, [0, 0.2]);
    const angle = 2 * Math.atan2(Math.hypot(p.qx, p.qy, p.qz), p.qw);
    expect(deg(angle)).toBeCloseTo(deg(Math.asin(0.1)), 9);
    // 套在兩個吊點上：高度 = 原本 + h
    const rig = compileRig(rigMechs(a), 1);
    const out = [0, 1].map(i => at(rig, 'rig', { h0: 0, h1: 0.2 }, a[i]));
    expect(out[0].y).toBeCloseTo(3, 9);
    expect(out[1].y).toBeCloseTo(3.2, 9);
    // 兩點的距離不變
    expect(out[0].distanceTo(out[1])).toBeCloseTo(2, 9);
    expect(s.n).toBe(2);
  });

  it('第 1 個吊點拉高 → 反方向轉；高度差大過兩點的距離 → 斜到垂直就停，並提醒', () => {
    const up1 = pose(a, [0.2, 0]).p;
    const up2 = pose(a, [0, 0.2]).p;
    expect(Math.sign(up1.qz) * Math.sign(up2.qz)).toBe(-1);
    const far = pose(a, [0, 5]);
    expect(far.p.unreachable).toBe(true);
    expect(deg(2 * Math.atan2(Math.hypot(far.p.qx, far.p.qy, far.p.qz), far.p.qw))).toBeCloseTo(90, 6);
    const w = hoistWarnings(far.s, [0, 5], 1);
    expect(w).toEqual(['兩個吊點的高度差（5 m）比它們之間的距離（2 m）還大，畫面上整片斜到垂直就停住']);
    // 剛好等於也吊不起來（|Δh| ≥ |d|）；差一點點還可以
    expect(pose(a, [0, 2]).p.unreachable).toBe(true);
    expect(pose(a, [0, 1.99]).p.unreachable).toBe(false);
  });

  it('兩個吊點原本就不一樣高：轉到的是「高度差」，不是角度', () => {
    const b = [P(-1, 3, 0), P(1, 3.5, 0)];
    const rig = compileRig(rigMechs(b), 1);
    const out = [0, 1].map(i => at(rig, 'rig', { h0: 0.1, h1: 0.4 }, b[i]));
    expect(out[0].y).toBeCloseTo(3.1, 9);
    expect(out[1].y).toBeCloseTo(3.9, 9);
  });

  it('沿著不是 X 軸的連線也對（斜著的兩個吊點）', () => {
    const c = [P(0, 2, 0), P(3, 2, 4)];   // 距離 5
    const rig = compileRig(rigMechs(c), 1);
    const out = [0, 1].map(i => at(rig, 'rig', { h0: 0, h1: 1 }, c[i]));
    expect(out[1].y - out[0].y).toBeCloseTo(1, 9);
    expect(out[0].distanceTo(out[1])).toBeCloseTo(5, 9);
    // 沒有繞垂直軸轉：兩點的水平連線方向要跟原本一樣（只是變短）
    const dh = new THREE.Vector2(out[1].x - out[0].x, out[1].z - out[0].z).normalize();
    expect(dh.x).toBeCloseTo(0.6, 9);
    expect(dh.y).toBeCloseTo(0.8, 9);
  });
});

describe('三個吊點：最小的轉動，把吊點平面轉到通過三個目標點的平面', () => {
  const a = [P(-2, 4, 1), P(2, 4, 1), P(0, 4, -2)];

  it('一樣高 → 沒有轉，整片往上平移', () => {
    const { p } = pose(a, [1, 1, 1]);
    expect(p.ty).toBeCloseTo(1, 12);
    expect(p.identity).toBe(false);
    expect(Math.abs(p.qx) + Math.abs(p.qy) + Math.abs(p.qz)).toBeLessThan(1e-12);
  });

  it('全部在 0 → 什麼都不動', () => {
    expect(pose(a, [0, 0, 0]).p.identity).toBe(true);
  });

  it('高度不一樣：轉完的吊點平面，法向量就是通過三個目標點的平面的法向量；沒有繞垂直軸轉', () => {
    const h = [0, 0.3, 0.1];
    const rig = compileRig(rigMechs(a), 1);
    const out = a.map(pt => at(rig, 'rig', { h0: h[0], h1: h[1], h2: h[2] }, pt));
    const target = a.map((pt, i) => new THREE.Vector3(pt.x, pt.y + h[i], pt.z));
    const nOut = new THREE.Vector3().crossVectors(out[1].clone().sub(out[0]), out[2].clone().sub(out[0])).normalize();
    const nTarget = new THREE.Vector3().crossVectors(target[1].clone().sub(target[0]), target[2].clone().sub(target[0])).normalize();
    if (nOut.y < 0) nOut.negate();
    if (nTarget.y < 0) nTarget.negate();
    expect(nOut.angleTo(nTarget)).toBeLessThan(1e-9);
    // 吊點的重心升高 h 的平均
    const c = out.reduce((s, v) => s.add(v), new THREE.Vector3()).divideScalar(3);
    expect(c.y).toBeCloseTo(4 + (0 + 0.3 + 0.1) / 3, 9);
    // 沒有 yaw：轉動軸在水平面上
    const sol = compileHoistSolver(a)!;
    const an = analyzeHoist(sol, h);
    expect(Math.abs(an.axis.y)).toBeLessThan(0.05);
  });

  it('原本就是斜的物件（吊點高度不一樣）也能算：全部拉一樣高 = 只平移', () => {
    const b = [P(-2, 4, 1), P(2, 4.4, 1), P(0, 4.2, -2)];
    const { p } = pose(b, [0.7, 0.7, 0.7]);
    expect(Math.abs(p.qx) + Math.abs(p.qy) + Math.abs(p.qz)).toBeLessThan(1e-12);
    expect(p.ty).toBeCloseTo(0.7, 12);
  });
});

describe('四個吊點：最小平方法找平面，不在同一個平面上就提醒', () => {
  const a = [P(-2, 4, -1), P(2, 4, -1), P(-2, 4, 1), P(2, 4, 1)];   // 左後、右後、左前、右前

  it('四個高度在同一個平面上 → 沒有提醒，吊點平面剛好轉到那個平面', () => {
    const h = [0, 0.2, 0.1, 0.3];   // 平面：0 + 0.05 x' + 0.1 z' 的樣子（共面）
    const s = compileHoistSolver(a)!;
    expect(analyzeHoist(s, h).residual).toBeLessThan(1e-12);
    expect(hoistWarnings(s, h, 1)).toEqual([]);
    const rig = compileRig(rigMechs(a), 1);
    const out = a.map(pt => at(rig, 'rig', { h0: h[0], h1: h[1], h2: h[2], h3: h[3] }, pt));
    // 轉完還是共面（硬的）
    const n1 = new THREE.Vector3().crossVectors(out[1].clone().sub(out[0]), out[2].clone().sub(out[0])).normalize();
    expect(Math.abs(out[3].clone().sub(out[0]).dot(n1))).toBeLessThan(1e-9);
  });

  it('一個吊點的高度對不上 → 差多少 cm 說多少（0.2 % 跨度和 1 cm 取大的）', () => {
    const s = compileHoistSolver(a)!;
    // 只有第 4 個拉高 0.2：離平面最遠 0.05 m = 5 cm
    const an = analyzeHoist(s, [0, 0, 0, 0.2]);
    expect(an.residual).toBeCloseTo(0.05, 9);
    expect(hoistWarnings(s, [0, 0, 0, 0.2], 1)).toEqual(['四個吊點的高度不在同一個平面上（差 5 cm），畫面上整片會貼著最接近這四個點的平面']);
    // 差 0.5 cm → 不到 1 cm，不提醒
    expect(hoistWarnings(s, [0, 0, 0, 0.02], 1)).toEqual([]);
    // 校準倍率：場景單位 / 公尺 = 2（物件放大一倍）→ 同樣高度（公尺）換算後 cm 一樣
    expect(hoistWarnings(s, [0, 0, 0, 0.4], 2)).toEqual(['四個吊點的高度不在同一個平面上（差 5 cm），畫面上整片會貼著最接近這四個點的平面']);
  });

  it('預先算好的矩陣：每幀不重新配置，數字跟用 THREE 逐步算的一樣', () => {
    const s = compileHoistSolver(a)!;
    const out = newHoistPose();
    const h = new Float64Array(4);
    for (const t of [0, 0.25, 0.5, 1]) {
      h.set([0, 0.4 * t, 0.2 * t, 0.6 * t]);
      const r = solveHoist(s, h, out);
      expect(r).toBe(out);
      expect(Math.hypot(r.qx, r.qy, r.qz, r.qw)).toBeCloseTo(1, 12);
    }
  });
});

describe('傾斜的字', () => {
  const lr = compileHoistSolver([P(-1, 3, 0), P(1, 3, 0)])!;     // 左右兩個吊點
  const fb = compileHoistSolver([P(0, 3, -1), P(0, 3, 1)])!;     // 前後兩個吊點
  const front: MechVec3 = P(0, 0, 1);

  it('左右兩個吊點高度不一樣 = 左右傾；前後兩個吊點 = 前後傾；幾乎沒傾斜 = 沒有傾斜', () => {
    const a = analyzeHoist(lr, [0, 0.2]);
    expect(tiltWord(a.axis, front)).toBe('左右');
    expect(tiltText(a, front)).toBe('傾斜 5.7°（左右）');
    const b = analyzeHoist(fb, [0, 0.2]);
    expect(tiltWord(b.axis, front)).toBe('前後');
    expect(tiltText(b, front)).toBe('傾斜 5.7°（前後）');
    expect(tiltText(analyzeHoist(lr, [0.3, 0.3]), front)).toBe('沒有傾斜');
  });

  it('舞台正面不是 +Z 也對（轉了 90 度的舞台：左右 / 前後對調）', () => {
    const a = analyzeHoist(lr, [0, 0.2]);
    expect(tiltWord(a.axis, P(1, 0, 0))).toBe('前後');
  });
});

describe('沿著移動檢查', () => {
  const a = [P(-2, 4, -1), P(2, 4, -1), P(-2, 4, 1), P(2, 4, 1)];
  const s = compileHoistSolver(a)!;

  it('每個吊點的時間不一樣：起點和終點都共面，中間不共面也要抓得到', () => {
    // 四個都從 0 拉到 1 m，但第 4 個晚 2 秒才開始、走 2 秒；其他走 2 秒
    const legs = [0, 1, 2, 3].map(i => ({ from: 0, to: 1, delay: i === 3 ? 2 : 0, duration: 2 }));
    expect(hoistWorst(s, [Float64Array.from([1, 1, 1, 1])]).residual).toBeLessThan(1e-12);   // 終點共面
    const samples = hoistMoveSamples(legs, 1);
    expect(samples.map(x => Array.from(x))).toEqual([[0, 0, 0, 0], [1, 1, 1, 0], [1, 1, 1, 1]]);   // 0 秒、2 秒（前三個到位）、4 秒
    const w = hoistWorst(s, samples);
    expect(w.residual).toBeCloseTo(0.25, 9);   // 在第 2 秒，前三個已經 1 m、第 4 個還在 0 → 離平面 0.25 m
  });

  it('兩個吊點：中間才吊不起來也抓得到', () => {
    const two = compileHoistSolver([P(-1, 3, 0), P(1, 3, 0)])!;
    const legs = [{ from: 0, to: 0, delay: 0, duration: 1 }, { from: 0, to: 0, delay: 0, duration: 1 }];
    expect(hoistWorst(two, hoistMoveSamples(legs, 1)).reach).toBe(0);
    // 第 2 個先衝到 3 m，第 1 個晚一點才跟上：最後一樣高，中間差 3 m > 2 m
    const legs2 = [{ from: 0, to: 3, delay: 2, duration: 0.5 }, { from: 0, to: 3, delay: 0, duration: 0.5 }];
    const w = hoistWorst(two, hoistMoveSamples(legs2, 1));
    expect(w.reach).toBeCloseTo(3, 9);
  });

  it('hoistLegAt：延遲前不動、之後等速、走完停住；走 0 秒 = 到了就切過去', () => {
    const leg = { from: 1, to: 3, delay: 1, duration: 2 };
    expect([0, 1, 2, 3, 9].map(t => hoistLegAt(leg, t))).toEqual([1, 1, 2, 3, 3]);
    expect([0, 0.99, 1, 5].map(t => hoistLegAt({ from: 1, to: 3, delay: 1, duration: 0 }, t))).toEqual([1, 1, 3, 3]);
  });

  it('每個 cue 的檢查：到位時的傾斜 + 到位和路上最糟的提醒（同一種只說一次）', () => {
    const rigs = buildHoistRigs(rigMechs(a));
    const stops: Record<string, number[]> = { c1: [0, 0, 0, 0], c2: [1, 1, 1, 1] };
    const item = (cueId: string, id: string) => {
      const i = Number(id.slice(1));
      const to = stops[cueId][i];
      // c2：第 4 個吊點晚 2 秒才動
      return cueId === 'c1'
        ? { value: to, from: null, delay: 0, duration: 0 }
        : { value: to, from: stops.c1[i], delay: i === 3 ? 2 : 0, duration: 2 };
    };
    const r = checkHoistRigs(rigs, ['c1', 'c2'], item, 1);
    expect(r.get('c1')!.get('rig')!.warnings).toEqual([]);
    expect(r.get('c2')!.get('rig')!.warnings).toEqual(['四個吊點的高度不在同一個平面上（差 25 cm），畫面上整片會貼著最接近這四個點的平面']);
    expect(r.get('c2')!.get('rig')!.tilt.tiltDeg).toBeLessThan(1e-6);   // 到位時一樣高 = 沒有傾斜
  });
});

describe('吊點可以選的位置', () => {
  const box = { min: P(-3, 0, -1), max: P(3, 2, 1) };
  it('角和邊緣中間都在物件最上面；左右是觀眾看過去的（正面 +Z → 觀眾的左邊是 −X）', () => {
    const f = P(0, 0, 1);
    expect(spotFromBox(box, 'leftFront', f)).toEqual(P(-3, 2, 1));
    expect(spotFromBox(box, 'rightBack', f)).toEqual(P(3, 2, -1));
    expect(spotFromBox(box, 'leftMid', f)).toEqual(P(-3, 2, 0));
    expect(spotFromBox(box, 'frontMid', f)).toEqual(P(0, 2, 1));
    expect(spotFromBox(box, 'center', f)).toEqual(P(0, 2, 0));
    // 舞台轉 180 度：左右、前後都對調
    expect(spotFromBox(box, 'leftFront', P(0, 0, -1))).toEqual(P(3, 2, -1));
  });
  it('新增吊點時，沒用過的位置依序挑', () => {
    expect(nextHoistSpot([])).toBe('leftMid');
    expect(nextHoistSpot(['leftMid', 'rightMid'])).toBe('frontMid');
    expect(nextHoistSpot(['leftMid', 'rightMid', 'frontMid'])).toBe('backMid');
    expect(HOIST_SPOTS.map(x => x.label)).toContain('左前角');
    expect(HOIST_SPOTS.map(x => x.label)).toContain('右緣中間');
  });
});

// ── 畫面上的動法 ────────────────────────────

/** 一組吊掛：整組 'rig'（帶 obj）+ 吊點 h0..（往上的直線） */
function rigMechs(attach: MechVec3[], extra: Partial<Mechanism> = {}): Mechanism[] {
  const base = {
    name: '', kind: 'linear' as const, axis: P(0, 1, 0), pivot: null, travelMin: -10, travelMax: 10, defaultValue: 0, maxSpeed: null,
    presets: [], parentId: null, consoleLabel: null, order: 0, metadata: null, cueCount: 0, updatedAt: '',
  };
  return [
    { ...base, id: 'rig', name: '吊掛', objectIds: ['obj'], variant: 'hoist_rig', ...extra } as Mechanism,
    ...attach.map((a, i) => ({
      ...base, id: `h${i}`, name: `吊點 ${i + 1}`, objectIds: [], variant: 'hoist', rigId: 'rig', rigIndex: i, attach: a, order: i + 1,
    }) as Mechanism),
  ];
}
function at(rig: ReturnType<typeof compileRig>, objId: string, values: Record<string, number>, p: MechVec3) {
  const op = new THREE.Vector3(), oq = new THREE.Quaternion();
  const chain = objId === 'rig' ? [rig.hoistRigs.get('rig')!] : rig.chains.get(objId);
  applyChain(chain, values, new THREE.Vector3(p.x, p.y, p.z), new THREE.Quaternion(), op, oq);
  return op;
}

describe('編譯：整組吊掛是鏈裡的一個零件', () => {
  const a = [P(-1, 3, 0), P(1, 3, 0)];

  it('整組不在 mechanisms / byId 裡（沒有自己的位置，不會被補間）；吊點是普通的往上直線；物件的鏈只有整組', () => {
    const rig = compileRig(rigMechs(a), 1);
    expect(rig.mechanisms.map(m => m.id)).toEqual(['h0', 'h1']);
    expect(rig.byId.has('rig')).toBe(false);
    expect(rig.hoistRigs.get('rig')?.hoist?.hoists.map(h => h.id)).toEqual(['h0', 'h1']);
    expect(rig.chains.get('obj')).toEqual([rig.hoistRigs.get('rig')]);
  });

  it('吊點不到 2 個 / 位置疊在一起 → 那組的物件沒有鏈（靜止），其他機關不受影響', () => {
    expect(compileRig(rigMechs([a[0]]), 1).chains.has('obj')).toBe(false);
    expect(compileRig(rigMechs([P(0, 3, 0), P(0, 5, 0)]), 1).chains.has('obj')).toBe(false);
  });

  it('整組可以裝在別的機關上（轉台）：鏈 = [整組, 轉台]', () => {
    const turn: Mechanism = {
      id: 'turn', name: '轉台', kind: 'rotary', axis: P(0, 1, 0), pivot: P(0, 0, 0), travelMin: -180, travelMax: 180, defaultValue: 0,
      maxSpeed: null, presets: [], parentId: null, objectIds: [], consoleLabel: null, order: 9, metadata: null, cueCount: 0, updatedAt: '',
    };
    const rig = compileRig([...rigMechs(a, { parentId: 'turn' }), turn], 1);
    expect(rig.chains.get('obj')!.map(m => m.id)).toEqual(['rig', 'turn']);
  });

  it('校準倍率：吊點的公尺換成場景單位（÷ 倍率）', () => {
    const rig = compileRig(rigMechs(a), 2);
    // 物件放在吊點上，兩個吊點拉到 0 / 1 m → 場景裡拉 0 / 0.5
    const out = a.map(pt => at(rig, 'rig', { h0: 0, h1: 1 }, pt));
    expect(out[1].y - out[0].y).toBeCloseTo(0.5, 9);
  });
});

describe('套用 / 還原剛好反過來（拖完存回 cue 位置不會錯）', () => {
  const rnd = (seed: number) => { let x = seed; return () => (x = (x * 16807) % 2147483647) / 2147483647; };
  const sets: [string, MechVec3[]][] = [
    ['2 點', [P(-1, 3, 0.5), P(2, 3.2, -0.5)]],
    ['3 點', [P(-2, 4, 1), P(2, 4, 1), P(0, 4, -2)]],
    ['4 點', [P(-2, 4, -1), P(2, 4, -1), P(-2, 4, 1), P(2, 4, 1)]],
  ];
  for (const [label, attach] of sets) {
    it(`${label}：任意高度、任意位置和角度，套用再還原 = 原本的`, () => {
      const rig = compileRig(rigMechs(attach), 1.3);
      const r = rnd(7);
      for (let k = 0; k < 20; k++) {
        const values: Record<string, number> = {};
        attach.forEach((_, i) => { values[`h${i}`] = (r() - 0.3) * (label === '2 點' ? 1.5 : 3); });
        const pos = new THREE.Vector3((r() - 0.5) * 10, r() * 5, (r() - 0.5) * 10);
        const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(r(), r(), r()));
        const shown = new THREE.Vector3(), shownQ = new THREE.Quaternion();
        applyChain(rig.chains.get('obj'), values, pos, quat, shown, shownQ);
        const back = new THREE.Vector3(), backQ = new THREE.Quaternion();
        basePoseFromScene(rig.chains.get('obj'), values, shown, shownQ, back, backQ);
        expect(back.distanceTo(pos)).toBeLessThan(1e-9);
        expect(Math.abs(backQ.dot(quat))).toBeCloseTo(1, 9);
      }
    });
  }

  it('整組的每個物件用同一個姿勢：兩個物件的相對位置不變（硬的）', () => {
    const attach = [P(-2, 4, 1), P(2, 4, 1), P(0, 4, -2)];
    const rig = compileRig(rigMechs(attach, { objectIds: ['obj', 'obj2'] }), 1);
    // obj2 也在整組裡（rigMechs 只放 obj，手動加進鏈）
    const chain = rig.chains.get('obj')!;
    const values = { h0: 0.2, h1: 0.5, h2: 0.9 };
    const p1 = new THREE.Vector3(1, 4.5, 0.2), p2 = new THREE.Vector3(-1.5, 4.1, -0.7);
    const o1 = new THREE.Vector3(), o2 = new THREE.Vector3(), q = new THREE.Quaternion();
    applyChain(chain, values, p1, new THREE.Quaternion(), o1, q);
    applyChain(chain, values, p2, new THREE.Quaternion(), o2, q);
    expect(o1.distanceTo(o2)).toBeCloseTo(p1.distanceTo(p2), 9);
  });

  it('姿勢快取：高度沒變就不重算（同一個物件）；變了就換', () => {
    const rig = compileRig(rigMechs(sets[1][1]), 1);
    const node = rig.hoistRigs.get('rig')!.hoist!;
    const p1 = hoistPoseOf(node, { h0: 0.1, h1: 0.2, h2: 0.3 });
    const ty1 = p1.ty;
    expect(hoistPoseOf(node, { h0: 0.1, h1: 0.2, h2: 0.3 })).toBe(p1);
    expect(hoistPoseOf(node, { h0: 0.1, h1: 0.2, h2: 0.9 }).ty).not.toBe(ty1);
  });

  it('沒有值（沒設）→ 用每個吊點的預設位置', () => {
    const mechs = rigMechs([P(-1, 3, 0), P(1, 3, 0)]);
    mechs[2] = { ...mechs[2], defaultValue: 0.4 };
    const rig = compileRig(mechs, 1);
    const out = at(rig, 'rig', {}, P(1, 3, 0));
    expect(out.y).toBeCloseTo(3.4, 9);
  });
});

describe('整組吊掛的檢查規則', () => {
  const attach = [P(-1, 3, 0), P(1, 3, 0)];
  const hoist = (i: number, over: Record<string, unknown> = {}) => ({ name: `吊點 ${i + 1}`, attach: attach[i], ...over });
  const plan = (raw: Record<string, unknown>, ctx = {}) => planHoistRig({ name: '舞台吊掛', objectIds: ['o1', 'o2'], hoists: [hoist(0), hoist(1)], ...raw }, ctx);

  it('新增：整組 + 2 個吊點；吊點固定是往上的直線、沒有物件，行程預設 0 ~ 5 m，指到還不存在的整組', () => {
    const r = plan({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rig.variant).toBe('hoist_rig');
    expect(r.value.rig.objectIds).toEqual(['o1', 'o2']);
    expect(r.value.rig.rigId).toBeNull();
    expect(r.value.hoists.map(h => h.id)).toEqual([null, null]);
    const h = r.value.hoists[1].input;
    expect(h).toMatchObject({ variant: 'hoist', kind: 'linear', axis: P(0, 1, 0), pivot: null, travelMin: 0, travelMax: 5, objectIds: [], parentId: null, rigIndex: 1, rigId: PENDING_RIG_ID });
    expect(h.attach).toEqual(attach[1]);
  });

  it('吊點沒取名字 → 「整組名稱 吊點 N」', () => {
    const r = plan({ hoists: [{ attach: attach[0] }, { attach: attach[1] }] });
    expect(r.ok && r.value.hoists.map(h => h.input.name)).toEqual(['舞台吊掛 吊點 1', '舞台吊掛 吊點 2']);
  });

  it('每個吊點自己的行程、速度、控台編號、預設位置', () => {
    const r = plan({ hoists: [hoist(0, { travelMin: -1, travelMax: 6, maxSpeed: 0.25, consoleLabel: 'Axis 5', defaultValue: 2 }), hoist(1)] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.hoists[0].input).toMatchObject({ travelMin: -1, travelMax: 6, maxSpeed: 0.25, consoleLabel: 'Axis 5', defaultValue: 2 });
  });

  it('吊點要 2 到 4 個；沒物件、位置不是數字、兩個疊在一起、三個排一直線、名稱重複都不行（說清楚是哪裡）', () => {
    const bad = (raw: Record<string, unknown>, ctx = {}) => {
      const r = plan(raw, ctx);
      if (r.ok) throw new Error('expected error');
      return r;
    };
    expect(bad({ hoists: [hoist(0)] })).toMatchObject({ field: 'hoists', error: MECH_MESSAGES.hoistCount });
    expect(bad({ hoists: [0, 1, 2, 3, 4].map(i => hoist(i % 2)) })).toMatchObject({ field: 'hoists', error: MECH_MESSAGES.hoistCount });
    expect(bad({ hoists: undefined })).toMatchObject({ field: 'hoists' });
    expect(bad({ objectIds: [] })).toMatchObject({ field: 'objectIds', error: MECH_MESSAGES.hoistObjects });
    expect(bad({ hoists: [hoist(0), { attach: { x: 'a', y: 0, z: 0 } }] })).toMatchObject({ field: 'attach', error: MECH_MESSAGES.hoistAttach });
    expect(bad({ hoists: [hoist(0), { attach: P(-1, 9, 0) }] })).toMatchObject({ field: 'attach', error: MECH_MESSAGES.hoistSame });
    expect(bad({ hoists: [hoist(0), hoist(1), { attach: P(3, 3, 0) }] })).toMatchObject({ field: 'attach', error: MECH_MESSAGES.hoistLine });
    expect(bad({ hoists: [hoist(0, { name: '同名' }), hoist(1, { name: '同名' })] })).toMatchObject({ field: 'name' });
    expect(bad({}, { siblings: [{ id: 'x', name: '舞台吊掛', parentId: null }] })).toMatchObject({ field: 'name' });
    expect(bad({ hoists: [hoist(0, { travelMin: 3, travelMax: 1 }), hoist(1)] })).toMatchObject({ field: 'travel' });
  });

  it('整組可以裝在轉台上，但不能裝在對開 / 吊掛上', () => {
    const sib = (variant: 'split' | 'hoist_rig' | null) => [{ id: 'p', name: '轉台', parentId: null, variant }];
    expect(plan({ parentId: 'p' }, { siblings: sib(null) }).ok).toBe(true);
    expect(plan({ parentId: 'p' }, { siblings: sib('split') }).ok).toBe(false);
    const r = plan({ parentId: 'p' }, { siblings: sib('hoist_rig') });
    expect(!r.ok && r.error).toBe(MECH_MESSAGES.hoistAsParent);
  });

  it('修改：有 id 的吊點改、沒有 id 的新增、原本有卻沒列的刪掉；沒送 hoists = 吊點都不動', () => {
    const existing = rigMechs([...attach, P(0, 3, -2)]);
    const rig = existing[0], hs = existing.slice(1);
    const ctx = { existing: { rig, hoists: hs }, siblings: existing.map(m => ({ id: m.id, name: m.name, parentId: null, variant: m.variant ?? null, rigId: m.rigId ?? null })) };
    // 不送 hoists：只改名字
    const rename = planHoistRig({ name: '新名字' }, ctx);
    expect(rename.ok && rename.value).toMatchObject({ hoistsTouched: false, removeIds: [], hoists: [] });
    expect(rename.ok && rename.value.rig.name).toBe('新名字');
    expect(rename.ok && rename.value.rig.objectIds).toEqual(['obj']);
    // 留 h0、h2（改 h2 的行程）、加一個新的，h1 刪掉
    const r = planHoistRig({ hoists: [{ id: 'h0', attach: attach[0] }, { id: 'h2', attach: P(0, 3, -2), travelMax: 8 }, { attach: P(0, 3, 2) }] }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.removeIds).toEqual(['h1']);
    expect(r.value.hoists.map(h => h.id)).toEqual(['h0', 'h2', null]);
    expect(r.value.hoists.map(h => h.input.rigIndex)).toEqual([0, 1, 2]);
    expect(r.value.hoists[1].input.travelMax).toBe(8);
    expect(r.value.hoists[0].input.name).toBe('吊點 1');   // 沒送名字 → 沿用原本的
    expect(r.value.hoists.every(h => h.input.rigId === 'rig')).toBe(true);
    // 別的整組的吊點、重複的 id → 不行
    expect(planHoistRig({ hoists: [{ id: 'zzz', attach: attach[0] }, { id: 'h1', attach: attach[1] }] }, ctx).ok).toBe(false);
    expect(planHoistRig({ hoists: [{ id: 'h0', attach: attach[0] }, { id: 'h0', attach: attach[1] }] }, ctx).ok).toBe(false);
  });
});

describe('一般的檢查：吊掛的變化類型', () => {
  it('整組：固定成往上的直線，沒有行程 / 速度 / 控台編號；吊點：沒有物件、不能裝在別的機關上', () => {
    const rig = normalizeMechanismInput({ name: 'R', variant: 'hoist_rig', kind: 'rotary', axis: { x: 1, y: 0, z: 0 }, travelMax: 9, maxSpeed: 3, consoleLabel: 'x', objectIds: ['a'] });
    expect(rig.ok && rig.value).toMatchObject({ kind: 'linear', axis: P(0, 1, 0), travelMin: 0, travelMax: 1, maxSpeed: null, consoleLabel: null, objectIds: ['a'], pivot: null });
    const h = normalizeMechanismInput({ name: 'H', variant: 'hoist', rigId: 'r', rigIndex: 0, attach: P(1, 2, 3), objectIds: ['a'], parentId: 'zzz', travelMax: 3 },
      { siblings: [{ id: 'r', name: 'R', parentId: null, variant: 'hoist_rig' }] });
    expect(h.ok && h.value).toMatchObject({ objectIds: [], parentId: null, attach: P(1, 2, 3), rigId: 'r', rigIndex: 0, travelMax: 3 });
  });
  it('吊點要指到存在的整組、編號 0 到 3、位置要是數字', () => {
    const sibs = [{ id: 'r', name: 'R', parentId: null, variant: 'hoist_rig' as const }, { id: 'n', name: 'N', parentId: null, variant: null }];
    const f = (o: Record<string, unknown>) => { const r = normalizeMechanismInput({ name: 'H', variant: 'hoist', rigId: 'r', rigIndex: 0, attach: P(0, 0, 0), ...o }, { siblings: sibs }); return r.ok ? null : r.field; };
    expect(f({})).toBeNull();
    expect(f({ rigId: 'nope' })).toBe('rigId');
    expect(f({ rigId: 'n' })).toBe('rigId');
    expect(f({ rigIndex: 4 })).toBe('rigId');
    expect(f({ attach: null })).toBe('attach');
  });
  it('mechanismToInput 帶著吊點的欄位；一般機關這三個欄位是空的', () => {
    const h = rigMechs([P(-1, 3, 0), P(1, 3, 0)])[1];
    const i = mechanismToInput(h);
    expect(i).toMatchObject({ variant: 'hoist', rigId: 'rig', rigIndex: 0, attach: P(-1, 3, 0) });
    expect(mechanismToInput({ ...h, variant: null })).toMatchObject({ rigId: null, rigIndex: null, attach: null });
  });
  it('valueAxes：整組吊掛不算（沒有位置），吊點算', () => {
    const ms = rigMechs([P(-1, 3, 0), P(1, 3, 0)]);
    expect(valueAxes(ms).map(m => m.id)).toEqual(['h0', 'h1']);
    const plain = [ms[1]];
    expect(valueAxes(plain)).toBe(plain);
    expect(hoistsOfRig(ms, 'rig').map(m => m.id)).toEqual(['h0', 'h1']);
  });
});

describe('機關總表：每個吊點一行，整組只出現在說明裡', () => {
  const mechs = rigMechs([P(-1, 3, 0), P(1, 3, 0)]).map((m, i) => ({ ...m, maxSpeed: i > 0 ? 0.5 : null, consoleLabel: i > 0 ? `Axis ${i}` : null, travelMax: 6 }));
  const input = {
    songs: [{ id: 's', name: '開場', code: null, order: 0, cues: [
      { id: 'c1', name: '暗場', order: 0, videoTimeSec: 0, crossfadeSeconds: 0 },
      { id: 'c2', name: '吊起', order: 1, videoTimeSec: 10, crossfadeSeconds: 4 },
    ] }],
    positions: [
      { cueId: 'c2', mechanismId: 'h0', value: 2, updatedAt: '' },
      { cueId: 'c2', mechanismId: 'h1', value: 3, delaySec: 1, updatedAt: '' },
    ],
    mechanisms: mechs,
  };

  it('每個 cue 每個吊點一行（整組沒有行）', () => {
    const rows = sheetRows(input);
    expect(rows).toHaveLength(4);
    expect(rows.map(r => r[6]?.v)).toEqual(['吊點 1', '吊點 2', '吊點 1', '吊點 2']);
    expect(rows[3].map(c => c?.v ?? '').slice(0, 20).join('|')).toContain('Axis 2');
    expect(buildMechanismSheetCsv(input)).not.toContain('吊掛,');
  });

  it('說明：整組寫一行（幾個吊點、高度不一樣會傾斜），每個吊點照一般的往上直線寫', () => {
    const legend = sheetLegend(mechs);
    expect(legend.filter(l => l.includes('吊掛'))[0]).toBe('# 吊掛：整組吊掛，2 個吊點（吊點 1、吊點 2）；每個吊點的數字 = 它被拉高幾公尺（0 = cue 裡原本的位置），各吊點高度不一樣時整片會跟著傾斜');
    expect(legend.some(l => l.startsWith('# 吊點 2（Axis 2）：直線，0 = cue 裡原本的位置，正的數字往上'))).toBe(true);
  });
});
