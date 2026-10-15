// 留言縮圖：留言當下抓一次 3D 畫面（StageViewApi.capture，最寬 480 px）＋把畫記和貼圖畫上去 → JPEG（data URL）。
// 一則留言抓一次，不會每一格都抓。後台最多收 150 KB → 太大就降畫質、再縮小。

import { drawAnnotation, type Annotation } from './annotations';
import { drawStickers } from './stickers';

export const THUMB_MAX_WIDTH = 480;
export const THUMB_TARGET_BYTES = 140 * 1024;

function dataUrlBytes(url: string): number {
  const i = url.indexOf(',');
  const b64 = i >= 0 ? url.length - i - 1 : url.length;
  return Math.floor(b64 * 3 / 4);
}

/**
 * 把抓到的畫面（和畫記、貼圖）變成 JPEG；抓不到 / 瀏覽器不讓讀 → null（留言照樣送出）
 * @param getImage 貼圖用的圖片（畫面上已經載好的）；沒給 = 縮圖上不畫貼圖。
 *   貼圖的圖片如果是別的網域來的又不給讀，畫上去會讓整張畫布不能輸出 → 這時候改成不畫貼圖再試一次，縮圖不會因此不見
 */
export function composeThumbnail(
  frame: HTMLCanvasElement | null, ann: Annotation | null, getImage?: (attachmentId: string) => CanvasImageSource | null,
): string | null {
  if (!frame || !frame.width || !frame.height) return null;
  const withImages = !!(getImage && ann?.images?.length);
  const first = renderThumbnail(frame, ann, withImages ? getImage : undefined);
  if (first.ok || !withImages) return first.url;
  return renderThumbnail(frame, ann, undefined).url;
}

function renderThumbnail(
  frame: HTMLCanvasElement, ann: Annotation | null, getImage?: (attachmentId: string) => CanvasImageSource | null,
): { ok: boolean; url: string | null } {
  try {
    let w = Math.min(THUMB_MAX_WIDTH, frame.width);
    for (let attempt = 0; attempt < 3; attempt++) {
      const h = Math.max(1, Math.round(frame.height * (w / frame.width)));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) return { ok: true, url: null };
      ctx.fillStyle = '#16181c';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(frame, 0, 0, w, h);
      if (ann) {
        // 貼圖在筆畫下面（筆畫是標記，要蓋在貼圖上看得到）
        if (getImage && ann.images?.length) drawStickers(ctx, ann.images, getImage, w, h);
        drawAnnotation(ctx, ann, w, h);
      }
      for (const q of [0.82, 0.68, 0.55]) {
        const url = c.toDataURL('image/jpeg', q);
        if (!url.startsWith('data:image/jpeg')) return { ok: true, url: null };
        if (dataUrlBytes(url) <= THUMB_TARGET_BYTES) return { ok: true, url };
      }
      w = Math.round(w * 0.75);
    }
    return { ok: true, url: null };
  } catch (e) {
    // 畫面被跨網域的影片「污染」等 → 不放縮圖
    console.warn('[thumbnail]', e);
    return { ok: false, url: null };
  }
}
