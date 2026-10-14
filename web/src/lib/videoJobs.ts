// 「＋加影片」交出去的工作：上傳檔案（分段，可以續傳）、貼連結（後台複製到 R2）。
//
// 工作放在這個分頁共用的地方（不在某首歌的畫面裡）→ 上傳中切到別首歌、回到總覽，上傳照樣繼續；
// 好了會通知頁面（onDone）→ 那首歌選到新的一版（停在第一格，按播放才開始）。
//
//   jobReducer — 一個工作的狀態怎麼變（純函式，videoJobs.test.ts 有測）
//     starting →（建好）→ uploading →（傳完）→ finishing →（給版本號）→ done
//     starting →（後台開始複製）→ copying → done
//     進行中的都可以 → failed（可以重試）/ canceled（取消，號碼不會被佔走）
//   createVideoJobStore — 真的去做（上傳 / 等複製好 / 取消 / 重試）；呼叫後台的部分可以換掉（測試用）
//   videoJobs / useVideoJobs / useWarnBeforeUnloadWhileUploading — 頁面用

import { useEffect, useSyncExternalStore } from 'react';
import {
  abortVideoUpload, getSongVideo, pasteVideoLink, retrySongVideo, uploadResumeKey, uploadSongVideo,
  type SongVideo, type UploadSongVideoOptions, type VideoApiError,
} from './videoApi';
import { friendlyError } from './songReview';

export type VideoJobKind = 'upload' | 'link';
export type VideoJobPhase = 'starting' | 'uploading' | 'finishing' | 'copying' | 'done' | 'failed' | 'canceled';

export interface VideoJob {
  /** 這個分頁裡的編號（不是影片 id） */
  id: string;
  kind: VideoJobKind;
  projectId: string;
  songId: string;
  /** 給人看的歌名（S03 主題曲） */
  songLabel: string;
  /** 檔名 / 貼的連結 */
  name: string;
  note: string;
  phase: VideoJobPhase;
  bytesDone: number;
  totalBytes: number | null;
  /** 後台的影片 id（建好之後才有） */
  videoId: string | null;
  /** 失敗原因（中文） */
  error: string | null;
  /** 好了的那一版（有版本號） */
  result: SongVideo | null;
  /** 失敗了能不能按重試（格式不收、太大的不能） */
  retryable: boolean;
}

export type VideoJobEvent =
  | { type: 'created'; videoId: string; bytesDone?: number; totalBytes?: number | null }
  | { type: 'progress'; bytesDone: number; totalBytes?: number | null }
  | { type: 'finishing' }
  | { type: 'done'; video: SongVideo }
  | { type: 'failed'; error: string; retryable?: boolean }
  | { type: 'cancel' }
  | { type: 'retry' };

const ACTIVE: ReadonlySet<VideoJobPhase> = new Set(['starting', 'uploading', 'finishing', 'copying']);

/** 還在做（還沒好、沒失敗、沒取消） */
export function isJobActive(job: Pick<VideoJob, 'phase'>): boolean {
  return ACTIVE.has(job.phase);
}

/** 關掉分頁會中斷的（瀏覽器正在傳檔案）；貼連結是後台在複製，關掉也沒關係 */
export function jobBlocksUnload(job: Pick<VideoJob, 'phase' | 'kind'>): boolean {
  return job.kind === 'upload' && (job.phase === 'starting' || job.phase === 'uploading' || job.phase === 'finishing');
}

/** 一個工作的狀態怎麼變：不合理的事件（取消之後又來進度、好了之後又失敗…）一律不理 */
export function jobReducer(job: VideoJob, ev: VideoJobEvent): VideoJob {
  if (job.phase === 'done' || job.phase === 'canceled') return job;  // 結束了
  switch (ev.type) {
    case 'created':
      if (job.phase !== 'starting') return job;
      return {
        ...job,
        videoId: ev.videoId,
        phase: job.kind === 'upload' ? 'uploading' : 'copying',
        bytesDone: Math.max(0, ev.bytesDone ?? job.bytesDone),
        totalBytes: ev.totalBytes !== undefined ? ev.totalBytes : job.totalBytes,
      };
    case 'progress': {
      if (job.phase !== 'uploading' && job.phase !== 'copying') return job;
      const totalBytes = ev.totalBytes !== undefined && ev.totalBytes !== null ? ev.totalBytes : job.totalBytes;
      // 同時傳好幾段時回來的順序不一定 → 只往前走
      const bytesDone = Math.max(job.bytesDone, Math.min(ev.bytesDone, totalBytes ?? Infinity));
      return { ...job, bytesDone, totalBytes };
    }
    case 'finishing':
      if (job.phase !== 'uploading') return job;
      return { ...job, phase: 'finishing', bytesDone: job.totalBytes ?? job.bytesDone };
    case 'done':
      if (!isJobActive(job)) return job;
      return {
        ...job, phase: 'done', result: ev.video, videoId: ev.video.id, error: null,
        bytesDone: job.totalBytes ?? job.bytesDone,
      };
    case 'failed':
      if (!isJobActive(job)) return job;
      return { ...job, phase: 'failed', error: ev.error, retryable: ev.retryable ?? true };
    case 'cancel':
      if (!isJobActive(job) && job.phase !== 'failed') return job;
      return { ...job, phase: 'canceled' };
    case 'retry':
      if (job.phase !== 'failed' || !job.retryable) return job;
      // 上傳：有 videoId 就續傳（只傳缺的段）；貼連結：後台重新複製
      return {
        ...job, error: null,
        phase: job.kind === 'upload' ? (job.videoId ? 'uploading' : 'starting') : 'copying',
      };
    default:
      return job;
  }
}

/** 進度 0～100（不知道總大小 = null） */
export function jobPercent(job: Pick<VideoJob, 'phase' | 'bytesDone' | 'totalBytes'>): number | null {
  if (job.phase === 'done') return 100;
  if (!job.totalBytes || job.totalBytes <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((job.bytesDone / job.totalBytes) * 100)));
}

/** 12.3 MB（小於 10 MB 留一位小數） */
export function formatMB(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/** 一行狀態：上傳中 45%（12.3 / 27.1 MB）、複製中 30%、處理中…、完成、失敗原因 */
export function jobStatusText(job: VideoJob): string {
  const pct = jobPercent(job);
  switch (job.phase) {
    case 'starting': return job.kind === 'upload' ? '準備上傳…' : '檢查連結中…';
    case 'uploading':
      return job.totalBytes
        ? `上傳中 ${pct ?? 0}%（${formatMB(job.bytesDone)} / ${formatMB(job.totalBytes)}）`
        : '上傳中…';
    case 'finishing': return '上傳好了，正在整理成一個檔案…';
    case 'copying':
      return pct != null
        ? `複製中 ${pct}%${job.totalBytes ? `（${formatMB(job.bytesDone)} / ${formatMB(job.totalBytes)}）` : ''}`
        : '複製中…';
    case 'done': return job.result?.label ? `完成，變成 ${job.result.label}` : '完成';
    case 'failed': return job.error || '失敗了';
    case 'canceled': return '已取消';
    default: return '';
  }
}

// ─── 真的去做 ───

export interface VideoJobDeps {
  upload: (projectId: string, songId: string, file: File, opts: UploadSongVideoOptions) => Promise<SongVideo>;
  abort: (projectId: string, songId: string, videoId: string) => Promise<void>;
  paste: (projectId: string, songId: string, input: { url: string; note?: string }) => Promise<{ video: SongVideo; duplicate: boolean }>;
  get: (projectId: string, songId: string, videoId: string) => Promise<SongVideo>;
  retryLink: (projectId: string, songId: string, videoId: string) => Promise<SongVideo>;
  /** 續傳用（key → videoId）；null = 不記 */
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 查複製進度的間隔（毫秒；後台建議 2～5 秒） */
  pollMs?: number;
  /** 好了之後那一列留多久再自動拿掉（毫秒；0 = 不拿掉） */
  doneLingerMs?: number;
}

export interface StartUploadInput {
  projectId: string;
  songId: string;
  songLabel: string;
  file: File;
  note?: string;
  /** 接著傳停住的那一版（「繼續上傳（選同一個檔案）」；別台電腦開始傳的也可以） */
  resumeVideoId?: string;
  /** 交之前算好的檔案指紋（AddVideoDialog 比對重複時算的） */
  fingerprint?: string | null;
}

export interface AddLinkInput {
  projectId: string;
  songId: string;
  songLabel: string;
  url: string;
  note?: string;
}

export interface VideoJobStore {
  getSnapshot(): readonly VideoJob[];
  subscribe(cb: () => void): () => void;
  /** 好了（拿到版本號）時通知一次 */
  onDone(cb: (job: VideoJob) => void): () => void;
  startUpload(input: StartUploadInput): string;
  /** 貼連結：連結有問題會直接丟錯（message 是後台的中文說明，馬上顯示）；沒問題回工作編號，開始等它複製好 */
  addLink(input: AddLinkInput): Promise<string>;
  cancel(jobId: string): Promise<void>;
  retry(jobId: string): void;
  /** 把結束的那一列拿掉 */
  dismiss(jobId: string): void;
  anyBlockingUnload(): boolean;
}

function errText(e: unknown): string {
  return friendlyError(e);
}

/** 這個錯誤再試也沒用（格式不收、太大、沒權限、這一版已經不在了） */
function permanent(e: unknown): boolean {
  const s = (e as VideoApiError | null)?.status;
  return s === 400 || s === 403 || s === 404 || s === 413 || s === 415;
}

export function createVideoJobStore(deps: VideoJobDeps): VideoJobStore {
  let jobs: readonly VideoJob[] = [];
  let seq = 0;
  const listeners = new Set<() => void>();
  const doneListeners = new Set<(job: VideoJob) => void>();
  const controllers = new Map<string, AbortController>();
  const files = new Map<string, File>();
  const fingerprints = new Map<string, string>();
  const pollMs = Math.max(1000, deps.pollMs ?? 3000);

  const find = (id: string) => jobs.find(j => j.id === id);
  const emit = () => { for (const cb of listeners) cb(); };

  function dispatch(id: string, ev: VideoJobEvent) {
    const cur = find(id);
    if (!cur) return;
    const next = jobReducer(cur, ev);
    if (next === cur) return;
    jobs = jobs.map(j => (j.id === id ? next : j));
    emit();
    if (next.phase === 'done' && cur.phase !== 'done') {
      for (const cb of doneListeners) {
        try { cb(next); } catch (e) { console.warn('[videoJobs] onDone', e); }
      }
      // 好了的那一列（「完成，變成 V3」）留一下就自己收掉
      if (deps.doneLingerMs) setTimeout(() => { if (find(id)?.phase === 'done') removeJob(id); }, deps.doneLingerMs);
    }
  }

  function removeJob(id: string) {
    jobs = jobs.filter(j => j.id !== id);
    files.delete(id);
    emit();
  }

  function add(job: VideoJob) {
    jobs = [...jobs, job];
    emit();
  }

  function resumeKeyOf(job: VideoJob, file: File) {
    return uploadResumeKey(job.projectId, job.songId, file);
  }
  function storageGet(k: string): string | null {
    try { return deps.storage?.getItem(k) ?? null; } catch { return null; }
  }
  function storageSet(k: string, v: string | null) {
    try {
      if (v) deps.storage?.setItem(k, v);
      else deps.storage?.removeItem(k);
    } catch { /* 只是不能續傳 */ }
  }

  async function runUpload(id: string) {
    const job = find(id);
    const file = files.get(id);
    if (!job || !file) return;
    const ctrl = new AbortController();
    controllers.set(id, ctrl);
    const key = resumeKeyOf(job, file);
    try {
      const video = await deps.upload(job.projectId, job.songId, file, {
        note: job.note || undefined,
        resumeVideoId: job.videoId ?? storageGet(key),
        fingerprint: fingerprints.get(id) ?? null,
        signal: ctrl.signal,
        onStarted: (v) => {
          storageSet(key, v.id);
          const cur = find(id);
          if (!cur) return;
          if (cur.phase === 'starting') {
            dispatch(id, { type: 'created', videoId: v.id, bytesDone: v.progress?.bytesDone ?? 0, totalBytes: file.size });
          } else if (cur.videoId !== v.id) {
            // 續傳的那一版已經不在了 → 後台重新開了一版
            jobs = jobs.map(j => (j.id === id ? { ...j, videoId: v.id, bytesDone: v.progress?.bytesDone ?? 0 } : j));
            emit();
          }
        },
        onProgress: (p) => {
          dispatch(id, { type: 'progress', bytesDone: p.bytesDone, totalBytes: p.totalBytes });
          if (p.bytesDone >= p.totalBytes) dispatch(id, { type: 'finishing' });
        },
      });
      storageSet(key, null);
      files.delete(id);
      dispatch(id, { type: 'done', video });
    } catch (e) {
      if (find(id)?.phase === 'canceled') return;
      if ((e as Error)?.name === 'AbortError') return;
      dispatch(id, { type: 'failed', error: errText(e), retryable: !permanent(e) });
    } finally {
      if (controllers.get(id) === ctrl) controllers.delete(id);
    }
  }

  // 等後台複製好：每幾秒查一次（每次查詢也會推動後台繼續複製）。網路一時不通就慢一點再查
  async function pollLink(id: string) {
    const ctrl = new AbortController();
    controllers.set(id, ctrl);
    let misses = 0;
    try {
      for (;;) {
        const job = find(id);
        if (!job || job.phase !== 'copying' || !job.videoId) return;
        try {
          const v = await deps.get(job.projectId, job.songId, job.videoId);
          misses = 0;
          if (ctrl.signal.aborted) return;
          if (v.status === 'ready') { dispatch(id, { type: 'done', video: v }); return; }
          if (v.status === 'failed') {
            dispatch(id, { type: 'failed', error: v.error || '複製失敗了', retryable: true });
            return;
          }
          if (v.progress) dispatch(id, { type: 'progress', bytesDone: v.progress.bytesDone, totalBytes: v.progress.totalBytes });
        } catch (e) {
          if (ctrl.signal.aborted) return;
          if (permanent(e)) {
            dispatch(id, { type: 'failed', error: errText(e), retryable: false });
            return;
          }
          misses++;
        }
        await deps.sleep(misses > 0 ? Math.min(pollMs * 2 ** misses, 30_000) : pollMs, ctrl.signal);
      }
    } catch {
      /* 取消了 */
    } finally {
      if (controllers.get(id) === ctrl) controllers.delete(id);
    }
  }

  function baseJob(kind: VideoJobKind, input: { projectId: string; songId: string; songLabel: string; note?: string }, name: string, totalBytes: number | null): VideoJob {
    return {
      id: `job${++seq}`,
      kind,
      projectId: input.projectId,
      songId: input.songId,
      songLabel: input.songLabel,
      name,
      note: (input.note || '').trim(),
      phase: 'starting',
      bytesDone: 0,
      totalBytes,
      videoId: null,
      error: null,
      result: null,
      retryable: true,
    };
  }

  return {
    getSnapshot: () => jobs,
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    onDone(cb) { doneListeners.add(cb); return () => { doneListeners.delete(cb); }; },

    startUpload(input) {
      const job = { ...baseJob('upload', input, input.file.name, input.file.size), videoId: input.resumeVideoId ?? null };
      files.set(job.id, input.file);
      if (input.fingerprint) fingerprints.set(job.id, input.fingerprint);
      add(job);
      void runUpload(job.id);
      return job.id;
    },

    async addLink(input) {
      // 後台先試抓一下：連結有問題直接丟錯給畫面顯示（還沒建工作）
      const { video } = await deps.paste(input.projectId, input.songId, { url: input.url.trim(), note: input.note?.trim() || undefined });
      // 同一個連結還在複製中又貼一次 → 後台回同一版：沿用原本那一列
      const existing = jobs.find(j => j.videoId === video.id && isJobActive(j));
      if (existing) return existing.id;
      const job = baseJob('link', input, input.url.trim(), video.progress?.totalBytes ?? video.sizeBytes ?? null);
      add(job);
      dispatch(job.id, { type: 'created', videoId: video.id, bytesDone: video.progress?.bytesDone ?? 0, totalBytes: video.progress?.totalBytes ?? video.sizeBytes ?? null });
      if (video.status === 'ready') dispatch(job.id, { type: 'done', video });
      else if (video.status === 'failed') dispatch(job.id, { type: 'failed', error: video.error || '複製失敗了', retryable: true });
      else void pollLink(job.id);
      return job.id;
    },

    async cancel(jobId) {
      const job = find(jobId);
      if (!job || (!isJobActive(job) && job.phase !== 'failed')) return;
      controllers.get(jobId)?.abort();
      dispatch(jobId, { type: 'cancel' });
      const file = files.get(jobId);
      if (file) storageSet(resumeKeyOf(job, file), null);
      files.delete(jobId);
      // 後台也取消（號碼不會被佔走）；還沒建好的不用
      if (job.videoId) {
        try { await deps.abort(job.projectId, job.songId, job.videoId); } catch { /* 已經不在了 / 排程兩天後也會清掉 */ }
      }
    },

    retry(jobId) {
      const job = find(jobId);
      if (!job || job.phase !== 'failed' || !job.retryable) return;
      if (job.kind === 'upload') {
        if (!files.get(jobId)) return;
        // 從頭（還沒建好）或續傳（只傳缺的段）
        const wasStarted = !!job.videoId;
        dispatch(jobId, { type: 'retry' });
        if (!wasStarted) {
          jobs = jobs.map(j => (j.id === jobId ? { ...j, bytesDone: 0 } : j));
          emit();
        }
        void runUpload(jobId);
        return;
      }
      if (!job.videoId) return;
      dispatch(jobId, { type: 'retry' });
      const { projectId, songId, videoId } = job;
      deps.retryLink(projectId, songId, videoId).then(() => pollLink(jobId), (e) => {
        // 409 = 已經在複製了 / 格式不能重試
        const s = (e as VideoApiError).status;
        if (s === 409 && (e as VideoApiError).data?.status === 'processing') { void pollLink(jobId); return; }
        dispatch(jobId, { type: 'failed', error: errText(e), retryable: !permanent(e) && s !== 409 });
      });
    },

    dismiss(jobId) {
      const job = find(jobId);
      if (!job || isJobActive(job)) return;
      removeJob(jobId);
    },

    anyBlockingUnload: () => jobs.some(jobBlocksUnload),
  };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });
}

function browserStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

/** 這個分頁共用的一份 */
export const videoJobs: VideoJobStore = createVideoJobStore({
  upload: (p, s, f, o) => uploadSongVideo(p, s, f, o),
  abort: abortVideoUpload,
  paste: pasteVideoLink,
  get: getSongVideo,
  retryLink: retrySongVideo,
  storage: browserStorage(),
  sleep: abortableSleep,
  doneLingerMs: 8000,
});

/** 頁面用：這個專案的所有工作（會跟著更新） */
export function useVideoJobs(projectId: string | null): readonly VideoJob[] {
  const all = useSyncExternalStore(videoJobs.subscribe, videoJobs.getSnapshot, videoJobs.getSnapshot);
  return projectId ? all.filter(j => j.projectId === projectId) : all;
}

/** 好了的時候叫 cb（頁面拿來選到新的一版） */
export function useVideoJobDone(cb: (job: VideoJob) => void) {
  useEffect(() => videoJobs.onDone(cb), [cb]);
}

/** 正在上傳時關分頁 / 重新整理 → 瀏覽器先問一聲（上傳會中斷；下次選同一個檔案可以接著傳） */
export function useWarnBeforeUnloadWhileUploading() {
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!videoJobs.anyBlockingUnload()) return;
      e.preventDefault();
      e.returnValue = '影片還在上傳，離開的話上傳會中斷';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);
}
