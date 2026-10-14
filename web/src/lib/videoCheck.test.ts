import { describe, expect, it } from 'vitest';
import {
  CANNOT_PLAY_TEXT, HIGH_BITRATE_MBPS, MAX_SAFE_WIDTH,
  assessVideo, canvasWarning, codecFromFourcc, estimateBitrateMbps, formatDuration, playCheckNotes, readBoxHeader,
  videoFourccFromBoxes, type ProbeResult,
} from './videoCheck';

const MB = 1e6 / 8; // 1 Mbps × 1 秒 = 125000 bytes
const ok = (width: number, height: number, durationSec: number | null = 180): ProbeResult => ({ ok: true, width, height, durationSec });

describe('assessVideo：播不了就擋', () => {
  it('打不開 / 只有聲音 / 等太久 → 擋下來，用同一句話', () => {
    for (const reason of ['decode', 'noVideo', 'timeout'] as const) {
      const r = assessVideo({ probe: { ok: false, reason }, sizeBytes: 5e9 });
      expect(r.block?.text).toBe(CANNOT_PLAY_TEXT);
      expect(r.warnings).toEqual([]);
    }
    expect(CANNOT_PLAY_TEXT).toBe('這個影片瀏覽器播不了（可能是 ProRes / HAP 編碼）。請在 AE 輸出 H.264 MP4 再交');
  });

  it('說明會寫原因；讀得到編碼就寫出來', () => {
    expect(assessVideo({ probe: { ok: false, reason: 'noVideo' } }).block?.detail).toBe('只讀得到聲音、讀不到畫面');
    expect(assessVideo({ probe: { ok: false, reason: 'timeout' } }).block?.detail).toBe('等了很久都讀不到畫面');
    expect(assessVideo({ probe: { ok: false, reason: 'decode' }, codec: codecFromFourcc('Hap1') }).block?.detail)
      .toBe('檔案裡的影像編碼是 HAP；瀏覽器打不開這個檔案的畫面');
    // H.264 也打不開 → 不要說是 ProRes 的問題
    expect(assessVideo({ probe: { ok: false, reason: 'decode' }, codec: codecFromFourcc('avc1') }).block?.detail)
      .toContain('H.264，但這台電腦解不開');
  });

  it('這台播得了，但檔案是 ProRes（例：Mac 的 Safari）→ 一樣擋，說別人看不到', () => {
    const r = assessVideo({ probe: ok(3840, 2160), sizeBytes: 30 * MB * 180, codec: codecFromFourcc('apch') });
    expect(r.block?.text).toBe(CANNOT_PLAY_TEXT);
    expect(r.block?.detail).toContain('Apple ProRes 422 HQ');
    expect(r.block?.detail).toContain('你這台電腦播得了');
  });

  it('H.264、跟畫布一樣大、位元率正常 → 沒有提醒', () => {
    const r = assessVideo({ probe: ok(3840, 2160, 180), sizeBytes: 30 * MB * 180, ledCanvas: { width: 3840, height: 2160 }, codec: codecFromFourcc('avc1') });
    expect(r.block).toBeNull();
    expect(r.warnings).toEqual([]);
    expect(r.summary).toBe('3840×2160 · 3:00 · 約 30 Mbps · H.264');
  });
});

describe('assessVideo：提醒但可以交', () => {
  it(`寬度超過 ${MAX_SAFE_WIDTH}`, () => {
    expect(assessVideo({ probe: ok(MAX_SAFE_WIDTH, 2048) }).warnings).toEqual([]);
    const r = assessVideo({ probe: ok(10496, 5120) });
    expect(r.block).toBeNull();
    expect(r.warnings.map(w => w.kind)).toEqual(['width']);
    expect(r.warnings[0].text).toContain('影片寬 10496 px，超過 8192');
    // LED 畫布本來就這麼寬：多一句
    const wide = assessVideo({ probe: ok(10496, 5120), ledCanvas: { width: 10496, height: 5120 } });
    expect(wide.warnings[0].text).toContain('LED 畫布本來就這麼寬');
  });

  it(`位元率超過 ${HIGH_BITRATE_MBPS} Mbps（檔案大小 ÷ 長度）`, () => {
    expect(assessVideo({ probe: ok(1920, 1080, 100), sizeBytes: 80 * MB * 100 }).warnings).toEqual([]);
    const r = assessVideo({ probe: ok(1920, 1080, 100), sizeBytes: 150 * MB * 100 });
    expect(r.warnings.map(w => w.kind)).toEqual(['bitrate']);
    expect(r.warnings[0].text).toContain('位元率大約 150 Mbps');
    // 不知道長度 → 不估
    expect(assessVideo({ probe: ok(1920, 1080, null), sizeBytes: 5e9 }).warnings).toEqual([]);
  });

  it('比例對但比較小 → 會比較糊（照規格的那句）', () => {
    const r = assessVideo({ probe: ok(1920, 1080), ledCanvas: { width: 3840, height: 2160 } });
    expect(r.warnings).toEqual([{ kind: 'canvasBlur', text: '影片是 1920×1080，LED 畫布是 3840×2160，比例對，但會比較糊' }]);
  });

  it('比例不一樣 → 會被拉長，說是哪個方向', () => {
    // 16:9 放到 8:3 的畫布：橫的放大比較多 → 左右拉寬
    expect(canvasWarning({ width: 1920, height: 1080 }, { width: 3840, height: 1440 })?.text)
      .toBe('影片是 1920×1080，LED 畫布是 3840×1440，比例不一樣：放到 LED 上畫面會被左右拉寬（變形）。請用 3840×1440 的合成輸出');
    // 很寬的影片放到 16:9 的畫布：直的放大比較多 → 上下拉長
    expect(canvasWarning({ width: 8800, height: 2024 }, { width: 3840, height: 2160 })?.text).toContain('上下拉長');
    expect(canvasWarning({ width: 8800, height: 2024 }, { width: 3840, height: 2160 })?.kind).toBe('canvasStretch');
  });

  it('比畫布大、一樣大、畫布還沒設定', () => {
    expect(canvasWarning({ width: 7680, height: 4320 }, { width: 3840, height: 2160 })?.kind).toBe('canvasLarger');
    expect(canvasWarning({ width: 3840, height: 2160 }, { width: 3840, height: 2160 })).toBeNull();
    expect(canvasWarning({ width: 1920, height: 1080 }, null)).toBeNull();
    // 差一點點（1% 以內）算比例對
    expect(canvasWarning({ width: 1920, height: 1088 }, { width: 3840, height: 2160 })?.kind).toBe('canvasBlur');
  });

  it('HEVC：播得了，但提醒別台電腦可能不行', () => {
    const r = assessVideo({ probe: ok(3840, 2160), codec: codecFromFourcc('hvc1') });
    expect(r.block).toBeNull();
    expect(r.warnings.map(w => w.kind)).toEqual(['codec']);
    expect(r.warnings[0].text).toContain('HEVC（H.265）');
  });

  it('好幾個問題一起列', () => {
    const r = assessVideo({ probe: ok(10496, 5120, 60), sizeBytes: 200 * MB * 60, ledCanvas: { width: 3840, height: 2160 } });
    expect(r.warnings.map(w => w.kind)).toEqual(['width', 'bitrate', 'canvasStretch']);
  });
});

describe('小工具', () => {
  it('formatDuration', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(180)).toBe('3:00');
    expect(formatDuration(59.6)).toBe('1:00');
    expect(formatDuration(3723)).toBe('1:02:03');
  });

  it('estimateBitrateMbps', () => {
    expect(estimateBitrateMbps(10 * MB * 60, 60)).toBeCloseTo(10);
    expect(estimateBitrateMbps(null, 60)).toBeNull();
    expect(estimateBitrateMbps(1000, 0)).toBeNull();
    expect(estimateBitrateMbps(1000, Infinity)).toBeNull();
  });

  it('codecFromFourcc：認識的寫名字，不認識的交給試播決定', () => {
    expect(codecFromFourcc('apcn')).toMatchObject({ label: 'Apple ProRes 422', family: 'prores', support: 'no' });
    expect(codecFromFourcc('HapY')).toMatchObject({ label: 'HAP Q', family: 'hap', support: 'no' });
    expect(codecFromFourcc('avc1')).toMatchObject({ family: 'h264', support: 'yes' });
    expect(codecFromFourcc('zzzz')).toMatchObject({ family: 'other', support: 'some' });
    // 不認識的編碼不會擋（試播過了就可以）
    expect(assessVideo({ probe: ok(1920, 1080), codec: codecFromFourcc('zzzz') }).block).toBeNull();
  });
});

// ─── MP4 / MOV 的 box ───

const ascii = (s: string) => Array.from(s, c => c.charCodeAt(0));
function box(type: string, ...parts: (number[] | Uint8Array)[]): Uint8Array {
  const body = parts.flatMap(p => Array.from(p));
  const size = 8 + body.length;
  return Uint8Array.from([(size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255, ...ascii(type), ...body]);
}
const hdlr = (handler: string) => box('hdlr', [0, 0, 0, 0], [0, 0, 0, 0], ascii(handler), new Array(12).fill(0));
const stsd = (fourcc: string) => box('stsd', [0, 0, 0, 0], [0, 0, 0, 1], box(fourcc, new Array(8).fill(0)));
const trak = (handler: string, fourcc: string) =>
  box('trak', box('tkhd', new Array(20).fill(0)), box('mdia', box('mdhd', new Array(8).fill(0)), hdlr(handler), box('minf', box('stbl', stsd(fourcc)))));

describe('videoFourccFromBoxes：MP4 / MOV 裡的影像編碼', () => {
  it('跳過聲音軌，找到影像軌的編碼', () => {
    const moov = box('moov', box('mvhd', new Array(20).fill(0)), trak('soun', 'lpcm'), trak('vide', 'apch'));
    expect(videoFourccFromBoxes(moov)).toBe('apch');
  });

  it('H.264 的 MP4、HAP 的 MOV', () => {
    expect(videoFourccFromBoxes(box('moov', trak('vide', 'avc1')))).toBe('avc1');
    expect(videoFourccFromBoxes(box('moov', trak('vide', 'Hap1'), trak('soun', 'mp4a')))).toBe('Hap1');
  });

  it('只有聲音、壞掉的、空的 → null', () => {
    expect(videoFourccFromBoxes(box('moov', trak('soun', 'mp4a')))).toBeNull();
    const good = box('moov', trak('vide', 'avc1'));
    expect(videoFourccFromBoxes(good.slice(0, good.length - 10))).toBeNull();
    expect(videoFourccFromBoxes(new Uint8Array(0))).toBeNull();
  });

  it('readBoxHeader：一般大小、64-bit 大小', () => {
    expect(readBoxHeader(Uint8Array.from([0, 0, 0, 24, ...ascii('ftyp')]))).toEqual({ type: 'ftyp', size: 24, header: 8 });
    const big = Uint8Array.from([0, 0, 0, 1, ...ascii('mdat'), 0, 0, 0, 1, 0, 0, 0, 16]);
    expect(readBoxHeader(big)).toEqual({ type: 'mdat', size: 2 ** 32 + 16, header: 16 });
    expect(readBoxHeader(new Uint8Array(4))).toBeNull();
  });
});

describe('playCheckNotes：版本第一次播之後，版本列上寫什麼', () => {
  it('播不了 → 那一句；可以播 → 貼連結的版本才列提醒', () => {
    expect(playCheckNotes({ status: 'cannotPlay', reason: 'decode', at: 1 }, { includeWarnings: false }))
      .toEqual({ error: CANNOT_PLAY_TEXT, warnings: [] });
    const played = { status: 'ok' as const, width: 1920, height: 1080, durationSec: 60, at: 1 };
    expect(playCheckNotes(played, { ledCanvas: { width: 3840, height: 2160 }, includeWarnings: false }))
      .toEqual({ error: null, warnings: [] });
    expect(playCheckNotes(played, { ledCanvas: { width: 3840, height: 2160 }, sizeBytes: 100 * MB * 60, includeWarnings: true }).warnings)
      .toEqual(['位元率大約 100 Mbps（檔案大小 ÷ 長度），超過 80：筆電播起來可能會卡。H.264 的 4K 建議 20–40 Mbps', '影片是 1920×1080，LED 畫布是 3840×2160，比例對，但會比較糊']);
    expect(playCheckNotes(null, { includeWarnings: true })).toEqual({ error: null, warnings: [] });
  });
});
