import { describe, expect, it } from 'vitest';
import {
  CLEAR_SCOPES, STAGE_PROPS_UNDO_MAX, applyEdit, applyUndo, clearQuestion, clearStageProps, countInScope, isStagePropsUndoKey, popUndo,
  pushUndo, sameStageProps, type PropsHistoryState,
} from './stagePropsHistory';
import { moveStagePropWith, removeStageProp, type StagePropItem } from './stageProps';

const item = (o: Partial<StagePropItem> & { id: string }): StagePropItem => ({ type: 'drummer', x: 0, y: 0, z: 0, rotY: 0, ...o });
const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra }) as unknown as EventTarget;

describe('復原紀錄', () => {
  it('一步一步退回去，最後一步先退；退完就沒有了', () => {
    const v0: StagePropItem[] = [];
    const v1 = [item({ id: 'a' })];
    const v2 = [item({ id: 'a' }), item({ id: 'b', type: 'piano' })];
    let stack: StagePropItem[][] = [];
    stack = pushUndo(stack, v0);   // 加 a 之前
    stack = pushUndo(stack, v1);   // 加 b 之前
    expect(stack).toHaveLength(2);
    const first = popUndo(stack);
    expect(first?.restored).toEqual(v1);
    const second = popUndo(first?.stack ?? []);
    expect(second?.restored).toEqual(v0);
    expect(popUndo(second?.stack ?? [])).toBeNull();
    expect(v2).toHaveLength(2);
  });

  it('沒有紀錄 → 不能退', () => {
    expect(popUndo([])).toBeNull();
  });

  it('最多 50 步：第 51 步進來，最舊的那步丟掉', () => {
    expect(STAGE_PROPS_UNDO_MAX).toBe(50);
    let stack: StagePropItem[][] = [];
    for (let i = 0; i < 60; i++) stack = pushUndo(stack, [item({ id: `p${i}` })]);
    expect(stack).toHaveLength(50);
    expect(stack[0][0].id).toBe('p10');
    expect(stack[49][0].id).toBe('p59');
  });

  it('不會改到傳進來的陣列（紀錄裡存的是當時的複本）', () => {
    const before = [item({ id: 'a' })];
    const stack = pushUndo([], before);
    before.push(item({ id: 'b' }));
    expect(stack[0]).toHaveLength(1);
    const r = popUndo(stack);
    expect(r?.restored).not.toBe(stack[0]);
  });

  it('加、刪、移動、轉都能用「做之前的清單」退回去', () => {
    const a = item({ id: 'a', x: 1 });
    const start = [a];
    const moved = moveStagePropWith(start, 'a', { x: 3, y: 0, z: 2, rotY: 90 });
    const removed = removeStageProp(moved, 'a');
    let stack = pushUndo([], start);
    stack = pushUndo(stack, moved);
    const r1 = popUndo(stack);
    expect(r1?.restored).toEqual(moved);       // 退掉「刪除」
    const r2 = popUndo(r1?.stack ?? []);
    expect(r2?.restored).toEqual(start);       // 退掉「移動 + 轉」
    expect(removed).toHaveLength(0);
  });

  it('兩份清單一不一樣：順序、欄位都算', () => {
    const a = [item({ id: 'a', x: 1 }), item({ id: 'b' })];
    expect(sameStageProps(a, a.map(i => ({ ...i })))).toBe(true);
    expect(sameStageProps(a, [a[1], a[0]])).toBe(false);
    expect(sameStageProps(a, [{ ...a[0], rotY: 15 }, a[1]])).toBe(false);
    expect(sameStageProps(a, [a[0]])).toBe(false);
    expect(sameStageProps([], [])).toBe(true);
  });
});

describe('一次清掉', () => {
  const list: StagePropItem[] = [
    item({ id: 'v', type: 'vocalist' }),
    item({ id: 'd', type: 'drummer' }),
    item({ id: 'dj', type: 'dj' }),
    item({ id: 'p', type: 'piano' }),
    item({ id: 'r', type: 'riser' }),
    item({ id: 'm', type: 'micStand' }),
  ];

  it('三個範圍：全部、人物（樂手）、器材，分類照比例尺面板的兩組', () => {
    expect(CLEAR_SCOPES).toEqual(['all', 'person', 'gear']);
    expect(countInScope(list, 'all')).toBe(6);
    expect(countInScope(list, 'person')).toBe(3);   // 主唱、鼓手、DJ
    expect(countInScope(list, 'gear')).toBe(3);     // 鋼琴、樂手台、麥克風架
    expect(countInScope([], 'all')).toBe(0);
    expect(countInScope([item({ id: 'x', type: 'piano' })], 'person')).toBe(0);
  });

  it('清掉全部 → 空的；只清樂手 → 器材留著；只清器材 → 樂手留著', () => {
    expect(clearStageProps(list, 'all')).toEqual([]);
    expect(clearStageProps(list, 'person').map(i => i.id)).toEqual(['p', 'r', 'm']);
    expect(clearStageProps(list, 'gear').map(i => i.id)).toEqual(['v', 'd', 'dj']);
  });

  it('不改原本的清單；留下的東西位置、順序都不變', () => {
    const before = list.map(i => ({ ...i }));
    const kept = clearStageProps(list, 'person');
    expect(list).toEqual(before);
    expect(kept[0]).toBe(list[3]);
  });

  it('清掉可以復原：清之前的清單進紀錄，退回去就拿回來', () => {
    const stack = pushUndo([], list);
    const cleared = clearStageProps(list, 'all');
    expect(cleared).toHaveLength(0);
    expect(popUndo(stack)?.restored).toEqual(list);
  });

  it('確認框的字：清掉 N 個…？，寫清楚哪一種、留著什麼、可以復原', () => {
    const all = clearQuestion('all', 12);
    expect(all.title).toBe('清掉 12 個樂手和器材？');
    expect(all.confirmLabel).toBe('清掉');
    expect(all.message).toContain('復原');
    expect(all.message).toContain('預設的人形');
    expect(clearQuestion('person', 5).title).toBe('清掉 5 個樂手？');
    expect(clearQuestion('person', 5).message).toContain('器材會留著');
    expect(clearQuestion('gear', 3).title).toBe('清掉 3 個器材？');
    expect(clearQuestion('gear', 3).message).toContain('樂手會留著');
  });
});

describe('Ctrl+Z / Cmd+Z', () => {
  it('Ctrl+Z、Cmd+Z（大小寫都行）= 復原', () => {
    expect(isStagePropsUndoKey({ key: 'z', ctrlKey: true })).toBe(true);
    expect(isStagePropsUndoKey({ key: 'Z', ctrlKey: true })).toBe(true);
    expect(isStagePropsUndoKey({ key: 'z', metaKey: true })).toBe(true);
  });

  it('單按 Z、Shift+Ctrl+Z（重做）、Alt、別的字母都不算', () => {
    expect(isStagePropsUndoKey({ key: 'z' })).toBe(false);
    expect(isStagePropsUndoKey({ key: 'z', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isStagePropsUndoKey({ key: 'z', ctrlKey: true, altKey: true })).toBe(false);
    expect(isStagePropsUndoKey({ key: 'y', ctrlKey: true })).toBe(false);
  });

  it('在打字的地方不算（文字框、多行文字、可編輯區塊、數字欄）；勾選框、按鈕上照算', () => {
    for (const t of [el('INPUT', { type: 'text' }), el('INPUT'), el('INPUT', { type: 'number' }), el('TEXTAREA'), el('DIV', { isContentEditable: true })]) {
      expect(isStagePropsUndoKey({ key: 'z', ctrlKey: true, target: t })).toBe(false);
    }
    for (const t of [el('INPUT', { type: 'checkbox' }), el('INPUT', { type: 'range' }), el('BUTTON'), el('DIV')]) {
      expect(isStagePropsUndoKey({ key: 'z', ctrlKey: true, target: t })).toBe(true);
    }
  });
});

describe('清單 + 復原紀錄一起走（頁面上的 useStageProps 就是照這個）', () => {
  const start: PropsHistoryState = { items: [], undo: [] };
  const drum = item({ id: 'd', type: 'drummer' });
  const piano = item({ id: 'p', type: 'piano' });

  it('加、移動、清掉每一步都記一步，連按復原一步一步退回去', () => {
    let st = applyEdit(start, [drum], true);                                             // 加鼓手
    st = applyEdit(st, [drum, piano], true);                                             // 加鋼琴
    st = applyEdit(st, moveStagePropWith(st.items, 'd', { x: 2, y: 0, z: 1, rotY: 30 }), true);  // 移動 + 轉
    st = applyEdit(st, clearStageProps(st.items, 'all'), true);                          // 清掉全部
    expect(st.items).toEqual([]);
    expect(st.undo).toHaveLength(4);
    const u1 = applyUndo(st) as PropsHistoryState;                                       // 退掉「清掉」
    expect(u1.items.map(i => i.id)).toEqual(['d', 'p']);
    expect(u1.items[0]).toMatchObject({ x: 2, z: 1, rotY: 30 });
    const u2 = applyUndo(u1) as PropsHistoryState;                                       // 退掉「移動 + 轉」
    expect(u2.items[0]).toMatchObject({ x: 0, z: 0, rotY: 0 });
    const u3 = applyUndo(u2) as PropsHistoryState;                                       // 退掉「加鋼琴」
    expect(u3.items.map(i => i.id)).toEqual(['d']);
    const u4 = applyUndo(u3) as PropsHistoryState;                                       // 退掉「加鼓手」
    expect(u4.items).toEqual([]);
    expect(applyUndo(u4)).toBeNull();                                                    // 沒有了
  });

  it('內容沒變不算一步（例如放開滑鼠但沒動）', () => {
    const st = applyEdit(start, [drum], true);
    const same = applyEdit(st, [{ ...drum }], true);
    expect(same.undo).toHaveLength(1);
  });

  it('專案上的清單還沒讀回來就改了：改得動、但不記（退回去會退成空的）', () => {
    const st = applyEdit(start, [drum], false);
    expect(st.items).toEqual([drum]);
    expect(st.undo).toEqual([]);
  });

  it('復原紀錄最多 50 步', () => {
    let st = start;
    for (let i = 0; i < 70; i++) st = applyEdit(st, [...st.items, item({ id: `p${i}`, x: i })], true);
    expect(st.undo).toHaveLength(50);
    let n = 0;
    for (let cur: PropsHistoryState | null = st; cur; cur = applyUndo(cur)) n++;
    expect(n).toBe(51);  // 起點 + 退 50 步
  });
});
