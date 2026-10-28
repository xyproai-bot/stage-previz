// 「拆成兩個各自動的機關」的確認框：用站內的確認對話框（dialogs）、預設名字、改名字、名字不合再問一次、取消不拆。
// 確認框的內容是 React 元素；測試直接拿它的 props 當「畫面上的輸入框」（改 names 等於在框裡打字）。
import { describe, it, expect } from 'vitest';
import type { ReactElement } from 'react';
import { dialogs } from '../dialogs/dialogStore';
import type { Mechanism } from '../../lib/mechanisms/model';
import { askUnsplitNames, type UnsplitNames } from './MechanismUnsplitDialog';

const mech = (over: Partial<Mechanism> & Pick<Mechanism, 'id'>): Mechanism => ({
  name: over.id, kind: 'linear', axis: { x: 0, y: 1, z: 0 }, pivot: null, travelMin: 0, travelMax: 4,
  defaultValue: 0, maxSpeed: null, presets: [], parentId: null, objectIds: [], consoleLabel: null, order: 0,
  metadata: null, cueCount: 0, updatedAt: '', ...over,
});
const doors = mech({
  id: 'doors', name: '側面 LED', variant: 'split', axis: { x: -1, y: 0, z: 0 },
  mirror: { axis: { x: 1, y: 0, z: 0 }, pivot: null, consoleLabel: null },
  objectIds: ['l1', 'l2', 'r1'], objectSides: { l1: 'a', l2: 'a', r1: 'b' },
});
const other = mech({ id: 'other', name: '轉台' });

const tick = () => new Promise<void>(r => setTimeout(r, 0));

function current() {
  const req = dialogs.current();
  if (!req || req.kind !== 'confirm') throw new Error('沒有確認框');
  const msg = req.options.message as ReactElement<{ names: UnsplitNames; sidesText: string; error: string | null }>;
  return { req, props: msg.props };
}

describe('拆成兩個各自動的機關：確認框', () => {
  it('標題、說明、確定按鈕；預設名字「原名 A」「原名 B」；按確定 → 回兩個名字', async () => {
    const p = askUnsplitNames(doors, [doors, other]);
    const { req, props } = current();
    expect(req.options.title).toBe('把「側面 LED」拆成兩個各自動的機關？');
    expect(req.options.confirmLabel).toBe('拆開');
    expect(req.options.destructive).toBeFalsy();
    expect(props.names).toEqual({ a: '側面 LED A', b: '側面 LED B' });
    expect(props.sidesText).toBe('A 邊 2 個物件，B 邊 1 個物件。');
    expect(props.error).toBeNull();
    dialogs.settle(req.id, true);
    expect(await p).toEqual({ nameA: '側面 LED A', nameB: '側面 LED B' });
  });

  it('框裡改了名字（前後空白去掉）→ 回改過的', async () => {
    const p = askUnsplitNames(doors, [doors, other]);
    const { req, props } = current();
    props.names.a = ' 左門 ';
    props.names.b = '右門';
    dialogs.settle(req.id, true);
    expect(await p).toEqual({ nameA: '左門', nameB: '右門' });
  });

  it('名字不合（跟別的機關重複 / 兩個一樣 / 空白）→ 框再出現一次寫出哪裡不對，已經打的字還在；改對才拆', async () => {
    const p = askUnsplitNames(doors, [doors, other]);
    const first = current();
    first.props.names.a = '轉台';
    dialogs.settle(first.req.id, true);
    await tick();
    const second = current();
    expect(second.req.id).not.toBe(first.req.id);
    expect(second.props.error).toBe('這個專案已經有叫「轉台」的機關');
    expect(second.props.names.a).toBe('轉台');
    second.props.names.a = '門';
    second.props.names.b = '門';
    dialogs.settle(second.req.id, true);
    await tick();
    const third = current();
    expect(third.props.error).toBe('這個專案已經有叫「門」的機關');
    third.props.names.b = '   ';
    dialogs.settle(third.req.id, true);
    await tick();
    const fourth = current();
    expect(fourth.props.error).toBe('機關名稱不能空白');
    fourth.props.names.b = '右門';
    dialogs.settle(fourth.req.id, true);
    expect(await p).toEqual({ nameA: '門', nameB: '右門' });
  });

  it('取消 → null（不拆）；取消發生在名字不合之後也一樣', async () => {
    const p = askUnsplitNames(doors, [doors, other]);
    dialogs.cancel(current().req.id);
    expect(await p).toBeNull();

    const q = askUnsplitNames(doors, [doors, other]);
    const first = current();
    first.props.names.a = '轉台';
    dialogs.settle(first.req.id, true);
    await tick();
    dialogs.cancel(current().req.id);
    expect(await q).toBeNull();
    expect(dialogs.current()).toBeNull();
  });
});
