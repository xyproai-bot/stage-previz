// 「選一個」對話框的直排（選哪一首歌、選頭像顏色）：畫出來的樣子 + 鍵盤不會替人選
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DialogHost from './DialogHost';
import { chooseDialog, dialogs } from './dialogStore';

// 伺服器端畫出來會對 useLayoutEffect 抱怨一堆（只是測試用的畫法，不影響真的畫面）
beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => {
  vi.restoreAllMocks();
  while (dialogs.current()) dialogs.cancel(dialogs.current()!.id);
});
const html = () => renderToStaticMarkup(createElement(DialogHost));

describe('選一個：直排（layout: list）', () => {
  it('一個選項一行；有色塊的畫色塊；目前的標「目前」；取消按鈕還在', () => {
    void chooseDialog({
      title: '換頭像顏色',
      layout: 'list',
      choices: [
        { value: '#10c78a', label: '綠', swatch: '#10c78a', current: true },
        { value: '#ffaa44', label: '橘', swatch: '#ffaa44' },
      ],
    });
    const h = html();
    expect(h).toContain('sp-dialog__choices');
    expect(h.match(/class="sp-dialog__choice[ "]/g)).toHaveLength(2);
    expect(h).toContain('background:#10c78a');
    expect(h).toContain('background:#ffaa44');
    expect(h).toContain('目前');
    expect(h).toContain('aria-current="true"');
    expect(h).toContain('取消');
  });

  it('沒有指定 layout = 原本一排的按鈕（選項不會跑進直排）', () => {
    void chooseDialog({ title: '要給誰用？', choices: [{ value: 'a', label: '只給這個專案' }, { value: 'b', label: '全部專案' }] });
    const h = html();
    expect(h).not.toContain('sp-dialog__choices');
    expect(h).toContain('只給這個專案');
    expect(h).toContain('sp-dialog__btn--primary');
  });

  it('直排的選項要自己點：沒點就回 null（取消），不會自動選第一個', async () => {
    const p = chooseDialog({ title: '改分享的歌', layout: 'list', choices: [{ value: '__all__', label: '整個專案' }, { value: 's1', label: '開場' }] });
    dialogs.cancel(dialogs.current()!.id);
    await expect(p).resolves.toBeNull();
    const p2 = chooseDialog({ title: '改分享的歌', layout: 'list', choices: [{ value: '__all__', label: '整個專案' }, { value: 's1', label: '開場' }] });
    dialogs.settle(dialogs.current()!.id, 's1');
    await expect(p2).resolves.toBe('s1');
  });
});
