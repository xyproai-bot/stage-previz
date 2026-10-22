import { describe, it, expect } from 'vitest';
import { cueNumLabel, cueNumName, cueNumQuoted, deleteSongMessage, sharedLibraryCueCount } from './cueBadge';
import { cueTimesOf } from './useSongTimeline';
import { switchSentence } from './ledTemplateTimeline';
import { resetAllDialog } from './cueResetAll';
import type { Cue } from './api';

const lib = { id: 'l1', label: '3-1', name: '副歌全開' };

describe('Cue 編號徽章文字', () => {
  it('Cue 庫的 cue：編號照原樣、名稱用 Cue 庫的', () => {
    expect(cueNumLabel({ libraryCue: lib })).toBe('3-1');
    expect(cueNumName({ name: '舊名', libraryCue: lib })).toBe('Cue 3-1 副歌全開');
    expect(cueNumQuoted({ name: '舊名', libraryCue: lib })).toBe('Cue 3-1「副歌全開」');
  });
  it('舊模式專案（沒有 libraryCue）：什麼都不變', () => {
    expect(cueNumLabel({})).toBeNull();
    expect(cueNumLabel({ libraryCue: null })).toBeNull();
    expect(cueNumName({ name: '開場' })).toBe('開場');
    expect(cueNumQuoted({ name: '開場', libraryCue: null })).toBe('開場');
  });
});

describe('AE 標記 / 換版型句子帶編號', () => {
  const cues = [
    { id: 'c1', status: 'master', name: '開場', videoTimeSec: 0, libraryCue: { label: '12', name: '副歌全開' } },
    { id: 'c2', status: 'master', name: '間奏', videoTimeSec: 83, libraryCue: null },
  ] as unknown as Cue[];
  it('Cue 庫的 cue：「從 Cue 12 副歌全開（1:23.0）起換成…」', () => {
    const t = cueTimesOf(cues)!;
    expect(t.get('c1')!.name).toBe('Cue 12 副歌全開');
    expect(switchSentence(t.get('c1')!.name, 83, '版型 B')).toBe('從 Cue 12 副歌全開（1:23.0）起換成「版型 B」');
  });
  it('舊模式的 cue 名字不變', () => {
    expect(cueTimesOf(cues)!.get('c2')!.name).toBe('間奏');
  });
});

describe('確認文字', () => {
  it('這首歌有幾個 cue 也被別的歌用', () => {
    const library = [
      { id: 'a', usage: { slots: [{ songId: 's1' }, { songId: 's2' }] } },
      { id: 'b', usage: { slots: [{ songId: 's1' }] } },
    ];
    const cues = [{ libraryCueId: 'a' }, { libraryCueId: 'b' }, { libraryCueId: null }];
    expect(sharedLibraryCueCount('s1', cues, library)).toBe(1);
    expect(sharedLibraryCueCount('s3', [{ libraryCueId: 'b' }], library)).toBe(1);
  });
  it('全部回到預設：有共用才多一句', () => {
    const s = { totalCues: 3, cuesWithOverrides: 2, overrides: 4, objects: 2 };
    expect(resetAllDialog(s).message).not.toContain('別的歌');
    expect(resetAllDialog(s, 2).message).toContain('其中 2 個 cue 也被別的歌使用，那些歌也會一起回到預設');
  });
  it('刪歌：Cue 庫專案多說 Cue 庫的 cue 不會被刪掉', () => {
    expect(deleteSongMessage(true)).toContain('Cue 庫的 cue 不會被刪掉');
    expect(deleteSongMessage(false)).toBe('它的所有 cue 會一起刪掉，刪了就救不回來。');
  });
});
