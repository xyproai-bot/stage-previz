// 「所有 cue 的物件回到預設位置」：確認視窗的數字和字、復原紀錄只記一步、從任何一個 cue 復原都能全部寫回去
import { describe, expect, it } from 'vitest';
import { EditHistory, historyScope } from './editHistory';
import { RESET_ALL_MENU_LABEL, resetAllDialog, resetAllHistoryScopes, runResetAll, summarizeOverrides, type OverrideRow } from './cueResetAll';

interface Row extends OverrideRow { position: { x: number; y: number; z: number } | null; visible: boolean | null }

/** 假的後台：一首歌的 cue 物件設定 */
function fakeServer(initial: Row[]) {
  let rows = initial.map(r => ({ ...r }));
  const calls: string[] = [];
  return {
    get rows() { return rows; },
    set rows(v: Row[]) { rows = v; },
    calls,
    failRestore: false,
    clear: async () => { calls.push('clear'); const gone = rows; rows = []; return { states: gone }; },
    restore: async function (this: { failRestore: boolean }, states: Row[]) {
      calls.push('restore');
      if (this.failRestore) throw new Error('網路斷了');
      const key = (r: Row) => `${r.cueId}/${r.objectId}`;
      const merged = new Map(rows.map(r => [key(r), r]));
      for (const s of states) merged.set(key(s), { ...s });
      rows = [...merged.values()];
    },
  };
}

const ROWS: Row[] = [
  { cueId: 'c1', objectId: 'oa', position: { x: 1, y: 2, z: 3 }, visible: false },
  { cueId: 'c1', objectId: 'ob', position: null, visible: true },
  { cueId: 'c2', objectId: 'ob', position: { x: 0, y: 4, z: 0 }, visible: null },
  { cueId: 'c3', objectId: 'oa', position: { x: 9, y: 9, z: 9 }, visible: null },
];
const sorted = (rows: Row[]) => [...rows].sort((a, b) => `${a.cueId}/${a.objectId}`.localeCompare(`${b.cueId}/${b.objectId}`));

describe('確認視窗', () => {
  it('數字：幾個 cue、幾個有調整、幾筆設定、幾個物件', () => {
    expect(summarizeOverrides(4, ROWS)).toEqual({ totalCues: 4, cuesWithOverrides: 3, overrides: 4, objects: 2 });
    expect(summarizeOverrides(2, [])).toEqual({ totalCues: 2, cuesWithOverrides: 0, overrides: 0, objects: 0 });
  });

  it('文字：列出影響的數量、什麼不會動、怎麼復原；是危險動作', () => {
    const d = resetAllDialog(summarizeOverrides(4, ROWS));
    expect(d.destructive).toBe(true);
    expect(d.title).toContain('所有 cue');
    expect(d.message).toContain('共 4 個 cue');
    expect(d.message).toContain('3 個 cue 調整過物件');
    expect(d.message).toContain('4 筆物件設定');
    expect(d.message).toContain('2 個物件');
    expect(d.message).toContain('名稱、時間、轉場');
    expect(d.message).toContain('機關時間軸');
    expect(d.message).toContain('預設隱藏');                 // 回到預設 = 預設隱藏的物件是隱藏的
    expect(d.message).toContain('Ctrl+Z');
    expect(d.confirmLabel).not.toMatch(/確定/);
    expect(RESET_ALL_MENU_LABEL).toBe('所有 cue 的物件回到預設位置');
  });
});

describe('復原紀錄放哪幾份', () => {
  it('現在這一份 + 每個 cue 各一份，不重複；沒選 cue 時現在這份是「物件預設位置」', () => {
    expect(resetAllHistoryScopes(historyScope('c2'), ['c1', 'c2', 'c3'])).toEqual(['cue:c2', 'cue:c1', 'cue:c3']);
    expect(resetAllHistoryScopes(historyScope(null), ['c1'])).toEqual(['defaults', 'cue:c1']);
  });
});

describe('清掉 + 復原一步', () => {
  const setup = () => {
    const server = fakeServer(ROWS);
    const history = new EditHistory();
    const scopes = resetAllHistoryScopes(historyScope('c1'), ['c1', 'c2', 'c3', 'c4']);
    return { server, history, scopes, run: () => runResetAll<Row>({ clear: () => server.clear(), restore: (s) => server.restore(s), history, scopes }) };
  };

  it('全部清掉；每個 cue 的復原紀錄都多一步', async () => {
    const { server, history, run } = setup();
    expect(await run()).toBe(4);
    expect(server.rows).toEqual([]);
    for (const c of ['c1', 'c2', 'c3', 'c4']) expect(history.counts(historyScope(c))).toEqual({ undo: 1, redo: 0 });
  });

  it('按一次復原 = 全部寫回去，跟清掉之前一模一樣（位置、顯示、沒設的欄位都是）', async () => {
    const { server, history, run } = setup();
    await run();
    expect(await history.undo(historyScope('c1'))).toBe('done');
    expect(sorted(server.rows)).toEqual(sorted(ROWS));
    expect(server.calls).toEqual(['clear', 'restore']);        // 一次清、一次寫回，不是逐一呼叫
    expect(history.counts(historyScope('c1'))).toEqual({ undo: 0, redo: 1 });
  });

  it('換到別的 cue 也能復原（不用回到按按鈕的那個 cue）；復原以後其他 cue 的紀錄清掉', async () => {
    const { server, history, run } = setup();
    await run();
    expect(await history.undo(historyScope('c3'))).toBe('done');
    expect(sorted(server.rows)).toEqual(sorted(ROWS));
    expect(history.counts(historyScope('c3'))).toEqual({ undo: 0, redo: 1 });
    for (const c of ['c1', 'c2', 'c4']) expect(history.counts(historyScope(c))).toEqual({ undo: 0, redo: 0 });
    // 從別的 cue 再按復原：沒東西了，不會再寫一次把後來的修改蓋掉
    expect(await history.undo(historyScope('c1'))).toBe('empty');
    expect(server.calls.filter(c => c === 'restore')).toHaveLength(1);
  });

  it('重做 = 再清一次；再復原 = 再寫回去', async () => {
    const { server, history, run } = setup();
    await run();
    await history.undo(historyScope('c2'));
    expect(await history.redo(historyScope('c2'))).toBe('done');
    expect(server.rows).toEqual([]);
    expect(history.counts(historyScope('c2'))).toEqual({ undo: 1, redo: 0 });
    expect(await history.undo(historyScope('c2'))).toBe('done');
    expect(sorted(server.rows)).toEqual(sorted(ROWS));
  });

  it('復原之前這個 cue 又改了別的：先復原那個修改，再復原批次（順序對）', async () => {
    const { server, history, run } = setup();
    await run();
    // c1 清掉之後又調了一個物件，記在 c1 的紀錄上
    server.rows.push({ cueId: 'c1', objectId: 'oz', position: { x: 5, y: 5, z: 5 }, visible: null });
    history.push(historyScope('c1'), {
      undo: async () => { server.rows = server.rows.filter(r => r.objectId !== 'oz'); },
      redo: async () => { /* 這個測試用不到 */ },
    });
    expect(history.counts(historyScope('c1')).undo).toBe(2);
    await history.undo(historyScope('c1'));
    expect(server.rows).toEqual([]);                           // 先復原了後來的修改
    await history.undo(historyScope('c1'));
    expect(sorted(server.rows)).toEqual(sorted(ROWS));         // 再復原批次
  });

  it('本來就沒有任何設定：什麼都沒清，也不記復原', async () => {
    const server = fakeServer([]);
    const history = new EditHistory();
    const n = await runResetAll<Row>({ clear: () => server.clear(), restore: (s) => server.restore(s), history, scopes: ['cue:c1'] });
    expect(n).toBe(0);
    expect(history.counts('cue:c1')).toEqual({ undo: 0, redo: 0 });
  });

  it('寫回失敗：丟出錯誤、這一步還在（可以再按一次復原）、其他 cue 的紀錄沒被清掉', async () => {
    const { server, history, run } = setup();
    await run();
    server.failRestore = true;
    await expect(history.undo(historyScope('c1'))).rejects.toThrow('網路斷了');
    expect(history.counts(historyScope('c1'))).toEqual({ undo: 1, redo: 0 });
    expect(history.counts(historyScope('c2'))).toEqual({ undo: 1, redo: 0 });
    server.failRestore = false;
    expect(await history.undo(historyScope('c1'))).toBe('done');
    expect(sorted(server.rows)).toEqual(sorted(ROWS));
  });

  it('清掉失敗：不記復原', async () => {
    const history = new EditHistory();
    await expect(runResetAll<Row>({ clear: async () => { throw new Error('後台出錯'); }, restore: async () => undefined, history, scopes: ['cue:c1'] })).rejects.toThrow('後台出錯');
    expect(history.counts('cue:c1')).toEqual({ undo: 0, redo: 0 });
  });
});
