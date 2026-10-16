// 自動貼 UV：找出每個 LED 物件的「螢幕」（平面片），算每一片的座標系（純函式，只吃一堆數字）
//
// 輸入是世界座標的三角形（docRead.ts 從 gltf-transform 的文件讀出來）。一個物件 = 一堆 PrimGeom（一個 primitive 一份）。
//   螢幕三角形 = 材質名字有 LED 的 primitive 裡的三角形；整個物件都沒有這種材質 → 全部三角形。
//   其他 primitive（外框、背板…）不是螢幕，但物件底下每個 mesh 都吃同一張 LED 貼圖，所以它們的頂點也要有 UV：
//   一律用「離它最近的那一片螢幕」的座標算，再夾進那一片的範圍裡（外框會變成螢幕邊緣的顏色，不會把物件的 UV 外框撐大）。
//
// 平面判斷（第 1 階段）：
//   三角形照位置焊起來分成幾片（跟 index 無關：硬邊匯出會把同一個位置的頂點複製很多份）；
//   每一片：最佳平面的 RMS 距離 <= 長邊的 0.3 %，而且（面積加權）99.5 % 以上的三角形法線跟平均法線差在 3 度內 → 平面。
//   有厚度的板子（前後兩個大面平行、面積差不多）→ 取朝觀眾的那一面當螢幕，側邊和背面跟著同一個函數算。
//   不是平面的那一片 → 試著當圓柱面的一段弧（cylinder.ts，第 2 階段；整圈 360 度的封閉圓柱第 4 階段，接縫放在背對觀眾那一側）；
//   不是圓柱 → 試著當「沿直線擠出的曲面」（波浪、折角…，extrusion.ts：側面形狀照弧長拉直，不拉伸，第 4 階段）；
//   也不是 → 試著用 LSCM 攤平（freeform.ts，第 4 階段：圓錐、一塊球面…，會有拉伸，變形百分比照實告訴製作）；
//   都做不到（有洞、封閉…）→ 整個物件不處理，並估一下「硬貼會變形多少」給製作看。
//   製作可以手動指定整個物件「平面」「弧面」或「自由曲面」（override），指定了就照他的，變形百分比照實告訴他。
//
// 座標：螢幕片的 right / up / normal
//   normal = 三角形繞向的法線（LED 只畫正面，觀眾站在 normal 這一側看）；鏡像過的節點（行列式 < 0）繞向會反，要乘回來。
//   牆（|normal·Y| < 0.9）：up = 世界朝上投影到平面；地屏 / 天花板：up = 舞台後方（離觀眾最遠）。
//   right = up × normal（站在 normal 那一側的人看過去的右邊），畫面的 y 朝下（down = -up）。

import { cross, dot, eigenSym3, length, normalize, scale, sub, WORLD_UP, type Vec3 } from './geometry';
import { arcLocal, arcPoint, fitArc, resolveSeamCorners, type ArcMap } from './cylinder';
import { extLocal, extPoint, fitExtrusion, type ExtMap } from './extrusion';
import { fitFreeform, freeLocal, type FreeMap } from './freeform';

export interface PrimGeom {
  /** 世界座標的頂點，每個頂點 3 個數字 */
  pos: Float64Array;
  /** 三角形的頂點編號（每 3 個一組） */
  index: Uint32Array;
  /** 螢幕（材質有 LED）的 primitive */
  screen: boolean;
  /** 節點世界矩陣行列式的正負：鏡像過 = -1（三角形繞向反過來） */
  sign: 1 | -1;
  /** 原本的 UV（每個頂點 2 個數字）；沒有 = null */
  uv: ArrayLike<number> | null;
}

export interface ObjectGeom { prims: PrimGeom[] }

export interface PieceFrame {
  origin: Vec3;
  right: Vec3;
  down: Vec3;
  normal: Vec3;
  /** 螢幕範圍：沿 right、down 的最小 / 最大（文件單位，從 origin 算） */
  minX: number; maxX: number; minY: number; maxY: number;
}

/** 攤平造成的變形（比例：0.012 = 1.2 %）：每個三角形「畫面上的面積 / 實際的面積」跟 1 差多少 */
export interface DistortionStat { max: number; mean: number }

/** 一片螢幕：平面、圓柱面的一段弧（或整圈）、沿直線擠出的曲面（波浪、折角）、自由曲面（LSCM 攤平） */
export interface Piece {
  kind: 'flat' | 'arc' | 'ext' | 'free';
  frame: PieceFrame;
  /** 寬（沿 right）、高（沿 down），文件單位 */
  widthU: number;
  heightU: number;
  /** 螢幕面的面積（文件單位平方） */
  area: number;
  /** 螢幕面的重心（世界座標） */
  center: Vec3;
  /** normal · 舞台正面：1 = 正對觀眾，< 0 = 背對觀眾 */
  facing: number;
  /** 平面誤差 / 長邊（弧面：頂點離圓柱面的 RMS / min(半徑, 長邊)） */
  flatness: number;
  /** 弧面才有：圓柱的擬合結果（半徑、角度範圍、凸或凹、方向） */
  arc?: ArcMap;
  /** 擠出曲面才有：側面形狀的折線、擠出方向 */
  ext?: ExtMap;
  /** 自由曲面才有：攤平後的網格 */
  free?: FreeMap;
  /** 螢幕頂點的外框（排版算舞台位置用） */
  bbox: { min: Vec3; max: Vec3 };
  /** 攤平的變形 */
  distortion: DistortionStat;
  /** 頂點離這片多近算「在這片上」（文件單位） */
  tol: number;
  /** 製作手動指定的類型（不是自動辨識的） */
  forced: boolean;
}

export type UnsupportedKind = 'arc' | 'fold' | 'other' | 'toomany' | 'empty' | 'closed' | 'arcfail' | 'freefail';

/** 製作手動指定整個物件的類型：auto = 自動辨識；free = 自由曲面（先試沿直線擠出，不行再用 LSCM 攤平） */
export type SurfaceOverride = 'auto' | 'flat' | 'arc' | 'free';

export interface ObjectAnalysis {
  /** ok = 每一片都能貼（平面或弧面）；unsupported = 這個物件不處理 */
  kind: 'ok' | 'unsupported';
  unsupported?: UnsupportedKind;
  /** 不能貼的曲面：硬貼的話會變形多少（用最接近的平面或圓柱估的），給製作看為什麼不收 */
  freeform?: { distortion: DistortionStat; via: 'flat' | 'arc' };
  /** 製作指定的類型（沒指定 = auto） */
  override?: SurfaceOverride;
  /** 由左到右（從觀眾席看） */
  pieces: Piece[];
  /** 給畫面顯示的提醒（白話） */
  warnings: string[];
  /** 物件所有頂點的外框 */
  bbox: { min: Vec3; max: Vec3 };
  screenTriangles: number;
}

export const RMS_FLAT_REL = 0.003;
export const NORMAL_TOLERANCE_DEG = 3;
export const NORMAL_OUTLIER_AREA = 0.005;
export const MAX_PIECES_PER_OBJECT = 8;
/** 比整個螢幕面積小這個比例的碎片（螺絲、貼字）不算一片螢幕，跟著最近的那片算 */
export const TINY_PIECE_AREA = 0.005;
const WELD_REL = 1e-4;

/** 舞台正面（水平、指向觀眾）：所有 LED 三角面依面積加總（跟 stageCamera.ts 的 stageFrontDirection 同一個算法）。沒有 LED → +Z */
export function stageFrontOf(objects: readonly ObjectGeom[]): Vec3 {
  let sx = 0, sz = 0;
  for (const o of objects) {
    for (const p of o.prims) {
      for (let t = 0; t + 2 < p.index.length; t += 3) {
        const a = p.index[t] * 3, b = p.index[t + 1] * 3, c = p.index[t + 2] * 3;
        const abx = p.pos[b] - p.pos[a], aby = p.pos[b + 1] - p.pos[a + 1], abz = p.pos[b + 2] - p.pos[a + 2];
        const acx = p.pos[c] - p.pos[a], acy = p.pos[c + 1] - p.pos[a + 1], acz = p.pos[c + 2] - p.pos[a + 2];
        // 只要水平的兩個分量（x、z）
        sx += (aby * acz - abz * acy) * p.sign;
        sz += (abx * acy - aby * acx) * p.sign;
      }
    }
  }
  const l = Math.hypot(sx, sz);
  return l < 1e-12 ? [0, 0, 1] : [sx / l, 0, sz / l];
}

/** 物件所有頂點的外框 */
export function boundsOf(geom: ObjectGeom): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of geom.prims) {
    for (let i = 0; i + 2 < p.pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = p.pos[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  return { min, max };
}

interface ScreenTris {
  /** 每個三角形 9 個數字 */
  p: Float64Array;
  /** 單位法線（已經乘過鏡像的正負） */
  n: Float64Array;
  area: Float64Array;
  /** 三個角的焊接編號 */
  w: Int32Array;
  /** 1 = 節點是鏡像的（行列式 < 0）：繞向反過來，角的順序要換過才是「朝觀眾」的逆時針 */
  flip: Uint8Array;
  count: number;
}

function collectScreenTris(geom: ObjectGeom, diag: number): ScreenTris {
  const tol = Math.max(diag * WELD_REL, 1e-12);
  const welds = new Map<string, number>();
  let total = 0;
  for (const pr of geom.prims) if (pr.screen) total += Math.floor(pr.index.length / 3);
  const p = new Float64Array(total * 9), n = new Float64Array(total * 3), area = new Float64Array(total), w = new Int32Array(total * 3), flip = new Uint8Array(total);
  let count = 0;
  for (const pr of geom.prims) {
    if (!pr.screen) continue;
    const nv = pr.pos.length / 3;
    const weldOf = new Int32Array(nv).fill(-1);
    const weld = (vi: number): number => {
      let id = weldOf[vi];
      if (id >= 0) return id;
      const key = `${Math.round(pr.pos[vi * 3] / tol)},${Math.round(pr.pos[vi * 3 + 1] / tol)},${Math.round(pr.pos[vi * 3 + 2] / tol)}`;
      id = welds.get(key) ?? -1;
      if (id < 0) { id = welds.size; welds.set(key, id); }
      weldOf[vi] = id;
      return id;
    };
    for (let t = 0; t + 2 < pr.index.length; t += 3) {
      const ia = pr.index[t], ib = pr.index[t + 1], ic = pr.index[t + 2];
      const a = ia * 3, b = ib * 3, c = ic * 3;
      const abx = pr.pos[b] - pr.pos[a], aby = pr.pos[b + 1] - pr.pos[a + 1], abz = pr.pos[b + 2] - pr.pos[a + 2];
      const acx = pr.pos[c] - pr.pos[a], acy = pr.pos[c + 1] - pr.pos[a + 1], acz = pr.pos[c + 2] - pr.pos[a + 2];
      const nx = (aby * acz - abz * acy) * pr.sign, ny = (abz * acx - abx * acz) * pr.sign, nz = (abx * acy - aby * acx) * pr.sign;
      const l2 = Math.hypot(nx, ny, nz);
      const ar = l2 / 2;
      if (!(ar > diag * diag * 1e-14)) continue;  // 沒有面積的三角形
      const o = count * 9;
      p[o] = pr.pos[a]; p[o + 1] = pr.pos[a + 1]; p[o + 2] = pr.pos[a + 2];
      p[o + 3] = pr.pos[b]; p[o + 4] = pr.pos[b + 1]; p[o + 5] = pr.pos[b + 2];
      p[o + 6] = pr.pos[c]; p[o + 7] = pr.pos[c + 1]; p[o + 8] = pr.pos[c + 2];
      n[count * 3] = nx / l2; n[count * 3 + 1] = ny / l2; n[count * 3 + 2] = nz / l2;
      area[count] = ar;
      flip[count] = pr.sign < 0 ? 1 : 0;
      w[count * 3] = weld(ia); w[count * 3 + 1] = weld(ib); w[count * 3 + 2] = weld(ic);
      count++;
    }
  }
  return { p, n, area, w, flip, count };
}

function components(tris: ScreenTris): number[][] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
    let c = x;
    while ((parent.get(c) ?? c) !== r) { const nx = parent.get(c)!; parent.set(c, r); c = nx; }
    return r;
  };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (let t = 0; t < tris.count; t++) {
    const a = tris.w[t * 3], b = tris.w[t * 3 + 1], c = tris.w[t * 3 + 2];
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    if (!parent.has(c)) parent.set(c, c);
    union(a, b); union(b, c);
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < tris.count; t++) {
    const r = find(tris.w[t * 3]);
    const g = groups.get(r);
    if (g) g.push(t); else groups.set(r, [t]);
  }
  return [...groups.values()];
}

interface PlaneFit {
  centroid: Vec3;
  normal: Vec3;
  /** 最佳平面的 RMS 距離 */
  rms: number;
  longExtent: number;
  area: number;
  flat: boolean;
  /** 三角形法線（面積加權）的平均方向：「從觀眾席看過去」的投影方向 */
  meanNormal: Vec3;
}

function fitPlane(tris: ScreenTris, ids: readonly number[]): PlaneFit {
  let W = 0;
  const c: Vec3 = [0, 0, 0];
  const S: Vec3 = [0, 0, 0];
  for (const t of ids) {
    const a = tris.area[t];
    W += a;
    for (let k = 0; k < 3; k++) {
      c[k] += (a / 3) * (tris.p[t * 9 + k] + tris.p[t * 9 + 3 + k] + tris.p[t * 9 + 6 + k]);
      S[k] += tris.n[t * 3 + k] * a;
    }
  }
  const centroid = scale(c, 1 / W) as Vec3;
  const m = [0, 0, 0, 0, 0, 0];
  for (const t of ids) {
    const w3 = tris.area[t] / 3;
    for (let v = 0; v < 3; v++) {
      const dx = tris.p[t * 9 + v * 3] - centroid[0], dy = tris.p[t * 9 + v * 3 + 1] - centroid[1], dz = tris.p[t * 9 + v * 3 + 2] - centroid[2];
      m[0] += w3 * dx * dx; m[1] += w3 * dx * dy; m[2] += w3 * dx * dz;
      m[3] += w3 * dy * dy; m[4] += w3 * dy * dz; m[5] += w3 * dz * dz;
    }
  }
  const eig = eigenSym3(m);
  let normal = eig.vectors[0];
  if (dot(normal, S) < 0) normal = scale(normal, -1) as Vec3;
  const rms = Math.sqrt(Math.max(0, eig.values[0]) / W);
  // 長邊：沿兩個大特徵向量的範圍
  const e1 = eig.vectors[1], e2 = eig.vectors[2];
  let lo1 = Infinity, hi1 = -Infinity, lo2 = Infinity, hi2 = -Infinity;
  for (const t of ids) {
    for (let v = 0; v < 3; v++) {
      const d: Vec3 = [tris.p[t * 9 + v * 3] - centroid[0], tris.p[t * 9 + v * 3 + 1] - centroid[1], tris.p[t * 9 + v * 3 + 2] - centroid[2]];
      const x = dot(d, e1), y = dot(d, e2);
      if (x < lo1) lo1 = x; if (x > hi1) hi1 = x;
      if (y < lo2) lo2 = y; if (y > hi2) hi2 = y;
    }
  }
  const longExtent = Math.max(hi1 - lo1, hi2 - lo2);
  let outlier = 0;
  const cosTol = Math.cos((NORMAL_TOLERANCE_DEG * Math.PI) / 180);
  for (const t of ids) {
    const d = tris.n[t * 3] * normal[0] + tris.n[t * 3 + 1] * normal[1] + tris.n[t * 3 + 2] * normal[2];
    if (d < cosTol) outlier += tris.area[t];
  }
  const flat = longExtent > 0 && rms <= RMS_FLAT_REL * longExtent && outlier <= NORMAL_OUTLIER_AREA * W;
  return { centroid, normal, rms, longExtent, area: W, flat, meanNormal: normalize(S) };
}

/** 厚板子：前後兩個大面平行、面積差不多 → 取朝觀眾的那一面的三角形；不是厚板子 = null */
function slabFace(tris: ScreenTris, ids: readonly number[], total: number, front: Vec3): number[] | null {
  const order = [...ids].sort((a, b) => tris.area[b] - tris.area[a]);
  const cosTol = Math.cos((NORMAL_TOLERANCE_DEG * Math.PI) / 180);
  const clusters: { n: Vec3; area: number; ids: number[] }[] = [];
  for (const t of order) {
    const n: Vec3 = [tris.n[t * 3], tris.n[t * 3 + 1], tris.n[t * 3 + 2]];
    let hit = clusters.find(c => dot(c.n, n) >= cosTol);
    if (!hit) {
      if (clusters.length >= 64) return null;
      hit = { n, area: 0, ids: [] };
      clusters.push(hit);
    }
    hit.area += tris.area[t];
    hit.ids.push(t);
  }
  clusters.sort((a, b) => b.area - a.area);
  if (clusters.length < 2) return null;
  const [c1, c2] = clusters;
  if (dot(c1.n, c2.n) > -0.98) return null;
  if (c2.area < c1.area * 0.8) return null;
  if (c1.area + c2.area < total * 0.85) return null;
  const pick = dot(c2.n, front) > dot(c1.n, front) ? c2 : c1;
  return pick.ids;
}

/** 弧面 / 折角 / 其他：看法線散在幾個方向 */
function classifyNonFlat(tris: ScreenTris, ids: readonly number[]): UnsupportedKind {
  const m = [0, 0, 0, 0, 0, 0];
  let total = 0;
  const cosTol = Math.cos((NORMAL_TOLERANCE_DEG * Math.PI) / 180);
  const clusters: { n: Vec3; area: number }[] = [];
  for (const t of ids) {
    const a = tris.area[t];
    const nx = tris.n[t * 3], ny = tris.n[t * 3 + 1], nz = tris.n[t * 3 + 2];
    m[0] += a * nx * nx; m[1] += a * nx * ny; m[2] += a * nx * nz;
    m[3] += a * ny * ny; m[4] += a * ny * nz; m[5] += a * nz * nz;
    total += a;
    const hit = clusters.find(c => dot(c.n, [nx, ny, nz]) >= cosTol);
    if (hit) hit.area += a; else if (clusters.length < 256) clusters.push({ n: [nx, ny, nz], area: a });
  }
  const eig = eigenSym3(m);
  const trace = eig.values[0] + eig.values[1] + eig.values[2];
  const significant = clusters.filter(c => c.area >= total * 0.02).length;
  if (trace > 0 && eig.values[0] / trace < 0.02) return significant <= 3 ? 'fold' : 'arc';
  return 'other';
}


/** 畫面上變形的門檻：<= 0.5 % 綠（看不出來）、<= 5 % 黃（輕微拉伸）、超過 = 紅（會變形） */
export const DISTORTION_OK = 0.005;
export const DISTORTION_WARN = 0.05;

/** 辨識「這個頂點在這片螢幕上」的最小容差（文件單位 = 這片長寬和的百萬分之一） */
const TOL_REL = 1e-6;

function cornerOf(tris: ScreenTris, t: number, k: number): Vec3 {
  return [tris.p[t * 9 + k * 3], tris.p[t * 9 + k * 3 + 1], tris.p[t * 9 + k * 3 + 2]];
}

/** 一組三角形的螢幕頂點（焊接後每個位置一份）、三角形法線 / 面積 / 重心：弧面擬合的輸入 */
function arcInputOf(tris: ScreenTris, ids: readonly number[]) {
  const seen = new Set<number>();
  const pts: number[] = [];
  const n = new Float64Array(ids.length * 3), area = new Float64Array(ids.length), c = new Float64Array(ids.length * 3);
  ids.forEach((t, i) => {
    for (let k = 0; k < 3; k++) {
      const w = tris.w[t * 3 + k];
      if (seen.has(w)) continue;
      seen.add(w);
      pts.push(tris.p[t * 9 + k * 3], tris.p[t * 9 + k * 3 + 1], tris.p[t * 9 + k * 3 + 2]);
    }
    n[i * 3] = tris.n[t * 3]; n[i * 3 + 1] = tris.n[t * 3 + 1]; n[i * 3 + 2] = tris.n[t * 3 + 2];
    area[i] = tris.area[t];
    for (let a = 0; a < 3; a++) c[i * 3 + a] = (tris.p[t * 9 + a] + tris.p[t * 9 + 3 + a] + tris.p[t * 9 + 6 + a]) / 3;
  });
  return { points: Float64Array.from(pts), triN: n, triArea: area, triC: c };
}

function boxOfIds(tris: ScreenTris, ids: readonly number[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const t of ids) {
    for (let k = 0; k < 3; k++) {
      for (let a = 0; a < 3; a++) {
        const v = tris.p[t * 9 + k * 3 + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
  }
  return { min, max };
}

/**
 * 攤平的變形：每個三角形「畫面上的面積 / 實際的面積」跟 1 差多少。
 * 弧面的網格是用弦（直線）近似圓弧的，但 LED 實際是光滑的圓柱，所以把弦長換成弧長再比（不然粗網格會被冤枉成「有一點變形」）。
 */
function measureDistortion(tris: ScreenTris, ids: readonly number[], piece: Piece): DistortionStat {
  const W = piece.widthU, H = piece.heightU;
  let max = 0, sum = 0, sumArea = 0;
  const arcIsY = piece.arc?.arcVertical ?? false;
  for (const t of ids) {
    const a3 = tris.area[t];
    if (!(a3 > 0)) continue;
    const l = [0, 1, 2].map(k => { const c = cornerOf(tris, t, k); return localOnPiece(piece, c[0], c[1], c[2]); });
    if (piece.arc?.closed) {
      // 封閉圓柱：接縫上的角是 0 還是 1，看同一個三角形的其他角（跟寫 UV 同一個規則）
      const key = arcIsY ? 'ly' : 'lx';
      const r = resolveSeamCorners([l[0][key], l[1][key], l[2][key]], [!!l[0].seam, !!l[1].seam, !!l[2].seam]);
      for (let k = 0; k < 3; k++) l[k][key] = r[k];
    }
    const auv = Math.abs((l[1].lx - l[0].lx) * (l[2].ly - l[0].ly) - (l[2].lx - l[0].lx) * (l[1].ly - l[0].ly)) / 2 * W * H;
    let ratio = auv / a3;
    if (piece.arc) {
      const f = l.map(x => (arcIsY ? x.ly : x.lx));
      const dth = (Math.max(...f) - Math.min(...f)) * piece.arc.span;
      if (dth > 1e-9) ratio *= Math.sin(dth / 2) / (dth / 2);
    }
    if (!Number.isFinite(ratio)) continue;
    const dev = Math.abs(ratio - 1);
    if (dev > max) max = dev;
    sum += dev * a3;
    sumArea += a3;
  }
  return { max, mean: sumArea > 0 ? sum / sumArea : 0 };
}

function buildPiece(tris: ScreenTris, ids: readonly number[], fit: PlaneFit, front: Vec3, forced: boolean): Piece | null {
  const n = normalize(fit.normal);
  let up: Vec3;
  if (Math.abs(dot(n, WORLD_UP)) < 0.9) {
    up = normalize(sub(WORLD_UP, scale(n, dot(WORLD_UP, n))));
  } else {
    // 地屏 / 天花板：畫面上方 = 舞台後方（離觀眾最遠）
    const back: Vec3 = scale(front, -1);
    up = normalize(sub(back, scale(n, dot(back, n))));
  }
  if (length(up) < 0.5) return null;
  const right = normalize(cross(up, n));
  const down = scale(up, -1) as Vec3;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const o = fit.centroid;
  for (const t of ids) {
    for (let v = 0; v < 3; v++) {
      const d: Vec3 = [tris.p[t * 9 + v * 3] - o[0], tris.p[t * 9 + v * 3 + 1] - o[1], tris.p[t * 9 + v * 3 + 2] - o[2]];
      const x = dot(d, right), y = dot(d, down);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const widthU = maxX - minX, heightU = maxY - minY;
  if (!(widthU > 0) || !(heightU > 0)) return null;
  const piece: Piece = {
    kind: 'flat',
    frame: { origin: o, right, down, normal: n, minX, maxX, minY, maxY },
    widthU, heightU,
    area: fit.area,
    center: fit.centroid,
    facing: dot(n, front),
    flatness: fit.longExtent > 0 ? fit.rms / fit.longExtent : 0,
    bbox: boxOfIds(tris, ids),
    distortion: { max: 0, mean: 0 },
    tol: TOL_REL * (widthU + heightU),
    forced,
  };
  piece.distortion = measureDistortion(tris, ids, piece);
  return piece;
}

type ArcBuild = { piece: Piece; outward: number } | { piece: null; reason: 'degenerate' | 'flat' | 'closed' | 'fit' };

/** 圓柱面的一段弧；force = 製作手動指定（殘差再大也貼，變形多少照實算） */
function buildArcPiece(tris: ScreenTris, ids: readonly number[], fit: PlaneFit, front: Vec3, force: boolean, seamDeg = 0): ArcBuild {
  const res = fitArc({ ...arcInputOf(tris, ids), front, force, seamDeg });
  if (!res.ok) return { piece: null, reason: res.reason };
  const m = res.map;
  const P = (lx: number, ly: number) => arcPoint(m, lx, ly);
  const piece: Piece = {
    kind: 'arc',
    frame: {
      origin: P(0.5, 0.5),
      right: normalize(sub(P(0.51, 0.5), P(0.49, 0.5))),
      down: normalize(sub(P(0.5, 0.51), P(0.5, 0.49))),
      normal: res.midNormal,
      minX: 0, maxX: res.width, minY: 0, maxY: res.height,
    },
    widthU: res.width,
    heightU: res.height,
    area: fit.area,
    center: fit.centroid,
    facing: dot(res.midNormal, front),
    flatness: res.rmsRel,
    arc: m,
    bbox: boxOfIds(tris, ids),
    distortion: { max: 0, mean: 0 },
    tol: Math.max(TOL_REL * (res.width + res.height), 3 * m.maxResidual),
    forced: force,
  };
  piece.distortion = measureDistortion(tris, ids, piece);
  return { piece, outward: res.outwardScore };
}

type ExtBuild = { piece: Piece } | { piece: null; reason: 'degenerate' | 'flat' | 'notExtrusion' | 'profile' | 'closedProfile' };

/** 沿直線擠出的曲面（波浪、折角、不規則的弧…）：側面形狀照弧長拉直 */
function buildExtPiece(tris: ScreenTris, ids: readonly number[], fit: PlaneFit, front: Vec3, forced: boolean): ExtBuild {
  const n = ids.length;
  const tri = new Float64Array(n * 9), triN = new Float64Array(n * 3), triArea = new Float64Array(n);
  ids.forEach((t, i) => {
    for (let k = 0; k < 9; k++) tri[i * 9 + k] = tris.p[t * 9 + k];
    for (let k = 0; k < 3; k++) triN[i * 3 + k] = tris.n[t * 3 + k];
    triArea[i] = tris.area[t];
  });
  const res = fitExtrusion({ tri, triN, triArea, front });
  if (!res.ok) return { piece: null, reason: res.reason };
  const m = res.map;
  const P = (lx: number, ly: number) => extPoint(m, lx, ly);
  const piece: Piece = {
    kind: 'ext',
    frame: {
      origin: P(0.5, 0.5),
      right: normalize(sub(P(0.51, 0.5), P(0.49, 0.5))),
      down: normalize(sub(P(0.5, 0.51), P(0.5, 0.49))),
      normal: res.meanNormal,
      minX: 0, maxX: res.width, minY: 0, maxY: res.height,
    },
    widthU: res.width,
    heightU: res.height,
    area: fit.area,
    center: fit.centroid,
    facing: dot(res.meanNormal, front),
    flatness: 0,
    ext: m,
    bbox: boxOfIds(tris, ids),
    distortion: { max: 0, mean: 0 },
    tol: Math.max(TOL_REL * (res.width + res.height), 3 * m.maxResidual),
    forced,
  };
  piece.distortion = measureDistortion(tris, ids, piece);
  return { piece };
}

type FreeBuild = { piece: Piece; flippedRatio: number } | { piece: null; reason: 'degenerate' | 'topology' | 'solve' };

/** 自由曲面：LSCM 攤平（圓盤狀的網格；有洞、封閉、繞向不一致的不行） */
function buildFreePiece(tris: ScreenTris, ids: readonly number[], fit: PlaneFit, front: Vec3, forced: boolean): FreeBuild {
  const compact = new Map<number, number>();
  const vp: number[] = [];
  const tri = new Int32Array(ids.length * 3);
  ids.forEach((t, i) => {
    const order = tris.flip[t] ? [0, 2, 1] : [0, 1, 2];
    order.forEach((k, j) => {
      const w = tris.w[t * 3 + k];
      let id = compact.get(w);
      if (id === undefined) {
        id = compact.size;
        compact.set(w, id);
        vp.push(tris.p[t * 9 + k * 3], tris.p[t * 9 + k * 3 + 1], tris.p[t * 9 + k * 3 + 2]);
      }
      tri[i * 3 + j] = id;
    });
  });
  const res = fitFreeform({ vpos: Float64Array.from(vp), tri, front });
  if (!res.ok) return { piece: null, reason: res.reason };
  const m = res.map;
  const up = Math.abs(dot(res.meanNormal, WORLD_UP)) < 0.9
    ? normalize(sub(WORLD_UP, scale(res.meanNormal, dot(WORLD_UP, res.meanNormal))))
    : normalize(sub(scale(front, -1), scale(res.meanNormal, dot(scale(front, -1), res.meanNormal))));
  const piece: Piece = {
    kind: 'free',
    frame: {
      origin: fit.centroid,
      right: normalize(cross(up, res.meanNormal)),
      down: scale(up, -1) as Vec3,
      normal: res.meanNormal,
      minX: 0, maxX: res.width, minY: 0, maxY: res.height,
    },
    widthU: res.width,
    heightU: res.height,
    area: fit.area,
    center: fit.centroid,
    facing: dot(res.meanNormal, front),
    flatness: 0,
    free: m,
    bbox: boxOfIds(tris, ids),
    distortion: { max: 0, mean: 0 },
    tol: Math.max(TOL_REL * (res.width + res.height), 1e-6 * Math.max(res.width, res.height)),
    forced,
  };
  piece.distortion = measureDistortion(tris, ids, piece);
  // 攤平後有地方翻到背面（重疊）：不管面積比例怎麼算都不能說沒變形
  if (m.flippedRatio > 0.001) piece.distortion = { max: Math.max(piece.distortion.max, 1), mean: Math.max(piece.distortion.mean, m.flippedRatio) };
  return { piece, flippedRatio: m.flippedRatio };
}

/** 從觀眾席看，由左到右：沿 (世界朝上 × 舞台正面) 的位置 */
export function audienceRight(front: Vec3): Vec3 {
  return normalize(cross(WORLD_UP, front));
}

export function analyzeObject(geom: ObjectGeom, front: Vec3, override: SurfaceOverride = 'auto', seamDeg = 0): ObjectAnalysis {
  const bbox = boundsOf(geom);
  const diag = length(sub(bbox.max, bbox.min));
  const empty = (unsupported: UnsupportedKind, warnings: string[] = []): ObjectAnalysis =>
    ({ kind: 'unsupported', unsupported, pieces: [], warnings, bbox, screenTriangles: 0, override });
  if (!(diag > 0)) return empty('empty');
  const tris = collectScreenTris(geom, diag);
  if (tris.count === 0) return empty('empty');
  let totalArea = 0;
  for (let t = 0; t < tris.count; t++) totalArea += tris.area[t];

  const comps = components(tris).sort((a, b) => b.length - a.length);
  const pieces: Piece[] = [];
  const warnings: string[] = [];
  let worst: UnsupportedKind | null = null;
  let freeform: ObjectAnalysis['freeform'];
  const rank: Record<string, number> = { freefail: 6, arcfail: 5, closed: 4, arc: 3, fold: 2, other: 1 };
  const worse = (k: UnsupportedKind) => { if (!worst || rank[k] > rank[worst]) worst = k; };
  let mixedFacing = false;
  const tryFlat = override === 'auto' || override === 'flat';
  const tryArc = override === 'auto' || override === 'arc';
  const tryFree = override === 'auto' || override === 'free';
  for (const ids of comps) {
    let compArea = 0;
    for (const t of ids) compArea += tris.area[t];
    if (compArea < totalArea * TINY_PIECE_AREA) continue;  // 螺絲、貼字：跟著最近的那片

    let fit = fitPlane(tris, ids);
    let piece: Piece | null = null;
    let fail: UnsupportedKind | null = null;
    if (tryFlat) {
      let faceIds: readonly number[] = ids;
      if (!fit.flat) {
        const face = slabFace(tris, ids, compArea, front);
        if (face) {
          const f2 = fitPlane(tris, face);
          if (f2.flat) { fit = f2; faceIds = face; }
        }
      }
      if (fit.flat || override === 'flat') {
        // 手動指定平面、但其實不平：沿著平均法線投影（從觀眾席看過去的樣子），變形多少照實算
        piece = buildPiece(tris, faceIds, fit.flat ? fit : { ...fit, normal: fit.meanNormal }, front, override === 'flat');
        if (!piece) fail = 'other';
      }
    }
    let closedNonCircle = false;
    if (!piece && !fail && tryArc) {
      const arc = buildArcPiece(tris, ids, fit, front, override === 'arc', seamDeg);
      if (arc.piece) {
        piece = arc.piece;
        if (Math.abs(arc.outward) < 0.8) mixedFacing = true;
      } else if (override === 'arc') {
        fail = 'arcfail';
      } else if (arc.reason === 'closed') {
        closedNonCircle = true;
      }
    }
    if (!piece && !fail && tryFree) {
      // 沿直線擠出的曲面（波浪、折角…）：側面形狀照弧長拉直；不是的話用 LSCM 攤平
      const ext = buildExtPiece(tris, ids, fit, front, override === 'free');
      // 自動辨識：擠出的攤法要是還是拉伸得很厲害（其實不是真的擠出，只是法線差不多垂直）→ 改用 LSCM 試試
      if (ext.piece && (override === 'free' || ext.piece.distortion.max <= DISTORTION_WARN)) {
        piece = ext.piece;
      } else {
        const free = buildFreePiece(tris, ids, fit, front, override === 'free');
        if (free.piece) {
          piece = free.piece;
          if (free.flippedRatio > 0.001) warnings.push(`攤平後有 ${(free.flippedRatio * 100).toFixed(1)}% 的面積翻到背面（重疊）：這塊形狀太複雜，建議選「保留原本 UV」或在 C4D 手動展開`);
        } else if (override === 'free') {
          fail = 'freefail';
        }
      }
    }
    if (!piece && !fail) {
      if (closedNonCircle) {
        fail = 'closed';
      } else {
        fail = classifyNonFlat(tris, ids);
        // 什麼都攤不平：估一下硬貼會變形多少（用最接近的平面或圓柱）
        const cands: { distortion: DistortionStat; via: 'flat' | 'arc' }[] = [];
        const pf = buildPiece(tris, ids, { ...fit, normal: fit.meanNormal }, front, true);
        if (pf) cands.push({ distortion: pf.distortion, via: 'flat' });
        const pa = buildArcPiece(tris, ids, fit, front, true);
        if (pa.piece) cands.push({ distortion: pa.piece.distortion, via: 'arc' });
        cands.sort((a, b) => a.distortion.mean - b.distortion.mean);
        if (cands[0] && (!freeform || cands[0].distortion.mean > freeform.distortion.mean)) freeform = cands[0];
        if (tryFree && override === 'auto') fail = 'freefail';
      }
    }
    if (piece) pieces.push(piece);
    else worse(fail ?? 'other');
  }
  if (worst) return { kind: 'unsupported', unsupported: worst, freeform, pieces: [], warnings, bbox, screenTriangles: tris.count, override };
  if (pieces.length === 0) return empty('empty');
  if (pieces.length > MAX_PIECES_PER_OBJECT) {
    return { kind: 'unsupported', unsupported: 'toomany', pieces: [], warnings, bbox, screenTriangles: tris.count, override };
  }
  // 由左到右（觀眾席看過去）
  const right = audienceRight(front);
  pieces.sort((a, b) => dot(a.center, right) - dot(b.center, right));
  if (pieces.some(p => p.facing < -0.2)) {
    warnings.push('有一片的正面朝向舞台後方（背對觀眾）：LED 只畫正面，觀眾席看不到這片的畫面');
  }
  if (mixedFacing) warnings.push('弧面的面有的朝外、有的朝內：貼出來的左右方向可能有一部分是反的，請在 3D 預覽檢查');
  return { kind: 'ok', pieces, warnings, bbox, screenTriangles: tris.count, override };
}

// ───────────────────────── 頂點 → 螢幕片 ─────────────────────────

export interface PieceLocal { piece: number; lx: number; ly: number; dist: number }

/** 這個點離某片螢幕有多遠、在它的哪裡（lx、ly = 0~1 的比例，可能超出 0~1）；平面片看長方形，弧面片看圓柱面的那一段；
 *  seam = 封閉圓柱接縫上的點（沿弧的位置是 0 還是 1 要看同一個三角形的其他角，resolveSeamCorners） */
export function localOnPiece(piece: Piece, x: number, y: number, z: number): { lx: number; ly: number; dist: number; seam?: boolean } {
  if (piece.arc) return arcLocal(piece.arc, x, y, z);
  if (piece.ext) return extLocal(piece.ext, x, y, z);
  if (piece.free) return freeLocal(piece.free, x, y, z);
  const f = piece.frame;
  const dx = x - f.origin[0], dy = y - f.origin[1], dz = z - f.origin[2];
  const px = dx * f.right[0] + dy * f.right[1] + dz * f.right[2];
  const py = dx * f.down[0] + dy * f.down[1] + dz * f.down[2];
  const pz = dx * f.normal[0] + dy * f.normal[1] + dz * f.normal[2];
  const ox = Math.max(f.minX - px, 0, px - f.maxX);
  const oy = Math.max(f.minY - py, 0, py - f.maxY);
  return { lx: (px - f.minX) / (f.maxX - f.minX), ly: (py - f.minY) / (f.maxY - f.minY), dist: Math.hypot(pz, ox, oy) };
}

/**
 * 每個頂點屬於哪一片螢幕（離哪一片最近）；lx、ly 已經夾進 0~1。
 * 不是螢幕的 primitive（外框、背板、舞台結構，沒有 LED 畫面）整個歸同一片（離它的中心最近的那一片）：
 * 它的三角形常常橫跨好幾片螢幕，如果各頂點各歸各的，排版時這幾片被擺得很遠，這些三角形的 UV 就會拉成橫跨整張畫布的大三角形，
 * 把這個物件在對位圖上的外框撐到整張畫布。整個歸同一片，UV 就全部落在那一片的長方形裡。
 */
export function assignVertices(prim: PrimGeom, pieces: readonly Piece[]): { piece: Int16Array; lx: Float64Array; ly: Float64Array; dist: Float64Array; seam: Uint8Array } {
  const nv = Math.floor(prim.pos.length / 3);
  const piece = new Int16Array(nv), lx = new Float64Array(nv), ly = new Float64Array(nv), dist = new Float64Array(nv), seam = new Uint8Array(nv);
  let only = -1;
  if (!prim.screen && pieces.length > 1 && nv > 0) {
    // 歸給面積最大的那一片（平手取編號小的）：只看螢幕片自己的大小，不看這個 primitive 的頂點，
    // 所以原檔、壓縮寫出再讀回來的檔（頂點被量化、重排）選到的永遠是同一片
    let bestArea = -1;
    for (let i = 0; i < pieces.length; i++) {
      const area = pieces[i].widthU * pieces[i].heightU;
      if (area > bestArea * (1 + 1e-9)) { bestArea = area; only = i; }
    }
  }
  for (let v = 0; v < nv; v++) {
    let best = -1, bd = Infinity, bx = 0, by = 0, bs = false;
    for (let i = only >= 0 ? only : 0; i < (only >= 0 ? only + 1 : pieces.length); i++) {
      const r = localOnPiece(pieces[i], prim.pos[v * 3], prim.pos[v * 3 + 1], prim.pos[v * 3 + 2]);
      if (r.dist < bd) { bd = r.dist; best = i; bx = r.lx; by = r.ly; bs = !!r.seam; }
    }
    piece[v] = best;
    seam[v] = bs ? 1 : 0;
    lx[v] = Math.min(1, Math.max(0, bx));
    ly[v] = Math.min(1, Math.max(0, by));
    dist[v] = bd;
  }
  return { piece, lx, ly, dist, seam };
}

