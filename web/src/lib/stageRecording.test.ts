import { describe, expect, it } from 'vitest';
import {
  RECORD_RESOLUTIONS, captionForCue, cueCaption, dateStamp, pickRecordFormat, progressLabel, recordBitrate, recordFileName,
  recordProgress, recordRange, recordResolution, recordUnsupportedReason, stripExt,
} from './stageRecording';

describe('選格式', () => {
  it('支援 mp4 就用 mp4', () => {
    const f = pickRecordFormat(m => m.startsWith('video/mp4') || m.startsWith('video/webm'));
    expect(f?.ext).toBe('mp4');
    expect(f?.isMp4).toBe(true);
    expect(f?.mimeType).toContain('avc1');
  });
  it('mp4 只認得較簡單的寫法也行', () => {
    const f = pickRecordFormat(m => m === 'video/mp4');
    expect(f).toMatchObject({ ext: 'mp4', mimeType: 'video/mp4' });
  });
  it('不支援 mp4 退到 webm', () => {
    const f = pickRecordFormat(m => m.startsWith('video/webm'));
    expect(f).toMatchObject({ ext: 'webm', isMp4: false });
    expect(f?.mimeType).toContain('vp9');
  });
  it('什麼都不支援 = null；判斷函式丟錯也不會壞', () => {
    expect(pickRecordFormat(() => false)).toBeNull();
    expect(pickRecordFormat(() => { throw new Error('x'); })).toBeNull();
  });
});

describe('不能錄的原因', () => {
  const fmt = { mimeType: 'video/mp4', ext: 'mp4', isMp4: true } as const;
  it('都支援 = null', () => {
    expect(recordUnsupportedReason({ hasMediaRecorder: true, hasCaptureStream: true, format: fmt })).toBeNull();
  });
  it('沒有 MediaRecorder / captureStream / 格式 各有原因', () => {
    expect(recordUnsupportedReason({ hasMediaRecorder: false, hasCaptureStream: true, format: fmt })).toContain('不支援錄影');
    expect(recordUnsupportedReason({ hasMediaRecorder: true, hasCaptureStream: false, format: fmt })).toContain('錄下來');
    expect(recordUnsupportedReason({ hasMediaRecorder: true, hasCaptureStream: true, format: null })).toContain('格式');
  });
});

describe('檔名', () => {
  it('專案-歌名-版本-日期.mp4', () => {
    const d = new Date(2026, 9, 23, 15, 0);
    expect(dateStamp(d)).toBe('20261023');
    expect(recordFileName({ project: '春季巡演', song: '01 開場', source: 'V3', date: d, ext: 'mp4' })).toBe('春季巡演-01 開場-V3-20261023.mp4');
  });
  it('檔名不能有的字元拿掉、缺的那段跳過', () => {
    const d = new Date(2026, 0, 5);
    expect(recordFileName({ project: 'A/B:C', song: null, source: '  final  v2 ', date: d, ext: 'webm' })).toBe('A B C-final v2-20260105.webm');
  });
  it('本地檔名去副檔名', () => {
    expect(stripExt('final_v3.mp4')).toBe('final_v3');
    expect(stripExt('a.b.mov')).toBe('a.b');
    expect(stripExt('noext')).toBe('noext');
  });
  it('太長的名字截短', () => {
    const f = recordFileName({ project: 'x'.repeat(100), date: new Date(2026, 0, 5), ext: 'mp4' });
    expect(f.length).toBeLessThan(60);
  });
});

describe('解析度', () => {
  it('預設 1080p，三種都有', () => {
    expect(RECORD_RESOLUTIONS.map(r => `${r.width}x${r.height}`)).toEqual(['1920x1080', '1280x720', '3840x2160']);
    expect(recordResolution(undefined).id).toBe('1080p');
    expect(recordResolution('720p').width).toBe(1280);
    expect(recordResolution('2160p').note).toContain('4K');
  });
  it('bit 率隨解析度變大、有上下限', () => {
    expect(recordBitrate(1280, 720)).toBeLessThan(recordBitrate(1920, 1080));
    expect(recordBitrate(1920, 1080)).toBeLessThan(recordBitrate(3840, 2160));
    expect(recordBitrate(100, 100)).toBe(4_000_000);
    expect(recordBitrate(7680, 4320)).toBe(40_000_000);
  });
});

describe('錄影範圍與進度', () => {
  it('整首 = 0 到結束', () => {
    expect(recordRange('all', 30, 100)).toEqual({ start: 0, end: 100, length: 100 });
  });
  it('從目前時間 = 現在到結束', () => {
    expect(recordRange('fromNow', 30, 100)).toEqual({ start: 30, end: 100, length: 70 });
  });
  it('已經在最後 0.5 秒內、或時間怪怪的 → 當整首', () => {
    expect(recordRange('fromNow', 99.8, 100).start).toBe(0);
    expect(recordRange('fromNow', NaN, 100).start).toBe(0);
    expect(recordRange('fromNow', -3, 100).start).toBe(0);
  });
  it('沒有長度 = 0 秒', () => {
    expect(recordRange('all', 0, NaN).length).toBe(0);
  });
  it('進度照影片時間算', () => {
    const r = recordRange('fromNow', 30, 100);
    expect(recordProgress(r, 30)).toMatchObject({ elapsed: 0, fraction: 0, done: false });
    const mid = recordProgress(r, 65);
    expect(mid.elapsed).toBe(35);
    expect(mid.fraction).toBeCloseTo(0.5);
    expect(recordProgress(r, 99.95).done).toBe(true);
    expect(recordProgress(r, 100)).toMatchObject({ elapsed: 70, fraction: 1, done: true });
  });
  it('影片還停在範圍前面不會變負的', () => {
    const r = recordRange('fromNow', 30, 100);
    expect(recordProgress(r, 10).elapsed).toBe(0);
  });
  it('時間文字', () => {
    expect(progressLabel({ elapsed: 12.9, length: 225 })).toBe('0:12 / 3:45');
  });
});

describe('cue 字幕', () => {
  const cues = [{ id: 'a', name: '開場' }, { id: 'b', name: '副歌全開' }, { id: 'c', name: '  ' }];
  it('Cue 順序 + 名字', () => {
    expect(cueCaption(2, '副歌全開')).toBe('Cue 3 副歌全開');
    expect(captionForCue(cues, 'b')).toBe('Cue 2 副歌全開');
  });
  it('沒名字只寫編號；沒選 / 找不到 = 不畫', () => {
    expect(captionForCue(cues, 'c')).toBe('Cue 3');
    expect(captionForCue(cues, null)).toBe('');
    expect(captionForCue(cues, 'zzz')).toBe('');
  });
});
