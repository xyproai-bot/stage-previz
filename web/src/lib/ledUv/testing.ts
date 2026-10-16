// 自動貼 UV 的測試用幾何（程式產生，每次都一樣）。只有測試用，不會打包進網站。

import type { Vec3 } from './geometry';
import { add, cross, normalize, scale } from './geometry';
import type { PrimGeom } from './surfaces';
import { arrangementFromPack, type ArrangeItem, type ArrangeNative, type Arrangement } from './arrange';
import type { PackResult } from './pack';

/**
 * 手排用的排法（測試用）：spec 裡指定的幾塊放在指定的位置 + 轉動；其餘的一塊一塊排在 shelfY 以下（不重疊），畫布自己填。
 * natives = plan.items，pack = plan.pack（自動排的結果，給少了的塊用）。
 */
export function shelfArrangement(
  natives: readonly ArrangeNative[], pack: Pick<PackResult, 'placed' | 'canvas'>,
  spec: Record<string, Partial<ArrangeItem>>, canvas: { width: number; height: number }, shelfY = 1200,
): Arrangement {
  const base = arrangementFromPack(natives, pack);
  let x = 0, y = shelfY, rowH = 0;
  const items: ArrangeItem[] = natives.map((n) => {
    const s = spec[n.key];
    if (s) return { key: n.key, x: 0, y: 0, rotate: 0, flipH: false, flipV: false, ...s };
    if (x + n.w > canvas.width - 100) { x = 0; y += rowH; rowH = 0; }
    const it: ArrangeItem = { key: n.key, x, y, rotate: 0, flipH: false, flipV: false };
    x += n.w;
    rowH = Math.max(rowH, n.h);
    return it;
  });
  return { ...base, canvasMode: 'custom', canvas: { ...canvas }, items, groups: [] };
}

/** 在 (origin, 沿 ax 走 w, 沿 ay 走 h) 的平面上鋪格子；三角形繞向讓法線 = ax × ay 的方向 */
export function gridPrim(origin: Vec3, ax: Vec3, ay: Vec3, w: number, h: number, seg = 4, opts: { screen?: boolean; sign?: 1 | -1; oldUv?: (s: number, t: number) => [number, number] } = {}): PrimGeom {
  const ux = normalize(ax), uy = normalize(ay);
  const pos: number[] = [], uv: number[] = [], index: number[] = [];
  for (let j = 0; j <= seg; j++) {
    for (let i = 0; i <= seg; i++) {
      const s = i / seg, t = j / seg;
      const p = add(add(origin, scale(ux, s * w)), scale(uy, t * h));
      pos.push(p[0], p[1], p[2]);
      const o = opts.oldUv ? opts.oldUv(s, t) : [s, 1 - t] as [number, number];
      uv.push(o[0], o[1]);
    }
  }
  const row = seg + 1;
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
      index.push(a, b, d, a, d, c);
    }
  }
  return { pos: Float64Array.from(pos), index: Uint32Array.from(index), screen: opts.screen ?? true, sign: opts.sign ?? 1, uv: Float64Array.from(uv) };
}

/** 一個有厚度的板子（前後兩個大面 + 四個側邊），前面朝 normal */
export function slabPrim(center: Vec3, ax: Vec3, ay: Vec3, w: number, h: number, thick: number): PrimGeom {
  const n = normalize(cross(ax, ay));
  const front = gridPrim(add(add(center, scale(normalize(ax), -w / 2)), add(scale(normalize(ay), -h / 2), scale(n, thick / 2))), ax, ay, w, h, 2);
  // 背面：同樣的格子，繞向反過來（法線朝 -n）
  const back = gridPrim(add(add(center, scale(normalize(ay), -h / 2)), add(scale(normalize(ax), w / 2), scale(n, -thick / 2))), scale(ax, -1), ay, w, h, 2);
  // 四個側邊（細長的格子）
  const sides = [
    gridPrim(add(add(center, scale(normalize(ax), -w / 2)), add(scale(normalize(ay), -h / 2), scale(n, -thick / 2))), ax, n, w, thick, 2),
    gridPrim(add(add(center, scale(normalize(ax), -w / 2)), add(scale(normalize(ay), h / 2), scale(n, thick / 2))), ax, scale(n, -1), w, thick, 2),
    gridPrim(add(add(center, scale(normalize(ax), -w / 2)), add(scale(normalize(ay), -h / 2), scale(n, thick / 2))), ay, scale(n, -1), h, thick, 2),
    gridPrim(add(add(center, scale(normalize(ax), w / 2)), add(scale(normalize(ay), -h / 2), scale(n, -thick / 2))), ay, n, h, thick, 2),
  ];
  return mergePrims([front, back, ...sides]);
}

/** 把幾個 primitive 合成一個（頂點不共用） */
export function mergePrims(prims: PrimGeom[]): PrimGeom {
  const pos: number[] = [], uv: number[] = [], index: number[] = [];
  for (const p of prims) {
    const base = pos.length / 3;
    pos.push(...p.pos);
    if (p.uv) uv.push(...Array.from(p.uv));
    for (const i of p.index) index.push(i + base);
  }
  return { pos: Float64Array.from(pos), index: Uint32Array.from(index), screen: prims[0].screen, sign: prims[0].sign, uv: Float64Array.from(uv) };
}

/** 圓柱的一段弧（內側朝圓心，法線朝外），給「弧面不支援」的測試 */
export function arcPrim(radius: number, sweepDeg: number, height: number, seg = 32, startDeg = -sweepDeg / 2, concave = false): PrimGeom {
  const pos: number[] = [], uv: number[] = [], index: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = ((startDeg + (i / seg) * sweepDeg) * Math.PI) / 180;
    for (const y of [0, height]) {
      pos.push(Math.sin(a) * radius, y, Math.cos(a) * radius);
      uv.push(i / seg, y > 0 ? 0 : 1);
    }
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    // 繞向決定法線朝外（凸）還是朝內（凹，觀眾在圓柱裡面看）
    if (concave) index.push(a, b, c, b, d, c);
    else index.push(a, c, b, b, c, d);
  }
  return { pos: Float64Array.from(pos), index: Uint32Array.from(index), screen: true, sign: 1, uv: Float64Array.from(uv) };
}

/** 圓錐的一段（半徑從下到上慢慢變小）：不是圓柱，給「辨識不出圓柱」的測試 */
export function conePrim(rBottom: number, rTop: number, sweepDeg: number, height: number, seg = 32): PrimGeom {
  const pos: number[] = [], uv: number[] = [], index: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = ((-sweepDeg / 2 + (i / seg) * sweepDeg) * Math.PI) / 180;
    pos.push(Math.sin(a) * rBottom, 0, Math.cos(a) * rBottom, Math.sin(a) * rTop, height, Math.cos(a) * rTop);
    uv.push(i / seg, 1, i / seg, 0);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    index.push(a, c, b, b, c, d);
  }
  return { pos: Float64Array.from(pos), index: Uint32Array.from(index), screen: true, sign: 1, uv: Float64Array.from(uv) };
}

/** 波浪形的長條（z 隨 x 起伏的正弦）：不是平面也不是圓柱 */
export function wavePrim(width: number, height: number, amplitude: number, waves: number, seg = 48): PrimGeom {
  const pos: number[] = [], uv: number[] = [], index: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const x = (i / seg - 0.5) * width;
    const z = amplitude * Math.sin((i / seg) * waves * Math.PI * 2);
    pos.push(x, 0, z, x, height, z);
    uv.push(i / seg, 1, i / seg, 0);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    index.push(a, c, b, b, c, d);
  }
  return { pos: Float64Array.from(pos), index: Uint32Array.from(index), screen: true, sign: 1, uv: Float64Array.from(uv) };
}

/** 對 primitive 的所有頂點做旋轉（繞 axis 轉 deg 度）再平移 */
export function moved(p: PrimGeom, rotAxis: Vec3, deg: number, shift: Vec3): PrimGeom {
  const k = normalize(rotAxis);
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  const pos = new Float64Array(p.pos.length);
  for (let i = 0; i < p.pos.length; i += 3) {
    const v: Vec3 = [p.pos[i], p.pos[i + 1], p.pos[i + 2]];
    const kv = cross(k, v);
    const kd = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
    pos[i] = v[0] * c + kv[0] * s + k[0] * kd * (1 - c) + shift[0];
    pos[i + 1] = v[1] * c + kv[1] * s + k[1] * kd * (1 - c) + shift[1];
    pos[i + 2] = v[2] * c + kv[2] * s + k[2] * kd * (1 - c) + shift[2];
  }
  return { ...p, pos };
}

/** 鏡像（x 取負），繞向反過來所以 sign = -1 */
export function mirroredX(p: PrimGeom): PrimGeom {
  const pos = Float64Array.from(p.pos);
  for (let i = 0; i < pos.length; i += 3) pos[i] = -pos[i];
  return { ...p, pos, sign: -1 };
}

/**
 * 跟 GPU 一樣的方式獨立檢查「會不會左右 / 上下反」（不靠 arcPoint 之類的對應函數）：
 * 每個三角形，站在看得到的那一面（繞向法線乘鏡像的正負）、頭朝世界朝上看過去，
 * u 要往畫面右邊增加、v 要往下增加（世界 y 變小）。回傳檢查了幾個三角形、有幾個不對（躺在地上看不出「右邊」的略過）。
 * prim.uv 是 0~1 的 UV，W、H 是畫布大小（把 UV 換成像素）。
 */
export function uvReadingCheck(prim: PrimGeom, W: number, H: number): { checked: number; bad: number } {
  let checked = 0, bad = 0;
  if (!prim.uv) return { checked, bad };
  for (let t = 0; t + 2 < prim.index.length; t += 3) {
    const [i, j, k] = [prim.index[t], prim.index[t + 1], prim.index[t + 2]];
    const P = (v: number): Vec3 => [prim.pos[v * 3], prim.pos[v * 3 + 1], prim.pos[v * 3 + 2]];
    const e1 = [0, 1, 2].map(q => P(j)[q] - P(i)[q]) as Vec3, e2 = [0, 1, 2].map(q => P(k)[q] - P(i)[q]) as Vec3;
    const n = normalize(cross(e1, e2).map(x => x * prim.sign) as Vec3);
    const du1 = (prim.uv[j * 2] - prim.uv[i * 2]) * W, du2 = (prim.uv[k * 2] - prim.uv[i * 2]) * W;
    const dv1 = (prim.uv[j * 2 + 1] - prim.uv[i * 2 + 1]) * H, dv2 = (prim.uv[k * 2 + 1] - prim.uv[i * 2 + 1]) * H;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    const dPdu = [0, 1, 2].map(q => (e1[q] * dv2 - e2[q] * dv1) / det) as Vec3;
    const dPdv = [0, 1, 2].map(q => (e2[q] * du1 - e1[q] * du2) / det) as Vec3;
    const right = cross([-n[0], -n[1], -n[2]], [0, 1, 0]);
    if (Math.hypot(right[0], right[1], right[2]) < 1e-6) continue;
    checked++;
    if (!(right[0] * dPdu[0] + right[1] * dPdu[1] + right[2] * dPdu[2] > 0) || !(dPdv[1] < 1e-9)) bad++;
  }
  return { checked, bad };
}
