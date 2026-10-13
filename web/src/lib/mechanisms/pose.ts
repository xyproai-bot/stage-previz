// 機關怎麼把物件搬到畫面上的位置（只有這一個檔案在算，StageScene 只在一個地方套用）。
//
// 一條規則：
//   存的是「cue 位置」（物件在 cue 裡的位置 / 角度，場景單位）
//   畫面上 = applyChain(cue 位置, 機關的值)
//   在 3D 拖完存回去 = basePoseFromScene(放手的位置, 放手那一幀的值)（剛好反過來）
// 所以機關的位移不會被加兩次（23af5a1 修過的那種 LED 跳走），旋轉的機關也是沿著圓弧走、不是走直線。
//
// 一個物件的「鏈」= 直接帶它的機關、那個機關裝在哪個機關上、再上一層…（裡面的先套，最多 4 層）。
// 直線：公尺 → 場景單位（÷ 測距校準倍率，跟 numberField.metersToScene 一樣）；旋轉：度，轉軸中心是場景單位。
// 角度不繞回：0 → 720° 就是轉兩圈（值是一個數字在等速變，不是兩個角度之間走近路）。

import * as THREE from 'three';
import { clampValue, type Mechanism, type MechanismValues } from './model';

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
}

export interface CompiledRig {
  mechanisms: RigMechanism[];
  byId: Map<string, RigMechanism>;
  /** objectId → 鏈（裡面的在前） */
  chains: Map<string, RigMechanism[]>;
}

export const EMPTY_RIG: CompiledRig = { mechanisms: [], byId: new Map(), chains: new Map() };
const MAX_DEPTH = 4;

type RigInput = Pick<Mechanism, 'id' | 'kind' | 'axis' | 'pivot' | 'defaultValue' | 'travelMin' | 'travelMax' | 'maxSpeed' | 'parentId' | 'objectIds'>;

/** 定義或校準倍率變了才重算 */
export function compileRig(mechs: RigInput[] | null | undefined, scaleCorrection: number): CompiledRig {
  if (!mechs || mechs.length === 0) return EMPTY_RIG;
  const s = scaleCorrection > 0 && Number.isFinite(scaleCorrection) ? scaleCorrection : 1;
  const byId = new Map<string, RigMechanism>();
  const list: RigMechanism[] = [];
  for (const m of mechs) {
    const axis = new THREE.Vector3(m.axis.x, m.axis.y, m.axis.z);
    if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0);
    axis.normalize();
    const rm: RigMechanism = {
      id: m.id, kind: m.kind, axis,
      pivot: m.pivot ? new THREE.Vector3(m.pivot.x, m.pivot.y, m.pivot.z) : new THREE.Vector3(),
      linearSceneScale: 1 / s,
      defaultValue: m.defaultValue, travelMin: m.travelMin, travelMax: m.travelMax,
      maxSpeed: m.maxSpeed, parentId: m.parentId,
    };
    byId.set(m.id, rm);
    list.push(rm);
  }
  const chains = new Map<string, RigMechanism[]>();
  for (const m of mechs) {
    const direct = byId.get(m.id)!;
    for (const objId of m.objectIds) {
      if (chains.has(objId)) continue;  // 一個物件只能直接放在一個機關（資料庫也擋）
      const chain: RigMechanism[] = [];
      const seen = new Set<string>();
      for (let cur: RigMechanism | undefined = direct; cur && !seen.has(cur.id) && chain.length < MAX_DEPTH; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
        seen.add(cur.id);
        chain.push(cur);
      }
      chains.set(objId, chain);
    }
  }
  return { mechanisms: list, byId, chains };
}

/** 這一幀這個機關用的值（沒有 → 預設位置；夾在行程內） */
export function rigValue(m: RigMechanism, values: MechanismValues | null | undefined): number {
  const v = values?.[m.id];
  return clampValue(v === undefined || v === null ? m.defaultValue : v, m.travelMin, m.travelMax);
}

// 共用的暫存（每幀不配置記憶體）
const tq = new THREE.Quaternion();
const tv = new THREE.Vector3();

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
