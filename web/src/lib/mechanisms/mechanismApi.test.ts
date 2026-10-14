import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  parseMechanism, parsePositions, listMechanisms, createMechanism, updateMechanism, setCuePosition,
  getShareSongPositions, getMechanismSheet, convertCuePositions, createMechanismBatch, updateMechanismGroup, deleteMechanismGroup,
  setCuePositionsBulk, listMechanismsAndGroups,
} from './mechanismApi';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// 測試跑在 Node：給一個最小的瀏覽器環境（localStorage、存檔提示用的計時器）
function stubBrowser() {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('window', { localStorage, setTimeout, clearTimeout });
}
beforeEach(stubBrowser);
afterEach(() => { vi.unstubAllGlobals(); });

describe('讀回來的資料補預設值', () => {
  it('缺欄位 / 壞資料 → 預設值', () => {
    const m = parseMechanism({ id: 'm1', name: '升降台', kind: 'weird', presets: [{ name: 'B', value: 2 }, { name: 'A', value: 1 }, { name: 3 }], objectIds: ['a', 7] });
    expect(m).toMatchObject({
      id: 'm1', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, pivot: null, travelMin: 0, travelMax: 1, defaultValue: 0,
      maxSpeed: null, parentId: null, objectIds: ['a'], consoleLabel: null, cueCount: 0,
    });
    expect(m.presets.map(p => p.name)).toEqual(['A', 'B']);
    expect(parseMechanism({ kind: 'rotary' }).pivot).toEqual({ x: 0, y: 0, z: 0 });
    expect(parseMechanism({ maxSpeed: 0 }).maxSpeed).toBeNull();
    expect(parseMechanism(null).id).toBe('');
  });
  it('對開（v2）：舊後台沒有這三欄 → 一般機關；B 邊壞掉 → 直線用反方向、旋轉當一般機關', () => {
    expect(parseMechanism({ id: 'a', kind: 'linear' })).toMatchObject({ variant: null, mirror: null, objectSides: {} });
    const split = parseMechanism({
      id: 's', kind: 'linear', axis: { x: 1, y: 0, z: 0 }, variant: 'split', objectIds: ['o1', 'o2'],
      mirror: { axis: { x: -1, y: 0, z: 0 }, pivot: null, consoleLabel: 'Axis 8' }, objectSides: { o2: 'b', o9: 'b' },
    });
    expect(split).toMatchObject({ variant: 'split', mirror: { axis: { x: -1, y: 0, z: 0 }, pivot: null, consoleLabel: 'Axis 8' }, objectSides: { o1: 'a', o2: 'b' } });
    expect(parseMechanism({ id: 's', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, variant: 'split' }).mirror?.axis).toEqual({ x: 0, y: -1, z: 0 });
    expect(parseMechanism({ id: 's', kind: 'rotary', variant: 'split' }).variant).toBeNull();
    expect(parseMechanism({ id: 's', variant: 'hoist' }).variant).toBeNull();
  });
  it('位置：不是數字的略過', () => {
    // 舊後台沒有延遲 / 走幾秒 → null（跟著 cue）；負的 / 不是數字 → null
    expect(parsePositions([
      { cueId: 'c', mechanismId: 'm', value: 1 }, { cueId: 'c', mechanismId: 'm', value: 'x' }, null,
      { cueId: 'd', mechanismId: 'm', value: 2, delaySec: 2, durationSec: -1 },
    ])).toEqual([
      { cueId: 'c', mechanismId: 'm', value: 1, delaySec: null, durationSec: null, updatedAt: '' },
      { cueId: 'd', mechanismId: 'm', value: 2, delaySec: 2, durationSec: null, updatedAt: '' },
    ]);
    expect(parsePositions('nope')).toEqual([]);
  });
});

describe('呼叫後台', () => {
  it('清單的網址、帶登入', async () => {
    localStorage.setItem('sp_session_token', 'tok');
    const f = vi.fn(async () => json(200, { mechanisms: [{ id: 'm1', name: 'A' }] }));
    vi.stubGlobal('fetch', f);
    const list = await listMechanisms('p 1');
    expect(list[0].id).toBe('m1');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://proxy.haimiaan.com/api/projects/p%201/mechanisms?mech=2');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    localStorage.removeItem('sp_session_token');
  });

  it('物件已經在別的機關 → 409 帶 conflicts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, {
      error: '「LED」已經在「升降台」裡，一個物件只能直接放在一個機關',
      conflicts: [{ objectId: 'o', objectName: 'LED', mechanismId: 'm', mechanismName: '升降台' }],
    })));
    await expect(createMechanism('p', { name: 'x' })).rejects.toMatchObject({
      status: 409, data: { conflicts: [{ mechanismName: '升降台' }] },
    });
  });

  it('修改回傳超出行程的數量；存位置送 PUT', async () => {
    const f = vi.fn(async (url: string) => (url.includes('/cues/')
      ? json(200, { ok: true, value: 3.5, clamped: true })
      : json(200, { mechanism: { id: 'm1' }, outOfRangeCount: 2 })));
    vi.stubGlobal('fetch', f);
    expect((await updateMechanism('p', 'm1', { travelMax: 2 })).outOfRangeCount).toBe(2);
    expect(await setCuePosition('p', 's', 'c', 'm1', 9)).toEqual({ value: 3.5, clamped: true });
    const [url, init] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('https://proxy.haimiaan.com/api/projects/p/songs/s/cues/c/mechanisms/m1');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe('{"value":9}');
  });

  it('分享連結：好讀網址 / 通行證', async () => {
    const f = vi.fn(async () => json(200, { positions: [{ cueId: 'c', mechanismId: 'm', value: 2 }] }));
    vi.stubGlobal('fetch', f);
    expect((await getShareSongPositions({ kind: 'slug', key: 'show-k7p2' }, 's1', 'acc'))[0].value).toBe(2);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://proxy.haimiaan.com/api/s/show-k7p2/songs/s1/mechanism-positions?mech=2');
    expect((init.headers as Record<string, string>)['x-share-access']).toBe('acc');
  });

  it('一排機關：一次建立、改共用設定、解散 / 刪除、一次存很多個位置', async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/mechanisms/batch')) return json(201, { group: { id: 'g1', name: 'LED 升降', settings: { namePrefix: 'LED 升降' } }, mechanisms: [{ id: 'm1', groupId: 'g1', groupIndex: 0 }] });
      if (url.includes('/mechanism-groups/') && init?.method === 'PATCH') return json(200, { group: { id: 'g1', name: '前排' }, mechanisms: [], outOfRangeCount: 2 });
      if (url.includes('/mechanism-groups/')) return json(200, { ok: true, dissolved: url.includes('dissolve=1'), removedMechanisms: 4, removedPositions: 7 });
      return json(200, { ok: true, items: [{ mechanismId: 'm1', value: 2, clamped: true, delaySec: 0.5, durationSec: null }, { mechanismId: 'm2', removed: true }] });
    });
    vi.stubGlobal('fetch', f);
    const made = await createMechanismBatch('p', { base: { kind: 'linear' }, objectIds: ['o1', 'o2'], namePrefix: 'LED 升降' });
    expect(made.group.name).toBe('LED 升降');
    expect(made.mechanisms[0]).toMatchObject({ groupId: 'g1', groupIndex: 0 });
    let [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect([url, init.method]).toEqual(['https://proxy.haimiaan.com/api/projects/p/mechanisms/batch', 'POST']);

    expect((await updateMechanismGroup('p', 'g 1', { name: '前排', travelMax: 2 })).outOfRangeCount).toBe(2);
    [url, init] = f.mock.calls[1] as unknown as [string, RequestInit];
    expect([url, init.method, init.body]).toEqual(['https://proxy.haimiaan.com/api/projects/p/mechanism-groups/g%201', 'PATCH', '{"name":"前排","travelMax":2}']);

    expect(await deleteMechanismGroup('p', 'g1', true)).toEqual({ removedMechanisms: 4, removedPositions: 7 });
    expect((f.mock.calls[2] as unknown as [string])[0]).toBe('https://proxy.haimiaan.com/api/projects/p/mechanism-groups/g1?dissolve=1');
    await deleteMechanismGroup('p', 'g1', false);
    expect((f.mock.calls[3] as unknown as [string])[0]).toBe('https://proxy.haimiaan.com/api/projects/p/mechanism-groups/g1');

    const res = await setCuePositionsBulk('p', 's', 'c', [{ mechanismId: 'm1', value: 2, delaySec: 0.5 }, { mechanismId: 'm2', value: null }]);
    expect(res).toEqual([
      { mechanismId: 'm1', value: 2, clamped: true, delaySec: 0.5, durationSec: null },
      { mechanismId: 'm2', removed: true },
    ]);
    [url, init] = f.mock.calls[4] as unknown as [string, RequestInit];
    expect([url, init.method]).toEqual(['https://proxy.haimiaan.com/api/projects/p/songs/s/cues/c/mechanism-positions', 'PUT']);
    expect(JSON.parse(init.body as string)).toEqual({ items: [{ mechanismId: 'm1', value: 2, delaySec: 0.5 }, { mechanismId: 'm2', value: null }] });
  });

  it('清單帶一排：舊後台沒有 groups → 空的', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { mechanisms: [{ id: 'm1' }], groups: [{ id: 'g1', name: '前排', order: 0 }, { name: '沒有 id' }] })));
    const r = await listMechanismsAndGroups('p');
    expect(r.groups.map(g => g.id)).toEqual(['g1']);
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { mechanisms: [{ id: 'm1' }] })));
    expect((await listMechanismsAndGroups('p')).groups).toEqual([]);
  });

  it('總表 / 轉換', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.includes('mechanism-sheet')
      ? json(200, { songs: [{ id: 's', cues: [] }], positions: [], mechanisms: [{ id: 'm' }] })
      : json(200, { ok: true, dryRun: true, converted: 3, skipped: [], positions: 3, rowsChanged: 6 }))));
    expect((await getMechanismSheet('p')).mechanisms[0].id).toBe('m');
    expect((await convertCuePositions('p', 'm', true)).converted).toBe(3);
  });
});
