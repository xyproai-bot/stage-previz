// 留言縮圖：留言當下抓一次 3D 畫面（StageViewApi.capture，最寬 480 px）＋把畫記畫上去 → JPEG（data URL）。
// 一則留言抓一次，不會每一格都抓。後台最多收 150 KB → 太大就降畫質、再縮小。

import { drawAnnotation, type Annotation } from './annotations';

export const THUMB_MAX_WIDTH = 480;
export const THUMB_TARGET_BYTES = 140 * 1024;

function dataUrlBytes(url: string): number {
  const i = url.indexOf(',');
  const b64 = i >= 0 ? url.length - i - 1 : url.length;
  return Math.floor(b64 * 3 / 4);
}

/** 把抓到的畫面（和畫記）變成 JPEG；抓不到 / 瀏覽器不讓讀 → null（留言照樣送出） */
export function composeThumbnail(frame: HTMLCanvasElement | null, ann: Annotation | null): string | null {
  if (!frame || !frame.width || !frame.height) return null;
  try {
    let w = Math.min(THUMB_MAX_WIDTH, frame.width);
    for (let attempt = 0; attempt < 3; attempt++) {
      const h = Math.max(1, Math.round(frame.height * (w / frame.width)));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      ctx.fillStyle = '#16181c';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(frame, 0, 0, w, h);
      if (ann) drawAnnotation(ctx, ann, w, h);
      for (const q of [0.82, 0.68, 0.55]) {
        const url = c.toDataURL('image/jpeg', q);
        if (!url.startsWith('data:image/jpeg')) return null;
        if (dataUrlBytes(url) <= THUMB_TARGET_BYTES) return url;
      }
      w = Math.round(w * 0.75);
    }
    return null;
  } catch (e) {
    // 畫面被跨網域的影片「污染」等 → 不放縮圖
    console.warn('[thumbnail]', e);
    return null;
  }
}
