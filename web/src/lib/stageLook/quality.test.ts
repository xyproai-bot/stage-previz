import { describe, it, expect } from 'vitest';
import { detectQualityProfile } from './quality';

const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Safari/605.1.15';

describe('detectQualityProfile', () => {
  it('桌機多核心 → high', () => {
    expect(detectQualityProfile({ maxTouchPoints: 0, hardwareConcurrency: 16, userAgent: WIN })).toBe('high');
  });
  it('iPadOS（偽裝成 Mac + 有觸控）→ low', () => {
    expect(detectQualityProfile({ maxTouchPoints: 5, hardwareConcurrency: 8, userAgent: MAC })).toBe('low');
  });
  it('舊 iPad UA → low', () => {
    expect(detectQualityProfile({ maxTouchPoints: 5, hardwareConcurrency: 6, userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)' })).toBe('low');
  });
  it('4 核心以下 → low', () => {
    expect(detectQualityProfile({ maxTouchPoints: 0, hardwareConcurrency: 4, userAgent: WIN })).toBe('low');
  });
  it('真 Mac（沒觸控）→ high', () => {
    expect(detectQualityProfile({ maxTouchPoints: 0, hardwareConcurrency: 10, userAgent: MAC })).toBe('high');
  });
});
