// 自動貼 UV 第 4 階段：自由曲面（不是平面、圓柱、擠出的面）用最小平方保角映射（LSCM）攤平（純函式，只吃一堆數字）
//
// LSCM（Lévy 等人 2002）：把網格攤平成 2D，讓每個三角形盡量只做「旋轉 + 等比例縮放」（保角，形狀不歪），
// 線性方程式的最小平方解；可以攤平的面（圓錐、折起來的平面…）解出來剛好沒有拉伸，真的彎的面（球面一塊、馬鞍）會有拉伸，
// 變形百分比照實算給製作看（surfaces.ts measureDistortion），他可以選「照形狀展開」或「保留原本 UV」。
//
// 做法：
//   1. 檢查網格能不能攤平：邊只被一到兩個三角形共用、繞向一致、剛好一圈邊界（像一張紙），不然 → topology
//   2. 每個三角形算自己的 2D 局部座標（從 3D 邊長），每個三角形一個複數方程式 Σ W_j U_j = 0；邊界上相隔最遠的兩個頂點釘住（消掉旋轉 / 縮放 / 平移）
//   3. 共軛梯度法（有 Jacobi 預處理）解正規方程式，不用額外的套件
//   4. 縮放成跟 3D 面積一樣大；轉到「世界右邊」對到畫面右邊（跟平面、圓柱同一套規則：牆上方朝上，地屏上方朝舞台後方）。
//      LSCM 的解是保持繞向的（不會左右反）：從法線那一側看過去，x 朝右、y 朝上
//
// 座標：(lx, ly) 都是 0~1（攤平後的外框裡的比例）。3D 裡任何一個點（外框、背板的頂點也要有 UV）→ 找最近的三角形 → 用重心座標內插。

import { cross, dot, length, normalize, scale, sub, WORLD_UP, type Vec3 } from './geometry';

export interface FreeInput {
  /** 焊接後的頂點位置，每個頂點 3 個數字 */
  vpos: Float64Array;
  /** 三角形（焊接後的頂點編號，每 3 個一組）；每個三角形的角順序要讓「繞向法線」朝著看得到畫面的那一面（鏡像的節點已經換過順序） */
  tri: Int32Array;
  front: Vec3;
}

export interface FreeMap {
  vpos: Float64Array;
  tri: Int32Array;
  /** 每個頂點攤平後的位置（0~1 的比例，畫面座標：x 朝右、y 朝下） */
  vlx: Float64Array;
  vly: Float64Array;
  grid: TriGrid;
  /** 翻到背面的三角形占的面積比例（> 0 = 攤平後有地方重疊 / 翻過去） */
  flippedRatio: number;
  /** 共軛梯度法跑了幾圈 */
  iterations: number;
}

export type FreeFailReason = 'degenerate' | 'topology' | 'solve';

export interface FreeFitOk {
  ok: true;
  map: FreeMap;
  /** 攤平後的實際大小（文件單位） */
  width: number;
  height: number;
  meanNormal: Vec3;
  /** 3D 面積總和（文件單位平方） */
  area: number;
}
export type FreeFitResult = FreeFitOk | { ok: false; reason: FreeFailReason };

// ───────────────────────── 三角形的空間格子（找最近的三角形）─────────────────────────

export interface TriGrid {
  min: Vec3;
  cell: Vec3;
  res: number;
  cells: Map<number, number[]>;
  count: number;
  /** 查詢時標記「這個三角形這次查過了」用（不用每次新開一個集合） */
  stamp: Int32Array;
  token: number;
}

function buildGrid(vpos: Float64Array, tri: Int32Array): TriGrid {
  const nt = tri.length / 3;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vpos.length; i += 3) for (let k = 0; k < 3; k++) { if (vpos[i + k] < min[k]) min[k] = vpos[i + k]; if (vpos[i + k] > max[k]) max[k] = vpos[i + k]; }
  const res = Math.max(1, Math.min(48, Math.round(Math.cbrt(nt / 2))));
  const ext = [0, 1, 2].map(k => Math.max(max[k] - min[k], 1e-9));
  const cell: Vec3 = [ext[0] / res, ext[1] / res, ext[2] / res];
  const cells = new Map<number, number[]>();
  const at = (v: number, k: number) => Math.min(res - 1, Math.max(0, Math.floor((v - min[k]) / cell[k])));
  for (let t = 0; t < nt; t++) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) {
      const v = vpos[tri[t * 3 + c] * 3 + k];
      if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v;
    }
    for (let x = at(lo[0], 0); x <= at(hi[0], 0); x++) for (let y = at(lo[1], 1); y <= at(hi[1], 1); y++) for (let z = at(lo[2], 2); z <= at(hi[2], 2); z++) {
      const key = (x * res + y) * res + z;
      const list = cells.get(key);
      if (list) list.push(t); else cells.set(key, [t]);
    }
  }
  return { min, cell, res, cells, count: nt, stamp: new Int32Array(nt), token: 0 };
}

/** 點到三角形的最近點（Ericson, Real-Time Collision Detection）：回傳距離平方和重心座標 */
function closestOnTriangle(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, out: Float64Array): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let u: number, v: number, w: number;
  if (d1 <= 0 && d2 <= 0) { u = 1; v = 0; w = 0; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { u = 0; v = 1; w = 0; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); u = 1 - t; v = t; w = 0; }
      else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { u = 0; v = 0; w = 1; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); u = 1 - t; v = 0; w = t; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const t = (d4 - d3) / ((d4 - d3) + (d5 - d6)); u = 0; v = 1 - t; w = t; }
            else { const den = 1 / (va + vb + vc); v = vb * den; w = vc * den; u = 1 - v - w; }
          }
        }
      }
    }
  }
  const qx = ax + abx * v + acx * w, qy = ay + aby * v + acy * w, qz = az + abz * v + acz * w;
  out[0] = u; out[1] = v; out[2] = w;
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

const scratch = new Float64Array(3);
const bestBary = new Float64Array(3);

/** 空間裡的點 → 攤平後的位置 (lx, ly = 0~1) 和離網格面有多遠（選「最近的一片」用） */
export function freeLocal(m: FreeMap, x: number, y: number, z: number): { lx: number; ly: number; dist: number } {
  const g = m.grid;
  const res = g.res;
  const ci = (v: number, k: number) => Math.min(res - 1, Math.max(0, Math.floor((v - g.min[k]) / g.cell[k])));
  const cx = ci(x, 0), cy = ci(y, 1), cz = ci(z, 2);
  const minCell = Math.min(g.cell[0], g.cell[1], g.cell[2]);
  let best = Infinity, bestT = -1;
  const token = ++g.token;
  for (let r = 0; r <= res; r++) {
    for (let ix = Math.max(0, cx - r); ix <= Math.min(res - 1, cx + r); ix++) {
      for (let iy = Math.max(0, cy - r); iy <= Math.min(res - 1, cy + r); iy++) {
        for (let iz = Math.max(0, cz - r); iz <= Math.min(res - 1, cz + r); iz++) {
          // 只看這一圈（比較小的圈已經看過了）
          if (Math.max(Math.abs(ix - cx), Math.abs(iy - cy), Math.abs(iz - cz)) !== r) continue;
          const list = g.cells.get((ix * res + iy) * res + iz);
          if (!list) continue;
          for (const t of list) {
            if (g.stamp[t] === token) continue;
            g.stamp[t] = token;
            const a = m.tri[t * 3] * 3, b = m.tri[t * 3 + 1] * 3, c = m.tri[t * 3 + 2] * 3;
            const d2 = closestOnTriangle(x, y, z, m.vpos[a], m.vpos[a + 1], m.vpos[a + 2], m.vpos[b], m.vpos[b + 1], m.vpos[b + 2], m.vpos[c], m.vpos[c + 1], m.vpos[c + 2], scratch);
            if (d2 < best) { best = d2; bestT = t; bestBary[0] = scratch[0]; bestBary[1] = scratch[1]; bestBary[2] = scratch[2]; }
          }
        }
      }
    }
    // 還沒看的格子至少離 r 格遠（點在中間那格裡面時）；點在格子外面時更遠，所以這個停止條件一定安全
    if (bestT >= 0 && best <= (r * minCell) * (r * minCell)) break;
  }
  if (bestT < 0) return { lx: 0, ly: 0, dist: Infinity };
  const ia = m.tri[bestT * 3], ib = m.tri[bestT * 3 + 1], ic = m.tri[bestT * 3 + 2];
  const lx = m.vlx[ia] * bestBary[0] + m.vlx[ib] * bestBary[1] + m.vlx[ic] * bestBary[2];
  const ly = m.vly[ia] * bestBary[0] + m.vly[ib] * bestBary[1] + m.vly[ic] * bestBary[2];
  return { lx, ly, dist: Math.sqrt(best) };
}

// ───────────────────────── LSCM ─────────────────────────

/** 網格是不是一張像紙的圓盤：回傳邊界頂點（一圈）；不是 = null */
function diskBoundary(nv: number, tri: Int32Array): number[] | null {
  const nt = tri.length / 3;
  const dir = new Map<number, number>();      // 有向邊 u→v 出現幾次
  const und = new Map<number, number>();      // 無向邊出現幾次
  const N = nv;
  for (let t = 0; t < nt; t++) {
    for (let c = 0; c < 3; c++) {
      const u = tri[t * 3 + c], v = tri[t * 3 + (c + 1) % 3];
      if (u === v) return null;
      dir.set(u * N + v, (dir.get(u * N + v) ?? 0) + 1);
      const k = u < v ? u * N + v : v * N + u;
      und.set(k, (und.get(k) ?? 0) + 1);
    }
  }
  const nextOf = new Map<number, number[]>();
  let edges = 0;
  for (const [k, cnt] of und) {
    edges++;
    if (cnt > 2) return null;
    const u = Math.floor(k / N), v = k % N;
    const uv = dir.get(u * N + v) ?? 0, vu = dir.get(v * N + u) ?? 0;
    if (cnt === 2 && (uv !== 1 || vu !== 1)) return null;        // 兩個三角形繞向不一致
    if (cnt === 1) {
      // 邊界邊，沿著繞向走：u→v（有的那個方向）
      const [a, b] = uv === 1 ? [u, v] : [v, u];
      const l = nextOf.get(a); if (l) l.push(b); else nextOf.set(a, [b]);
    }
  }
  if (nv - edges + nt !== 1) return null;                         // 不是圓盤（有洞、封閉…）
  if (nextOf.size === 0) return null;
  for (const l of nextOf.values()) if (l.length !== 1) return null;   // 邊界在某個頂點分岔（蝴蝶結）
  const start = nextOf.keys().next().value as number;
  const loop = [start];
  let cur = nextOf.get(start)![0];
  while (cur !== start) {
    loop.push(cur);
    cur = nextOf.get(cur)![0];
    if (loop.length > nextOf.size) return null;
  }
  return loop.length === nextOf.size ? loop : null;               // 不止一圈邊界
}

interface Lscm { u: Float64Array; v: Float64Array; iterations: number }

function solveLscm(vpos: Float64Array, tri: Int32Array, nv: number, pinA: number, pinB: number): Lscm | null {
  const nt = tri.length / 3;
  const freeIndex = new Int32Array(nv).fill(-1);
  let nf = 0;
  for (let i = 0; i < nv; i++) if (i !== pinA && i !== pinB) freeIndex[i] = nf++;
  if (nf < 1) return null;
  const D = Math.hypot(vpos[pinA * 3] - vpos[pinB * 3], vpos[pinA * 3 + 1] - vpos[pinB * 3 + 1], vpos[pinA * 3 + 2] - vpos[pinB * 3 + 2]);
  // 釘住的位置：A = (0, 0)、B = (D, 0)
  const pinU = new Float64Array(nv), pinV = new Float64Array(nv);
  pinU[pinB] = D;
  const rows = nt * 2;
  const coef = new Float64Array(rows * 6);
  const vari = new Int32Array(rows * 6).fill(-1);
  const rhs = new Float64Array(rows);       // 釘住的頂點貢獻的常數項（A x + rhs）
  for (let t = 0; t < nt; t++) {
    const i0 = tri[t * 3], i1 = tri[t * 3 + 1], i2 = tri[t * 3 + 2];
    const P = [i0, i1, i2].map(i => [vpos[i * 3], vpos[i * 3 + 1], vpos[i * 3 + 2]] as Vec3);
    const e1 = sub(P[1], P[0]), e2 = sub(P[2], P[0]);
    const l1 = length(e1);
    if (!(l1 > 0)) return null;
    const ex = scale(e1, 1 / l1) as Vec3;
    const x2 = l1, y2 = 0;
    const x3 = dot(e2, ex);
    const perp = sub(e2, scale(ex, x3));
    const y3 = length(perp);
    // 局部座標 (0,0)、(x2,0)、(x3,y3)：從 3D 看過去是逆時針（y3 > 0）
    const dT = x2 * y3;
    if (!(dT > 1e-18 * l1 * l1)) continue;     // 扁掉的三角形不給限制
    const k = 1 / Math.sqrt(dT);
    // W1 = (x3-x2) + i(y3-y2)；W2 = (x1-x3) + i(y1-y3)；W3 = (x2-x1) + i(y2-y1)，x1 = y1 = 0
    const wr = [x3 - x2, -x3, x2], wi = [y3 - y2, -y3, y2];
    const ids = [i0, i1, i2];
    for (let r = 0; r < 2; r++) {
      const row = t * 2 + r;
      for (let j = 0; j < 3; j++) {
        // 實部：Wr·u - Wi·v；虛部：Wi·u + Wr·v
        const cu = (r === 0 ? wr[j] : wi[j]) * k;
        const cv = (r === 0 ? -wi[j] : wr[j]) * k;
        const fi = freeIndex[ids[j]];
        if (fi >= 0) {
          coef[row * 6 + j * 2] = cu; vari[row * 6 + j * 2] = fi * 2;
          coef[row * 6 + j * 2 + 1] = cv; vari[row * 6 + j * 2 + 1] = fi * 2 + 1;
        } else {
          rhs[row] += cu * pinU[ids[j]] + cv * pinV[ids[j]];
        }
      }
    }
  }
  const n = nf * 2;
  const mulA = (x: Float64Array, out: Float64Array) => {
    for (let r = 0; r < rows; r++) {
      let s = 0;
      for (let q = 0; q < 6; q++) { const vi = vari[r * 6 + q]; if (vi >= 0) s += coef[r * 6 + q] * x[vi]; }
      out[r] = s;
    }
  };
  const mulAt = (y: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (let r = 0; r < rows; r++) {
      const yr = y[r];
      if (yr === 0) continue;
      for (let q = 0; q < 6; q++) { const vi = vari[r * 6 + q]; if (vi >= 0) out[vi] += coef[r * 6 + q] * yr; }
    }
  };
  // 預處理：AᵀA 的對角線
  const diag = new Float64Array(n);
  for (let r = 0; r < rows; r++) for (let q = 0; q < 6; q++) { const vi = vari[r * 6 + q]; if (vi >= 0) diag[vi] += coef[r * 6 + q] * coef[r * 6 + q]; }
  for (let i = 0; i < n; i++) if (!(diag[i] > 0)) diag[i] = 1;
  // (AᵀA) x = -Aᵀ rhs
  const b = new Float64Array(n);
  mulAt(rhs, b);
  for (let i = 0; i < n; i++) b[i] = -b[i];
  const x = new Float64Array(n);
  // 起始值：A、B 之間的一條線（比全 0 收斂快）
  for (let i = 0; i < nv; i++) {
    const fi = freeIndex[i];
    if (fi < 0) continue;
    x[fi * 2] = D * 0.5; x[fi * 2 + 1] = 0;
  }
  const tmpR = new Float64Array(rows), tmpN = new Float64Array(n);
  const mulM = (p: Float64Array, out: Float64Array) => { mulA(p, tmpR); mulAt(tmpR, out); };
  const res = new Float64Array(n);
  mulM(x, tmpN);
  for (let i = 0; i < n; i++) res[i] = b[i] - tmpN[i];
  const z = new Float64Array(n), p = new Float64Array(n), q = new Float64Array(n);
  for (let i = 0; i < n; i++) { z[i] = res[i] / diag[i]; p[i] = z[i]; }
  let rz = 0, bnorm = 0;
  for (let i = 0; i < n; i++) { rz += res[i] * z[i]; bnorm += b[i] * b[i]; }
  bnorm = Math.sqrt(bnorm) || 1;
  const maxIter = Math.max(2000, 40 * Math.round(Math.sqrt(n)) + 200);
  let it = 0;
  for (; it < maxIter; it++) {
    let rn = 0;
    for (let i = 0; i < n; i++) rn += res[i] * res[i];
    if (Math.sqrt(rn) <= 1e-12 * bnorm) break;
    mulM(p, q);
    let pq = 0;
    for (let i = 0; i < n; i++) pq += p[i] * q[i];
    if (!(pq > 0)) break;
    const alpha = rz / pq;
    for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; res[i] -= alpha * q[i]; }
    let rzNew = 0;
    for (let i = 0; i < n; i++) { z[i] = res[i] / diag[i]; rzNew += res[i] * z[i]; }
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  const u = new Float64Array(nv), v = new Float64Array(nv);
  for (let i = 0; i < nv; i++) {
    const fi = freeIndex[i];
    if (fi >= 0) { u[i] = x[fi * 2]; v[i] = x[fi * 2 + 1]; } else { u[i] = pinU[i]; v[i] = pinV[i]; }
    if (!Number.isFinite(u[i]) || !Number.isFinite(v[i])) return null;
  }
  return { u, v, iterations: it };
}

/** 邊界上相隔最遠的兩個頂點（兩次「找最遠的」，不是嚴格最遠但夠用） */
function farPair(vpos: Float64Array, boundary: readonly number[]): [number, number] {
  const d = (a: number, b: number) => Math.hypot(vpos[a * 3] - vpos[b * 3], vpos[a * 3 + 1] - vpos[b * 3 + 1], vpos[a * 3 + 2] - vpos[b * 3 + 2]);
  const far = (from: number) => { let best = from, bd = -1; for (const v of boundary) { const dd = d(from, v); if (dd > bd) { bd = dd; best = v; } } return best; };
  const b = far(boundary[0]);
  const a = far(b);
  return [a, b];
}

export function fitFreeform(inp: FreeInput): FreeFitResult {
  const { vpos, tri, front } = inp;
  const nv = vpos.length / 3, nt = tri.length / 3;
  if (nt < 1 || nv < 3) return { ok: false, reason: 'degenerate' };
  const boundary = diskBoundary(nv, tri);
  if (!boundary) return { ok: false, reason: 'topology' };
  const [pa, pb] = farPair(vpos, boundary);
  if (pa === pb) return { ok: false, reason: 'degenerate' };
  const sol = solveLscm(vpos, tri, nv, pa, pb);
  if (!sol) return { ok: false, reason: 'solve' };

  // 面積、平均法線
  let A3 = 0, A2 = 0, A2signed = 0;
  const sumN: Vec3 = [0, 0, 0];
  const areas = new Float64Array(nt);
  const normals = new Float64Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const i = tri[t * 3], j = tri[t * 3 + 1], k = tri[t * 3 + 2];
    const e1 = [vpos[j * 3] - vpos[i * 3], vpos[j * 3 + 1] - vpos[i * 3 + 1], vpos[j * 3 + 2] - vpos[i * 3 + 2]] as Vec3;
    const e2 = [vpos[k * 3] - vpos[i * 3], vpos[k * 3 + 1] - vpos[i * 3 + 1], vpos[k * 3 + 2] - vpos[i * 3 + 2]] as Vec3;
    const n = cross(e1, e2);
    const l = length(n);
    areas[t] = l / 2;
    if (l > 0) { normals[t * 3] = n[0] / l; normals[t * 3 + 1] = n[1] / l; normals[t * 3 + 2] = n[2] / l; }
    A3 += areas[t];
    sumN[0] += n[0] / 2; sumN[1] += n[1] / 2; sumN[2] += n[2] / 2;
    const d = ((sol.u[j] - sol.u[i]) * (sol.v[k] - sol.v[i]) - (sol.u[k] - sol.u[i]) * (sol.v[j] - sol.v[i])) / 2;
    A2 += Math.abs(d);
    A2signed += d;
  }
  const meanNormal = normalize(sumN);
  if (!(A3 > 0) || !(A2 > 0) || length(meanNormal) < 0.5) return { ok: false, reason: 'degenerate' };
  // 縮放成跟 3D 面積一樣大；真的是鏡像的解（不該發生）就左右翻回來
  const s = Math.sqrt(A3 / A2);
  const mirror = A2signed < 0 ? -1 : 1;
  const U = new Float64Array(nv), V = new Float64Array(nv);
  for (let i = 0; i < nv; i++) { U[i] = sol.u[i] * s * mirror; V[i] = sol.v[i] * s; }

  // 畫面方向：牆上方 = 世界朝上，地屏 / 天花板上方 = 舞台後方；右邊 = 上 × 法線
  let up: Vec3;
  if (Math.abs(dot(meanNormal, WORLD_UP)) < 0.9) up = normalize(sub(WORLD_UP, scale(meanNormal, dot(WORLD_UP, meanNormal))));
  else { const back = scale(front, -1) as Vec3; up = normalize(sub(back, scale(meanNormal, dot(back, meanNormal)))); }
  if (length(up) < 0.5) return { ok: false, reason: 'degenerate' };
  const right = normalize(cross(up, meanNormal));
  // 「世界右邊」在攤平後的平面上平均指向哪裡（每個三角形：右邊投影到它的面上，用它的 2D 對應轉過去，面積加權）
  let rx = 0, ry = 0;
  for (let t = 0; t < nt; t++) {
    const i = tri[t * 3], j = tri[t * 3 + 1], k = tri[t * 3 + 2];
    const e1 = [vpos[j * 3] - vpos[i * 3], vpos[j * 3 + 1] - vpos[i * 3 + 1], vpos[j * 3 + 2] - vpos[i * 3 + 2]] as Vec3;
    const e2 = [vpos[k * 3] - vpos[i * 3], vpos[k * 3 + 1] - vpos[i * 3 + 1], vpos[k * 3 + 2] - vpos[i * 3 + 2]] as Vec3;
    const nt3: Vec3 = [normals[t * 3], normals[t * 3 + 1], normals[t * 3 + 2]];
    const v = sub(right, scale(nt3, dot(right, nt3)));
    const g11 = dot(e1, e1), g12 = dot(e1, e2), g22 = dot(e2, e2);
    const det = g11 * g22 - g12 * g12;
    if (!(det > 0)) continue;
    const r1 = dot(v, e1), r2 = dot(v, e2);
    const al = (r1 * g22 - r2 * g12) / det, be = (r2 * g11 - r1 * g12) / det;
    const f1u = U[j] - U[i], f1v = V[j] - V[i], f2u = U[k] - U[i], f2v = V[k] - V[i];
    rx += areas[t] * (al * f1u + be * f2u);
    ry += areas[t] * (al * f1v + be * f2v);
  }
  const psi = Math.hypot(rx, ry) > 1e-12 ? -Math.atan2(ry, rx) : 0;
  const cs = Math.cos(psi), sn = Math.sin(psi);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  const U2 = new Float64Array(nv), V2 = new Float64Array(nv);
  for (let i = 0; i < nv; i++) {
    U2[i] = U[i] * cs - V[i] * sn;
    V2[i] = U[i] * sn + V[i] * cs;
    if (U2[i] < minU) minU = U2[i]; if (U2[i] > maxU) maxU = U2[i];
    if (V2[i] < minV) minV = V2[i]; if (V2[i] > maxV) maxV = V2[i];
  }
  const W = maxU - minU, H = maxV - minV;
  if (!(W > 0) || !(H > 0)) return { ok: false, reason: 'degenerate' };
  const vlx = new Float64Array(nv), vly = new Float64Array(nv);
  for (let i = 0; i < nv; i++) { vlx[i] = (U2[i] - minU) / W; vly[i] = (maxV - V2[i]) / H; }
  // 翻到背面的三角形（攤平後逆時針變順時針）
  let flipped = 0;
  for (let t = 0; t < nt; t++) {
    const i = tri[t * 3], j = tri[t * 3 + 1], k = tri[t * 3 + 2];
    const d = (U2[j] - U2[i]) * (V2[k] - V2[i]) - (U2[k] - U2[i]) * (V2[j] - V2[i]);
    if (d < 0) flipped += areas[t];
  }
  const map: FreeMap = { vpos, tri, vlx, vly, grid: buildGrid(vpos, tri), flippedRatio: flipped / A3, iterations: sol.iterations };
  return { ok: true, map, width: W, height: H, meanNormal, area: A3 };
}
