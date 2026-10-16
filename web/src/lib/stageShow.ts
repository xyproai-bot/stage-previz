// 全螢幕預演（3D 舞台佔滿整個螢幕、所有操作介面藏起來，拿來給人看）的規則——純函式（stageShow.test.ts 有測）。
//
//   進入：按 F，或 3D 工具列的「全螢幕預演」（「⋯」選單裡也有）；離開：Esc、小條上的「離開（Esc）」、再按一次 F
//   怎麼全螢幕：優先用瀏覽器的 Fullscreen API（對 3D 舞台那個區塊），不支援的（iPhone Safari）改成用 CSS 蓋滿整個視窗
//   小條：滑鼠一動或手指一點，出現 2.5 秒（播放 / 暫停、時間、歌名、離開），之後自己收起來
//   鍵盤：播放（空白鍵、J / K / L、逐格）、換 cue、比較兩版（C）照用；剪輯類的（I / O 標區段、W / E / Q 移動旋轉、
//        復原 / 重做、換歌…）全部關掉
//
// 「現在是不是全螢幕預演」記在 <html data-stage-show="1">：各處的快捷鍵（StageScene、審片、管理頁）不用互相 import 就能問。

/** 小條出現之後幾毫秒收起來 */
export const SHOW_BAR_HIDE_MS = 2500;

/** <html> 上的標記（全螢幕預演中 = '1'） */
export const STAGE_SHOW_ATTR = 'data-stage-show';

export function isStageShowActive(doc: Pick<Document, 'documentElement'> | undefined = typeof document === 'undefined' ? undefined : document): boolean {
  return !!doc && doc.documentElement.getAttribute(STAGE_SHOW_ATTR) === '1';
}

export function markStageShow(doc: Pick<Document, 'documentElement'>, on: boolean): void {
  if (on) doc.documentElement.setAttribute(STAGE_SHOW_ATTR, '1');
  else doc.documentElement.removeAttribute(STAGE_SHOW_ATTR);
}

// ─── 按鍵 ───

export interface ShowKeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
}

/** 在打字的地方（文字框、多行文字、可以編輯的區塊、下拉選單）按 F 是打字，不是全螢幕 */
function isTyping(t: EventTarget | null | undefined): boolean {
  const el = t as { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = String(el.type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type);
  }
  return false;
}

/**
 * 這個按鍵對全螢幕預演來說是什麼：
 *   'toggle' = F（進入 / 離開）；'exit' = 預演中按 Esc；其他 = null
 * 打字的時候、按著 Ctrl / Cmd / Alt、按住不放（repeat）、別人已經處理掉了（defaultPrevented）都不算。
 * dialogOpen = 有對話框開著（對話框裡的 F、Esc 是對話框的事）
 */
export function showKeyAction(e: ShowKeyLike, active: boolean, dialogOpen = false): 'toggle' | 'exit' | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.defaultPrevented || dialogOpen) return null;
  if (e.key === 'Escape') return active ? 'exit' : null;
  if ((e.key === 'f' || e.key === 'F') && !e.repeat) {
    if (isTyping(e.target)) return null;
    return 'toggle';
  }
  return null;
}

/** 預演中還能用的審片快捷鍵（reviewShortcuts.ts 的 ReviewAction）；剪輯類（I / O、換歌、Esc 清畫記）關掉 */
export const SHOW_ALLOWED_REVIEW_ACTIONS: readonly string[] = [
  'playPause', 'shuttleBack', 'shuttleStop', 'shuttleForward', 'frameBack', 'frameForward', 'nextCue', 'prevCue',
];

/** 預演中這個審片動作要不要照做 */
export function reviewActionAllowedInShow(action: string, showActive: boolean): boolean {
  return !showActive || SHOW_ALLOWED_REVIEW_ACTIONS.includes(action);
}

// ─── 怎麼全螢幕 ───

export interface FullscreenElementLike {
  requestFullscreen?: unknown;
  webkitRequestFullscreen?: unknown;
}
export interface FullscreenDocLike {
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
}

/**
 * 用哪一種：'standard'（requestFullscreen）、'webkit'（webkitRequestFullscreen，舊版 Safari / iPad）、
 * 'css'（都不行：iPhone Safari 的 <div> 沒有全螢幕；或網頁被嵌在不准全螢幕的框框裡）
 */
export function chooseFullscreenMode(el: FullscreenElementLike | null | undefined, doc: FullscreenDocLike | null | undefined): 'standard' | 'webkit' | 'css' {
  if (!el || !doc) return 'css';
  if (typeof el.requestFullscreen === 'function' && doc.fullscreenEnabled !== false) return 'standard';
  if (typeof el.webkitRequestFullscreen === 'function' && doc.webkitFullscreenEnabled !== false) return 'webkit';
  return 'css';
}

// ─── 小條 ───

/** 小條現在要不要顯示：最後一次動滑鼠 / 點螢幕在 hideMs 之內 */
export function barVisibleAt(now: number, lastActivity: number | null, hideMs = SHOW_BAR_HIDE_MS): boolean {
  return lastActivity !== null && now - lastActivity < hideMs;
}

/** 0:12 / 3:45（長度不知道就只寫現在的時間） */
export function showClockText(time: number, duration: number): string {
  const fmt = (sec: number) => {
    const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  return Number.isFinite(duration) && duration > 0 ? `${fmt(time)} / ${fmt(duration)}` : fmt(time);
}

export interface StageShowTransport {
  playing: boolean;
  time: number;
  duration: number;
  onTogglePlay: () => void;
}

export interface StageShowInfo {
  /** 小條上的歌名（沒有就不寫） */
  title?: string;
  /** 有影片可以播的頁面給；AE 即時（自己在播）、沒影片的沒有 */
  transport?: StageShowTransport;
}

/** 小條上的播放鈕要不要有：有影片、而且有長度（還沒讀好的影片按了沒用） */
export function showTransportUsable(t: StageShowTransport | undefined): t is StageShowTransport {
  return !!t && Number.isFinite(t.duration) && t.duration > 0;
}
