import { describe, it, expect } from 'vitest';
import { cueAtTime } from './cueTiming';

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
