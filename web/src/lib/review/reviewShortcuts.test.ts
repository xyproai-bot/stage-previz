import { describe, expect, it } from 'vitest';
import { REVIEW_SHORTCUTS, nextShuttle, reviewActionFor, shortcutsFor } from './reviewShortcuts';
import { isCompareShortcut } from '../abCompare';

const key = (k: string, extra: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; target: unknown }> = {}) =>
  ({ key: k, ...extra }) as Parameters<typeof reviewActionFor>[0];

describe('審片快捷鍵', () => {
  it('每個鍵對到一個動作', () => {
    expect(reviewActionFor(key(' '))).toBe('playPause');
    expect(reviewActionFor(key('j'))).toBe('shuttleBack');
    expect(reviewActionFor(key('k'))).toBe('shuttleStop');
    expect(reviewActionFor(key('L'))).toBe('shuttleForward');
    expect(reviewActionFor(key(','))).toBe('frameBack');
    expect(reviewActionFor(key('.'))).toBe('frameForward');
    expect(reviewActionFor(key('i'))).toBe('markIn');
    expect(reviewActionFor(key('O'))).toBe('markOut');
    expect(reviewActionFor(key('['))).toBe('prevSong');
    expect(reviewActionFor(key(']'))).toBe('nextSong');
    expect(reviewActionFor(key('Escape'))).toBe('escape');
  });
  it('Shift+J / K 照舊是切 cue（不會變成倒轉 / 停）', () => {
    expect(reviewActionFor(key('J', { shiftKey: true }))).toBe('nextCue');
    expect(reviewActionFor(key('K', { shiftKey: true }))).toBe('prevCue');
    expect(reviewActionFor(key('L', { shiftKey: true }))).toBeNull();
  });
  it('C 留給比較（A/B），這裡不搶；比較那邊也不會搶 J / K / L', () => {
    expect(reviewActionFor(key('c'))).toBeNull();
    expect(isCompareShortcut(key('c') as never)).toBe(true);
    for (const k of ['j', 'k', 'l', ' ', ',', '.', 'i', 'o']) expect(isCompareShortcut(key(k) as never)).toBe(false);
  });
  it('打字、按著 Ctrl / Cmd / Alt、漫遊模式都不算', () => {
    expect(reviewActionFor(key('j', { target: { tagName: 'TEXTAREA' } }))).toBeNull();
    expect(reviewActionFor(key(' ', { target: { tagName: 'INPUT', type: 'text' } }))).toBeNull();
    expect(reviewActionFor(key('k', { target: { tagName: 'SELECT' } }))).toBeNull();
    expect(reviewActionFor(key('l', { ctrlKey: true }))).toBeNull();
    expect(reviewActionFor(key('j', { metaKey: true }))).toBeNull();
    expect(reviewActionFor(key('.', { altKey: true }))).toBeNull();
    expect(reviewActionFor(key(' '), { pointerLocked: true })).toBeNull();
  });
  it('空白鍵在勾選框上 = 勾 / 不勾；在其他按鈕上照樣是播放 / 暫停', () => {
    expect(reviewActionFor(key(' ', { target: { tagName: 'INPUT', type: 'checkbox' } }))).toBeNull();
    expect(reviewActionFor(key(' ', { target: { tagName: 'BUTTON' } }))).toBe('playPause');
    expect(reviewActionFor(key(' ', { target: { tagName: 'INPUT', type: 'range' } }))).toBe('playPause');
  });
  it('說明表：同一個鍵不會出現兩次（不會打架）；每頁列出自己有的', () => {
    const seen = new Set<string>();
    for (const s of REVIEW_SHORTCUTS) {
      const k = s.keys.join('+');
      expect(seen.has(k), k).toBe(false);
      seen.add(k);
    }
    expect(shortcutsFor('share').some(s => s.action === 'prevSong')).toBe(false);
    expect(shortcutsFor('studio').some(s => s.action === 'nextSong')).toBe(true);
    expect(shortcutsFor('share').some(s => s.action === 'compare')).toBe(false);
    expect(shortcutsFor('preview').some(s => s.action === 'compare')).toBe(true);
    // 說明表上的每個動作都真的對得到按鍵
    for (const s of REVIEW_SHORTCUTS) {
      if (s.action === 'compare') continue;
      const k = s.keys.at(-1)!;
      const ev = key(k === '空白鍵' ? ' ' : k === 'Esc' ? 'Escape' : k, { shiftKey: s.keys[0] === 'Shift' });
      expect(reviewActionFor(ev), s.label).toBe(s.action);
    }
  });
});

describe('J / K / L', () => {
  it('L 播放，再按一次 2 倍速，再按還是 2 倍；J 倒轉一樣；K 停', () => {
    let s = nextShuttle({ dir: 0, rate: 1 }, 'shuttleForward');
    expect(s).toEqual({ dir: 1, rate: 1 });
    s = nextShuttle(s, 'shuttleForward');
    expect(s).toEqual({ dir: 1, rate: 2 });
    expect(nextShuttle(s, 'shuttleForward')).toEqual({ dir: 1, rate: 2 });
    expect(nextShuttle(s, 'shuttleBack')).toEqual({ dir: -1, rate: 1 });
    expect(nextShuttle({ dir: -1, rate: 1 }, 'shuttleBack')).toEqual({ dir: -1, rate: 2 });
    expect(nextShuttle({ dir: -1, rate: 2 }, 'shuttleStop')).toEqual({ dir: 0, rate: 1 });
  });
});
