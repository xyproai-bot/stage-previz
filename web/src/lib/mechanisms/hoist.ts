// 吊掛（機關 v2 第 4 階段）：2～4 個吊點拉到不同的高度，整片物件跟著傾斜。
// 設計：docs/superpowers/specs/2026-10-15-mechanism-v2-design.md（第 3 節 Hoist pose、第 5 節 Stage 4）
//
// 跟 model.ts 一樣只放純算式（後台也會 import 這個 .ts）：不碰 DOM / React / three，不用 enum / 建構子參數屬性。
//
// 一組吊掛 = 一個「整組」（帶動物件，自己沒有位置）+ 2～4 個「吊點」（各自是往上的直線機關，有自己的行程、速度、每個 cue 的位置）。
// 每個吊點有一個 attach：它在物件上的位置（場景單位，cue 位置的座標）。吊點的值 h_i = 這個吊點被拉高幾公尺（0 = cue 裡原本的位置）。
// 物件是硬的：
//   2 個吊點：沿著兩點的水平連線，繞著跟它垂直的水平軸轉，轉到兩點的高度差剛好等於 h₂ − h₁（轉不到 → 斜到垂直為止並提醒）
//   3 個吊點：最小的轉動，把物件的吊點平面轉到「通過三個目標點」的平面
//   4 個吊點：同上，用最小平方法找最接近四個目標點的平面（四點不共面 → 提醒硬的東西會被扭到）
// 平移：吊點的重心升高 h 的平均值。永遠不會繞著垂直軸轉（沒有 yaw）。
// 每幀只做一次小矩陣乘法，不配置記憶體（HoistSolver 事先算好）。

import { audienceRight, horizontalFront, type Mechanism, type MechVec3 } from './model.ts';
import type { StageBox } from './flip.ts';

export const HOIST_MIN = 2;
export const HOIST_MAX = 4;
/** 三個以上的吊點排成一直線的判斷：水平散佈的「細的那一邊」比「粗的那一邊」小到這個比例就算一直線 */
const LINE_RATIO = 1e-6;
const MIN_SEP = 1e-4;   // 兩個吊點水平距離至少這麼遠（場景單位）

const dot3 = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => ax * bx + ay * by + az * bz;

// ─────────────────────────────────────────────
// 吊點位置的檢查
// ─────────────────────────────────────────────

/** 吊點的位置能不能算出一個姿勢（兩個吊點不能疊在一起、三個以上不能排成一直線）；可以 = null */
export function hoistGeometryProblem(attach: MechVec3[]): 'count' | 'same' | 'line' | null {
  const n = attach.length;
  if (n < HOIST_MIN || n > HOIST_MAX) return 'count';
  if (n === 2) return Math.hypot(attach[1].x - attach[0].x, attach[1].z - attach[0].z) > MIN_SEP ? null : 'same';
  let cx = 0, cz = 0;
  for (const a of attach) { cx += a.x; cz += a.z; }
  cx /= n; cz /= n;
  let sxx = 0, szz = 0, sxz = 0;
  for (const a of attach) { const x = a.x - cx, z = a.z - cz; sxx += x * x; szz += z * z; sxz += x * z; }
  const tr = sxx + szz;
  if (!(tr > MIN_SEP * MIN_SEP)) return 'same';
  return sxx * szz - sxz * sxz > LINE_RATIO * tr * tr ? null : 'line';
}

// ─────────────────────────────────────────────
// 事先算好的解（一組吊掛一個）
// ─────────────────────────────────────────────

export interface HoistSolver {
  n: number;
  /** 吊點（場景單位） */
  ax: Float64Array; ay: Float64Array; az: Float64Array;
  /** 吊點的重心：物件繞著這裡轉 */
  cx: number; cy: number; cz: number;
  /** 吊點之間最遠的水平距離（場景單位） */
  span: number;
  // 2 個吊點
  /** 2→1 的水平單位向量、轉軸（= u × 上，水平）、水平距離、空間距離、原本的高度差、原本的仰角 */
  ux: number; uz: number; kx: number; kz: number; lh: number; len: number; dv: number; phi0: number;
  // 3～4 個吊點：斜率（α = ∂高度/∂x，β = ∂高度/∂z）= 原本的斜率 + 權重 · 高度
  w0: Float64Array; w1: Float64Array;
  alpha0: number; beta0: number;
  /** 原本的吊點平面的法向量 */
  n0x: number; n0y: number; n0z: number;
  /** 吊點對重心的水平座標（四點共面檢查用） */
  dx: Float64Array; dz: Float64Array;
}

/** 吊點位置 → 解；位置算不出姿勢（疊在一起 / 一直線 / 數量不對）→ null */
export function compileHoistSolver(attach: MechVec3[]): HoistSolver | null {
  if (hoistGeometryProblem(attach)) return null;
  const n = attach.length;
  const s: HoistSolver = {
    n, ax: new Float64Array(n), ay: new Float64Array(n), az: new Float64Array(n),
    cx: 0, cy: 0, cz: 0, span: 0,
    ux: 1, uz: 0, kx: 0, kz: 0, lh: 1, len: 1, dv: 0, phi0: 0,
    w0: new Float64Array(n), w1: new Float64Array(n), alpha0: 0, beta0: 0, n0x: 0, n0y: 1, n0z: 0,
    dx: new Float64Array(n), dz: new Float64Array(n),
  };
  attach.forEach((a, i) => { s.ax[i] = a.x; s.ay[i] = a.y; s.az[i] = a.z; s.cx += a.x / n; s.cy += a.y / n; s.cz += a.z / n; });
  for (let i = 0; i < n; i++) {
    s.dx[i] = s.ax[i] - s.cx; s.dz[i] = s.az[i] - s.cz;
    for (let j = i + 1; j < n; j++) s.span = Math.max(s.span, Math.hypot(s.ax[j] - s.ax[i], s.az[j] - s.az[i]));
  }
  if (n === 2) {
    const hx = s.ax[1] - s.ax[0], hz = s.az[1] - s.az[0];
    s.lh = Math.hypot(hx, hz);
    s.ux = hx / s.lh; s.uz = hz / s.lh;
    s.dv = s.ay[1] - s.ay[0];
    s.len = Math.hypot(s.lh, s.dv);
    s.phi0 = Math.atan2(s.dv, s.lh);
    // 轉軸 = u × 上：u = (ux, 0, uz)、上 = (0, 1, 0) → (−uz, 0, ux)；正的角度讓第 2 個吊點升高
    s.kx = -s.uz; s.kz = s.ux;
    return s;
  }
  let sxx = 0, szz = 0, sxz = 0;
  for (let i = 0; i < n; i++) { sxx += s.dx[i] * s.dx[i]; szz += s.dz[i] * s.dz[i]; sxz += s.dx[i] * s.dz[i]; }
  const det = sxx * szz - sxz * sxz;
  for (let i = 0; i < n; i++) {
    s.w0[i] = (szz * s.dx[i] - sxz * s.dz[i]) / det;
    s.w1[i] = (-sxz * s.dx[i] + sxx * s.dz[i]) / det;
    s.alpha0 += s.w0[i] * s.ay[i];
    s.beta0 += s.w1[i] * s.ay[i];
  }
  const l = Math.hypot(s.alpha0, 1, s.beta0);
  s.n0x = -s.alpha0 / l; s.n0y = 1 / l; s.n0z = -s.beta0 / l;
  return s;
}

// ─────────────────────────────────────────────
// 每幀：高度 → 姿勢
// ─────────────────────────────────────────────

/** 物件的姿勢：繞著吊點的重心轉 (qx,qy,qz,qw)，再整個往上平移 ty（場景單位） */
export interface HoistPose {
  qx: number; qy: number; qz: number; qw: number; ty: number;
  /** 沒有轉也沒有平移（所有吊點都在 0） */
  identity: boolean;
  /** 只有 2 個吊點：高度差大過兩點的距離，轉到垂直就停了 */
  unreachable: boolean;
}

export function newHoistPose(): HoistPose {
  return { qx: 0, qy: 0, qz: 0, qw: 1, ty: 0, identity: true, unreachable: false };
}

/**
 * 每個吊點的高度（場景單位，往上為正；0 = cue 位置）→ 姿勢。不配置記憶體。
 * h 的長度要等於吊點數。
 */
export function solveHoist(s: HoistSolver, h: ArrayLike<number>, out: HoistPose): HoistPose {
  const n = s.n;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += h[i] / n;
  out.ty = mean;
  out.unreachable = false;
  out.qx = 0; out.qy = 0; out.qz = 0; out.qw = 1;
  if (n === 2) {
    const r = (s.dv + (h[1] - h[0])) / s.len;
    out.unreachable = Math.abs(r) > 1 - 1e-9;
    const phi = Math.asin(r > 1 ? 1 : r < -1 ? -1 : r);
    const half = (phi - s.phi0) / 2;
    const sn = Math.sin(half);
    out.qx = s.kx * sn; out.qz = s.kz * sn; out.qw = Math.cos(half);
  } else {
    let a = s.alpha0, b = s.beta0;
    for (let i = 0; i < n; i++) { a += s.w0[i] * h[i]; b += s.w1[i] * h[i]; }
    const l = Math.hypot(a, 1, b);
    const nx = -a / l, ny = 1 / l, nz = -b / l;
    // n0 → n 的最小轉動：軸 = n0 × n，w = 1 + n0·n
    let qx = s.n0y * nz - s.n0z * ny, qy = s.n0z * nx - s.n0x * nz, qz = s.n0x * ny - s.n0y * nx;
    let qw = 1 + dot3(s.n0x, s.n0y, s.n0z, nx, ny, nz);
    const ql = Math.hypot(qx, qy, qz, qw);
    qx /= ql; qy /= ql; qz /= ql; qw /= ql;
    out.qx = qx; out.qy = qy; out.qz = qz; out.qw = qw;
  }
  out.identity = Math.abs(out.ty) < 1e-12 && Math.abs(out.qx) + Math.abs(out.qy) + Math.abs(out.qz) < 1e-12;
  return out;
}

// ─────────────────────────────────────────────
// 給畫面的分析：傾斜幾度、哪個方向、有沒有硬扭 / 吊不起來
// ─────────────────────────────────────────────

export interface HoistAnalysis {
  /** 傾斜幾度（物件轉了多少） */
  tiltDeg: number;
  /** 轉動的軸（單位向量；沒轉 = 0,0,0） */
  axis: MechVec3;
  /** 四個吊點：最小平方法的平面離哪個吊點最遠（場景單位）；其他 = 0 */
  residual: number;
  /** 兩個吊點：高度差大過兩點的距離 */
  unreachable: boolean;
  /** 兩個吊點：實際的高度差（場景單位，要拉出來的） */
  heightDiff: number;
}

export function analyzeHoist(s: HoistSolver, h: ArrayLike<number>): HoistAnalysis {
  const pose = solveHoist(s, h, newHoistPose());
  const sin = Math.hypot(pose.qx, pose.qy, pose.qz);
  const tiltDeg = (2 * Math.atan2(sin, Math.abs(pose.qw)) * 180) / Math.PI;
  const axis = sin > 1e-12 ? { x: pose.qx / sin, y: pose.qy / sin, z: pose.qz / sin } : { x: 0, y: 0, z: 0 };
  let residual = 0;
  if (s.n === 4) {
    // 高度的變化量 h 要是 平移 + 一個斜面；對不上的就是硬的東西會被扭到的量
    let mean = 0, a = 0, b = 0;
    for (let i = 0; i < 4; i++) { mean += h[i] / 4; a += s.w0[i] * h[i]; b += s.w1[i] * h[i]; }
    for (let i = 0; i < 4; i++) residual = Math.max(residual, Math.abs(h[i] - (mean + a * s.dx[i] + b * s.dz[i])));
  }
  return { tiltDeg, axis, residual, unreachable: pose.unreachable, heightDiff: s.n === 2 ? h[1] - h[0] : 0 };
}

/** 傾斜的方向字：繞著觀眾的左右軸轉 = 前後傾；繞著前後軸轉 = 左右傾；其他 = 斜向 */
export function tiltWord(axis: MechVec3, front: MechVec3 | null | undefined): '前後' | '左右' | '斜向' {
  const f = horizontalFront(front);
  const r = audienceRight(f);
  const hl = Math.hypot(axis.x, axis.z);
  if (hl < 1e-9) return '斜向';
  const ax = axis.x / hl, az = axis.z / hl;
  if (Math.abs(ax * r.x + az * r.z) > 0.92) return '前後';
  if (Math.abs(ax * f.x + az * f.z) > 0.92) return '左右';
  return '斜向';
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** 「傾斜 2.3°（前後）」；幾乎沒傾斜 →「沒有傾斜」 */
export function tiltText(a: Pick<HoistAnalysis, 'tiltDeg' | 'axis'>, front: MechVec3 | null | undefined): string {
  if (a.tiltDeg < 0.05) return '沒有傾斜';
  return `傾斜 ${round1(a.tiltDeg)}°（${tiltWord(a.axis, front)}）`;
}

export const HOIST_MESSAGES = {
  planar: (cm: string) => `四個吊點的高度不在同一個平面上（差 ${cm} cm）：硬的東西會被扭到`,
  reach: (diff: string, dist: string) => `兩個吊點的高度差（${diff} m）比它們之間的距離（${dist} m）還大：吊不起來，最多只能斜到垂直`,
} as const;

const trimNum = (v: number, d = 1) => String(Math.round(v * 10 ** d) / 10 ** d);

/** 一堆高度（每個長度 = 吊點數）裡最糟的：四點離平面最遠多少、兩點高度差最大多少（吊不起來的那些） */
export interface HoistWorst { residual: number; reach: number }

export function hoistWorst(s: HoistSolver, heights: ArrayLike<number>[]): HoistWorst {
  const w: HoistWorst = { residual: 0, reach: 0 };
  for (const h of heights) {
    const a = analyzeHoist(s, h);
    w.residual = Math.max(w.residual, a.residual);
    if (a.unreachable) w.reach = Math.max(w.reach, Math.abs(a.heightDiff));
  }
  return w;
}

/**
 * 最糟的情況 → 要提醒的字（同一種只說一次，沒有 = 空）。
 * sceneUnitsPerMeter：公尺 → 場景單位的倍率（= 1 ÷ 測距校準倍率），用來換成公分 / 公尺說給人聽。
 */
export function hoistWarningsFrom(s: HoistSolver, w: HoistWorst, sceneUnitsPerMeter: number): string[] {
  const ms = sceneUnitsPerMeter > 0 ? sceneUnitsPerMeter : 1;
  const out: string[] = [];
  if (s.n === 4 && w.residual > Math.max(0.01 * ms, 0.002 * s.span)) out.push(HOIST_MESSAGES.planar(trimNum((w.residual / ms) * 100)));
  if (w.reach > 0) out.push(HOIST_MESSAGES.reach(trimNum(w.reach / ms, 2), trimNum(s.len / ms, 2)));
  return out;
}

/** 這組高度（場景單位）要提醒的事 */
export function hoistWarnings(s: HoistSolver, h: ArrayLike<number>, sceneUnitsPerMeter: number): string[] {
  return hoistWarningsFrom(s, hoistWorst(s, [h]), sceneUnitsPerMeter);
}

// ─────────────────────────────────────────────
// 一組吊掛 = 整組 + 它的吊點（從機關清單整理出來）
// ─────────────────────────────────────────────

export type HoistLike = Pick<Mechanism, 'id' | 'name' | 'variant' | 'rigId' | 'rigIndex' | 'attach'>;

export interface HoistRigDef {
  rigId: string;
  name: string;
  /** 照吊點編號排好 */
  hoistIds: string[];
  hoistNames: string[];
  solver: HoistSolver;
}

/** 機關清單 → 每一組吊掛（吊點不到 2 個 / 位置算不出姿勢的略過：那組的物件就靜止） */
export function buildHoistRigs(mechs: ReadonlyArray<HoistLike> | null | undefined): HoistRigDef[] {
  if (!mechs) return [];
  const out: HoistRigDef[] = [];
  for (const rig of mechs) {
    if (rig.variant !== 'hoist_rig') continue;
    const hs = mechs
      .filter(m => m.variant === 'hoist' && m.rigId === rig.id && m.attach)
      .sort((a, b) => (a.rigIndex ?? 0) - (b.rigIndex ?? 0));
    const solver = compileHoistSolver(hs.map(h => h.attach!));
    if (!solver) continue;
    out.push({ rigId: rig.id, name: rig.name, hoistIds: hs.map(h => h.id), hoistNames: hs.map(h => h.name), solver });
  }
  return out;
}

/** 整組吊掛的吊點（照編號排好）；給清單、表單用 */
export function hoistsOfRig<T extends Pick<Mechanism, 'variant' | 'rigId' | 'rigIndex'>>(mechs: T[], rigId: string): T[] {
  return mechs.filter(m => m.variant === 'hoist' && m.rigId === rigId).sort((a, b) => (a.rigIndex ?? 0) - (b.rigIndex ?? 0));
}

// ─────────────────────────────────────────────
// 吊點可以選的位置（物件外框的角和邊緣中間，在物件的上面）
// ─────────────────────────────────────────────

export type HoistSpot = 'leftFront' | 'rightFront' | 'leftBack' | 'rightBack' | 'leftMid' | 'rightMid' | 'frontMid' | 'backMid' | 'center';

export const HOIST_SPOTS: { key: HoistSpot; label: string }[] = [
  { key: 'leftFront', label: '左前角' },
  { key: 'rightFront', label: '右前角' },
  { key: 'leftBack', label: '左後角' },
  { key: 'rightBack', label: '右後角' },
  { key: 'leftMid', label: '左緣中間' },
  { key: 'rightMid', label: '右緣中間' },
  { key: 'frontMid', label: '前緣中間' },
  { key: 'backMid', label: '後緣中間' },
  { key: 'center', label: '中心' },
];

/** 新增吊點時，沒被用過的位置依序挑：左右中間 → 前後中間 → 四個角 → 中心 */
export function nextHoistSpot(used: HoistSpot[]): HoistSpot {
  const order: HoistSpot[] = ['leftMid', 'rightMid', 'frontMid', 'backMid', 'leftFront', 'rightFront', 'leftBack', 'rightBack', 'center'];
  return order.find(k => !used.includes(k)) ?? 'center';
}

/**
 * 外框（場景座標）+ 位置名字 → 吊點的位置（場景單位）。吊點都在物件最上面。
 * 左右 = 觀眾看過去的左右；前 = 靠近觀眾。外框投影到舞台的右 / 上 / 前方向上量，舞台不是正對 X 或 Z 軸時也對。
 */
export function spotFromBox(box: StageBox, spot: HoistSpot, front: MechVec3): MechVec3 {
  const f = horizontalFront(front);
  const r = audienceRight(f);
  let rMin = Infinity, rMax = -Infinity, fMin = Infinity, fMax = -Infinity, uMax = -Infinity;
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const pr = x * r.x + z * r.z, pf = x * f.x + z * f.z;
    rMin = Math.min(rMin, pr); rMax = Math.max(rMax, pr);
    fMin = Math.min(fMin, pf); fMax = Math.max(fMax, pf);
    uMax = Math.max(uMax, y);
  }
  const rMid = (rMin + rMax) / 2, fMid = (fMin + fMax) / 2;
  const pick: Record<HoistSpot, [number, number]> = {
    leftFront: [rMin, fMax], rightFront: [rMax, fMax], leftBack: [rMin, fMin], rightBack: [rMax, fMin],
    leftMid: [rMin, fMid], rightMid: [rMax, fMid], frontMid: [rMid, fMax], backMid: [rMid, fMin], center: [rMid, fMid],
  };
  const [pr, pf] = pick[spot];
  return { x: r.x * pr + f.x * pf || 0, y: uMax, z: r.z * pr + f.z * pf || 0 };
}

// ─────────────────────────────────────────────
// 沿著移動檢查（吊點各自的時間不一樣，中間會有不在同一個平面上的時候）
// ─────────────────────────────────────────────

/** 一個吊點這一次的移動（公尺）：延遲 delay 秒才開始，花 duration 秒走完，等速 */
export interface HoistLeg { from: number; to: number; delay: number; duration: number }

export function hoistLegAt(leg: HoistLeg, t: number): number {
  if (t < leg.delay) return leg.from;
  if (!(leg.duration > 0) || t >= leg.delay + leg.duration) return leg.to;
  return leg.from + (leg.to - leg.from) * ((t - leg.delay) / leg.duration);
}

/**
 * 沿著這一次移動要檢查的高度（場景單位）：每個吊點等速、各自的延遲和走幾秒，高度對時間是一段一段的直線，
 * 「離平面多遠」對高度是凸的 → 最大值一定出現在某個吊點開始動 / 到位的那一刻，只要取這幾個時間點。
 */
export function hoistMoveSamples(legs: HoistLeg[], sceneUnitsPerMeter: number): Float64Array[] {
  const ms = sceneUnitsPerMeter > 0 ? sceneUnitsPerMeter : 1;
  const times = new Set<number>([0]);
  for (const l of legs) { times.add(l.delay); times.add(l.delay + l.duration); }
  return [...times].sort((a, b) => a - b).map(t => Float64Array.from(legs, l => hoistLegAt(l, t) * ms));
}

// ─────────────────────────────────────────────
// 每個 cue 的吊掛檢查（機關分頁：整組標題上的傾斜字和提醒）
// ─────────────────────────────────────────────

export interface RigCueCheck {
  /** 這個 cue 到位時的傾斜 */
  tilt: HoistAnalysis;
  /** 到位時的提醒 + 走過來的路上的提醒（同樣的字只留一次） */
  warnings: string[];
}

/** 一個 cue 上一個吊點的資料（從機關檢查 MechCheck 和位置整理來；沒有 = 沒資料） */
export interface HoistCueItem { value: number; from: number | null; delay: number; duration: number }

/**
 * 每個 cue、每一組吊掛的傾斜和提醒。
 * itemOf：這個 cue 這個吊點的 { 位置, 上一個 cue 的位置, 延遲, 走幾秒 }；沒有上一個 cue（第一個 cue）from = null
 */
export function checkHoistRigs(
  rigs: HoistRigDef[], cueIds: string[], itemOf: (cueId: string, hoistId: string) => HoistCueItem | null, sceneUnitsPerMeter: number,
): Map<string, Map<string, RigCueCheck>> {
  const ms = sceneUnitsPerMeter > 0 ? sceneUnitsPerMeter : 1;
  const out = new Map<string, Map<string, RigCueCheck>>();
  for (const cueId of cueIds) {
    const row = new Map<string, RigCueCheck>();
    for (const rig of rigs) {
      const items = rig.hoistIds.map(id => itemOf(cueId, id));
      if (items.some(x => !x)) continue;
      const to = Float64Array.from(items, x => x!.value * ms);
      const samples: ArrayLike<number>[] = [to];
      if (items.every(x => x!.from !== null)) {
        samples.push(...hoistMoveSamples(items.map(x => ({ from: x!.from!, to: x!.value, delay: x!.delay, duration: x!.duration })), ms));
      }
      const warnings = hoistWarningsFrom(rig.solver, hoistWorst(rig.solver, samples), ms);
      row.set(rig.rigId, { tilt: analyzeHoist(rig.solver, to), warnings });
    }
    out.set(cueId, row);
  }
  return out;
}
