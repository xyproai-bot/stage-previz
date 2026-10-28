import { describe, expect, it } from 'vitest';
import { changedIds, effectiveValues, moveTogether, revertDraft, setDraftValue } from './draft';

const saved = { a: 1, b: 0, c: 90 };

describe('setDraftValue：草稿只放改過的機關', () => {
  it('改了 → 放進草稿；改回跟存的一樣 → 拿掉', () => {
    const d1 = setDraftValue({}, saved, 'a', 2.5);
    expect(d1).toEqual({ a: 2.5 });
    const d2 = setDraftValue(d1, saved, 'a', 1);
    expect(d2).toEqual({});
  });
  it('不改原本的物件（倉庫要靠新物件知道變了）', () => {
    const d = { a: 2 };
    const out = setDraftValue(d, saved, 'b', 3);
    expect(d).toEqual({ a: 2 });
    expect(out).toEqual({ a: 2, b: 3 });
  });
  it('存的值裡沒有這個機關 → 一律放進草稿', () => {
    expect(setDraftValue({}, saved, 'z', 0)).toEqual({ z: 0 });
  });
});

describe('effectiveValues / changedIds / revertDraft', () => {
  it('畫面用的值 = 存的值 + 草稿', () => {
    expect(effectiveValues(saved, { b: 4 })).toEqual({ a: 1, b: 4, c: 90 });
  });
  it('改了幾個機關', () => {
    expect(changedIds({ b: 4, c: 10 }).sort()).toEqual(['b', 'c']);
  });
  it('回到存的值：只拿掉指定的', () => {
    expect(revertDraft({ a: 3, b: 4, c: 10 }, ['a', 'c'])).toEqual({ b: 4 });
  });
});

describe('moveTogether：一起動時每個加一樣的量', () => {
  const ranges = { a: { travelMin: 0, travelMax: 5 }, b: { travelMin: -2, travelMax: 2 }, c: { travelMin: 0, travelMax: 3 } };
  it('主要的走到目標，其他的加一樣的量', () => {
    expect(moveTogether({ a: 1, b: 0, c: 2 }, ['a', 'b', 'c'], 'a', 2, ranges)).toEqual({ a: 2, b: 1, c: 3 });
  });
  it('超出行程的各自夾住，不影響別的', () => {
    expect(moveTogether({ a: 1, b: 0, c: 2 }, ['a', 'b', 'c'], 'a', 4, ranges)).toEqual({ a: 4, b: 2, c: 3 });
  });
  it('主要的目標也夾在行程內；量照夾過的算', () => {
    expect(moveTogether({ a: 4, b: 0 }, ['a', 'b'], 'a', 9, ranges)).toEqual({ a: 5, b: 1 });
  });
  it('沒有開始值的機關跳過', () => {
    expect(moveTogether({ a: 1 }, ['a', 'b'], 'a', 2, ranges)).toEqual({ a: 2 });
  });
});
