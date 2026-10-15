// 機關怎麼把物件搬到畫面上的位置（只有這一個檔案在算，StageScene 只在一個地方套用）。
//
// 一條規則：
//   存的是「cue 位置」（物件在 cue 裡的位置 / 角度，場景單位）
//   畫面上 = applyChain(cue 位置, 機關的值)
//   在 3D 拖完存回去 = basePoseFromScene(放手的位置, 放手那一幀的值)（剛好反過來）
// 所以機關的位移不會被加兩次（23af5a1 修過的那種 LED 跳走），旋轉的機關也是沿著圓弧走、不是走直線。
//
// 一個物件的「鏈」= 直接帶它的機關、那個機關裝在哪個機關上、再上一層…（裡面的先套，最多 4 層）。
// 對開（v2 第 2 階段）：A 邊、B 邊是同一個機關（同一個 id = 同一個位置），B 邊的物件鏈的第一個零件換成
// 「B 零件」（用 mirror 的方向 / 轉軸中心）；其他的跟一般機關一樣，所以還原（basePoseFromScene）也剛好反過來。
// 吊掛（v2 第 4 階段）：整組吊掛是鏈裡的一個「吊掛零件」，由它的每個吊點的高度算出一個姿勢（繞著吊點重心轉 + 往上平移，hoist.ts），
// 一個姿勢套在整組的每個物件上；還原（basePoseFromScene）先扣掉平移、再反方向轉回來，剛好反過來。
// 直線：公尺 → 場景單位（÷ 測距校準倍率，跟 numberField.metersToScene 一樣）；旋轉：度，轉軸中心是場景單位。
// 角度不繞回：0 → 720° 就是轉兩圈（值是一個數字在等速變，不是兩個角度之間走近路）。

import * as THREE from 'three';
import { clampValue, type Mechanism, type MechanismValues } from './model';
import { buildHoistRigs, newHoistPose, solveHoist, type HoistPose, type HoistSolver } from './hoist';

export interface RigMechanism {
  id: string;
  kind: 'linear' | 'rotary';
  axis: THREE.Vector3;
  pivot: THREE.Vector3;
  /** 公尺 → 場景單位 */
  linearSceneScale: number;
  defaultValue: number;
  travelMin: number;
  travelMax: number;
  maxSpeed: number | null;
  parentId: string | null;
  /** 對開的 B 邊零件（id 跟 A 邊一樣，位置也是同一個）；一般機關 / A 邊 = undefined */
  side?: 'b';
  /** 整組吊掛（它自己沒有位置，姿勢由每個吊點的高度算）；其他 = undefined */
  hoist?: HoistNode;
}

/** 整組吊掛的零件：吊點的解、每個吊點的機關（讀它的值）、上一次算的姿勢（高度沒變就不重算） */
export interface HoistNode {
  solver: HoistSolver;
  /** 照吊點編號 */
  hoists: RigMechanism[];
  pose: HoistPose;
  /** 上一次算姿勢用的高度（場景單位）；還沒算過 = valid false */
  lastH: Float64Array;
  scratchH: Float64Array;
  valid: boolean;
}

export interface CompiledRig {
  /** 每個機關一個（對開只算 A 邊；B 邊零件不放在這裡，所以每個位置只會被補間一次） */
  mechanisms: RigMechanism[];
  byId: Map<string, RigMechanism>;
  /** 對開的 B 邊零件：機關 id → 零件（管理頁畫行程用） */
  mirrors: Map<string, RigMechanism>;
  /** 整組吊掛的零件：整組 id → 零件（不在 mechanisms / byId 裡：它沒有自己的位置） */
  hoistRigs: Map<string, RigMechanism>;
  /** objectId → 鏈（裡面的在前） */
  chains: Map<string, RigMechanism[]>;
}

export const EMPTY_RIG: CompiledRig = { mechanisms: [], byId: new Map(), mirrors: new Map(), hoistRigs: new Map(), chains: new Map() };
const MAX_DEPTH = 4;

type RigInput = Pick<Mechanism, 'id' | 'kind' | 'axis' | 'pivot' | 'defaultValue' | 'travelMin' | 'travelMax' | 'maxSpeed' | 'parentId' | 'objectIds'>
  & Partial<Pick<Mechanism, 'name' | 'variant' | 'mirror' | 'objectSides' | 'rigId' | 'rigIndex' | 'attach'>>;

/** 定義或校準倍率變了才重算 */
export function compileRig(mechs: RigInput[] | null | undefined, scaleCorrection: number): CompiledRig {
  if (!mechs || mechs.length === 0) return EMPTY_RIG;
  const s = scaleCorrection > 0 && Number.isFinite(scaleCorrection) ? scaleCorrection : 1;
  const byId = new Map<string, RigMechanism>();
  const mirrors = new Map<string, RigMechanism>();
  const list: RigMechanism[] = [];
  const unit = (v: { x: number; y: number; z: number }) => {
    const a = new THREE.Vector3(v.x, v.y, v.z);
    if (a.lengthSq() < 1e-12) a.set(0, 1, 0);
    return a.normalize();
  };
  for (const m of mechs) {
    if (m.variant === 'hoist_rig') continue;   // 整組吊掛沒有自己的位置：下面另外做成吊掛零件
    const rm: RigMechanism = {
      id: m.id, kind: m.kind, axis: unit(m.axis),
      pivot: m.pivot ? new THREE.Vector3(m.pivot.x, m.pivot.y, m.pivot.z) : new THREE.Vector3(),
      linearSceneScale: 1 / s,
      defaultValue: m.defaultValue, travelMin: m.travelMin, travelMax: m.travelMax,
      maxSpeed: m.maxSpeed, parentId: m.parentId,
    };
    byId.set(m.id, rm);
    list.push(rm);
    // 對開：B 邊零件（同一個 id、同一個位置，方向 / 轉軸中心用 mirror 的）
    if (m.variant === 'split' && m.mirror) {
      mirrors.set(m.id, {
        ...rm, axis: unit(m.mirror.axis),
        pivot: m.mirror.pivot ? new THREE.Vector3(m.mirror.pivot.x, m.mirror.pivot.y, m.mirror.pivot.z) : new THREE.Vector3(),
        side: 'b',
      });
    }
  }
  // 整組吊掛：吊點的位置算得出姿勢才做（吊點不到 2 個 / 疊在一起 → 那組的物件靜止）
  const hoistRigs = new Map<string, RigMechanism>();
  for (const def of buildHoistRigs(mechs.map(m => ({
    id: m.id, name: m.name ?? '', variant: m.variant ?? null, rigId: m.rigId ?? null, rigIndex: m.rigIndex ?? null, attach: m.attach ?? null,
  })))) {
    const rigDef = mechs.find(m => m.id === def.rigId)!;
    const hoists = def.hoistIds.map(id => byId.get(id)).filter((x): x is RigMechanism => !!x);
    if (hoists.length !== def.hoistIds.length) continue;
    hoistRigs.set(def.rigId, {
      id: def.rigId, kind: 'linear', axis: new THREE.Vector3(0, 1, 0), pivot: new THREE.Vector3(),
      linearSceneScale: 1 / s, defaultValue: 0, travelMin: 0, travelMax: 1, maxSpeed: null, parentId: rigDef.parentId,
      hoist: {
        solver: def.solver, hoists, pose: newHoistPose(),
        lastH: new Float64Array(hoists.length), scratchH: new Float64Array(hoists.length), valid: false,
      },
    });
  }
  const chains = new Map<string, RigMechanism[]>();
  for (const m of mechs) {
    const direct = m.variant === 'hoist_rig' ? hoistRigs.get(m.id) : byId.get(m.id);
    if (!direct) continue;
    const mirror = mirrors.get(m.id);
    for (const objId of m.objectIds) {
      if (chains.has(objId)) continue;  // 一個物件只能直接放在一個機關（資料庫也擋）
      const chain: RigMechanism[] = [];
      const seen = new Set<string>();
      for (let cur: RigMechanism | undefined = direct; cur && !seen.has(cur.id) && chain.length < MAX_DEPTH; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
        seen.add(cur.id);
        chain.push(cur);
      }
      if (mirror && m.objectSides?.[objId] === 'b') chain[0] = mirror;
      chains.set(objId, chain);
    }
  }
  return { mechanisms: list, byId, mirrors, hoistRigs, chains };
}

/** 這一幀這個機關用的值（沒有 → 預設位置；夾在行程內） */
export function rigValue(m: RigMechanism, values: MechanismValues | null | undefined): number {
  const v = values?.[m.id];
  return clampValue(v === undefined || v === null ? m.defaultValue : v, m.travelMin, m.travelMax);
}

// 共用的暫存（每幀不配置記憶體）
const tq = new THREE.Quaternion();
const tv = new THREE.Vector3();

/** 這一幀整組吊掛的姿勢（每個吊點的高度 → 場景單位；高度跟上一次一樣就不重算） */
export function hoistPoseOf(node: HoistNode, values: MechanismValues | null | undefined): HoistPose {
  const h = node.scratchH;
  let same = node.valid;
  for (let i = 0; i < node.hoists.length; i++) {
    const hm = node.hoists[i];
    h[i] = rigValue(hm, values) * hm.linearSceneScale;
    if (h[i] !== node.lastH[i]) same = false;
  }
  if (!same) {
    solveHoist(node.solver, h, node.pose);
    node.lastH.set(h);
    node.valid = true;
  }
  return node.pose;
}

/** 吊掛的姿勢套在 (pos, quat) 上：繞著吊點的重心轉，再往上平移 */
function applyHoist(node: HoistNode, values: MechanismValues | null | undefined, outPos: THREE.Vector3, outQuat: THREE.Quaternion, inverse: boolean): void {
  const p = hoistPoseOf(node, values);
  if (p.identity) return;
  const s = node.solver;
  if (inverse) {
    outPos.y -= p.ty;
    tq.set(-p.qx, -p.qy, -p.qz, p.qw);
  } else {
    tq.set(p.qx, p.qy, p.qz, p.qw);
  }
  tv.set(outPos.x - s.cx, outPos.y - s.cy, outPos.z - s.cz).applyQuaternion(tq);
  outPos.set(s.cx + tv.x, s.cy + tv.y, s.cz + tv.z);
  if (!inverse) outPos.y += p.ty;
  outQuat.premultiply(tq);
}

/** cue 位置 → 畫面位置（outPos / outQuat 可以跟 basePos / baseQuat 是同一個物件） */
export function applyChain(
  chain: RigMechanism[] | undefined, values: MechanismValues | null | undefined,
  basePos: THREE.Vector3, baseQuat: THREE.Quaternion, outPos: THREE.Vector3, outQuat: THREE.Quaternion,
): void {
  if (outPos !== basePos) outPos.copy(basePos);
  if (outQuat !== baseQuat) outQuat.copy(baseQuat);
  if (!chain) return;
  for (let i = 0; i < chain.length; i++) {
    const m = chain[i];
    if (m.hoist) { applyHoist(m.hoist, values, outPos, outQuat, false); continue; }
    const v = rigValue(m, values);
    if (v === 0) continue;
    if (m.kind === 'linear') {
      outPos.addScaledVector(m.axis, v * m.linearSceneScale);
    } else {
      tq.setFromAxisAngle(m.axis, THREE.MathUtils.degToRad(v));
      tv.subVectors(outPos, m.pivot).applyQuaternion(tq);
      outPos.copy(m.pivot).add(tv);
      outQuat.premultiply(tq);
    }
  }
}

/** 畫面位置 → cue 位置（applyChain 剛好反過來；拖完存檔用，用放手那一幀的值） */
export function basePoseFromScene(
  chain: RigMechanism[] | undefined, values: MechanismValues | null | undefined,
  scenePos: THREE.Vector3, sceneQuat: THREE.Quaternion, outPos: THREE.Vector3, outQuat: THREE.Quaternion,
): void {
  if (outPos !== scenePos) outPos.copy(scenePos);
  if (outQuat !== sceneQuat) outQuat.copy(sceneQuat);
  if (!chain) return;
  for (let i = chain.length - 1; i >= 0; i--) {
    const m = chain[i];
    if (m.hoist) { applyHoist(m.hoist, values, outPos, outQuat, true); continue; }
    const v = rigValue(m, values);
    if (v === 0) continue;
    if (m.kind === 'linear') {
      outPos.addScaledVector(m.axis, -v * m.linearSceneScale);
    } else {
      tq.setFromAxisAngle(m.axis, THREE.MathUtils.degToRad(-v));
      tv.subVectors(outPos, m.pivot).applyQuaternion(tq);
      outPos.copy(m.pivot).add(tv);
      outQuat.premultiply(tq);
    }
  }
}

// ─────────────────────────────────────────────
// 管理頁點到某個機關時，3D 畫面上畫它的行程（cue 位置的座標；外層機關在 StageScene 每幀套上）
// ─────────────────────────────────────────────

export interface TravelGeometry {
  /** 行程的線（直線兩點；旋轉 = 圓弧上的點） */
  path: THREE.Vector3[];
  /** 常用位置的刻度（每個兩點） */
  ticks: [THREE.Vector3, THREE.Vector3][];
  /** 兩端（最低 / 最高）的刻度 */
  ends: [THREE.Vector3, THREE.Vector3][];
}

/**
 * @param center   帶的物件在 cue 位置時的中心
 * @param size     物件大小（刻度長度、物件就在轉軸中心時的半徑）
 */
export function travelGeometry(m: RigMechanism, center: THREE.Vector3, size: number, presetValues: number[]): TravelGeometry {
  const tick = Math.max(size * 0.12, 0.05);
  if (m.kind === 'linear') {
    const at = (v: number) => center.clone().addScaledVector(m.axis, v * m.linearSceneScale);
    // 刻度方向：跟方向垂直的一個方向
    const side = new THREE.Vector3(0, 1, 0).cross(m.axis);
    if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
    side.normalize().multiplyScalar(tick);
    const mark = (v: number, k = 1): [THREE.Vector3, THREE.Vector3] => {
      const p = at(v);
      return [p.clone().addScaledVector(side, -k), p.clone().addScaledVector(side, k)];
    };
    return {
      path: [at(m.travelMin), at(m.travelMax)],
      ticks: presetValues.map(v => mark(v)),
      ends: [mark(m.travelMin, 2), mark(m.travelMax, 2)],
    };
  }
  // 旋轉：在跟轉軸垂直、通過物件中心的平面上，以轉軸為圓心
  const rel = center.clone().sub(m.pivot);
  rel.addScaledVector(m.axis, -rel.dot(m.axis));
  if (rel.length() < size * 0.25) {
    // 物件就在轉軸上 → 用物件大小當半徑，從任一個跟轉軸垂直的方向開始
    rel.set(1, 0, 0).addScaledVector(m.axis, -m.axis.x);
    if (rel.lengthSq() < 1e-8) rel.set(0, 0, 1).addScaledVector(m.axis, -m.axis.z);
    rel.normalize().multiplyScalar(Math.max(size * 0.6, 0.5));
  }
  const planeCenter = m.pivot.clone().addScaledVector(m.axis, center.clone().sub(m.pivot).dot(m.axis));
  const q = new THREE.Quaternion();
  const at = (deg: number, scale = 1) => {
    q.setFromAxisAngle(m.axis, THREE.MathUtils.degToRad(deg));
    return planeCenter.clone().add(rel.clone().multiplyScalar(scale).applyQuaternion(q));
  };
  const span = Math.min(m.travelMax - m.travelMin, 360);
  const steps = Math.max(8, Math.ceil(span / 5));
  const path: THREE.Vector3[] = [];
  for (let i = 0; i <= steps; i++) path.push(at(m.travelMin + (span * i) / steps));
  const k = Math.min(tick / rel.length(), 0.3);
  const mark = (deg: number, mul = 1): [THREE.Vector3, THREE.Vector3] => [at(deg, 1 - k * mul), at(deg, 1 + k * mul)];
  return {
    path,
    ticks: presetValues.map(v => mark(v)),
    ends: span >= 360 ? [] : [mark(m.travelMin, 2), mark(m.travelMax, 2)],
  };
}
