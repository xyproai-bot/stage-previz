// 歌曲的音樂（沒有影片的歌，用音樂當「歌的時間」）— 畫面用的規則和文字（純函式，songMusic.test.ts 有測）。
//   後台：cf-worker/songMusic.mjs（API 文件 docs/music-api.md）；前端呼叫：musicApi.ts；
//   播放器：useMusicPlayer.ts（跟影片播放器同一個介面）；畫面：components/MusicBar.tsx、SongMusicField.tsx。
//
// 規則：
//   - 有影片 → 放影片（影片自己的聲音），不放音樂；沒影片才放音樂（clockSource）
//   - 上傳 / 換 / 移除：製作和導演；動畫師只能聽（canEditMusic）。後台會再檢查一次
//   - 邊聽邊按：選中的 cue 的「對應影片時間」= 音樂現在的時間，取到 0.1 秒（cueTimeFromMusic）；導演頁沒有這顆

import type { SongMusicSummary } from './musicApi';

export const MIB = 1024 * 1024;
/** 跟後台預設一樣（cf-worker/songMusic.mjs DEFAULT_MUSIC_MAX_BYTES）；真正的上限以後台為準，超過時後台會回說明 */
export const MUSIC_MAX_BYTES = 90 * MIB;
/** 選檔視窗 accept：MP3 / WAV / M4A / AAC / FLAC */
export const MUSIC_ACCEPT = '.mp3,.wav,.m4a,.aac,.flac,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/aac,audio/flac';
export const MUSIC_FORMATS_TEXT = 'MP3 / WAV / M4A / AAC / FLAC';
const MUSIC_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'flac'];

/** 畫面上的字（測試會對一遍，免得又寫出英文叫人的字） */
export const MUSIC_TEXT = {
  rowLabel: '音樂',
  none: '還沒有音樂',
  upload: '上傳音樂',
  replace: '換音樂',
  remove: '移除',
  cancel: '取消',
  hasVideoNote: '這首歌有影片，播放時聽影片的聲音，音樂不會播',
  busy: '處理中…',
  playTitle: '播放音樂（空白鍵）；機關時間軸和 3D 跟著音樂的時間',
  pauseTitle: '暫停音樂（空白鍵）',
  stopTitle: '停止（回到開頭，機關回到目前選的 cue）',
  muteTitle: '關掉聲音',
  unmuteTitle: '打開聲音',
  setNow: '設在現在這一秒',
  setNowHint: '把選中的 cue 的「對應影片時間」設成音樂現在播到的時間（取到 0.1 秒）。快捷鍵：M',
  setNowNoCue: '先選一個 cue，才能設時間',
  setNowNotReady: '音樂還沒載好（或載入失敗），先等它載好、或按播放列上的「重新載入」，才能設時間',
  loadFailed: '音樂載入失敗：可能是網路斷了、播放網址過期了，或這個瀏覽器播不了這個檔案',
  reload: '重新載入',
} as const;

// ─────────────────────────────────────────────
// 權限
// ─────────────────────────────────────────────

/** 能不能上傳 / 換 / 移除：這個專案的製作和導演（跟後台 canEditStage 一樣）；動畫師只能聽 */
export function canEditMusic(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'director';
}

/** 能不能用「設在現在這一秒」改 cue 的時間：只有製作（導演不能設 cue 的時間） */
export function canSetCueTimeFromMusic(role: string | null | undefined): boolean {
  return role === 'admin';
}

// ─────────────────────────────────────────────
// 選檔
// ─────────────────────────────────────────────

// 跟後台 cf-worker/songMusic.mjs 的 musicMimeFor 同一套：類型寫得清楚就看類型（只收這五種和它們的別名），
// 類型是「一般檔案」或沒寫才看副檔名。以前這裡是「任何 audio/ 開頭都算」，OGG / Opus 這種後台不收的檔案會先跳出
// 「要換掉舊的音樂嗎？」、按了才被後台退回；現在選的當下就擋掉。
const MUSIC_MIMES = new Set(['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/flac']);
const MUSIC_MIME_ALIASES: Record<string, string> = {
  'audio/mp3': 'audio/mpeg', 'audio/x-mp3': 'audio/mpeg', 'audio/mpeg3': 'audio/mpeg', 'audio/x-mpeg': 'audio/mpeg', 'audio/x-mpeg-3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/vnd.wave': 'audio/wav',
  'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/mp4a-latm': 'audio/mp4',
  'audio/x-aac': 'audio/aac', 'audio/aacp': 'audio/aac',
  'audio/x-flac': 'audio/flac',
};
const GENERIC_MIMES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/binary', 'application/x-download', 'application/force-download', 'application/download']);

/** 選的檔案是不是我們收的音樂（先看類型，類型空 / 是一般檔案的看副檔名；影片檔、OGG 之類不算） */
export function isMusicFile(file: { name: string; type: string }): boolean {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(file.name.trim())?.[1]?.toLowerCase() ?? '';
  const raw = String(file.type || '').split(';')[0].trim().toLowerCase();
  const mime = MUSIC_MIME_ALIASES[raw] || raw;
  if (MUSIC_MIMES.has(mime)) return true;
  if (GENERIC_MIMES.has(mime)) return MUSIC_EXTS.includes(ext);
  // 有些瀏覽器把 .m4a 標成 video/mp4
  return ext === 'm4a' && (mime === 'video/mp4' || mime === 'video/quicktime');
}

/** 上傳前先擋：不是音樂、太大、空的 → 回要顯示的說明；可以傳 → null */
export function musicFileProblem(file: { name: string; type: string; size: number }, maxBytes = MUSIC_MAX_BYTES): string | null {
  if (!isMusicFile(file)) {
    const looksVideo = file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|avi)$/i.test(file.name);
    return looksVideo
      ? `「${file.name}」是影片檔。影片請用「加影片」，音樂只收 ${MUSIC_FORMATS_TEXT}`
      : `「${file.name}」不是我們收的音樂格式，只收 ${MUSIC_FORMATS_TEXT}`;
  }
  if (file.size <= 0) return `「${file.name}」是空的`;
  if (file.size > maxBytes) return `「${file.name}」太大（${formatMusicSize(file.size)}），音樂上限是 ${formatMusicSize(maxBytes)}`;
  return null;
}

/** 上傳 / 查到的完整資料 → 歌單上帶的簡短資料（不帶播放網址、誰傳的） */
export function musicSummaryOf(m: SongMusicSummary): SongMusicSummary {
  return { id: m.id, filename: m.filename, mime: m.mime, sizeBytes: m.sizeBytes, durationSec: m.durationSec, uploadedAt: m.uploadedAt };
}

// ─────────────────────────────────────────────
// 顯示
// ─────────────────────────────────────────────

/** 3:35（沒有長度 = 空字串） */
export function formatMusicDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 1:23.4（播放列上的時間，取到 0.1 秒：按「設在現在這一秒」存的就是這個數字） */
export function formatMusicClock(sec: number): string {
  const t = cueTimeFromMusic(sec);
  const m = Math.floor(t / 60);
  const rest = t - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
}

/** 40 MB / 850 KB */
export function formatMusicSize(bytes: number | null | undefined): string {
  const v = Number(bytes) || 0;
  if (v >= MIB) return `${Math.round(v / MIB)} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} KB`;
  return `${v} bytes`;
}

/** 檔名 · 3:35 · 40 MB */
export function musicLine(m: Pick<SongMusicSummary, 'filename' | 'durationSec' | 'sizeBytes'>): string {
  return [m.filename, formatMusicDuration(m.durationSec), m.sizeBytes ? formatMusicSize(m.sizeBytes) : ''].filter(Boolean).join(' · ');
}

// ─────────────────────────────────────────────
// 放影片還是放音樂
// ─────────────────────────────────────────────

export type ClockSource = 'video' | 'music' | 'none';

/**
 * 這首歌的「歌的時間」跟誰走：
 *   有影片 → 影片（影片自己的聲音，不放音樂）；沒影片、有音樂 → 音樂；都沒有 → none
 *   還沒確定這首歌有沒有影片（版本清單還在讀，且歌單上也沒有最新版本）→ 先不放音樂，免得放一下又被影片蓋掉
 */
export function clockSource(o: { hasVideo: boolean; videosLoaded: boolean; hasMusic: boolean }): ClockSource {
  if (o.hasVideo) return 'video';
  if (!o.videosLoaded) return 'none';
  return o.hasMusic ? 'music' : 'none';
}

// ─────────────────────────────────────────────
// 邊聽邊按
// ─────────────────────────────────────────────

/** 音樂現在的時間 → cue 的「對應影片時間」：取到 0.1 秒（四捨五入），不小於 0 */
export function cueTimeFromMusic(sec: number): number {
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.round(sec * 10) / 10;
}

/**
 * 「設在現在這一秒」現在做得了嗎？不行 → 要跟人說的話；可以 → null。
 * 按鈕有灰掉，但快捷鍵 M 不會，所以這裡也要擋：音樂還沒載好 / 載入失敗時讀到的時間是 0，直接設會把 cue 的時間蓋成 0:00.0。
 */
export function setNowBlocker(o: { cue: { status: string } | null | undefined; playerReady: boolean }): string | null {
  if (!o.cue) return MUSIC_TEXT.setNowNoCue;
  if (o.cue.status !== 'master') return '提案的 cue 不能設時間，請先選正式的 cue';
  if (!o.playerReady) return MUSIC_TEXT.setNowNotReady;
  return null;
}

/** 設在現在這一秒的提示。cueLabel 已經是畫面上叫那個 cue 的樣子（例：「開場」、Cue 3「開場」） */
export function setNowToast(cueLabel: string, sec: number): string {
  return `${cueLabel}的對應影片時間設成 ${formatMusicClock(sec)}`;
}

/** 設在現在這一秒會不會有變化（跟原本一樣就不用存） */
export function cueTimeChanged(current: number | null | undefined, next: number): boolean {
  return current == null || Math.abs(current - next) > 1e-9;
}

// ─────────────────────────────────────────────
// 瀏覽器量長度
// ─────────────────────────────────────────────

/**
 * 用瀏覽器讀檔案的長度（秒）。讀不出來（瀏覽器打不開這個檔案）→ null；最多等 10 秒。
 * 只在瀏覽器裡用（要 document、URL.createObjectURL）。
 */
export function readAudioDuration(file: Blob, timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') { resolve(null); return; }
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    let done = false;
    const finish = (v: number | null) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      resolve(v);
    };
    const timer = window.setTimeout(() => finish(null), timeoutMs);
    audio.addEventListener('loadedmetadata', () => finish(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null), { once: true });
    audio.addEventListener('error', () => finish(null), { once: true });
    audio.src = url;
  });
}
