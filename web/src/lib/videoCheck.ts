// 交影片前的檢查（純函式，videoCheck.test.ts 有測）：
//   瀏覽器播不播得了 → 播不了就擋下來（AE 常輸出 ProRes / HAP 的 .mov，瀏覽器播不了，傳了好幾 GB 才發現）
//   解析度太大、位元率太高、跟 LED 畫布不一樣大 → 提醒，可以照交
//
// 真的去試播（隱藏的 <video>）在 videoProbe.ts；這裡只管「結果怎麼判斷、話怎麼說」。
// 本地檔案（localVideo.ts）和貼連結的版本第一次播的時候，也用這裡的話。

import type { CanvasSize } from './ledMap';
import { templateVideoNote } from './ledTemplate';

/** 寬度超過這個：很多電腦（筆電、iPad）播不動 */
export const MAX_SAFE_WIDTH = 8192;
/** 位元率（檔案大小 ÷ 長度）超過這個：筆電播起來可能會卡 */
export const HIGH_BITRATE_MBPS = 80;
/** 長寬比差在這個比例以內算「比例對」 */
const ASPECT_TOLERANCE = 0.01;

/** 播不了的時候的那一句（上傳前擋下來、版本列、播放器都用這句） */
export const CANNOT_PLAY_TEXT = '這個影片瀏覽器播不了（可能是 ProRes / HAP 編碼）。請在 AE 輸出 H.264 MP4 再交';
/** 本地檔案（只在這台電腦放到 LED 上，不交出去）播不了 */
export const LOCAL_CANNOT_PLAY_TEXT = '瀏覽器播不了這個影片：可能是編碼不支援（例如 ProRes / HAP）或解析度太大。請轉成 H.264 MP4，寬度在 8192 以內再試';

/** 隱藏的 <video> 試播的結果 */
export type ProbeResult =
  | { ok: true; width: number; height: number; durationSec: number | null }
  /** decode：打不開（瀏覽器說格式不支援）/ noVideo：只讀得到聲音、沒有畫面 / timeout：等太久都沒有畫面 */
  | { ok: false; reason: 'decode' | 'noVideo' | 'timeout' };

/** 瀏覽器播不播得了這種編碼：yes 都可以 / some 看電腦 / no 大部分瀏覽器都不行 */
export type CodecSupport = 'yes' | 'some' | 'no';

export interface CodecInfo {
  /** 檔案裡寫的四個字（avc1、apch、Hap1…） */
  fourcc: string;
  /** 給人看的名字（H.264、Apple ProRes 422 HQ…） */
  label: string;
  family: 'h264' | 'hevc' | 'prores' | 'hap' | 'web' | 'pro' | 'other';
  support: CodecSupport;
}

const CODECS: Record<string, Omit<CodecInfo, 'fourcc'>> = {
  avc1: { label: 'H.264', family: 'h264', support: 'yes' },
  avc3: { label: 'H.264', family: 'h264', support: 'yes' },
  hvc1: { label: 'HEVC（H.265）', family: 'hevc', support: 'some' },
  hev1: { label: 'HEVC（H.265）', family: 'hevc', support: 'some' },
  dvh1: { label: 'Dolby Vision（HEVC）', family: 'hevc', support: 'some' },
  dvhe: { label: 'Dolby Vision（HEVC）', family: 'hevc', support: 'some' },
  apch: { label: 'Apple ProRes 422 HQ', family: 'prores', support: 'no' },
  apcn: { label: 'Apple ProRes 422', family: 'prores', support: 'no' },
  apcs: { label: 'Apple ProRes 422 LT', family: 'prores', support: 'no' },
  apco: { label: 'Apple ProRes 422 Proxy', family: 'prores', support: 'no' },
  ap4h: { label: 'Apple ProRes 4444', family: 'prores', support: 'no' },
  ap4x: { label: 'Apple ProRes 4444 XQ', family: 'prores', support: 'no' },
  aprn: { label: 'Apple ProRes RAW', family: 'prores', support: 'no' },
  aprh: { label: 'Apple ProRes RAW HQ', family: 'prores', support: 'no' },
  Hap1: { label: 'HAP', family: 'hap', support: 'no' },
  Hap5: { label: 'HAP Alpha', family: 'hap', support: 'no' },
  HapY: { label: 'HAP Q', family: 'hap', support: 'no' },
  HapM: { label: 'HAP Q Alpha', family: 'hap', support: 'no' },
  HapA: { label: 'HAP Alpha-Only', family: 'hap', support: 'no' },
  Hap7: { label: 'HAP R', family: 'hap', support: 'no' },
  av01: { label: 'AV1', family: 'web', support: 'yes' },
  vp08: { label: 'VP8', family: 'web', support: 'yes' },
  vp09: { label: 'VP9', family: 'web', support: 'yes' },
  AVdn: { label: 'Avid DNxHD', family: 'pro', support: 'no' },
  AVdh: { label: 'Avid DNxHR', family: 'pro', support: 'no' },
  CFHD: { label: 'GoPro CineForm', family: 'pro', support: 'no' },
  'rle ': { label: 'QuickTime Animation', family: 'pro', support: 'no' },
  'png ': { label: 'PNG（每一格一張圖）', family: 'pro', support: 'no' },
  'raw ': { label: '沒有壓縮', family: 'pro', support: 'no' },
  '2vuy': { label: '沒有壓縮（8-bit 4:2:2）', family: 'pro', support: 'no' },
  v210: { label: '沒有壓縮（10-bit 4:2:2）', family: 'pro', support: 'no' },
  jpeg: { label: 'Motion JPEG', family: 'pro', support: 'no' },
  mjpa: { label: 'Motion JPEG', family: 'pro', support: 'no' },
  mjpb: { label: 'Motion JPEG', family: 'pro', support: 'no' },
  mp4v: { label: 'MPEG-4 Part 2', family: 'other', support: 'no' },
};

/** 四個字 → 編碼；不認識的回 family 'other'、support 'some'（交給試播決定） */
export function codecFromFourcc(fourcc: string): CodecInfo {
  const known = CODECS[fourcc];
  if (known) return { fourcc, ...known };
  return { fourcc, label: fourcc.trim() || '不明', family: 'other', support: 'some' };
}

// ─── MP4 / MOV 裡找影像編碼（讀檔案的部分在 videoProbe.ts）───

/** MP4 / MOV 的一個 box：type 四個字、內容從 start 到 end（不含 box 開頭） */
interface Box { type: string; start: number; end: number }

function fourccAt(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
}

/** b 裡 [from, to) 這一段的 box（壞掉的就停） */
function childBoxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let o = from;
  while (o + 8 <= to) {
    let size = u32(b, o);
    const type = fourccAt(b, o + 4);
    let header = 8;
    if (size === 1) {
      if (o + 16 > to) break;
      const hi = u32(b, o + 8), lo = u32(b, o + 12);
      size = hi * 2 ** 32 + lo;
      header = 16;
    } else if (size === 0) {
      size = to - o;
    }
    if (size < header || o + size > to) break;
    out.push({ type, start: o + header, end: o + size });
    o += size;
  }
  return out;
}

/** 一個 box 開頭 8 / 16 bytes → { type, size, header }（size 0 = 到檔案最後） */
export function readBoxHeader(b: Uint8Array): { type: string; size: number; header: number } | null {
  if (b.length < 8) return null;
  let size = u32(b, 0);
  let header = 8;
  if (size === 1) {
    if (b.length < 16) return null;
    size = u32(b, 8) * 2 ** 32 + u32(b, 12);
    header = 16;
  }
  return { type: fourccAt(b, 4), size, header };
}

/**
 * moov box 的內容（或整個小檔案）→ 第一個影像軌的編碼（四個字）；找不到 = null
 * moov → trak → mdia → hdlr（'vide' = 影像軌）/ minf → stbl → stsd → 第一個樣本的種類
 */
export function videoFourccFromBoxes(data: Uint8Array): string | null {
  const top = childBoxes(data, 0, data.length);
  const moov = top.find(x => x.type === 'moov');
  // 給的可能是整個 moov box，也可能只是 moov 裡面的內容
  const traks = moov
    ? childBoxes(data, moov.start, moov.end).filter(x => x.type === 'trak')
    : top.filter(x => x.type === 'trak');
  for (const trak of traks) {
    const mdia = childBoxes(data, trak.start, trak.end).find(x => x.type === 'mdia');
    if (!mdia) continue;
    const inMdia = childBoxes(data, mdia.start, mdia.end);
    const hdlr = inMdia.find(x => x.type === 'hdlr');
    if (!hdlr || hdlr.start + 12 > hdlr.end || fourccAt(data, hdlr.start + 8) !== 'vide') continue;
    const minf = inMdia.find(x => x.type === 'minf');
    if (!minf) continue;
    const stbl = childBoxes(data, minf.start, minf.end).find(x => x.type === 'stbl');
    if (!stbl) continue;
    const stsd = childBoxes(data, stbl.start, stbl.end).find(x => x.type === 'stsd');
    // stsd：版本 / 旗標 4 + 幾個 4 + 第一個樣本（大小 4 + 種類 4）
    if (!stsd || stsd.start + 16 > stsd.end) continue;
    return fourccAt(data, stsd.start + 12);
  }
  return null;
}

// ─── 判斷 ───

export type CheckWarningKind = 'width' | 'bitrate' | 'canvasBlur' | 'canvasLarger' | 'canvasStretch' | 'codec';

export interface CheckWarning { kind: CheckWarningKind; text: string }

export interface VideoCheck {
  /** 播不了 → 擋下來（null = 可以交） */
  block: { text: string; detail: string | null } | null;
  /** 可以交，但要注意的 */
  warnings: CheckWarning[];
  /** 一行說明：1920×1080 · 3:00 · 約 25 Mbps · H.264（讀不到的不寫） */
  summary: string;
  /** 不是提醒、只是告訴你的事（例：影片剛好是 LED 版型的 50%，播放時自動放大貼回）；沒有就不會有這個欄位 */
  notes?: string[];
}

export interface CheckInput {
  probe: ProbeResult;
  /** 檔案大小（估位元率用） */
  sizeBytes?: number | null;
  /** 專案的 LED 畫布大小（還沒設定 = null → 不比） */
  ledCanvas?: CanvasSize | null;
  /** 檔案裡的影像編碼（讀不到 = null） */
  codec?: CodecInfo | null;
  /** 這首歌選的 LED 版型（整張畫布 / 沒選 = null → 照專案的 LED 畫布比）：影片大小跟版型畫布比，剛好等比例縮放就接受、標百分比，比例不一樣才提醒變形 */
  template?: { name: string; canvas: CanvasSize } | null;
}

/** 秒數 → 3:00 / 1:02:03 */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** 位元率（Mbps）= 檔案大小 × 8 ÷ 長度；算不出來 = null */
export function estimateBitrateMbps(sizeBytes: number | null | undefined, durationSec: number | null | undefined): number | null {
  if (!sizeBytes || !durationSec || !Number.isFinite(sizeBytes) || !Number.isFinite(durationSec) || durationSec <= 0 || sizeBytes <= 0) return null;
  return (sizeBytes * 8) / durationSec / 1e6;
}

const dims = (w: number, h: number) => `${w}×${h}`;

/** 影片大小跟 LED 畫布比：一樣 → null；比例對但比較小 / 比較大；比例不一樣（會被拉長） */
export function canvasWarning(video: CanvasSize, canvas: CanvasSize | null | undefined): CheckWarning | null {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0 || video.width <= 0 || video.height <= 0) return null;
  if (video.width === canvas.width && video.height === canvas.height) return null;
  const v = dims(video.width, video.height);
  const c = dims(canvas.width, canvas.height);
  const av = video.width / video.height;
  const ac = canvas.width / canvas.height;
  if (Math.abs(av - ac) / ac <= ASPECT_TOLERANCE) {
    if (video.width < canvas.width) {
      return { kind: 'canvasBlur', text: `影片是 ${v}，LED 畫布是 ${c}，比例對，但會比較糊` };
    }
    return { kind: 'canvasLarger', text: `影片是 ${v}，LED 畫布是 ${c}，比例對；影片比畫布大，檔案比較大、播放比較吃電腦，LED 上也不會更清楚` };
  }
  // 放到 LED 上一律撐滿整張畫布：橫的放大比較多 = 左右拉寬，直的放大比較多 = 上下拉長
  const sx = canvas.width / video.width;
  const sy = canvas.height / video.height;
  const how = sx > sy ? '左右拉寬' : '上下拉長';
  return {
    kind: 'canvasStretch',
    text: `影片是 ${v}，LED 畫布是 ${c}，比例不一樣：放到 LED 上畫面會被${how}（變形）。請用 ${c} 的合成輸出`,
  };
}

function blockDetail(input: CheckInput): string | null {
  const { probe, codec } = input;
  const named = codec && codec.family !== 'other' ? `檔案裡的影像編碼是 ${codec.label}` : null;
  if (probe.ok) {
    // 這台電腦播得了（例：Mac 的 Safari 播得了 ProRes），但大部分瀏覽器不行
    return `${named ?? '這個影片的編碼'}：你這台電腦播得了，但 Chrome、Edge、Firefox 大多播不了，導演、客戶很可能看不到`;
  }
  if (codec && (codec.family === 'h264' || codec.family === 'hevc')) {
    return `${named}，但這台電腦解不開：可能是 10-bit、4:2:2，或解析度太大`;
  }
  const why = probe.reason === 'noVideo' ? '只讀得到聲音、讀不到畫面'
    : probe.reason === 'timeout' ? '等了很久都讀不到畫面'
    : '瀏覽器打不開這個檔案的畫面';
  return named ? `${named}；${why}` : why;
}

/** 試播結果 + 檔案大小 + LED 畫布 → 要不要擋、要提醒什麼 */
export function assessVideo(input: CheckInput): VideoCheck {
  const { probe, sizeBytes, codec, template } = input;
  // 選了版型：影片是跟版型畫布比（不是整張 LED 畫布）
  const ledCanvas = template ? template.canvas : input.ledCanvas;
  const summaryParts: string[] = [];
  if (probe.ok) {
    summaryParts.push(dims(probe.width, probe.height));
    if (probe.durationSec) summaryParts.push(formatDuration(probe.durationSec));
  }
  const mbps = probe.ok ? estimateBitrateMbps(sizeBytes, probe.durationSec) : null;
  if (mbps !== null) summaryParts.push(`約 ${Math.round(mbps)} Mbps`);
  if (codec && codec.family !== 'other') summaryParts.push(codec.label);
  const summary = summaryParts.join(' · ');

  if (!probe.ok || codec?.support === 'no') {
    return { block: { text: CANNOT_PLAY_TEXT, detail: blockDetail(input) }, warnings: [], summary };
  }

  const warnings: CheckWarning[] = [];
  if (probe.width > MAX_SAFE_WIDTH) {
    const canvasWide = !!ledCanvas && ledCanvas.width > MAX_SAFE_WIDTH;
    warnings.push({
      kind: 'width',
      text: `影片寬 ${probe.width} px，超過 ${MAX_SAFE_WIDTH}：很多電腦（尤其筆電、iPad）會播不動或很卡`
        + (canvasWide ? '。LED 畫布本來就這麼寬的話可以照交，但請先在導演會用的電腦上試播' : ''),
    });
  }
  if (mbps !== null && mbps > HIGH_BITRATE_MBPS) {
    warnings.push({
      kind: 'bitrate',
      text: `位元率大約 ${Math.round(mbps)} Mbps（檔案大小 ÷ 長度），超過 ${HIGH_BITRATE_MBPS}：筆電播起來可能會卡。H.264 的 4K 建議 20–40 Mbps`,
    });
  }
  let notes: string[] | undefined;
  if (template) {
    const tn = templateVideoNote({ width: probe.width, height: probe.height }, template);
    if (tn?.level === 'warn') warnings.push({ kind: 'canvasStretch', text: tn.text });
    else if (tn) notes = [tn.text];
  } else {
    const cw = canvasWarning({ width: probe.width, height: probe.height }, ledCanvas);
    if (cw) warnings.push(cw);
  }
  if (codec?.family === 'hevc') {
    warnings.push({
      kind: 'codec',
      text: `這支是 ${codec.label}：你這台電腦播得了，但不是每台電腦都能播（要看顯示卡和瀏覽器），導演、客戶那邊可能看不到。建議改輸出 H.264 MP4`,
    });
  }
  return { block: null, warnings, summary, ...(notes ? { notes } : {}) };
}

// ─── 版本第一次播的時候（貼連結的版本沒辦法先檢查）───

/** 一版影片在這台電腦播的結果（存在這台電腦） */
export type PlayCheck =
  | { status: 'ok'; width: number; height: number; durationSec: number | null; at: number }
  | { status: 'cannotPlay'; reason: 'decode' | 'noVideo'; at: number };

/** 版本列上要顯示的：播不了 → 擋的那句；可以播 → 提醒（解析度、位元率、畫布） */
export function playCheckNotes(
  check: PlayCheck | null | undefined,
  opts: { sizeBytes?: number | null; ledCanvas?: CanvasSize | null; includeWarnings: boolean },
): { error: string | null; warnings: string[] } {
  if (!check) return { error: null, warnings: [] };
  if (check.status === 'cannotPlay') return { error: CANNOT_PLAY_TEXT, warnings: [] };
  if (!opts.includeWarnings) return { error: null, warnings: [] };
  const r = assessVideo({
    probe: { ok: true, width: check.width, height: check.height, durationSec: check.durationSec },
    sizeBytes: opts.sizeBytes,
    ledCanvas: opts.ledCanvas,
  });
  return { error: null, warnings: r.warnings.map(w => w.text) };
}
