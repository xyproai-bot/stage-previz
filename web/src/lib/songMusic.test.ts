import { describe, expect, it } from 'vitest';
import {
  MIB, MUSIC_ACCEPT, MUSIC_MAX_BYTES, MUSIC_TEXT, canEditMusic, canSetCueTimeFromMusic, clockSource, cueTimeChanged, cueTimeFromMusic,
  studioHasVideo,
  formatMusicClock, formatMusicDuration, formatMusicSize, isMusicFile, musicFileProblem, musicLine, musicSummaryOf, setNowBlocker, setNowToast,
} from './songMusic';

describe('誰能做什麼', () => {
  it('上傳 / 換 / 移除：製作和導演；動畫師、不是成員都不行', () => {
    expect(canEditMusic('admin')).toBe(true);
    expect(canEditMusic('director')).toBe(true);
    for (const r of ['animator', null, undefined, '']) expect(canEditMusic(r)).toBe(false);
  });
  it('設 cue 的時間（邊聽邊按）：只有製作；導演不行', () => {
    expect(canSetCueTimeFromMusic('admin')).toBe(true);
    for (const r of ['director', 'animator', null, undefined]) expect(canSetCueTimeFromMusic(r)).toBe(false);
  });
});

describe('選檔', () => {
  const f = (name: string, type: string, size = 1000) => ({ name, type, size });
  it('MP3 / WAV / M4A / AAC / FLAC 收；類型空的看副檔名；影片和別的不收', () => {
    for (const [n, t] of [['a.mp3', 'audio/mpeg'], ['a.wav', 'audio/wav'], ['a.m4a', 'audio/x-m4a'], ['a.aac', 'audio/aac'], ['a.flac', 'audio/flac'], ['a.WAV', ''], ['a.m4a', ''], ['a.mp3', 'application/octet-stream']]) {
      expect(isMusicFile({ name: n, type: t }), `${n} ${t}`).toBe(true);
    }
    expect(isMusicFile({ name: 'x.m4a', type: 'video/mp4' })).toBe(true);    // 有些瀏覽器把 m4a 標成 video/mp4
    expect(isMusicFile({ name: 'mv.mp4', type: 'video/mp4' })).toBe(false);
    expect(isMusicFile({ name: 'mv.mov', type: '' })).toBe(false);
    expect(isMusicFile({ name: 'a.txt', type: 'text/plain' })).toBe(false);
    expect(isMusicFile({ name: 'noext', type: '' })).toBe(false);
  });
  it('跟後台同一套：後台不收的 audio 格式（OGG / Opus / WebM / AIFF / MIDI）選的當下就擋，不會先問「要換掉舊的嗎」；別名照收', () => {
    for (const [n, t] of [['a.ogg', 'audio/ogg'], ['a.opus', 'audio/opus'], ['a.weba', 'audio/webm'], ['a.aiff', 'audio/x-aiff'], ['a.mid', 'audio/midi'], ['a.amr', 'audio/amr']]) {
      expect(isMusicFile({ name: n, type: t }), `${n} ${t}`).toBe(false);
      expect(musicFileProblem({ name: n, type: t, size: 1000 }), `${n} ${t}`).toMatch(/不是我們收的音樂格式.*MP3 \/ WAV \/ M4A \/ AAC \/ FLAC/);
    }
    // 類型是 audio/ogg、檔名卻寫 .mp3：後台看類型 → 不收，這裡也一樣
    expect(isMusicFile({ name: 'a.mp3', type: 'audio/ogg' })).toBe(false);
    // 別名（各瀏覽器 / 作業系統寫法不同）、類型後面帶參數
    for (const t of ['audio/mp3', 'audio/x-mp3', 'audio/x-wav', 'audio/wave', 'audio/x-flac', 'audio/aacp', 'audio/x-m4a', 'audio/mpeg; charset=binary', 'AUDIO/MPEG']) {
      expect(isMusicFile({ name: 'x', type: t }), t).toBe(true);
    }
    // 類型是「一般檔案」才看副檔名
    for (const t of ['', 'application/octet-stream', 'binary/octet-stream', 'application/x-download']) {
      expect(isMusicFile({ name: 'a.flac', type: t }), t).toBe(true);
      expect(isMusicFile({ name: 'a.ogg', type: t }), t).toBe(false);
    }
  });
  it('上傳前先擋：不是音樂（影片會指去「加影片」）、空的、太大', () => {
    expect(musicFileProblem(f('a.mp3', 'audio/mpeg'))).toBeNull();
    expect(musicFileProblem(f('a.wav', 'audio/wav', MUSIC_MAX_BYTES))).toBeNull();            // 剛好上限可以
    expect(musicFileProblem(f('a.wav', 'audio/wav', MUSIC_MAX_BYTES + 1))).toMatch(/太大.*上限是 90 MB/);
    expect(musicFileProblem(f('a.mp3', 'audio/mpeg', 0))).toMatch(/是空的/);
    expect(musicFileProblem(f('mv.mp4', 'video/mp4'))).toMatch(/影片檔.*加影片.*MP3 \/ WAV \/ M4A \/ AAC \/ FLAC/);
    expect(musicFileProblem(f('a.txt', 'text/plain'))).toMatch(/不是我們收的音樂格式/);
    expect(musicFileProblem(f('a.mp3', 'audio/mpeg', 3 * MIB), 2 * MIB)).toMatch(/上限是 2 MB/);
  });
  it('選檔視窗 accept 列出五種副檔名', () => {
    for (const ext of ['.mp3', '.wav', '.m4a', '.aac', '.flac']) expect(MUSIC_ACCEPT).toContain(ext);
    expect(MUSIC_ACCEPT).not.toContain('video');
  });
  it('上限跟後台預設一樣：4 分鐘 48k/24bit 立體聲 WAV（約 66 MB）放得下', () => {
    expect(MUSIC_MAX_BYTES).toBe(90 * MIB);
    expect(4 * 60 * 48000 * 3 * 2).toBeLessThan(MUSIC_MAX_BYTES);
  });
});

describe('設在現在這一秒：什麼時候不能設', () => {
  it('沒選 cue / 提案的 cue / 音樂還沒載好（快捷鍵 M 不會像按鈕灰掉，要自己擋，不然會把 cue 的時間蓋成 0:00.0）', () => {
    expect(setNowBlocker({ cue: null, playerReady: true })).toBe(MUSIC_TEXT.setNowNoCue);
    expect(setNowBlocker({ cue: undefined, playerReady: false })).toBe(MUSIC_TEXT.setNowNoCue);
    expect(setNowBlocker({ cue: { status: 'proposal' }, playerReady: true })).toMatch(/提案的 cue 不能設時間/);
    expect(setNowBlocker({ cue: { status: 'master' }, playerReady: false })).toBe(MUSIC_TEXT.setNowNotReady);
    expect(MUSIC_TEXT.setNowNotReady).toMatch(/還沒載好.*重新載入/);
    expect(setNowBlocker({ cue: { status: 'master' }, playerReady: true })).toBeNull();
  });
});

describe('顯示', () => {
  it('長度 3:35；沒有 / 壞的 = 空字串', () => {
    expect(formatMusicDuration(215.4)).toBe('3:35');
    expect(formatMusicDuration(59.6)).toBe('1:00');
    expect(formatMusicDuration(0)).toBe('');
    expect(formatMusicDuration(null)).toBe('');
    expect(formatMusicDuration(NaN)).toBe('');
  });
  it('播放列的時間取到 0.1 秒（按「設在現在這一秒」存的就是這個數字）', () => {
    expect(formatMusicClock(0)).toBe('0:00.0');
    expect(formatMusicClock(83.44)).toBe('1:23.4');
    expect(formatMusicClock(83.46)).toBe('1:23.5');
    expect(formatMusicClock(59.96)).toBe('1:00.0');
    expect(formatMusicClock(5.04)).toBe('0:05.0');
    expect(formatMusicClock(-3)).toBe('0:00.0');
    expect(formatMusicClock(NaN)).toBe('0:00.0');
  });
  it('大小', () => {
    expect(formatMusicSize(40 * MIB)).toBe('40 MB');
    expect(formatMusicSize(850 * 1024)).toBe('850 KB');
    expect(formatMusicSize(12)).toBe('12 bytes');
    expect(formatMusicSize(null)).toBe('0 bytes');
  });
  it('一行：檔名 · 長度 · 大小', () => {
    expect(musicLine({ filename: 'S01 開場.mp3', durationSec: 215.4, sizeBytes: 5 * MIB })).toBe('S01 開場.mp3 · 3:35 · 5 MB');
    expect(musicLine({ filename: 'x.wav', durationSec: null, sizeBytes: null })).toBe('x.wav');
  });
  it('完整資料 → 歌單上的簡短資料（不帶播放網址）', () => {
    const full = { id: 'sm_1', filename: 'a.mp3', mime: 'audio/mpeg', sizeBytes: 1, durationSec: 2, uploadedAt: 't', songId: 's1', uploadedBy: null, streamUrl: '/x' };
    expect(musicSummaryOf(full)).toEqual({ id: 'sm_1', filename: 'a.mp3', mime: 'audio/mpeg', sizeBytes: 1, durationSec: 2, uploadedAt: 't' });
  });
  it('畫面上的字沒有英文叫人的字、沒有 emoji', () => {
    const all = Object.values(MUSIC_TEXT).join('\n') + setNowToast('Cue 3', 83.4);
    expect(all).not.toMatch(/\b(users?|admins?|directors?|animators?)\b/i);
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('放影片還是放音樂', () => {
  it('有影片 → 影片（不放音樂）；沒影片、有音樂 → 音樂；都沒有 → none', () => {
    expect(clockSource({ hasVideo: true, videosLoaded: true, hasMusic: true })).toBe('video');
    expect(clockSource({ hasVideo: true, videosLoaded: false, hasMusic: true })).toBe('video');
    expect(clockSource({ hasVideo: false, videosLoaded: true, hasMusic: true })).toBe('music');
    expect(clockSource({ hasVideo: false, videosLoaded: true, hasMusic: false })).toBe('none');
    expect(clockSource({ hasVideo: true, videosLoaded: true, hasMusic: false })).toBe('video');
  });
  it('影片版本還沒讀完、歌單上也沒有最新版本 → 先不放音樂（免得放一下又被影片蓋掉）', () => {
    expect(clockSource({ hasVideo: false, videosLoaded: false, hasMusic: true })).toBe('none');
  });
});

describe('動畫師工作站：什麼時候算有影片（有 → 放影片的聲音，音樂不放）', () => {
  const base = { hasVersion: false, latestVideoId: null, source: 'ndi', localKind: null };
  it('這首歌交過影片（選得到版本、或歌單上有最新一版）→ 有影片，不管 LED 現在選哪個來源', () => {
    for (const source of ['ndi', 'version', 'file']) {
      expect(studioHasVideo({ ...base, source, hasVersion: true }), source).toBe(true);
      expect(studioHasVideo({ ...base, source, latestVideoId: 'v1' }), source).toBe(true);
    }
  });
  it('LED 選了本地檔案、放的是影片 → 有影片；放的是圖片、沒選檔案、或來源不是本地檔案 → 不算', () => {
    expect(studioHasVideo({ ...base, source: 'file', localKind: 'video' })).toBe(true);
    expect(studioHasVideo({ ...base, source: 'file', localKind: 'image' })).toBe(false);
    expect(studioHasVideo({ ...base, source: 'file', localKind: null })).toBe(false);
    // 切到 AE 即時：本地影片已經停掉了，不算
    expect(studioHasVideo({ ...base, source: 'ndi', localKind: 'video' })).toBe(false);
    expect(studioHasVideo({ ...base, source: 'version', localKind: 'video' })).toBe(false);
  });
  it('沒交過影片、LED 沒放影片 → 沒有影片：有音樂就放音樂（AE 即時、本地圖片、什麼都沒放都一樣）', () => {
    for (const [source, localKind] of [['ndi', null], ['version', null], ['file', 'image'], ['file', null]] as const) {
      const hasVideo = studioHasVideo({ ...base, source, localKind });
      expect(clockSource({ hasVideo, videosLoaded: true, hasMusic: true }), `${source} ${localKind}`).toBe('music');
    }
  });
  it('有影片的歌（交上來的或本地的）照舊放影片，不放音樂', () => {
    expect(clockSource({ hasVideo: studioHasVideo({ ...base, hasVersion: true }), videosLoaded: true, hasMusic: true })).toBe('video');
    expect(clockSource({ hasVideo: studioHasVideo({ ...base, source: 'file', localKind: 'video' }), videosLoaded: true, hasMusic: true })).toBe('video');
  });
  it('缺資料也不會爆（歌單還沒到：latestVideoId 沒有）', () => {
    expect(studioHasVideo({ hasVersion: false, source: 'ndi' })).toBe(false);
    expect(studioHasVideo({ hasVersion: false, latestVideoId: undefined, source: 'file', localKind: undefined })).toBe(false);
  });
});

describe('邊聽邊按：音樂現在的時間 → cue 的對應影片時間', () => {
  it('取到 0.1 秒（四捨五入），不小於 0', () => {
    expect(cueTimeFromMusic(83.44)).toBe(83.4);
    expect(cueTimeFromMusic(83.46)).toBe(83.5);
    expect(cueTimeFromMusic(0.04)).toBe(0);
    expect(cueTimeFromMusic(12)).toBe(12);
    expect(cueTimeFromMusic(-5)).toBe(0);
    expect(cueTimeFromMusic(NaN)).toBe(0);
    expect(cueTimeFromMusic(Infinity)).toBe(0);
    expect(cueTimeFromMusic(215.99)).toBe(216);
  });
  it('跟原本一樣就不用存', () => {
    expect(cueTimeChanged(null, 12)).toBe(true);
    expect(cueTimeChanged(undefined, 0)).toBe(true);
    expect(cueTimeChanged(12, 12)).toBe(false);
    expect(cueTimeChanged(12, 12.1)).toBe(true);
  });
  it('提示：「Cue 3 開場」的對應影片時間設成 1:23.4', () => {
    expect(setNowToast('「開場」', 83.4)).toBe('「開場」的對應影片時間設成 1:23.4');
  });
});
