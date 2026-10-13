import { describe, expect, it } from 'vitest';
import {
  createErrorReporter, describeError, errorKey, installErrorReporting, MAX_REPORTS_PER_PAGE, renderErrorValue, reportPath,
  reportRenderError, shouldIgnore, type ClientErrorReport,
} from './errorReporting';

describe('reportPath', () => {
  it('只留路徑，分享連結碼 / 邀請碼遮掉', () => {
    expect(reportPath('https://previz.haimiaan.com/studio/p_1?song=s2#c')).toBe('/studio/p_1');
    expect(reportPath('https://previz.haimiaan.com/share/Kq8sTt2kLm9p?pw=1')).toBe('/share/:token');
    expect(reportPath('https://previz.haimiaan.com/s/jinma2026-k7p2')).toBe('/s/:token');
    expect(reportPath('https://previz.haimiaan.com/invite/abc')).toBe('/invite/:token');
    expect(reportPath('/help')).toBe('/help');
  });
});

describe('describeError / shouldIgnore / errorKey', () => {
  it('Error、字串、有 message 的物件', () => {
    const e = new TypeError('x is undefined');
    expect(describeError(e)?.message).toBe('TypeError: x is undefined');
    expect(describeError('boom')).toEqual({ message: 'boom' });
    expect(describeError({ message: 'm', name: 'N' })?.message).toBe('m');
    expect(describeError(undefined)).toBeNull();
    expect(describeError(undefined, 'Script error.')).toEqual({ message: 'Script error.' });
  });
  it('不用送的', () => {
    expect(shouldIgnore({ message: 'Script error.' })).toBe(true);
    expect(shouldIgnore({ message: 'AbortError: The user aborted a request.' })).toBe(true);
    expect(shouldIgnore({ message: 'ResizeObserver loop completed with undelivered notifications.' })).toBe(true);
    expect(shouldIgnore({ message: 'x', stack: 'at a (chrome-extension://abc/x.js:1:2)' })).toBe(true);
    expect(shouldIgnore({ message: 'TypeError: x' })).toBe(false);
  });
  it('同一個錯誤 = 訊息 + 第一個有位置的 stack', () => {
    const a = errorKey({ message: 'm', stack: 'TypeError: m\n    at f (https://x/a.js:1:2)\n    at g (https://x/a.js:3:4)' });
    const b = errorKey({ message: 'm', stack: 'TypeError: m\n    at f (https://x/a.js:1:2)\n    at h (https://x/b.js:9:9)' });
    expect(a).toBe(b);
    expect(errorKey({ message: 'm', stack: 'at z (https://x/a.js:5:6)' })).not.toBe(a);
  });
});

describe('createErrorReporter', () => {
  function setup(href = 'https://previz.haimiaan.com/share/tok123?pw=9') {
    const sent: ClientErrorReport[] = [];
    const r = createErrorReporter({ send: (x) => sent.push(x), getHref: () => href, appVersion: '2.0.0' });
    return { r, sent };
  }
  it('同一個錯誤只送一次', () => {
    const { r, sent } = setup();
    const err = new Error('same');
    r.onError({ error: err, message: err.message, filename: '' });
    r.onError({ error: err, message: err.message, filename: '' });
    r.onRejection({ reason: err });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ message: 'Error: same', path: '/share/:token', appVersion: '2.0.0' });
  });
  it('一頁最多 10 則', () => {
    const { r, sent } = setup('https://previz.haimiaan.com/admin');
    for (let i = 0; i < 25; i++) r.onRejection({ reason: new Error(`e${i}`) });
    expect(sent).toHaveLength(MAX_REPORTS_PER_PAGE);
    expect(r.sentCount).toBe(10);
  });
  it('Script error. 和沒有內容的 rejection', () => {
    const { r, sent } = setup();
    r.onError({ error: null, message: 'Script error.', filename: '' });
    r.onRejection({ reason: undefined });
    expect(sent.map(s => s.message)).toEqual(['Unhandled rejection']);
  });
  it('送出去失敗不會丟錯', () => {
    const r = createErrorReporter({ send: () => { throw new Error('offline'); }, getHref: () => '/' });
    expect(() => r.report(new Error('x'))).not.toThrow();
  });
});

describe('installErrorReporting', () => {
  it('接上 error / unhandledrejection，拆掉後不再送', () => {
    const listeners = new Map<string, (e: Event) => void>();
    const target = {
      location: { href: 'https://previz.haimiaan.com/preview/p_1?x=1' },
      addEventListener: (t: string, fn: (e: Event) => void) => { listeners.set(t, fn); },
      removeEventListener: (t: string) => { listeners.delete(t); },
    } as unknown as Parameters<typeof installErrorReporting>[0];
    const sent: ClientErrorReport[] = [];
    const off = installErrorReporting(target, (x) => sent.push(x));
    listeners.get('error')?.({ error: new Error('a'), message: 'a', filename: '' } as unknown as Event);
    listeners.get('unhandledrejection')?.({ reason: new Error('b') } as unknown as Event);
    expect(sent.map(s => [s.message, s.path])).toEqual([['Error: a', '/preview/p_1'], ['Error: b', '/preview/p_1']]);
    off();
    expect(listeners.size).toBe(0);
  });
});

describe('reportRenderError（ErrorBoundary 接到的畫面崩潰）', () => {
  it('正式版才送；開發中不送', () => {
    const sent: unknown[] = [];
    const report = (v: unknown) => { sent.push(v); return true; };
    expect(reportRenderError(new Error('x'), null, { enabled: false, report })).toBe(false);
    expect(sent).toHaveLength(0);
    expect(reportRenderError(new Error('x'), null, { enabled: true, report })).toBe(true);
    expect(sent).toHaveLength(1);
  });
  it('元件的位置接在 stack 後面，訊息不變', () => {
    const e = new TypeError('cannot read x');
    const v = renderErrorValue(e, '\n    at StageScene\n    at Preview') as Error;
    expect(v).toBeInstanceOf(Error);
    expect(describeError(v)?.message).toBe('TypeError: cannot read x');
    expect(v.stack).toContain('Component stack:');
    expect(v.stack).toContain('at StageScene');
    // 沒有元件位置 → 原封不動
    expect(renderErrorValue(e, '')).toBe(e);
  });
  it('跟 window 的錯誤一樣去重、一頁最多 10 則（共用同一個 reporter）', () => {
    const sent: ClientErrorReport[] = [];
    const r = createErrorReporter({ send: (x) => sent.push(x), getHref: () => 'https://x/preview/p_1' });
    const err = new Error('boom');
    reportRenderError(err, 'at A', { enabled: true, report: (v) => r.report(v) });
    reportRenderError(err, 'at A', { enabled: true, report: (v) => r.report(v) });
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toBe('Error: boom');
    expect(sent[0].path).toBe('/preview/p_1');
  });
});
