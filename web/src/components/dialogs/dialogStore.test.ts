import { describe, expect, it } from 'vitest';
import { DialogStore, primaryChoice, splitQuestion } from './dialogStore';

describe('站內對話框的排隊和回答', () => {
  it('確認：按確定 true、取消 false；回答完就從排隊拿掉', async () => {
    const s = new DialogStore();
    const seen: number[] = [];
    s.subscribe(q => seen.push(q.length));
    const p = s.confirm({ title: '刪除？', confirmLabel: '刪除', destructive: true });
    const req = s.current()!;
    expect(req.kind).toBe('confirm');
    s.settle(req.id, true);
    await expect(p).resolves.toBe(true);
    expect(s.current()).toBeNull();
    expect(seen).toEqual([1, 0]);

    const p2 = s.confirm({ title: '登出？', confirmLabel: '登出' });
    s.cancel(s.current()!.id);
    await expect(p2).resolves.toBe(false);
  });

  it('輸入：回傳打的字（不自動去空白）；取消回 null', async () => {
    const s = new DialogStore();
    const p = s.prompt({ title: '新增歌曲', confirmLabel: '新增' });
    s.settle(s.current()!.id, '  S03 主題曲 ');
    await expect(p).resolves.toBe('  S03 主題曲 ');
    const p2 = s.prompt({ title: '改名', confirmLabel: '改名' });
    s.cancel(s.current()!.id);
    await expect(p2).resolves.toBeNull();
  });

  it('一次只顯示一個，後來的排隊；同一個回答兩次只算第一次', async () => {
    const s = new DialogStore();
    const a = s.confirm({ title: 'A', confirmLabel: '好' });
    const b = s.choose({ title: 'B', choices: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y', primary: true }] });
    const first = s.current()!;
    expect(first.options.title).toBe('A');
    s.settle(first.id, true);
    s.settle(first.id, false);
    await expect(a).resolves.toBe(true);
    const second = s.current()!;
    expect(second.options.title).toBe('B');
    s.settle(second.id, 'y');
    await expect(b).resolves.toBe('y');
    expect(s.snapshot()).toEqual([]);
  });

  it('舊的整段文字拆成標題 + 說明；主要選項', () => {
    expect(splitQuestion('要刪掉 V2 嗎？\n\n刪掉後…\n第二行')).toEqual({ title: '要刪掉 V2 嗎？', message: '刪掉後…\n第二行' });
    expect(splitQuestion('刪除？')).toEqual({ title: '刪除？' });
    expect(primaryChoice([{ value: 'a', label: 'A' }, { value: 'b', label: 'B', primary: true }])?.value).toBe('b');
    expect(primaryChoice([{ value: 'a', label: 'A' }])?.value).toBe('a');
    expect(primaryChoice([])).toBeNull();
  });
});
