// 「最近活動」要讀幾筆：一開始 50 筆；按「看更早的」一次讀到後台的上限 200 筆。
//   後台 GET /api/projects/:id/activity?limit=N（1 到 200，超過會被截成 200）

/** 一開始讀幾筆 */
export const ACTIVITY_FIRST = 50;
/** 後台一次最多給幾筆 */
export const ACTIVITY_MAX = 200;

/** 還有可能更早的紀錄嗎：這次要的筆數都拿滿了、而且還沒到後台的上限 */
export function canLoadEarlierActivity(loaded: number, limit: number): boolean {
  return limit < ACTIVITY_MAX && loaded >= limit;
}

/** 已經是後台能給的最多了，而且也拿滿了（再早的看不到） */
export function atActivityLimit(loaded: number, limit: number): boolean {
  return limit >= ACTIVITY_MAX && loaded >= ACTIVITY_MAX;
}
