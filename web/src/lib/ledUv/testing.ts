// 自動貼 UV 的測試用幾何（程式產生，每次都一樣）。只有測試用，不會打包進網站。

import type { Vec3 } from './geometry';
import { add, cross, normalize, scale } from './geometry';
import type { PrimGeom } from './surfaces';

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
export function arcPrim(radius: number, sweepDeg: number, height: number, seg = 32, startDeg = -sweepDeg / 2): PrimGeom {
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
