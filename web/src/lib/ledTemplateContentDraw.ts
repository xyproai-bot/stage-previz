// LED 版型編輯器的畫布底層：底圖 + 每塊螢幕框裡的對位圖內容。用 canvas 畫，數字怎麼算在 lib/ledTemplateContent.ts / ledTemplateBackdrop.ts。
//
// 「對位圖內容」= 3D 的 LED 沒有影片時顯示的測試圖（drawTestPattern：名字、x y w h、100 px 格線、彩條、灰階、四角記號）。
// 整張畫布的測試圖只畫一次、留著（renderFullMap），拖曳、縮放、平移的時候只是從這張留著的圖裡剪一塊貼進框裡，不會重畫整張。

import { buildLedLayout, testPatternSize, type CanvasSize, type LedLayout, type PixelRect } from './ledMap';
import { drawTestPattern } from './ledMapDraw';
import type { Rotation, SrcSpan } from './ledTemplate';
import { backdropRect, type BackdropPrefs } from './ledTemplateBackdrop';
import { contentPieces, intersectsView, worthDrawing } from './ledTemplateContent';

/** 整張畫布的測試圖（留著用）：單邊最多 4096、面積最多 800 萬像素，跟 3D 上的測試圖同一張的樣子 */
export interface FullMap {
  canvas: HTMLCanvasElement;
  /** 這張圖代表的整張 LED 畫布（真實點數） */
  full: CanvasSize;
}

const MAP_MAX_SIDE = 4096;
const MAP_MAX_AREA = 8e6;

/** 找不到模型裡的 LED（只有替身方塊）時，3D 顯示的是整張畫布一張測試圖；編輯器也一樣 */
export function wholeCanvasLayout(canvas: CanvasSize): LedLayout {
  return buildLedLayout([{ id: 'led', name: 'LED', tris: [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1] }], canvas);
}

/** 把整張畫布的測試圖畫成一張 canvas（畫一次，之後一直用） */
export function renderFullMap(layout: LedLayout): FullMap {
  const size = testPatternSize(layout.canvas, MAP_MAX_SIDE, MAP_MAX_AREA);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('這個瀏覽器沒有 2D 畫布');
  drawTestPattern(ctx, layout, size.scale);
  return { canvas, full: layout.canvas };
}

export function releaseFullMap(map: FullMap | null) {
  if (!map) return;
  map.canvas.width = 0;
  map.canvas.height = 0;
}

export interface LayerItem {
  key: string;
  dest: PixelRect;
  rotate: Rotation;
  flipH: boolean;
  flipV: boolean;
}

export interface LayerBackdrop {
  image: CanvasImageSource;
  width: number;
  height: number;
  prefs: BackdropPrefs;
}

export interface LayerDraw {
  /** 版型畫布 */
  canvas: CanvasSize;
  /** 畫面：縮放 / 平移（版型畫布像素 → host 的 CSS 像素）和 host 的大小 */
  view: { zoom: number; panX: number; panY: number };
  size: { w: number; h: number };
  dpr: number;
  backdrop: LayerBackdrop | null;
  /** 對位圖內容；null = 不畫 */
  content: { map: FullMap; spanOf: (key: string) => SrcSpan | null } | null;
  /** 由下往上的順序 */
  items: readonly LayerItem[];
}

/** 畫底圖和每塊螢幕框裡的內容（canvas 事先設成 host 的大小 × dpr） */
export function drawLayers(ctx: CanvasRenderingContext2D, p: LayerDraw) {
  const { view, dpr } = p;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.panX, dpr * view.panY);

  // 最底下：底圖（只畫在版型畫布裡面）
  if (p.backdrop && p.backdrop.prefs.visible && p.backdrop.prefs.opacity > 0) {
    const r = backdropRect(p.backdrop.prefs.fit, p.backdrop, p.canvas);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, p.canvas.width, p.canvas.height);
    ctx.clip();
    ctx.globalAlpha = p.backdrop.prefs.opacity;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(p.backdrop.image, 0, 0, p.backdrop.width, p.backdrop.height, r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  // 每塊螢幕框裡：整張畫布測試圖裡屬於這塊螢幕的那一段，照轉動、翻轉、縮放擺進來
  if (p.content && p.content.map.canvas.width > 0) {
    const { map, spanOf } = p.content;
    const kx = map.canvas.width / map.full.width, ky = map.canvas.height / map.full.height;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (const it of p.items) {
      const span = spanOf(it.key);
      if (!span || !worthDrawing(it.dest, view.zoom) || !intersectsView(it.dest, view, p.size)) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(it.dest.x, it.dest.y, it.dest.w, it.dest.h);
      ctx.clip();
      for (const piece of contentPieces(span, map.full, it)) {
        const s = piece.src;
        ctx.save();
        ctx.transform(...piece.matrix);
        ctx.drawImage(map.canvas, s.x * kx, s.y * ky, s.w * kx, s.h * ky, s.x, s.y, s.w, s.h);
        ctx.restore();
      }
      ctx.restore();
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
