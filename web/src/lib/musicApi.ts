// 歌曲的音樂（沒有影片的歌，用音樂當「歌的時間」）的前端呼叫 — 對應 cf-worker/songMusic.mjs
// 完整說明（每個網址、回傳格式、錯誤碼）：docs/music-api.md
//
// 音樂不大，一個請求直接傳完（PUT 檔案內容；用 XMLHttpRequest 才有傳到一半的進度）。播放用回傳的 streamUrl（支援 Range）。
//
// 權限（後台會檢查，畫面只是先擋）：
//   看 / 聽                 專案成員都可以（動畫師只能聽）
//   上傳 / 換 / 移除        製作和導演
//   分享連結的訪客          只能聽，不走這裡的網址（shareMusicApi.ts）；沒有上傳 / 換 / 移除

import { apiBase, getSessionToken } from './api';

/** 歌單上每首歌帶的簡短資料（沒有播放網址） */
export interface SongMusicSummary {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number | null;
  /** 長度（秒）；瀏覽器量不到的 = null */
  durationSec: number | null;
  uploadedAt: string;
}

/** 單首歌的音樂（含誰傳的、播放網址） */
export interface SongMusic extends SongMusicSummary {
  songId: string;
  uploadedBy: { id: string; name: string | null } | null;
  /** 相對路徑（absoluteMusicUrl 接上後台網址），已經帶了 6～12 小時的播放通行證；播到一半 401 → 重新拿 */
  streamUrl: string;
}

/** GET /songs 每首歌多的欄位（舊的後台沒有這兩欄 = 沒有音樂） */
export interface SongMusicFields {
  hasMusic: boolean;
  music: SongMusicSummary | null;
}

/** 後台回的錯誤：message 是中文、可以直接顯示 */
export interface MusicApiError extends Error {
  status: number;
  data: { error?: string; maxBytes?: number; passExpired?: boolean; [k: string]: unknown };
}

const enc = encodeURIComponent;
const musicPath = (projectId: string, songId: string) => `/api/projects/${enc(projectId)}/songs/${enc(songId)}/music`;

function makeError(status: number, data: MusicApiError['data']): MusicApiError {
  const e = new Error(data?.error || `HTTP ${status}`) as MusicApiError;
  e.status = status;
  e.data = data || {};
  return e;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getSessionToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(apiBase() + path, { credentials: 'include', ...init, headers });
  if (!resp.ok) {
    let data: MusicApiError['data'] = {};
    try { data = await resp.json(); } catch { /* 不是 JSON */ }
    throw makeError(resp.status, data);
  }
  return resp.json() as Promise<T>;
}

/** 相對的 streamUrl → 完整網址（給 <audio> / <video> 的 src） */
export function absoluteMusicUrl(streamUrl: string): string {
  return /^https?:\/\//.test(streamUrl) ? streamUrl : apiBase() + streamUrl;
}

/** 這首歌的音樂（含播放網址）；沒有 = null */
export async function getSongMusic(projectId: string, songId: string): Promise<SongMusic | null> {
  return (await call<{ music: SongMusic | null }>(musicPath(projectId, songId))).music;
}

/** 移除這首歌的音樂（製作、導演） */
export async function deleteSongMusic(projectId: string, songId: string): Promise<void> {
  await call<{ ok: true }>(musicPath(projectId, songId), { method: 'DELETE' });
}

export interface UploadMusicOptions {
  /** 瀏覽器量到的長度（秒），選填 */
  durationSec?: number | null;
  /** 已經送出幾 bytes / 總共幾 bytes */
  onProgress?: (loaded: number, total: number) => void;
  /** 取消上傳 → AbortError */
  signal?: AbortSignal;
}

/**
 * 上傳 / 換掉這首歌的音樂（製作、導演）。用 XMLHttpRequest 不用 fetch：fetch 沒辦法知道「已經送出多少」。
 * 後台回的錯 → MusicApiError（中文 message + status；413 有 data.maxBytes）；網路斷 → TypeError；signal 取消 → AbortError。
 */
export function uploadSongMusic(projectId: string, songId: string, file: File, opts: UploadMusicOptions = {}): Promise<SongMusic> {
  return new Promise((resolve, reject) => {
    const { signal, onProgress } = opts;
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const query = `?filename=${enc(file.name)}${opts.durationSec != null && opts.durationSec > 0 ? `&durationSec=${enc(String(Math.round(opts.durationSec * 1000) / 1000))}` : ''}`;
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', apiBase() + musicPath(projectId, songId) + query);
    xhr.withCredentials = true;
    const token = getSessionToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    // 瀏覽器把類型寫成空的（有些 .m4a / .flac）→ 後台看檔名的副檔名
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.min(e.loaded, e.total), e.total); };
    let settled = false;
    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    xhr.onload = () => finish(() => {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(xhr.responseText || '{}') ?? {}; } catch { /* 不是 JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.music) { resolve(data.music as SongMusic); return; }
      reject(makeError(xhr.status, data as MusicApiError['data']));
    });
    xhr.onerror = () => finish(() => reject(new TypeError('Failed to fetch')));
    xhr.ontimeout = () => finish(() => reject(new TypeError('Failed to fetch')));
    xhr.onabort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')));
    xhr.send(file);
  });
}

/** 上傳 / 移除失敗要跟人說什麼（後台的中文照用；沒連上網路、被取消另外寫） */
export function musicErrorText(e: unknown): string {
  if (e instanceof DOMException && e.name === 'AbortError') return '已取消上傳';
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    const msg = (e as Error).message;
    if (msg && !/^HTTP \d+$/.test(msg)) return msg;
    if (status === 401) return '登入過期了，請重新整理頁面再登入';
    if (status === 403) return '只有製作或導演可以上傳、換或移除音樂';
    if (status === 409) return '這個專案已封存或音樂剛剛被換掉了，請重新整理再試';
    return `伺服器回應錯誤（${status}），請稍後再試`;
  }
  return '網路斷了，音樂沒有傳完，請檢查網路後再試一次';
}
