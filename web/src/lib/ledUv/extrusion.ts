// 自動貼 UV 第 4 階段：沿直線擠出的曲面（純函式，只吃一堆數字）
//
// 「擠出曲面」= 一條側面形狀（波浪、折角、不規則的弧…）沿著一條直線掃出來的面，就是廣義的圓柱（圓柱 = 側面形狀是圓弧）。
// LED 最常見的曲面就是這種（波浪螢幕、折角螢幕）。它可以不拉伸地攤平：把側面形狀沿著它的弧長拉直，另一個方向是擠出的距離。
//   1. 擠出方向：三角形法線（面積加權）的共變異矩陣最小的特徵向量（擠出的面，所有法線都垂直於擠出方向）
//   2. 側面形狀：把所有頂點投影到垂直於擠出方向的平面，焊起來（同一個位置只算一個點），
//      三角形的邊連起來就是一條折線（一個點最多接兩條邊；斜著劃過格子的對角線會被濾掉）
//   3. 攤平：x（或 y）= 沿折線的累積長度（弧長，不是弦長）；另一個方向 = 沿擠出方向的位置。網格本身就是擠出出來的，所以每個三角形的大小都不變
//   4. 方向（跟平面、圓柱同一套規則）：牆 → 畫面上方 = 世界朝上；地屏 / 天花板 → 畫面上方 = 舞台後方；
//      右邊 = 上 × 法線（站在法線那一側看過去的右邊），所以不會左右反
//
// 座標：(lx, ly) 都是 0~1，跟平面、弧面一樣，之後套同一套轉 / 翻 / 擺進長方形。

import { cross, dot, eigenSym3, length, normalize, scale, sub, WORLD_UP, type Vec3 } from './geometry';
import { basisFor } from './cylinder';

export interface ExtMap {
  /** 擠出方向（單位向量） */
  axis: Vec3;
  /** 垂直於擠出方向的一組基底（e1 × e2 = axis）：側面形狀的 2D 座標 = (p·e1, p·e2) */
  e1: Vec3;
  e2: Vec3;
  /** 側面形狀的折線：n 個點的 2D 座標，和從起點算起的累積長度（cum[n-1] = 全長） */
  pa: Float64Array;
  pb: Float64Array;
  cum: Float64Array;
  /** 沿擠出方向的範圍（p·axis） */
  hMin: number;
  hMax: number;
  /** 側面形狀在畫面上是上下方向（擠出方向橫著）= true；一般的牆（直著擠出）= false */
  profileVertical: boolean;
  /** 沿折線的方向要不要反過來 */
  sRev: boolean;
  /** 沿擠出方向的方向要不要反過來 */
  hRev: boolean;
  /** 螢幕頂點離折線最遠的距離（容差用，焊接誤差等級） */
  maxResidual: number;
}

export type ExtFailReason = 'degenerate' | 'flat' | 'notExtrusion' | 'profile' | 'closedProfile';

export interface ExtFitOk {
  ok: true;
  map: ExtMap;
  /** 攤平後的實際大小（文件單位）：寬 = 畫面左右、高 = 畫面上下 */
  width: number;
  height: number;
  /** 面積加權的平均法線（單位） */
  meanNormal: Vec3;
  /** 側面形狀有幾個點 */
  profilePoints: number;
}
export type ExtFitResult = ExtFitOk | { ok: false; reason: ExtFailReason };

export interface ExtFitInput {
  /** 螢幕三角形：每個 9 個數字（三個角的世界座標） */
  tri: Float64Array;
  /** 單位法線（已經乘過鏡像的正負）、面積 */
  triN: Float64Array;
  triArea: Float64Array;
  front: Vec3;
}

/** 法線的共變異矩陣最小特徵值占的比例：超過就不是擠出的面（1e-4 ≈ 法線平均偏離垂直 0.6°；DCC 匯出的擠出面是 1e-12 等級） */
export const EXT_AXIS_REL = 1e-4;
/** 焊接側面形狀的點：外框對角線的這個比例以內算同一個點 */
const WELD_REL = 2e-5;

/** 2D 點焊接：容差內算同一個點。回傳每個輸入點的編號、和每個點的座標 */
function weld2d(a: Float64Array, b: Float64Array, tol: number): { id: Int32Array; px: number[]; py: number[] } {
  const n = a.length;
  const id = new Int32Array(n);
  const px: number[] = [], py: number[] = [];
  const cells = new Map<string, number[]>();
  const key = (i: number, j: number) => `${i},${j}`;
  for (let k = 0; k < n; k++) {
    const ci = Math.floor(a[k] / tol), cj = Math.floor(b[k] / tol);
    let found = -1;
    for (let di = -1; di <= 1 && found < 0; di++) {
      for (let dj = -1; dj <= 1 && found < 0; dj++) {
        const list = cells.get(key(ci + di, cj + dj));
        if (!list) continue;
        for (const q of list) {
          if (Math.abs(px[q] - a[k]) <= tol && Math.abs(py[q] - b[k]) <= tol) { found = q; break; }
        }
      }
    }
    if (found < 0) {
      found = px.length;
      px.push(a[k]); py.push(b[k]);
      const kk = key(ci, cj);
      const list = cells.get(kk);
      if (list) list.push(found); else cells.set(kk, [found]);
    }
    id[k] = found;
  }
  return { id, px, py };
}

/** 把一堆邊（節點編號對）整理成一條折線的節點順序；不是一條不分岔的線 = reason */
function walkProfile(nodes: number, px: readonly number[], py: readonly number[], edges: Map<number, Set<number>>): { order: number[] } | { reason: 'profile' | 'closedProfile' } {
  const len = (u: number, v: number) => Math.hypot(px[u] - px[v], py[u] - py[v]);
  // 一個點接超過兩條邊：斜著跨過去的對角線（跳過中間的點），比較長的那幾條不要；兩端都同意才留
  const drop = new Set<string>();
  const ek = (u: number, v: number) => (u < v ? `${u}-${v}` : `${v}-${u}`);
  for (const [u, nb] of edges) {
    if (nb.size <= 2) continue;
    const sorted = [...nb].sort((x, y) => len(u, x) - len(u, y));
    for (let k = 2; k < sorted.length; k++) drop.add(ek(u, sorted[k]));
  }
  const adj: number[][] = Array.from({ length: nodes }, () => []);
  for (const [u, nb] of edges) for (const v of nb) if (u < v && !drop.has(ek(u, v))) { adj[u].push(v); adj[v].push(u); }
  let ends = 0, start = -1;
  for (let u = 0; u < nodes; u++) {
    const d = adj[u].length;
    if (d === 0 || d > 2) return { reason: 'profile' };
    if (d === 1) { ends++; if (start < 0) start = u; }
  }
  if (ends === 0) return { reason: 'closedProfile' };
  if (ends !== 2) return { reason: 'profile' };
  const order: number[] = [start];
  let prev = -1, cur = start;
  while (true) {
    const next = adj[cur].find(v => v !== prev);
    if (next === undefined) break;
    order.push(next);
    prev = cur; cur = next;
    if (order.length > nodes) return { reason: 'profile' };
  }
  if (order.length !== nodes) return { reason: 'profile' };
  return { order };
}

/** 沿擠出方向擠出的曲面：擬合 + 方向。做不出來 = 原因 */
export function fitExtrusion(inp: ExtFitInput): ExtFitResult {
  const { tri, triN, triArea, front } = inp;
  const nt = triArea.length;
  if (nt < 2) return { ok: false, reason: 'degenerate' };

  // 1. 擠出方向
  const m = [0, 0, 0, 0, 0, 0];
  let totalArea = 0;
  const sumN: Vec3 = [0, 0, 0];
  for (let t = 0; t < nt; t++) {
    const a = triArea[t], nx = triN[t * 3], ny = triN[t * 3 + 1], nz = triN[t * 3 + 2];
    m[0] += a * nx * nx; m[1] += a * nx * ny; m[2] += a * nx * nz;
    m[3] += a * ny * ny; m[4] += a * ny * nz; m[5] += a * nz * nz;
    sumN[0] += a * nx; sumN[1] += a * ny; sumN[2] += a * nz;
    totalArea += a;
  }
  const eig = eigenSym3(m);
  const trace = eig.values[0] + eig.values[1] + eig.values[2];
  if (!(trace > 0) || !(totalArea > 0)) return { ok: false, reason: 'degenerate' };
  if (eig.values[1] / trace < 1e-7) return { ok: false, reason: 'flat' };
  if (eig.values[0] / trace > EXT_AXIS_REL) return { ok: false, reason: 'notExtrusion' };
  const axis0 = eig.vectors[0];
  const axis: Vec3 = axis0[1] < 0 || (axis0[1] === 0 && axis0[0] < 0) ? (scale(axis0, -1) as Vec3) : axis0;
  const [e1, e2] = basisFor(axis);
  const meanNormal = normalize(sumN);

  // 2. 投影、焊接
  const np = nt * 3;
  const A = new Float64Array(np), B = new Float64Array(np), H = new Float64Array(np);
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity, hMin = Infinity, hMax = -Infinity;
  for (let i = 0; i < np; i++) {
    const x = tri[i * 3], y = tri[i * 3 + 1], z = tri[i * 3 + 2];
    A[i] = x * e1[0] + y * e1[1] + z * e1[2];
    B[i] = x * e2[0] + y * e2[1] + z * e2[2];
    H[i] = x * axis[0] + y * axis[1] + z * axis[2];
    if (A[i] < minA) minA = A[i]; if (A[i] > maxA) maxA = A[i];
    if (B[i] < minB) minB = B[i]; if (B[i] > maxB) maxB = B[i];
    if (H[i] < hMin) hMin = H[i]; if (H[i] > hMax) hMax = H[i];
  }
  const height = hMax - hMin;
  const diag2 = Math.hypot(maxA - minA, maxB - minB);
  if (!(height > 0) || !(diag2 > 0)) return { ok: false, reason: 'degenerate' };
  const tol = Math.max(diag2, height) * WELD_REL;
  const w = weld2d(A, B, tol);
  const nodes = w.px.length;
  if (nodes < 2) return { ok: false, reason: 'degenerate' };

  // 3. 三角形的邊 → 折線
  const edges = new Map<number, Set<number>>();
  const link = (u: number, v: number) => {
    if (u === v) return;
    let s = edges.get(u); if (!s) { s = new Set(); edges.set(u, s); } s.add(v);
    let r = edges.get(v); if (!r) { r = new Set(); edges.set(v, r); } r.add(u);
  };
  for (let t = 0; t < nt; t++) {
    const a = w.id[t * 3], b = w.id[t * 3 + 1], c = w.id[t * 3 + 2];
    link(a, b); link(b, c); link(c, a);
  }
  const walked = walkProfile(nodes, w.px, w.py, edges);
  if ('reason' in walked) return { ok: false, reason: walked.reason };
  const n = nodes;
  const pa = new Float64Array(n), pb = new Float64Array(n), cum = new Float64Array(n);
  walked.order.forEach((u, i) => {
    pa[i] = w.px[u]; pb[i] = w.py[u];
    if (i > 0) cum[i] = cum[i - 1] + Math.hypot(pa[i] - pa[i - 1], pb[i] - pb[i - 1]);
  });
  const S = cum[n - 1];
  if (!(S > 0)) return { ok: false, reason: 'degenerate' };

  // 4. 方向
  let u0: Vec3;
  if (Math.abs(dot(meanNormal, WORLD_UP)) < 0.9) {
    u0 = normalize(sub(WORLD_UP, scale(meanNormal, dot(WORLD_UP, meanNormal))));
  } else {
    const back = scale(front, -1) as Vec3;
    u0 = normalize(sub(back, scale(meanNormal, dot(back, meanNormal))));
  }
  if (length(u0) < 0.5) return { ok: false, reason: 'degenerate' };
  const right = normalize(cross(u0, meanNormal));
  // 側面形狀的主要方向（兩端連線的方向，正負照從起點走到終點）
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += pa[i]; my += pb[i]; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = pa[i] - mx, dy = pb[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ta = Math.cos(theta), tb = Math.sin(theta);
  if (ta * (pa[n - 1] - pa[0]) + tb * (pb[n - 1] - pb[0]) < 0) { ta = -ta; tb = -tb; }
  const tangent: Vec3 = [ta * e1[0] + tb * e2[0], ta * e1[1] + tb * e2[1], ta * e1[2] + tb * e2[2]];
  const uAxis = dot(u0, axis), uTan = dot(u0, tangent);
  const profileVertical = Math.abs(uTan) > Math.abs(uAxis);
  let sRev: boolean, hRev: boolean;
  if (!profileVertical) {
    // 擠出方向是畫面的上下；側面形狀是左右：x 隨弧長增加的方向要是畫面右邊
    sRev = dot(tangent, right) < 0;
    hRev = uAxis > 0;      // 上 = +擠出方向 → h 越大越上面 → ly = (hMax - h) / 高
  } else {
    // 側面形狀是畫面的上下（y 朝下）；擠出方向是左右
    sRev = uTan > 0;       // 弧長增加的方向朝上 → 反過來
    hRev = dot(axis, right) < 0;
  }
  const map: ExtMap = { axis, e1, e2, pa, pb, cum, hMin, hMax, profileVertical, sRev, hRev, maxResidual: tol };
  return {
    ok: true,
    map,
    width: profileVertical ? height : S,
    height: profileVertical ? S : height,
    meanNormal,
    profilePoints: n,
  };
}

/** 空間裡的點 → 擠出面上的位置 (lx, ly = 0~1，可能超出)；dist = 離這個面有多遠（選「最近的一片」用） */
export function extLocal(m: ExtMap, x: number, y: number, z: number): { lx: number; ly: number; dist: number } {
  const a = x * m.e1[0] + y * m.e1[1] + z * m.e1[2];
  const b = x * m.e2[0] + y * m.e2[1] + z * m.e2[2];
  const h = x * m.axis[0] + y * m.axis[1] + z * m.axis[2];
  const n = m.pa.length;
  let best = Infinity, bestS = 0;
  for (let i = 0; i + 1 < n; i++) {
    const x0 = m.pa[i], y0 = m.pb[i];
    const dx = m.pa[i + 1] - x0, dy = m.pb[i + 1] - y0;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((a - x0) * dx + (b - y0) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x0 + t * dx - a, ey = y0 + t * dy - b;
    const d2 = ex * ex + ey * ey;
    if (d2 < best) { best = d2; bestS = m.cum[i] + t * (m.cum[i + 1] - m.cum[i]); }
  }
  const S = m.cum[n - 1];
  const sFrac = bestS / S;
  const dh = m.hMax - m.hMin;
  const hFrac = m.hRev ? (m.hMax - h) / dh : (h - m.hMin) / dh;
  const sPic = m.sRev ? 1 - sFrac : sFrac;
  const overH = Math.max(m.hMin - h, 0, h - m.hMax);
  const dist = Math.hypot(Math.sqrt(best), overH);
  return m.profileVertical ? { lx: hFrac, ly: sPic, dist } : { lx: sPic, ly: hFrac, dist };
}

/** 擠出面上的點（沿折線的比例、沿擠出方向的比例 → 世界座標）：給測試和 3D 預覽的檢查用 */
export function extPoint(m: ExtMap, lx: number, ly: number): Vec3 {
  const sPic = m.profileVertical ? ly : lx, hPic = m.profileVertical ? lx : ly;
  const sFrac = m.sRev ? 1 - sPic : sPic;
  const n = m.pa.length;
  const target = sFrac * m.cum[n - 1];
  let i = 0;
  while (i + 2 < n && m.cum[i + 1] < target) i++;
  const seg = m.cum[i + 1] - m.cum[i];
  const t = seg > 0 ? Math.min(1, Math.max(0, (target - m.cum[i]) / seg)) : 0;
  const a = m.pa[i] + t * (m.pa[i + 1] - m.pa[i]);
  const b = m.pb[i] + t * (m.pb[i + 1] - m.pb[i]);
  const h = m.hRev ? m.hMax - hPic * (m.hMax - m.hMin) : m.hMin + hPic * (m.hMax - m.hMin);
  return [
    m.e1[0] * a + m.e2[0] * b + m.axis[0] * h,
    m.e1[1] * a + m.e2[1] * b + m.axis[1] * h,
    m.e1[2] * a + m.e2[2] * b + m.axis[2] * h,
  ];
}
