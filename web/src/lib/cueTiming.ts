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

// 換 cue 時舞台移動要花幾秒 = cue 的「轉場時間」，0 = 直接切換（不滑）。
// 還沒選 cue（看的是物件預設位置）時用預設秒數。
// 注意：2026-10 以前 0 代表「用預設 1 秒」，舊資料要先跑一次
//   UPDATE cues SET crossfade_seconds = 1 WHERE crossfade_seconds = 0
// 才不會從滑過去變成直接跳（交給後台那邊備份後執行）。
export const DEFAULT_CUE_TRANSITION_SECONDS = 1;
/** 新增 cue 時的轉場秒數（後台沒給就是 0 = 直接切換，所以新增時一定要帶） */
export const NEW_CUE_CROSSFADE_SECONDS = DEFAULT_CUE_TRANSITION_SECONDS;

export function cueTransitionSeconds(cue: { crossfadeSeconds: number } | null | undefined): number {
  if (!cue) return DEFAULT_CUE_TRANSITION_SECONDS;
  const s = cue.crossfadeSeconds;
  return Number.isFinite(s) && s > 0 ? s : 0;
}

/** 欄位裡打的轉場秒數 → 要存的數字；空白 / 不是數字 / 負的 → null（不存，欄位還原） */
export function parseCrossfadeInput(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

/**
 * 「對應影片時間」欄位 → 要存的秒數：
 *   空白 → { ok: true, value: null }（清掉對應時間）
 *   「15.5」或「1:23」「1:23.5」（分:秒，秒要小於 60）→ 秒數
 *   亂打 / 負的 → { ok: false }（不存，欄位還原；以前亂打會被當成清掉）
 */
export function parseVideoTimeInput(text: string): { ok: true; value: number | null } | { ok: false } {
  const t = text.trim();
  if (t === '') return { ok: true, value: null };
  const num = (x: string) => (/^(\d+\.?\d*|\.\d+)$/.test(x) ? Number(x) : NaN);
  let value: number;
  if (t.includes(':')) {
    const parts = t.split(':');
    if (parts.length !== 2) return { ok: false };
    const m = num(parts[0].trim());
    const sec = num(parts[1].trim());
    if (!Number.isInteger(m) || !(sec < 60)) return { ok: false };
    value = m * 60 + sec;
  } else {
    value = num(t);
  }
  if (!Number.isFinite(value) || value < 0) return { ok: false };
  return { ok: true, value: Math.round(value * 1000) / 1000 };
}

/** cue 清單上顯示的切換方式 */
export function crossfadeLabel(seconds: number): string {
  return Number.isFinite(seconds) && seconds > 0 ? `轉場 ${seconds} 秒` : '直接切換';
}

// 換 cue 時舞台移動走到哪了（0 = 還在舊位置、1 = 到新位置）
// 等速：從頭到尾同一個速度，不會一開始慢、最後拖很久（長秒數時特別明顯）
export function cueMoveProgress(elapsedMs: number, durationMs: number): number {
  if (!(durationMs > 0)) return 1;
  return Math.min(Math.max(elapsedMs / durationMs, 0), 1);
}
