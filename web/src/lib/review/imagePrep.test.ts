import { describe, expect, it } from 'vitest';
import { attachmentRoom, pastePlan, planImagePrep, prepTargetSize } from './imagePrep';
import { fitWithin, sniffImage } from './attachmentRules';

const MB = 1024 * 1024;

describe('參考圖片傳上去之前怎麼處理', () => {
  it('JPEG / PNG / WebP 一律重新存（拿掉 EXIF / GPS）；PNG、WebP 會存 WebP 的瀏覽器存 WebP，不會的存 PNG', () => {
    expect(planImagePrep({ type: 'image/jpeg', size: 3 * MB, width: 4032, height: 3024 })).toEqual({ action: 'reencode', output: 'image/jpeg' });
    expect(planImagePrep({ type: 'image/jpeg', size: 80_000, width: 640, height: 480 })).toEqual({ action: 'reencode', output: 'image/jpeg' });
    expect(planImagePrep({ type: 'image/png', size: 2 * MB, width: 1920, height: 1080 }, { webpEncode: true })).toEqual({ action: 'reencode', output: 'image/webp' });
    expect(planImagePrep({ type: 'image/png', size: 2 * MB, width: 1920, height: 1080 }, { webpEncode: false })).toEqual({ action: 'reencode', output: 'image/png' });
    expect(planImagePrep({ type: 'image/webp', size: MB, width: 1000, height: 800 }, { webpEncode: false })).toEqual({ action: 'reencode', output: 'image/png' });
  });

  it('GIF 原樣傳（會動的）；太大張的不收', () => {
    expect(planImagePrep({ type: 'image/gif', size: 12 * MB, width: 800, height: 450 })).toEqual({ action: 'keep', type: 'image/gif' });
    expect(planImagePrep({ type: 'image/gif', size: MB, width: 9000, height: 100 }).action).toBe('reject');
  });

  it('不收的：HEIC、SVG、超過 15 MB、讀不到尺寸、大到瀏覽器會當掉', () => {
    const r = (x: Parameters<typeof planImagePrep>[0]) => planImagePrep(x);
    expect(r({ type: 'image/heic', size: MB, width: 100, height: 100 })).toMatchObject({ action: 'reject', reason: expect.stringContaining('HEIC') });
    expect(r({ type: 'image/svg+xml', size: 1000, width: 100, height: 100 })).toMatchObject({ action: 'reject', reason: expect.stringContaining('PNG、JPEG、WebP、GIF') });
    expect(r({ type: 'image/png', size: 15 * MB + 1, width: 100, height: 100 })).toMatchObject({ action: 'reject', reason: expect.stringContaining('15 MB') });
    expect(r({ type: 'image/jpeg', size: MB, width: 0, height: 0 }).action).toBe('reject');
    expect(r({ type: 'image/png', size: 10 * MB, width: 20000, height: 20000 })).toMatchObject({ action: 'reject', reason: expect.stringContaining('20000×20000') });
  });

  it('縮到長邊 2560（直的、橫的都一樣）；比較小的不放大', () => {
    expect(prepTargetSize(8800, 2024)).toEqual({ width: 2560, height: 589 });
    expect(prepTargetSize(3024, 4032)).toEqual({ width: 1920, height: 2560 });
    expect(prepTargetSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(fitWithin(4000, 3000, 480)).toEqual({ width: 480, height: 360 });
  });

  it('看檔頭判斷類型（副檔名 / 瀏覽器說的不算）', () => {
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 1280);
    new DataView(png.buffer).setUint32(20, 720);
    expect(sniffImage(png)).toEqual({ type: 'image/png', width: 1280, height: 720 });
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });
});

describe('貼上（Ctrl+V）', () => {
  it('截圖、「複製圖片」（HTML 只有 <img>）、檔案總管複製的檔案 → 圖片', () => {
    expect(pastePlan(1, '')).toBe('images');
    expect(pastePlan(1, '<meta charset="utf-8"><img src="https://a.com/x.png">')).toBe('images');
  });
  it('沒有圖片、或 Excel / Word / 網頁選一段（HTML 裡有字）→ 照一般貼上文字', () => {
    expect(pastePlan(0, '')).toBe('text');
    expect(pastePlan(1, '<table><tr><td>第 3 個 cue</td></tr></table>')).toBe('text');
    expect(pastePlan(1, '<style>td{}</style><p>&nbsp;舞台</p>')).toBe('text');
  });
  it('張數：超過上限的不加', () => {
    expect(attachmentRoom(0, 3, 4)).toEqual({ take: 3, dropped: 0 });
    expect(attachmentRoom(3, 3, 4)).toEqual({ take: 1, dropped: 2 });
    expect(attachmentRoom(2, 1, 2)).toEqual({ take: 0, dropped: 1 });
  });
});
