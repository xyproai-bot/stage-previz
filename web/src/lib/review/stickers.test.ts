import { describe, expect, it } from 'vitest';
import {
  MAX_ANN_IMAGES, STICKER_ID_RE, checkImagesBelong, normalizeRot, sanitizeImageElement, sanitizeImageList, type AnnImage,
} from './stickerRules';
import { ATTACHMENT_ID_RE } from './attachmentRules';
import {
  STICKER_DEFAULT_OPACITY, drawStickers, hitSticker, moveSticker, newSticker, pickSticker, pinchSticker, rotateSticker, scaleSticker,
  setStickerOpacity, stickerCorners, stickerCss, stickerPixelAspect, toStickerLocal,
} from './stickers';
import { annotationSummary, parseAnnotation, serializeAnnotation } from './annotations';
import { planStickerSync, stickerSourceOf } from './useStickerBridge';
import type { DraftItem } from './useAttachmentDraft';

const A = 'ca_aaaaaaaa11112222';
const B = 'ca_bbbbbbbb33334444';
const el = (extra: Partial<AnnImage> = {}): AnnImage => ({ type: 'image', attachmentId: A, x: 0.5, y: 0.5, w: 0.2, h: 0.3, rot: 0, opacity: 0.8, ...extra });
const W = 1000, H = 500;

describe('貼圖的格式規則（前後台共用）', () => {
  it('id 規則跟附件的一樣', () => {
    expect(STICKER_ID_RE.source).toBe(ATTACHMENT_ID_RE.source);
  });

  it('整理：數字夾進範圍、四捨五入；格式不對 → null', () => {
    expect(sanitizeImageElement(el())).toEqual(el());
    expect(sanitizeImageElement(el({ x: -2, y: 7, w: 0.0001, h: 9, rot: 270, opacity: 0 }))).toEqual(el({ x: 0, y: 1, w: 0.02, h: 2, rot: -90, opacity: 0.05 }));
    expect(sanitizeImageElement(el({ x: 0.123456 }))?.x).toBe(0.1235);
    for (const bad of [null, 'x', [], { ...el(), type: 'text' }, { ...el(), attachmentId: 'abc' }, { ...el(), x: '0.5' }, { ...el(), rot: NaN }, { ...el(), opacity: undefined }]) {
      expect(sanitizeImageElement(bad)).toBeNull();
    }
  });

  it('角度整理成 -180~180', () => {
    expect(normalizeRot(190)).toBe(-170);
    expect(normalizeRot(-190)).toBe(170);
    expect(normalizeRot(180)).toBe(180);
    expect(normalizeRot(-180)).toBe(180);
    expect(normalizeRot(720)).toBe(0);
    expect(normalizeRot(NaN)).toBe(0);
  });

  it('一整串：同一張只能貼一次、不超過上限、可以沒有', () => {
    expect(sanitizeImageList(undefined)).toEqual({ ok: true, images: [] });
    expect(sanitizeImageList([el(), el({ attachmentId: B })])).toMatchObject({ ok: true });
    expect(sanitizeImageList([el(), el({ x: 0.1 })]).ok).toBe(false);
    expect(sanitizeImageList('x').ok).toBe(false);
    const many = Array.from({ length: MAX_ANN_IMAGES + 1 }, (_, i) => el({ attachmentId: `ca_${String(i).repeat(10)}` }));
    expect(sanitizeImageList(many).ok).toBe(false);
  });

  it('只能用這則留言自己的圖片', () => {
    expect(checkImagesBelong([el()], [A, B]).ok).toBe(true);
    expect(checkImagesBelong([el(), el({ attachmentId: B })], [A]).ok).toBe(false);
    expect(checkImagesBelong([], []).ok).toBe(true);
    expect(checkImagesBelong(undefined, []).ok).toBe(true);
  });
});

describe('存進畫記、讀出來', () => {
  it('只有貼圖也算有畫記；沒有貼圖的畫記格式跟以前一樣', () => {
    const only = serializeAnnotation([], 1.7778, null, [el()]);
    expect(only).toEqual({ v: 1, aspect: 1.7778, shapes: [], images: [el()] });
    expect(serializeAnnotation([], 1.5, null, [])).toBeNull();
    const pen = serializeAnnotation([{ t: 'arrow', c: '#ff3b30', w: 0.006, p: [0.1, 0.1, 0.5, 0.5] }], 1.5, 2);
    expect(pen).toEqual({ v: 1, aspect: 1.5, t: 2, shapes: [{ t: 'arrow', c: '#ff3b30', w: 0.006, p: [0.1, 0.1, 0.5, 0.5] }] });
    expect('images' in pen!).toBe(false);
  });

  it('送出前整理：壞的、重複的貼圖拿掉，最多 4 張', () => {
    const list = [el(), el({ x: 0.1 }), { ...el({ attachmentId: B }), rot: 'x' } as unknown as AnnImage, el({ attachmentId: 'ca_cccccccc55556666' })];
    expect(serializeAnnotation([], 1.5, null, list)?.images?.map(i => i.attachmentId)).toEqual([A, 'ca_cccccccc55556666']);
  });

  it('讀後台來的：看不懂的貼圖略過，不會整個壞掉；只剩看不懂的 → 沒有畫記', () => {
    const raw = { v: 1, aspect: 1.5, shapes: [], images: [el(), { type: 'video', attachmentId: B }, { nonsense: true }] };
    expect(parseAnnotation(raw)?.images).toEqual([el()]);
    expect(parseAnnotation({ v: 1, aspect: 1.5, shapes: [], images: [{ type: 'video' }] })).toBeNull();
    expect(parseAnnotation({ v: 1, aspect: 1.5, images: [el()] })?.shapes).toEqual([]);
    expect(parseAnnotation({ v: 1, aspect: 1.5, shapes: [] })).toBeNull();
    expect(parseAnnotation({ v: 1, aspect: 1.5, shapes: [], images: [el()], t: 4 })?.t).toBe(4);
  });

  it('小字', () => {
    expect(annotationSummary(serializeAnnotation([], 1.5, null, [el(), el({ attachmentId: B })]))).toBe('貼圖 2 張');
    expect(annotationSummary(serializeAnnotation([{ t: 'rect', c: '#ffffff', w: 0.006, p: [0, 0, 0.5, 0.5] }], 1.5, null, [el()]))).toBe('畫記 1 筆、貼圖 1 張');
  });
});

describe('新貼上去的貼圖', () => {
  it('保持圖片原本的比例，長邊佔畫面一半，放中間', () => {
    const wide = newSticker(A, 2000, 1000, 16 / 9);          // 2:1 的圖，在 16:9 的畫面
    expect(wide.w).toBe(0.5);
    expect(stickerPixelAspect(wide, 16 / 9)).toBeCloseTo(2, 2);
    expect(wide.opacity).toBe(STICKER_DEFAULT_OPACITY);
    expect([wide.x, wide.y, wide.rot]).toEqual([0.5, 0.5, 0]);
    const tall = newSticker(A, 1000, 3000, 16 / 9);          // 很長的直圖：高度頂到一半，寬度跟著變窄
    expect(tall.h).toBe(0.5);
    expect(stickerPixelAspect(tall, 16 / 9)).toBeCloseTo(1 / 3, 2);
    // 不知道圖片多大 → 3:2
    expect(stickerPixelAspect(newSticker(A, 0, 0, 16 / 9), 16 / 9)).toBeCloseTo(1.5, 2);
    // 已經貼了幾張就錯開一點
    expect(newSticker(A, 100, 100, 1.5, 2).x).toBeGreaterThan(newSticker(A, 100, 100, 1.5, 0).x);
  });
});

describe('點到哪一張、四個角', () => {
  it('沒轉的時候：框裡面算點到', () => {
    const e = el();                                           // 中心 (500, 250)、200 × 150 像素
    expect(hitSticker([500, 250], e, W, H)).toBe(true);
    expect(hitSticker([599, 324], e, W, H)).toBe(true);
    expect(hitSticker([601, 250], e, W, H)).toBe(false);
    expect(hitSticker([500, 326], e, W, H)).toBe(false);
  });

  it('轉 90 度：寬變高', () => {
    const e = el({ rot: 90 });
    expect(hitSticker([500, 340], e, W, H)).toBe(true);       // 本來的寬 200 → 轉完上下各 100
    expect(hitSticker([590, 250], e, W, H)).toBe(false);      // 本來的右邊 100 → 轉完左右只剩 75
    expect(hitSticker([570, 250], e, W, H)).toBe(true);
    const [lx, ly] = toStickerLocal([500, 350], e, W, H);
    expect(lx).toBeCloseTo(100, 6);
    expect(ly).toBeCloseTo(0, 6);
  });

  it('疊在一起：點到最上面那張', () => {
    const under = el({ attachmentId: A });
    const over = el({ attachmentId: B, w: 0.1, h: 0.1 });
    expect(pickSticker([500, 250], [under, over], W, H)?.attachmentId).toBe(B);
    expect(pickSticker([580, 250], [under, over], W, H)?.attachmentId).toBe(A);
    expect(pickSticker([10, 10], [under, over], W, H)).toBeNull();
  });

  it('四個角：左上、右上、右下、左下；轉 90 度順時針', () => {
    const c0 = stickerCorners(el(), W, H);
    expect(c0[0]).toEqual([400, 175]);
    expect(c0[2]).toEqual([600, 325]);
    const c1 = stickerCorners(el({ rot: 90 }), W, H);
    expect(c1[0][0]).toBeCloseTo(575, 6);                      // 左上角轉到右上
    expect(c1[0][1]).toBeCloseTo(150, 6);
  });
});

describe('移動、縮放、旋轉、捏合', () => {
  it('拖：照手指移動的像素換算成 0~1；中心不會被拖出畫面', () => {
    const m = moveSticker(el(), 100, -50, W, H);
    expect([m.x, m.y]).toEqual([0.6, 0.4]);
    expect(moveSticker(el(), 99999, -99999, W, H)).toMatchObject({ x: 1, y: 0 });
    expect(moveSticker(el(), 10, 10, 0, 0)).toEqual(el());
  });

  it('拖角落縮放：離中心遠一倍就放大一倍，比例不變', () => {
    const e = el();
    const corner: [number, number] = [600, 325];               // 右下角（離中心 125）
    const big = scaleSticker(e, corner, [700, 400], W, H);     // 離中心 250
    expect(big.w).toBeCloseTo(0.4, 4);
    expect(big.h).toBeCloseTo(0.6, 4);
    expect(stickerPixelAspect(big, W / H)).toBeCloseTo(stickerPixelAspect(e, W / H), 3);
    expect([big.x, big.y]).toEqual([0.5, 0.5]);               // 中心不動
    const small = scaleSticker(e, corner, [550, 287.5], W, H);
    expect(small.w).toBeCloseTo(0.1, 4);
    // 拉到極端：夾在最小最大之間
    expect(scaleSticker(e, corner, [500.01, 250], W, H).w).toBeGreaterThanOrEqual(0.02);
    const huge = scaleSticker(e, corner, [90000, 90000], W, H);
    expect(Math.max(huge.w, huge.h)).toBeLessThanOrEqual(2);
    expect(stickerPixelAspect(huge, W / H)).toBeCloseTo(stickerPixelAspect(e, W / H), 2);
    // 按在中心上（距離 0）→ 不動
    expect(scaleSticker(e, [500, 250], [600, 300], W, H)).toEqual(e);
  });

  it('轉動把手：手指繞中心轉多少，貼圖就轉多少；Shift 轉到每 15° 一格', () => {
    const e = el();
    const r = rotateSticker(e, [500, 150], [600, 250], W, H);  // 從正上方轉到正右方 = 順時針 90 度
    expect(r.rot).toBeCloseTo(90, 4);
    const r2 = rotateSticker(el({ rot: 30 }), [500, 150], [600, 250], W, H);
    expect(r2.rot).toBeCloseTo(120, 4);
    // 轉過頭會繞回 -180~180
    expect(rotateSticker(el({ rot: 170 }), [500, 150], [600, 250], W, H).rot).toBeCloseTo(-100, 4);
    // 吸附
    const near = rotateSticker(e, [500, 150], [600, 250 - 100 * Math.tan((7 * Math.PI) / 180) + 10], W, H);
    expect(rotateSticker(e, [500, 150], [596, 238], W, H, true).rot % 15).toBe(0);
    expect(near.rot % 15).not.toBe(0);
    expect(rotateSticker(e, [500, 150], [500, 250], W, H)).toEqual(e);  // 在中心上沒有方向
  });

  it('兩根手指：捏開放大、轉兩指連線就轉、中點移動就平移', () => {
    const e = el();
    const start: [[number, number], [number, number]] = [[400, 250], [600, 250]];
    const spread = pinchSticker(e, start, [[300, 250], [700, 250]], W, H);
    expect(spread.w).toBeCloseTo(0.4, 4);
    expect(spread.h).toBeCloseTo(0.6, 4);
    expect(spread.rot).toBe(0);
    const turned = pinchSticker(e, start, [[500, 150], [500, 350]], W, H);   // 水平 → 垂直 = 轉 90 度
    expect(turned.rot).toBeCloseTo(90, 4);
    expect(turned.w).toBeCloseTo(0.2, 4);
    const moved = pinchSticker(e, start, [[500, 300], [700, 300]], W, H);
    expect(moved.x).toBeCloseTo(0.6, 4);
    expect(moved.y).toBeCloseTo(0.6, 4);
    expect(pinchSticker(e, [[10, 10], [10, 10]], [[0, 0], [50, 50]], W, H)).toEqual(e);   // 兩指一開始疊在一起 → 不動
  });

  it('不透明度夾在 0.05~1', () => {
    expect(setStickerOpacity(el(), 0.4).opacity).toBe(0.4);
    expect(setStickerOpacity(el(), 0).opacity).toBe(0.05);
    expect(setStickerOpacity(el(), 5).opacity).toBe(1);
  });

  it('CSS：左上角、寬高（像素）、轉動', () => {
    expect(stickerCss(el({ rot: 30 }), W, H)).toEqual({ left: 400, top: 175, width: 200, height: 150, transform: 'rotate(30deg)' });
  });
});

describe('縮圖合成', () => {
  it('每張貼圖：移到中心、轉、半透明、畫上去；還沒載好的略過', () => {
    const calls: string[] = [];
    const ctx = {
      globalAlpha: 1,
      save: () => calls.push('save'), restore: () => calls.push('restore'),
      translate: (x: number, y: number) => calls.push(`translate ${x},${y}`),
      rotate: (a: number) => calls.push(`rotate ${a.toFixed(3)}`),
      drawImage: (_i: unknown, x: number, y: number, w: number, h: number) => calls.push(`draw ${x},${y},${w},${h} a=${ctx.globalAlpha}`),
    };
    const img = {} as CanvasImageSource;
    const n = drawStickers(ctx, [el({ rot: 90, opacity: 0.5 }), el({ attachmentId: B })], (id) => (id === A ? img : null), 480, 270);
    expect(n).toBe(1);
    expect(calls).toEqual(['save', 'translate 240,135', 'rotate 1.571', 'draw -48,-40.5,96,81 a=0.5', 'restore']);
    expect(drawStickers(ctx, undefined, () => img, 480, 270)).toBe(0);
  });
});

describe('留言框的圖片 ↔ 畫面上的貼圖', () => {
  const item = (id: string, extra: Partial<DraftItem> = {}): DraftItem => ({
    key: `k_${id}`, status: 'done', progress: 1, preview: `blob:thumb-${id}`, full: `blob:full-${id}`,
    attachment: { id, url: `/api/comment-attachments/p1/${id}.png`, type: 'image/png', size: 10, width: 800, height: 600 }, ...extra,
  });

  it('拖進 3D 畫面的（傳好了）自動貼上去；貼過一次的不會再自己貼回來；沒傳好的先不貼', () => {
    const items = [item(A, { sticker: true }), item(B, { sticker: true, status: 'uploading', attachment: undefined }), item('ca_cccccccc55556666')];
    expect(planStickerSync(items, new Set(), []).place.map(i => i.attachment!.id)).toEqual([A]);
    expect(planStickerSync(items, new Set([A]), [A]).place).toEqual([]);
  });

  it('圖片從留言框拿掉 → 畫面上那張貼圖也拿掉；還在的不動', () => {
    expect(planStickerSync([item(A)], new Set(), [A, B]).remove).toEqual([B]);
    expect(planStickerSync([], new Set(), [A]).remove).toEqual([A]);
    expect(planStickerSync([item(A, { status: 'uploading' })], new Set(), [A]).remove).toEqual([A]);
  });

  it('貼上去用的圖：原圖的本機網址最先，沒有就用預覽，再沒有就用後台的網址；沒傳好 = 不能貼', () => {
    expect(stickerSourceOf(item(A))).toMatchObject({ id: A, src: `blob:full-${A}`, width: 800, height: 600 });
    expect(stickerSourceOf(item(A, { full: null }))?.src).toBe(`blob:thumb-${A}`);
    expect(stickerSourceOf(item(A, { full: null, preview: null }))?.src).toContain('/api/comment-attachments/p1/');
    expect(stickerSourceOf(item(A, { status: 'uploading' }))).toBeNull();
    expect(stickerSourceOf(item(A, { status: 'error' }))).toBeNull();
  });
});
