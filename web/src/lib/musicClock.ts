// 音樂當「歌的時間」的接線（編輯頁、導演頁共用）：
//   musicTimelineClock    把音樂播放器包成機關時間軸要的 TimelineClock（播放頭跟音樂走、點時間尺讓音樂跳過去）
//   useMusicPreviewFeed   編輯頁：音樂播的時候，3D 的機關跟著音樂時間（編輯頁的 3D 機關看 previewTimeRef）
//   useMusicHotkeys       空白鍵 = 播放 / 暫停音樂；M = 把選中的 cue 設在現在這一秒（編輯頁）

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { LocalVideoState } from './localVideo';
import type { TimelineClock } from './mechanisms/stageTimeline';
import { isTypingTarget } from './keyTarget';

/** 播放頭每幀讀音樂現在幾秒；播放鍵、點時間尺都交給音樂播放器 */
export function musicTimelineClock(p: Pick<LocalVideoState, 'video' | 'playing' | 'togglePlay' | 'seek' | 'duration'>): TimelineClock {
  const video = p.video;
  return { now: () => video.currentTime, playing: p.playing, toggle: p.togglePlay, seek: p.seek, duration: p.duration > 0 ? p.duration : undefined };
}

/** React 裡用：播放器的狀態變了才換新的 clock */
export function useMusicTimelineClock(p: LocalVideoState, enabled: boolean): TimelineClock | null {
  const { video, playing, togglePlay, seek, duration } = p;
  return useMemo(
    () => (enabled ? musicTimelineClock({ video, playing, togglePlay, seek, duration }) : null),
    [enabled, video, playing, togglePlay, seek, duration],
  );
}

/** 預覽用到的播放元素（<video> / <audio>）的最小介面，方便用假的測 */
export interface PreviewMedia extends EventTarget {
  currentTime: number;
  paused: boolean;
  pause: () => void;
}

export interface PreviewFeed {
  /** 停止：暫停、回到開頭、預覽清掉（機關回到目前選的 cue） */
  stop: () => void;
  /** 拆掉：不再聽播放元素的事件，預覽清掉 */
  dispose: () => void;
}

/**
 * 編輯頁：音樂播的時候，3D 的機關跟著音樂時間（物件停在目前選的 cue，跟機關時間軸自己播的時候一樣）。
 *   開始播 / 拖時間尺跳過去之後才算「開始預覽」；暫停會停在那一刻；stop() 回到目前選的 cue。
 *   編輯頁的 3D 每幀看 previewTimeRef（useEditorMechanisms），這裡只管把音樂的時間寫進去。
 */
export function createMusicPreviewFeed(
  media: PreviewMedia,
  setPreviewTime: (t: number | null) => void,
  raf: { request: (cb: () => void) => number; cancel: (id: number) => void } = {
    request: (cb) => requestAnimationFrame(cb),
    cancel: (id) => cancelAnimationFrame(id),
  },
): PreviewFeed {
  let engaged = false;
  let stopping = false;
  let frame = 0;
  const push = () => { if (engaged) setPreviewTime(media.currentTime); };
  const loop = () => { push(); frame = raf.request(loop); };
  const onPlay = () => { engaged = true; raf.cancel(frame); frame = raf.request(loop); };
  const onPause = () => { raf.cancel(frame); push(); };
  const onSeek = () => { if (stopping) return; engaged = true; push(); };
  media.addEventListener('play', onPlay);
  media.addEventListener('pause', onPause);
  media.addEventListener('ended', onPause);
  media.addEventListener('seeking', onSeek);
  media.addEventListener('seeked', onSeek);
  if (!media.paused) onPlay();
  return {
    stop() {
      stopping = true;
      engaged = false;
      raf.cancel(frame);
      media.pause();
      try { media.currentTime = 0; } catch { /* 還沒載好就算了 */ }
      setPreviewTime(null);
      setTimeout(() => { stopping = false; }, 300);
    },
    dispose() {
      raf.cancel(frame);
      media.removeEventListener('play', onPlay);
      media.removeEventListener('pause', onPause);
      media.removeEventListener('ended', onPause);
      media.removeEventListener('seeking', onSeek);
      media.removeEventListener('seeked', onSeek);
      engaged = false;
      setPreviewTime(null);
    },
  };
}

/**
 * React 裡用：enabled 時接上（有影片了、音樂被移除 → 拆掉，預覽清掉）。
 * resetKey = 現在放的是哪一個音樂檔（音樂 id）：換成別的音樂時（換歌、換音樂；enabled 一直是 true）也要重新接，
 * 不然上一個聽到 2.9 秒停下來、換成新的，3D 的機關還停在「新音樂的 2.9 秒」，播放列卻是 0:00。
 * 同一個音樂換新網址（過期重載）不算換，時間照舊。
 */
export function useMusicPreviewFeed(o: {
  enabled: boolean;
  video: HTMLVideoElement;
  setPreviewTime: (t: number | null) => void;
  resetKey?: string | null;
}): { stop: () => void } {
  const { enabled, video, setPreviewTime, resetKey } = o;
  const feed = useRef<PreviewFeed | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const f = createMusicPreviewFeed(video, setPreviewTime);
    feed.current = f;
    return () => { f.dispose(); if (feed.current === f) feed.current = null; };
  }, [enabled, video, setPreviewTime, resetKey]);
  const stop = useCallback(() => {
    if (feed.current) feed.current.stop();
    else { video.pause(); setPreviewTime(null); }
  }, [video, setPreviewTime]);
  return { stop };
}

/** 這個按鍵事件該不該讓給正在操作的東西（打字、按鈕自己的空白鍵、3D 走路模式、帶修飾鍵） */
export function hotkeyYields(e: Pick<KeyboardEvent, 'target' | 'ctrlKey' | 'metaKey' | 'altKey' | 'defaultPrevented'>): boolean {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return true;
  if (isTypingTarget(e.target)) return true;
  if (typeof document !== 'undefined' && document.pointerLockElement) return true;   // 3D 走路模式（空白鍵 = 上升）
  return false;
}

/** 空白鍵遇到這些東西時，它們自己會處理（按鈕按下去、連結、分頁、選單、對話框裡） */
export function spaceBelongsToTarget(target: EventTarget | null): boolean {
  const el = target as { closest?: (s: string) => unknown } | null;
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.closest('button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="dialog"], input[type="checkbox"], input[type="radio"]');
}

/**
 * 快捷鍵：space = 播放 / 暫停；m = onMark（有給才算）。
 * 打字時、按著 Ctrl / Alt / Cmd、焦點在按鈕等自己會處理空白鍵的東西上 → 不處理。
 */
export function useMusicHotkeys(o: { enabled: boolean; onToggle: () => void; onMark?: (() => void) | null }): void {
  const ref = useRef(o);
  ref.current = o;
  useEffect(() => {
    if (!o.enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const cur = ref.current;
      if (!cur.enabled || hotkeyYields(e)) return;
      if (e.key === ' ' || e.code === 'Space') {
        if (spaceBelongsToTarget(e.target)) return;
        e.preventDefault();
        cur.onToggle();
      } else if ((e.key === 'm' || e.key === 'M') && !e.shiftKey && cur.onMark && !e.repeat) {
        e.preventDefault();
        cur.onMark();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [o.enabled]);
}
