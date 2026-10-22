import { describe, expect, it } from 'vitest';
import { fmtSlotTime, ledSwitchFollows, orderSlots, slotsOutOfOrder, sortedSlotIds, timeTaken, timeTakenText } from './songSlots';

const s = (id: string, order: number, t: number | null) => ({ id, order, videoTimeSec: t });

describe('這首歌的 cue：照時間排', () => {
  it('加一個比較早的時間 -> 排到前面（跟 Cue 庫編號無關）', () => {
    const r = orderSlots([s('a', 0, 0), s('b', 1, 60), s('new', 2, 30)]);
    expect(r.map(x => x.id)).toEqual(['a', 'new', 'b']);
    expect(r.map(x => x.order)).toEqual([0, 1, 2]);
  });
  it('改時間之後重排', () => {
    expect(sortedSlotIds([s('a', 0, 100), s('b', 1, 60), s('c', 2, 90)])).toEqual(['b', 'c', 'a']);
  });
  it('沒有時間的跟在前一個後面', () => {
    expect(sortedSlotIds([s('a', 0, 10), s('u', 1, null), s('b', 2, 5)])).toEqual(['b', 'a', 'u']);
  });
  it('順序和時間對不上才提示', () => {
    expect(slotsOutOfOrder([s('a', 0, 0), s('b', 1, 60)])).toBe(false);
    expect(slotsOutOfOrder([s('a', 0, 60), s('b', 1, 0)])).toBe(true);
    expect(slotsOutOfOrder([])).toBe(false);
  });
});

describe('同時間擋', () => {
  const slots = [s('a', 0, 0), s('b', 1, 83)];
  it('同一個時間已經有 cue', () => {
    expect(timeTaken(slots, 83)).toBe(true);
    expect(timeTaken(slots, 83.0004)).toBe(true);
    expect(timeTaken(slots, 84)).toBe(false);
    expect(timeTaken(slots, null)).toBe(false);
  });
  it('改自己的時間不算撞到自己', () => {
    expect(timeTaken(slots, 83, 'b')).toBe(false);
    expect(timeTaken(slots, 0, 'b')).toBe(true);
  });
  it('提示文字', () => {
    expect(timeTakenText(83)).toBe('這首歌 1:23 已經有 cue 了');
    expect(timeTakenText(0)).toBe('這首歌 0:00 已經有 cue 了');
  });
});

describe('時間顯示 / LED 切換點', () => {
  it('fmtSlotTime', () => {
    expect(fmtSlotTime(0)).toBe('0:00');
    expect(fmtSlotTime(83)).toBe('1:23');
    expect(fmtSlotTime(83.5)).toBe('1:23.5');
    expect(fmtSlotTime(null)).toBe('沒有時間');
  });
  it('拿掉前提醒有 LED 切換點跟著', () => {
    expect(ledSwitchFollows([{ cueId: 'x' }, { cueId: null }], 'x')).toBe(true);
    expect(ledSwitchFollows([{ cueId: null }], 'x')).toBe(false);
  });
});
