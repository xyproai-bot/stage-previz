import { describe, it, expect } from 'vitest';
import { cueAtTime, cueTransitionSeconds, cueMoveProgress, DEFAULT_CUE_TRANSITION_SECONDS } from './cueTiming';

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
  });
  it('沒設（0）或還沒選 cue → 預設平滑秒數', () => {
    expect(cueTransitionSeconds({ crossfadeSeconds: 0 })).toBe(DEFAULT_CUE_TRANSITION_SECONDS);
    expect(cueTransitionSeconds(undefined)).toBe(DEFAULT_CUE_TRANSITION_SECONDS);
    expect(DEFAULT_CUE_TRANSITION_SECONDS).toBeGreaterThan(0);
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
