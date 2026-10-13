// 「上傳中，但不是這個分頁在傳」的那一版（傳的分頁關掉了 / 在別台電腦傳）：
//   - 每一段都傳上來了，只差最後「整理成一個檔案」（complete）→ 有權限的人（製作、交這一版的人）打開頁面時自動完成
//     （以前會一直停在「上傳中 100%」，要選同一個檔案再傳一次、或等兩天被自動取消）
//   - 還有段沒傳 → 要有檔案才能接著傳：「繼續上傳（選同一個檔案）」/「取消這次上傳」
//   - 剛剛還有在動（別的分頁 / 電腦正在傳）→ 先不動它，只寫在傳
// 後台說明：docs/videos-api.md「上傳（分段，可以續傳）」；完成這一步按兩次也沒關係。
// 規則（純函式）、完成的流程（可以換掉後台呼叫）在 stalledUploads.test.ts 有測；hook 在最下面。

import { useCallback, useEffect, useRef, useState } from 'react';
import { completeVideoUpload, getSongVideo, videoMimeForFile, type SongVideo, type VideoApiError } from './videoApi';
import { isJobActive, type VideoJob } from './videoJobs';
import { parseServerTime } from './serverTime';
import { friendlyError } from './songReview';

/** 多久沒動算停住了：後台最後一次更新超過 60 秒，或這個畫面看著 30 秒都沒前進 */
export const STALL_SERVER_MS = 60_000;
export const STALL_LOCAL_MS = 30_000;

export type StalledKind =
  /** 剛剛還有在動（可能別的分頁 / 電腦正在傳） */
  | 'busy'
  /** 每一段都傳上來了，只差整理成一個檔案 */
  | 'finish'
  /** 還有段沒傳，要選同一個檔案接著傳 */
  | 'resume';

type V = Pick<SongVideo, 'status' | 'progress' | 'sizeBytes' | 'updatedAt'>;

/** 每一段都傳上來了（後台算的「已經傳好的 bytes」= 檔案大小） */
export function allPartsSent(v: V): boolean {
  if (v.status !== 'uploading') return false;
  const total = v.progress?.totalBytes ?? v.sizeBytes;
  return !!total && total > 0 && (v.progress?.bytesDone ?? 0) >= total;
}

/**
 * 不是這個分頁在傳的「上傳中」那一版現在是什麼情況（不是上傳中 = null）。
 * unchangedSince = 這個畫面從什麼時候開始看到它的進度沒變（本機時間；第一次看到 = 現在）
 */
export function stalledUploadKind(v: V, now: number, unchangedSince: number): StalledKind | null {
  if (v.status !== 'uploading') return null;
  const updated = parseServerTime(v.updatedAt);
  const serverQuiet = !Number.isNaN(updated) && now - updated >= STALL_SERVER_MS;
  const localQuiet = now - unchangedSince >= STALL_LOCAL_MS;
  if (!serverQuiet && !localQuiet) return 'busy';
  return allPartsSent(v) ? 'finish' : 'resume';
}

/** 單一版本的資料（GET）確認每一段都在 */
export function partsConfirmed(v: Pick<SongVideo, 'status' | 'upload'>): boolean {
  const u = v.upload;
  if (v.status !== 'uploading' || !u) return false;
  const have = new Set(u.uploadedParts);
  for (let n = 1; n <= u.partCount; n++) if (!have.has(n)) return false;
  return true;
}

export type FinishResult =
  | { kind: 'done'; video: SongVideo }
  /** 其實還有段沒傳 → 要選檔案接著傳 */
  | { kind: 'missing' }
  /** 已經不在上傳中了（別人取消 / 完成了）→ 重新抓清單就好 */
  | { kind: 'gone' }
  | { kind: 'error'; message: string };

export interface FinishDeps {
  get: (projectId: string, songId: string, videoId: string) => Promise<SongVideo>;
  complete: (projectId: string, songId: string, videoId: string) => Promise<SongVideo>;
}

const defaultDeps: FinishDeps = {
  get: getSongVideo,
  complete: (p, s, v) => completeVideoUpload(p, s, v),
};

/** 先確認每一段都在，再叫後台整理成一個檔案、給版本號 */
export async function finishStalledUpload(
  projectId: string, songId: string, videoId: string, deps: FinishDeps = defaultDeps,
): Promise<FinishResult> {
  let v: SongVideo;
  try {
    v = await deps.get(projectId, songId, videoId);
  } catch (e) {
    const s = (e as VideoApiError).status;
    if (s === 404) return { kind: 'gone' };
    return { kind: 'error', message: friendlyError(e) };
  }
  if (v.status === 'ready') return { kind: 'done', video: v };
  if (v.status !== 'uploading') return { kind: 'gone' };
  if (!partsConfirmed(v)) return { kind: 'missing' };
  try {
    const done = await deps.complete(projectId, songId, videoId);
    return done.status === 'ready' ? { kind: 'done', video: done } : { kind: 'gone' };
  } catch (e) {
    const err = e as VideoApiError;
    // 409 + missingParts = 還有段沒傳（或大小不對要重傳那一段）；409 沒有 missingParts = 已經不在上傳中
    if (err.status === 409) return Array.isArray(err.data?.missingParts) ? { kind: 'missing' } : { kind: 'gone' };
    if (err.status === 404) return { kind: 'gone' };
    return { kind: 'error', message: friendlyError(e) };
  }
}

/** 這個分頁自己在做的那幾版（有自己的進度列；版本列不用另外再列、也不用幫它完成） */
export function trackedVideoIds(jobs: readonly Pick<VideoJob, 'videoId' | 'phase'>[]): Set<string> {
  const ids = new Set<string>();
  for (const j of jobs) if (j.videoId && (isJobActive(j) || j.phase === 'failed')) ids.add(j.videoId);
  return ids;
}

/** 「繼續上傳（選同一個檔案）」選的檔案對不對（不對 → 一句話；對 → null） */
export function resumeFileProblem(v: Pick<SongVideo, 'sizeBytes'>, file: { name: string; size: number; type?: string }): string | null {
  if (!videoMimeForFile(file)) return `「${file.name}」不是 MP4 / MOV / WebM 影片`;
  if (v.sizeBytes != null && file.size !== v.sizeBytes) {
    return `「${file.name}」不是當初傳的那個檔案（大小不一樣）。要接著傳請選同一個檔案；要交新的一版請按「加影片」`;
  }
  return null;
}

/** 版本列下面那一列的一句話（pct = 已經傳了幾 %；can = 這個人能不能完成 / 繼續 / 取消） */
export function pendingUploadText(pct: number | null, view: StalledView | undefined, can: boolean): { text: string; error: boolean } {
  const p = pct != null ? ` ${pct}%` : '';
  switch (view?.kind) {
    case 'finishing':
      return { text: '每一段都傳上來了，正在整理成一個檔案…', error: false };
    case 'finishFailed':
      return { text: `每一段都傳上來了，但整理成一個檔案沒有成功：${view.error}`, error: true };
    case 'finish':
      return can
        ? { text: '每一段都傳上來了，正在整理成一個檔案…', error: false }
        : { text: '每一段都傳上來了，交這一版的人或製作打開這一頁就會自動完成', error: false };
    case 'resume': {
      const at = pct != null ? `上傳到 ${pct}% 就停了` : '上傳到一半就停了';
      return can
        ? { text: `${at}（傳的那個分頁可能關掉了）。要接著傳，請選同一個檔案`, error: false }
        : { text: `${at}，要等交這一版的人接著傳`, error: false };
    }
    default:
      return { text: `上傳中${p}（在別的分頁或別台電腦傳）`, error: false };
  }
}

// ─── 頁面用 ───

/** 畫面上那一列要怎麼寫 */
export type StalledView =
  | { kind: 'busy' }
  | { kind: 'finishing' }
  | { kind: 'finishFailed'; error: string }
  | { kind: 'finish' }   // 每一段都傳上來了，但這個人沒權限完成（等交的人 / 製作打開）
  | { kind: 'resume' };

/**
 * 導演頁、工作站：這首歌「上傳中、但不是這個分頁在傳」的那幾版。
 * 每一段都傳上來了 + 這個人可以完成（canModify）→ 自動完成一次，好了叫 onFinished（頁面重抓版本清單）。
 * trackedIds = 這個分頁正在傳的（那幾版有自己的進度列，不用管）
 */
export function useStalledUploads(o: {
  projectId: string;
  songId: string | null;
  pending: readonly SongVideo[];
  trackedIds: ReadonlySet<string>;
  canModify: (v: SongVideo) => boolean;
  onFinished: (video: SongVideo | null) => void;
}): { views: ReadonlyMap<string, StalledView>; retryFinish: (v: SongVideo) => void } {
  const { projectId, songId, pending, trackedIds } = o;
  const canRef = useRef(o.canModify);
  canRef.current = o.canModify;
  const doneRef = useRef(o.onFinished);
  doneRef.current = o.onFinished;

  // 每一版的進度從什麼時候開始沒變（這個畫面看到的）
  const seenRef = useRef(new Map<string, { bytes: number; since: number }>());
  // 自動完成過的（每一版只自動試一次；失敗了給「再試一次」）
  const triedRef = useRef(new Set<string>());
  const [finishing, setFinishing] = useState<ReadonlyMap<string, StalledView>>(new Map());
  const [now, setNow] = useState(() => Date.now());

  const watched = pending.filter(v => v.status === 'uploading' && !trackedIds.has(v.id));
  const watchedKey = watched.map(v => `${v.id}:${v.progress?.bytesDone ?? 0}`).join('|');

  // 換歌 → 重來
  useEffect(() => {
    seenRef.current = new Map();
    setFinishing(new Map());
  }, [songId]);

  // 記下進度從什麼時候開始沒變；有在看的時候每 5 秒重算一次（「在傳」→「停住了」不用等資料變）
  useEffect(() => {
    const t = Date.now();
    const seen = seenRef.current;
    for (const v of watched) {
      const bytes = v.progress?.bytesDone ?? 0;
      const prev = seen.get(v.id);
      if (!prev || prev.bytes !== bytes) seen.set(v.id, { bytes, since: t });
    }
    setNow(t);
    if (watched.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedKey]);

  const runFinish = useCallback((v: SongVideo) => {
    if (!songId) return;
    triedRef.current.add(v.id);
    setFinishing(m => new Map(m).set(v.id, { kind: 'finishing' }));
    void finishStalledUpload(projectId, songId, v.id).then((r) => {
      setFinishing(m => {
        const next = new Map(m);
        if (r.kind === 'error') next.set(v.id, { kind: 'finishFailed', error: r.message });
        else if (r.kind === 'missing') next.set(v.id, { kind: 'resume' });
        else next.delete(v.id);
        return next;
      });
      if (r.kind === 'done') doneRef.current(r.video);
      else if (r.kind === 'gone') doneRef.current(null);
    });
  }, [projectId, songId]);

  const views = new Map<string, StalledView>();
  for (const v of watched) {
    const own = finishing.get(v.id);
    if (own) { views.set(v.id, own); continue; }
    const kind = stalledUploadKind(v, now, seenRef.current.get(v.id)?.since ?? now);
    if (kind) views.set(v.id, { kind });
  }

  // 每一段都傳上來了 + 可以完成 → 自動完成（每一版一次）
  const toFinish = watched.filter(v => views.get(v.id)?.kind === 'finish' && !triedRef.current.has(v.id) && canRef.current(v));
  const toFinishKey = toFinish.map(v => v.id).join('|');
  useEffect(() => {
    for (const v of toFinish) runFinish(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toFinishKey, runFinish]);

  return { views, retryFinish: runFinish };
}
