// 自動貼 UV 排版畫面：框裡的測試圖，照「這塊現在排在哪裡」畫（純函式，不碰 canvas）。
// 以前框裡是從「自動排好的那一版」整張測試圖剪一塊貼進來，所以拖動以後框裡的 x y w h、角落座標還是舊位置。
// 現在每塊自己造一個只有它的小排法：它的位置 = 現在的左上角，大小 = 規格（沒轉過的樣子）；轉動、翻轉由 contentPieces 擺進框裡。

import { layoutPanel, type CanvasSize, type LedLayout } from '../ledMap';
import type { PixelRect } from '../ledMap';
import type { SrcSpan } from '../ledTemplate';
import { sourceSpan } from './arrange';

export interface TileContent {
  /** 只有這一塊的排法（畫布剛好包住它：左上角就是它現在的位置） */
  layout: LedLayout;
  /** 這塊在上面那張畫布裡的範圍 */
  span: SrcSpan;
}

/** 位置 x、y 是整數；放到畫布外面（負的）的，數字顯示成 0（畫布外的部分本來就不會寫進模型） */
export function tileContent(name: string, nativeW: number, nativeH: number, x: number, y: number, index: number): TileContent | null {
  const w = Math.round(nativeW), h = Math.round(nativeH);
  if (!(w > 0) || !(h > 0)) return null;
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const canvas: CanvasSize = { width: x0 + w, height: y0 + h };
  const rect: PixelRect = { x: x0, y: y0, w, h };
  const u0 = rect.x / canvas.width, v0 = rect.y / canvas.height, u1 = (rect.x + rect.w) / canvas.width, v1 = (rect.y + rect.h) / canvas.height;
  const panel = layoutPanel({ id: name, name, tris: [u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1] }, canvas, index);
  if (!panel) return null;
  return { layout: { canvas, panels: [panel], skipped: [] }, span: sourceSpan(rect, canvas) };
}

/** 同一塊位置沒變就用上一次算好的（拖曳時每一格只有被拖的那幾塊要重算） */
export function makeTileContentCache(limit = 400) {
  const cache = new Map<string, TileContent | null>();
  return (key: string, name: string, nativeW: number, nativeH: number, x: number, y: number, index: number): TileContent | null => {
    const sig = `${key}|${name}|${nativeW}x${nativeH}|${x},${y}|${index}`;
    if (cache.has(sig)) return cache.get(sig)!;
    const made = tileContent(name, nativeW, nativeH, x, y, index);
    if (cache.size >= limit) cache.clear();
    cache.set(sig, made);
    return made;
  };
}
