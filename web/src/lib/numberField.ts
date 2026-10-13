// 管理頁數字欄位（位置 / 角度）：打字 → 按 Enter 或點別的地方就存
//
// 位置在資料裡是「場景單位」（模型自動縮放後的單位），畫面上顯示成公尺：
//   公尺 = 場景單位 × 測距校準倍率（跟比例尺、測距、機關滑桿同一個倍率）
// 沒校準過時倍率 = 1，數字跟以前一樣。

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** 欄位裡打的字 → 數字；空白 / 不是數字（例：「abc」「1.2.3」「-」）→ null（不存、欄位還原） */
export function parseNumberInput(text: string): number | null {
  const t = text.trim();
  if (!NUMBER_RE.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function roundTo(v: number, decimals: number): number {
  const f = 10 ** decimals;
  const r = Math.round(v * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/** 欄位上顯示的數字（最多 decimals 位小數，不補零） */
export function formatFieldNumber(v: number, decimals = 3): string {
  return Number.isFinite(v) ? String(roundTo(v, decimals)) : '0';
}

const safeScale = (scaleCorrection: number) => (scaleCorrection > 0 && Number.isFinite(scaleCorrection) ? scaleCorrection : 1);

/** 場景單位 → 公尺（顯示用） */
export function sceneToMeters(v: number, scaleCorrection: number): number {
  return v * safeScale(scaleCorrection);
}

/** 公尺 → 場景單位（存檔用；留 6 位小數，去掉除法的小尾巴） */
export function metersToScene(m: number, scaleCorrection: number): number {
  return roundTo(m / safeScale(scaleCorrection), 6);
}

/** 打的數字跟目前存的（照顯示的位數）一樣 → 不用存 */
export function sameAsShown(typed: number, current: number, decimals = 3): boolean {
  return roundTo(typed, decimals) === roundTo(current, decimals);
}

/** 方向鍵微調：從欄位裡的數字加 delta；欄位裡不是數字就從 fallback（目前的值）開始 */
export function stepNumberInput(text: string, fallback: number, delta: number, decimals = 3): string {
  const base = parseNumberInput(text) ?? fallback;
  return formatFieldNumber(base + delta, decimals);
}
