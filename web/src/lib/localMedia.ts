// 本地檔案清單（分享頁拖進來的影片 / 圖片）：只在這台電腦放到 LED 上，不上傳。
//   mediaKindOf / splitMediaFiles / skippedFilesMessage — 看檔案是影片、圖片，還是不能用
//   addMediaItems / removeMediaItem / selectMediaItem — 清單操作（純函式，回傳新的清單）
//   useLocalMedia — 管清單 + 影片播放器（useLocalVideo）+ 正在放的圖片

import { useCallback, useEffect, useRef, useState } from 'react';
import { isVideoFile, useLocalVideo, type LocalVideoState } from './localVideo';

export type LocalMediaKind = 'video' | 'image';

// 瀏覽器一定打得開的圖片（TIFF / PSD / HEIC / EXR 打不開 → 不收）
const IMAGE_MIME = /^image\/(png|jpeg|webp|gif|bmp|avif)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;

export function mediaKindOf(file: { name: string; type: string }): LocalMediaKind | null {
  if (file.type) {
    if (file.type.startsWith('video/')) return 'video';
    return IMAGE_MIME.test(file.type) ? 'image' : null;
  }
  if (isVideoFile(file)) return 'video';
  return IMAGE_EXT.test(file.name) ? 'image' : null;
}

/** 分成能用的（影片 / 圖片）和不能用的（只留檔名，給提示用） */
export function splitMediaFiles<F extends { name: string; type: string }>(files: Iterable<F>) {
  const accepted: { file: F; kind: LocalMediaKind }[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    const kind = mediaKindOf(file);
    if (kind) accepted.push({ file, kind });
    else rejected.push(file.name);
  }
  return { accepted, rejected };
}

/** 略過的檔案 → 一句提示；沒有略過就 null */
export function skippedFilesMessage(names: string[]): string | null {
  if (names.length === 0) return null;
  const shown = names.slice(0, 3).join('、') + (names.length > 3 ? ` 等 ${names.length} 個` : '');
  return `略過 ${shown}：只能放影片或圖片（PNG / JPG / WebP）`;
}

/** 同一個檔案（名稱 + 大小 + 修改時間一樣）拖兩次不重複加 */
export function mediaFileKey(file: { name: string; size: number; lastModified: number }): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export interface LocalMediaItem {
  id: string;
  key: string;
  name: string;
  kind: LocalMediaKind;
  file: File;
  /** 圖片才有（縮圖 + LED 用）；影片的網址由 useLocalVideo 自己管 */
  url: string | null;
}

export interface LocalMediaList {
  items: LocalMediaItem[];
  activeId: string | null;
}

export const EMPTY_MEDIA_LIST: LocalMediaList = { items: [], activeId: null };

/**
 * 加進清單（排在後面）。已經在清單裡的同一個檔案不再加。
 * 第一個拖進來的檔案（新加的，或清單裡原本那個）變成正在放的。
 * added = 真的加進去的（沒加的那些，呼叫的人要自己收掉網址）
 */
export function addMediaItems(list: LocalMediaList, incoming: LocalMediaItem[]): { list: LocalMediaList; added: LocalMediaItem[] } {
  if (incoming.length === 0) return { list, added: [] };
  const items = [...list.items];
  const added: LocalMediaItem[] = [];
  let firstId: string | null = null;
  for (const it of incoming) {
    const existing = items.find(x => x.key === it.key);
    if (existing) {
      firstId ??= existing.id;
      continue;
    }
    items.push(it);
    added.push(it);
    firstId ??= it.id;
  }
  return { list: { items, activeId: firstId ?? list.activeId }, added };
}

/** 從清單拿掉；拿掉的是正在放的 → 變成沒有在放（不自動換下一個） */
export function removeMediaItem(list: LocalMediaList, id: string): { list: LocalMediaList; removed: LocalMediaItem | null } {
  const removed = list.items.find(x => x.id === id) ?? null;
  if (!removed) return { list, removed: null };
  return {
    list: { items: list.items.filter(x => x.id !== id), activeId: list.activeId === id ? null : list.activeId },
    removed,
  };
}

/** 點清單裡的檔案 → 變成正在放的（不在清單 / 本來就在放 → 原樣） */
export function selectMediaItem(list: LocalMediaList, id: string): LocalMediaList {
  if (list.activeId === id || !list.items.some(x => x.id === id)) return list;
  return { ...list, activeId: id };
}

export function activeMediaItem(list: LocalMediaList): LocalMediaItem | null {
  return list.items.find(x => x.id === list.activeId) ?? null;
}

export interface LocalMediaState {
  items: LocalMediaItem[];
  active: LocalMediaItem | null;
  /** 影片播放器（正在放的是影片時才用它的畫面） */
  player: LocalVideoState;
  /** 正在放的圖片（已經解碼好，可以直接當 LED 貼圖）；還在讀 / 不是圖片 → null */
  image: HTMLImageElement | null;
  imageError: string | null;
  /** 加檔案：回傳略過的檔名、有沒有東西可以放 */
  add: (files: File[]) => { rejected: string[]; shown: boolean };
  select: (id: string) => void;
  remove: (id: string) => void;
}

export function useLocalMedia(): LocalMediaState {
  const player = useLocalVideo();
  const { video, load: loadVideo, clear: clearVideo } = player;
  const [list, setList] = useState<LocalMediaList>(EMPTY_MEDIA_LIST);
  const listRef = useRef(list);
  const seqRef = useRef(0);
  // 播放器裡現在載著哪一支（切去圖片時影片只暫停、不卸掉，切回來接著播）
  const loadedVideoIdRef = useRef<string | null>(null);

  const commit = useCallback((next: LocalMediaList) => {
    listRef.current = next;
    setList(next);
  }, []);

  // 換成正在放的檔案：影片 → 載入（新的從頭播、同一支接著播）；圖片 / 沒有 → 影片暫停
  const show = useCallback((item: LocalMediaItem | null) => {
    if (!item || item.kind !== 'video') { video.pause(); return; }
    if (loadedVideoIdRef.current !== item.id) {
      loadedVideoIdRef.current = item.id;
      loadVideo(item.file);
    } else {
      video.play().catch(() => { /* 自動播放被擋就等使用者按播放 */ });
    }
  }, [video, loadVideo]);

  const add = useCallback((files: File[]) => {
    const { accepted, rejected } = splitMediaFiles(files);
    const incoming: LocalMediaItem[] = accepted.map(({ file, kind }) => ({
      id: `m${++seqRef.current}`,
      key: mediaFileKey(file),
      name: file.name,
      kind,
      file,
      url: kind === 'image' ? URL.createObjectURL(file) : null,
    }));
    const prev = listRef.current;
    const { list: next, added } = addMediaItems(prev, incoming);
    for (const it of incoming) if (it.url && !added.includes(it)) URL.revokeObjectURL(it.url);
    commit(next);
    if (next.activeId !== prev.activeId) show(activeMediaItem(next));
    return { rejected, shown: incoming.length > 0 };
  }, [commit, show]);

  const select = useCallback((id: string) => {
    const prev = listRef.current;
    const next = selectMediaItem(prev, id);
    if (next === prev) return;
    commit(next);
    show(activeMediaItem(next));
  }, [commit, show]);

  const remove = useCallback((id: string) => {
    const { list: next, removed } = removeMediaItem(listRef.current, id);
    if (!removed) return;
    commit(next);
    if (removed.url) URL.revokeObjectURL(removed.url);
    if (loadedVideoIdRef.current === removed.id) {
      loadedVideoIdRef.current = null;
      clearVideo();
    }
  }, [commit, clearVideo]);

  // 離開頁面 → 收掉所有圖片網址（影片的由 useLocalVideo 收）
  useEffect(() => () => {
    for (const it of listRef.current.items) if (it.url) URL.revokeObjectURL(it.url);
  }, []);

  // 正在放的圖片先解碼好再交給 LED（換圖時舊的留著，新的好了才換上）
  const active = activeMediaItem(list);
  const activeImageUrl = active?.kind === 'image' ? active.url : null;
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  useEffect(() => {
    setImageError(null);
    if (!activeImageUrl) { setImage(null); return; }
    let cancelled = false;
    const img = new Image();
    img.src = activeImageUrl;
    img.decode().then(() => {
      if (cancelled) return;
      if (!img.naturalWidth) throw new Error('empty image');
      setImage(img);
    }).catch(() => {
      if (cancelled) return;
      setImage(null);
      setImageError('瀏覽器打不開這張圖片，請轉成 PNG 或 JPG 再試');
    });
    return () => { cancelled = true; };
  }, [activeImageUrl]);

  return { items: list.items, active, player, image, imageError, add, select, remove };
}
