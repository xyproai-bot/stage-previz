import { describe, it, expect } from 'vitest';
import { normalizeHomeView } from './homeView';

const good = { position: [1, 2, 30], target: [0, 5, 0], fov: 40 };

describe('normalizeHomeView', () => {
  it('合法的原樣留著', () => {
    expect(normalizeHomeView(good)).toEqual(good);
  });
  it('JSON 字串也收', () => {
    expect(normalizeHomeView(JSON.stringify(good))).toEqual(good);
  });
  it('視角夾在 10~120 度', () => {
    expect(normalizeHomeView({ ...good, fov: 500 })!.fov).toBe(120);
    expect(normalizeHomeView({ ...good, fov: 1 })!.fov).toBe(10);
  });
  it('壞資料 / 空的 / 位置跟看向同一點 → null', () => {
    expect(normalizeHomeView(null)).toBeNull();
    expect(normalizeHomeView({})).toBeNull();
    expect(normalizeHomeView('{x')).toBeNull();
    expect(normalizeHomeView({ ...good, position: [1, 2] })).toBeNull();
    expect(normalizeHomeView({ ...good, target: [1, 'a', 3] })).toBeNull();
    expect(normalizeHomeView({ ...good, target: good.position })).toBeNull();
    expect(normalizeHomeView({ ...good, position: [1e9, 0, 0] })).toBeNull();
  });
});
