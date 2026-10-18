import { afterEach, describe, expect, it } from 'vitest';
import { COMPACT_MAX_WIDTH, KEYBOARD_MIN_PX, PHONE_MAX_WIDTH, isCompactLayout, isPhoneLayout, viewportVars } from './viewportVars';
import { readFileSync } from 'node:fs';
import indexHtml from '../../index.html?raw';

// CSS 用 ?raw 讀會是空的（測試不處理 CSS），直接讀檔
const readText = (rel: string) => new TextDecoder().decode(readFileSync(new URL(rel, import.meta.url)));
const previewCss = readText('../pages/Preview.css');
const shareCss = readText('../pages/Share.css');
const guestPanelCss = readText('../components/GuestCommentsPanel.css');
const globalCss = readText('../styles/global.css');
const studioCss = readText('../pages/Studio.css');

describe('isPhoneLayout：手機寬度（留言變成底下拉上來的面板）', () => {
  const g = globalThis as unknown as { window?: unknown };
  afterEach(() => { delete g.window; });

  it('沒有 window（測試環境、伺服器）= 不是手機', () => {
    expect(isPhoneLayout()).toBe(false);
  });

  it('問 640px 以下這個條件，瀏覽器說符合 = 手機', () => {
    const asked: string[] = [];
    g.window = { matchMedia: (q: string) => { asked.push(q); return { matches: true }; } };
    expect(isPhoneLayout()).toBe(true);
    expect(asked).toEqual([`(max-width: ${PHONE_MAX_WIDTH}px)`]);
  });

  it('瀏覽器說不符合 = 不是手機', () => {
    g.window = { matchMedia: () => ({ matches: false }) };
    expect(isPhoneLayout()).toBe(false);
  });
});

describe('手機版面跟 CSS 對得上', () => {
  const phoneQuery = `@media (max-width: ${PHONE_MAX_WIDTH}px)`;

  it('導演頁、分享頁的留言面板都是在同一個手機寬度下變成面板', () => {
    expect(previewCss).toContain(phoneQuery);
    expect(guestPanelCss).toContain(phoneQuery);
    expect(previewCss).toMatch(/\.song-detail__side\s*\{[^}]*position:\s*absolute/);
    expect(guestPanelCss).toMatch(/\.share-comments\s*\{[^}]*position:\s*absolute/);
  });

  it('整頁高度用看得到的高度（--vvh，退回 dvh），不是會被網址列蓋住的 100vh', () => {
    expect(previewCss).toMatch(/\.preview\s*\{[^}]*height:\s*var\(--vvh/);
    expect(shareCss).toMatch(/\.share\s*\{[^}]*height:\s*var\(--vvh/);
    expect(globalCss).toContain('--vvh: 100dvh');
  });

  it('viewport 設定有 viewport-fit=cover（才有 safe-area）和鍵盤縮版面的設定', () => {
    expect(indexHtml).toContain('viewport-fit=cover');
    expect(indexHtml).toContain('interactive-widget=resizes-content');
  });

  it('電腦版（≥1200）不被手機規則影響：留言面板的 absolute 定位只在手機寬度的區塊裡', () => {
    // 手機區塊之外不准有「.song-detail__side { position: absolute」
    const outside = previewCss.split(phoneQuery)[0];
    expect(outside).not.toMatch(/\.song-detail__side\s*\{[^}]*position:\s*absolute/);
    const outsideShare = guestPanelCss.split(phoneQuery)[0];
    expect(outsideShare).not.toMatch(/\.share-comments\s*\{[^}]*position:\s*absolute/);
  });
});

describe('viewportVars：看得到的高度 → CSS 變數', () => {
  it('沒放大、沒鍵盤：高度直接寫進去', () => {
    expect(viewportVars({ height: 844, offsetTop: 0, scale: 1, layoutHeight: 844 })).toEqual({ vvh: '844px', vvTop: '0px', keyboardOpen: false });
  });

  it('網址列縮起來（少幾十 px）不算鍵盤', () => {
    const v = viewportVars({ height: 790, offsetTop: 0, scale: 1, layoutHeight: 844 });
    expect(v.vvh).toBe('790px');
    expect(v.keyboardOpen).toBe(false);
  });

  it('鍵盤跳出來（少了 300px）：高度變小、標記鍵盤打開', () => {
    const v = viewportVars({ height: 544, offsetTop: 0, scale: 1, layoutHeight: 844 });
    expect(v).toEqual({ vvh: '544px', vvTop: '0px', keyboardOpen: true });
  });

  it('剛好少 KEYBOARD_MIN_PX 就算鍵盤', () => {
    expect(viewportVars({ height: 844 - KEYBOARD_MIN_PX, offsetTop: 0, scale: 1, layoutHeight: 844 }).keyboardOpen).toBe(true);
    expect(viewportVars({ height: 844 - KEYBOARD_MIN_PX + 1, offsetTop: 0, scale: 1, layoutHeight: 844 }).keyboardOpen).toBe(false);
  });

  it('iPhone 打字時畫面被往上推：離最上面的距離也要記', () => {
    expect(viewportVars({ height: 500, offsetTop: 120.4, scale: 1, layoutHeight: 844 }).vvTop).toBe('120px');
  });

  it('兩指放大時不覆蓋（不然版面會跟著縮）', () => {
    expect(viewportVars({ height: 300, offsetTop: 50, scale: 2, layoutHeight: 844 })).toEqual({ vvh: null, vvTop: null, keyboardOpen: false });
  });

  it('數字怪怪的（0、NaN）不覆蓋', () => {
    expect(viewportVars({ height: 0, offsetTop: 0, scale: 1, layoutHeight: 844 }).vvh).toBeNull();
    expect(viewportVars({ height: NaN, offsetTop: 0, scale: 1, layoutHeight: 844 }).vvh).toBeNull();
    expect(viewportVars({ height: 800, offsetTop: 0, scale: 1, layoutHeight: 0 }).vvh).toBeNull();
  });

  it('offsetTop 是負數或 NaN 當 0', () => {
    expect(viewportVars({ height: 800, offsetTop: -3, scale: 1, layoutHeight: 844 }).vvTop).toBe('0px');
    expect(viewportVars({ height: 800, offsetTop: NaN, scale: 1, layoutHeight: 844 }).vvTop).toBe('0px');
  });
});

describe('動畫師工作站（Studio）的手機 / iPad 版面跟 CSS 對得上', () => {
  const g = globalThis as unknown as { window?: unknown };
  afterEach(() => { delete g.window; });
  const compactQuery = `@media (max-width: ${COMPACT_MAX_WIDTH}px)`;
  /** 從某個 @media 開頭，取到對應的右大括號為止 */
  const block = (css: string, head: string) => {
    const start = css.indexOf(head);
    if (start < 0) return '';
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
    }
    return css.slice(start);
  };

  it('isCompactLayout 問的寬度跟 CSS 一樣（1199px 以下 = iPad、手機）', () => {
    expect(isCompactLayout()).toBe(false);
    const asked: string[] = [];
    g.window = { matchMedia: (q: string) => { asked.push(q); return { matches: true }; } };
    expect(isCompactLayout()).toBe(true);
    expect(asked).toEqual([`(max-width: ${COMPACT_MAX_WIDTH}px)`]);
    expect(studioCss).toContain(compactQuery);
    expect(COMPACT_MAX_WIDTH).toBeLessThan(1200);
  });

  it('手機直放的面板（absolute 定位）用 640px，跟 isPhoneLayout 一樣', () => {
    expect(studioCss).toContain(`@media (max-width: ${PHONE_MAX_WIDTH}px) and (orientation: portrait)`);
    expect(block(studioCss, `@media (max-width: ${PHONE_MAX_WIDTH}px) and (orientation: portrait)`)).toMatch(/\.studio-right\s*\{[^}]*position:\s*absolute/);
  });

  it('電腦版（≥1200）不被影響：面板的 absolute、整頁高度、歌單一行都只在窄螢幕的區塊裡', () => {
    // 所有「會改版面」的規則都在 max-width 的 @media 裡 → 把那些區塊拿掉之後剩下的（電腦版）不能有它們
    let desktop = studioCss;
    for (const m of studioCss.match(/@media [^{]*\{/g) ?? []) desktop = desktop.replace(block(desktop, m), '');
    expect(desktop).not.toMatch(/\.studio-right\s*\{[^}]*position:\s*absolute/);
    expect(desktop).not.toMatch(/\.studio\s*\{[^}]*--vvh/);
    expect(desktop).not.toMatch(/\.studio-songs__toggle\s*\{[^}]*display:\s*flex/);
    expect(desktop).toMatch(/\.studio-scrim,[^{]*\{\s*display:\s*none/);
    expect(desktop).toMatch(/grid-template-columns:\s*240px 1fr 340px/);
  });

  it('整頁高度用看得到的高度（--vvh，退回 100dvh），不是會被網址列蓋住的 100vh', () => {
    expect(block(studioCss, compactQuery)).toMatch(/\.studio\s*\{[^}]*height:\s*var\(--vvh,\s*100dvh\)/);
  });

  it('手機、iPad：整頁不會左右捲、輸入欄位 16px', () => {
    expect(globalCss).toMatch(/@media \(max-width: 1199px\)[^}]*has\(\.studio\)[^}]*overflow-x:\s*clip/);
    expect(globalCss).toMatch(/\.my-projects, \.studio\) :is\(input/);
  });
});
