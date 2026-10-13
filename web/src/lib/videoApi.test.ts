import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  videoMimeForFile, partRange, partsToUpload, uploadResumeKey, absoluteVideoUrl,
  videoStatusLabel, videoProgressPercent, uploadSongVideo, pasteVideoLink, listSongVideos,
  type SongVideo,
} from './videoApi';

const MiB = 1024 * 1024;

function video(over: Partial<SongVideo> = {}): SongVideo {
  return {
    id: 'sv_1', projectId: 'p1', songId: 's1', version: null, label: '', title: 'a', note: '', source: 'upload',
    originalUrl: null, driveFileId: null, mime: 'video/mp4', sizeBytes: null, width: null, height: null, durationSec: null,
    status: 'uploading', error: null, progress: null, createdBy: null, createdAt: '', updatedAt: '', readyAt: null,
    isLatest: false, streamUrl: null, ...over,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); });

describe('小工具', () => {
  it('檔案類型：類型寫清楚看類型，沒寫看副檔名；mkv 不收', () => {
    expect(videoMimeForFile({ name: 'a.mp4', type: 'video/mp4' })).toBe('video/mp4');
    expect(videoMimeForFile({ name: 'a.MOV', type: '' })).toBe('video/quicktime');
    expect(videoMimeForFile({ name: 'a.webm', type: 'application/octet-stream' })).toBe('video/webm');
    expect(videoMimeForFile({ name: 'a.m4v', type: 'video/x-m4v' })).toBe('video/mp4');
    expect(videoMimeForFile({ name: 'a.mkv', type: 'video/x-matroska' })).toBeNull();
    expect(videoMimeForFile({ name: 'a.mp4', type: 'image/png' })).toBeNull();
  });
  it('切段 / 還沒傳的段 / 續傳 key', () => {
    expect(partRange(1, 16 * MiB, 40 * MiB)).toEqual({ start: 0, end: 16 * MiB });
    expect(partRange(3, 16 * MiB, 40 * MiB)).toEqual({ start: 32 * MiB, end: 40 * MiB });
    expect(partsToUpload({ partCount: 4, uploadedParts: [1, 3] })).toEqual([2, 4]);
    expect(uploadResumeKey('p1', 's1', { name: 'a.mp4', size: 9, lastModified: 5 })).toBe('sp_video_upload:p1:s1:a.mp4:9:5');
  });
  it('播放網址接上後台網址；已經是完整網址就不動', () => {
    expect(absoluteVideoUrl('/api/videos/sv_1/stream?pass=x')).toBe('https://proxy.haimiaan.com/api/videos/sv_1/stream?pass=x');
    expect(absoluteVideoUrl('https://x.test/v.mp4')).toBe('https://x.test/v.mp4');
  });
  it('狀態中文、進度', () => {
    expect(videoStatusLabel({ status: 'processing', source: 'drive' })).toBe('從 Drive 複製中');
    expect(videoStatusLabel({ status: 'ready', source: 'upload' })).toBe('可以播');
    expect(videoProgressPercent({ status: 'uploading', progress: { bytesDone: 50, totalBytes: 200 } })).toBe(25);
    expect(videoProgressPercent({ status: 'ready', progress: null })).toBe(100);
    expect(videoProgressPercent({ status: 'processing', progress: { bytesDone: 5, totalBytes: null } })).toBeNull();
  });
});

describe('呼叫後台', () => {
  it('錯誤帶中文訊息和狀態碼', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { error: '不收 YouTube / Vimeo 這類影音網站的連結' })));
    await expect(pasteVideoLink('p1', 's1', { url: 'https://youtu.be/x' })).rejects.toMatchObject({
      status: 400, message: '不收 YouTube / Vimeo 這類影音網站的連結',
    });
  });

  it('清單的網址', async () => {
    const f = vi.fn(async () => json(200, { videos: [], latestVideoId: null, songCode: 'S01' }));
    vi.stubGlobal('fetch', f);
    expect(await listSongVideos('p 1', 's1')).toEqual({ videos: [], latestVideoId: null, songCode: 'S01' });
    expect((f.mock.calls[0] as unknown[])[0]).toBe('https://proxy.haimiaan.com/api/projects/p%201/songs/s1/videos');
  });

  it('整個上傳：續傳跳過傳好的段、失敗的段重試、最後完成', async () => {
    const size = 40 * MiB + 7;
    const file = new File([new Uint8Array(size)], 'S01_open.mp4', { type: 'video/mp4' });
    const upload = { partSize: 16 * MiB, partCount: 3, uploadedParts: [1], maxConcurrency: 3 };
    const puts: number[] = [];
    let failOnce = true;
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'GET' && url.endsWith('/videos/sv_1')) {
        return json(200, { video: video({ sizeBytes: size, upload, progress: { bytesDone: 16 * MiB, totalBytes: size } }) });
      }
      const m = /\/parts\/(\d+)$/.exec(url);
      if (method === 'PUT' && m) {
        const n = Number(m[1]);
        const len = (init!.body as Blob).size;
        expect(len).toBe(n < 3 ? 16 * MiB : size - 32 * MiB);
        if (n === 2 && failOnce) { failOnce = false; return json(502, { error: '第 2 段沒有傳成功' }); }
        puts.push(n);
        return json(200, { ok: true, partNumber: n, etag: 'e' + n, bytesDone: null, totalBytes: size });
      }
      if (method === 'POST' && url.endsWith('/complete')) {
        return json(200, { video: video({ status: 'ready', version: 1, label: 'V1', streamUrl: '/api/videos/sv_1/stream?pass=x' }) });
      }
      throw new Error('unexpected ' + method + ' ' + url);
    });
    vi.stubGlobal('fetch', f);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const progress: number[] = [];
    const p = uploadSongVideo('p1', 's1', file, { resumeVideoId: 'sv_1', onProgress: (x) => progress.push(x.bytesDone) });
    await vi.runAllTimersAsync();
    const v = await p;
    vi.useRealTimers();
    expect(v.version).toBe(1);
    expect(puts.sort()).toEqual([2, 3]);
    expect(progress.at(-1)).toBe(size);
  });

  it('不收的格式在送出前就擋下來', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const file = new File([new Uint8Array(10)], 'a.mkv', { type: 'video/x-matroska' });
    await expect(uploadSongVideo('p1', 's1', file)).rejects.toMatchObject({ status: 415 });
    expect(f).not.toHaveBeenCalled();
  });
});
