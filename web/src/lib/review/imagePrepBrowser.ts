// 參考圖片在瀏覽器裡縮小、重新存一次（拿掉 EXIF / GPS），再做一張清單用的小縮圖。規則在 imagePrep.ts。

import { ATTACHMENT_MAX_BYTES, ATTACHMENT_THUMB_EDGE, fitWithin, sniffImage, type AttachmentType } from './attachmentRules';
import { planImagePrep, prepTargetSize } from './imagePrep';

export interface PreparedImage {
  blob: Blob;
  type: AttachmentType;
  width: number;
  height: number;
  /** 清單上顯示的小縮圖（WebP / JPEG，約 480 px）；做不出來 = null */
  thumb: Blob | null;
}

export class ImagePrepError extends Error {}

let webpOk: boolean | null = null;
/** 這個瀏覽器能不能存 WebP（Safari 不行） */
export function canEncodeWebp(): boolean {
  if (webpOk !== null) return webpOk;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    webpOk = c.toDataURL('image/webp').startsWith('data:image/webp');
  } catch { webpOk = false; }
  return webpOk;
}

type Drawable = ImageBitmap | HTMLImageElement;

async function decode(file: Blob): Promise<{ img: Drawable; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    for (const opts of [{ imageOrientation: 'from-image' } as ImageBitmapOptions, undefined]) {
      try {
        const bmp = opts ? await createImageBitmap(file, opts) : await createImageBitmap(file);
        return { img: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
      } catch { /* 換下一種方法 */ }
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } catch {
    throw new ImagePrepError('這張圖片打不開，請換一張或存成 JPEG / PNG 再放');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise(res => canvas.toBlob(b => res(b), type, quality));
}

function draw(img: Drawable, w: number, h: number, background?: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new ImagePrepError('這個瀏覽器不能處理圖片');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, w, h); }
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

async function makeThumb(img: Drawable, width: number, height: number): Promise<Blob | null> {
  try {
    const t = fitWithin(width, height, ATTACHMENT_THUMB_EDGE);
    if (canEncodeWebp()) {
      const b = await toBlob(draw(img, t.width, t.height), 'image/webp', 0.8);
      if (b && b.type === 'image/webp') return b;
    }
    return await toBlob(draw(img, t.width, t.height, '#1f2125'), 'image/jpeg', 0.82);
  } catch {
    return null;
  }
}

/** 一張圖：檢查 → 縮小 / 重新存（GIF 原樣）→ 小縮圖。不能用 → 丟 ImagePrepError（訊息可以直接給人看） */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sniff = sniffImage(bytes);
  const plan = planImagePrep(
    { type: sniff?.type || file.type, size: file.size, width: sniff?.width ?? 0, height: sniff?.height ?? 0 },
    { webpEncode: canEncodeWebp() },
  );
  if (plan.action === 'reject') throw new ImagePrepError(plan.reason);
  const d = await decode(file);
  try {
    if (plan.action === 'keep') {
      return { blob: file, type: 'image/gif', width: d.width, height: d.height, thumb: await makeThumb(d.img, d.width, d.height) };
    }
    const size = prepTargetSize(d.width, d.height);
    const canvas = draw(d.img, size.width, size.height, plan.output === 'image/jpeg' ? '#ffffff' : undefined);
    let blob = await toBlob(canvas, plan.output, plan.output === 'image/png' ? undefined : 0.9);
    // 瀏覽器不會存 WebP → 給的是 PNG
    if (blob && blob.type !== plan.output && blob.type !== 'image/png') blob = null;
    if (!blob) throw new ImagePrepError('這張圖片處理不了，請換一張或存成 JPEG / PNG 再放');
    if (blob.size > ATTACHMENT_MAX_BYTES) throw new ImagePrepError('這張圖片縮小後還是太大（一張最多 15 MB）');
    return {
      blob, type: blob.type as AttachmentType, width: size.width, height: size.height,
      thumb: await makeThumb(d.img, d.width, d.height),
    };
  } finally {
    d.close();
  }
}
