// 本地檔案清單（分享頁拖進來的影片 / 圖片）：只在這台電腦放到 LED 上，不上傳。
//   mediaKindOf / splitMediaFiles / skippedFilesMessage — 看檔案是影片、圖片，還是不能用
//   addMediaItems / removeMediaItem / selectMediaItem / moveMediaItem / stepMediaItem / updateMediaItem
//     — 清單操作（純函式，回傳新的清單）
//   thumbnailTime / fitSize / makeMediaThumbnail — 清單縮圖（影片抓一格、圖片縮小；一次做一個）
//   useLocalMedia — 管清單 + 正在放的圖片；影片用頁面那一個播放器（useLocalVideo，跟歌曲影片版本共用同一個 <video>）

import { useCallback, useEffect, useRef, useState } from 'react';
import { isVideoFile, type LocalVideoState } from './localVideo';

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
  /** 圖片才有（LED 用）；影片的網址由 useLocalVideo 自己管 */
  url: string | null;
  /** 清單縮圖（小張 JPEG data URL）；還沒做好 / 做不出來 → null */
  thumb: string | null;
  /** 縮圖做完了沒（做不出來也算做完 → 顯示圖示） */
  thumbReady: boolean;
  /** 影片長度（秒）；圖片 / 還不知道 → null */
  duration: number | null;
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

/**
 * 拖曳排順序：把 id 移到「原本清單第 insertAt 個的前面」（insertAt = 清單長度 → 移到最後）。
 * 正在放的不變。不在清單 / 位置沒變 → 原樣。
 */
export function moveMediaItem(list: LocalMediaList, id: string, insertAt: number): LocalMediaList {
  const from = list.items.findIndex(x => x.id === id);
  if (from < 0 || !Number.isFinite(insertAt)) return list;
  const at = Math.min(Math.max(Math.round(insertAt), 0), list.items.length);
  const to = at > from ? at - 1 : at;  // 先拿掉自己，後面的位置往前一格
  if (to === from) return list;
  const items = [...list.items];
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved);
  return { ...list, items };
}

/**
 * ↑ / ↓ 換上一個 / 下一個：回傳要放的 id。
 * 沒有在放的 → ↓ 從第一個、↑ 從最後一個開始；已經在頭 / 尾、清單空的 → null（不繞回去）
 */
export function stepMediaItem(list: LocalMediaList, delta: number): string | null {
  const n = list.items.length;
  if (n === 0 || delta === 0) return null;
  const cur = list.items.findIndex(x => x.id === list.activeId);
  const next = cur < 0 ? (delta > 0 ? 0 : n - 1) : cur + Math.sign(delta);
  if (next < 0 || next >= n || next === cur) return null;
  return list.items[next].id;
}

/** 改清單裡某一個的資料（縮圖、長度做好時填回去）；不在清單 → 原樣 */
export function updateMediaItem(
  list: LocalMediaList, id: string, patch: Partial<Pick<LocalMediaItem, 'thumb' | 'thumbReady' | 'duration'>>,
): LocalMediaList {
  const i = list.items.findIndex(x => x.id === id);
  if (i < 0) return list;
  const items = [...list.items];
  items[i] = { ...items[i], ...patch };
  return { ...list, items };
}

// ── 清單縮圖 ──

/** 顯示框（CSS 88×40）的 2 倍 → 高解析螢幕也清楚，一張只有幾 KB */
export const THUMB_BOX = { w: 176, h: 80 };

/**
 * 影片縮圖抓哪一秒：片長的 10%，但至少 1 秒（太短的片子取一半）——
 * 開頭常常是黑畫面淡入，抓 0 秒會一片黑。不知道片長 → 0（抓第一格）
 */
export function thumbnailTime(duration: number): number {
  if (duration === Infinity) return 1;
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  return Math.max(duration * 0.1, Math.min(1, duration / 2));
}

/** 整張畫面縮進框裡（不裁切，LED 畫布再寬也看得到全部），至少 1px */
export function fitSize(w: number, h: number, boxW: number, boxH: number): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: boxW, h: boxH };
  const s = Math.min(boxW / w, boxH / h);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

function drawThumb(source: CanvasImageSource, w: number, h: number): string | null {
  const size = fitSize(w, h, THUMB_BOX.w, THUMB_BOX.h);
  const canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, size.w, size.h);
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function imageThumb(file: File): Promise<string | null> {
  const bmp = await createImageBitmap(file);
  try {
    return drawThumb(bmp, bmp.width, bmp.height);
  } finally {
    bmp.close();
  }
}

/** 另開一個靜音的 <video> 抓一格（跟 LED 用的播放器分開，抓完就放掉解碼器） */
function videoThumb(file: File): Promise<{ thumb: string | null; duration: number | null }> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    const src = URL.createObjectURL(file);
    let duration: number | null = null;
    let done = false;
    const finish = (thumb: string | null) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(src);
      resolve({ thumb, duration });
    };
    const grab = () => {
      try { finish(drawThumb(v, v.videoWidth, v.videoHeight)); } catch { finish(null); }
    };
    // 很大的檔案 / 解不開的編碼：等太久就放棄（只是縮圖，播放器那邊會自己報錯）
    const timer = window.setTimeout(() => finish(null), 20000);
    v.addEventListener('loadedmetadata', () => {
      duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null;
      if (!v.videoWidth) { finish(null); return; }
      const t = thumbnailTime(v.duration);
      if (t > 0) {
        v.addEventListener('seeked', grab, { once: true });
        v.currentTime = t;
      } else {
        v.addEventListener('loadeddata', grab, { once: true });
      }
    }, { once: true });
    v.addEventListener('error', () => finish(null), { once: true });
    v.src = src;
  });
}

/** 做一張清單縮圖（影片順便拿到片長）；做不出來 → thumb null */
export async function makeMediaThumbnail(item: Pick<LocalMediaItem, 'kind' | 'file'>): Promise<{ thumb: string | null; duration: number | null }> {
  if (item.kind === 'video') return videoThumb(item.file);
  try {
    return { thumb: await imageThumb(item.file), duration: null };
  } catch {
    return { thumb: null, duration: null };
  }
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
  /** 拖曳排順序：移到原本第 insertAt 個的前面 */
  move: (id: string, insertAt: number) => void;
  /** 換上一個（-1）/ 下一個（+1）；有換回 true */
  step: (delta: number) => boolean;
  /** 從別的來源（歌曲影片、AE 即時）切回本地檔案：正在放的影片如果被換掉了就重新載入 */
  reshow: () => void;
}

/** 播放器裡載的是清單裡哪一個（跟歌曲影片版本的 key 分開） */
export const localMediaKey = (id: string) => `local:${id}`;

export function useLocalMedia(player: LocalVideoState): LocalMediaState {
  const { video, load: loadVideo, clear: clearVideo, getSrcKey } = player;
  const [list, setList] = useState<LocalMediaList>(EMPTY_MEDIA_LIST);
  const listRef = useRef(list);
  const seqRef = useRef(0);

  const commit = useCallback((next: LocalMediaList) => {
    listRef.current = next;
    setList(next);
  }, []);

  // 換成正在放的檔案：影片 → 載入（停在第一格，按播放才開始；同一支就停在原本那一格）；圖片 / 沒有 → 影片暫停
  // （切去圖片時影片只暫停、不卸掉，切回來還在那一格）
  const show = useCallback((item: LocalMediaItem | null) => {
    if (!item || item.kind !== 'video') { video.pause(); return; }
    if (getSrcKey() !== localMediaKey(item.id)) loadVideo(item.file, localMediaKey(item.id));
  }, [video, loadVideo, getSrcKey]);

  // 縮圖：排隊一次做一個（不跟 LED 正在播的影片搶解碼），做好填回清單；已經拿掉的就跳過
  const thumbQueueRef = useRef<LocalMediaItem[]>([]);
  const thumbBusyRef = useRef(false);
  const aliveRef = useRef(true);
  const pumpThumbs = useCallback(() => {
    if (thumbBusyRef.current || !aliveRef.current) return;
    const inList = (it: LocalMediaItem) => listRef.current.items.some(x => x.id === it.id);
    const queue = thumbQueueRef.current;
    while (queue.length > 0 && !inList(queue[0])) queue.shift();
    const item = queue.shift();
    if (!item) return;
    thumbBusyRef.current = true;
    makeMediaThumbnail(item).then(({ thumb, duration }) => {
      thumbBusyRef.current = false;
      if (!aliveRef.current) return;
      commit(updateMediaItem(listRef.current, item.id, { thumb, thumbReady: true, ...(duration != null ? { duration } : {}) }));
      pumpThumbs();
    });
  }, [commit]);

  const add = useCallback((files: File[]) => {
    const { accepted, rejected } = splitMediaFiles(files);
    const incoming: LocalMediaItem[] = accepted.map(({ file, kind }) => ({
      id: `m${++seqRef.current}`,
      key: mediaFileKey(file),
      name: file.name,
      kind,
      file,
      url: kind === 'image' ? URL.createObjectURL(file) : null,
      thumb: null,
      thumbReady: false,
      duration: null,
    }));
    const prev = listRef.current;
    const { list: next, added } = addMediaItems(prev, incoming);
    for (const it of incoming) if (it.url && !added.includes(it)) URL.revokeObjectURL(it.url);
    commit(next);
    if (next.activeId !== prev.activeId) show(activeMediaItem(next));
    thumbQueueRef.current.push(...added);
    pumpThumbs();
    return { rejected, shown: incoming.length > 0 };
  }, [commit, show, pumpThumbs]);

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
    if (getSrcKey() === localMediaKey(removed.id)) clearVideo();
  }, [commit, clearVideo, getSrcKey]);

  const move = useCallback((id: string, insertAt: number) => {
    const prev = listRef.current;
    const next = moveMediaItem(prev, id, insertAt);
    if (next !== prev) commit(next);
  }, [commit]);

  const step = useCallback((delta: number) => {
    const id = stepMediaItem(listRef.current, delta);
    if (!id) return false;
    select(id);
    return true;
  }, [select]);

  const reshow = useCallback(() => {
    const item = activeMediaItem(listRef.current);
    if (item?.kind === 'video' && getSrcKey() !== localMediaKey(item.id)) loadVideo(item.file, localMediaKey(item.id));
  }, [getSrcKey, loadVideo]);

  // 離開頁面 → 收掉所有圖片網址（影片的由 useLocalVideo 收）、縮圖不再做
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      thumbQueueRef.current = [];
      for (const it of listRef.current.items) if (it.url) URL.revokeObjectURL(it.url);
    };
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

  return { items: list.items, active, player, image, imageError, add, select, remove, move, step, reshow };
}
