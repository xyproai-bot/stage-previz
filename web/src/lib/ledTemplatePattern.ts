// LED 畫布版型的「測試圖」和「模板圖」的排版（純算數，不碰 canvas）：
//   - 測試圖：編輯版型的時候貼在 3D 的 LED 上。每塊螢幕一個不一樣的顏色，上面寫名字、真實點數、一支「上」的箭頭、像素格；
//     畫在螢幕自己的方向裡（轉 90° / 翻轉的螢幕，圖在版型畫布上是橫的 / 鏡像的），貼回 3D 上才會是正的 —— 放錯、轉錯一眼就看得出來。
//   - 模板圖（下載給動畫師當 AE 參考圖層）：深色底，每塊螢幕的長方形 + 名字 + 版型裡的像素 + 一支指著「這塊螢幕的上方」的箭頭，字是正的。
// 真的拿 canvas 畫在 lib/ledTemplateDraw.ts。
//
// 座標：版型畫布像素（原點左上，y 朝下）。「本地座標」= 螢幕自己的真實點數（左上 (0,0)，寬 nativeW 高 nativeH）。

import { panelColor, panelHue, safeName, type CanvasSize, type PixelRect } from './ledMap';
import { resolveCabinet, type Cabinet } from './ledCabinet';
import { localTransform, type LedTemplatePlan, type Rotation, type ScreenDef } from './ledTemplate';

/** 2D canvas 的 transform(a, b, c, d, e, f)：x' = a·x + c·y + e，y' = b·x + d·y + f */
export type Matrix6 = [number, number, number, number, number, number];

export interface PatternItem {
  key: string;
  name: string;
  /** 這塊螢幕在螢幕清單裡的第幾個（顏色跟著它，拿掉別塊顏色不會變） */
  index: number;
  hue: number;
  color: string;
  dest: PixelRect;
  rotate: Rotation;
  flipH: boolean;
  flipV: boolean;
  /** 螢幕自己的真實點數（測試圖就畫在這個大小的座標裡） */
  native: { w: number; h: number };
  /** 本地座標 → 版型畫布像素 */
  matrix: Matrix6;
  /** 這塊螢幕的「上方」在版型畫布上指哪個方向（單位向量，只會是上下左右） */
  up: { dx: number; dy: number };
  upText: '朝上' | '朝右' | '朝下' | '朝左';
  /** 有鏡像（左右翻和上下翻只翻一個） */
  mirrored: boolean;
  nativeText: string;
  destText: string;
  /** 測試圖網格一格 = 一片 LED 箱體的大小（真實點數，在螢幕自己的座標裡） */
  cabinet: Cabinet;
}

/** 螢幕的上方在版型畫布上指哪裡：本地的 (0, -1) 經過轉動、翻轉 */
export function upDirection(rotate: Rotation, flipH: boolean, flipV: boolean): { dx: number; dy: number } {
  const t = localTransform(rotate, flipH, flipV);
  // A·(0, -1) = (-a01, -a11)；加 0 把 -0 變成 0
  return { dx: -t.a[1] + 0, dy: -t.a[3] + 0 };
}

export function upText(dir: { dx: number; dy: number }): PatternItem['upText'] {
  if (dir.dy < 0) return '朝上';
  if (dir.dy > 0) return '朝下';
  return dir.dx > 0 ? '朝右' : '朝左';
}

/** 本地座標 → 版型畫布像素的矩陣 */
export function localMatrix(dest: PixelRect, native: { w: number; h: number }, rotate: Rotation, flipH: boolean, flipV: boolean): Matrix6 {
  const t = localTransform(rotate, flipH, flipV);
  const lw = Math.max(1, native.w), lh = Math.max(1, native.h);
  return [
    (dest.w * t.a[0]) / lw, (dest.h * t.a[2]) / lw,
    (dest.w * t.a[1]) / lh, (dest.h * t.a[3]) / lh,
    dest.x + dest.w * t.b[0], dest.y + dest.h * t.b[1],
  ];
}

export function applyMatrix(m: Matrix6, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 排版：版型裡每一塊螢幕一個項目（在模型裡找不到的螢幕略過）；順序照版型裡的放法 */
export function layoutPattern(plan: Pick<LedTemplatePlan, 'screens'> & { cabinet?: Cabinet | null }, defs: readonly ScreenDef[]): PatternItem[] {
  const out: PatternItem[] = [];
  for (const p of plan.screens) {
    const index = defs.findIndex(d => d.key === p.key);
    if (index < 0) continue;
    const def = defs[index];
    const native = { w: def.nativeW, h: def.nativeH };
    const up = upDirection(p.rotate, p.flipH, p.flipV);
    out.push({
      key: p.key, name: def.name, index,
      hue: panelHue(index), color: panelColor(index),
      dest: p.dest, rotate: p.rotate, flipH: p.flipH, flipV: p.flipV,
      native,
      matrix: localMatrix(p.dest, native, p.rotate, p.flipH, p.flipV),
      up, upText: upText(up), mirrored: p.flipH !== p.flipV,
      nativeText: `${def.nativeW}×${def.nativeH}`,
      destText: `${p.dest.w}×${p.dest.h}`,
      cabinet: resolveCabinet(p.cabinet, plan.cabinet),
    });
  }
  return out;
}

// ───────────────────────── 模板圖（給 AE 的參考圖層）─────────────────────────

export interface GuideBox {
  /** 箭頭：中心、長度（沿 up 方向） */
  arrow: { cx: number; cy: number; len: number };
  /** 文字區：左上角、寬、可用高度 */
  text: { x: number; y: number; w: number; h: number };
  layout: 'side' | 'stack';
}

/**
 * 一塊螢幕長方形裡，箭頭和文字怎麼擺：
 *  - 很扁的長條（寬 > 高 × 2.2）：箭頭放左邊，文字放右邊
 *  - 其他：箭頭放上面，文字放下面
 * 箭頭長度不超過長方形最短邊的 0.6 倍。
 */
export function guideLayout(dest: PixelRect): GuideBox {
  const { x, y, w, h } = dest;
  const m = Math.min(w, h);
  if (w > h * 2.2) {
    const len = Math.max(1, m * 0.6);
    const side = Math.min(w * 0.3, h * 1.1);
    return {
      layout: 'side',
      arrow: { cx: x + side / 2, cy: y + h / 2, len },
      text: { x: x + side, y, w: w - side, h },
    };
  }
  const len = Math.max(1, Math.min(m * 0.6, h * 0.34));
  return {
    layout: 'stack',
    arrow: { cx: x + w / 2, cy: y + h * 0.1 + len / 2, len },
    text: { x, y: y + h * 0.1 + len + h * 0.02, w, h: h - (h * 0.1 + len + h * 0.04) },
  };
}

/** 模板圖的檔名：LED版型圖-主舞臺-中間底幕-4400x200.png */
export function guideFileName(projectName: string | undefined, plan: Pick<LedTemplatePlan, 'name' | 'canvas'>): string {
  return `LED版型圖-${safeName(projectName || '')}-${safeName(plan.name)}-${plan.canvas.width}x${plan.canvas.height}.png`;
}

/** 測試圖貼圖要多大：跟版型畫布同比例，單邊 4096、面積 600 萬像素以內（夠看清楚字，改一次畫得快） */
export const PATTERN_MAX_SIDE = 4096;
export const PATTERN_MAX_AREA = 6e6;

export function patternSize(canvas: CanvasSize): { width: number; height: number; scale: number } {
  const scale = Math.min(1, PATTERN_MAX_SIDE / Math.max(canvas.width, canvas.height), Math.sqrt(PATTERN_MAX_AREA / (canvas.width * canvas.height)));
  return { width: Math.max(16, Math.round(canvas.width * scale)), height: Math.max(16, Math.round(canvas.height * scale)), scale };
}
