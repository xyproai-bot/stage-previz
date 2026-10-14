import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  videoMimeForFile, partRange, partsToUpload, uploadResumeKey, absoluteVideoUrl,
  videoStatusLabel, videoProgressPercent, uploadSongVideo, pasteVideoLink, listSongVideos,
  createUploadProgress, uploadVideoPart,
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

/**
 * 假的 XMLHttpRequest（分段上傳用它，才有傳到一半的進度）。
 *   auto 有設定：送出後自己回報 4 次進度再回應（reply 決定成功 / 失敗 / 網路斷）
 *   auto 沒設定：測試自己叫 progress() / respond() / networkError()
 */
type AutoReply = { status: number; body: unknown } | 'network';
class FakeXHR {
  static instances: FakeXHR[] = [];
  static auto: ((method: string, url: string, body: Blob) => AutoReply) | null = null;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  withCredentials = false;
  status = 0;
  responseText = '';
  body: Blob | null = null;
  aborted = false;
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  get part(): number { return Number(/\/parts\/(\d+)$/.exec(this.url)?.[1] ?? 0); }
  send(body: Blob) {
    this.body = body;
    FakeXHR.instances.push(this);
    const auto = FakeXHR.auto;
    if (!auto) return;
    void (async () => {
      const reply = auto(this.method, this.url, body);
      for (let i = 1; i <= 4; i++) {
        await Promise.resolve();
        if (this.aborted) return;
        this.progress(Math.round((body.size * i) / 4));
      }
      await Promise.resolve();
      if (this.aborted) return;
      if (reply === 'network') this.networkError();
      else this.respond(reply.status, reply.body);
    })();
  }
  progress(loaded: number) { this.upload.onprogress?.({ loaded, total: this.body?.size ?? 0, lengthComputable: true }); }
  respond(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.(); }
  networkError() { this.onerror?.(); }
  abort() { this.aborted = true; this.onabort?.(); }
}

function useFakeXhr(auto: typeof FakeXHR.auto = null) {
  FakeXHR.instances = [];
  FakeXHR.auto = auto;
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
}

/** 等非同步的步驟跑完（真的計時器） */
async function waitFor(cond: () => boolean, tries = 50) {
  for (let i = 0; i < tries && !cond(); i++) await new Promise(r => setTimeout(r, 0));
  if (!cond()) throw new Error('waitFor timed out');
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('小工具', () => {
  it('檔案類型：類型寫清楚看類型，沒寫看副檔名；mkv 不收', () => {
    expect(videoMimeForFile({ name: 'a.mp4', type: 'video/mp4' })).toBe('video/mp4');
    expect(videoMimeForFile({ name: 'a.MOV', type: '' })).toBe('video/quicktime');
    expect(videoMimeForFile({ name: 'a.mov', type: 'video/mov' })).toBe('video/quicktime');
    expect(videoMimeForFile({ name: 'a.mov', type: 'video/x-quicktime' })).toBe('video/quicktime');
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

  it('整個上傳：續傳跳過傳好的段、失敗的段重試（後台錯誤、網路斷掉都會重試）、最後完成', async () => {
    const size = 40 * MiB + 7;
    const file = new File([new Uint8Array(size)], 'S01_open.mp4', { type: 'video/mp4' });
    const upload = { partSize: 16 * MiB, partCount: 3, uploadedParts: [1], maxConcurrency: 3 };
    const puts: number[] = [];
    let fail2 = true;
    let fail3 = true;
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'GET' && url.endsWith('/videos/sv_1')) {
        return json(200, { video: video({ sizeBytes: size, upload, progress: { bytesDone: 16 * MiB, totalBytes: size } }) });
      }
      if (method === 'POST' && url.endsWith('/complete')) {
        return json(200, { video: video({ status: 'ready', version: 1, label: 'V1', streamUrl: '/api/videos/sv_1/stream?pass=x' }) });
      }
      throw new Error('unexpected ' + method + ' ' + url);
    });
    vi.stubGlobal('fetch', f);
    useFakeXhr((method, url, body) => {
      const n = Number(/\/parts\/(\d+)$/.exec(url)?.[1]);
      expect(method).toBe('PUT');
      expect(body.size).toBe(n < 3 ? 16 * MiB : size - 32 * MiB);
      if (n === 2 && fail2) { fail2 = false; return { status: 502, body: { error: '第 2 段沒有傳成功' } }; }
      if (n === 3 && fail3) { fail3 = false; return 'network'; }
      puts.push(n);
      return { status: 200, body: { ok: true, partNumber: n, etag: 'e' + n, bytesDone: null, totalBytes: size } };
    });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const progress: number[] = [];
    const p = uploadSongVideo('p1', 's1', file, { resumeVideoId: 'sv_1', onProgress: (x) => progress.push(x.bytesDone) });
    await vi.runAllTimersAsync();
    const v = await p;
    vi.useRealTimers();
    expect(v.version).toBe(1);
    expect(puts.sort()).toEqual([2, 3]);
    // 失敗的段重傳時，進度不會倒退
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress[0]).toBeGreaterThan(16 * MiB);  // 從續傳的地方開始
    expect(progress.at(-1)).toBe(size);
    const x = FakeXHR.instances[0];
    expect(x.url).toBe('https://proxy.haimiaan.com/api/projects/p1/songs/s1/videos/sv_1/parts/' + x.part);
    expect(x.headers['Content-Type']).toBe('application/octet-stream');
    expect(x.withCredentials).toBe(true);
  });

  it('傳到一半就有進度：同時傳的好幾段加起來，一直往前、最後一段確認前停在 99%', async () => {
    const size = 40 * MiB + 7;
    const file = new File([new Uint8Array(size)], 'S02.mp4', { type: 'video/mp4' });
    const created = video({ sizeBytes: size, upload: { partSize: 16 * MiB, partCount: 3, uploadedParts: [], maxConcurrency: 3 }, progress: { bytesDone: 0, totalBytes: size } });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = (init?.method || 'GET').toUpperCase();
      if (method === 'POST' && url.endsWith('/uploads')) return json(200, { video: created });
      if (method === 'POST' && url.endsWith('/complete')) return json(200, { video: video({ status: 'ready', version: 2, label: 'V2' }) });
      throw new Error('unexpected ' + method + ' ' + url);
    }));
    useFakeXhr();
    // 每次看時間都過了 1 秒 → 每個進度都會回報（實際上最多每 0.1 秒一次）
    let t = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 1000));
    const progress: number[] = [];
    const p = uploadSongVideo('p1', 's1', file, { meta: {}, onProgress: (x) => progress.push(x.bytesDone) });
    await waitFor(() => FakeXHR.instances.length === 3);
    const [x1, x2, x3] = [1, 2, 3].map(n => FakeXHR.instances.find(x => x.part === n)!);
    const ok = (n: number, done: number) => ({ ok: true, partNumber: n, etag: 'e' + n, bytesDone: done, totalBytes: size });
    x1.progress(4 * MiB);
    x2.progress(8 * MiB);
    x3.progress(2 * MiB);
    x2.respond(200, ok(2, 16 * MiB));
    await waitFor(() => progress.length >= 4);
    x1.progress(16 * MiB);
    x1.respond(200, ok(1, 32 * MiB));
    x3.progress(8 * MiB + 7);  // 全部送出了，但後台還沒說收到 → 不能說傳完
    await waitFor(() => progress.length >= 6);
    x3.respond(200, ok(3, size));
    const v = await p;
    expect(v.version).toBe(2);
    expect(progress).toEqual([4 * MiB, 12 * MiB, 14 * MiB, 22 * MiB, 34 * MiB, size - 1, size]);
  });

  it('取消：正在傳的那段馬上停（AbortError），不會去叫「完成」', async () => {
    const size = 3 * MiB;
    const file = new File([new Uint8Array(size)], 'a.mp4', { type: 'video/mp4' });
    const created = video({ sizeBytes: size, upload: { partSize: 16 * MiB, partCount: 1, uploadedParts: [], maxConcurrency: 3 } });
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method || 'GET') === 'POST' && url.endsWith('/uploads')) return json(200, { video: created });
      throw new Error('unexpected ' + url);
    });
    vi.stubGlobal('fetch', f);
    useFakeXhr();
    const ctrl = new AbortController();
    const p = uploadSongVideo('p1', 's1', file, { meta: {}, signal: ctrl.signal });
    await waitFor(() => FakeXHR.instances.length === 1);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeXHR.instances[0].aborted).toBe(true);
    expect(f.mock.calls.some(c => String(c[0]).endsWith('/complete'))).toBe(false);
  });

  it('一段傳不上去：後台的中文錯誤 + 狀態碼；409 這種重試也沒用的不重試', async () => {
    useFakeXhr(() => ({ status: 409, body: { error: '這一版已經不在上傳中了', status: 'failed' } }));
    await expect(uploadVideoPart('p1', 's1', 'sv_1', 1, new Blob([new Uint8Array(10)]))).rejects.toMatchObject({
      status: 409, message: '這一版已經不在上傳中了', data: { status: 'failed' },
    });
    useFakeXhr(() => 'network');
    await expect(uploadVideoPart('p1', 's1', 'sv_1', 1, new Blob([new Uint8Array(10)]))).rejects.toBeInstanceOf(TypeError);
    // 已經取消了就不送
    useFakeXhr();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(uploadVideoPart('p1', 's1', 'sv_1', 1, new Blob([new Uint8Array(10)]), ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeXHR.instances).toEqual([]);
  });

  it('不收的格式在送出前就擋下來', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const file = new File([new Uint8Array(10)], 'a.mkv', { type: 'video/x-matroska' });
    await expect(uploadSongVideo('p1', 's1', file)).rejects.toMatchObject({ status: 415 });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('上傳進度怎麼算（好幾段一起傳）', () => {
  it('傳好的段 + 正在傳的段送出的部分加起來', () => {
    const p = createUploadProgress(100);
    expect(p.sending(1, 10)).toBe(10);
    expect(p.sending(2, 5)).toBe(15);
    expect(p.sending(1, 30)).toBe(35);
    expect(p.done(1, 40)).toBe(45);   // 第 1 段 40 傳好 + 第 2 段送出 5
    expect(p.bytesDone()).toBe(45);
  });

  it('續傳：從已經傳好的開始算', () => {
    const p = createUploadProgress(100, 40);
    expect(p.bytesDone()).toBe(40);
    expect(p.sending(2, 10)).toBe(50);
  });

  it('只往前：一段失敗要重傳時不倒退，重傳追上之後才繼續往前', () => {
    const p = createUploadProgress(100);
    p.sending(1, 30);
    expect(p.failed(1)).toBe(30);
    expect(p.sending(1, 10)).toBe(30);
    expect(p.sending(1, 35)).toBe(35);
  });

  it('全部送出、還沒收到後台確認 → 最多到 99%（總大小 - 1）；確認了才到 100%', () => {
    const p = createUploadProgress(100);
    p.done(1, 60);
    expect(p.sending(2, 40)).toBe(99);
    expect(p.done(2, 40)).toBe(100);
  });

  it('不會超過總大小；後台說收到比較多時跟著後台', () => {
    const p = createUploadProgress(100);
    expect(p.sending(1, 500)).toBe(99);
    const q = createUploadProgress(100);
    expect(q.done(2, 20, 70)).toBe(70);  // 別的段之前已經傳好了（後台算的）
    expect(q.done(1, 80, 100)).toBe(100);
    expect(q.done(3, 50, 100)).toBe(100);
  });
});
