import { describe, expect, it } from 'vitest';
import { pickFitLevel } from './useFitLevel';

/** 假的一排：每一級寬度不同，畫面寬 room */
function row(widths: number[], room: number) {
  let level = -1;
  const tried: number[] = [];
  const pick = () => pickFitLevel(widths.length - 1, n => { level = n; tried.push(n); }, () => widths[level] > room);
  return { pick, tried, level: () => level };
}

describe('pickFitLevel：放不下就一級一級收', () => {
  it('放得下 → 停在 0 級（全部帶字）', () => {
    const r = row([900, 700, 500, 300], 1000);
    expect(r.pick()).toBe(0);
    expect(r.level()).toBe(0);
  });

  it('1280 寬放不下全部帶字（1670）→ 收到第一個放得下的級數', () => {
    const r = row([1670, 1300, 900, 400], 1265);
    expect(r.pick()).toBe(2);
    expect(r.level()).toBe(2);
    expect(r.tried).toEqual([0, 1, 2]);
  });

  it('到最後一級還放不下 → 停在最後一級（收進「⋯」）', () => {
    const r = row([1670, 1300, 900, 400], 300);
    expect(r.pick()).toBe(3);
    expect(r.level()).toBe(3);
  });

  it('每次都從 0 級重試：視窗變寬時會回到帶字', () => {
    const widths = [1670, 1300, 900, 400];
    let level = 3;
    expect(pickFitLevel(3, n => { level = n; }, () => widths[level] > 1800)).toBe(0);
  });
});
