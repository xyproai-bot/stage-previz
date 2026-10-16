// 自動貼 UV 第 2 階段：圓柱 / 弧面（純函式，只吃一堆數字）
//
// 一片弧面螢幕 = 圓柱面的一段。作法：
//   1. 軸：三角形法線（面積加權）的共變異矩陣最小的特徵向量（圓柱面的法線都垂直於軸；不管網格切得多粗都成立）
//   2. 半徑、圓心：把螢幕頂點投影到垂直於軸的平面，Kåsa 圓擬合再用高斯牛頓修成幾何誤差最小
//   3. 弧的角度範圍：頂點的角度排好，找最大的空隙，空隙以外就是弧（只收一段弧，整圈 360 度要拆頂點 → 第 4 階段）
//   4. 凸 / 凹：法線朝外（凸，觀眾在圓柱外面看）或朝內（凹，觀眾在圓柱裡面看）；LED 只畫正面，觀眾站在法線那一側
//   5. 方向：牆（法線跟世界朝上差很多）上方 = 世界朝上；地屏 / 天花板（法線幾乎垂直）上方 = 舞台後方；
//      右邊 = 上 × 法線（站在法線那一側的人看過去的右邊），所以凸、凹、鏡像過的都不會左右反
//   6. 攤平：弧長 = 半徑 × 角度（真正的弧長，不是弦長），所以畫面不會被拉伸
//
// 座標：弧上的位置 (lx, ly) 都是 0~1（弧長比例、沿軸比例），跟平面螢幕片一樣，之後套同一套轉 / 翻 / 擺進長方形。

import { cross, dot, eigenSym3, length, normalize, scale, sub, WORLD_UP, type Vec3 } from './geometry';

const TWO_PI = Math.PI * 2;

export interface ArcMap {
  /** 軸上的一點（沿軸的位置 h 從這裡算） */
  center: Vec3;
  /** 單位軸向，e1 × e2 = axis（角度繞 axis 逆時針增加） */
  axis: Vec3;
  e1: Vec3;
  e2: Vec3;
  radius: number;
  /** 弧的起點角、弧度範圍（0 ~ 2π） */
  thetaStart: number;
  span: number;
  /** 沿軸範圍（從 center 算） */
  hMin: number;
  hMax: number;
  /** 法線朝外 = 凸（觀眾在圓柱外面看）；朝內 = 凹 */
  convex: boolean;
  /** 弧在畫面上是上下方向（圓柱的軸橫躺）= true；一般的弧牆（軸直立）= false */
  arcVertical: boolean;
  /** 弧長方向要不要反過來（讓畫面是「站在法線那一側看」的左右 / 上下） */
  arcRev: boolean;
  /** 沿軸方向要不要反過來 */
  axisRev: boolean;
  /** 螢幕頂點離圓柱面最遠的距離（容差用） */
  maxResidual: number;
}

export type ArcFailReason = 'degenerate' | 'flat' | 'closed' | 'fit';

export interface ArcFitOk {
  ok: true;
  map: ArcMap;
  /** 攤平後的實際大小（文件單位）：寬 = 畫面左右、高 = 畫面上下 */
  width: number;
  height: number;
  /** 弧正中間的法線（單位） */
  midNormal: Vec3;
  /** 螢幕面的平均 normal 朝外的程度：1 = 全部朝外（凸）、-1 = 全部朝內（凹） */
  outwardScore: number;
  /** 頂點到圓柱面的 RMS 距離 / min(半徑, 長邊) */
  rmsRel: number;
  maxRel: number;
}
export type ArcFitResult = ArcFitOk | { ok: false; reason: ArcFailReason };

export interface ArcFitInput {
  /** 螢幕頂點（每個位置一份），3 個數字一個點 */
  points: Float64Array;
  /** 螢幕三角形：單位法線（已經乘過鏡像正負）、面積、重心 */
  triN: Float64Array;
  triArea: Float64Array;
  triC: Float64Array;
  /** 舞台正面（水平、指向觀眾） */
  front: Vec3;
  /** 製作手動選了「弧面」：殘差太大也貼（變形多少由變形百分比告訴他），只擋做不出來的 */
  force?: boolean;
}

export const ARC_RMS_REL = 0.005;
export const ARC_MAX_REL = 0.02;
/** 弧的角度範圍超過這個就當整圈（需要拆頂點） */
export const ARC_CLOSED_RAD = (350 * Math.PI) / 180;
/** 自動模式：半徑超過弧長這麼多倍就當平的 */
const MIN_SPAN_RAD = (0.5 * Math.PI) / 180;

/** 解 3×3 線性方程組（高斯消去、部分選主元）；解不出來 = null */
function solve3(a: number[][], b: number[]): number[] | null {
  const m = a.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-300) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = c + 1; r < 3; r++) {
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let s = m[r][3];
    for (let k = r + 1; k < 3; k++) s -= m[r][k] * x[k];
    x[r] = s / m[r][r];
  }
  return x.every(Number.isFinite) ? x : null;
}

/** 圓擬合：先 Kåsa（代數誤差），再高斯牛頓把幾何誤差最小化。回傳圓心與半徑（座標跟輸入同一個原點） */
export function fitCircle(xs: ArrayLike<number>, ys: ArrayLike<number>): { cx: number; cy: number; r: number } | null {
  const n = xs.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sz = 0, sxz = 0, syz = 0;
  let span = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i] - mx, y = ys[i] - my, z = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y;
    sz += z; sxz += x * z; syz += y * z;
    span = Math.max(span, Math.abs(x), Math.abs(y));
  }
  if (!(span > 0)) return null;
  const k = solve3([[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], [-sxz, -syz, -sz]);
  if (!k) return null;
  let cx = -k[0] / 2, cy = -k[1] / 2;
  const r2 = cx * cx + cy * cy - k[2];
  if (!(r2 > 0)) return null;
  let r = Math.sqrt(r2);
  // 高斯牛頓：殘差 = 到圓心的距離 - r
  for (let it = 0; it < 30; it++) {
    const jtj = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const jtr = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx - cx, dy = ys[i] - my - cy;
      const rho = Math.hypot(dx, dy);
      if (!(rho > 0)) continue;
      const res = rho - r;
      const j0 = -dx / rho, j1 = -dy / rho, j2 = -1;
      jtj[0][0] += j0 * j0; jtj[0][1] += j0 * j1; jtj[0][2] += j0 * j2;
      jtj[1][1] += j1 * j1; jtj[1][2] += j1 * j2; jtj[2][2] += 1;
      jtr[0] += j0 * res; jtr[1] += j1 * res; jtr[2] += j2 * res;
    }
    jtj[1][0] = jtj[0][1]; jtj[2][0] = jtj[0][2]; jtj[2][1] = jtj[1][2];
    const damp = 1e-12 * (jtj[0][0] + jtj[1][1] + jtj[2][2]);
    jtj[0][0] += damp; jtj[1][1] += damp; jtj[2][2] += damp;
    const d = solve3(jtj, [-jtr[0], -jtr[1], -jtr[2]]);
    if (!d) break;
    const nr = r + d[2], ncx = cx + d[0], ncy = cy + d[1];
    if (!(nr > 0) || ![ncx, ncy, nr].every(Number.isFinite)) break;
    cx = ncx; cy = ncy; r = nr;
    if (Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) < 1e-13 * Math.max(span, r)) break;
  }
  return { cx: cx + mx, cy: cy + my, r };
}

/** 垂直於 axis 的一組右手基底 e1 × e2 = axis */
export function basisFor(axis: Vec3): [Vec3, Vec3] {
  const ref: Vec3 = Math.abs(axis[0]) < 0.6 ? [1, 0, 0] : [0, 1, 0];
  const e1 = normalize(sub(ref, scale(axis, dot(ref, axis))));
  const e2 = cross(axis, e1);
  return [e1, normalize(e2)];
}

const mod2pi = (a: number): number => ((a % TWO_PI) + TWO_PI) % TWO_PI;

/** 圓柱的一段弧：擬合 + 方向。做不出來 = 原因 */
export function fitArc(inp: ArcFitInput): ArcFitResult {
  const { points, triN, triArea, triC, front } = inp;
  const np = Math.floor(points.length / 3), nt = triArea.length;
  if (np < 4 || nt < 2) return { ok: false, reason: 'degenerate' };

  // 1. 軸
  const m = [0, 0, 0, 0, 0, 0];
  let totalArea = 0;
  for (let t = 0; t < nt; t++) {
    const a = triArea[t], nx = triN[t * 3], ny = triN[t * 3 + 1], nz = triN[t * 3 + 2];
    m[0] += a * nx * nx; m[1] += a * nx * ny; m[2] += a * nx * nz;
    m[3] += a * ny * ny; m[4] += a * ny * nz; m[5] += a * nz * nz;
    totalArea += a;
  }
  const eig = eigenSym3(m);
  const trace = eig.values[0] + eig.values[1] + eig.values[2];
  if (!(trace > 0) || !(totalArea > 0)) return { ok: false, reason: 'degenerate' };
  // 法線幾乎只有一個方向 = 平的（兩個小特徵值分不開，軸不確定）
  if (eig.values[1] / trace < 1e-7) return { ok: false, reason: 'flat' };
  const axis0 = eig.vectors[0];
  // 軸的正負先照世界朝上；橫躺的軸之後再看
  const axis: Vec3 = axis0[1] < 0 || (axis0[1] === 0 && axis0[0] < 0) ? (scale(axis0, -1) as Vec3) : axis0;
  const [e1, e2] = basisFor(axis);

  // 2. 圓
  const xs = new Float64Array(np), ys = new Float64Array(np), hs = new Float64Array(np);
  for (let i = 0; i < np; i++) {
    const px = points[i * 3], py = points[i * 3 + 1], pz = points[i * 3 + 2];
    xs[i] = px * e1[0] + py * e1[1] + pz * e1[2];
    ys[i] = px * e2[0] + py * e2[1] + pz * e2[2];
    hs[i] = px * axis[0] + py * axis[1] + pz * axis[2];
  }
  const circle = fitCircle(xs, ys);
  if (!circle) return { ok: false, reason: 'fit' };
  const R = circle.r;
  let hMin = Infinity, hMax = -Infinity;
  for (let i = 0; i < np; i++) { if (hs[i] < hMin) hMin = hs[i]; if (hs[i] > hMax) hMax = hs[i]; }
  const height = hMax - hMin;
  if (!(height > 0)) return { ok: false, reason: 'degenerate' };

  // 3. 角度範圍：排好角度找最大空隙
  const th = new Float64Array(np);
  for (let i = 0; i < np; i++) th[i] = mod2pi(Math.atan2(ys[i] - circle.cy, xs[i] - circle.cx));
  const sorted = Array.from(th).sort((a, b) => a - b);
  let gap = sorted[0] + TWO_PI - sorted[np - 1], gapEnd = sorted[0];
  const steps: number[] = [];
  for (let i = 0; i + 1 < np; i++) {
    const g = sorted[i + 1] - sorted[i];
    if (g > 1e-9) steps.push(g);
    if (g > gap) { gap = g; gapEnd = sorted[i + 1]; }
  }
  const span = TWO_PI - gap;
  // 整圈：最大的空隙跟一般相鄰頂點的間隔差不多 = 沒有缺口（圓柱網格接縫那一格），要拆頂點才攤得開
  steps.sort((x, y) => x - y);
  const typicalStep = steps.length ? steps[Math.floor(steps.length / 2)] : 0;
  if (span > ARC_CLOSED_RAD || (typicalStep > 0 && gap <= 1.5 * typicalStep)) return { ok: false, reason: 'closed' };
  if (!(span > MIN_SPAN_RAD)) return { ok: false, reason: 'flat' };
  const thetaStart = gapEnd;
  const arcLen = R * span;
  const longExtent = Math.max(arcLen, height);
  // 半徑比整片螢幕大太多 = 其實是平的（沒辦法算出可靠的半徑）
  if (R > 1e4 * longExtent) return { ok: false, reason: 'flat' };

  // 殘差
  let sumSq = 0, maxRes = 0;
  for (let i = 0; i < np; i++) {
    const res = Math.abs(Math.hypot(xs[i] - circle.cx, ys[i] - circle.cy) - R);
    sumSq += res * res;
    if (res > maxRes) maxRes = res;
  }
  const rms = Math.sqrt(sumSq / np);
  const ref = Math.min(R, longExtent);
  const rmsRel = rms / ref, maxRel = maxRes / ref;
  if (!inp.force && (rmsRel > ARC_RMS_REL || maxRel > ARC_MAX_REL)) return { ok: false, reason: 'fit' };

  // 圓心（3D）：軸上 h = 0 的點
  const center: Vec3 = [
    e1[0] * circle.cx + e2[0] * circle.cy,
    e1[1] * circle.cx + e2[1] * circle.cy,
    e1[2] * circle.cx + e2[2] * circle.cy,
  ];

  // 4. 凸 / 凹：面積加權的 (法線 · 徑向)
  let outward = 0;
  for (let t = 0; t < nt; t++) {
    const dx = triC[t * 3] - center[0], dy = triC[t * 3 + 1] - center[1], dz = triC[t * 3 + 2] - center[2];
    const h = dx * axis[0] + dy * axis[1] + dz * axis[2];
    const rx = dx - h * axis[0], ry = dy - h * axis[1], rz = dz - h * axis[2];
    const rl = Math.hypot(rx, ry, rz);
    if (!(rl > 0)) continue;
    outward += triArea[t] * ((triN[t * 3] * rx + triN[t * 3 + 1] * ry + triN[t * 3 + 2] * rz) / rl);
  }
  const outwardScore = outward / totalArea;
  const convex = outwardScore >= 0;
  const eps = convex ? 1 : -1;

  // 5. 方向：弧正中間的位置
  const thetaMid = thetaStart + span / 2;
  const rMid: Vec3 = [
    Math.cos(thetaMid) * e1[0] + Math.sin(thetaMid) * e2[0],
    Math.cos(thetaMid) * e1[1] + Math.sin(thetaMid) * e2[1],
    Math.cos(thetaMid) * e1[2] + Math.sin(thetaMid) * e2[2],
  ];
  const tMid = normalize(cross(axis, rMid));
  const nMid = scale(rMid, eps) as Vec3;
  let u0: Vec3;
  if (Math.abs(dot(nMid, WORLD_UP)) < 0.9) {
    u0 = normalize(sub(WORLD_UP, scale(nMid, dot(WORLD_UP, nMid))));
  } else {
    const back = scale(front, -1) as Vec3;
    u0 = normalize(sub(back, scale(nMid, dot(back, nMid))));
  }
  if (length(u0) < 0.5) return { ok: false, reason: 'degenerate' };
  const uAxis = dot(u0, axis), uTan = dot(u0, tMid);
  const arcVertical = Math.abs(uTan) > Math.abs(uAxis);

  let arcRev: boolean, axisRev: boolean;
  if (!arcVertical) {
    // 軸是畫面的上下：上 = 軸的 sgn 方向；右 = 上 × 法線 = sgn·ε·t̂（t̂ = 角度增加的方向）
    const sgn = uAxis >= 0 ? 1 : -1;
    arcRev = sgn * eps < 0;
    axisRev = sgn > 0;  // 畫面的 y 朝下：上 = +軸 → 下 = 小的 h 在上
  } else {
    // 弧是畫面的上下：上 = τ·t̂；右 = 上 × 法線 = -τ·ε·軸
    const tau = uTan >= 0 ? 1 : -1;
    arcRev = tau > 0;   // 畫面朝下 = 角度減少的方向
    axisRev = -tau * eps < 0;
  }
  // axisRev 的意思：true = 比例是 (hMax - h)/高；false = (h - hMin)/高
  // 軸是畫面上下時：ly 朝下。上 = +軸（sgn > 0）→ h 越大越上面 → ly = (hMax - h)/高 → axisRev = true ✓
  // 軸是畫面左右時：lx 朝右 = 軸的 (-τ·ε) 方向，正 = h 越大越右邊 → lx = (h - hMin)/高 → axisRev = false ✓

  const map: ArcMap = {
    center, axis, e1, e2, radius: R, thetaStart, span, hMin, hMax, convex, arcVertical, arcRev, axisRev, maxResidual: maxRes,
  };
  return {
    ok: true,
    map,
    width: arcVertical ? height : arcLen,
    height: arcVertical ? arcLen : height,
    midNormal: nMid,
    outwardScore,
    rmsRel, maxRel,
  };
}

/**
 * 空間裡的點 → 弧上的位置 (lx, ly = 0~1，可能超出)。
 * 落在弧的缺口（弧以外的角度）的點夾到最近的一端；dist = 離圓柱面這一段有多遠（選「最近的一片」用）
 */
export function arcLocal(m: ArcMap, x: number, y: number, z: number): { lx: number; ly: number; dist: number } {
  const dx = x - m.center[0], dy = y - m.center[1], dz = z - m.center[2];
  const a = dx * m.e1[0] + dy * m.e1[1] + dz * m.e1[2];
  const b = dx * m.e2[0] + dy * m.e2[1] + dz * m.e2[2];
  const h = dx * m.axis[0] + dy * m.axis[1] + dz * m.axis[2];
  const rho = Math.hypot(a, b);
  let t = mod2pi(Math.atan2(b, a) - m.thetaStart);
  let over = 0;
  if (t > m.span) {
    const toEnd = t - m.span, toStart = TWO_PI - t;
    if (toEnd < toStart) { over = toEnd; t = m.span; } else { over = toStart; t = 0; }
  }
  const frac = t / m.span;
  const dh = m.hMax - m.hMin;
  const axisFrac = m.axisRev ? (m.hMax - h) / dh : (h - m.hMin) / dh;
  const arcFrac = m.arcRev ? 1 - frac : frac;
  const overH = Math.max(m.hMin - h, 0, h - m.hMax);
  const dist = Math.hypot(rho - m.radius, over * m.radius, overH);
  return m.arcVertical ? { lx: axisFrac, ly: arcFrac, dist } : { lx: arcFrac, ly: axisFrac, dist };
}

/** 圓柱面上的點（弧長比例 0~1、沿軸比例 0~1 → 世界座標）：給測試和 3D 預覽的檢查用 */
export function arcPoint(m: ArcMap, lx: number, ly: number): Vec3 {
  const arcFrac = m.arcVertical ? ly : lx, axisFrac = m.arcVertical ? lx : ly;
  const f = m.arcRev ? 1 - arcFrac : arcFrac;
  const theta = m.thetaStart + f * m.span;
  const h = m.axisRev ? m.hMax - axisFrac * (m.hMax - m.hMin) : m.hMin + axisFrac * (m.hMax - m.hMin);
  const c = Math.cos(theta) * m.radius, s = Math.sin(theta) * m.radius;
  return [
    m.center[0] + m.e1[0] * c + m.e2[0] * s + m.axis[0] * h,
    m.center[1] + m.e1[1] * c + m.e2[1] * s + m.axis[1] * h,
    m.center[2] + m.e1[2] * c + m.e2[2] * s + m.axis[2] * h,
  ];
}
