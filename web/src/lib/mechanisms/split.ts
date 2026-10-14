// 對開：把帶動的物件照位置分成兩邊（A 邊 / B 邊）。純判斷（不碰 DOM / three），有單元測試。
// 設計：docs/superpowers/specs/2026-10-15-mechanism-v2-design.md（第 5 節 Stage 2：「照位置自動分兩邊」）

import { audienceRight, horizontalFront, type MechanismKind, type MechanismSide, type MechVec3 } from './model';

const dot = (a: MechVec3, b: MechVec3) => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * 照位置分兩邊：
 *   找出物件中心散得最開的方向（觀眾的右手邊 / 上 / 前），在最中間切一刀；
 *   直線：A 邊 = 在「數字變大」那一頭的（正的數字讓 A 邊往外走）；方向跟切的方向垂直 → 觀眾看過去左邊 / 上面 / 前面
 *   旋轉：A 邊 = 觀眾看過去的左邊 / 上面 / 前面
 *   中心剛好在切線上的算 A 邊；找不到位置的物件放 A 邊；少於兩個物件有位置 → 全部 A 邊
 * centers：物件 id → 中心（cue 位置，場景座標）
 */
export function autoSplitSides(
  ids: string[], centers: Record<string, MechVec3 | undefined>, kind: MechanismKind, axis: MechVec3, front: MechVec3,
): Record<string, MechanismSide> {
  const out: Record<string, MechanismSide> = {};
  for (const id of ids) out[id] = 'a';
  const known = ids.filter(id => centers[id]);
  if (known.length < 2) return out;
  const f = horizontalFront(front);
  // [方向, 旋轉時 A 邊在這個方向的哪一頭（−1 = 小的那一頭）]
  const dirs: [MechVec3, 1 | -1][] = [[audienceRight(f), -1], [{ x: 0, y: 1, z: 0 }, 1], [f, 1]];
  let best: { d: MechVec3; sign: 1 | -1; min: number; max: number } | null = null;
  let bestSpread = 1e-6;
  for (const [d, rotSign] of dirs) {
    const ps = known.map(id => dot(centers[id]!, d));
    const min = Math.min(...ps), max = Math.max(...ps);
    if (max - min > bestSpread * (1 + 1e-9)) {
      bestSpread = max - min;
      const along = dot(axis, d);
      const sign: 1 | -1 = kind === 'rotary' || Math.abs(along) < 1e-6 ? rotSign : (along > 0 ? 1 : -1);
      best = { d, sign, min, max };
    }
  }
  if (!best) return out;
  const mid = (best.min + best.max) / 2;
  for (const id of known) out[id] = best.sign * (dot(centers[id]!, best.d) - mid) >= -1e-9 ? 'a' : 'b';
  return out;
}

/** 每一邊有幾個物件 */
export function countSides(ids: string[], sides: Record<string, MechanismSide | undefined>): { a: number; b: number } {
  let b = 0;
  for (const id of ids) if (sides[id] === 'b') b++;
  return { a: ids.length - b, b };
}
