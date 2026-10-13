import { describe, expect, it } from 'vitest';
import { compareOptions, defaultCompareKey, startCompare, flipTarget, otherKey, syncPair, isCompareShortcut } from './abCompare';

const items = [
  { key: 'v:3', label: 'V3', url: 'u3' },
  { key: 'v:2', label: 'V2', url: 'u2' },
  { key: 'v:1', label: 'V1', url: 'u1' },
  { key: 'v:x', label: '', url: null },
];

describe('比較（A/B）', () => {
  it('可以比的版本：可以播、不是正在看的', () => {
    expect(compareOptions(items, 'v:2').map(o => o.label)).toEqual(['V3', 'V1']);
  });

  it('預設比下一個舊版；最舊的就比上一個新版', () => {
    expect(defaultCompareKey(items, 'v:3')).toBe('v:2');
    expect(defaultCompareKey(items, 'v:2')).toBe('v:1');
    expect(defaultCompareKey(items, 'v:1')).toBe('v:2');
    expect(defaultCompareKey([items[0]], 'v:3')).toBeNull();
    expect(defaultCompareKey(items, null)).toBe('v:3');
  });

  it('A ↔ B 來回切', () => {
    const pair = startCompare('v:2', 'v:1')!;
    expect(pair).toEqual({ a: 'v:2', b: 'v:1' });
    expect(flipTarget(pair, 'v:2')).toBe('v:1');
    expect(flipTarget(pair, 'v:1')).toBe('v:2');
    expect(otherKey(pair, 'v:1')).toBe('v:2');
    expect(startCompare('v:2', 'v:2')).toBeNull();
    expect(startCompare(null, 'v:2')).toBeNull();
  });

  it('自己點了第三版 → 那版變 A、B 留著；B 被刪 → 不比了', () => {
    const pair = { a: 'v:2', b: 'v:1' };
    const keys = items.map(i => i.key);
    expect(syncPair(pair, 'v:2', keys)).toBe(pair);
    expect(syncPair(pair, 'v:1', keys)).toBe(pair);
    expect(syncPair(pair, 'v:3', keys)).toEqual({ a: 'v:3', b: 'v:1' });
    expect(syncPair(pair, 'v:2', ['v:3', 'v:2'])).toBeNull();
    expect(syncPair(pair, 'v:3', ['v:3', 'v:2'])).toEqual({ a: 'v:3', b: 'v:2' });
    expect(syncPair(null, 'v:2', keys)).toBeNull();
    expect(syncPair(pair, null, keys)).toBeNull();
  });

  it('快捷鍵 C：打字中、按著 Ctrl / Cmd（複製）時不算', () => {
    expect(isCompareShortcut({ key: 'c' })).toBe(true);
    expect(isCompareShortcut({ key: 'C' })).toBe(true);
    expect(isCompareShortcut({ key: 'c', ctrlKey: true })).toBe(false);
    expect(isCompareShortcut({ key: 'c', metaKey: true })).toBe(false);
    expect(isCompareShortcut({ key: 'c', target: { tagName: 'TEXTAREA' } })).toBe(false);
    expect(isCompareShortcut({ key: 'c', target: { tagName: 'DIV', isContentEditable: true } })).toBe(false);
    expect(isCompareShortcut({ key: 'v' })).toBe(false);
  });
});
