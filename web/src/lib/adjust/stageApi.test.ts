import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  copyStageCue, isStageConflict, patchStageCue, saveStageAs, saveStagePositions, setSlotStageCrossfade, type StageApiError,
} from './stageApi';

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

/** 這個呼叫應該失敗：拿到錯誤 */
async function fail(p: Promise<unknown>): Promise<StageApiError> {
  try { await p; } catch (e) { return e as StageApiError; }
  throw new Error('應該要失敗');
}

const rows = [{ mechanismId: 'm1', value: 2, delaySec: null, durationSec: null, carried: false }];

describe('stageApi：每個函式打對的網址、帶對的內容', () => {
  it('存回 Cue 庫：PUT mechanism-positions，帶 ifRev', async () => {
    const f = mockFetch(200, { ok: true, rev: 4, songs: [], changed: 1, notified: 2 });
    const r = await saveStagePositions('p 1', 'lc_1', { ifRev: 3, mechanisms: rows, songId: 's1' });
    expect(r.rev).toBe(4);
    expect(lastCall(f)).toEqual({ url: '/api/projects/p%201/library-cues/lc_1/mechanism-positions', method: 'PUT', body: { ifRev: 3, mechanisms: rows, songId: 's1' } });
    await saveStagePositions('p1', 'lc_1', { ifRev: 4, mechanisms: rows, undo: true });
    expect(lastCall(f).body).toEqual({ ifRev: 4, mechanisms: rows, undo: true });
  });
  it('另存 / 複製 / 改名 / 轉場秒數', async () => {
    let f = mockFetch(201, { libraryCue: { id: 'lc_2', label: '30-1' }, slot: { id: 'c1' }, song: { id: 's1' }, notified: 0 });
    await saveStageAs('p1', 'lc_1', { name: '副歌（導演改）', mechanisms: rows, songId: 's1', cueId: 'c1' });
    expect(lastCall(f)).toEqual({ url: '/api/projects/p1/library-cues/lc_1/stage-save-as', method: 'POST', body: { name: '副歌（導演改）', mechanisms: rows, songId: 's1', cueId: 'c1' } });
    f = mockFetch(201, { libraryCue: { id: 'lc_3' } });
    await copyStageCue('p1', 'lc_1', { name: '複製' });
    expect(lastCall(f)).toEqual({ url: '/api/projects/p1/library-cues/lc_1/stage-copy', method: 'POST', body: { name: '複製' } });
    f = mockFetch(200, { libraryCue: { id: 'lc_1' }, notified: 0 });
    await patchStageCue('p1', 'lc_1', { crossfadeSeconds: 2, songId: 's1' });
    expect(lastCall(f)).toEqual({ url: '/api/projects/p1/library-cues/lc_1/stage', method: 'PATCH', body: { crossfadeSeconds: 2, songId: 's1' } });
    f = mockFetch(200, { ok: true, notified: 1 });
    await setSlotStageCrossfade('p1', 's 1', 'c1', 2.5);
    expect(lastCall(f)).toEqual({ url: '/api/projects/p1/songs/s%201/cues/c1/stage-crossfade', method: 'PUT', body: { crossfadeSeconds: 2.5 } });
  });
  it('409 被別人改過：錯誤帶中文說明、誰改的、現在的版本；isStageConflict 認得', async () => {
    mockFetch(409, { error: '這個 cue 剛剛被 王導 改過', conflict: true, rev: 5, changedBy: { id: 'u1', name: '王導' } });
    const err = await fail(saveStagePositions('p1', 'lc_1', { ifRev: 3, mechanisms: rows }));
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('這個 cue 剛剛被 王導 改過');
    expect(err.status).toBe(409);
    expect(err.data).toMatchObject({ conflict: true, rev: 5, changedBy: { name: '王導' } });
    expect(isStageConflict(err)).toBe(true);
  });
  it('其他錯誤（403 / 400 / 409 但不是版本衝突）不算衝突', async () => {
    mockFetch(403, { error: '只有導演或製作可以調整舞台' });
    const forbidden = await fail(copyStageCue('p1', 'lc_1', {}));
    expect(forbidden.status).toBe(403);
    expect(forbidden.message).toBe('只有導演或製作可以調整舞台');
    expect(isStageConflict(forbidden)).toBe(false);
    mockFetch(409, { error: '這首歌的這個 cue 沒有另外設轉場秒數，要改請改 Cue 庫的秒數' });
    expect(isStageConflict(await fail(setSlotStageCrossfade('p1', 's1', 'c1', 1)))).toBe(false);
    expect(isStageConflict(null)).toBe(false);
    expect(isStageConflict(new Error('x'))).toBe(false);
  });
});
