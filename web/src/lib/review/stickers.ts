// 貼圖（貼在 3D 畫面上的參考圖片）——純函式（stickers.test.ts 有測）
//
// 資料格式和整理規則在 stickerRules.ts（前後台共用）。這裡是畫面上的算法：
//   一張貼圖 = 中心 (x, y)、寬 w、高 h（都是 0~1，相對畫記的那塊畫面：x、w 看寬，y、h 看高）、轉 rot 度、不透明度。
//   所有「滑鼠 / 手指怎麼動 → 貼圖變怎樣」都在這裡算，畫面元件只負責收事件、畫出來。
//   算的時候一律換成像素（W × H = 畫記那塊畫面的大小），所以轉了角度、畫面不是正方形也不會歪。

import {
  STICKER_MAX_SIZE, STICKER_MIN_SIZE, normalizeRot, roundImage,
  type AnnImage,
} from './stickerRules';

export type Pt = readonly [number, number];

/** 新貼上去的貼圖預設的不透明度（半透明才看得到底下的舞台） */
export const STICKER_DEFAULT_OPACITY = 0.75;
/** 新貼上去的貼圖，長邊佔畫面的比例 */
export const STICKER_START_EXTENT = 0.5;
/** 按住 Shift 轉的時候，每一格幾度 */
export const STICKER_SNAP_DEG = 15;
/** 轉動把手離貼圖上緣多遠（像素） */
export const STICKER_ROTATE_OFFSET = 30;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const deg = (rad: number) => (rad * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;

/**
 * 新貼上去的貼圖：保持圖片原本的比例，長邊佔畫面的一半；放在畫面中間，已經貼了幾張就錯開一點，不會剛好疊在一起。
 * @param aspect 畫面的寬 / 高
 * @param imgW 圖片的寬（像素；不知道就給 0，用 3:2）
 */
export function newSticker(attachmentId: string, imgW: number, imgH: number, aspect: number, index = 0): AnnImage {
  const r = imgW > 0 && imgH > 0 ? imgW / imgH : 1.5;
  const a = aspect > 0 ? aspect : 16 / 9;
  // 圖片在畫面上的比例 = w × a / h = r → h = w × a / r；寬和高都不超過 STICKER_START_EXTENT
  const w = Math.min(STICKER_START_EXTENT, (STICKER_START_EXTENT * r) / a);
  const h = (w * a) / r;
  const off = (index % 5) * 0.045;
  return roundImage({
    type: 'image', attachmentId,
    x: 0.5 + off, y: 0.5 + off, w, h, rot: 0, opacity: STICKER_DEFAULT_OPACITY,
  });
}

/** 畫面上圖片的寬 / 高（像素比例） */
export function stickerPixelAspect(el: Pick<AnnImage, 'w' | 'h'>, frameAspect: number): number {
  return el.h > 0 ? (el.w * frameAspect) / el.h : 1;
}

/** 貼圖在 W × H 這塊畫面上的樣子（中心、寬、高，像素） */
export function stickerPx(el: AnnImage, W: number, H: number): { cx: number; cy: number; w: number; h: number } {
  return { cx: el.x * W, cy: el.y * H, w: el.w * W, h: el.h * H };
}

/** 像素位置 → 以貼圖中心為原點、跟著貼圖轉回來的位置（貼圖沒轉的時候就是正的） */
export function toStickerLocal(p: Pt, el: AnnImage, W: number, H: number): [number, number] {
  const { cx, cy } = stickerPx(el, W, H);
  const dx = p[0] - cx, dy = p[1] - cy;
  const a = rad(-el.rot);
  return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
}

/** 這個點有沒有點到貼圖（轉過的長方形） */
export function hitSticker(p: Pt, el: AnnImage, W: number, H: number): boolean {
  const { w, h } = stickerPx(el, W, H);
  const [lx, ly] = toStickerLocal(p, el, W, H);
  return Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2;
}

/** 從最上面那張往下找，點到哪一張（沒有 = null） */
export function pickSticker(p: Pt, list: readonly AnnImage[], W: number, H: number): AnnImage | null {
  for (let i = list.length - 1; i >= 0; i--) if (hitSticker(p, list[i], W, H)) return list[i];
  return null;
}

/** 四個角（左上、右上、右下、左下）在畫面上的位置（像素，已經算進轉動） */
export function stickerCorners(el: AnnImage, W: number, H: number): [Pt, Pt, Pt, Pt] {
  const { cx, cy, w, h } = stickerPx(el, W, H);
  const a = rad(el.rot);
  const c = Math.cos(a), s = Math.sin(a);
  const at = (lx: number, ly: number): Pt => [cx + lx * c - ly * s, cy + lx * s + ly * c];
  return [at(-w / 2, -h / 2), at(w / 2, -h / 2), at(w / 2, h / 2), at(-w / 2, h / 2)];
}

/** 拖：整張貼圖跟著手指平移（中心夾在畫面裡，不會整張拖出去找不回來） */
export function moveSticker(start: AnnImage, dxPx: number, dyPx: number, W: number, H: number): AnnImage {
  if (!(W > 0) || !(H > 0)) return start;
  return roundImage({ ...start, x: clamp(start.x + dxPx / W, 0, 1), y: clamp(start.y + dyPx / H, 0, 1) });
}

/** 把倍率限制在貼圖的寬、高都在最小最大之間 */
function clampScale(start: Pick<AnnImage, 'w' | 'h'>, k: number): number {
  const lo = Math.max(STICKER_MIN_SIZE / start.w, STICKER_MIN_SIZE / start.h);
  const hi = Math.min(STICKER_MAX_SIZE / start.w, STICKER_MAX_SIZE / start.h);
  return clamp(k, lo, Math.max(lo, hi));
}

/**
 * 拖角落縮放：以貼圖中心為準，手指離中心多遠，貼圖就放大多少倍；比例不變。
 * @param startPtr 按下去的位置、ptr 現在的位置（像素）
 */
export function scaleSticker(start: AnnImage, startPtr: Pt, ptr: Pt, W: number, H: number): AnnImage {
  const { cx, cy } = stickerPx(start, W, H);
  const d0 = Math.hypot(startPtr[0] - cx, startPtr[1] - cy);
  const d1 = Math.hypot(ptr[0] - cx, ptr[1] - cy);
  if (!(d0 > 1e-6)) return start;
  const k = clampScale(start, d1 / d0);
  return roundImage({ ...start, w: start.w * k, h: start.h * k });
}

/**
 * 拖轉動把手：貼圖跟著手指繞中心轉；snap（按住 Shift）→ 轉到每 15° 一格
 */
export function rotateSticker(start: AnnImage, startPtr: Pt, ptr: Pt, W: number, H: number, snap = false): AnnImage {
  const { cx, cy } = stickerPx(start, W, H);
  if (Math.hypot(ptr[0] - cx, ptr[1] - cy) < 1e-6 || Math.hypot(startPtr[0] - cx, startPtr[1] - cy) < 1e-6) return start;
  const a0 = Math.atan2(startPtr[1] - cy, startPtr[0] - cx);
  const a1 = Math.atan2(ptr[1] - cy, ptr[0] - cx);
  let r = start.rot + deg(a1 - a0);
  if (snap) r = Math.round(r / STICKER_SNAP_DEG) * STICKER_SNAP_DEG;
  return roundImage({ ...start, rot: normalizeRot(r) });
}

/**
 * 兩根手指：捏開 / 捏起 = 縮放、兩指連線轉 = 旋轉、兩指中點移動 = 平移
 * @param startPts 剛放上兩根手指時的位置、nowPts 現在的位置（像素）
 */
export function pinchSticker(start: AnnImage, startPts: readonly [Pt, Pt], nowPts: readonly [Pt, Pt], W: number, H: number): AnnImage {
  const [a0, b0] = startPts, [a1, b1] = nowPts;
  const d0 = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]);
  const d1 = Math.hypot(b1[0] - a1[0], b1[1] - a1[1]);
  if (!(d0 > 1e-6) || !(W > 0) || !(H > 0)) return start;
  const k = clampScale(start, d1 / d0);
  const turn = deg(Math.atan2(b1[1] - a1[1], b1[0] - a1[0]) - Math.atan2(b0[1] - a0[1], b0[0] - a0[0]));
  const mdx = (a1[0] + b1[0]) / 2 - (a0[0] + b0[0]) / 2;
  const mdy = (a1[1] + b1[1]) / 2 - (a0[1] + b0[1]) / 2;
  return roundImage({
    ...start,
    x: clamp(start.x + mdx / W, 0, 1), y: clamp(start.y + mdy / H, 0, 1),
    w: start.w * k, h: start.h * k, rot: normalizeRot(start.rot + turn),
  });
}

/** 改不透明度（0.05~1） */
export function setStickerOpacity(el: AnnImage, opacity: number): AnnImage {
  return roundImage({ ...el, opacity });
}

/** 貼圖用的 CSS：放在 W × H 的那塊上（左上角、寬高、轉動） */
export function stickerCss(el: AnnImage, W: number, H: number): { left: number; top: number; width: number; height: number; transform: string } {
  const { cx, cy, w, h } = stickerPx(el, W, H);
  return { left: cx - w / 2, top: cy - h / 2, width: w, height: h, transform: `rotate(${el.rot}deg)` };
}

/** 最小的 2D 畫布介面（縮圖合成用；測試可以給假的） */
export interface StickerCanvasLike {
  save(): void; restore(): void;
  translate(x: number, y: number): void; rotate(angle: number): void;
  drawImage(img: CanvasImageSource, x: number, y: number, w: number, h: number): void;
  globalAlpha: number;
}

/**
 * 把貼圖畫到 2D 畫布上（W × H = 整張畫，跟畫記當時的 3D 畫面一樣比例）；還沒載好的圖片略過。
 * @returns 畫了幾張
 */
export function drawStickers(
  ctx: StickerCanvasLike, images: readonly AnnImage[] | undefined, getImage: (attachmentId: string) => CanvasImageSource | null, W: number, H: number,
): number {
  let n = 0;
  for (const el of images || []) {
    const img = getImage(el.attachmentId);
    if (!img) continue;
    const { cx, cy, w, h } = stickerPx(el, W, H);
    ctx.save();
    ctx.globalAlpha = el.opacity;
    ctx.translate(cx, cy);
    ctx.rotate(rad(el.rot));
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
    n++;
  }
  return n;
}
