import { describe, expect, it } from 'vitest';
import { estimateFps, formatClockShort, formatRange, formatTimecode, formatTimecodeOrMs, fpsFromFrameCount, frameDuration, snapFps, stepFrameTime } from './timecode';

describe('影片幾格', () => {
  it('量到的格數對到常見的格數', () => {
    expect(snapFps(29.96)).toBe(29.97);
    expect(snapFps(25.2)).toBe(25);
    expect(snapFps(23.98)).toBe(23.976);
    expect(snapFps(59.9)).toBe(59.94);
    expect(snapFps(17.3)).toBe(17.3);
    expect(snapFps(0)).toBe(30);
  });
  it('每一格的間隔取中位數（掉格不影響）；量太少 = 不知道', () => {
    const d25 = Array.from({ length: 30 }, (_, i) => (i % 9 === 0 ? 0.08 : 0.04));
    expect(estimateFps(d25)).toBe(25);
    expect(estimateFps([0.04, 0.04])).toBeNull();
    expect(estimateFps(Array.from({ length: 20 }, () => 1 / 60))).toBe(60);
  });
  it('電腦忙、畫面掉格量出來太低 → 不信（null）', () => {
    expect(estimateFps(Array.from({ length: 20 }, () => 1 / 8.2))).toBeNull();
  });
  it('解碼的格數 ÷ 播了幾秒（掉格也算在裡面）', () => {
    expect(fpsFromFrameCount(50, 2)).toBe(25);
    expect(fpsFromFrameCount(59.94 * 3, 3)).toBe(59.94);
    expect(fpsFromFrameCount(10, 1)).toBeNull();      // 播太短
    expect(fpsFromFrameCount(16, 2)).toBeNull();      // 8 格：不合理
    expect(fpsFromFrameCount(0, 2)).toBeNull();
  });
  it('不知道幾格 = 1/30 秒一格', () => {
    expect(frameDuration(null)).toBeCloseTo(1 / 30);
    expect(frameDuration(25)).toBeCloseTo(0.04);
  });
});

describe('逐格', () => {
  it('往後一格停在下一格的中間；往前一格停在上一格', () => {
    expect(stepFrameTime(1.0, 1, 25, 10)).toBeCloseTo(1.06);   // 第 25 格 → 第 26 格（1.04~1.08 的中間）
    expect(stepFrameTime(1.06, 1, 25, 10)).toBeCloseTo(1.1);
    expect(stepFrameTime(1.06, -1, 25, 10)).toBeCloseTo(1.02);
  });
  it('不會跑到開頭之前、結尾之後', () => {
    expect(stepFrameTime(0, -1, 30, 10)).toBeCloseTo(0.5 / 30);
    expect(stepFrameTime(9.99, 1, 30, 10)).toBeLessThan(10);
  });
  it('不知道幾格 → 1/30 秒', () => {
    expect(stepFrameTime(2, 1, null, 10)).toBeCloseTo((60 + 1 + 0.5) / 30);
  });
});

describe('時間碼和時間', () => {
  it('HH:MM:SS:FF', () => {
    expect(formatTimecode(0, 25)).toBe('00:00:00:00');
    expect(formatTimecode(12.48, 25)).toBe('00:00:12:12');
    expect(formatTimecode(3725.5, 30)).toBe('01:02:05:15');
    expect(formatTimecode(1.5, 29.97)).toBe('00:00:01:15');
    expect(formatTimecode(1.5, null)).toBe('00:00:01:15');
    expect(formatTimecode(-3, 25)).toBe('00:00:00:00');
  });
  it('匯出：不知道幾格就寫毫秒，不寫猜的格數', () => {
    expect(formatTimecodeOrMs(12.48, 25)).toBe('00:00:12:12');
    expect(formatTimecodeOrMs(12.48, null)).toBe('00:00:12.480');
    expect(formatTimecodeOrMs(3725.5, undefined)).toBe('01:02:05.500');
  });
  it('0:12、超過一小時 1:02:03', () => {
    expect(formatClockShort(12.9)).toBe('0:12');
    expect(formatClockShort(3723)).toBe('1:02:03');
    expect(formatClockShort(NaN)).toBe('0:00');
  });
  it('區段 0:12–0:18', () => {
    expect(formatRange(12, 18)).toBe('0:12–0:18');
    expect(formatRange(12, null)).toBe('0:12');
    expect(formatRange(12, 12)).toBe('0:12');
  });
});
