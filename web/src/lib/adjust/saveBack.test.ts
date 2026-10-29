import { describe, expect, it } from 'vitest';
import type { CueMechanismPosition } from '../mechanisms/model';
import {
  STAGE_SAVE_TEXT, buildStageRows, copiedText, copyHint, defaultCopyName, defaultSaveAsName, libraryRowsOf, parseSeconds, renamedText,
  saveAsHint, saveBackMessage, savedAsText, savedText, secText, secondsDoneText, secondsHint, secondsTitle, songsText, undoneText, usageSongs,
} from './saveBack';

const row = (over: Partial<CueMechanismPosition> & { cueId: string; mechanismId: string; value: number }): CueMechanismPosition => ({ updatedAt: '', ...over });

describe('存回：整份機關位置', () => {
  const rows: CueMechanismPosition[] = [
    // Cue 30 被兩個 slot 用 → 同一份列出現兩次
    row({ cueId: 'c1', mechanismId: 'm1', value: 1, delaySec: 0.5, durationSec: 2, libraryCueId: 'lc30' }),
    row({ cueId: 'c1', mechanismId: 'm2', value: 90, carried: true, libraryCueId: 'lc30' }),
    row({ cueId: 'c2', mechanismId: 'm1', value: 1, delaySec: 0.5, durationSec: 2, libraryCueId: 'lc30' }),
    row({ cueId: 'c2', mechanismId: 'm2', value: 90, carried: true, libraryCueId: 'lc30' }),
    row({ cueId: 'c3', mechanismId: 'm1', value: 3, libraryCueId: 'lc31' }),
    row({ cueId: 'c4', mechanismId: 'm1', value: 5 }),     // 舊模式的列（沒有 Cue 庫的 cue）
  ];
  it('只拿這個 Cue 庫的 cue 的列、用到兩次的去重；延遲 / 走幾秒 / carried 原樣', () => {
    expect(libraryRowsOf(rows, 'lc30')).toEqual([
      { mechanismId: 'm1', value: 1, delaySec: 0.5, durationSec: 2, carried: false },
      { mechanismId: 'm2', value: 90, delaySec: null, durationSec: null, carried: true },
    ]);
    expect(libraryRowsOf(rows, 'lc31')).toEqual([{ mechanismId: 'm1', value: 3, delaySec: null, durationSec: null, carried: false }]);
    expect(libraryRowsOf(rows, 'lc_none')).toEqual([]);
  });
  it('沿用的列不會帶時間（後台不收）', () => {
    const r = libraryRowsOf([row({ cueId: 'c', mechanismId: 'm', value: 1, carried: true, delaySec: 2, durationSec: 3, libraryCueId: 'lc' })], 'lc');
    expect(r[0]).toMatchObject({ carried: true, delaySec: null, durationSec: null });
  });
  it('草稿換掉改過的值，沒改的原樣；本來沒有列的機關被調了 → 新增一列（沒有自己的時間）', () => {
    const current = libraryRowsOf(rows, 'lc30');
    const out = buildStageRows(current, { m1: 2.5, m9: -45 });
    expect(out).toEqual([
      { mechanismId: 'm1', value: 2.5, delaySec: 0.5, durationSec: 2, carried: false },
      { mechanismId: 'm2', value: 90, delaySec: null, durationSec: null, carried: true },
      { mechanismId: 'm9', value: -45, delaySec: null, durationSec: null, carried: false },
    ]);
    // 不改到傳進來的
    expect(current[0].value).toBe(1);
    // 沒有草稿 → 原樣
    expect(buildStageRows(current, {})).toEqual(current);
  });
  it('草稿裡不是數字的略過', () => {
    expect(buildStageRows([], { a: Number.NaN, b: 2 })).toEqual([{ mechanismId: 'b', value: 2, delaySec: null, durationSec: null, carried: false }]);
  });
});

describe('哪些歌會一起變', () => {
  it('同一首歌用兩次只算一首、順序照 usage', () => {
    const songs = usageSongs({
      slots: [
        { cueId: 'c1', songId: 's5', songName: '開場', songCode: 'S05', videoTimeSec: 1 },
        { cueId: 'c2', songId: 's5', songName: '開場', songCode: 'S05', videoTimeSec: 9 },
        { cueId: 'c3', songId: 's12', songName: '副歌', songCode: null, videoTimeSec: 1 },
      ],
    });
    expect(songs).toEqual([{ id: 's5', name: '開場', code: 'S05' }, { id: 's12', name: '副歌', code: null }]);
    expect(songsText(songs)).toBe('S05、副歌');
  });
  it('太多首：寫「等 N 首」', () => {
    const songs = Array.from({ length: 15 }, (_, i) => ({ name: `歌${i + 1}`, code: `S${i + 1}` }));
    expect(songsText(songs)).toBe('S1、S2、S3、S4、S5、S6、S7、S8、S9、S10、S11、S12 等 15 首');
    expect(songsText(songs, 3)).toBe('S1、S2、S3 等 15 首');
  });
  it('存回前的說明：列出哪些歌會一起變；物件不會動', () => {
    expect(saveBackMessage([{ name: 'a', code: 'S05' }, { name: 'b', code: 'S12' }, { name: 'c', code: 'S17' }], 2))
      .toBe('這些歌會一起變：S05、S12、S17。\n改了 2 個機關的位置；物件的位置和顯示都不會動。');
    expect(saveBackMessage([], 1)).toBe('這個 cue 現在沒有歌在用。改了 1 個機關的位置；物件的位置和顯示都不會動。');
  });
  it('存完的提示', () => {
    expect(savedText('30', 2, [{ name: 'a', code: 'S05' }, { name: 'b', code: 'S12' }])).toBe('已存回 cue 30（改了 2 個機關，S05、S12 會一起變）');
    expect(savedText('30', 1, [])).toBe('已存回 cue 30（改了 1 個機關）');
    expect(undoneText('30')).toBe('已復原 cue 30');
    expect(savedAsText('30-1')).toBe('已另存成 cue 30-1，這首歌改用它');
    expect(copiedText('30-1')).toContain('cue 30-1');
    expect(renamedText('30', '副歌')).toBe('cue 30 改名成「副歌」');
  });
});

describe('名字、秒數', () => {
  it('預設名字', () => {
    expect(defaultSaveAsName('副歌全開')).toBe('副歌全開（導演改）');
    expect(defaultCopyName('副歌全開')).toBe('副歌全開（複製）');
    expect(saveAsHint('30')).toContain('只有這首歌');
    expect(saveAsHint('30')).toContain('30-1');
    expect(copyHint('30', false)).not.toContain('還沒存');
    expect(copyHint('30', true)).toContain('還沒存的不會一起複製');
  });
  it('打的秒數：0 到 3600、可以有小數、後面寫「秒」也行；其他都不收', () => {
    expect(parseSeconds('2')).toEqual({ ok: true, value: 2 });
    expect(parseSeconds(' 1.5 ')).toEqual({ ok: true, value: 1.5 });
    expect(parseSeconds('0')).toEqual({ ok: true, value: 0 });
    expect(parseSeconds('3秒')).toEqual({ ok: true, value: 3 });
    expect(parseSeconds('3600')).toEqual({ ok: true, value: 3600 });
    for (const bad of ['', ' ', 'abc', '-1', '3601', '1,5', '1e3', '.5', '2..5', 'Infinity']) {
      expect(parseSeconds(bad).ok, bad).toBe(false);
    }
    expect(secText(2)).toBe('2');
    expect(secText(2.555)).toBe('2.56');
  });
  it('轉場秒數：這首歌自己設了 → 寫「這首歌自己設了 X 秒」、改的是這首歌自己的；沒有 → 改 Cue 庫的、先列出受影響的歌', () => {
    const own = secondsHint({ own: true, label: '30', ownSeconds: 3, librarySeconds: 1.5, songs: [] });
    expect(own).toContain('這首歌自己設了 3 秒');
    expect(own).toContain('改的是這首歌自己的');
    expect(own).toContain('1.5 秒');
    const lib = secondsHint({ own: false, label: '30', ownSeconds: 1.5, librarySeconds: 1.5, songs: [{ name: 'a', code: 'S05' }, { name: 'b', code: 'S12' }] });
    expect(lib).toBe('改的是 cue 30 的轉場（Cue 庫的），這些歌會一起變：S05、S12。');
    expect(secondsHint({ own: false, label: '30', ownSeconds: 1, librarySeconds: 1, songs: [] })).toBe('改的是 cue 30 的轉場（Cue 庫的）。');
    expect(secondsTitle(true, '30')).toContain('這首歌');
    expect(secondsTitle(false, '30')).toBe('改 cue 30 的轉場秒數');
    expect(secondsDoneText(true, '30', 2)).toBe('這首歌的 cue 30 轉場改成 2 秒');
    expect(secondsDoneText(false, '30', 2)).toBe('cue 30 的轉場改成 2 秒（用到的歌一起變）');
  });
});

describe('畫面上的字', () => {
  it('沒有英文叫人的字、沒有 emoji；三顆按鈕的字跟規格一樣', () => {
    expect(STAGE_SAVE_TEXT.saveBack).toBe('存回 Cue 庫');
    expect(STAGE_SAVE_TEXT.saveAs).toBe('另存成新 cue');
    expect(STAGE_SAVE_TEXT.discard).toBe('放棄改動');
    const all = [
      ...Object.values(STAGE_SAVE_TEXT).map(v => (typeof v === 'function' ? v('30') : v)),
      saveBackMessage([{ name: 'a', code: 'S1' }], 2), savedText('30', 1, []), undoneText('30'), savedAsText('30-1'), copiedText('30-1'), renamedText('30', 'x'),
      saveAsHint('30'), copyHint('30', true), secondsHint({ own: true, label: '1', ownSeconds: 1, librarySeconds: 2, songs: [] }),
      secondsTitle(false, '1'), secondsDoneText(true, '1', 1),
    ].join('\n');
    expect(all).not.toMatch(/\b(users?|admins?|directors?|animators?)\b/i);
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
