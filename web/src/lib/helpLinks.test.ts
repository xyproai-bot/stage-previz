import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { HELP_ANCHORS, helpUrl, ndiHelpAnchor } from './helpLinks';
import type { NdiStep } from './ndiSteps';
import Help, { HELP_TOC, type HelpTocItem } from '../pages/Help';

const ALL_STEPS: NdiStep[] = [
  'browser_unsupported', 'need_permission', 'permission_denied', 'connecting', 'helper_missing', 'helper_outdated',
  'ndi_missing', 'no_source', 'no_local_source', 'waiting_frames', 'live', 'ready',
];

const flat = (items: HelpTocItem[]): string[] => items.flatMap(i => [i.id, ...flat(i.children ?? [])]);

describe('說明頁連結', () => {
  it('helpUrl：相對網址，有段落就加 #', () => {
    expect(helpUrl()).toBe('/help');
    expect(helpUrl(HELP_ANCHORS.aeNdiOutput)).toBe('/help#ae-ndi-output');
  });

  it('卡住的每一步都連到對應的那一段；連線中 / LIVE / 檢查 OK 不用連', () => {
    expect(ndiHelpAnchor('browser_unsupported')).toBe('faq-safari');
    expect(ndiHelpAnchor('need_permission')).toBe('chrome-allow');
    expect(ndiHelpAnchor('permission_denied')).toBe('faq-blocked');
    expect(ndiHelpAnchor('helper_missing')).toBe('faq-no-helper');
    expect(ndiHelpAnchor('helper_outdated')).toBe('faq-outdated');
    expect(ndiHelpAnchor('ndi_missing')).toBe('faq-no-ndi-tools');
    expect(ndiHelpAnchor('no_source')).toBe('faq-no-ae');
    expect(ndiHelpAnchor('no_local_source')).toBe('faq-no-ae');
    expect(ndiHelpAnchor('waiting_frames')).toBe('faq-waiting-frames');
    expect(ndiHelpAnchor('connecting')).toBeNull();
    expect(ndiHelpAnchor('live')).toBeNull();
    expect(ndiHelpAnchor('ready')).toBeNull();
  });

  it('目錄列出每一段，而且不重複', () => {
    const ids = flat(HELP_TOC);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...Object.values(HELP_ANCHORS)].sort());
  });

  it('說明頁真的有這些段落（別的頁面連過來找得到）', () => {
    // react-router 在伺服器端轉字串會警告 useLayoutEffect（測試只看輸出的字，不用管）
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/help'] }, createElement(Help)));
    err.mockRestore();
    for (const id of Object.values(HELP_ANCHORS)) expect(html).toContain(`id="${id}"`);
    for (const step of ALL_STEPS) {
      const a = ndiHelpAnchor(step);
      if (a) expect(html).toContain(`id="${a}"`);
    }
  });
});
