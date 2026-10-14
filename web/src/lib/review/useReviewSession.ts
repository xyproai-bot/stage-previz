// 審片的「一場」（導演頁、動畫師工作站、分享連結共用）：播放器快捷鍵、逐格、J/K/L、速度、時間碼、
// 區段（I / O、拖時間軸）、打開留言（換版本 → 跳到那一格 → 攝影機飛過去 → 疊上畫記 → 區段循環）、畫記草稿、
// 送出留言時要帶的東西（區段、視角、cue、畫記、縮圖）。
//
// 規則（純函式）在同一個資料夾：reviewShortcuts.ts、playhead.ts、timecode.ts、annotations.ts、thumbnail.ts。
// 3D 畫面的操作走 StageScene 的 viewApiRef（getView / flyTo / capture）。

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { CameraView, CommentExtras, SongComment } from '../api';
import type { LocalVideoState } from '../localVideo';
import type { StageViewApi } from '../../components/StageScene';
import { versionKey } from '../songVersions';
import { toast } from '../toast';
import { nextShuttle, reviewActionFor, type Shuttle } from './reviewShortcuts';
import { estimateFps, fpsFromFrameCount, stepFrameTime } from './timecode';
import { loopSeekTarget, normalizeRange, seekLeavesRange } from './playhead';
import {
  DEFAULT_ANN_COLOR, parseAnnotation, serializeAnnotation, type AnnShape, type AnnTool, type Annotation,
} from './annotations';
import { composeThumbnail, THUMB_MAX_WIDTH } from './thumbnail';

interface VersionLike { key: string; url: string | null; label: string; crossOrigin?: 'anonymous' | 'use-credentials' }

export interface ReviewSessionOptions {
  player: LocalVideoState;
  /** 歌曲影片（版本）正在 LED 上放 → 播放快捷鍵、區段、畫記才作用 */
  videoActive: boolean;
  /** 換歌 → 全部重來 */
  resetKey: string | null;
  viewApiRef: MutableRefObject<StageViewApi | null>;
  /** 打開留言時換到那一版 */
  versions?: { items: readonly VersionLike[]; currentKey: string | null; select: (key: string) => void };
  /** 打開留言要換版本之前（工作站：LED 切回「影片」） */
  beforeOpenVersion?: () => void;
  /** 現在的 cue（留言記下來） */
  cueId: string | null;
  /** Shift+J / K */
  onCueStep?: (dir: 1 | -1) => void;
  /** [ / ]（工作站換歌） */
  onSongStep?: (dir: 1 | -1) => void;
  /** 按 O 標好區段 / 開始畫記之後 → 留言框拿到焦點 */
  onFocusComposer?: () => void;
  /** false = 不聽鍵盤（例：對話框開著） */
  keyboard?: boolean;
}

export interface AnnotationDraft {
  active: boolean;
  shapes: AnnShape[];
  tool: AnnTool;
  color: string;
  /** 畫的時候 3D 畫面的寬 / 高 */
  aspect: number;
  /** 畫的那一秒（影片） */
  time: number | null;
  setTool: (t: AnnTool) => void;
  setColor: (c: string) => void;
  add: (s: AnnShape) => void;
  undo: () => void;
  /** 全部擦掉（按復原可以拿回來） */
  clear: () => void;
  canUndo: boolean;
  /** 開始畫：先暫停、記下這一格的畫面和視角 */
  start: () => boolean;
  /** 不要了 */
  cancel: () => void;
}

export interface ReviewSession {
  // 播放
  fps: number | null;
  frameStep: (dir: 1 | -1) => void;
  shuttle: Shuttle;
  speed: number;
  setSpeed: (r: number) => void;
  timecode: boolean;
  toggleTimecode: () => void;
  // 區段（I / O）
  marks: { in: number | null; out: number | null };
  range: { start: number; end: number } | null;
  markIn: (t?: number) => void;
  markOut: (t?: number) => void;
  setMarks: (a: number | null, b: number | null) => void;
  clearMarks: () => void;
  // 循環（選了區段留言）
  loop: { start: number; end: number } | null;
  // 打開的留言
  selectedId: string | null;
  showing: Annotation | null;
  open: (c: SongComment | OpenableComment) => Promise<void>;
  clearSelection: () => void;
  // 畫記草稿
  draft: AnnotationDraft;
  /** 送出留言時要帶的：時間（區段 / 畫的那一秒 / attachTime / 現在的時間）、視角、cue、畫記、縮圖 */
  collect: (attachTime: number | null) => CommentExtras & { time: number };
  /** 沒特別選時間時，留言綁在影片現在的時間（預設要；留言框上面的 × 可以取消） */
  bindNow: boolean;
  setBindNow: (on: boolean) => void;
  /** 送出之後：清掉區段、畫記 */
  afterSend: () => void;
}

/** 打開留言要的欄位（團隊、訪客的留言都有） */
export type OpenableComment = Pick<SongComment, 'id' | 'time' | 'timeEnd' | 'view' | 'annotation' | 'videoId'>;

const TIMECODE_KEY = 'sp_review_timecode';

export function useReviewSession(o: ReviewSessionOptions): ReviewSession {
  const { player, videoActive, resetKey, viewApiRef } = o;
  const { video } = player;
  const optsRef = useRef(o);
  optsRef.current = o;

  // ── 影片幾格（播放時量） ──
  const [fps, setFps] = useState<number | null>(null);
  useEffect(() => { setFps(null); }, [player.srcKey]);
  // 解碼的格數（顯示的 + 掉的）÷ 影片走了幾秒：3D 很忙、畫面掉格也量得準（中間拉時間軸就重新量）
  useEffect(() => {
    if (fps != null || !player.playing || typeof video.getVideoPlaybackQuality !== 'function') return;
    let base: { frames: number; t: number } | null = null;
    const reset = () => { base = null; };
    const onTime = () => {
      if (video.playbackRate !== 1 || video.paused) { base = null; return; }
      const frames = video.getVideoPlaybackQuality().totalVideoFrames;
      if (!base) { base = { frames, t: video.currentTime }; return; }
      const dt = video.currentTime - base.t;
      if (dt < 0) { base = null; return; }
      if (dt >= 2) {
        const f = fpsFromFrameCount(frames - base.frames, dt);
        if (f) setFps(f);
        base = { frames, t: video.currentTime };
      }
    };
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('seeking', reset);
    video.addEventListener('ratechange', reset);
    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('seeking', reset);
      video.removeEventListener('ratechange', reset);
    };
  }, [video, player.playing, fps]);
  useEffect(() => {
    type RVFC = (cb: (now: number, meta: { mediaTime: number }) => void) => number;
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?: RVFC; cancelVideoFrameCallback?: (h: number) => void };
    if (typeof video.getVideoPlaybackQuality === 'function') return;  // 上面那個量得比較準
    if (!v.requestVideoFrameCallback || fps != null || !player.playing) return;
    const deltas: number[] = [];
    let last: number | null = null;
    let handle = 0;
    let done = false;
    const onFrame = (_now: number, meta: { mediaTime: number }) => {
      if (done) return;
      if (v.playbackRate === 1 && last != null) {
        const d = meta.mediaTime - last;
        if (d > 0) deltas.push(d);
      }
      last = meta.mediaTime;
      if (deltas.length >= 40) {
        const f = estimateFps(deltas);
        if (f) { setFps(f); done = true; return; }
        deltas.splice(0, 20);
      }
      handle = v.requestVideoFrameCallback!(onFrame);
    };
    handle = v.requestVideoFrameCallback(onFrame);
    return () => { done = true; v.cancelVideoFrameCallback?.(handle); };
  }, [video, player.playing, fps]);

  // ── 逐格、J / K / L、速度 ──
  const [shuttle, setShuttle] = useState<Shuttle>({ dir: 0, rate: 1 });
  const reverseTimerRef = useRef<number | null>(null);
  const stopReverse = useCallback(() => {
    if (reverseTimerRef.current != null) { window.clearInterval(reverseTimerRef.current); reverseTimerRef.current = null; }
  }, []);
  useEffect(() => () => stopReverse(), [stopReverse]);
  // 自己按了播放 / 暫停（不是倒轉）→ 狀態跟著
  useEffect(() => {
    if (player.playing) { stopReverse(); setShuttle(s => (s.dir === 1 ? s : { dir: 1, rate: player.rate })); }
    else if (reverseTimerRef.current == null) setShuttle(s => (s.dir === 0 ? s : { dir: 0, rate: 1 }));
  }, [player.playing, player.rate, stopReverse]);

  const frameStep = useCallback((dir: 1 | -1) => {
    stopReverse();
    if (!video.paused) video.pause();
    const t = stepFrameTime(video.currentTime, dir, fps, video.duration || 0);
    player.seek(t);
    setShuttle({ dir: 0, rate: 1 });
  }, [video, fps, player, stopReverse]);

  const applyShuttle = useCallback((next: Shuttle) => {
    stopReverse();
    setShuttle(next);
    if (next.dir === 0) { video.pause(); return; }
    if (next.dir === 1) {
      player.setRate(next.rate);
      video.play().catch(() => {});
      return;
    }
    // 倒轉：瀏覽器不能倒著播 → 停住，每 60ms 往回跳一點
    video.pause();
    const stepSec = 0.06 * next.rate;
    reverseTimerRef.current = window.setInterval(() => {
      const t = video.currentTime - stepSec;
      if (t <= 0) { player.seek(0); stopReverse(); setShuttle({ dir: 0, rate: 1 }); return; }
      player.seek(t);
    }, 60);
  }, [video, player, stopReverse]);

  const setSpeed = useCallback((r: number) => {
    player.setRate(r);
    setShuttle(s => (s.dir === 1 ? { dir: 1, rate: r } : s));
  }, [player]);

  const [timecode, setTimecode] = useState<boolean>(() => {
    try { return localStorage.getItem(TIMECODE_KEY) === '1'; } catch { return false; }
  });
  const toggleTimecode = useCallback(() => {
    setTimecode(v => {
      try { localStorage.setItem(TIMECODE_KEY, v ? '0' : '1'); } catch { /* 只是下次不記得 */ }
      return !v;
    });
  }, []);

  // ── 區段（I / O、拖時間軸） ──
  const [marks, setMarksState] = useState<{ in: number | null; out: number | null }>({ in: null, out: null });
  const range = useMemo(() => normalizeRange(marks.in, marks.out), [marks.in, marks.out]);
  const markIn = useCallback((t?: number) => {
    const at = t ?? video.currentTime;
    setMarksState(m => ({ in: at, out: m.out != null && m.out > at + 0.05 ? m.out : null }));
  }, [video]);
  const markOut = useCallback((t?: number) => {
    const at = t ?? video.currentTime;
    setMarksState(m => {
      const start = m.in != null && m.in < at - 0.05 ? m.in : Math.max(0, at - 5);
      return { in: start, out: at };
    });
    optsRef.current.onFocusComposer?.();
  }, [video]);
  const setMarks = useCallback((a: number | null, b: number | null) => setMarksState({ in: a, out: b }), []);
  const clearMarks = useCallback(() => setMarksState({ in: null, out: null }), []);

  // ── 打開的留言、循環、畫記疊圖 ──
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loop, setLoop] = useState<{ start: number; end: number } | null>(null);
  const [showing, setShowing] = useState<Annotation | null>(null);
  const openSeqRef = useRef(0);
  const clearSelection = useCallback(() => {
    openSeqRef.current++;
    setSelectedId(null);
    setLoop(null);
    setShowing(null);
  }, []);

  // 播放 → 畫記收起來（留言還是選著，區段照樣循環）
  useEffect(() => { if (player.playing) setShowing(null); }, [player.playing]);
  // 使用者自己轉視角 → 畫記對不上了，收起來（3D 畫面換歌時會重建 → 一直看是不是同一個）
  useEffect(() => {
    let off: (() => void) | null = null;
    let subscribed: StageViewApi | null = null;
    const check = () => {
      const api = viewApiRef.current;
      if (api === subscribed) return;
      off?.();
      off = null;
      subscribed = api;
      if (api) off = api.onUserMove(() => setShowing(null));
    };
    check();
    const t = window.setInterval(check, 500);
    return () => { window.clearInterval(t); off?.(); };
  }, [viewApiRef]);

  // 區段循環：播到結束跳回開始；自己拉到區段外面 → 不再循環
  const selfSeekRef = useRef(false);
  useEffect(() => {
    if (!loop) return;
    let raf = 0;
    const tick = () => {
      if (!video.paused) {
        const to = loopSeekTarget(video.currentTime, loop);
        if (to != null) { selfSeekRef.current = true; video.currentTime = to; }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const onSeeking = () => {
      if (selfSeekRef.current) { selfSeekRef.current = false; return; }
      if (seekLeavesRange(video.currentTime, loop)) { setLoop(null); setSelectedId(null); }
    };
    video.addEventListener('seeking', onSeeking);
    return () => { cancelAnimationFrame(raf); video.removeEventListener('seeking', onSeeking); };
  }, [loop, video]);

  const open = useCallback(async (c: SongComment | OpenableComment) => {
    if (drawActiveRef.current) {
      toast.warn('正在畫記：先送出留言，或按畫記工具列的叉叉不要畫記，再打開別的留言');
      return;
    }
    const seq = ++openSeqRef.current;
    const opts = optsRef.current;
    setSelectedId(c.id);
    setShowing(null);
    const hasRange = c.timeEnd != null && c.timeEnd > c.time;
    const ann = parseAnnotation(c.annotation);
    // 停在哪一格：有畫記 → 畫的那一格（區段留言常常是先標 I / O 再畫，畫的不是區段開頭）；沒有 → 留言的時間
    const at = ann?.t != null && (!hasRange || (ann.t >= c.time - 0.5 && ann.t <= (c.timeEnd as number) + 0.5)) ? ann.t : c.time;
    const hasTime = at > 0 || hasRange;
    setLoop(hasRange ? { start: c.time, end: c.timeEnd as number } : null);
    // 有區段、沒有畫記 → 直接開始循環；有畫記 → 先停在那一格給你看
    const autoplay = hasRange && !ann;

    // 換到留言的那一版（先換網址再記住選了哪一版：頁面載入影片的 effect 看到同一個 key 就不會從頭載）
    let switched = false;
    if (c.videoId && opts.versions) {
      const key = versionKey(c.videoId);
      const it = opts.versions.items.find(x => x.key === key);
      if (!it || !it.url) {
        if (hasTime) toast.warn('這則留言的那一版已經不在了，先用現在這一版看');
      } else {
        if (player.getSrcKey() !== key) {
          opts.beforeOpenVersion?.();
          player.loadUrl(it.url, { key: it.key, name: it.label, crossOrigin: it.crossOrigin, startAt: hasTime ? at : 0, autoplay });
          switched = true;
        }
        if (key !== opts.versions.currentKey) {
          opts.beforeOpenVersion?.();
          opts.versions.select(it.key);
        }
      }
    }
    if (!switched && hasTime) {
      const go = () => {
        selfSeekRef.current = true;
        if (autoplay) { player.seek(at); player.play(); }
        else { player.pause(); player.seek(at); }
      };
      if (player.ready) go();
      else player.video.addEventListener('loadedmetadata', go, { once: true });
    }

    // 攝影機飛過去，到了再疊上畫記
    const api = viewApiRef.current;
    if (c.view && api) {
      await api.flyTo(c.view, { fitAspect: ann?.aspect ?? c.view.aspect ?? null });
    }
    if (seq !== openSeqRef.current) return;
    if (ann) setShowing(ann);
  }, [player, viewApiRef]);

  // ── 畫記草稿 ──
  const [drawActive, setDrawActive] = useState(false);
  const [shapes, setShapes] = useState<AnnShape[]>([]);
  const [tool, setTool] = useState<AnnTool>('arrow');
  const [color, setColor] = useState<string>(DEFAULT_ANN_COLOR);
  const [drawAspect, setDrawAspect] = useState(16 / 9);
  const [drawTime, setDrawTime] = useState<number | null>(null);
  const drawFrameRef = useRef<HTMLCanvasElement | null>(null);
  const drawViewRef = useRef<CameraView | null>(null);
  const drawActiveRef = useRef(false);
  drawActiveRef.current = drawActive;
  // 「全部擦掉」可以復原：擦掉前的那些筆畫留著，按復原拿回來
  const clearedRef = useRef<AnnShape[] | null>(null);
  const startDraw = useCallback(() => {
    // 已經在畫了 → 不要重新開始（畫好的筆畫不會不見）
    if (drawActiveRef.current) return true;
    const api = viewApiRef.current;
    if (!api) return false;
    if (!video.paused) video.pause();
    stopReverse();
    setShowing(null);
    drawFrameRef.current = api.capture(THUMB_MAX_WIDTH);
    drawViewRef.current = api.getView();
    setDrawAspect(api.aspect() || 16 / 9);
    setDrawTime(optsRef.current.videoActive ? video.currentTime : null);
    setShapes([]);
    setDrawActive(true);
    return true;
  }, [viewApiRef, video, stopReverse]);
  const cancelDraw = useCallback(() => {
    setDrawActive(false);
    setShapes([]);
    clearedRef.current = null;
    drawFrameRef.current = null;
    drawViewRef.current = null;
    setDrawTime(null);
  }, []);
  const draft: AnnotationDraft = {
    active: drawActive, shapes, tool, color, aspect: drawAspect, time: drawTime,
    setTool, setColor,
    add: (s) => { clearedRef.current = null; setShapes(list => [...list, s]); },
    undo: () => {
      if (shapes.length === 0 && clearedRef.current) { const back = clearedRef.current; clearedRef.current = null; setShapes(back); return; }
      setShapes(list => list.slice(0, -1));
    },
    clear: () => { if (shapes.length) clearedRef.current = shapes; setShapes([]); },
    canUndo: shapes.length > 0 || !!clearedRef.current,
    start: startDraw,
    cancel: cancelDraw,
  };

  // 換歌 → 全部重來
  useEffect(() => {
    clearSelection();
    clearMarks();
    cancelDraw();
    stopReverse();
    setShuttle({ dir: 0, rate: 1 });
    setBindNow(true);
  }, [resetKey, clearSelection, clearMarks, cancelDraw, stopReverse]);

  const [bindNow, setBindNow] = useState(true);
  const collect = useCallback((attachTime: number | null): CommentExtras & { time: number } => {
    const api = viewApiRef.current;
    const ann = drawActive ? serializeAnnotation(shapes, drawAspect, drawTime) : null;
    const view = (drawActive ? drawViewRef.current : null) ?? api?.getView() ?? null;
    let time = 0;
    let timeEnd: number | null = null;
    if (range && optsRef.current.videoActive) { time = range.start; timeEnd = range.end; }
    else if (drawActive && drawTime != null) time = drawTime;
    else if (attachTime != null) time = attachTime;
    else if (bindNow && optsRef.current.videoActive) time = video.currentTime;
    const frame = (drawActive ? drawFrameRef.current : null) ?? api?.capture(THUMB_MAX_WIDTH) ?? null;
    const thumbnail = composeThumbnail(frame, ann);
    return { time: Math.round(time * 1000) / 1000, timeEnd, view, cueId: optsRef.current.cueId, annotation: ann, thumbnail };
  }, [viewApiRef, drawActive, shapes, drawAspect, drawTime, range, bindNow, video]);

  const afterSend = useCallback(() => {
    clearMarks();
    cancelDraw();
    setBindNow(true);
  }, [clearMarks, cancelDraw]);

  // ── 鍵盤 ──
  const stateRef = useRef({ videoActive, shuttle, frameStep, applyShuttle, markIn, markOut, clearSelection, clearMarks, drawActive });
  stateRef.current = { videoActive, shuttle, frameStep, applyShuttle, markIn, markOut, clearSelection, clearMarks, drawActive };
  const kDownRef = useRef(false);
  useEffect(() => {
    if (o.keyboard === false) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // 對話框開著（匯出、分享、確認…）→ 快捷鍵一律不處理（空白鍵是按對話框的按鈕、Esc 是關對話框）
      if (dialogOpen(e.target)) return;
      const action = reviewActionFor(e, { pointerLocked: !!document.pointerLockElement });
      if (!action) return;
      const st = stateRef.current;
      const oo = optsRef.current;
      if (action === 'nextCue' || action === 'prevCue') {
        if (!oo.onCueStep) return;
        e.preventDefault();
        oo.onCueStep(action === 'nextCue' ? 1 : -1);
        return;
      }
      if (action === 'prevSong' || action === 'nextSong') {
        if (!oo.onSongStep) return;
        e.preventDefault();
        if (st.drawActive) { toast.warn('正在畫記：先送出留言，或按叉叉不要畫記，再換歌'); return; }
        oo.onSongStep(action === 'nextSong' ? 1 : -1);
        return;
      }
      if (action === 'escape') {
        st.clearSelection();
        st.clearMarks();
        return;
      }
      if (!st.videoActive) return;
      // 畫記的時候影片不要動（畫的是按「畫記」那一格）
      if (st.drawActive) return;
      e.preventDefault();
      switch (action) {
        case 'playPause': stopReverse(); if (video.paused) video.play().catch(() => {}); else video.pause(); break;
        case 'frameBack': st.frameStep(-1); break;
        case 'frameForward': st.frameStep(1); break;
        case 'markIn': st.markIn(); break;
        case 'markOut': st.markOut(); break;
        case 'shuttleStop': kDownRef.current = true; st.applyShuttle(nextShuttle(st.shuttle, 'shuttleStop')); break;
        case 'shuttleBack':
        case 'shuttleForward':
          // 按住 K 再按 J / L = 一格
          if (kDownRef.current) { st.frameStep(action === 'shuttleBack' ? -1 : 1); break; }
          if (e.repeat) break;
          st.applyShuttle(nextShuttle(st.shuttle, action));
          break;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'k' || e.key === 'K') kDownRef.current = false;
      // 空白鍵在按鈕上：放開時瀏覽器會再「按一下」那個按鈕 → 擋掉（已經在按下時播放 / 暫停了）
      if ((e.key === ' ' || e.key === 'Spacebar') && stateRef.current.videoActive) {
        const t = e.target as HTMLElement | null;
        if (t && t.tagName === 'BUTTON') e.preventDefault();
      }
    };
    const onBlur = () => { kDownRef.current = false; };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [o.keyboard, video, stopReverse]);

  return {
    fps, frameStep, shuttle, speed: player.rate, setSpeed, timecode, toggleTimecode,
    marks, range, markIn, markOut, setMarks, clearMarks,
    loop, selectedId, showing, open, clearSelection,
    draft, collect, afterSend, bindNow, setBindNow,
  };
}

/** 手機、iPad：留言清單在舞台下面 → 打開留言、開始畫記時把 3D 畫面捲回來 */
export function revealStage(el: Element | null | undefined): void {
  if (!el || typeof window === 'undefined') return;
  if (!window.matchMedia('(max-width: 1024px)').matches) return;
  const r = el.getBoundingClientRect();
  if (r.top >= 0 && r.bottom <= window.innerHeight) return;
  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/** 觸控裝置（開始畫記時不要把焦點放到留言框：鍵盤會跳出來、畫面被推走） */
export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

/** 有沒有對話框開著（或焦點在對話框裡） */
function dialogOpen(target: EventTarget | null): boolean {
  const t = target as Element | null;
  if (t && typeof t.closest === 'function' && t.closest('[role="dialog"], [aria-modal="true"]')) return true;
  if (typeof document === 'undefined') return false;
  return !!document.querySelector('.dialog-overlay, .dlg-overlay, .help-overlay, [aria-modal="true"]');
}
