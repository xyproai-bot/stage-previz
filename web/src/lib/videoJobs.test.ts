import { describe, it, expect, vi } from 'vitest';
import {
  createVideoJobStore, formatMB, isJobActive, jobBlocksUnload, jobPercent, jobReducer, jobStatusText,
  type VideoJob, type VideoJobDeps,
} from './videoJobs';
import type { SongVideo, UploadSongVideoOptions, VideoApiError } from './videoApi';

const MiB = 1024 * 1024;

function job(over: Partial<VideoJob> = {}): VideoJob {
  return {
    id: 'job1', kind: 'upload', projectId: 'p1', songId: 's1', songLabel: 'S01 開場', name: 'a.mp4', note: '',
    phase: 'starting', bytesDone: 0, totalBytes: 40 * MiB, videoId: null, error: null, result: null, retryable: true,
    ...over,
  };
}

function video(over: Partial<SongVideo> = {}): SongVideo {
  return {
    id: 'sv_1', projectId: 'p1', songId: 's1', version: null, label: '', title: 'a', note: '', source: 'upload',
    originalUrl: null, driveFileId: null, mime: 'video/mp4', sizeBytes: 40 * MiB, width: null, height: null, durationSec: null,
    status: 'uploading', error: null, progress: null, createdBy: null, createdAt: '', updatedAt: '', readyAt: null,
    isLatest: false, streamUrl: null, ...over,
  };
}

function apiError(status: number, message: string, data: Record<string, unknown> = {}): VideoApiError {
  const e = new Error(message) as VideoApiError;
  e.status = status;
  e.data = data;
  return e;
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('jobReducer：上傳的狀態怎麼變', () => {
  it('開始 → 上傳中 → 整理中 → 好了（拿到版本號）', () => {
    let j = job();
    j = jobReducer(j, { type: 'created', videoId: 'sv_1', totalBytes: 40 * MiB });
    expect(j).toMatchObject({ phase: 'uploading', videoId: 'sv_1' });
    j = jobReducer(j, { type: 'progress', bytesDone: 16 * MiB });
    expect(jobPercent(j)).toBe(40);
    j = jobReducer(j, { type: 'finishing' });
    expect(j.phase).toBe('finishing');
    j = jobReducer(j, { type: 'done', video: video({ status: 'ready', version: 3, label: 'V3' }) });
    expect(j.phase).toBe('done');
    expect(j.result?.label).toBe('V3');
    expect(jobPercent(j)).toBe(100);
    expect(jobStatusText(j)).toBe('完成，變成 V3');
  });

  it('好幾段同時傳，進度回來順序亂也只往前走、不超過總大小', () => {
    let j = jobReducer(job(), { type: 'created', videoId: 'sv_1' });
    j = jobReducer(j, { type: 'progress', bytesDone: 32 * MiB });
    j = jobReducer(j, { type: 'progress', bytesDone: 16 * MiB });
    expect(j.bytesDone).toBe(32 * MiB);
    j = jobReducer(j, { type: 'progress', bytesDone: 99 * MiB });
    expect(j.bytesDone).toBe(40 * MiB);
  });

  it('貼連結：開始後是「複製中」', () => {
    let j = jobReducer(job({ kind: 'link', totalBytes: null }), { type: 'created', videoId: 'sv_2' });
    expect(j.phase).toBe('copying');
    expect(jobStatusText(j)).toBe('複製中…');
    j = jobReducer(j, { type: 'progress', bytesDone: 30, totalBytes: 100 });
    expect(jobStatusText(j)).toContain('複製中 30%');
    // 複製中不會跳到「整理中」
    expect(jobReducer(j, { type: 'finishing' })).toBe(j);
  });

  it('取消之後的進度、失敗、完成都不理', () => {
    let j = jobReducer(job(), { type: 'created', videoId: 'sv_1' });
    j = jobReducer(j, { type: 'cancel' });
    expect(j.phase).toBe('canceled');
    expect(jobReducer(j, { type: 'progress', bytesDone: 1 })).toBe(j);
    expect(jobReducer(j, { type: 'failed', error: 'x' })).toBe(j);
    expect(jobReducer(j, { type: 'done', video: video() })).toBe(j);
    expect(jobReducer(j, { type: 'retry' })).toBe(j);
    expect(isJobActive(j)).toBe(false);
  });

  it('失敗 → 重試：已經建好的續傳（上傳中），還沒建好的從頭', () => {
    const started = jobReducer(jobReducer(job(), { type: 'created', videoId: 'sv_1' }), { type: 'failed', error: '網路斷了' });
    expect(started).toMatchObject({ phase: 'failed', error: '網路斷了' });
    expect(jobStatusText(started)).toBe('網路斷了');
    expect(jobReducer(started, { type: 'retry' })).toMatchObject({ phase: 'uploading', error: null, videoId: 'sv_1' });
    const early = jobReducer(job(), { type: 'failed', error: 'x' });
    expect(jobReducer(early, { type: 'retry' }).phase).toBe('starting');
    // 不能重試的（格式不收）按了也沒用
    const fatal = jobReducer(job(), { type: 'failed', error: '只收 MP4', retryable: false });
    expect(jobReducer(fatal, { type: 'retry' })).toBe(fatal);
  });

  it('好了之後不會再變成失敗', () => {
    const done = jobReducer(jobReducer(job(), { type: 'created', videoId: 'sv_1' }), { type: 'done', video: video({ status: 'ready' }) });
    expect(jobReducer(done, { type: 'failed', error: 'x' })).toBe(done);
    expect(jobReducer(done, { type: 'cancel' })).toBe(done);
  });

  it('關分頁要不要先問：只有瀏覽器正在傳檔案時', () => {
    expect(jobBlocksUnload(job({ phase: 'uploading' }))).toBe(true);
    expect(jobBlocksUnload(job({ phase: 'finishing' }))).toBe(true);
    expect(jobBlocksUnload(job({ phase: 'done' }))).toBe(false);
    expect(jobBlocksUnload(job({ phase: 'failed' }))).toBe(false);
    expect(jobBlocksUnload(job({ kind: 'link', phase: 'copying' }))).toBe(false);
  });

  it('文字：百分比 + MB', () => {
    const j = job({ phase: 'uploading', bytesDone: 12.34 * MiB, totalBytes: 27.1 * MiB });
    expect(jobStatusText(j)).toBe('上傳中 45%（12.3 MB / 27.1 MB）');
    expect(formatMB(512 * MiB)).toBe('512 MB');
    expect(jobPercent(job({ totalBytes: null }))).toBeNull();
  });
});

function fakeDeps(over: Partial<VideoJobDeps> = {}) {
  const store = new Map<string, string>();
  const deps: VideoJobDeps = {
    upload: vi.fn(),
    abort: vi.fn(async () => {}),
    paste: vi.fn(),
    get: vi.fn(),
    retryLink: vi.fn(),
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => { store.set(k, v); },
      removeItem: (k) => { store.delete(k); },
    },
    sleep: () => Promise.resolve(),
    ...over,
  };
  return { deps, store };
}

const file = (name = 'S01_開場.mp4', size = 40 * MiB) => ({ name, size, type: 'video/mp4', lastModified: 1 }) as unknown as File;

describe('createVideoJobStore：上傳', () => {
  it('上傳好了 → 通知一次、續傳記錄清掉', async () => {
    let started: ((v: SongVideo) => void) | undefined;
    let finish: ((v: SongVideo) => void) | undefined;
    const { deps, store } = fakeDeps({
      upload: vi.fn((_p, _s, _f, opts: UploadSongVideoOptions) => {
        started = opts.onStarted;
        return new Promise<SongVideo>((res) => { finish = res; });
      }),
    });
    const s = createVideoJobStore(deps);
    const done = vi.fn();
    s.onDone(done);
    const id = s.startUpload({ projectId: 'p1', songId: 's1', songLabel: 'S01', file: file(), note: ' 修了轉場 ' });
    expect(s.getSnapshot()[0]).toMatchObject({ id, phase: 'starting', note: '修了轉場' });
    expect(s.anyBlockingUnload()).toBe(true);
    started!(video({ id: 'sv_9' }));
    expect(s.getSnapshot()[0]).toMatchObject({ phase: 'uploading', videoId: 'sv_9' });
    expect([...store.values()]).toEqual(['sv_9']);
    finish!(video({ id: 'sv_9', status: 'ready', version: 2, label: 'V2' }));
    await flush();
    expect(s.getSnapshot()[0].phase).toBe('done');
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0][0].result.label).toBe('V2');
    expect(store.size).toBe(0);
    expect(s.anyBlockingUnload()).toBe(false);
  });

  it('上次沒傳完的同一個檔案 → 帶著那一版 id 續傳', async () => {
    const { deps, store } = fakeDeps({ upload: vi.fn(async () => video({ status: 'ready', version: 1 })) });
    store.set('sp_video_upload:p1:s1:S01_開場.mp4:41943040:1', 'sv_old');
    const s = createVideoJobStore(deps);
    s.startUpload({ projectId: 'p1', songId: 's1', songLabel: 'S01', file: file() });
    await flush();
    expect((deps.upload as ReturnType<typeof vi.fn>).mock.calls[0][3].resumeVideoId).toBe('sv_old');
  });

  it('失敗顯示中文原因；重試 → 續傳同一版', async () => {
    const calls: UploadSongVideoOptions[] = [];
    const { deps } = fakeDeps({
      upload: vi.fn(async (_p, _s, _f, opts: UploadSongVideoOptions) => {
        calls.push(opts);
        if (calls.length === 1) {
          opts.onStarted?.(video({ id: 'sv_5' }));
          throw new TypeError('Failed to fetch');
        }
        return video({ id: 'sv_5', status: 'ready', version: 1, label: 'V1' });
      }),
    });
    const s = createVideoJobStore(deps);
    const id = s.startUpload({ projectId: 'p1', songId: 's1', songLabel: 'S01', file: file() });
    await flush();
    expect(s.getSnapshot()[0]).toMatchObject({ phase: 'failed', error: '連不上伺服器，請檢查網路後再試', retryable: true });
    s.retry(id);
    await flush();
    expect(calls[1].resumeVideoId).toBe('sv_5');
    expect(s.getSnapshot()[0].phase).toBe('done');
  });

  it('格式不收（415）不能重試', async () => {
    const { deps } = fakeDeps({ upload: vi.fn(async () => { throw apiError(415, '只收 MP4 / MOV / WebM 影片'); }) });
    const s = createVideoJobStore(deps);
    s.startUpload({ projectId: 'p1', songId: 's1', songLabel: 'S01', file: file('a.mkv') });
    await flush();
    expect(s.getSnapshot()[0]).toMatchObject({ phase: 'failed', error: '只收 MP4 / MOV / WebM 影片', retryable: false });
  });

  it('取消：停下來、後台也取消（號碼不會被佔走）、不會變成失敗', async () => {
    let signal: AbortSignal | undefined;
    const { deps, store } = fakeDeps({
      upload: vi.fn((_p, _s, _f, opts: UploadSongVideoOptions) => {
        signal = opts.signal;
        opts.onStarted?.(video({ id: 'sv_7' }));
        return new Promise<SongVideo>((_res, rej) => {
          opts.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
        });
      }),
    });
    const s = createVideoJobStore(deps);
    const done = vi.fn();
    s.onDone(done);
    const id = s.startUpload({ projectId: 'p1', songId: 's1', songLabel: 'S01', file: file() });
    await s.cancel(id);
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(deps.abort).toHaveBeenCalledWith('p1', 's1', 'sv_7');
    expect(s.getSnapshot()[0].phase).toBe('canceled');
    expect(store.size).toBe(0);
    expect(done).not.toHaveBeenCalled();
    s.dismiss(id);
    expect(s.getSnapshot()).toHaveLength(0);
  });

  it('還在做的不能拿掉', () => {
    const { deps } = fakeDeps({ upload: vi.fn(() => new Promise<SongVideo>(() => {})) });
    const s = createVideoJobStore(deps);
    const id = s.startUpload({ projectId: 'p1', songId: 's1', songLabel: 'S01', file: file() });
    s.dismiss(id);
    expect(s.getSnapshot()).toHaveLength(1);
  });
});

describe('createVideoJobStore：貼連結', () => {
  it('連結有問題 → 直接丟後台的中文說明（不建工作）', async () => {
    const { deps } = fakeDeps({ paste: vi.fn(async () => { throw apiError(400, '這是 Drive 資料夾的連結，請貼單一影片檔的連結'); }) });
    const s = createVideoJobStore(deps);
    await expect(s.addLink({ projectId: 'p1', songId: 's1', songLabel: 'S01', url: 'https://drive.google.com/drive/folders/x' }))
      .rejects.toThrow('這是 Drive 資料夾的連結');
    expect(s.getSnapshot()).toHaveLength(0);
  });

  it('複製中每幾秒查一次進度，好了通知', async () => {
    const states = [
      video({ id: 'sv_l', status: 'processing', progress: { bytesDone: 30, totalBytes: 100 } }),
      video({ id: 'sv_l', status: 'ready', version: 4, label: 'V4' }),
    ];
    const { deps } = fakeDeps({
      paste: vi.fn(async () => ({ video: video({ id: 'sv_l', status: 'processing', progress: { bytesDone: 0, totalBytes: 100 } }), duplicate: false })),
      get: vi.fn(async () => states.shift()!),
    });
    const s = createVideoJobStore(deps);
    const done = vi.fn();
    s.onDone(done);
    const seen: string[] = [];
    s.subscribe(() => { const j = s.getSnapshot()[0]; if (j) seen.push(jobStatusText(j)); });
    await s.addLink({ projectId: 'p1', songId: 's1', songLabel: 'S01', url: ' https://example.com/a.mp4 ', note: '試看' });
    await flush(); await flush();
    expect(seen).toContain('複製中 30%（0.0 MB / 0.0 MB）');
    expect(s.getSnapshot()[0]).toMatchObject({ phase: 'done', name: 'https://example.com/a.mp4' });
    expect(done.mock.calls[0][0].result.label).toBe('V4');
    expect(deps.paste).toHaveBeenCalledWith('p1', 's1', { url: 'https://example.com/a.mp4', note: '試看' });
  });

  it('後台複製失敗 → 顯示原因；重試 → 後台重新複製再接著等', async () => {
    const { deps } = fakeDeps({
      paste: vi.fn(async () => ({ video: video({ id: 'sv_f', status: 'processing' }), duplicate: false })),
      get: vi.fn()
        .mockResolvedValueOnce(video({ id: 'sv_f', status: 'failed', error: '來源打不開了（404）' }))
        .mockResolvedValueOnce(video({ id: 'sv_f', status: 'ready', version: 1, label: 'V1' })),
      retryLink: vi.fn(async () => video({ id: 'sv_f', status: 'processing' })),
    });
    const s = createVideoJobStore(deps);
    const id = await s.addLink({ projectId: 'p1', songId: 's1', songLabel: 'S01', url: 'https://example.com/a.mp4' });
    await flush();
    expect(s.getSnapshot()[0]).toMatchObject({ phase: 'failed', error: '來源打不開了（404）' });
    s.retry(id);
    await flush(); await flush();
    expect(deps.retryLink).toHaveBeenCalledWith('p1', 's1', 'sv_f');
    expect(s.getSnapshot()[0].phase).toBe('done');
  });

  it('查進度時網路一時不通 → 不算失敗，等一下再查', async () => {
    const { deps } = fakeDeps({
      paste: vi.fn(async () => ({ video: video({ id: 'sv_n', status: 'processing' }), duplicate: false })),
      get: vi.fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(video({ id: 'sv_n', status: 'ready', version: 2, label: 'V2' })),
    });
    const s = createVideoJobStore(deps);
    await s.addLink({ projectId: 'p1', songId: 's1', songLabel: 'S01', url: 'https://example.com/a.mp4' });
    await flush(); await flush();
    expect(s.getSnapshot()[0].phase).toBe('done');
  });

  it('同一個連結還在複製又貼一次 → 沿用原本那一列', async () => {
    const { deps } = fakeDeps({
      paste: vi.fn(async () => ({ video: video({ id: 'sv_d', status: 'processing' }), duplicate: true })),
      get: vi.fn(() => new Promise<SongVideo>(() => {})),
    });
    const s = createVideoJobStore(deps);
    const a = await s.addLink({ projectId: 'p1', songId: 's1', songLabel: 'S01', url: 'https://example.com/a.mp4' });
    const b = await s.addLink({ projectId: 'p1', songId: 's1', songLabel: 'S01', url: 'https://example.com/a.mp4' });
    expect(a).toBe(b);
    expect(s.getSnapshot()).toHaveLength(1);
  });

  it('取消複製 → 後台也取消', async () => {
    const { deps } = fakeDeps({
      paste: vi.fn(async () => ({ video: video({ id: 'sv_c', status: 'processing' }), duplicate: false })),
      get: vi.fn(async () => video({ id: 'sv_c', status: 'processing' })),
      sleep: (_ms, signal) => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))),
    });
    const s = createVideoJobStore(deps);
    const id = await s.addLink({ projectId: 'p1', songId: 's1', songLabel: 'S01', url: 'https://example.com/a.mp4' });
    await flush();
    await s.cancel(id);
    expect(deps.abort).toHaveBeenCalledWith('p1', 's1', 'sv_c');
    expect(s.getSnapshot()[0].phase).toBe('canceled');
  });
});
