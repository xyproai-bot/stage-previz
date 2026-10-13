import { describe, it, expect } from 'vitest';
import { normalizeLedCanvas, sameLedCanvas } from './ledCanvas';

const jinma = { width: 10496, height: 5120 };

describe('normalizeLedCanvas', () => {
  it('合法的原樣留著', () => {
    expect(normalizeLedCanvas(jinma)).toEqual(jinma);
  });
  it('JSON 字串也收（後台存的是字串）', () => {
    expect(normalizeLedCanvas(JSON.stringify(jinma))).toEqual(jinma);
  });
  it('寬高是數字字串也收', () => {
    expect(normalizeLedCanvas({ width: '1920', height: ' 1080 ' })).toEqual({ width: 1920, height: 1080 });
  });
  it('邊界 16 和 32768 都可以', () => {
    expect(normalizeLedCanvas({ width: 16, height: 32768 })).toEqual({ width: 16, height: 32768 });
  });
  it('超出範圍 → null', () => {
    expect(normalizeLedCanvas({ width: 15, height: 1080 })).toBeNull();
    expect(normalizeLedCanvas({ width: 1920, height: 32769 })).toBeNull();
    expect(normalizeLedCanvas({ width: 0, height: 0 })).toBeNull();
    expect(normalizeLedCanvas({ width: -1920, height: 1080 })).toBeNull();
  });
  it('不是整數 → null', () => {
    expect(normalizeLedCanvas({ width: 1920.5, height: 1080 })).toBeNull();
    expect(normalizeLedCanvas({ width: '1920.5', height: 1080 })).toBeNull();
    expect(normalizeLedCanvas({ width: '1e4', height: 1080 })).toBeNull();
    expect(normalizeLedCanvas({ width: 'abc', height: 1080 })).toBeNull();
    expect(normalizeLedCanvas({ width: true, height: 1080 })).toBeNull();
    expect(normalizeLedCanvas({ width: NaN, height: 1080 })).toBeNull();
  });
  it('空的 / 壞資料 / 少一邊 → null', () => {
    expect(normalizeLedCanvas(null)).toBeNull();
    expect(normalizeLedCanvas(undefined)).toBeNull();
    expect(normalizeLedCanvas('')).toBeNull();
    expect(normalizeLedCanvas('{x')).toBeNull();
    expect(normalizeLedCanvas({})).toBeNull();
    expect(normalizeLedCanvas([10496, 5120])).toBeNull();
    expect(normalizeLedCanvas({ width: 10496 })).toBeNull();
  });
  it('多的欄位丟掉', () => {
    expect(normalizeLedCanvas({ ...jinma, fps: 30 })).toEqual(jinma);
  });
});

describe('sameLedCanvas', () => {
  it('一樣 / 不一樣 / null', () => {
    expect(sameLedCanvas(jinma, { width: 10496, height: 5120 })).toBe(true);
    expect(sameLedCanvas(jinma, { width: 10496, height: 5121 })).toBe(false);
    expect(sameLedCanvas(null, null)).toBe(true);
    expect(sameLedCanvas(jinma, null)).toBe(false);
    expect(sameLedCanvas(null, jinma)).toBe(false);
  });
});
