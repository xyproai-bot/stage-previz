// 自動貼 UV 第 4 階段的測試用形狀（程式產生，每次都一樣）。只有測試用，不會打包進網站。

import { add, normalize, scale, type Vec3 } from './geometry';
import type { PrimGeom } from './surfaces';

/** 整顆球（封閉、沒有邊界）：不是平面、圓柱、擠出的面，也攤不平（沒有邊界可以剪開）→「不能攤平」的例子 */
export function spherePrim(radius: number, seg = 16): PrimGeom {
  const pos: number[] = [], uv: number[] = [], index: number[] = [];
  for (let j = 0; j <= seg; j++) {
    const phi = (j / seg) * Math.PI;
    for (let i = 0; i <= seg * 2; i++) {
      const th = (i / (seg * 2)) * Math.PI * 2;
      pos.push(radius * Math.sin(phi) * Math.cos(th), radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(th));
      uv.push(i / (seg * 2), j / seg);
    }
  }
  const row = seg * 2 + 1;
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg * 2; i++) {
      const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  return { pos: Float64Array.from(pos), index: Uint32Array.from(index), screen: true, sign: 1, uv: Float64Array.from(uv) };
}

/**
 * 一條側面形狀（折線 [[a, b], …]，2D 座標放在 ax、ay 兩個方向）沿著 extrude 方向擠出 h 公尺做成的曲面（廣義圓柱），高度分 rows 段。
 * 三角形的繞向讓法線朝 (折線走向 × 擠出方向) 的方向；flip = 反過來。舊 UV：u = 沿折線的弧長比例，v = 1 - 沿擠出方向的比例。
 */
export function extrudePrim(profile: readonly (readonly [number, number])[], ax: Vec3, ay: Vec3, extrude: Vec3, h: number, rows = 2, flip = false): PrimGeom {
  const pos: number[] = [], uv: number[] = [], index: number[] = [];
  const n = profile.length;
  let total = 0;
  const cum = [0];
  for (let i = 1; i < n; i++) { total += Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]); cum.push(total); }
  const ex = normalize(extrude);
  const ux = normalize(ax), uy = normalize(ay);
  for (let r = 0; r <= rows; r++) {
    for (let i = 0; i < n; i++) {
      const p = add(add(scale(ux, profile[i][0]), scale(uy, profile[i][1])), scale(ex, (r / rows) * h));
      pos.push(p[0], p[1], p[2]);
      uv.push(cum[i] / total, 1 - r / rows);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i + 1 < n; i++) {
      const a = r * n + i, b = a + 1, c = a + n, d = c + 1;
      if (flip) index.push(a, d, b, a, c, d); else index.push(a, b, d, a, d, c);
    }
  }
  return { pos: Float64Array.from(pos), index: Uint32Array.from(index), screen: true, sign: 1, uv: Float64Array.from(uv) };
}

/**
 * 整圈封閉的圓柱（頂點在接縫處是共用的，沒有複製）：半徑 radius、高 height（y 從 0 到 height）、一圈 seg 格、高度分 rows 段。
 * startDeg：第一排頂點的角度（0 = +X 方向，往 +Z 轉，跟 arcPrim 同一個約定：x = sin(a)·r、z = cos(a)·r）。concave = 法線朝內（觀眾在圓柱裡面）。
 * 舊 UV：u = 一圈的比例（0~1，接縫處是 0 和 1），v = 1 - 高度比例。
 */
export function tubePrim(radius: number, height: number, seg = 24, rows = 2, startDeg = 0, concave = false): PrimGeom {
  const pos: number[] = [], uv: number[] = [], index: number[] = [];
  for (let r = 0; r <= rows; r++) {
    for (let i = 0; i < seg; i++) {
      const a = ((startDeg + (i / seg) * 360) * Math.PI) / 180;
      pos.push(Math.sin(a) * radius, (r / rows) * height, Math.cos(a) * radius);
      uv.push(i / seg, 1 - r / rows);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < seg; i++) {
      const a = r * seg + i, b = r * seg + ((i + 1) % seg), c = a + seg, d = b + seg;
      // a = 這一排的第 i 個、b = 右邊一個、c = 上一排的第 i 個、d = 上一排右邊一個；(a, b, c) 的法線 = 右 × 上 = 朝外（凸）；凹：反過來
      if (concave) index.push(a, c, b, b, c, d);
      else index.push(a, b, c, b, d, c);
    }
  }
  return { pos: Float64Array.from(pos), index: Uint32Array.from(index), screen: true, sign: 1, uv: Float64Array.from(uv) };
}

/** 馬鞍面（z = k·(x² - y²)）：不能攤平、沒有擠出方向 → LSCM 會有拉伸 */
export function saddlePrim(width: number, height: number, k: number, seg = 12): PrimGeom {
  const pos: number[] = [], uv: number[] = [], index: number[] = [];
  for (let j = 0; j <= seg; j++) {
    for (let i = 0; i <= seg; i++) {
      const s = i / seg, t = j / seg;
      const x = (s - 0.5) * width, y = (t - 0.5) * height;
      pos.push(x, y, k * (x * x - y * y));
      uv.push(s, 1 - t);
    }
  }
  const row = seg + 1;
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * row + i, b = a + 1, c = a + row, d = c + 1;
      index.push(a, b, d, a, d, c);
    }
  }
  return { pos: Float64Array.from(pos), index: Uint32Array.from(index), screen: true, sign: 1, uv: Float64Array.from(uv) };
}
