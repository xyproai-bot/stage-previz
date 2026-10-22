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

import { canDragOnto, dragHintText, dragReorder, rearrangeSlots, stepTarget } from './songSlots';
import { EditHistory, historyScope } from './editHistory';

describe('拖拉改順序', () => {
  const apply = (r: { ids: string[]; times: Record<string, number | null> }) =>
    r.ids.map((id, i) => ({ id, order: i, videoTimeSec: r.times[id] }));

  it('有時間的兩個互拖 = 時間對調', () => {
    const r = dragReorder([s('a', 0, 10), s('b', 1, 30)], 'b', 'a')!;
    expect(r.ids).toEqual(['b', 'a']);
    expect(r.times).toEqual({ b: 10, a: 30 });
  });
  it('跨好幾格：時間集合不變、依序重新分配、結果仍照時間排', () => {
    const slots = [s('a', 0, 5), s('b', 1, 10), s('c', 2, 20), s('d', 3, 30), s('e', 4, 40)];
    const r = dragReorder(slots, 'e', 'b')!;
    expect(r.ids).toEqual(['a', 'e', 'b', 'c', 'd']);
    expect(r.times).toEqual({ a: 5, e: 10, b: 20, c: 30, d: 40 });
    expect(slotsOutOfOrder(apply(r))).toBe(false);
  });
  it('往下拖也一樣', () => {
    const r = dragReorder([s('a', 0, 1), s('b', 1, 2), s('c', 2, 3)], 'a', 'c')!;
    expect(r.ids).toEqual(['b', 'c', 'a']);
    expect(r.times).toEqual({ b: 1, c: 2, a: 3 });
  });
  it('沒時間的：照拖的位置排，時間不動', () => {
    const r = dragReorder([s('x', 0, null), s('y', 1, null), s('z', 2, null)], 'z', 'x')!;
    expect(r.ids).toEqual(['z', 'x', 'y']);
    expect(Object.values(r.times)).toEqual([null, null, null]);
  });
  it('有時間和沒時間混在一起：只能換到同一種的位置，結果還是照時間排得出同樣順序', () => {
    const slots = [s('a', 0, 10), s('x', 1, null), s('b', 2, 30), s('y', 3, null)];
    expect(canDragOnto(slots, 'a', 'x')).toBe(false);
    expect(dragReorder(slots, 'a', 'x')).toBeNull();
    const r = dragReorder(slots, 'b', 'a')!;
    expect(r.ids).toEqual(['b', 'x', 'a', 'y']);
    expect(r.times).toEqual({ b: 10, x: null, a: 30, y: null });
    expect(slotsOutOfOrder(apply(r))).toBe(false);
    expect(dragReorder(slots, 'y', 'x')!.ids).toEqual(['a', 'y', 'b', 'x']);
  });
  it('不是整首歌的 cue -> null；自己拖自己不行', () => {
    expect(rearrangeSlots([s('a', 0, 1), s('b', 1, 2)], ['a'])).toBeNull();
    expect(dragReorder([s('a', 0, 1), s('b', 1, 2)], 'a', 'a')).toBeNull();
  });
  it('上下鍵：找最近一個同一種的', () => {
    const slots = [s('a', 0, 10), s('x', 1, null), s('b', 2, 30)];
    expect(stepTarget(slots, 'a', 1)).toBe('b');
    expect(stepTarget(slots, 'x', 1)).toBeNull();
    expect(stepTarget(slots, 'a', -1)).toBeNull();
  });
  it('說明文字：混在一起才講規則', () => {
    expect(dragHintText([s('a', 0, 1)])).toBe('');
    expect(dragHintText([s('a', 0, 1), s('b', 1, null)])).toContain('沒時間的只能拖到沒時間的位置');
    expect(dragHintText([s('a', 0, null), s('b', 1, null)])).not.toContain('時間');
  });
  it('一次拖拉 = 一個復原步驟：復原一次就回到原樣，再重做一次又回去', async () => {
    let state = [s('a', 0, 10), s('b', 1, 30)];
    const before = { ids: state.map(c => c.id), times: Object.fromEntries(state.map(c => [c.id, c.videoTimeSec])) as Record<string, number | null> };
    const r = dragReorder(state, 'b', 'a')!;
    const write = async (ids: string[], times: Record<string, number | null>) => { state = ids.map((id, i) => ({ id, order: i, videoTimeSec: times[id] })); };
    const h = new EditHistory();
    await write(r.ids, r.times);
    h.push(historyScope('a'), { undo: () => write(before.ids, before.times), redo: () => write(r.ids, r.times) });
    expect(state.map(c => [c.id, c.videoTimeSec])).toEqual([['b', 10], ['a', 30]]);
    expect(h.counts(historyScope('a')).undo).toBe(1);
    await h.undo(historyScope('a'));
    expect(state.map(c => [c.id, c.videoTimeSec])).toEqual([['a', 10], ['b', 30]]);
    await h.redo(historyScope('a'));
    expect(state.map(c => [c.id, c.videoTimeSec])).toEqual([['b', 10], ['a', 30]]);
  });
});
