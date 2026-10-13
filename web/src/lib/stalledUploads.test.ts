import { describe, it, expect, vi } from 'vitest';
import {
  STALL_LOCAL_MS, STALL_SERVER_MS, allPartsSent, finishStalledUpload, partsConfirmed, pendingUploadText,
  resumeFileProblem, stalledUploadKind, trackedVideoIds, type FinishDeps,
} from './stalledUploads';
import type { SongVideo, VideoApiError } from './videoApi';

const MiB = 1024 * 1024;
const T0 = Date.parse('2026-10-14T03:00:00.000Z');

function video(over: Partial<SongVideo> = {}): SongVideo {
  return {
    id: 'sv_1', projectId: 'p1', songId: 's1', version: null, label: '', title: 'S01_開場', note: '',
    source: 'upload', originalUrl: null, driveFileId: null, mime: 'video/mp4', sizeBytes: 40 * MiB,
    width: null, height: null, durationSec: null, status: 'uploading', error: null,
    progress: { bytesDone: 40 * MiB, totalBytes: 40 * MiB },
    createdBy: { id: 'u1', name: '小明' }, createdAt: '2026-10-14T02:00:00.000Z', updatedAt: '2026-10-14T03:00:00.000Z',
    readyAt: null, isLatest: false, streamUrl: null,
    ...over,
  } as SongVideo;
}

const apiError = (status: number, data: Record<string, unknown> = {}) =>
  Object.assign(new Error('x'), { status, data }) as VideoApiError;

describe('上傳停住的那一版是什麼情況', () => {
  it('每一段都傳上來了 = 已經傳的 bytes 等於檔案大小', () => {
    expect(allPartsSent(video())).toBe(true);
    expect(allPartsSent(video({ progress: { bytesDone: 20 * MiB, totalBytes: 40 * MiB } }))).toBe(false);
    expect(allPartsSent(video({ status: 'processing' }))).toBe(false);
    expect(allPartsSent(video({ progress: null, sizeBytes: null }))).toBe(false);
  });

  it('剛剛還有在動（後台 60 秒內更新過、這個畫面也還沒看 30 秒）→ 在傳，先不動它', () => {
    expect(stalledUploadKind(video(), T0 + 10_000, T0 + 5_000)).toBe('busy');
  });

  it('後台超過 60 秒沒動 + 每一段都在 → 只差整理成一個檔案', () => {
    expect(stalledUploadKind(video(), T0 + STALL_SERVER_MS, T0 + STALL_SERVER_MS)).toBe('finish');
  });

  it('還有段沒傳 → 要選同一個檔案接著傳', () => {
    const v = video({ progress: { bytesDone: 16 * MiB, totalBytes: 40 * MiB } });
    expect(stalledUploadKind(v, T0 + 2 * 86400_000, T0 + 2 * 86400_000)).toBe('resume');
  });

  it('電腦時間跟伺服器對不上也沒關係：這個畫面看著 30 秒都沒前進就算停住了', () => {
    // 這台電腦的時間比伺服器慢 → 後台看起來「剛剛才更新」
    const now = T0 - 5 * 60_000;
    expect(stalledUploadKind(video(), now, now)).toBe('busy');
    expect(stalledUploadKind(video(), now + STALL_LOCAL_MS, now)).toBe('finish');
  });

  it('不是上傳中 → 不管', () => {
    expect(stalledUploadKind(video({ status: 'processing' }), T0 + 999_999, T0)).toBeNull();
    expect(stalledUploadKind(video({ status: 'ready' }), T0 + 999_999, T0)).toBeNull();
  });

  it('單一版本的資料：1 ~ partCount 每一段都在才算數', () => {
    expect(partsConfirmed(video({ upload: { partSize: 16 * MiB, partCount: 3, uploadedParts: [3, 1, 2], maxConcurrency: 3 } }))).toBe(true);
    expect(partsConfirmed(video({ upload: { partSize: 16 * MiB, partCount: 3, uploadedParts: [1, 3], maxConcurrency: 3 } }))).toBe(false);
    expect(partsConfirmed(video({ upload: undefined }))).toBe(false);
  });
});

describe('自動完成（每一段都傳上來了）', () => {
  const allIn = video({ upload: { partSize: 16 * MiB, partCount: 3, uploadedParts: [1, 2, 3], maxConcurrency: 3 } });

  it('確認每一段都在 → 叫後台完成 → 拿到 V3', async () => {
    const deps: FinishDeps = {
      get: vi.fn(async () => allIn),
      complete: vi.fn(async () => video({ status: 'ready', version: 3, label: 'V3' })),
    };
    const r = await finishStalledUpload('p1', 's1', 'sv_1', deps);
    expect(r).toMatchObject({ kind: 'done', video: { label: 'V3' } });
    expect(deps.complete).toHaveBeenCalledWith('p1', 's1', 'sv_1');
  });

  it('其實還有段沒傳 → 不叫完成，改成「繼續上傳」', async () => {
    const deps: FinishDeps = {
      get: vi.fn(async () => video({ upload: { partSize: 16 * MiB, partCount: 3, uploadedParts: [1, 2], maxConcurrency: 3 } })),
      complete: vi.fn(),
    };
    expect(await finishStalledUpload('p1', 's1', 'sv_1', deps)).toEqual({ kind: 'missing' });
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it('後台說還缺哪幾段（409 missingParts）→ 繼續上傳；409 沒有 missingParts = 已經不在上傳中', async () => {
    const missing: FinishDeps = { get: async () => allIn, complete: async () => { throw apiError(409, { missingParts: [2] }); } };
    expect(await finishStalledUpload('p1', 's1', 'sv_1', missing)).toEqual({ kind: 'missing' });
    const notUploading: FinishDeps = { get: async () => allIn, complete: async () => { throw apiError(409, { status: 'failed' }); } };
    expect(await finishStalledUpload('p1', 's1', 'sv_1', notUploading)).toEqual({ kind: 'gone' });
  });

  it('別人剛好已經完成了 / 取消了 → 不用做，重新抓清單', async () => {
    const ready: FinishDeps = { get: async () => video({ status: 'ready', version: 3, label: 'V3' }), complete: vi.fn() };
    expect((await finishStalledUpload('p1', 's1', 'sv_1', ready)).kind).toBe('done');
    const gone: FinishDeps = { get: async () => { throw apiError(404); }, complete: vi.fn() };
    expect(await finishStalledUpload('p1', 's1', 'sv_1', gone)).toEqual({ kind: 'gone' });
  });

  it('網路一時不通 / 合併失敗 → 說原因，給「再試一次」', async () => {
    const deps: FinishDeps = { get: async () => allIn, complete: async () => { throw apiError(502, {}); } };
    const r = await finishStalledUpload('p1', 's1', 'sv_1', deps);
    expect(r.kind).toBe('error');
  });
});

describe('版本列下面那一列怎麼寫', () => {
  it('在傳 / 整理中 / 整理失敗', () => {
    expect(pendingUploadText(44, undefined, true).text).toBe('上傳中 44%（在別的分頁或別台電腦傳）');
    expect(pendingUploadText(100, { kind: 'busy' }, true).text).toBe('上傳中 100%（在別的分頁或別台電腦傳）');
    expect(pendingUploadText(100, { kind: 'finishing' }, true).text).toBe('每一段都傳上來了，正在整理成一個檔案…');
    const failed = pendingUploadText(100, { kind: 'finishFailed', error: '連不上伺服器' }, true);
    expect(failed).toEqual({ text: '每一段都傳上來了，但整理成一個檔案沒有成功：連不上伺服器', error: true });
  });

  it('停住了：自己傳的 → 叫你選同一個檔案；別人（導演）看 → 等交的人', () => {
    expect(pendingUploadText(44, { kind: 'resume' }, true).text).toBe('上傳到 44% 就停了（傳的那個分頁可能關掉了）。要接著傳，請選同一個檔案');
    expect(pendingUploadText(44, { kind: 'resume' }, false).text).toBe('上傳到 44% 就停了，要等交這一版的人接著傳');
    expect(pendingUploadText(100, { kind: 'finish' }, false).text).toBe('每一段都傳上來了，交這一版的人或製作打開這一頁就會自動完成');
  });

  it('選的檔案不對（大小不一樣 / 不是影片）→ 說清楚，不會開一個新的上傳', () => {
    const v = video();
    expect(resumeFileProblem(v, { name: 'S01_開場.mp4', size: 40 * MiB, type: 'video/mp4' })).toBeNull();
    expect(resumeFileProblem(v, { name: 'S01_開場_v2.mp4', size: 41 * MiB, type: 'video/mp4' })).toContain('不是當初傳的那個檔案');
    expect(resumeFileProblem(v, { name: 'a.mkv', size: 40 * MiB, type: 'video/x-matroska' })).toContain('不是 MP4 / MOV / WebM');
  });

  it('這個分頁自己在傳 / 失敗待重試的那幾版不用另外列', () => {
    const ids = trackedVideoIds([
      { videoId: 'sv_1', phase: 'uploading' },
      { videoId: 'sv_2', phase: 'failed' },
      { videoId: 'sv_3', phase: 'done' },
      { videoId: null, phase: 'starting' },
    ]);
    expect([...ids].sort()).toEqual(['sv_1', 'sv_2']);
  });
});
