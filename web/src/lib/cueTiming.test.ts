import { describe, it, expect } from 'vitest';
import {
  cueAtTime, cueTransitionSeconds, cueMoveProgress, DEFAULT_CUE_TRANSITION_SECONDS, NEW_CUE_CROSSFADE_SECONDS,
  videoCueSelection, parseCrossfadeInput, crossfadeLabel, parseVideoTimeInput,
} from './cueTiming';

const cues = [
  { id: 'intro', videoTimeSec: 0 },
  { id: 'verse', videoTimeSec: 12.5 },
  { id: 'nope', videoTimeSec: null },
  { id: 'chorus', videoTimeSec: 40 },
];

describe('cueAtTime', () => {
  it('回傳時間 ≤ 現在的最後一個 cue', () => {
    expect(cueAtTime(cues, 0)).toBe('intro');
    expect(cueAtTime(cues, 12.4)).toBe('intro');
    expect(cueAtTime(cues, 12.5)).toBe('verse');
    expect(cueAtTime(cues, 99)).toBe('chorus');
  });
  it('順序亂的也行', () => {
    expect(cueAtTime([cues[3], cues[0], cues[1]], 20)).toBe('verse');
  });
  it('還沒到第一個有時間的 cue → 第一個', () => {
    expect(cueAtTime([{ id: 'a', videoTimeSec: 5 }], 1)).toBe('a');
  });
  it('都沒設時間 → null', () => {
    expect(cueAtTime([{ id: 'a', videoTimeSec: null }], 3)).toBeNull();
    expect(cueAtTime([], 3)).toBeNull();
  });
});

describe('cueTransitionSeconds', () => {
  it('cue 有設 crossfade → 用 cue 的', () => {
    expect(cueTransitionSeconds({ crossfadeSeconds: 2.5 })).toBe(2.5);
    expect(cueTransitionSeconds({ crossfadeSeconds: 1 })).toBe(1);
  });
  it('0 = 直接切換（不滑），不再偷偷變成預設 1 秒', () => {
    expect(cueTransitionSeconds({ crossfadeSeconds: 0 })).toBe(0);
  });
  it('壞資料（負的 / 不是數字）→ 直接切換', () => {
    expect(cueTransitionSeconds({ crossfadeSeconds: -3 })).toBe(0);
    expect(cueTransitionSeconds({ crossfadeSeconds: NaN })).toBe(0);
  });
  it('還沒選 cue（看預設位置）→ 預設平滑秒數', () => {
    expect(cueTransitionSeconds(undefined)).toBe(DEFAULT_CUE_TRANSITION_SECONDS);
    expect(cueTransitionSeconds(null)).toBe(DEFAULT_CUE_TRANSITION_SECONDS);
    expect(DEFAULT_CUE_TRANSITION_SECONDS).toBeGreaterThan(0);
  });
  it('新增的 cue 預設滑 1 秒', () => {
    expect(NEW_CUE_CROSSFADE_SECONDS).toBe(1);
    expect(cueTransitionSeconds({ crossfadeSeconds: NEW_CUE_CROSSFADE_SECONDS })).toBe(1);
  });
});

describe('parseCrossfadeInput（淡入淡出欄位的檢查）', () => {
  it('數字 → 存（小數點留兩位）', () => {
    expect(parseCrossfadeInput('1.5')).toBe(1.5);
    expect(parseCrossfadeInput(' 2 ')).toBe(2);
    expect(parseCrossfadeInput('0')).toBe(0);
    expect(parseCrossfadeInput('0.333')).toBe(0.33);
  });
  it('空白 / 不是數字 / 負的 → null（不存，欄位還原）', () => {
    expect(parseCrossfadeInput('')).toBeNull();
    expect(parseCrossfadeInput('   ')).toBeNull();
    expect(parseCrossfadeInput('abc')).toBeNull();
    expect(parseCrossfadeInput('1s')).toBeNull();
    expect(parseCrossfadeInput('-1')).toBeNull();
    expect(parseCrossfadeInput('Infinity')).toBeNull();
  });
});

describe('crossfadeLabel（cue 清單上寫的）', () => {
  it('有秒數 → 淡入淡出幾秒；0 → 直接切換', () => {
    expect(crossfadeLabel(1)).toBe('淡入淡出 1 秒');
    expect(crossfadeLabel(2.5)).toBe('淡入淡出 2.5 秒');
    expect(crossfadeLabel(0)).toBe('直接切換');
    expect(crossfadeLabel(NaN)).toBe('直接切換');
  });
});

describe('cueMoveProgress', () => {
  it('等速：走到一半時間就走一半路、四分之一時間就走四分之一', () => {
    expect(cueMoveProgress(10000, 20000)).toBe(0.5);
    expect(cueMoveProgress(5000, 20000)).toBe(0.25);
    expect(cueMoveProgress(15000, 20000)).toBe(0.75);
  });
  it('還沒開始 → 0；超過時間 → 1', () => {
    expect(cueMoveProgress(-100, 20000)).toBe(0);
    expect(cueMoveProgress(0, 20000)).toBe(0);
    expect(cueMoveProgress(20000, 20000)).toBe(1);
    expect(cueMoveProgress(99999, 20000)).toBe(1);
  });
  it('時間是 0 → 直接到位', () => {
    expect(cueMoveProgress(0, 0)).toBe(1);
    expect(cueMoveProgress(500, -1)).toBe(1);
  });
});

describe('videoCueSelection（播影片時 cue 列亮哪個，要跟舞台一致）', () => {
  it('亮的是有時間的 cue → 一律照影片時間（就算影片時間沒換段也會改過來）', () => {
    // 例：放圖片時點了 chorus，切回影片時影片在 verse 那段 → 改亮 verse（舞台也在 verse）
    expect(videoCueSelection(cues, 20, 'chorus', 'verse')).toEqual({ selectedId: 'verse', targetId: 'verse' });
    expect(videoCueSelection(cues, 45, 'verse', 'verse')).toEqual({ selectedId: 'chorus', targetId: 'chorus' });
    expect(videoCueSelection(cues, 20, null, null)).toEqual({ selectedId: 'verse', targetId: 'verse' });
  });
  it('點有時間的 cue（已經跳到那個時間）→ 就是它', () => {
    expect(videoCueSelection(cues, 40, 'chorus', 'verse')).toEqual({ selectedId: 'chorus', targetId: 'chorus' });
  });
  it('手動點沒時間的 cue → 留著，影片在同一段時不搶回來', () => {
    expect(videoCueSelection(cues, 20, 'nope', 'verse')).toEqual({ selectedId: 'nope', targetId: 'verse' });
    expect(videoCueSelection(cues, 30, 'nope', 'verse')).toEqual({ selectedId: 'nope', targetId: 'verse' });
  });
  it('手動點沒時間的 cue → 影片走進下一段就回到時間軸', () => {
    expect(videoCueSelection(cues, 40, 'nope', 'verse')).toEqual({ selectedId: 'chorus', targetId: 'chorus' });
  });
  it('都沒設時間 → 不動', () => {
    const none = [{ id: 'a', videoTimeSec: null }, { id: 'b', videoTimeSec: null }];
    expect(videoCueSelection(none, 10, 'b', null)).toEqual({ selectedId: 'b', targetId: null });
  });
});

describe('parseVideoTimeInput（對應影片時間欄位的檢查）', () => {
  it('秒數 / 分:秒', () => {
    expect(parseVideoTimeInput('15.5')).toEqual({ ok: true, value: 15.5 });
    expect(parseVideoTimeInput('1:23')).toEqual({ ok: true, value: 83 });
    expect(parseVideoTimeInput(' 2:05.5 ')).toEqual({ ok: true, value: 125.5 });
    expect(parseVideoTimeInput('0')).toEqual({ ok: true, value: 0 });
  });
  it('空白 = 清掉對應時間', () => {
    expect(parseVideoTimeInput('')).toEqual({ ok: true, value: null });
    expect(parseVideoTimeInput('  ')).toEqual({ ok: true, value: null });
  });
  it('亂打不會被當成清掉（不存、欄位還原）', () => {
    for (const bad of ['abc', '-3', '1:2:3', '1:75', '1.5:10', ':30', '1:', '1:abc', '12s']) {
      expect(parseVideoTimeInput(bad)).toEqual({ ok: false });
    }
  });
});
