// 留言框的參考圖片 ↔ 3D 畫面上的貼圖（導演頁、動畫師工作站、分享連結的留言框共用）：
//   - 把圖片檔拖進 3D 畫面：交給留言框上傳（跟貼上、選檔案一樣的流程），傳好就自動貼到畫面上
//   - 留言框裡的圖片縮圖按「放到畫面上」：馬上貼上去（用本機的原圖，不用等網路）
//   - 圖片從留言框拿掉 → 畫面上那張貼圖也一起拿掉（貼圖只能用這則留言自己的圖片）
//   - 貼圖拿掉（刪除）→ 圖片還在留言框裡，要另外拿掉
// 規則（誰貼得上、算法）在 stickerRules.ts、stickers.ts；這裡只有接線，planStickerSync 是純函式（有測）。

import { useEffect, useRef } from 'react';
import { attachmentSrc } from '../api';
import type { StickerDraft, StickerSource } from './useReviewSession';
import type { AttachmentDraft, DraftItem } from './useAttachmentDraft';

/** 這一張圖片貼在畫面上要用的圖和大小；還沒傳好 = null */
export function stickerSourceOf(it: DraftItem): (StickerSource & { id: string }) | null {
  const a = it.attachment;
  if (it.status !== 'done' || !a) return null;
  const src = it.full || it.preview || attachmentSrc(a.url);
  if (!src) return null;
  return { id: a.id, src, width: a.width ?? 0, height: a.height ?? 0 };
}

/**
 * 留言框的圖片變了 → 要貼上去哪幾張、要從畫面上拿掉哪幾張
 * @param placed 已經自動貼過一次的（貼過又被刪掉的不會再自己貼回來）
 * @param onView 現在畫面上貼著的（attachmentId）
 */
export function planStickerSync(
  items: readonly DraftItem[], placed: ReadonlySet<string>, onView: readonly string[],
): { place: DraftItem[]; remove: string[] } {
  const ready = new Set(items.filter(it => it.status === 'done' && it.attachment).map(it => it.attachment!.id));
  return {
    place: items.filter(it => it.sticker && it.status === 'done' && it.attachment && !placed.has(it.attachment.id)),
    remove: onView.filter(id => !ready.has(id)),
  };
}

export function useStickerBridge(stickers: StickerDraft, draft: AttachmentDraft): void {
  const dRef = useRef(draft);
  dRef.current = draft;
  const sRef = useRef(stickers);
  sRef.current = stickers;
  const placed = useRef(new Set<string>());
  const enabled = draft.enabled;

  useEffect(() => {
    if (!enabled) return;
    sRef.current.register({ addFiles: (files) => dRef.current.addFiles(files, { sticker: true }) });
    return () => sRef.current.register(null);
  }, [enabled]);

  useEffect(() => {
    if (!draft.items.length) placed.current.clear();
    const plan = planStickerSync(draft.items, placed.current, sRef.current.items.map(i => i.attachmentId));
    for (const it of plan.place) {
      placed.current.add(it.attachment!.id);
      const src = stickerSourceOf(it);
      if (src) sRef.current.place(src);
    }
    for (const id of plan.remove) sRef.current.remove(id);
  }, [draft.items]);
}
