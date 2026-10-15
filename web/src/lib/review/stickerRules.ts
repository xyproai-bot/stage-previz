// 貼圖（貼在 3D 畫面上的參考圖片）的格式和整理規則：前端（畫、讀）和後台（cf-worker/comments.mjs 直接 import 這個 .ts）共用。
//
// 這個檔案前後台共用，所以只能放「純判斷」：不 import 別的檔案、不碰 DOM / React、不用 enum / namespace 這類要編譯的寫法。
//
// 貼圖存在畫記（annotation）裡，跟畫的筆、箭頭、方框、圓圈同一層：
//   annotation = { v: 1, aspect, t?, shapes: [...], images?: [貼圖…] }
// 一張貼圖：
//   { type: 'image', attachmentId, x, y, w, h, rot, opacity }
//   attachmentId  這則留言自己的參考圖片（ca_… 開頭，後台說了算）
//   x, y          圖片「中心」在畫面上的位置，0~1（x 往右、y 往下，相對畫記當時的 3D 畫面，跟筆畫一樣）
//   w, h          圖片的寬 / 高，各自是「畫面寬 / 畫面高」的比例（所以圖片的比例 = w × aspect / h）
//   rot           轉幾度（順時針，繞中心，-180~180）
//   opacity       不透明度 0.05~1（半透明才看得到底下的舞台）
// 舊版前端（只認 shapes）看到 images 會直接略過，不會壞。

export interface AnnImage {
  type: 'image';
  attachmentId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  opacity: number;
}

/** 一則留言最多幾張貼圖（= 團隊一則留言的圖片上限；訪客一則最多 2 張，由附件數量擋） */
export const MAX_ANN_IMAGES = 4;
/** 貼圖的寬 / 高最小、最大（畫面寬 / 高的比例） */
export const STICKER_MIN_SIZE = 0.02;
export const STICKER_MAX_SIZE = 2;
export const STICKER_MIN_OPACITY = 0.05;
/** 跟 attachmentRules.ts 的 ATTACHMENT_ID_RE 一樣（單元測試會對一下；這個檔案不能 import 別的檔案） */
export const STICKER_ID_RE = /^ca_[a-z0-9]{8,40}$/;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round = (n: number, d: number) => { const k = 10 ** d; return Math.round(n * k) / k; };

/** 角度整理成 (-180, 180] */
export function normalizeRot(deg: number): number {
  if (!isNum(deg)) return 0;
  let r = deg % 360;
  if (r > 180) r -= 360;
  else if (r <= -180) r += 360;
  return r;
}

/** 數字夾進範圍、四捨五入（座標 4 位、角度 2 位、不透明度 3 位） */
export function roundImage(el: AnnImage): AnnImage {
  return {
    type: 'image',
    attachmentId: el.attachmentId,
    x: round(clamp(el.x, 0, 1), 4),
    y: round(clamp(el.y, 0, 1), 4),
    w: round(clamp(el.w, STICKER_MIN_SIZE, STICKER_MAX_SIZE), 4),
    h: round(clamp(el.h, STICKER_MIN_SIZE, STICKER_MAX_SIZE), 4),
    rot: round(normalizeRot(el.rot), 2),
    opacity: round(clamp(el.opacity, STICKER_MIN_OPACITY, 1), 3),
  };
}

/**
 * 一張貼圖整理好；格式不對（不是圖片貼圖、id 不對、少了數字）→ null。
 * 數字太大 / 太小不擋，夾回範圍（手滑拉太大不該讓整則留言送不出去）。
 */
export function sanitizeImageElement(raw: unknown): AnnImage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (e.type !== 'image') return null;
  if (typeof e.attachmentId !== 'string' || !STICKER_ID_RE.test(e.attachmentId)) return null;
  if (!isNum(e.x) || !isNum(e.y) || !isNum(e.w) || !isNum(e.h) || !isNum(e.rot) || !isNum(e.opacity)) return null;
  return roundImage({ type: 'image', attachmentId: e.attachmentId, x: e.x, y: e.y, w: e.w, h: e.h, rot: e.rot, opacity: e.opacity });
}

/**
 * 一整串貼圖整理好：每張都要合格、同一張圖片只能貼一次、不超過上限。
 * @returns ok:true + 整理好的；不合格 → error 是說給使用者聽的話
 */
export function sanitizeImageList(raw: unknown): { ok: true; images: AnnImage[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return { ok: false, error: '貼圖的格式不對，請重新放一次' };
  if (raw.length > MAX_ANN_IMAGES) return { ok: false, error: `貼圖太多了（最多 ${MAX_ANN_IMAGES} 張）` };
  const seen = new Set<string>();
  const images: AnnImage[] = [];
  for (const el of raw) {
    const img = sanitizeImageElement(el);
    if (!img || seen.has(img.attachmentId)) return { ok: false, error: '貼圖的格式不對，請重新放一次' };
    seen.add(img.attachmentId);
    images.push(img);
  }
  return { ok: true, images };
}

/** 貼圖只能用這則留言自己的圖片：每張貼圖的 attachmentId 都要在 attachmentIds 裡 */
export function checkImagesBelong(images: readonly AnnImage[] | null | undefined, attachmentIds: readonly string[]): { ok: true } | { ok: false; error: string } {
  if (!images || !images.length) return { ok: true };
  const mine = new Set(attachmentIds);
  for (const img of images) {
    if (!mine.has(img.attachmentId)) return { ok: false, error: '貼圖用的圖片要是這則留言附的圖片' };
  }
  return { ok: true };
}
