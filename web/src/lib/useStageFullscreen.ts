// 全螢幕預演：把 containerRef 那一塊拉到整個螢幕、藏起所有操作介面。規則（純函式）在 stageShow.ts。
//
//   - 平常 containerRef 就是 3D 舞台自己（StageScene 裡面呼叫）。導演頁、分享連結會自己呼叫一份，containerRef 給 3D 舞台外面
//     那個不會被換掉的外層，再用 stageShow.controller 交給 StageScene：換歌時 3D 舞台整個重建，被拉成全螢幕的外層還在，
//     瀏覽器就不會退出全螢幕（也不用再要一次全螢幕——那得在使用者操作裡呼叫，換歌後已經不是了）
//   - 被拉成全螢幕的那個元素會貼上 data-stage-show-host="api|css"（StageShow.css 靠它排版、藏掉外層裡 3D 舞台以外的東西）
//   - 瀏覽器有 Fullscreen API 就用它；沒有（iPhone Safari）或被擋掉，改用 CSS 蓋滿整個視窗（data-stage-show-host="css"）
//   - F 進入 / 離開；Esc 離開（真的全螢幕時瀏覽器自己處理 Esc，我們靠 fullscreenchange 知道）
//   - 滑鼠一動或手指一點，小條出現 2.5 秒
//   - 影片、AE 即時照樣在播（影片元素本來就放在頁面上，這裡不動它）
//   - <html data-stage-show="1">：預演中的標記，各處快捷鍵用它判斷要不要關掉剪輯類的按鍵
// enabled = false（頁面沒有給 stageShow）→ 什麼都不做（例如分鏡縮圖用的 StageScene 不能也聽 F）。

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  chooseFullscreenMode, isStageShowActive, markStageShow, SHOW_BAR_HIDE_MS, showKeyAction, STAGE_SHOW_HOST_ATTR,
  type StageFullscreen,
} from './stageShow';

type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

export type { StageFullscreen };

const CSS_LOCK_CLASS = 'stage-show-lock';
/** 要求全螢幕之後，等多久還沒進去就改用 CSS 蓋滿 */
const FULLSCREEN_WAIT_MS = 1000;

/** 有對話框開著（對話框裡的 F、Esc 是對話框的事） */
function dialogOpen(target: EventTarget | null): boolean {
  const t = target as Element | null;
  if (t && typeof t.closest === 'function' && t.closest('[role="dialog"], [aria-modal="true"]')) return true;
  return !!document.querySelector('.dialog-overlay, .dlg-overlay, .help-overlay, [aria-modal="true"]');
}

export function useStageFullscreen(containerRef: RefObject<HTMLElement | null>, enabled: boolean): StageFullscreen {
  const [mode, setMode] = useState<'api' | 'css' | null>(null);
  const modeRef = useRef<'api' | 'css' | null>(null);
  modeRef.current = mode;
  const [timerOn, setTimerOn] = useState(false);
  // 小條上有東西開著（視角選單）或滑鼠停在小條上：小條不收
  const [held, setHeld] = useState(false);
  const barTimer = useRef<number | null>(null);

  const poke = useCallback(() => {
    setTimerOn(true);
    if (barTimer.current !== null) window.clearTimeout(barTimer.current);
    barTimer.current = window.setTimeout(() => { barTimer.current = null; setTimerOn(false); }, SHOW_BAR_HIDE_MS);
  }, []);

  const holdBar = useCallback((on: boolean) => {
    setHeld(on);
    if (!on && modeRef.current !== null) poke();  // 放開之後再留 2.5 秒
  }, [poke]);

  const fsElement = useCallback((): Element | null => {
    const d = document as FsDocument;
    return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
  }, []);

  const exit = useCallback(() => {
    if (modeRef.current === null) return;
    const wasApi = modeRef.current === 'api';
    modeRef.current = null;
    setMode(null);
    if (wasApi && fsElement()) {
      const d = document as FsDocument;
      try {
        const r = d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.();
        if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => { /* 已經不是全螢幕了 */ });
      } catch { /* 已經不是全螢幕了 */ }
    }
  }, [fsElement]);

  const enter = useCallback(() => {
    const el = containerRef.current as FsElement | null;
    if (!enabled || !el || modeRef.current !== null) return;
    // 漫遊模式的滑鼠鎖定先放掉（不然 Esc 會被它吃掉）
    try { document.exitPointerLock?.(); } catch { /* 沒鎖住 */ }
    const kind = chooseFullscreenMode(el, document as FsDocument);
    const useCss = () => { modeRef.current = 'css'; setMode('css'); };
    if (kind === 'css') { useCss(); return; }
    try {
      const r = kind === 'standard' ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen?.();
      modeRef.current = 'api';  // 先記起來：fullscreenchange 可能比 promise 先到
      setMode('api');
      if (r && typeof (r as Promise<void>).then === 'function') {
        (r as Promise<void>).then(undefined, () => { if (modeRef.current === 'api' && !fsElement()) useCss(); });
      }
      // 有的環境（嵌在別的程式裡的瀏覽器畫面）既不全螢幕也不回報錯誤 → 1 秒後還沒進去，就改用 CSS 蓋滿
      window.setTimeout(() => { if (modeRef.current === 'api' && !fsElement()) useCss(); }, FULLSCREEN_WAIT_MS);
    } catch {
      useCss();
    }
  }, [containerRef, enabled, fsElement]);

  const toggle = useCallback(() => { if (modeRef.current === null) enter(); else exit(); }, [enter, exit]);

  // 真的全螢幕時，使用者用瀏覽器自己的方式離開（Esc、手勢）→ 跟著離開
  useEffect(() => {
    if (!enabled) return;
    const onChange = () => {
      if (modeRef.current === 'api' && fsElement() !== containerRef.current) { modeRef.current = null; setMode(null); }
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, [enabled, containerRef, fsElement]);

  // F 進入 / 離開、Esc 離開
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const a = showKeyAction(e, modeRef.current !== null, dialogOpen(e.target));
      if (!a) return;
      if (a === 'toggle') {
        // 預演中按 F 離開，一定可以；進入時，別的 StageScene 已經在預演就不搶
        if (modeRef.current === null && isStageShowActive()) return;
        e.preventDefault();
        toggle();
      } else {
        exit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, toggle, exit]);

  // 預演中：標記、CSS 模式鎖住頁面捲動、滑鼠 / 手指一動就叫出小條
  const active = mode !== null;
  useEffect(() => {
    if (!active || !mode) return;
    const el = containerRef.current;
    markStageShow(document, true);
    el?.setAttribute(STAGE_SHOW_HOST_ATTR, mode);
    if (mode === 'css') document.documentElement.classList.add(CSS_LOCK_CLASS);
    poke();
    el?.addEventListener('pointermove', poke);
    el?.addEventListener('pointerdown', poke);
    return () => {
      el?.removeEventListener('pointermove', poke);
      el?.removeEventListener('pointerdown', poke);
      if (barTimer.current !== null) { window.clearTimeout(barTimer.current); barTimer.current = null; }
      setTimerOn(false);
      setHeld(false);
      el?.removeAttribute(STAGE_SHOW_HOST_ATTR);
      markStageShow(document, false);
      document.documentElement.classList.remove(CSS_LOCK_CLASS);
    };
  }, [active, mode, containerRef, poke]);

  // 頁面換掉（離開這頁）時，還在全螢幕就退出來
  useEffect(() => () => {
    if (modeRef.current === null) return;  // 自己沒在預演（別的 StageScene 可能正在）→ 不動標記
    if (modeRef.current === 'api' && fsElement()) {
      const d = document as FsDocument;
      try { void (d.exitFullscreen ? d.exitFullscreen() : d.webkitExitFullscreen?.()); } catch { /* 算了 */ }
    }
    containerRef.current?.removeAttribute(STAGE_SHOW_HOST_ATTR);
    markStageShow(document, false);
    document.documentElement.classList.remove(CSS_LOCK_CLASS);
  }, [fsElement, containerRef]);

  return { active, mode, barVisible: timerOn || held, enter, exit, toggle, holdBar };
}
