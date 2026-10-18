// 禁止下載的前端那一半：把影片 / 畫面上「順手就能存」的路都關掉（純判斷 + 一個設 <video> 屬性的小函式）。
// 擋得到的：右鍵「影片另存新檔」「圖片另存」、瀏覽器影片播放器自己的下載鈕、子母畫面（浮出去的影片沒有浮水印）、拖曳存檔。
// 擋不到的：螢幕錄影、拍螢幕、開發人員工具——所以才要有浮水印。畫面上也是這樣寫給使用者看的（lib/watermark/copy.ts）。

export interface ElementLike {
  tagName?: string;
  closest?: (selector: string) => unknown;
}

/** 這些地方是「畫面」：3D 舞台、小播放器的影片、浮水印層、影片、畫布、圖片 */
export const MEDIA_SURFACE_SELECTOR = '.stage-scene, .mini-player__screen, .wm-overlay, video, canvas, img';

export function isMediaSurface(el: ElementLike | null | undefined): boolean {
  if (!el) return false;
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'VIDEO' || tag === 'CANVAS' || tag === 'IMG') return true;
  return !!el.closest?.(MEDIA_SURFACE_SELECTOR);
}

/** 右鍵選單 / 開始拖曳要不要擋：打在畫面上才擋（留言框、輸入欄的右鍵照常能用，才能貼上文字） */
export function shouldBlockMediaEvent(target: unknown): boolean {
  return isMediaSurface(target as ElementLike | null);
}

export interface VideoGuardOptions {
  /** 禁止下載：拿掉瀏覽器影片播放器的下載 */
  noDownload: boolean;
  /** 有浮水印：影片不能浮出去（子母畫面 / 投放到別的螢幕的影片沒有浮水印那一層） */
  watermark: boolean;
}

/** <video> 的屬性：下載、子母畫面、投放。on 之外的（兩個都沒開）一律還原成瀏覽器預設 */
export function applyVideoGuards(video: HTMLVideoElement, opts: VideoGuardOptions): void {
  const guarded = opts.noDownload || opts.watermark;
  video.disablePictureInPicture = guarded;
  (video as HTMLVideoElement & { disableRemotePlayback: boolean }).disableRemotePlayback = guarded;
  if (opts.noDownload) video.setAttribute('controlsList', 'nodownload noremoteplayback');
  else video.removeAttribute('controlsList');
}
