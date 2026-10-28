import { describe, expect, it } from 'vitest';
import { ADJUST_TEXT, barText, groupLabel, hoistHint, kindLabel, rangeText, scopeLabel, togetherHint, valueText } from './panelText';

const up = { x: 0, y: 1, z: 0 }, side = { x: 1, y: 0, z: 0 };

describe('面板上的字', () => {
  it('機關是哪一種', () => {
    expect(kindLabel({ kind: 'linear', variant: 'arc', axis: up })).toBe('沿弧形軌道');
    expect(kindLabel({ kind: 'linear', variant: null, axis: up })).toBe('升降');
    expect(kindLabel({ kind: 'linear', variant: null, axis: side })).toBe('直線');
    expect(kindLabel({ kind: 'rotary', variant: null, axis: up })).toBe('旋轉');
    expect(kindLabel({ kind: 'rotary', variant: null, axis: side })).toBe('翻轉');
    expect(kindLabel({ kind: 'linear', variant: 'hoist', axis: up })).toBe('吊點');
  });
  it('值、行程', () => {
    expect(valueText(1.25, 'linear')).toBe('1.25 m');
    expect(valueText(-180, 'rotary')).toBe('-180°');
    expect(rangeText({ kind: 'linear', travelMin: 0, travelMax: 2.5 })).toBe('行程 0 m 到 2.5 m');
  });
  it('整組選、提示列', () => {
    expect(scopeLabel('one', 1)).toBe('只有這個');
    expect(scopeLabel('all', 6)).toBe('整排一起（6）');
    expect(scopeLabel('left', 3)).toBe('左半（3）');
    expect(togetherHint(1)).toBe('');
    expect(togetherHint(3)).toContain('3 個一起動');
    expect(barText(2)).toBe('改了 2 個機關');
  });
  it('一排機關的名字：成員名字共同的開頭', () => {
    expect(groupLabel(['旋轉 LED 1', '旋轉 LED 2', '旋轉 LED 10'])).toBe('旋轉 LED');
    expect(groupLabel(['升降-01', '升降-02'])).toBe('升降');
    expect(groupLabel(['甲', '乙'])).toBe('一排機關');
    expect(groupLabel([])).toBe('一排機關');
  });
  it('字裡沒有英文叫人的字、沒有 emoji', () => {
    const all = [
      ...Object.values(ADJUST_TEXT).map(v => (typeof v === 'function' ? v(3) : v)),
      hoistHint(true), hoistHint(false), togetherHint(4), scopeLabel('right', 2), barText(5),
    ].join('\n');
    expect(all).not.toMatch(/\b(users?|admins?|directors?|animators?)\b/i);
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
