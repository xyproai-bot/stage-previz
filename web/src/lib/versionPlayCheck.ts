// 影片版本在這台電腦播的結果（貼連結的版本沒辦法在複製前檢查 → 第一次播的時候檢查）。
//   localVideo.ts 播版本時記下來：有畫面 → 長寬秒數；播不了 → cannotPlay
//   SongVersionBar 讀出來，在版本列上寫「這個影片瀏覽器播不了…」或解析度、位元率、畫布的提醒
// 只存在這台電腦（localStorage，壞了也不會出錯）；不同瀏覽器結果可能不一樣，所以不存到後台。

import { useSyncExternalStore } from 'react';
import type { PlayCheck } from './videoCheck';

const STORAGE_KEY = 'sp_video_play_check';
/** 最多記幾版（舊的先丟） */
const MAX_ENTRIES = 300;

type Store = Record<string, PlayCheck>;

let cache: Store | null = null;
const listeners = new Set<() => void>();

function load(): Store {
  if (cache) return cache;
  let out: Store = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out = parsed as Store;
  } catch { /* 壞資料 / 私密模式 → 當沒有 */ }
  cache = out;
  return out;
}

function save(store: Store) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* 存不了就只記在這一頁 */ }
}

/** 'v:<影片 id>' → 影片 id；別的（本地檔案、舊的 Drive 影片）→ null */
export function versionIdFromKey(key: string | null | undefined): string | null {
  return key && key.startsWith('v:') ? key.slice(2) || null : null;
}

export function getPlayCheck(videoId: string): PlayCheck | null {
  return load()[videoId] ?? null;
}

function sameCheck(a: PlayCheck | undefined, b: PlayCheck): boolean {
  if (!a || a.status !== b.status) return false;
  if (a.status === 'ok' && b.status === 'ok') return a.width === b.width && a.height === b.height && a.durationSec === b.durationSec;
  return a.status === 'cannotPlay' && b.status === 'cannotPlay' && a.reason === b.reason;
}

export function recordPlayCheck(videoId: string, check: PlayCheck) {
  const cur = load();
  if (sameCheck(cur[videoId], check)) return;
  const next: Store = { ...cur, [videoId]: check };
  const ids = Object.keys(next);
  if (ids.length > MAX_ENTRIES) {
    ids.sort((a, b) => next[a].at - next[b].at);
    for (const id of ids.slice(0, ids.length - MAX_ENTRIES)) delete next[id];
  }
  cache = next;
  save(next);
  listeners.forEach(cb => cb());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    cache = null;  // 別的分頁記了 → 重讀
    cb();
  };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(cb); window.removeEventListener('storage', onStorage); };
}

/** 全部版本的播放結果（記了新的就會重畫） */
export function usePlayChecks(): Readonly<Store> {
  return useSyncExternalStore(subscribe, load, load);
}

/** 測試用：清掉記住的 */
export function resetPlayChecksForTest() {
  cache = null;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
