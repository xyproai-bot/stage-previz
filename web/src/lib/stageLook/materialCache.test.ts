import { describe, it, expect } from 'vitest';
import { chooseMaterials, readMaterialCache, writeMaterialCache } from './materialCache';

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

describe('chooseMaterials', () => {
  it('專案上有 → 用專案的', () => {
    expect(chooseMaterials({ a: { roughness: 0.2 } }, { b: { roughness: 1 } })).toEqual({ value: { a: { roughness: 0.2 } }, fromCache: false });
  });
  it('專案上沒有、這台電腦有 → 用這台電腦的（之後要補存回專案）', () => {
    expect(chooseMaterials({}, { b: { roughness: 1 } })).toEqual({ value: { b: { roughness: 1 } }, fromCache: true });
  });
  it('都沒有 → 空的', () => {
    expect(chooseMaterials({}, null)).toEqual({ value: {}, fromCache: false });
  });
});

describe('readMaterialCache / writeMaterialCache', () => {
  it('存了讀得回來（會清理壞值），空的就刪掉', () => {
    const s = fakeStorage();
    writeMaterialCache(s, 'p1', { 霧銀: { roughness: 0.4 }, 壞: { color: 'red' } });
    expect(readMaterialCache(s, 'p1')).toEqual({ 霧銀: { roughness: 0.4 } });
    writeMaterialCache(s, 'p1', {});
    expect(readMaterialCache(s, 'p1')).toBeNull();
  });
  it('壞 JSON → null', () => {
    const s = fakeStorage();
    s.setItem('sp-materials:p1', '{x');
    expect(readMaterialCache(s, 'p1')).toBeNull();
  });
});
