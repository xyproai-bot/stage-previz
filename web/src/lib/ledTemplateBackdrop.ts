// LED 版型編輯器的「底圖」：製作自己載入一張參考圖（例如客戶給的這個排法的對位圖），墊在版型畫布最底下對位用。
// 這個檔案只放算數和檢查（不碰 canvas / 網路 / 瀏覽器儲存）：
//   - 底圖怎麼擺（照畫布大小拉伸 / 照原尺寸放左上）
//   - 底圖大小跟版型畫布差多少、要不要問怎麼擺
//   - 檔案能不能用、設定值怎麼整理
// 存在這台電腦的瀏覽器裡（lib/ledTemplateBackdropStore.ts），不會上傳到後台。

import type { CanvasSize, PixelRect } from './ledMap';

/** 底圖大小跟版型畫布不一樣時怎麼擺：stretch = 拉伸成畫布大小；native = 原尺寸放左上角 */
export type BackdropFit = 'stretch' | 'native';

export interface BackdropPrefs {
  fit: BackdropFit;
  /** 0 ~ 1 */
  opacity: number;
  visible: boolean;
}

export const DEFAULT_BACKDROP_PREFS: BackdropPrefs = { fit: 'stretch', opacity: 0.5, visible: true };

/** 還沒存檔的新版型用這個代號放底圖，存好拿到真正的代號以後再搬過去 */
export const NEW_TEMPLATE_ID = '__new__';

export const BACKDROP_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const BACKDROP_ACCEPT = BACKDROP_TYPES.join(',');
export const BACKDROP_MAX_BYTES = 80 * 1024 * 1024;
/** 瀏覽器畫得動的圖：單邊、面積（超過就解不開或很卡） */
export const BACKDROP_MAX_SIDE = 16384;
export const BACKDROP_MAX_AREA = 200e6;

/** 存在瀏覽器裡的鍵：專案 + 版型 */
export function backdropKey(projectId: string, templateId: string | null | undefined): string {
  return `${projectId}:${templateId || NEW_TEMPLATE_ID}`;
}

export function clampOpacity(n: unknown, fallback: number = DEFAULT_BACKDROP_PREFS.opacity): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
}

/** 讀回來的設定值（壞掉、缺欄位）整理成可以用的 */
export function normalizeBackdropPrefs(raw: unknown): BackdropPrefs {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    fit: o.fit === 'native' ? 'native' : 'stretch',
    opacity: clampOpacity(o.opacity),
    visible: o.visible === false ? false : true,
  };
}

/** 檔案能不能當底圖；可以 = null，不行 = 要告訴使用者的話 */
export function checkBackdropFile(file: { name: string; type: string; size: number }): string | null {
  const type = (file.type || '').toLowerCase();
  const byName = /\.(png|jpe?g|webp)$/i.test(file.name);
  const typeOk = (BACKDROP_TYPES as readonly string[]).includes(type) || (!type && byName);
  if (!typeOk) return '底圖只能用 PNG、JPG 或 WebP 圖檔';
  if (file.size <= 0) return '這個檔案是空的';
  if (file.size > BACKDROP_MAX_BYTES) return `底圖檔案太大了（${Math.round(file.size / 1048576)} MB），請縮小到 ${Math.round(BACKDROP_MAX_BYTES / 1048576)} MB 以內`;
  return null;
}

/** 解開以後的圖片大小能不能畫；可以 = null */
export function checkBackdropPixels(size: { width: number; height: number }): string | null {
  if (!(size.width > 0 && size.height > 0)) return '這張圖讀不出大小';
  if (size.width > BACKDROP_MAX_SIDE || size.height > BACKDROP_MAX_SIDE || size.width * size.height > BACKDROP_MAX_AREA) {
    return `這張圖太大了（${size.width}×${size.height}），瀏覽器畫不動；請縮小到單邊 ${BACKDROP_MAX_SIDE} 像素以內`;
  }
  return null;
}

export function sameSize(img: { width: number; height: number }, canvas: CanvasSize): boolean {
  return img.width === canvas.width && img.height === canvas.height;
}

/**
 * 底圖畫在版型畫布上的哪裡（版型畫布像素）：
 *   大小一樣、或選「照畫布大小拉伸」= 整張畫布；選「照原尺寸放左上」= 原尺寸、左上角對齊（超出畫布的部分不畫）
 */
export function backdropRect(fit: BackdropFit, img: { width: number; height: number }, canvas: CanvasSize): PixelRect {
  if (sameSize(img, canvas) || fit === 'stretch') return { x: 0, y: 0, w: canvas.width, h: canvas.height };
  return { x: 0, y: 0, w: img.width, h: img.height };
}

/** 底圖跟版型畫布大小不一樣時要說的話；一樣 = null */
export function backdropSizeNote(img: { width: number; height: number }, canvas: CanvasSize): string | null {
  if (sameSize(img, canvas)) return null;
  const ratioImg = img.width / img.height, ratioCanvas = canvas.width / canvas.height;
  const ratioNote = Math.abs(ratioImg / ratioCanvas - 1) > 0.01 ? '，長寬比也不一樣' : '';
  return `底圖是 ${img.width}×${img.height}，版型畫布是 ${canvas.width}×${canvas.height}${ratioNote}`;
}
