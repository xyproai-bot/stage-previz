import { describe, it, expect } from 'vitest';
import { clearPersonalLooks, countPersonalLooks, listKeysWithPrefix } from './localPrefs';
import { readPersonalLook, writePersonalLook } from './stageLook/personalLook';

function fakeStorage(init: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(init));
  return {
    get length() { return m.size; },
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    _map: m,
  };
}

describe('listKeysWithPrefix', () => {
  it('只挑前綴對的，而且前綴後面要有東西', () => {
    const s = fakeStorage({ 'sp-look:p1': '{}', 'sp-look:': '{}', 'sp-looks:x': '{}', 'other': '1' });
    expect(listKeysWithPrefix(s, 'sp-look:')).toEqual(['sp-look:p1']);
  });
  it('沒有 storage / storage 爆掉 → 空清單', () => {
    expect(listKeysWithPrefix(null, 'sp-look:')).toEqual([]);
    const broken = { get length(): number { throw new Error('x'); }, key: () => null };
    expect(listKeysWithPrefix(broken, 'sp-look:')).toEqual([]);
  });
});

describe('countPersonalLooks', () => {
  it('數有幾個專案調過現場亮度（跟 personalLook 存的 key 一致）', () => {
    const s = fakeStorage();
    expect(countPersonalLooks(s)).toBe(0);
    writePersonalLook(s, 'p1', { exposure: 1.3 });
    writePersonalLook(s, 'p2', { houseLight: 0.5 });
    expect(countPersonalLooks(s)).toBe(2);
  });
});

describe('clearPersonalLooks', () => {
  it('只清 sp-look:*，admin 暫存跟視角書籤都留著', () => {
    const s = fakeStorage({
      'sp-materials:p1': '{"a":1}',
      'sp-home-view:p1': '{"b":2}',
      'sp_camera_bookmarks:p1': '[]',
      'sp_session_token': 'tok',
    });
    writePersonalLook(s, 'p1', { exposure: 1.3 });
    writePersonalLook(s, 'p2', { houseLight: 0.5 });
    writePersonalLook(s, 'p3', { exposure: 0.8 });

    expect(clearPersonalLooks(s)).toBe(3);
    expect(countPersonalLooks(s)).toBe(0);
    expect(readPersonalLook(s, 'p1')).toBeNull();
    expect(Array.from(s._map.keys()).sort()).toEqual([
      'sp-home-view:p1', 'sp-materials:p1', 'sp_camera_bookmarks:p1', 'sp_session_token',
    ]);
  });
  it('沒東西可清 → 0；storage 爆掉也不會丟錯', () => {
    expect(clearPersonalLooks(fakeStorage())).toBe(0);
    expect(clearPersonalLooks(null)).toBe(0);
    const s = fakeStorage({ 'sp-look:p1': '{}' });
    const broken = { ...s, get length() { return s.length; }, removeItem: () => { throw new Error('x'); } };
    expect(() => clearPersonalLooks(broken)).not.toThrow();
    expect(clearPersonalLooks(broken)).toBe(0);
  });
});
