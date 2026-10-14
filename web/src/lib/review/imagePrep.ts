// 參考圖片傳上去之前要怎麼處理（純判斷，imagePrep.test.ts 有測；真的縮圖在 imagePrepBrowser.ts）：
//   - PNG / JPEG / WebP：一律重新畫一次（拍照的 EXIF / GPS 位置跟著拿掉），長邊超過 2560 px 就縮
//       JPEG → JPEG；PNG / WebP → WebP（瀏覽器不會存 WebP，例如 Safari → PNG），透明的地方留著
//   - GIF：原樣傳（會動的），只做一張小縮圖
//   - 不收的類型、超過 15 MB、尺寸大到瀏覽器會當掉 → 說清楚為什麼
//   - 貼上（Ctrl+V）：剪貼簿裡有圖片、又不是從 Excel / Word / 網頁複製的一段文字 → 當成圖片

import {
  ATTACHMENT_GIF_MAX_EDGE, ATTACHMENT_LONG_EDGE, ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_SOURCE_PIXELS, ATTACHMENT_TYPES,
  fitWithin, formatAttachmentSize, isAttachmentType, type AttachmentType,
} from './attachmentRules';

export type PrepPlan =
  | { action: 'reject'; reason: string }
  | { action: 'keep'; type: 'image/gif' }
  | { action: 'reencode'; output: 'image/jpeg' | 'image/webp' | 'image/png' };

export const ACCEPT_ATTR = ATTACHMENT_TYPES.join(',');

/**
 * @param input.type   瀏覽器說的類型（看檔頭判斷的比較準，有就用那個）
 * @param input.width / height  看檔頭讀到的尺寸（讀不到 = 0）
 */
export function planImagePrep(
  input: { type: string; size: number; width: number; height: number },
  opts: { webpEncode?: boolean } = {},
): PrepPlan {
  const t = String(input.type || '').toLowerCase();
  if (/heic|heif/.test(t)) return { action: 'reject', reason: 'iPhone 的 HEIC 照片請先存成 JPEG 再放（或用手機直接選照片）' };
  if (!isAttachmentType(t)) return { action: 'reject', reason: '只能放 PNG、JPEG、WebP、GIF 圖片' };
  if (input.size > ATTACHMENT_MAX_BYTES) {
    return { action: 'reject', reason: `這張圖片太大了（${formatAttachmentSize(input.size)}），一張最多 15 MB` };
  }
  if (!(input.width > 0) || !(input.height > 0)) return { action: 'reject', reason: '這張圖片打不開，請換一張或存成 JPEG / PNG 再放' };
  if (input.width * input.height > ATTACHMENT_MAX_SOURCE_PIXELS) {
    return { action: 'reject', reason: `這張圖片的尺寸太大了（${input.width}×${input.height}），請先縮小再放` };
  }
  if (t === 'image/gif') {
    if (Math.max(input.width, input.height) > ATTACHMENT_GIF_MAX_EDGE) {
      return { action: 'reject', reason: `這張 GIF 的尺寸太大了（${input.width}×${input.height}），請先縮小再放` };
    }
    return { action: 'keep', type: 'image/gif' };
  }
  const type = t as AttachmentType;
  if (type === 'image/jpeg') return { action: 'reencode', output: 'image/jpeg' };
  return { action: 'reencode', output: opts.webpEncode ? 'image/webp' : 'image/png' };
}

/** 縮完的尺寸（長邊最多 2560；比較小就不動） */
export function prepTargetSize(width: number, height: number): { width: number; height: number } {
  return fitWithin(width, height, ATTACHMENT_LONG_EDGE);
}

/**
 * 貼上的時候：剪貼簿的內容要當圖片還是文字
 *   沒有圖片 → 'text'；有圖片、但同時有一段有字的 HTML（Excel / Word / 網頁選一段）→ 'text'（照一般貼上）；
 *   其他（截圖、「複製圖片」、檔案總管複製的檔案）→ 'images'
 */
export function pastePlan(imageCount: number, html: string): 'images' | 'text' {
  if (imageCount <= 0) return 'text';
  const plain = String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .trim();
  return plain ? 'text' : 'images';
}

/** 可以加幾張（已經有的 + 這次的，超過上限的不加） */
export function attachmentRoom(current: number, adding: number, max: number): { take: number; dropped: number } {
  const room = Math.max(0, max - current);
  const take = Math.min(room, Math.max(0, adding));
  return { take, dropped: Math.max(0, adding - take) };
}
