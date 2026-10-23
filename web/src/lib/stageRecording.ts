// 工作站「錄成影片」：3D 舞台 + 貼在 LED 上的影片 → 一個影片檔（給不想學新工具的導演看）
// 這裡只放純函式（選格式、檔名、解析度、錄的範圍、進度、字幕），好測；真的錄影在 useStageRecorder.ts。

export interface RecordResolution {
  id: '1080p' | '720p' | '2160p';
  width: number;
  height: number;
  label: string;
  /** 選了要提醒的一句話 */
  note?: string;
}

export const RECORD_RESOLUTIONS: readonly RecordResolution[] = [
  { id: '1080p', width: 1920, height: 1080, label: '1920×1080（預設）' },
  { id: '720p', width: 1280, height: 720, label: '1280×720（檔案小）' },
  { id: '2160p', width: 3840, height: 2160, label: '3840×2160（4K）', note: '4K 很吃電腦，可能錄得不順；不順請改 1920×1080' },
];

export const DEFAULT_RECORD_RESOLUTION = RECORD_RESOLUTIONS[0];

export function recordResolution(id: string | null | undefined): RecordResolution {
  return RECORD_RESOLUTIONS.find(r => r.id === id) ?? DEFAULT_RECORD_RESOLUTION;
}

// ── 格式 ──

export interface RecordFormat {
  mimeType: string;
  ext: 'mp4' | 'webm';
  /** 真的是 mp4（不是退而求其次的 webm） */
  isMp4: boolean;
}

const MP4_CANDIDATES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4'];
const WEBM_CANDIDATES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

/** 這個瀏覽器能錄的格式：先 mp4（H.264），不行才 webm；都不行 = null */
export function pickRecordFormat(isTypeSupported: (mime: string) => boolean): RecordFormat | null {
  const ok = (m: string) => { try { return isTypeSupported(m); } catch { return false; } };
  for (const m of MP4_CANDIDATES) if (ok(m)) return { mimeType: m, ext: 'mp4', isMp4: true };
  for (const m of WEBM_CANDIDATES) if (ok(m)) return { mimeType: m, ext: 'webm', isMp4: false };
  return null;
}

export const WEBM_NOTE = '這個瀏覽器只能存成 webm，Google Drive 一樣能播';

/** 能不能在這個瀏覽器錄；不能 = 原因（按鈕灰掉時寫給使用者看），能 = null */
export function recordUnsupportedReason(env: {
  hasMediaRecorder: boolean;
  hasCaptureStream: boolean;
  format: RecordFormat | null;
}): string | null {
  if (!env.hasMediaRecorder) return '這個瀏覽器不支援錄影（手機 / iPad 的瀏覽器常常不行），請用電腦的 Chrome 或 Edge';
  if (!env.hasCaptureStream) return '這個瀏覽器沒辦法把 3D 畫面錄下來，請用電腦的 Chrome 或 Edge';
  if (!env.format) return '這個瀏覽器沒有可用的影片格式，請用電腦的 Chrome 或 Edge';
  return null;
}

// ── 檔名 ──

/** 檔名不能有的字元換成空白；連續空白縮成一個；太長截掉 */
export function cleanNamePart(s: string | null | undefined, max = 40): string {
  const t = (s ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(t).slice(0, max).join('').trim();
}

/** 本地檔名去掉副檔名（「final_v3.mp4」→「final_v3」） */
export function stripExt(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
}

export function dateStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** 「專案-歌名-版本或檔名-日期.mp4」；缺的那一段跳過 */
export function recordFileName(o: { project?: string | null; song?: string | null; source?: string | null; date: Date; ext: 'mp4' | 'webm' }): string {
  const parts = [cleanNamePart(o.project), cleanNamePart(o.song), cleanNamePart(o.source), dateStamp(o.date)].filter(Boolean);
  return `${parts.join('-')}.${o.ext}`;
}

// ── 範圍 / 進度 ──

export type RecordScope = 'all' | 'fromNow';

export interface RecordRange {
  start: number;
  end: number;
  /** 要錄幾秒 */
  length: number;
}

/** 整首 = 0 到結束；從目前時間 = 現在到結束（現在已經在最後 0.5 秒內就當整首，不然會錄出空的） */
export function recordRange(scope: RecordScope, currentTime: number, duration: number): RecordRange {
  const end = Number.isFinite(duration) && duration > 0 ? duration : 0;
  let start = 0;
  if (scope === 'fromNow' && Number.isFinite(currentTime) && currentTime > 0 && currentTime < end - 0.5) start = currentTime;
  return { start, end, length: Math.max(0, end - start) };
}

export interface RecordProgress {
  /** 已經錄了幾秒 */
  elapsed: number;
  length: number;
  /** 0 到 1 */
  fraction: number;
  done: boolean;
}

/** 影片現在播到 videoTime → 錄了多少（影片時間算，不看牆上時鐘，暫停卡住也不會亂跳） */
export function recordProgress(range: RecordRange, videoTime: number): RecordProgress {
  const elapsed = Math.min(range.length, Math.max(0, (Number.isFinite(videoTime) ? videoTime : range.start) - range.start));
  const fraction = range.length > 0 ? elapsed / range.length : 1;
  // 差 0.08 秒內（一格多一點）算播完；video 自己的 ended 也會觸發
  return { elapsed, length: range.length, fraction, done: range.length - elapsed < 0.08 };
}

/** 「0:12 / 3:45」 */
export function progressLabel(p: Pick<RecordProgress, 'elapsed' | 'length'>): string {
  return `${clock(p.elapsed)} / ${clock(p.length)}`;
}

function clock(sec: number): string {
  const s = Math.floor(Math.max(0, sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 錄影的 bit 率：解析度越大越高（H.264 / VP9 抓個大概，給 MediaRecorder 的 videoBitsPerSecond） */
export function recordBitrate(width: number, height: number): number {
  const px = width * height;
  return Math.round(Math.min(40_000_000, Math.max(4_000_000, px * 6)));
}

// ── cue 字幕 ──

/** 左下角小字：「Cue 3 副歌全開」；沒有 cue = 空字串（不畫） */
export function cueCaption(index: number, name: string | null | undefined): string {
  if (index < 0) return '';
  const n = (name ?? '').trim();
  return n ? `Cue ${index + 1} ${n}` : `Cue ${index + 1}`;
}

/** 目前選到哪個 cue（用 id 找順序）的字幕 */
export function captionForCue(cues: readonly { id: string; name: string }[], cueId: string | null): string {
  if (!cueId) return '';
  const i = cues.findIndex(c => c.id === cueId);
  return i < 0 ? '' : cueCaption(i, cues[i].name);
}

/** 把字幕畫在畫面左下角（字大小跟著畫面高度，1080p 約 34px） */
export function drawCaption(ctx: CanvasRenderingContext2D, width: number, height: number, text: string): void {
  if (!text) return;
  const size = Math.max(14, Math.round(height / 32));
  const pad = Math.round(size * 0.6);
  const margin = Math.round(size * 1.1);
  ctx.save();
  ctx.font = `600 ${size}px system-ui, "Noto Sans TC", "Microsoft JhengHei", sans-serif`;
  ctx.textBaseline = 'middle';
  const w = Math.min(width - margin * 2, ctx.measureText(text).width + pad * 2);
  const h = size + pad * 1.4;
  const x = margin;
  const y = height - margin - h;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x + pad, y + h / 2, w - pad * 2);
  ctx.restore();
}
