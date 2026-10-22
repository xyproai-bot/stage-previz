import { describe, it, expect } from 'vitest';
import { EditHistory, historyScope } from './editHistory';

/** 模擬「一個值」被改來改去，每一步記一筆 */
function makeValue(initial: number) {
  const box = { value: initial, log: [] as string[] };
  return box;
}
function setStep(box: { value: number; log: string[] }, from: number, to: number, tag = '') {
  return {
    undo: async () => { box.value = from; box.log.push(`undo${tag}`); },
    redo: async () => { box.value = to; box.log.push(`redo${tag}`); },
  };
}

describe('historyScope', () => {
  it('選了 cue → 那個 cue 一份；沒選 → 物件預設位置一份', () => {
    expect(historyScope('c1')).toBe('cue:c1');
    expect(historyScope('c2')).not.toBe(historyScope('c1'));
    expect(historyScope(null)).toBe('defaults');
    expect(historyScope(undefined)).toBe('defaults');
  });
});

describe('EditHistory（每個 cue 各一份）', () => {
  it('復原 → 重做 → 再復原', async () => {
    const h = new EditHistory();
    const a = makeValue(0);
    a.value = 5; h.push('cue:A', setStep(a, 0, 5));
    expect(h.counts('cue:A')).toEqual({ undo: 1, redo: 0 });

    expect(await h.undo('cue:A')).toBe('done');
    expect(a.value).toBe(0);
    expect(h.counts('cue:A')).toEqual({ undo: 0, redo: 1 });

    expect(await h.redo('cue:A')).toBe('done');
    expect(a.value).toBe(5);
    expect(h.counts('cue:A')).toEqual({ undo: 1, redo: 0 });

    expect(await h.undo('cue:A')).toBe('done');
    expect(a.value).toBe(0);
  });

  it('換到別的 cue 按復原：不會改到上一個 cue', async () => {
    const h = new EditHistory();
    const a = makeValue(0);
    a.value = 1; h.push('cue:A', setStep(a, 0, 1));
    // 換到 cue B（還沒改過任何東西）→ 沒東西可復原，A 原封不動
    expect(await h.undo('cue:B')).toBe('empty');
    expect(await h.redo('cue:B')).toBe('empty');
    expect(a.value).toBe(1);
    expect(a.log).toEqual([]);
    // 回到 A，A 的紀錄還在
    expect(h.counts('cue:A')).toEqual({ undo: 1, redo: 0 });
    expect(await h.undo('cue:A')).toBe('done');
    expect(a.value).toBe(0);
  });

  it('每個 cue 的紀錄互不影響', async () => {
    const h = new EditHistory();
    const a = makeValue(0);
    const b = makeValue(0);
    a.value = 1; h.push('cue:A', setStep(a, 0, 1, 'A'));
    b.value = 2; h.push('cue:B', setStep(b, 0, 2, 'B'));
    await h.undo('cue:B');
    expect(b.value).toBe(0);
    expect(a.value).toBe(1);
    expect(h.counts('cue:A')).toEqual({ undo: 1, redo: 0 });
    expect(h.counts('cue:B')).toEqual({ undo: 0, redo: 1 });
  });

  it('復原後又改了新的 → 不能重做（跟一般軟體一樣）', async () => {
    const h = new EditHistory();
    const a = makeValue(0);
    a.value = 1; h.push('cue:A', setStep(a, 0, 1));
    await h.undo('cue:A');
    a.value = 7; h.push('cue:A', setStep(a, 0, 7));
    expect(h.counts('cue:A')).toEqual({ undo: 1, redo: 0 });
    expect(await h.redo('cue:A')).toBe('empty');
    expect(a.value).toBe(7);
  });

  it('最多記 limit 步，超過丟最舊的', async () => {
    const h = new EditHistory(3);
    const a = makeValue(0);
    for (let i = 1; i <= 5; i++) { const from = a.value; a.value = i; h.push('cue:A', setStep(a, from, i)); }
    expect(h.counts('cue:A').undo).toBe(3);
    while ((await h.undo('cue:A')) === 'done') { /* 全部復原 */ }
    expect(a.value).toBe(2);  // 1→2 那步（最舊的兩步）已經丟了
  });

  it('復原失敗（例：網路斷）→ 那一步放回去，可以再按一次', async () => {
    const h = new EditHistory();
    let fail = true;
    let value = 1;
    h.push('cue:A', {
      undo: async () => { if (fail) throw new Error('offline'); value = 0; },
      redo: async () => { value = 1; },
    });
    await expect(h.undo('cue:A')).rejects.toThrow('offline');
    expect(h.counts('cue:A')).toEqual({ undo: 1, redo: 0 });
    expect(h.busy).toBe(false);
    fail = false;
    expect(await h.undo('cue:A')).toBe('done');
    expect(value).toBe(0);
  });

  it('復原還沒做完又按一次 → busy，不會同時跑兩個', async () => {
    const h = new EditHistory();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let undone = 0;
    h.push('cue:A', { undo: async () => { undone++; }, redo: async () => {} });
    h.push('cue:A', { undo: async () => { undone++; }, redo: async () => {} });
    // 最上面這步的復原要等一下（像網路慢）
    h.push('cue:A', { undo: async () => { await gate; undone++; }, redo: async () => {} });
    const first = h.undo('cue:A');
    expect(h.busy).toBe(true);
    expect(await h.undo('cue:A')).toBe('busy');
    release();
    expect(await first).toBe('done');
    expect(undone).toBe(1);
    expect(h.counts('cue:A')).toEqual({ undo: 2, redo: 1 });
  });

  it('復原做到一半又有新的修改 → 那一步不放進重做（順序會亂）', async () => {
    const h = new EditHistory();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    h.push('cue:A', { undo: async () => { await gate; }, redo: async () => {} });
    const p = h.undo('cue:A');
    h.push('cue:A', { undo: async () => {}, redo: async () => {} });
    release();
    await p;
    expect(h.counts('cue:A')).toEqual({ undo: 1, redo: 0 });
  });

  it('同一步放進好幾份紀錄：從哪一份復原 / 重做，就把那一份的名字交給這一步（一次改很多個 cue 的批次修改用）', async () => {
    const h = new EditHistory();
    const seen: string[] = [];
    const step = { undo: async (s: string) => { seen.push('undo@' + s); }, redo: async (s: string) => { seen.push('redo@' + s); } };
    h.push('cue:A', step);
    h.push('cue:B', step);
    await h.undo('cue:B');
    await h.redo('cue:B');
    expect(seen).toEqual(['undo@cue:B', 'redo@cue:B']);
    expect(h.counts('cue:A')).toEqual({ undo: 1, redo: 0 });   // 另一份沒動（要不要清掉是這一步自己的事）
  });

  it('clear：清掉那一份', async () => {
    const h = new EditHistory();
    h.push('cue:A', { undo: async () => {}, redo: async () => {} });
    h.clear('cue:A');
    expect(h.counts('cue:A')).toEqual({ undo: 0, redo: 0 });
    expect(await h.undo('cue:A')).toBe('empty');
  });
});
