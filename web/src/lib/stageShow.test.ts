import { describe, expect, it } from 'vitest';
import {
  barVisibleAt, chooseFullscreenMode, isStageShowActive, markStageShow, reviewActionAllowedInShow, SHOW_ALLOWED_REVIEW_ACTIONS,
  SHOW_BAR_HIDE_MS, showClockText, showKeyAction, showTransportUsable, STAGE_SHOW_ATTR,
} from './stageShow';
import { reviewActionFor } from './review/reviewShortcuts';

const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra }) as unknown as EventTarget;

describe('F 進入 / 離開、Esc 離開', () => {
  it('F（大小寫都行）= 進入 / 離開；Esc 只有預演中才算離開', () => {
    expect(showKeyAction({ key: 'f' }, false)).toBe('toggle');
    expect(showKeyAction({ key: 'F' }, false)).toBe('toggle');
    expect(showKeyAction({ key: 'f' }, true)).toBe('toggle');
    expect(showKeyAction({ key: 'Escape' }, true)).toBe('exit');
    expect(showKeyAction({ key: 'Escape' }, false)).toBeNull();
  });

  it('打字的時候按 F 是打字：文字框、多行文字、可編輯區塊、下拉選單、數字欄', () => {
    for (const t of [el('INPUT', { type: 'text' }), el('INPUT'), el('INPUT', { type: 'number' }), el('INPUT', { type: 'search' }), el('TEXTAREA'), el('SELECT'), el('DIV', { isContentEditable: true })]) {
      expect(showKeyAction({ key: 'f', target: t }, false)).toBeNull();
    }
  });

  it('勾選框、滑桿、按鈕上按 F 照樣全螢幕', () => {
    for (const t of [el('INPUT', { type: 'checkbox' }), el('INPUT', { type: 'range' }), el('BUTTON'), el('DIV')]) {
      expect(showKeyAction({ key: 'f', target: t }, false)).toBe('toggle');
    }
  });

  it('按著 Ctrl / Cmd / Alt（Ctrl+F 是瀏覽器的搜尋）、按住不放、別人處理過了、對話框開著 → 不算', () => {
    expect(showKeyAction({ key: 'f', ctrlKey: true }, false)).toBeNull();
    expect(showKeyAction({ key: 'f', metaKey: true }, false)).toBeNull();
    expect(showKeyAction({ key: 'f', altKey: true }, false)).toBeNull();
    expect(showKeyAction({ key: 'f', repeat: true }, false)).toBeNull();
    expect(showKeyAction({ key: 'f', defaultPrevented: true }, false)).toBeNull();
    expect(showKeyAction({ key: 'f' }, false, true)).toBeNull();
    expect(showKeyAction({ key: 'Escape' }, true, true)).toBeNull();
  });

  it('其他鍵都不是', () => {
    for (const key of ['g', 'Enter', ' ', 'j', 'ArrowUp', 'F11']) expect(showKeyAction({ key }, true)).toBeNull();
  });
});

describe('預演中剪輯類的快捷鍵關掉', () => {
  it('播放（空白鍵、J / K / L）、逐格、換 cue 照用', () => {
    for (const a of ['playPause', 'shuttleBack', 'shuttleStop', 'shuttleForward', 'frameBack', 'frameForward', 'nextCue', 'prevCue']) {
      expect(reviewActionAllowedInShow(a, true), a).toBe(true);
    }
  });

  it('標區段（I / O）、換歌、Esc 清畫記不動', () => {
    for (const a of ['markIn', 'markOut', 'prevSong', 'nextSong', 'escape']) {
      expect(reviewActionAllowedInShow(a, true), a).toBe(false);
    }
  });

  it('沒在預演 → 全部照舊', () => {
    for (const a of ['markIn', 'markOut', 'prevSong', 'nextSong', 'escape', 'playPause']) {
      expect(reviewActionAllowedInShow(a, false), a).toBe(true);
    }
  });

  it('允許清單裡的每一個都是審片快捷鍵真的有的動作（改名字時這裡會抓到）', () => {
    const keys: Record<string, { key: string; shiftKey?: boolean }> = {
      playPause: { key: ' ' }, shuttleBack: { key: 'j' }, shuttleStop: { key: 'k' }, shuttleForward: { key: 'l' },
      frameBack: { key: ',' }, frameForward: { key: '.' }, nextCue: { key: 'J', shiftKey: true }, prevCue: { key: 'K', shiftKey: true },
    };
    for (const a of SHOW_ALLOWED_REVIEW_ACTIONS) expect(reviewActionFor(keys[a]), a).toBe(a);
  });
});

describe('怎麼全螢幕', () => {
  const full = (d: Record<string, unknown> = {}) => ({ fullscreenEnabled: true, ...d });
  it('有 requestFullscreen → 標準；只有 webkit 的（舊 Safari、iPad）→ webkit；都沒有（iPhone）→ CSS', () => {
    expect(chooseFullscreenMode({ requestFullscreen: () => {} }, full())).toBe('standard');
    expect(chooseFullscreenMode({ webkitRequestFullscreen: () => {} }, { webkitFullscreenEnabled: true })).toBe('webkit');
    expect(chooseFullscreenMode({}, full())).toBe('css');
    expect(chooseFullscreenMode(null, full())).toBe('css');
    expect(chooseFullscreenMode({ requestFullscreen: () => {} }, null)).toBe('css');
  });

  it('網頁被嵌在不准全螢幕的框框裡（fullscreenEnabled = false）→ 改用 CSS', () => {
    expect(chooseFullscreenMode({ requestFullscreen: () => {} }, { fullscreenEnabled: false })).toBe('css');
    expect(chooseFullscreenMode({ requestFullscreen: () => {}, webkitRequestFullscreen: () => {} }, { fullscreenEnabled: false, webkitFullscreenEnabled: true })).toBe('webkit');
    expect(chooseFullscreenMode({ webkitRequestFullscreen: () => {} }, { webkitFullscreenEnabled: false })).toBe('css');
  });
});

describe('小條', () => {
  it('動一下出現 2.5 秒，之後收起來；沒動過 = 不顯示', () => {
    expect(SHOW_BAR_HIDE_MS).toBe(2500);
    expect(barVisibleAt(1000, null)).toBe(false);
    expect(barVisibleAt(1000, 1000)).toBe(true);
    expect(barVisibleAt(3499, 1000)).toBe(true);
    expect(barVisibleAt(3500, 1000)).toBe(false);
    expect(barVisibleAt(9000, 1000)).toBe(false);
  });

  it('時間的寫法：0:12 / 3:45；長度不知道就只寫現在的', () => {
    expect(showClockText(12.9, 225)).toBe('0:12 / 3:45');
    expect(showClockText(75, 600)).toBe('1:15 / 10:00');
    expect(showClockText(5, 0)).toBe('0:05');
    expect(showClockText(5, NaN)).toBe('0:05');
    expect(showClockText(-3, 60)).toBe('0:00 / 1:00');
    expect(showClockText(NaN, 60)).toBe('0:00 / 1:00');
  });

  it('播放鈕：有影片而且讀到長度才有（AE 即時、還沒讀好的影片沒有）', () => {
    const t = { playing: false, time: 0, duration: 30, onTogglePlay: () => {} };
    expect(showTransportUsable(t)).toBe(true);
    expect(showTransportUsable({ ...t, duration: 0 })).toBe(false);
    expect(showTransportUsable({ ...t, duration: NaN })).toBe(false);
    expect(showTransportUsable(undefined)).toBe(false);
  });
});

describe('預演中的標記（各處快捷鍵靠它判斷）', () => {
  it('<html data-stage-show="1">：開 / 關', () => {
    const attrs = new Map<string, string>();
    const doc = { documentElement: { getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k) } } as unknown as Document;
    expect(isStageShowActive(doc)).toBe(false);
    markStageShow(doc, true);
    expect(attrs.get(STAGE_SHOW_ATTR)).toBe('1');
    expect(isStageShowActive(doc)).toBe(true);
    markStageShow(doc, false);
    expect(isStageShowActive(doc)).toBe(false);
    expect(isStageShowActive(undefined)).toBe(false);
  });
});
