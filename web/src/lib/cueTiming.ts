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
