import { describe, it, expect } from 'vitest';
import { formatClock, isVideoFile } from './localVideo';

describe('isVideoFile', () => {
  it('看 MIME type', () => {
    expect(isVideoFile({ name: 'a.bin', type: 'video/mp4' })).toBe(true);
    expect(isVideoFile({ name: 'a.png', type: 'image/png' })).toBe(false);
  });
  it('MIME 空的時候看副檔名', () => {
    expect(isVideoFile({ name: 'S01_主題曲.MP4', type: '' })).toBe(true);
    expect(isVideoFile({ name: 'render.mov', type: '' })).toBe(true);
    expect(isVideoFile({ name: 'notes.txt', type: '' })).toBe(false);
  });
});

describe('formatClock', () => {
  it('分:秒', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65.4)).toBe('1:05');
    expect(formatClock(3600 + 61)).toBe('61:01');
  });
  it('壞數字 → 0:00', () => {
    expect(formatClock(NaN)).toBe('0:00');
    expect(formatClock(-3)).toBe('0:00');
  });
});
