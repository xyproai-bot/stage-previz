import { describe, expect, it } from 'vitest';
import type { LibraryCue, LibraryCueUsage } from './cueLibraryApi';
import { compareLabels, deleteBlockedText, filterLibraryCues, sortLibraryCues, stepLibraryCue, usageLabel } from './cueLibraryList';

const usage = (songs: [string, string][]): LibraryCueUsage => ({
  songCount: new Set(songs.map(s => s[0])).size, slotCount: songs.length,
  slots: songs.map(([songId, code], i) => ({ cueId: 'c' + i, songId, songName: '歌' + songId, songCode: code || null, videoTimeSec: i * 10 })),
});
const mk = (label: string, name: string, u: LibraryCueUsage = usage([]), n = 0): LibraryCue => ({
  id: 'lc' + label, label, name, note: '', basedOnId: null, rev: 1, crossfadeSeconds: 1, createdAt: String(1000 + n), updatedAt: '', usage: u, counts: { objects: 0, mechanisms: 0 },
});

describe('Cue 庫清單', () => {
  it('編號照自然排序：1, 2, 2.5, 3, 3-1, 12, 301', () => {
    const l = ['301', '12', '3-1', '2.5', '3', '2', '1'].map((x, i) => mk(x, 'n' + x, usage([]), i));
    expect(sortLibraryCues(l).map(c => c.label)).toEqual(['1', '2', '2.5', '3', '3-1', '12', '301']);
    expect(compareLabels('A', '9')).toBeGreaterThan(0);
  });
  it('搜尋：編號或名稱都找得到，不分大小寫', () => {
    const l = [mk('1', '開場'), mk('3-1', '副歌全開'), mk('12', 'Final Chorus')];
    expect(filterLibraryCues(l, '副歌', 'all').map(c => c.label)).toEqual(['3-1']);
    expect(filterLibraryCues(l, '3-', 'all').map(c => c.label)).toEqual(['3-1']);
    expect(filterLibraryCues(l, 'chorus', 'all').map(c => c.label)).toEqual(['12']);
    expect(filterLibraryCues(l, '  ', 'all')).toHaveLength(3);
    expect(filterLibraryCues(l, '找不到', 'all')).toHaveLength(0);
  });
  it('篩選：沒有歌在用', () => {
    const l = [mk('1', 'a', usage([['s1', 'S01']])), mk('2', 'b'), mk('3', 'c')];
    expect(filterLibraryCues(l, '', 'unused').map(c => c.label)).toEqual(['2', '3']);
    expect(filterLibraryCues(l, 'c', 'unused').map(c => c.label)).toEqual(['3']);
  });
  it('每列小字與刪除被擋的文字', () => {
    expect(usageLabel(usage([]))).toBe('沒有歌在用');
    expect(usageLabel(usage([['s1', 'S01'], ['s1', 'S01'], ['s2', 'S02']]))).toBe('用在 2 首歌');
    expect(deleteBlockedText(usage([['s1', 'S01'], ['s1', 'S01'], ['s2', '']]))).toBe('2 首歌在用（S01、歌s2），先從這些歌拿掉才能刪');
  });
  it('J / K 照編號上下切換，頭尾不循環', () => {
    const l = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(stepLibraryCue(l, 'a', 1)).toBe('b');
    expect(stepLibraryCue(l, 'c', 1)).toBe('c');
    expect(stepLibraryCue(l, 'a', -1)).toBe('a');
    expect(stepLibraryCue(l, null, 1)).toBe('a');
    expect(stepLibraryCue(l, null, -1)).toBe('c');
    expect(stepLibraryCue([], 'a', 1)).toBeNull();
  });
});
