import { describe, it, expect } from 'vitest';
import { computeClipPlanes, applyClipPlanes } from './cameraClip';

describe('computeClipPlanes', () => {
  it('遠鏡頭 near 變大', () => {
    expect(computeClipPlanes(40, 30).near).toBeGreaterThan(0.2);
    expect(computeClipPlanes(40, 30).near).toBeGreaterThan(computeClipPlanes(5, 30).near);
  });
  it('近鏡頭 near 小', () => {
    expect(computeClipPlanes(0.3, 30).near).toBe(0.05);
    expect(computeClipPlanes(0, 30).near).toBe(0.05);
  });
  it('near 上限 1 公尺', () => {
    expect(computeClipPlanes(5000, 30).near).toBe(1);
  });
  it('far 包住整個場景與鏡頭距離', () => {
    const { far } = computeClipPlanes(60, 100);
    expect(far).toBeGreaterThanOrEqual(100 + 60);
    expect(computeClipPlanes(1, 10).far).toBe(200);
  });
  it('壞數字不會出 NaN', () => {
    const p = computeClipPlanes(NaN, NaN);
    expect(Number.isFinite(p.near) && Number.isFinite(p.far)).toBe(true);
  });
  it('只有變了才要更新投影', () => {
    const cam = { near: 0.1, far: 200 };
    expect(applyClipPlanes(cam, 40, 30)).toBe(true);
    expect(applyClipPlanes(cam, 40, 30)).toBe(false);
  });
});
