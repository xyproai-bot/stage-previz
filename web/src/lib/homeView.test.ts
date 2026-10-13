import { describe, it, expect } from 'vitest';
import { normalizeHomeView, readHomeViewCache, writeHomeViewCache, chooseHomeView } from './homeView';

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

const good = { position: [1, 2, 30], target: [0, 5, 0], fov: 40 };

describe('normalizeHomeView', () => {
  it('合法的原樣留著', () => {
    expect(normalizeHomeView(good)).toEqual(good);
  });
  it('JSON 字串也收', () => {
    expect(normalizeHomeView(JSON.stringify(good))).toEqual(good);
  });
  it('視角夾在 10~120 度', () => {
    expect(normalizeHomeView({ ...good, fov: 500 })!.fov).toBe(120);
    expect(normalizeHomeView({ ...good, fov: 1 })!.fov).toBe(10);
  });
  it('壞資料 / 空的 / 位置跟看向同一點 → null', () => {
    expect(normalizeHomeView(null)).toBeNull();
    expect(normalizeHomeView({})).toBeNull();
    expect(normalizeHomeView('{x')).toBeNull();
    expect(normalizeHomeView({ ...good, position: [1, 2] })).toBeNull();
    expect(normalizeHomeView({ ...good, target: [1, 'a', 3] })).toBeNull();
    expect(normalizeHomeView({ ...good, target: good.position })).toBeNull();
    expect(normalizeHomeView({ ...good, position: [1e9, 0, 0] })).toBeNull();
  });
});

describe('cache', () => {
  it('存了讀得回來，null 就刪掉', () => {
    const s = fakeStorage();
    writeHomeViewCache(s, 'p1', good as never);
    expect(readHomeViewCache(s, 'p1')).toEqual(good);
    writeHomeViewCache(s, 'p1', null);
    expect(readHomeViewCache(s, 'p1')).toBeNull();
  });
});

describe('chooseHomeView', () => {
  const other = { position: [9, 9, 9], target: [0, 0, 0], fov: 50 } as never;
  it('專案上有 → 用專案的', () => {
    expect(chooseHomeView(good as never, other)).toEqual({ value: good, fromCache: false });
  });
  it('專案上沒有、這台電腦有 → 用這台電腦的', () => {
    expect(chooseHomeView(null, other)).toEqual({ value: other, fromCache: true });
  });
  it('都沒有 → null（用自動的正面全景）', () => {
    expect(chooseHomeView(null, null)).toEqual({ value: null, fromCache: false });
  });
});
