// 「沿弧形軌道」（直線機關的 variant = 'arc'）的小工具：純計算，不 import three、不用要編譯的 TS 寫法（前後台都能用）。
// 設計：docs/superpowers/specs/2026-10-29-director-stage-control-design.md 第 3 節
//
// 弧形機關：圓心 = pivot、轉軸 = axis（正負決定「值變大往哪邊走」）、半徑 = arcRadius（公尺）。
// 值 s（公尺，沿弧線量）→ 角度 θ = s ÷ 半徑（弧度），物件繞圓心轉 θ（pose.ts 的 applyChain 算）。
// 設定畫面用下面兩個函式把「物件現在的位置」換成半徑，並替原本的直線方向挑對轉軸的正負。

export interface ArcVec { x: number; y: number; z: number }

const dot = (a: ArcVec, b: ArcVec) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a: ArcVec, b: ArcVec): ArcVec => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: ArcVec, b: ArcVec): ArcVec => ({
  x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x,
});
const len = (a: ArcVec) => Math.hypot(a.x, a.y, a.z);
/** 單位向量；0 向量 → 往上（跟 pose.ts 的 unit 一樣） */
function unit(v: ArcVec): ArcVec {
  const l = len(v);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l, z: v.z / l } : { x: 0, y: 1, z: 0 };
}
/** -0 → 0（比較、顯示都乾淨） */
const clean = (n: number) => (Math.abs(n) < 1e-12 ? 0 : n);

/**
 * 物件中心到圓心、在垂直轉軸的平面上的距離（公尺）。物件的高度（沿轉軸的那一段）不算。
 * @param metersPerScene 1 個場景單位是幾公尺（測距校準倍率；壞的當 1）
 */
export function arcRadiusFor(pivot: ArcVec, axis: ArcVec, center: ArcVec, metersPerScene: number): number {
  const a = unit(axis);
  const rel = sub(center, pivot);
  const along = dot(rel, a);
  const perp = { x: rel.x - a.x * along, y: rel.y - a.y * along, z: rel.z - a.z * along };
  const s = metersPerScene > 0 && Number.isFinite(metersPerScene) ? metersPerScene : 1;
  return len(perp) * s;
}

/**
 * 回 upAxis 或 -upAxis（單位向量），讓「值變大」時物件在原位的移動方向跟 wantDir（原本直線的方向）同一邊。
 * 繞轉軸 A 往正角度轉時，離圓心 rel 的點移動的方向是 A × rel（右手定則）。
 * wantDir 跟移動方向垂直 / 是 0 向量 / 物件就在圓心上 → 用 upAxis 本身。
 */
export function arcAxisFor(pivot: ArcVec, upAxis: ArcVec, center: ArcVec, wantDir: ArcVec): ArcVec {
  const up = unit(upAxis);
  const move = cross(up, sub(center, pivot));
  const mag = len(move) * len(wantDir);
  const s = mag > 1e-12 && dot(move, wantDir) / mag < -1e-6 ? -1 : 1;
  return { x: clean(up.x * s), y: clean(up.y * s), z: clean(up.z * s) };
}
