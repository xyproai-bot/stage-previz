import { describe, it, expect } from 'vitest';
import {
  formatFieldNumber, metersToScene, parseNumberInput, roundTo, sameAsShown, sceneToMeters, stepNumberInput,
} from './numberField';

describe('parseNumberInput（欄位檢查：不是數字就不存）', () => {
  it('一般數字', () => {
    expect(parseNumberInput('1.5')).toBe(1.5);
    expect(parseNumberInput(' -2 ')).toBe(-2);
    expect(parseNumberInput('+3')).toBe(3);
    expect(parseNumberInput('.5')).toBe(0.5);
    expect(parseNumberInput('10.')).toBe(10);
    expect(parseNumberInput('0')).toBe(0);
    expect(parseNumberInput('1e2')).toBe(100);
  });
  it('空白 / 打到一半 / 亂打 → null', () => {
    for (const bad of ['', '  ', '-', '.', 'abc', '1.2.3', '1,5', '0x10', '1m', 'Infinity', 'NaN', '1e999']) {
      expect(parseNumberInput(bad)).toBeNull();
    }
  });
});

describe('公尺 ↔ 場景單位（照測距校準倍率）', () => {
  it('沒校準（×1）→ 數字一樣', () => {
    expect(sceneToMeters(2.5, 1)).toBe(2.5);
    expect(metersToScene(2.5, 1)).toBe(2.5);
  });
  it('有校準：顯示的公尺 = 場景單位 × 倍率；存回去再顯示還是同一個數字', () => {
    const sc = 10.37;
    const scene = metersToScene(1.5, sc);
    expect(scene).toBeCloseTo(1.5 / sc, 6);
    expect(formatFieldNumber(sceneToMeters(scene, sc))).toBe('1.5');
  });
  it('倍率壞掉（0 / 負的 / NaN）→ 當作 1，不會除以 0', () => {
    expect(metersToScene(3, 0)).toBe(3);
    expect(metersToScene(3, -2)).toBe(3);
    expect(sceneToMeters(3, NaN)).toBe(3);
  });
});

describe('formatFieldNumber / roundTo / sameAsShown', () => {
  it('最多 3 位小數、不補零、不會出現 -0', () => {
    expect(formatFieldNumber(1.23456)).toBe('1.235');
    expect(formatFieldNumber(2)).toBe('2');
    expect(formatFieldNumber(-0.0001)).toBe('0');
    expect(formatFieldNumber(NaN)).toBe('0');
    expect(roundTo(-0.0004, 3)).toBe(0);
  });
  it('打的跟顯示的一樣 → 不用存', () => {
    expect(sameAsShown(1.5, 1.50004)).toBe(true);
    expect(sameAsShown(1.6, 1.5)).toBe(false);
  });
});

describe('stepNumberInput（方向鍵微調）', () => {
  it('從欄位裡的數字加減', () => {
    expect(stepNumberInput('1.5', 0, 0.1)).toBe('1.6');
    expect(stepNumberInput('0', 0, -1)).toBe('-1');
  });
  it('欄位裡不是數字 → 從目前的值開始', () => {
    expect(stepNumberInput('abc', 2, 0.1)).toBe('2.1');
  });
});
