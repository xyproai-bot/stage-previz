import { describe, expect, it } from 'vitest';
import { songCueCounts } from './editorSongs';

describe('songCueCounts（歌單上的「N 個 cue」）', () => {
  it('正式 cue 和提案分開數', () => {
    expect(songCueCounts([{ status: 'master' }, { status: 'master' }, { status: 'proposal' }])).toEqual({ cueCount: 2, proposalCount: 1 });
  });
  it('沒有 cue → 0', () => {
    expect(songCueCounts([])).toEqual({ cueCount: 0, proposalCount: 0 });
  });
});
