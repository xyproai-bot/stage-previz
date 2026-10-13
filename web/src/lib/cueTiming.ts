// 影片時間 → 哪個 cue：找「對應影片時間 ≤ 現在」的最後一個 cue（cue 在管理頁設的 videoTimeSec）
// 還沒到第一個有時間的 cue 時回傳第一個；都沒設時間回傳 null（不自動切）

export function cueAtTime(
  cues: { id: string; videoTimeSec: number | null }[],
  currentTime: number,
): string | null {
  const timed = cues
    .filter(c => c.videoTimeSec != null)
    .sort((a, b) => (a.videoTimeSec as number) - (b.videoTimeSec as number));
  if (timed.length === 0) return null;
  let target = timed[0];
  for (const c of timed) {
    if ((c.videoTimeSec as number) <= currentTime) target = c;
    else break;
  }
  return target.id;
}

/**
 * 播本地影片時 cue 列該亮哪一個（亮的要跟舞台一致）：
 *   - 亮的是有影片時間的 cue（或沒亮）→ 舞台照影片時間軸擺 → 一律亮 cueAtTime
 *   - 亮的是沒設影片時間的 cue（手動點的）→ 舞台照那個 cue 擺（時間軸暫停）→ 留著，
 *     直到影片走進下一段（應該的 cue 跟上次不同）才回到時間軸
 * lastTargetId = 上一次算的 cueAtTime；回傳要亮的 + 這次的 cueAtTime（下次當 lastTargetId）
 */
export function videoCueSelection(
  cues: { id: string; videoTimeSec: number | null }[],
  currentTime: number,
  selectedId: string | null,
  lastTargetId: string | null,
): { selectedId: string | null; targetId: string | null } {
  const targetId = cueAtTime(cues, currentTime);
  if (!targetId) return { selectedId, targetId };  // 都沒設時間 → 不自動切
  const selected = cues.find(c => c.id === selectedId);
  const manual = !!selected && selected.videoTimeSec == null;
  if (manual && targetId === lastTargetId) return { selectedId, targetId };
  return { selectedId: targetId, targetId };
}

// 換 cue 時舞台移動要花幾秒：cue 有設 crossfade 就用它，沒設（0）就用預設，讓切換是滑過去不是瞬間跳
export const DEFAULT_CUE_TRANSITION_SECONDS = 1;

export function cueTransitionSeconds(cue: { crossfadeSeconds: number } | null | undefined): number {
  return cue && cue.crossfadeSeconds > 0 ? cue.crossfadeSeconds : DEFAULT_CUE_TRANSITION_SECONDS;
}

// 換 cue 時舞台移動走到哪了（0 = 還在舊位置、1 = 到新位置）
// 等速：從頭到尾同一個速度，不會一開始慢、最後拖很久（長秒數時特別明顯）
export function cueMoveProgress(elapsedMs: number, durationMs: number): number {
  if (!(durationMs > 0)) return 1;
  return Math.min(Math.max(elapsedMs / durationMs, 0), 1);
}
