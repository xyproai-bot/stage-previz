// 浮水印的一塊圖樣（SVG）：斜的兩行字（誰在看 / 日期時間），白字加黑邊——亮的、暗的 LED 畫面上都看得到。
// 整個畫面是這一塊重複貼滿（CSS background），錯半格排，不會有整排整列的空隙。
// 純函式：字進去、SVG 字串出來（測試看得到轉義、尺寸）。

export interface WatermarkTile {
  /** SVG 原始碼 */
  svg: string;
  /** 重複的單位（寬 × 高，單位 CSS px）；背景位置的移動量以它為準 */
  width: number;
  height: number;
  /** 可以直接放進 CSS background-image 的 data URL */
  url: string;
}

export const TILE_ANGLE_DEG = -28;
const FONT_STACK = "'Noto Sans TC','PingFang TC','Microsoft JhengHei',system-ui,sans-serif";

/** 大概的字寬（全形字 1 個字寬，英文數字約 0.58，空白 0.3）；只拿來決定圖樣多大，不用準 */
export function estimateTextWidth(text: string, fontPx: number): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === ' ') w += 0.3;
    else if (c < 0x2e80) w += 0.58;
    else w += 1;
  }
  return w * fontPx;
}

/** 畫面多寬 → 字放大縮小多少（手機小一點、大螢幕 / 全螢幕大一點；小播放器固定小） */
export function watermarkScale(widthPx: number, compact: boolean): number {
  if (compact) return 0.8;
  if (!(widthPx > 0)) return 1;
  if (widthPx < 480) return 0.85;
  if (widthPx < 900) return 1;
  if (widthPx < 1600) return 1.15;
  return 1.4;
}

/** 第一行的基本字級（CSS px），乘上 watermarkScale */
export const WATERMARK_BASE_FONT_PX = 13;

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * @param lines  [誰在看, 日期時間]
 * @param fontPx 第一行的字級（第二行小一點）
 */
export function buildWatermarkTile(lines: [string, string], fontPx: number): WatermarkTile {
  const f1 = fontPx;
  const f2 = Math.round(fontPx * 0.86 * 10) / 10;
  const w = Math.max(estimateTextWidth(lines[0], f1), estimateTextWidth(lines[1], f2));
  const h = f1 + f2 + fontPx * 0.5;
  const rad = Math.abs(TILE_ANGLE_DEG) * Math.PI / 180;
  const bw = w * Math.cos(rad) + h * Math.sin(rad);
  const bh = w * Math.sin(rad) + h * Math.cos(rad);
  // 同一排兩個之間留一個字寬以上的空，上下兩排之間也留空
  const W = Math.ceil(bw + fontPx * 3);
  const H = Math.ceil(bh + fontPx * 3);
  const stroke = Math.max(2, Math.round(fontPx * 0.2 * 10) / 10);

  const label = (cx: number, cy: number) =>
    `<g transform="translate(${cx} ${cy}) rotate(${TILE_ANGLE_DEG})">`
    + `<text x="0" y="${-(h / 2 - f1 * 0.85).toFixed(1)}" font-size="${f1}">${escapeXml(lines[0])}</text>`
    + `<text x="0" y="${(h / 2 - f2 * 0.2).toFixed(1)}" font-size="${f2}">${escapeXml(lines[1])}</text>`
    + `</g>`;

  // 第一排放在上半格中間；第二排錯開半格（左右各放一個，接起來剛好是完整的一個）
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H * 2}" viewBox="0 0 ${W} ${H * 2}">`
    + `<g fill="#fff" stroke="#000" stroke-width="${stroke}" stroke-linejoin="round" paint-order="stroke" text-anchor="middle" font-family="${FONT_STACK}" font-weight="600">`
    + label(W / 2, H / 2)
    + label(0, H * 1.5)
    + label(W, H * 1.5)
    + `</g></svg>`;

  return { svg, width: W, height: H * 2, url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
}
