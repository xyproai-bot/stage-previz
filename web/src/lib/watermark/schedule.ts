// 浮水印什麼時候換字、什麼時候換位置（純函式，時間都由外面給）。
//
//   日期時間每分鐘更新一次（整分鐘換）。
//   位置每 45 秒慢慢換一個地方（畫面上是滑過去，不是閃一下）：
//     不固定在同一處，截圖時用裁切就切不乾淨；
//     位置由「連結編號 / 名字」決定起點，之後照黃金比例一步一步走，相鄰兩次一定差很遠、一段時間內各處都走得到。

export const STAMP_PERIOD_MS = 60_000;
export const MOVE_PERIOD_MS = 45_000;

/** 現在是第幾個「換位置」的時段（時間每過 45 秒加一） */
export function moveIndex(nowMs: number): number {
  return Math.floor(nowMs / MOVE_PERIOD_MS);
}

/** 現在是第幾分鐘（日期時間字樣跟著它換） */
export function minuteIndex(nowMs: number): number {
  return Math.floor(nowMs / STAMP_PERIOD_MS);
}

/** 離下一個整分鐘還有幾毫秒（剛好整分鐘 = 一整分鐘） */
export function msUntilNextMinute(nowMs: number): number {
  return STAMP_PERIOD_MS - (((nowMs % STAMP_PERIOD_MS) + STAMP_PERIOD_MS) % STAMP_PERIOD_MS);
}

/** 離下一次換位置還有幾毫秒 */
export function msUntilNextMove(nowMs: number): number {
  return MOVE_PERIOD_MS - (((nowMs % MOVE_PERIOD_MS) + MOVE_PERIOD_MS) % MOVE_PERIOD_MS);
}

/** 下一次要動（換字或換位置，哪個先到）是幾毫秒後；多留 50 毫秒避免計時器早了一點點又落在同一個時段 */
export function nextTickDelay(nowMs: number): number {
  return Math.min(msUntilNextMinute(nowMs), msUntilNextMove(nowMs)) + 50;
}

/** 字串 → [0, 1)（FNV-1a；同一個字串永遠同一個數字） */
export function seedFraction(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0) / 0x100000000;
}

const frac = (x: number) => x - Math.floor(x);

const STEP_X = 0.6180339887;   // 黃金比例：相鄰兩次在圓環上至少差 0.38
const STEP_Y = 0.4142135624;   // 根號 2 減 1：至少差 0.41

/**
 * 第 index 個時段，圖樣要往右 / 往下移多少（占一塊圖樣寬高的比例，0 到 1 之間）。
 * 同一個 seed、同一個 index 永遠一樣（重新整理也一樣）；不同的 seed 起點不同。
 */
export function moveOffset(index: number, seed: string): { fx: number; fy: number } {
  const sx = seedFraction(`x|${seed}`);
  const sy = seedFraction(`y|${seed}`);
  return { fx: frac(sx + index * STEP_X), fy: frac(sy + index * STEP_Y) };
}

/** 圓環上兩個 0~1 的位置差多遠（0.9 和 0.1 只差 0.2） */
export function ringDistance(a: number, b: number): number {
  const d = Math.abs(frac(a) - frac(b));
  return Math.min(d, 1 - d);
}

/** 換成實際的像素位置（background-position 用）；tile = 一塊圖樣的寬高 */
export function offsetPx(index: number, seed: string, tile: { width: number; height: number }): { x: number; y: number } {
  const { fx, fy } = moveOffset(index, seed);
  return { x: Math.round(fx * tile.width), y: Math.round(fy * tile.height) };
}
