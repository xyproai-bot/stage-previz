import { describe, it, expect } from 'vitest';
import { noSourceStatus, resolveShareSource, shareSourceStorageKey } from './shareSource';
import { readLedSource, saveLedSource } from '../components/LedSourceSwitch';

describe('分享連結一打開 LED 放什麼', () => {
  it('有影片 → 放影片', () => {
    expect(resolveShareSource({ pref: null, hasVideo: true, settled: true })).toBe('version');
  });

  it('沒有影片 → 什麼都不放（測試圖），不會自己跳到 AE 即時', () => {
    expect(resolveShareSource({ pref: null, hasVideo: false, settled: true })).toBeNull();
  });

  it('還在讀影片清單 → 先當作影片（不會先閃一下別的）', () => {
    expect(resolveShareSource({ pref: null, hasVideo: false, settled: false })).toBe('version');
  });

  it('上次自己選了 AE 即時 → 這次也是（動畫師）；有沒有影片都一樣', () => {
    expect(resolveShareSource({ pref: 'ndi', hasVideo: false, settled: true })).toBe('ndi');
    expect(resolveShareSource({ pref: 'ndi', hasVideo: true, settled: true })).toBe('ndi');
  });

  it('上次選了本地檔案 → 本地檔案', () => {
    expect(resolveShareSource({ pref: 'file', hasVideo: true, settled: true })).toBe('file');
  });

  it('上次選了影片、這首歌沒有影片 → 測試圖（不是 AE 即時）', () => {
    expect(resolveShareSource({ pref: 'version', hasVideo: false, settled: true })).toBeNull();
    expect(resolveShareSource({ pref: 'version', hasVideo: true, settled: true })).toBe('version');
  });

  it('沒放東西時上面那一行：沒有影片 / 讀取失敗分開說', () => {
    expect(noSourceStatus(null)).toBe('這首歌還沒有影片');
    expect(noSourceStatus('影片清單讀取失敗：網路不通')).toBe('影片清單讀取失敗：網路不通');
  });
});

describe('每個分享連結分開記上次選的來源', () => {
  function memoryLocalStorage() {
    const m = new Map<string, string>();
    const prev = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, v); },
      removeItem: (k: string) => { m.delete(k); },
    };
    return { m, restore: () => { (globalThis as { localStorage?: unknown }).localStorage = prev; } };
  }

  it('好讀網址、舊式網址、不同連結的 key 都不一樣', () => {
    const a = shareSourceStorageKey({ kind: 'slug', key: 'tour-2026' });
    const b = shareSourceStorageKey({ kind: 'slug', key: 'other' });
    const c = shareSourceStorageKey({ kind: 'token', key: 'tour-2026' });
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a).toBe('sp_led_source:share:slug:tour-2026');
  });

  it('在 A 連結選了 AE 即時，B 連結還是沒選過', () => {
    const s = memoryLocalStorage();
    try {
      const a = shareSourceStorageKey({ kind: 'slug', key: 'a' });
      const b = shareSourceStorageKey({ kind: 'slug', key: 'b' });
      saveLedSource(a, 'ndi');
      expect(readLedSource(a)).toBe('ndi');
      expect(readLedSource(b)).toBeNull();
      expect(resolveShareSource({ pref: readLedSource(b), hasVideo: false, settled: true })).toBeNull();
    } finally {
      s.restore();
    }
  });

  it('localStorage 不能用（無痕 / 被擋）→ 當作沒選過，不會壞', () => {
    const prev = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    try {
      const k = shareSourceStorageKey({ kind: 'slug', key: 'a' });
      expect(() => saveLedSource(k, 'ndi')).not.toThrow();
      expect(readLedSource(k)).toBeNull();
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = prev;
    }
  });
});
