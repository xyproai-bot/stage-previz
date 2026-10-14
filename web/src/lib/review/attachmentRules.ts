// 留言的參考圖片（附件）規則：前端（貼上 / 拖進來 / 選檔案、縮小）和後台（cf-worker/commentAttachments.mjs 直接 import 這個 .ts）共用。
//
// 這個檔案前後台共用，所以只能放「純判斷」：不 import 別的檔案、不碰 DOM / React、不用 enum / namespace 這類要編譯的寫法。
//
//   - 只收 PNG / JPEG / WebP / GIF（看檔案開頭的位元組，不信副檔名或瀏覽器說的類型）
//   - 一張最多 15 MB；團隊一則最多 4 張、分享連結的訪客一則最多 2 張
//   - 前端先縮到長邊 2560 px 再傳（重新畫一次 = 拍照的 EXIF / GPS 位置一起拿掉）；GIF 原樣傳（會動的）
//   - 後台：JPEG / PNG / WebP 長邊超過 4096 = 沒經過縮小 → 不收

export const ATTACHMENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

/** 存檔用的副檔名 */
export const ATTACHMENT_EXT: Readonly<Record<AttachmentType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
/** 小縮圖（清單上顯示的，約 480 px）最多多大 */
export const ATTACHMENT_THUMB_MAX_BYTES = 300 * 1024;
export const MEMBER_MAX_ATTACHMENTS = 4;
export const GUEST_MAX_ATTACHMENTS = 2;
/** 前端縮到長邊最多這麼大（GIF 不動） */
export const ATTACHMENT_LONG_EDGE = 2560;
/** 清單上的小縮圖 */
export const ATTACHMENT_THUMB_EDGE = 480;
/** 後台：JPEG / PNG / WebP 長邊最多（前端縮過一定在這以內） */
export const ATTACHMENT_SERVER_MAX_EDGE = 4096;
/** GIF 原樣傳，長邊最多 */
export const ATTACHMENT_GIF_MAX_EDGE = 8192;
/** 前端：原圖超過這麼多像素就不打開（怕瀏覽器記憶體不夠當掉） */
export const ATTACHMENT_MAX_SOURCE_PIXELS = 120_000_000;
/** 只有圖片、沒寫字的留言：通知和舊版畫面顯示這個 */
export const IMAGE_ONLY_TEXT = '（圖片）';
/** 附件 id（後台給的） */
export const ATTACHMENT_ID_RE = /^ca_[a-z0-9]{8,40}$/;

export function isAttachmentType(t: unknown): t is AttachmentType {
  return typeof t === 'string' && (ATTACHMENT_TYPES as readonly string[]).includes(t);
}

export interface SniffedImage {
  type: AttachmentType;
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }                                      // 填充
    if (m === 0x01 || m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }  // 沒有長度的標記
    if (m === 0xd9 || m === 0xda) return null;                              // 圖片開始了還沒看到尺寸
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    // SOF0–SOF15（C4 = DHT、C8 = JPG、CC = DAC 不是）
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 9 > b.length) return null;
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return null;
}

/**
 * 看檔案開頭判斷是不是我們收的圖片、多大。不是 / 壞掉 → null
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const b = bytes;
  if (!b || b.length < 12) return null;
  let type: AttachmentType | null = null;
  let size: { width: number; height: number } | null = null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    type = 'image/png';
    if (b.length >= 24 && ascii(b, 12, 4) === 'IHDR') size = { width: u32be(b, 16), height: u32be(b, 20) };
  } else if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    type = 'image/jpeg';
    size = jpegSize(b);
  } else if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') {
    type = 'image/gif';
    size = { width: u16le(b, 6), height: u16le(b, 8) };
  } else if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    type = 'image/webp';
    size = webpSize(b);
  }
  if (!type || !size) return null;
  if (!(size.width > 0) || !(size.height > 0)) return null;
  return { type, width: size.width, height: size.height };
}

/** 縮到長邊最多 maxEdge（比較小就不動） */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (!(long > maxEdge)) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  const k = maxEdge / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** 檔案大小給人看：1.2 MB / 830 KB */
export function formatAttachmentSize(bytes: number): string {
  if (!(bytes > 0)) return '0 KB';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
