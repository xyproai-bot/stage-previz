import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { absoluteMusicUrl, deleteSongMusic, getSongMusic, musicErrorText, uploadSongMusic, type MusicApiError } from './musicApi';

// ── 假的 XMLHttpRequest：記下送了什麼，測試自己決定什麼時候回應 ──
class FakeXhr {
  static last: FakeXhr | null = null;
  method = ''; url = ''; withCredentials = false;
  headers: Record<string, string> = {};
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0; responseText = '';
  sent: unknown = null;
  aborted = false;
  constructor() { FakeXhr.last = this; }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  send(body: unknown) { this.sent = body; }
  abort() { this.aborted = true; this.onabort?.(); }
  respond(status: number, body: unknown) { this.status = status; this.responseText = JSON.stringify(body); this.onload?.(); }
}

/** 等這個呼叫失敗，拿到它丟出來的錯誤 */
const failure = async (p: Promise<unknown>): Promise<MusicApiError> => (await p.then(() => { throw new Error('應該要失敗'); }, (e: unknown) => e)) as MusicApiError;

const file = (name = 'S01 開場.mp3', type = 'audio/mpeg') => ({ name, type, size: 100 } as unknown as File);
const music = { id: 'sm_1', songId: 's1', filename: 'S01 開場.mp3', mime: 'audio/mpeg', sizeBytes: 100, durationSec: 215.5, uploadedAt: 't', uploadedBy: null, streamUrl: '/api/music/sm_1/stream?pass=x' };

beforeEach(() => { (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr; FakeXhr.last = null; });
afterEach(() => { delete (globalThis as unknown as { XMLHttpRequest?: unknown }).XMLHttpRequest; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('uploadSongMusic', () => {
  it('PUT 到 /songs/:s/music，檔名和長度放在網址上，檔案內容就是請求內容，類型照檔案', async () => {
    const f = file();
    const p = uploadSongMusic('p 1', 's1', f, { durationSec: 215.5 });
    const x = FakeXhr.last!;
    expect(x.method).toBe('PUT');
    expect(x.url).toBe('https://proxy.haimiaan.com/api/projects/p%201/songs/s1/music?filename=S01%20%E9%96%8B%E5%A0%B4.mp3&durationSec=215.5');
    expect(x.headers['Content-Type']).toBe('audio/mpeg');
    expect(x.withCredentials).toBe(true);
    expect(x.sent).toBe(f);
    x.respond(201, { music });
    await expect(p).resolves.toEqual(music);
  });

  it('類型空的 → application/octet-stream（後台看副檔名）；沒有長度就不帶 durationSec', async () => {
    const p = uploadSongMusic('p1', 's1', file('x.flac', ''));
    const x = FakeXhr.last!;
    expect(x.headers['Content-Type']).toBe('application/octet-stream');
    expect(x.url).toMatch(/\?filename=x\.flac$/);
    x.respond(200, { music });
    await p;
  });

  it('進度：已經送出多少 / 總共多少', async () => {
    const seen: [number, number][] = [];
    const p = uploadSongMusic('p1', 's1', file(), { onProgress: (l, t) => seen.push([l, t]) });
    const x = FakeXhr.last!;
    x.upload.onprogress?.({ lengthComputable: true, loaded: 40, total: 100 });
    x.upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 });
    x.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
    x.respond(200, { music });
    await p;
    expect(seen).toEqual([[40, 100], [100, 100]]);
  });

  it('後台回的錯 → 中文 message + status + 整個內容（太大有 maxBytes）', async () => {
    const p = uploadSongMusic('p1', 's1', file());
    FakeXhr.last!.respond(413, { error: '檔案太大（120 MB），上限是 90 MB', maxBytes: 94371840 });
    const e = await failure(p);
    expect(e.status).toBe(413);
    expect(e.message).toBe('檔案太大（120 MB），上限是 90 MB');
    expect(e.data.maxBytes).toBe(94371840);
    expect(musicErrorText(e)).toBe('檔案太大（120 MB），上限是 90 MB');
  });

  it('網路斷 → TypeError；取消 → AbortError；一開始就取消的不送出去', async () => {
    const p1 = uploadSongMusic('p1', 's1', file());
    FakeXhr.last!.onerror?.();
    const e1 = await p1.catch(x => x);
    expect(e1).toBeInstanceOf(TypeError);
    expect(musicErrorText(e1)).toMatch(/網路斷了/);

    const ctrl = new AbortController();
    const p2 = uploadSongMusic('p1', 's1', file(), { signal: ctrl.signal });
    ctrl.abort();
    const e2 = await p2.catch(x => x);
    expect(e2.name).toBe('AbortError');
    expect(FakeXhr.last!.aborted).toBe(true);
    expect(musicErrorText(e2)).toBe('已取消上傳');

    FakeXhr.last = null;
    const done = new AbortController();
    done.abort();
    await expect(uploadSongMusic('p1', 's1', file(), { signal: done.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeXhr.last).toBeNull();
  });
});

describe('其他呼叫', () => {
  it('取這首歌的音樂 / 移除：走專案網址，登入用 Bearer', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'sp_session_token' ? 'tok' : null), setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(init.method === 'DELETE' ? { ok: true } : { music }), { status: 200 });
    }));
    expect(await getSongMusic('p1', 's1')).toEqual(music);
    await deleteSongMusic('p1', 's1');
    expect(calls[0].url).toBe('https://proxy.haimiaan.com/api/projects/p1/songs/s1/music');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(calls[1].init.method).toBe('DELETE');
  });

  it('後台回錯誤 → 丟出中文說明和狀態碼', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: '這首歌還沒有音樂' }), { status: 404 })));
    const e = await failure(deleteSongMusic('p1', 's1'));
    expect(e.status).toBe(404);
    expect(e.message).toBe('這首歌還沒有音樂');
  });

  it('相對的播放網址接上後台網址；完整網址照用', () => {
    expect(absoluteMusicUrl('/api/music/sm_1/stream?pass=x')).toBe('https://proxy.haimiaan.com/api/music/sm_1/stream?pass=x');
    expect(absoluteMusicUrl('https://x.test/a.mp3')).toBe('https://x.test/a.mp3');
  });

  it('錯誤說明：沒有中文說明時依狀態碼白話；全部沒有英文叫人的字', () => {
    const e = (status: number, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });
    expect(musicErrorText(e(401))).toMatch(/登入過期/);
    expect(musicErrorText(e(403))).toMatch(/製作或導演/);
    expect(musicErrorText(e(409))).toMatch(/封存|換掉/);
    expect(musicErrorText(e(500))).toMatch(/500/);
    expect(musicErrorText(new TypeError('Failed to fetch'))).toMatch(/網路斷了/);
    const all = [401, 403, 409, 500].map(s => musicErrorText(e(s))).join('');
    expect(all).not.toMatch(/\b(users?|admins?|directors?|animators?)\b/i);
  });
});
