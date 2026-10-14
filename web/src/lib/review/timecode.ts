// 影片的格數（fps）、時間碼、逐格——純函式（timecode.test.ts 有測）
//
// 瀏覽器不會直接說影片幾格 → 播放時量每一格的時間（requestVideoFrameCallback 的 mediaTime），
// 取中位數再對到常見的格數（23.976、24、25、29.97、30、50、59.94、60）。量不到 = 1/30 秒一格。

export const DEFAULT_FPS = 30;
const COMMON_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];

/** 量到的格數 → 最近的常見格數（差 1.5% 以內），對不到就四捨五入到小數 2 位 */
export function snapFps(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return DEFAULT_FPS;
  let best = COMMON_FPS[0];
  for (const f of COMMON_FPS) if (Math.abs(f - raw) < Math.abs(best - raw)) best = f;
  return Math.abs(best - raw) / best <= 0.015 ? best : Math.round(raw * 100) / 100;
}

/** 量出來的格數要在這之間才信（電腦忙的時候畫面會掉格，量出來會偏低 → 不信，用 1/30 秒） */
export const MIN_TRUSTED_FPS = 20;
export const MAX_TRUSTED_FPS = 121;
const trusted = (f: number | null) => (f != null && f >= MIN_TRUSTED_FPS && f <= MAX_TRUSTED_FPS ? f : null);

/**
 * 每一格之間的時間（秒）→ fps；量得太少（< 8 格）、亂跳、太低（電腦忙在掉格）→ null
 * 掉格的時候間隔會是兩倍 → 用中位數；還是太低就不信
 */
export function estimateFps(deltas: readonly number[]): number | null {
  const ok = deltas.filter(d => Number.isFinite(d) && d > 1 / 130 && d < 1 / 8).sort((a, b) => a - b);
  if (ok.length < 8) return null;
  const mid = ok[Math.floor(ok.length / 2)];
  return trusted(snapFps(1 / mid));
}

/**
 * 播了一段之後：瀏覽器解碼的格數（顯示的 + 掉的，getVideoPlaybackQuality）÷ 影片走了幾秒 → fps。
 * 3D 很忙、畫面掉格也算得準（掉的格也算在裡面）。至少要播 1.5 秒；算出來不合理 → null
 */
export function fpsFromFrameCount(frames: number, mediaSeconds: number): number | null {
  if (!(mediaSeconds >= 1.5) || !(frames > 0)) return null;
  return trusted(snapFps(frames / mediaSeconds));
}

/** 一格幾秒 */
export function frameDuration(fps: number | null | undefined): number {
  return 1 / (fps && fps > 0 ? fps : DEFAULT_FPS);
}

/** 往前 / 往後一格要停在哪一秒（停在格子中間，瀏覽器才不會停到隔壁那格） */
export function stepFrameTime(current: number, dir: 1 | -1, fps: number | null | undefined, duration: number): number {
  const f = fps && fps > 0 ? fps : DEFAULT_FPS;
  const frame = Math.floor(current * f + 1e-6) + dir;
  const max = duration > 0 ? Math.max(0, Math.floor(duration * f - 1e-6)) : Infinity;
  const clamped = Math.max(0, Math.min(max, frame));
  return (clamped + 0.5) / f;
}

/**
 * 時間碼 HH:MM:SS:FF（29.97 / 59.94 用 30 / 60 格算，不做 drop-frame）。
 * 不知道幾格（fps = null）→ 一律用 30 格算（畫面上會說「還不知道幾格」）；匯出用 formatTimecodeOrMs
 */
export function formatTimecode(sec: number, fps: number | null | undefined): string {
  const base = Math.round(fps && fps > 0 ? fps : DEFAULT_FPS);
  const total = Math.max(0, Math.floor((Number.isFinite(sec) ? sec : 0) * base + 1e-6));
  const ff = total % base;
  const s = Math.floor(total / base);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`;
}

/** 匯出用：知道幾格 → HH:MM:SS:FF；不知道 → HH:MM:SS.mmm（不寫猜的格數） */
export function formatTimecodeOrMs(sec: number, fps: number | null | undefined): string {
  if (fps && fps > 0) return formatTimecode(sec, fps);
  const ms = Math.max(0, Math.round((Number.isFinite(sec) ? sec : 0) * 1000));
  const s = Math.floor(ms / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}.${p(ms % 1000, 3)}`;
}

/** 一般的時間 0:12（超過一小時 1:02:03） */
export function formatClockShort(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 區段 0:12–0:18；只有開始 = 0:12 */
export function formatRange(start: number, end?: number | null): string {
  return end != null && end > start ? `${formatClockShort(start)}–${formatClockShort(end)}` : formatClockShort(start);
}

/** 播放速度（0.5× / 1× / 2×） */
export const PLAYBACK_RATES = [0.5, 1, 2] as const;
export function rateLabel(r: number): string {
  return `${r}×`;
}
