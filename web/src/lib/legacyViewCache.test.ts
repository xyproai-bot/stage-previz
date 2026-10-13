import { describe, it, expect } from 'vitest';
import { clearLegacyViewCaches } from './legacyViewCache';

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

describe('clearLegacyViewCaches（舊版材質 / 重置視角暫存，打開專案時清掉，不再補存回專案）', () => {
  it('清掉所有專案的 sp-materials:* 跟 sp-home-view:*，其他設定都留著', () => {
    const s = fakeStorage({
      'sp-materials:p1': '{"霧銀":{"roughness":0.4}}',
      'sp-materials:p2': '{}',
      'sp-home-view:p1': '{"position":[1,2,3],"target":[0,0,0],"fov":40}',
      'sp-look:p1': '{"exposure":1.2}',
      'sp_camera_bookmarks:p1': '[]',
      'sp_session_token': 'tok',
    });
    expect(clearLegacyViewCaches(s)).toBe(3);
    expect(Array.from(s._map.keys()).sort()).toEqual(['sp-look:p1', 'sp_camera_bookmarks:p1', 'sp_session_token']);
  });
  it('沒有舊暫存 → 0，什麼都不動', () => {
    const s = fakeStorage({ 'sp-look:p1': '{}' });
    expect(clearLegacyViewCaches(s)).toBe(0);
    expect(s._map.size).toBe(1);
  });
  it('沒有 storage / storage 爆掉也不會丟錯', () => {
    expect(clearLegacyViewCaches(null)).toBe(0);
    expect(clearLegacyViewCaches(undefined)).toBe(0);
    const s = fakeStorage({ 'sp-materials:p1': '{}' });
    const broken = { get length() { return s.length; }, key: s.key, removeItem: () => { throw new Error('x'); } };
    expect(() => clearLegacyViewCaches(broken)).not.toThrow();
    expect(clearLegacyViewCaches(broken)).toBe(0);
  });
});
