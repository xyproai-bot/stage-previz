import { describe, it, expect } from 'vitest';
import { DEFAULT_LOOK_SETTINGS } from './lookSettings';
import { isLookCustomized, mergeLook, readPersonalLook, writePersonalLook } from './personalLook';

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    _map: m,
  };
}

describe('mergeLook', () => {
  it('沒有個人設定 → 專案設定', () => {
    expect(mergeLook(DEFAULT_LOOK_SETTINGS, null)).toEqual(DEFAULT_LOOK_SETTINGS);
  });
  it('個人只蓋自己調過的欄位，而且會夾範圍', () => {
    const project = { ...DEFAULT_LOOK_SETTINGS, houseLight: 0.3 };
    const out = mergeLook(project, { exposure: 9 });
    expect(out.exposure).toBe(3);
    expect(out.houseLight).toBe(0.3);
  });
});

describe('isLookCustomized', () => {
  it('跟專案一樣 → false；有任何一個不同 → true', () => {
    expect(isLookCustomized(DEFAULT_LOOK_SETTINGS, { ...DEFAULT_LOOK_SETTINGS })).toBe(false);
    expect(isLookCustomized(DEFAULT_LOOK_SETTINGS, { ...DEFAULT_LOOK_SETTINGS, exposure: 1.2 })).toBe(true);
  });
});

describe('readPersonalLook / writePersonalLook', () => {
  it('依專案分開存、讀回來一樣', () => {
    const s = fakeStorage();
    writePersonalLook(s, 'p1', { exposure: 1.3 });
    writePersonalLook(s, 'p2', { houseLight: 0.5 });
    expect(readPersonalLook(s, 'p1')).toEqual({ exposure: 1.3 });
    expect(readPersonalLook(s, 'p2')).toEqual({ houseLight: 0.5 });
  });
  it('null → 刪掉', () => {
    const s = fakeStorage();
    writePersonalLook(s, 'p1', { exposure: 1.3 });
    writePersonalLook(s, 'p1', null);
    expect(readPersonalLook(s, 'p1')).toBeNull();
  });
  it('壞資料 / 不認識的欄位 → 丟掉', () => {
    const s = fakeStorage();
    s.setItem('sp-look:p1', '{壞掉');
    expect(readPersonalLook(s, 'p1')).toBeNull();
    s.setItem('sp-look:p1', JSON.stringify({ exposure: '1.1', junk: 5 }));
    expect(readPersonalLook(s, 'p1')).toEqual({ exposure: 1.1 });
  });
  it('storage 爆掉也不會丟錯', () => {
    const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    expect(readPersonalLook(broken, 'p1')).toBeNull();
    expect(() => writePersonalLook(broken, 'p1', { exposure: 1 })).not.toThrow();
  });
});
