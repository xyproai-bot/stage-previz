// 留言框裡還沒送出的參考圖片（新留言、回覆、改留言共用）：
//   加進來 → 縮小 / 重新存（imagePrepBrowser）→ 馬上上傳（看得到 %）→ 送出留言時帶 ids
//   拿掉 / 取消 / 換歌：還沒送出的跟後台說拿掉（失敗也沒關係，後台一天後自己清）
//   改留言：reset(原本的圖片) → 原本的標成 existing（拿掉時不刪檔，按「儲存」才由後台刪）

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommentAttachment } from '../api';
import { attachmentSrc } from '../api';
import { toast } from '../toast';
import type { AttachmentUploader, UploadError } from './attachmentsApi';
import { attachmentRoom } from './imagePrep';
import { ImagePrepError, prepareImage, type PreparedImage } from './imagePrepBrowser';

export interface DraftItem {
  key: string;
  status: 'preparing' | 'uploading' | 'done' | 'error';
  /** 0~1 */
  progress: number;
  /** 預覽（本機的 blob 網址，或已經在留言裡的縮圖） */
  preview: string | null;
  attachment?: CommentAttachment;
  /** 本來就在留言裡（改留言） */
  existing?: boolean;
  error?: string;
}

export interface AttachmentDraft {
  items: DraftItem[];
  /** 傳好的（照順序；含原本就有的） */
  ids: string[];
  /** 還在處理 / 上傳 */
  busy: boolean;
  /** 有傳失敗的 */
  failed: boolean;
  max: number;
  /** 有沒有可以用的上傳（沒有 = 不顯示加圖片） */
  enabled: boolean;
  addFiles: (files: File[] | FileList) => void;
  remove: (key: string) => void;
  retry: (key: string) => void;
  /** 送出成功 → clear(false)；取消 → clear(true)（拿掉還沒送出的） */
  clear: (discardPending: boolean) => void;
  /** 改留言：換成原本的圖片 */
  reset: (existing: CommentAttachment[]) => void;
}

let seq = 0;

export function useAttachmentDraft(uploader: AttachmentUploader | null, resetKey: unknown): AttachmentDraft {
  const [items, setItems] = useState<DraftItem[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const countRef = useRef(0);
  const prepared = useRef(new Map<string, PreparedImage>());
  const aborts = useRef(new Map<string, AbortController>());
  const blobUrls = useRef(new Map<string, string>());
  const upRef = useRef(uploader);
  upRef.current = uploader;

  const patch = useCallback((key: string, p: Partial<DraftItem>) => {
    setItems(list => list.map(it => (it.key === key ? { ...it, ...p } : it)));
  }, []);

  const gone = useRef(new Set<string>());
  const forget = useCallback((key: string) => {
    gone.current.add(key);
    aborts.current.get(key)?.abort();
    aborts.current.delete(key);
    prepared.current.delete(key);
    const u = blobUrls.current.get(key);
    if (u) URL.revokeObjectURL(u);
    blobUrls.current.delete(key);
  }, []);

  const upload = useCallback(async (key: string) => {
    const up = upRef.current;
    const img = prepared.current.get(key);
    if (!up || !img) return;
    const ac = new AbortController();
    aborts.current.set(key, ac);
    patch(key, { status: 'uploading', progress: 0, error: undefined });
    try {
      const a = await up.upload(img, (f) => patch(key, { progress: f }), ac.signal);
      if (ac.signal.aborted) { void up.discard(a.id); return; }
      patch(key, { status: 'done', progress: 1, attachment: a });
    } catch (e) {
      const err = e as UploadError;
      if (err.aborted) return;
      patch(key, { status: 'error', error: err.message || '圖片沒傳上去' });
      toast.error(err.message || '圖片沒傳上去');
    } finally {
      if (aborts.current.get(key) === ac) aborts.current.delete(key);
    }
  }, [patch]);

  const addFiles = useCallback((list: File[] | FileList) => {
    const up = upRef.current;
    if (!up) return;
    const files = Array.from(list);
    if (!files.length) return;
    const { take, dropped } = attachmentRoom(countRef.current, files.length, up.max);
    if (dropped) toast.warn(`一則留言最多 ${up.max} 張圖片${take ? `，多的 ${dropped} 張沒有加` : ''}`);
    for (const file of files.slice(0, take)) {
      const key = `d${++seq}`;
      countRef.current++;
      setItems(l => [...l, { key, status: 'preparing', progress: 0, preview: null }]);
      void (async () => {
        try {
          const img = await prepareImage(file);
          if (gone.current.has(key)) return;   // 處理到一半被拿掉了
          prepared.current.set(key, img);
          const url = URL.createObjectURL(img.thumb ?? img.blob);
          blobUrls.current.set(key, url);
          patch(key, { preview: url });
          await upload(key);
        } catch (e) {
          if (gone.current.has(key)) return;
          countRef.current = Math.max(0, countRef.current - 1);
          setItems(l => l.filter(it => it.key !== key));
          forget(key);
          toast.warn(e instanceof ImagePrepError ? e.message : '這張圖片打不開，請換一張或存成 JPEG / PNG 再放');
        }
      })();
    }
  }, [patch, upload, forget]);

  const remove = useCallback((key: string) => {
    const it = itemsRef.current.find(x => x.key === key);
    if (!it) return;
    countRef.current = Math.max(0, countRef.current - 1);
    forget(key);
    if (it.status === 'done' && it.attachment && !it.existing) void upRef.current?.discard(it.attachment.id);
    setItems(l => l.filter(x => x.key !== key));
  }, [forget]);

  const retry = useCallback((key: string) => { void upload(key); }, [upload]);

  const clear = useCallback((discardPending: boolean) => {
    for (const it of itemsRef.current) {
      forget(it.key);
      if (discardPending && it.status === 'done' && it.attachment && !it.existing) void upRef.current?.discard(it.attachment.id);
    }
    countRef.current = 0;
    setItems([]);
  }, [forget]);

  const reset = useCallback((existing: CommentAttachment[]) => {
    clear(true);
    const next = existing.map(a => ({
      key: `d${++seq}`, status: 'done' as const, progress: 1, preview: attachmentSrc(a.thumbUrl || a.url), attachment: a, existing: true,
    }));
    countRef.current = next.length;
    setItems(next);
  }, [clear]);

  // 換歌 / 換一則回覆：還沒送出的拿掉
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) { firstRef.current = false; return; }
    clear(true);
  }, [resetKey]);  // eslint-disable-line react-hooks/exhaustive-deps
  // 離開頁面：還沒送出的拿掉
  useEffect(() => () => clear(true), [clear]);

  return {
    items,
    ids: items.filter(it => it.status === 'done' && it.attachment).map(it => it.attachment!.id),
    busy: items.some(it => it.status === 'preparing' || it.status === 'uploading'),
    failed: items.some(it => it.status === 'error'),
    max: uploader?.max ?? 0,
    enabled: !!uploader,
    addFiles, remove, retry, clear, reset,
  };
}

/** 送出前的檢查：還在傳 / 有傳失敗的 → 說一聲、不送 */
export function draftBlocksSend(d: AttachmentDraft): boolean {
  if (d.busy) { toast.info('圖片還在上傳，等一下再送出'); return true; }
  if (d.failed) { toast.warn('有圖片沒傳上去：按那張圖片重試，或拿掉再送出'); return true; }
  return false;
}
