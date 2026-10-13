// 管理頁歌單上每首歌的「N 個 cue」：跟後台算法一樣（正式 cue 和提案分開數）
import type { Cue } from './api';

export function songCueCounts(cues: ReadonlyArray<Pick<Cue, 'status'>>): { cueCount: number; proposalCount: number } {
  let cueCount = 0;
  let proposalCount = 0;
  for (const c of cues) {
    if (c.status === 'master') cueCount++;
    else if (c.status === 'proposal') proposalCount++;
  }
  return { cueCount, proposalCount };
}
