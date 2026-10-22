import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './cueLibraryApi';

function mockFetch(status: number, body: unknown) {
  const f = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', f);
  return f;
}
const lastCall = (f: ReturnType<typeof mockFetch>) => {
  const [url, init] = f.mock.calls[f.mock.calls.length - 1] as unknown as [string, RequestInit];
  return { url: url.replace(/^https?:\/\/[^/]+/, ''), method: (init.method || 'GET').toUpperCase(), body: init.body ? JSON.parse(init.body as string) : undefined };
};

// 沒有 jsdom：給 apiBase / saveStatus 用的最小 window
const store = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
beforeEach(() => {
  vi.stubGlobal('window', { localStorage: store, setTimeout, clearTimeout, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });
  vi.stubGlobal('localStorage', store);
});
afterEach(() => vi.unstubAllGlobals());

describe('cueLibraryApi：每個函式打對的網址', () => {
  it('Cue 庫的 cue：列表 / 新增 / 改 / 刪 / 誰在用 / 畫面', async () => {
    let f = mockFetch(200, { libraryCues: [] });
    expect(await api.listLibraryCues('p 1')).toEqual([]);
    expect(lastCall(f)).toMatchObject({ url: '/api/projects/p%201/library-cues', method: 'GET' });
    f = mockFetch(201, { libraryCue: { id: 'lc_1' }, slot: { id: 'c1' } });
    await api.createLibraryCue('p1', { label: '12-1', basedOnId: 'lc_0', place: { songId: 's1', replaceCueId: 'c1' } });
    expect(lastCall(f)).toMatchObject({ url: '/api/projects/p1/library-cues', method: 'POST', body: { label: '12-1', basedOnId: 'lc_0', place: { songId: 's1', replaceCueId: 'c1' } } });
    f = mockFetch(200, { libraryCue: { id: 'lc_1' } });
    await api.updateLibraryCue('p1', 'lc_1', { label: '3-1' });
    expect(lastCall(f)).toMatchObject({ url: '/api/projects/p1/library-cues/lc_1', method: 'PATCH', body: { label: '3-1' } });
    await api.getLibraryCue('p1', 'lc_1');
    expect(lastCall(f)).toMatchObject({ method: 'GET', url: '/api/projects/p1/library-cues/lc_1' });
    f = mockFetch(200, { ok: true });
    await api.deleteLibraryCue('p1', 'lc_1');
    expect(lastCall(f)).toMatchObject({ url: '/api/projects/p1/library-cues/lc_1', method: 'DELETE' });
    f = mockFetch(200, { usage: { songCount: 0, slotCount: 0, slots: [] } });
    await api.getLibraryCueUsage('p1', 'lc_1');
    expect(lastCall(f).url).toBe('/api/projects/p1/library-cues/lc_1/usage');
    f = mockFetch(200, { rev: 2, previous: { objects: [], mechanisms: [] } });
    await api.putLibraryLook('p1', 'lc_1', { objects: [], mechanisms: [] }, 1);
    expect(lastCall(f)).toMatchObject({ url: '/api/projects/p1/library-cues/lc_1/look', method: 'PUT', body: { ifRev: 1, objects: [], mechanisms: [] } });
    await api.putLibraryLook('p1', 'lc_1', { objects: [], mechanisms: [] });
    expect('ifRev' in lastCall(f).body).toBe(false);
  });

  it('slot：加 / 換指向 / 改時間 / 拿掉', async () => {
    let f = mockFetch(201, { slot: { id: 'c1' }, order: [] });
    await api.addSongSlot('p1', 's1', { libraryCueId: 'lc_1', videoTimeSec: 45 });
    expect(lastCall(f)).toMatchObject({ url: '/api/projects/p1/songs/s1/cues', method: 'POST', body: { libraryCueId: 'lc_1', videoTimeSec: 45 } });
    f = mockFetch(200, { ok: true });
    await api.updateSongSlot('p1', 's1', 'c1', { libraryCueId: 'lc_2', videoTimeSec: null });
    expect(lastCall(f)).toMatchObject({ url: '/api/projects/p1/songs/s1/cues/c1', method: 'PATCH', body: { libraryCueId: 'lc_2', videoTimeSec: null } });
    await api.removeSongSlot('p1', 's1', 'c1');
    expect(lastCall(f)).toMatchObject({ url: '/api/projects/p1/songs/s1/cues/c1', method: 'DELETE' });
  });

  it('錯誤：中文訊息、status、409 的 rev / usage 都拿得到', async () => {
    mockFetch(409, { error: '這個 cue 剛剛被別人改過', rev: 7 });
    await expect(api.putLibraryLook('p1', 'lc_1', { objects: [], mechanisms: [] }, 3)).rejects.toMatchObject({ status: 409, message: '這個 cue 剛剛被別人改過', data: { rev: 7 } });
    mockFetch(409, { error: '還有 2 首歌在用這個 cue，先從這些歌拿掉才能刪', usage: { songCount: 2, slotCount: 3, slots: [] } });
    await expect(api.deleteLibraryCue('p1', 'lc_1')).rejects.toMatchObject({ status: 409, data: { usage: { songCount: 2 } } });
    mockFetch(409, { error: '這個編號已經有了' });
    await expect(api.createLibraryCue('p1', { label: '1', name: 'x' })).rejects.toMatchObject({ message: '這個編號已經有了' });
  });
});
