// 歌曲影片版本（V1、V2…）的前端呼叫 — 對應 cf-worker/worker.js「歌曲影片版本」那一段
// 完整說明（每個網址、回傳格式、錯誤碼）：docs/videos-api.md
//
// 影片一律放在我們自己的 R2：上傳是瀏覽器分段傳（每段 16 MiB，可以續傳；用 XMLHttpRequest 才有傳到一半的進度）；
// 貼連結 / Drive 資料夾同步是後台複製一份到 R2。播放一律用回傳的 streamUrl（支援 Range、可以快取）。
//
// 權限（後台會檢查，畫面只是先擋）：
//   看版本 / 播放      專案成員都可以
//   交新版             admin，或負責這首歌的動畫師（歌沒指派人 = 專案裡的動畫師都可以）；導演不行
//   改說明 / 刪 / 取消  admin，或交這一版的人

import { apiBase, getSessionToken, type ShareRef } from './api';

// ─── 型別 ───

export type SongVideoStatus = 'uploading' | 'processing' | 'ready' | 'failed';
export type SongVideoSource = 'upload' | 'link' | 'drive';

export interface SongVideoUploadInfo {
  /** 每段幾 bytes（最後一段可以比較小）；一定要照這個切 */
  partSize: number;
  partCount: number;
  /** 已經傳好的段（1 開始）→ 續傳時跳過 */
  uploadedParts: number[];
  /** 建議同時傳幾段 */
  maxConcurrency: number;
}

export interface SongVideo {
  id: string;
  projectId: string;
  songId: string;
  /** 版本號（好了才有；上傳中 / 複製中 / 失敗 = null）。號碼只增不減，刪掉的號碼不會再用 */
  version: number | null;
  /** 'V3'；沒有版本號 = '' */
  label: string;
  title: string;
  note: string;
  source: SongVideoSource;
  /** 貼的連結（source = link） */
  originalUrl: string | null;
  driveFileId: string | null;
  mime: 'video/mp4' | 'video/quicktime' | 'video/webm' | string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  status: SongVideoStatus;
  /**
   * failed：失敗原因（中文，可以直接顯示）
   * processing：最近一次出錯的原因（後台會自動重試，可以顯示成提醒）
   */
  error: string | null;
  /** 上傳中 / 複製中才有 */
  progress: { bytesDone: number; totalBytes: number | null } | null;
  /** 誰交的（Drive 同步 = null） */
  createdBy: { id: string; name: string | null } | null;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  /** 這首歌最新的可播版本 */
  isLatest: boolean;
  /**
   * 播放網址（相對路徑，用 absoluteVideoUrl 接上後台網址），ready 才有。
   * 已經帶了 6～12 小時的播放通行證（<video src> 帶不了登入 header）；播到一半回 401 → 重新拿清單換新網址
   */
  streamUrl: string | null;
  /** 上傳中（status = uploading）時才有：續傳用 */
  upload?: SongVideoUploadInfo;
  /** R2 存放方式：'Standard' 標準 / 'InfrequentAccess' 長期存放（舊的後台沒有這欄） */
  storageClass?: string;
  /** 跟更早交的哪一版是同一個檔案（指紋一樣）；沒有 = null（舊的後台沒有這欄） */
  duplicateOf?: { videoId: string; label: string; songId: string; songCode: string | null; songName: string; sameSong: boolean } | null;
  /** 剛交好、後台還在算指紋（算完才知道有沒有重複）→ 清單會再更新 */
  fingerprintPending?: boolean;
  /** 這一版做的時候用的 LED 版型 id（沒有 = 整張畫布；舊的後台沒有這欄） */
  templateId?: string | null;
  /** 那個版型當時的排法（快照；版型之後改了也不變）；格式見 lib/ledTemplate.ts parsePlan，沒有 = 整張畫布 */
  template?: unknown;
  /** 這一版上傳時整條版型時間線（中途換版型；格式見 lib/ledTemplateTimeline.ts parseTimeline；沒有 = 單一版型，舊的後台沒有這欄） */
  templateTimeline?: unknown;
}

export interface SongVideoList {
  /** 上傳中 / 複製中 / 失敗的在最前面（新的在前），接著版本號由大到小 */
  videos: SongVideo[];
  latestVideoId: string | null;
  songCode: string | null;
}

/** GET /songs 每首歌多的欄位（api.ts 的 Song 之後可以加上這幾個） */
export interface SongVideoFields {
  /** 歌曲固定代號（S01…），Drive 檔名開頭用它對歌 */
  code: string | null;
  latestVideoId: string | null;
  latestVideoVersion: number | null;
  /** 這首歌選的 LED 版型 id（沒選 = 整張畫布；舊的後台沒有這欄）。有中途換版型的話，這是開頭的版型 */
  templateId?: string | null;
  /** 中途換版型的點（0039；格式見 lib/ledTemplateTimeline.ts parseSwitches；舊的後台沒有這欄 = 沒有） */
  templateSwitches?: unknown;
}

/** 分享連結看到的一版（不含說明、誰交的、原始連結） */
export interface ShareSongVideo {
  id: string;
  songId: string;
  version: number;
  label: string;
  title: string;
  mime: string;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  createdAt: string;
  readyAt: string | null;
  /** 相對路徑；有密碼的連結已經接好 ?access=<通行證>，直接 absoluteVideoUrl() 當 src */
  streamUrl: string;
  /** 這一版做的時候用的 LED 版型排法（沒有 = 整張畫布；舊的後台沒有這欄） */
  template?: unknown;
  /** 這一版上傳時整條版型時間線（中途換版型；沒有 = 單一版型） */
  templateTimeline?: unknown;
}

/** 分享頁 /data 回傳的 songs[] 多的欄位 */
export interface ShareSongVideoFields {
  code: string | null;
  latestVideo: ShareSongVideo | null;
}

/** GET /api/projects/:id/comments/summary 的一首歌（說明：docs/comments-api.md） */
export interface CommentSummary {
  songId: string;
  count: number;
  openCount: number;
  latestAt: string | null;
  latestId: string | null;
  /** 不是我留的（自己的留言不算未讀） */
  fromOthersCount: number;
  latestFromOthersAt: string | null;
}

/** 後台回的錯誤：message 是中文、可以直接顯示；data 是整個錯誤內容 */
export interface VideoApiError extends Error {
  status: number;
  data: {
    error?: string;
    /** 代號被別首歌用掉（409） */
    codeTaken?: boolean;
    /** 完成上傳時還沒傳的段（409） */
    missingParts?: number[];
    /** 這一段應該多大（400） */
    expectedBytes?: number;
    /** 上限（413） */
    maxBytes?: number;
    /** 播放網址的通行證過期（401）→ 重新拿清單 */
    passExpired?: boolean;
    /** 目前狀態（409） */
    status?: SongVideoStatus;
    [k: string]: unknown;
  };
}

// ─── 共用 ───

const enc = encodeURIComponent;
const songBase = (projectId: string, songId: string) => `/api/projects/${enc(projectId)}/songs/${enc(songId)}/videos`;

async function toError(resp: Response): Promise<VideoApiError> {
  let data: VideoApiError['data'] = {};
  try { data = await resp.json(); } catch { /* 不是 JSON */ }
  const e = new Error(data?.error || `HTTP ${resp.status}`) as VideoApiError;
  e.status = resp.status;
  e.data = data || {};
  return e;
}

async function call<T>(path: string, init: RequestInit = {}, headers: Record<string, string> = {}): Promise<T> {
  const h: Record<string, string> = { ...headers };
  const token = getSessionToken();
  if (token) h.Authorization = `Bearer ${token}`;
  if (init.body !== undefined && typeof init.body === 'string') h['Content-Type'] = 'application/json';
  const resp = await fetch(apiBase() + path, { credentials: 'include', ...init, headers: h });
  if (!resp.ok) throw await toError(resp);
  return resp.json() as Promise<T>;
}

/** 相對的 streamUrl → 完整網址（給 <video src>） */
export function absoluteVideoUrl(streamUrl: string): string {
  return /^https?:\/\//.test(streamUrl) ? streamUrl : apiBase() + streamUrl;
}

// ─── 版本清單 / 單一版本 ───

/** 版本清單。畫面上有「複製中」的時候，每幾秒叫一次就會推動後台繼續複製 */
export function listSongVideos(projectId: string, songId: string): Promise<SongVideoList> {
  return call(songBase(projectId, songId));
}

/** 單一版本（含上傳 / 複製進度；上傳中會帶 upload 讓你續傳） */
export async function getSongVideo(projectId: string, songId: string, videoId: string): Promise<SongVideo> {
  return (await call<{ video: SongVideo }>(`${songBase(projectId, songId)}/${enc(videoId)}`)).video;
}

/** 改標題 / 說明 / 長寬秒數（admin 或交這一版的人） */
export async function patchSongVideo(
  projectId: string, songId: string, videoId: string,
  patch: Partial<{ title: string; note: string; width: number | null; height: number | null; durationSec: number | null }>,
): Promise<SongVideo> {
  return (await call<{ video: SongVideo }>(`${songBase(projectId, songId)}/${enc(videoId)}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  })).video;
}

/** 刪掉一版（從清單拿掉；號碼不會再用）。還在上傳 / 複製的會順便取消 */
export async function deleteSongVideo(projectId: string, songId: string, videoId: string): Promise<void> {
  await call(`${songBase(projectId, songId)}/${enc(videoId)}`, { method: 'DELETE' });
}

/** 複製失敗 → 重試（只有貼連結 / Drive 的才能重試） */
export async function retrySongVideo(projectId: string, songId: string, videoId: string): Promise<SongVideo> {
  return (await call<{ video: SongVideo }>(`${songBase(projectId, songId)}/${enc(videoId)}/retry`, { method: 'POST' })).video;
}

// ─── 貼連結 ───

/**
 * 貼連結（Google Drive 單檔 / Dropbox / OneDrive / SharePoint / 直接 .mp4 .mov .webm 網址）
 * 後台先試抓一下：連結有問題馬上回中文錯誤（400 看不懂的連結、413 太大、422 抓不到 / 不是影片）；
 * 沒問題回 status = 'processing' 的一版，後台開始複製到 R2 → 用 waitForSongVideo 等它好。
 * 同一個連結還在複製中又貼一次 → 回同一版（duplicate = true）
 */
export async function pasteVideoLink(
  projectId: string, songId: string,
  input: { url: string; title?: string; note?: string },
): Promise<{ video: SongVideo; duplicate: boolean }> {
  const r = await call<{ video: SongVideo; duplicate?: boolean }>(`${songBase(projectId, songId)}/link`, {
    method: 'POST', body: JSON.stringify(input),
  });
  return { video: r.video, duplicate: !!r.duplicate };
}

/**
 * 等某一版好了（ready）或失敗（failed）。每次查詢也會推動後台繼續複製（不要停掉）。
 * 回傳最後的狀態；signal 取消 → 丟 AbortError
 */
export async function waitForSongVideo(
  projectId: string, songId: string, videoId: string,
  opts: { intervalMs?: number; signal?: AbortSignal; onUpdate?: (v: SongVideo) => void } = {},
): Promise<SongVideo> {
  const interval = Math.max(1000, opts.intervalMs ?? 3000);
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const v = await getSongVideo(projectId, songId, videoId);
    opts.onUpdate?.(v);
    if (v.status === 'ready' || v.status === 'failed') return v;
    await sleep(interval, opts.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

// ─── 上傳（分段）───

export const VIDEO_ACCEPT = 'video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm';

/** 檔案的類型（瀏覽器沒給就看副檔名）；不收的回 null */
export function videoMimeForFile(file: { name: string; type?: string }): 'video/mp4' | 'video/quicktime' | 'video/webm' | null {
  const t = (file.type || '').toLowerCase();
  if (t === 'video/mp4' || t === 'video/x-m4v') return 'video/mp4';
  // .mov 有的電腦 / 瀏覽器報成 video/mov、video/x-quicktime
  if (t === 'video/quicktime' || t === 'video/mov' || t === 'video/x-quicktime') return 'video/quicktime';
  if (t === 'video/webm') return 'video/webm';
  if (t && t !== 'application/octet-stream') return null;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'webm') return 'video/webm';
  return null;
}

/** 第 n 段（1 開始）在檔案裡的範圍 [start, end) */
export function partRange(n: number, partSize: number, size: number): { start: number; end: number } {
  const start = (n - 1) * partSize;
  return { start, end: Math.min(size, start + partSize) };
}

/** 還沒傳的段 */
export function partsToUpload(info: Pick<SongVideoUploadInfo, 'partCount' | 'uploadedParts'>): number[] {
  const have = new Set(info.uploadedParts);
  const out: number[] = [];
  for (let n = 1; n <= info.partCount; n++) if (!have.has(n)) out.push(n);
  return out;
}

/** 同一個檔案的續傳 key（存 localStorage：key → videoId） */
export function uploadResumeKey(projectId: string, songId: string, file: { name: string; size: number; lastModified?: number }): string {
  return `sp_video_upload:${projectId}:${songId}:${file.name}:${file.size}:${file.lastModified ?? 0}`;
}

/** 開始上傳：回 status = 'uploading' 的一版，video.upload 告訴你怎麼切 */
export async function createVideoUpload(
  projectId: string, songId: string,
  input: { filename: string; sizeBytes: number; mime: string; title?: string; note?: string; width?: number; height?: number; durationSec?: number; fingerprint?: string },
): Promise<SongVideo> {
  return (await call<{ video: SongVideo }>(`${songBase(projectId, songId)}/uploads`, {
    method: 'POST', body: JSON.stringify(input),
  })).video;
}

export interface UploadPartResult { ok: true; partNumber: number; etag: string; bytesDone: number | null; totalBytes: number }

/**
 * 傳第 n 段（大小要剛好是 partRange 切出來的）。
 * 用 XMLHttpRequest 不用 fetch：fetch 沒辦法知道「已經送出多少」，進度只能等整段傳完才跳一次；
 * XMLHttpRequest 邊送邊回報（onUploadProgress = 這一段已經送出幾 bytes）。
 * 錯誤跟以前一樣：後台回的錯 → VideoApiError（中文 message + status）；網路斷 → TypeError（跟 fetch 一樣）；
 * signal 取消 → AbortError。
 */
export function uploadVideoPart(
  projectId: string, songId: string, videoId: string, partNumber: number, chunk: Blob, signal?: AbortSignal,
  onUploadProgress?: (loaded: number) => void,
): Promise<UploadPartResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', apiBase() + `${songBase(projectId, songId)}/${enc(videoId)}/parts/${partNumber}`);
    xhr.withCredentials = true;
    const token = getSessionToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (onUploadProgress) xhr.upload.onprogress = (e) => onUploadProgress(Math.min(e.loaded, chunk.size));
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
      let data: VideoApiError['data'] = {};
      try { data = JSON.parse(xhr.responseText || '{}') ?? {}; } catch { /* 不是 JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) { resolve(data as unknown as UploadPartResult); return; }
      const e = new Error(data?.error || `HTTP ${xhr.status}`) as VideoApiError;
      e.status = xhr.status;
      e.data = data || {};
      reject(e);
    });
    // 跟 fetch 一樣：連不上 → TypeError（重試、錯誤說明都照舊）
    xhr.onerror = () => finish(() => reject(new TypeError('Failed to fetch')));
    xhr.ontimeout = () => finish(() => reject(new TypeError('Failed to fetch')));
    xhr.onabort = () => finish(() => reject(new DOMException('Aborted', 'AbortError')));
    xhr.send(chunk);
  });
}

/**
 * 上傳進度：同時傳好幾段時，把「傳好的段」和「正在送的段已經送出的部分」加起來。
 *   - 只會往前（一段失敗重試時，畫面停在原地，不會倒退）
 *   - 還有段沒收到後台確認時，最多到「總大小 - 1」（畫面停在 99%，不會提早說傳完了）
 *   - 不會超過總大小
 */
export interface UploadProgress {
  /** 第 n 段送出了 loaded bytes（還在傳）→ 回傳現在的總進度 */
  sending(part: number, loaded: number): number;
  /** 第 n 段傳好了（size = 這一段多大；serverBytesDone = 後台說總共收到多少，有的話）→ 回傳現在的總進度 */
  done(part: number, size: number, serverBytesDone?: number | null): number;
  /** 第 n 段失敗了（等一下重傳）→ 送出的部分不算 */
  failed(part: number): number;
  bytesDone(): number;
}

export function createUploadProgress(totalBytes: number, alreadyDone = 0): UploadProgress {
  const total = Math.max(0, totalBytes);
  let confirmed = Math.max(0, Math.min(total, alreadyDone));
  let server = 0;
  let shown = confirmed;
  const inFlight = new Map<number, number>();
  const compute = () => {
    let sending = 0;
    for (const v of inFlight.values()) sending += v;
    let raw = Math.max(confirmed + sending, Math.min(server, total));
    if (confirmed < total) raw = Math.min(raw, total - 1);
    shown = Math.max(shown, Math.min(raw, total));
    return shown;
  };
  return {
    sending(part, loaded) {
      inFlight.set(part, Math.max(0, loaded));
      return compute();
    },
    done(part, size, serverBytesDone) {
      inFlight.delete(part);
      confirmed = Math.min(total, confirmed + Math.max(0, size));
      if (typeof serverBytesDone === 'number' && Number.isFinite(serverBytesDone)) server = Math.max(server, serverBytesDone);
      return compute();
    },
    failed(part) {
      inFlight.delete(part);
      return compute();
    },
    bytesDone: () => shown,
  };
}

/** 傳到一半的進度最多多久回報一次（毫秒）；一段傳好一定回報 */
const PROGRESS_INTERVAL_MS = 100;

/** 所有段都傳好 → 合併、給版本號（可以順便帶影片長寬秒數） */
export async function completeVideoUpload(
  projectId: string, songId: string, videoId: string,
  meta: { width?: number; height?: number; durationSec?: number } = {},
): Promise<SongVideo> {
  return (await call<{ video: SongVideo }>(`${songBase(projectId, songId)}/${enc(videoId)}/complete`, {
    method: 'POST', body: JSON.stringify(meta),
  })).video;
}

/** 取消上傳 / 複製（還沒好的才行；好了的用 deleteSongVideo） */
export async function abortVideoUpload(projectId: string, songId: string, videoId: string): Promise<void> {
  await call(`${songBase(projectId, songId)}/${enc(videoId)}/abort`, { method: 'POST' });
}

/** 讀影片的長寬秒數（瀏覽器才有；讀不到回空的，不影響上傳） */
export function readVideoFileMeta(file: Blob, timeoutMs = 8000): Promise<{ width?: number; height?: number; durationSec?: number }> {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return Promise.resolve({});
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement('video');
    let done = false;
    const finish = (v: { width?: number; height?: number; durationSec?: number }) => {
      if (done) return;
      done = true;
      // 先停掉這個暫時的播放器再收網址（不然它還會去讀已經收掉的網址，主控台會跳錯）
      el.removeAttribute('src');
      el.load();
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const t = setTimeout(() => finish({}), timeoutMs);
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () => {
      clearTimeout(t);
      finish({
        width: el.videoWidth || undefined,
        height: el.videoHeight || undefined,
        durationSec: Number.isFinite(el.duration) && el.duration > 0 ? el.duration : undefined,
      });
    };
    el.onerror = () => { clearTimeout(t); finish({}); };
    el.src = url;
  });
}

export interface UploadSongVideoOptions {
  title?: string;
  note?: string;
  /** 影片長寬秒數（不給就自己讀，讀不到就算了） */
  meta?: { width?: number; height?: number; durationSec?: number };
  /** 同時傳幾段（預設照後台建議，通常 3） */
  concurrency?: number;
  /** 每段失敗重試幾次（預設 3，網路斷掉會等一下再試） */
  retries?: number;
  /** 續傳：上次沒傳完的那一版 id（uploadResumeKey 存的） */
  resumeVideoId?: string | null;
  /** 交之前算好的檔案指紋（videoFingerprint.ts）→ 存在這一版，之後才知道有沒有人交了一樣的檔案 */
  fingerprint?: string | null;
  signal?: AbortSignal;
  /** 進度：傳到一半也會叫（同時傳好幾段時是加起來的，最多每 0.1 秒一次）；每傳好一段一定叫一次 */
  onProgress?: (p: { bytesDone: number; totalBytes: number; video: SongVideo }) => void;
  /** 建好上傳（拿到 videoId）時叫一次 → 存起來給續傳用 */
  onStarted?: (video: SongVideo) => void;
}

/**
 * 整個上傳流程：開始（或續傳）→ 分段傳（同時好幾段、失敗重試）→ 完成 → 回傳好了的那一版（有版本號）
 * 錯誤丟 VideoApiError（message 是中文）；signal 取消時只是停下來，要放棄這次上傳請另外叫 abortVideoUpload
 */
export async function uploadSongVideo(
  projectId: string, songId: string, file: File | (Blob & { name: string; lastModified?: number }),
  opts: UploadSongVideoOptions = {},
): Promise<SongVideo> {
  const mime = videoMimeForFile(file);
  if (!mime) {
    const e = new Error('只收 MP4 / MOV / WebM 影片') as VideoApiError;
    e.status = 415; e.data = {};
    throw e;
  }
  let video: SongVideo | null = null;
  if (opts.resumeVideoId) {
    try {
      const v = await getSongVideo(projectId, songId, opts.resumeVideoId);
      if (v.status === 'ready') return v;
      if (v.status === 'uploading' && v.sizeBytes === file.size && v.upload) video = v;
    } catch { /* 那一版不見了 → 重新開始 */ }
  }
  if (!video) {
    const meta = opts.meta ?? await readVideoFileMeta(file);
    video = await createVideoUpload(projectId, songId, {
      filename: file.name, sizeBytes: file.size, mime, title: opts.title, note: opts.note, ...meta,
      ...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}),
    });
  }
  opts.onStarted?.(video);
  const info = video.upload!;
  const todo = partsToUpload(info);
  // 進度 = 傳好的段 + 正在傳的段已經送出的（同時好幾段一起算）
  const progress = createUploadProgress(file.size, video.progress?.bytesDone ?? 0);
  let lastReportAt = -Infinity;
  let lastReported = -1;
  const report = (bytesDone: number, force: boolean) => {
    const now = Date.now();
    if (bytesDone === lastReported || (!force && now - lastReportAt < PROGRESS_INTERVAL_MS)) return;
    lastReportAt = now;
    lastReported = bytesDone;
    opts.onProgress?.({ bytesDone, totalBytes: file.size, video: video! });
  };
  const retries = opts.retries ?? 3;
  const queue = [...todo];
  const worker = async () => {
    for (;;) {
      const n = queue.shift();
      if (n === undefined) return;
      const { start, end } = partRange(n, info.partSize, file.size);
      for (let attempt = 0; ; attempt++) {
        if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        try {
          const r = await uploadVideoPart(
            projectId, songId, video!.id, n, file.slice(start, end), opts.signal,
            (loaded) => report(progress.sending(n, loaded), false),
          );
          report(progress.done(n, end - start, r.bytesDone), true);
          break;
        } catch (e) {
          progress.failed(n);
          const status = (e as VideoApiError).status;
          // 權限 / 這一版已經不在上傳中 / 大小不對 → 重試也沒用
          if ((e as Error).name === 'AbortError' || status === 400 || status === 403 || status === 404 || status === 409 || attempt >= retries) throw e;
          await sleep(1000 * 2 ** attempt, opts.signal);
        }
      }
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency ?? info.maxConcurrency ?? 3, 6));
  await Promise.all(Array.from({ length: Math.min(n, Math.max(1, todo.length)) }, worker));
  const meta = opts.meta ?? {};
  return completeVideoUpload(projectId, songId, video.id, meta);
}

// ─── 歌曲代號 ───

/** 改歌曲代號（admin）。被別首歌用掉 → 409（error.data.codeTaken）；格式不對 → 400 */
export async function updateSongCode(projectId: string, songId: string, code: string): Promise<void> {
  await call(`/api/projects/${enc(projectId)}/songs/${enc(songId)}`, { method: 'PATCH', body: JSON.stringify({ code }) });
}

// ─── 分享連結 ───

function shareApiPath(ref: ShareRef): string {
  return ref.kind === 'slug' ? `/api/s/${enc(ref.key)}` : `/api/share/${enc(ref.key)}`;
}

/** 分享連結看某首歌的影片：只有最新的可播版本（0 或 1 個）。通行證過期 → 401 */
export async function getShareSongVersions(ref: ShareRef, songId: string, access?: string): Promise<{ videos: ShareSongVideo[]; latestVideoId: string | null }> {
  const resp = await fetch(`${apiBase()}${shareApiPath(ref)}/songs/${enc(songId)}/versions`, {
    headers: access ? { 'x-share-access': access } : {},
  });
  if (!resp.ok) throw await toError(resp);
  return resp.json();
}

// ─── 留言摘要（docs/comments-api.md）───

/** 每首歌幾則留言、最新一則 → 工作站一次拿全部算未讀（latestFromOthersAt > 上次看的時間 才需要抓那首歌的留言） */
export async function getCommentsSummary(projectId: string): Promise<CommentSummary[]> {
  return (await call<{ songs: CommentSummary[] }>(`/api/projects/${enc(projectId)}/comments/summary`)).songs;
}

// ─── 給畫面用的小工具 ───

/** 狀態的中文 */
export function videoStatusLabel(v: Pick<SongVideo, 'status' | 'source'>): string {
  switch (v.status) {
    case 'uploading': return '上傳中';
    case 'processing': return v.source === 'drive' ? '從 Drive 複製中' : '複製中';
    case 'ready': return '可以播';
    case 'failed': return '失敗';
    default: return '';
  }
}

/** 進度 0～100（不知道總大小 = null） */
export function videoProgressPercent(v: Pick<SongVideo, 'progress' | 'status'>): number | null {
  if (v.status === 'ready') return 100;
  const p = v.progress;
  if (!p || !p.totalBytes) return null;
  return Math.max(0, Math.min(100, Math.floor((p.bytesDone / p.totalBytes) * 100)));
}
