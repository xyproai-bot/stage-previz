import { describe, it, expect } from 'vitest';
import { cueAtTime, cueTransitionSeconds, DEFAULT_CUE_TRANSITION_SECONDS } from './cueTiming';

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
