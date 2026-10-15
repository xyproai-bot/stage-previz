import { describe, expect, it } from 'vitest';
import {
  backdropKey, backdropRect, backdropSizeNote, BACKDROP_MAX_BYTES, checkBackdropFile, checkBackdropPixels, clampOpacity,
  DEFAULT_BACKDROP_PREFS, NEW_TEMPLATE_ID, normalizeBackdropPrefs, sameSize,
} from './ledTemplateBackdrop';

describe('底圖：鍵、設定值', () => {
  it('鍵 = 專案 + 版型；還沒存的新版型用固定的代號', () => {
    expect(backdropKey('p1', 't9')).toBe('p1:t9');
    expect(backdropKey('p1', null)).toBe(`p1:${NEW_TEMPLATE_ID}`);
    expect(backdropKey('p1', undefined)).toBe(`p1:${NEW_TEMPLATE_ID}`);
  });
  it('不透明度夾在 0 ~ 1，壞值用預設', () => {
    expect(clampOpacity(0.456)).toBe(0.46);
    expect(clampOpacity(-3)).toBe(0);
    expect(clampOpacity(7)).toBe(1);
    expect(clampOpacity('x')).toBe(DEFAULT_BACKDROP_PREFS.opacity);
    expect(clampOpacity(NaN)).toBe(DEFAULT_BACKDROP_PREFS.opacity);
  });
  it('讀回來的設定壞掉、缺欄位 = 預設值補上', () => {
    expect(normalizeBackdropPrefs(null)).toEqual(DEFAULT_BACKDROP_PREFS);
    expect(normalizeBackdropPrefs({ fit: 'native', opacity: 0.25, visible: false })).toEqual({ fit: 'native', opacity: 0.25, visible: false });
    expect(normalizeBackdropPrefs({ fit: 'weird', opacity: 'a', visible: 'no' })).toEqual({ fit: 'stretch', opacity: 0.5, visible: true });
  });
});

describe('底圖：檔案檢查', () => {
  it('PNG / JPG / WebP 可以', () => {
    expect(checkBackdropFile({ name: 'a.png', type: 'image/png', size: 1000 })).toBeNull();
    expect(checkBackdropFile({ name: 'a.jpg', type: 'image/jpeg', size: 1000 })).toBeNull();
    expect(checkBackdropFile({ name: 'a.webp', type: 'image/webp', size: 1000 })).toBeNull();
  });
  it('有些系統不給檔案類型，看副檔名', () => {
    expect(checkBackdropFile({ name: 'map.JPEG', type: '', size: 1000 })).toBeNull();
    expect(checkBackdropFile({ name: 'map.txt', type: '', size: 1000 })).toMatch('PNG');
  });
  it('其他格式、空檔、太大的檔都不行，並且說得出原因', () => {
    expect(checkBackdropFile({ name: 'a.gif', type: 'image/gif', size: 1000 })).toMatch('PNG、JPG 或 WebP');
    expect(checkBackdropFile({ name: 'a.png', type: 'image/png', size: 0 })).toMatch('空的');
    expect(checkBackdropFile({ name: 'a.png', type: 'image/png', size: BACKDROP_MAX_BYTES + 1 })).toMatch('太大');
  });
  it('圖片太大畫不動', () => {
    expect(checkBackdropPixels({ width: 10496, height: 5120 })).toBeNull();
    expect(checkBackdropPixels({ width: 20000, height: 100 })).toMatch('太大');
    expect(checkBackdropPixels({ width: 16000, height: 16000 })).toMatch('太大');
    expect(checkBackdropPixels({ width: 0, height: 100 })).toMatch('大小');
  });
});

describe('底圖：大小比對、怎麼擺', () => {
  const canvas = { width: 4400, height: 1200 };
  it('一樣大 = 不用問、整張畫布', () => {
    expect(sameSize({ width: 4400, height: 1200 }, canvas)).toBe(true);
    expect(backdropSizeNote({ width: 4400, height: 1200 }, canvas)).toBeNull();
    expect(backdropRect('native', { width: 4400, height: 1200 }, canvas)).toEqual({ x: 0, y: 0, w: 4400, h: 1200 });
  });
  it('不一樣大：拉伸 = 整張畫布；原尺寸 = 左上角、圖自己的大小', () => {
    const img = { width: 2200, height: 600 };
    expect(sameSize(img, canvas)).toBe(false);
    expect(backdropRect('stretch', img, canvas)).toEqual({ x: 0, y: 0, w: 4400, h: 1200 });
    expect(backdropRect('native', img, canvas)).toEqual({ x: 0, y: 0, w: 2200, h: 600 });
    expect(backdropRect('native', { width: 8000, height: 3000 }, canvas)).toEqual({ x: 0, y: 0, w: 8000, h: 3000 });
  });
  it('說明寫出兩邊的大小；長寬比不一樣會多說一句', () => {
    expect(backdropSizeNote({ width: 2200, height: 600 }, canvas)).toBe('底圖是 2200×600，版型畫布是 4400×1200');
    expect(backdropSizeNote({ width: 1920, height: 1080 }, canvas)).toBe('底圖是 1920×1080，版型畫布是 4400×1200，長寬比也不一樣');
  });
});
