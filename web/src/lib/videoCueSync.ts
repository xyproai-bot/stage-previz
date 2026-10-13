// LED 上在播影片（歌曲影片版本 / 舊的 Drive 影片 / 本地檔案）時，舞台跟著影片時間走 —— 分享頁、導演頁、動畫師工作站共用。
//
// 規則（cueTimeline.ts）：cue 在「對應影片時間」剛好到位，提前「轉場」秒數開始等速移動。
//   例：cue 設在 30 秒、轉場 20 秒 → 影片 10 秒時開始動、20 秒走到一半、30 秒到位。
// 位置是用影片時間算的（不是時鐘），所以暫停會停在半路、拉時間軸舞台也跟著退。
//
//   timelineFrame — 這一幀舞台要擺在哪（純函式，videoCueSync.test.ts 有測）
//   cueSeekTime   — 手動點 cue → 影片跳到幾秒
//   useVideoCueTimeline — 頁面用：給 StageScene 的 poseAtFrame、cue 列亮哪個、點 cue 跳時間

import { useCallback, useEffect, useRef } from 'react';
import type { CueState } from './api';
import { videoCueSelection } from './cueTiming';
import { cuePoses, cueWindows, poseAtTime, type CuePoseMap, type CueWindow, type TimelineCue } from './cueTimeline';

export interface VideoTimeline {
  windows: CueWindow[];
  /** 每個有影片時間的 cue 的物件位置（先算好，每幀直接拿） */
  poses: Map<string, CuePoseMap>;
  timedIds: Set<string>;
}

export interface FrameState {
  /** LED 上正在放影片（不是 AE 即時 / 圖片 / 什麼都沒有） */
  active: boolean;
  /** 影片讀好了（有畫面） */
  ready: boolean;
  /** cue 列現在亮的 */
  selectedCueId: string | null;
  /** 影片現在幾秒 */
  time: number;
}

/**
 * 這一幀舞台照影片時間擺在哪；null = 照平常（換 cue 滑過去）：
 * 沒在放影片、還沒讀好、沒有 cue 設影片時間、或手動點了沒設時間的 cue（舞台照那個 cue 擺）
 */
export function timelineFrame(tl: VideoTimeline | null, s: FrameState): CuePoseMap | null {
  if (!s.active || !s.ready || !tl || tl.windows.length === 0) return null;
  if (s.selectedCueId && !tl.timedIds.has(s.selectedCueId)) return null;
  return poseAtTime(tl.windows, tl.poses, s.time);
}

/** 手動點 cue → 影片跳到那個 cue 的時間（沒在放影片、cue 沒設時間 → null，不跳） */
export function cueSeekTime(cue: { videoTimeSec: number | null } | null | undefined, active: boolean): number | null {
  if (!active || !cue || cue.videoTimeSec == null || !Number.isFinite(cue.videoTimeSec)) return null;
  return Math.max(0, cue.videoTimeSec);
}

/** 時間軸要用的 cue 位置都到了才回傳（還沒到的 cue 不放進去，poseAtTime 碰到就回 null） */
export async function loadTimeline(
  cues: TimelineCue[],
  statesFor: (cueId: string) => Promise<CueState[]> | null,
): Promise<VideoTimeline | null> {
  const windows = cueWindows(cues);
  if (windows.length === 0) return null;
  const entries = await Promise.all(windows.map(w => {
    const p = statesFor(w.cueId);
    return p ? p.then(states => [w.cueId, cuePoses(states)] as const, () => null) : null;
  }));
  const poses = new Map<string, CuePoseMap>();
  for (const e of entries) if (e) poses.set(e[0], e[1]);
  return { windows, poses, timedIds: new Set(windows.map(w => w.cueId)) };
}

export interface VideoCueTimelineOptions<C extends TimelineCue> {
  /** 這首歌的 cue（含 videoTimeSec、crossfadeSeconds） */
  cues: C[];
  /** 某個 cue 的物件位置（有快取就用快取） */
  statesFor: (cueId: string) => Promise<CueState[]> | null;
  /** 變了就重算時間軸（分頁切回來重抓 cue 時） */
  refreshKey?: unknown;
  /** 變了就把時間軸清掉重來（換歌：新的 cue 還沒讀到前，不能拿上一首的時間軸擺舞台） */
  resetKey?: unknown;
  /** LED 上正在放影片 */
  active: boolean;
  ready: boolean;
  video: HTMLVideoElement;
  /** 影片現在幾秒（React 狀態，cue 列亮哪個用） */
  time: number;
  selectedCueId: string | null;
  onSelectCue: (id: string | null) => void;
  seek: (t: number) => void;
}

export function useVideoCueTimeline<C extends TimelineCue>(o: VideoCueTimelineOptions<C>) {
  const timelineRef = useRef<VideoTimeline | null>(null);
  const lastAutoCueRef = useRef<string | null>(null);
  const stateRef = useRef({ active: o.active, ready: o.ready, selectedCueId: o.selectedCueId });
  stateRef.current = { active: o.active, ready: o.ready, selectedCueId: o.selectedCueId };
  const statesForRef = useRef(o.statesFor);
  statesForRef.current = o.statesFor;

  // 換了一首歌的 cue → 影片時間重新對 cue；上一首的時間軸不要套到這首
  useEffect(() => {
    lastAutoCueRef.current = null;
    timelineRef.current = null;
  }, [o.cues, o.resetKey]);

  // 放影片時才去拿每個 cue 的位置（全部到了才換上，換之前沿用舊的）
  useEffect(() => {
    if (!o.active) return;
    let cancelled = false;
    void loadTimeline(o.cues, (id) => statesForRef.current(id)).then(tl => {
      if (!cancelled) timelineRef.current = tl;
    });
    return () => { cancelled = true; };
  }, [o.cues, o.refreshKey, o.active]);

  // 影片播到某秒 → cue 列亮的跟著（亮的永遠跟舞台一致，規則在 videoCueSelection）
  const { active, time, cues, selectedCueId, onSelectCue } = o;
  useEffect(() => {
    if (!active) return;
    const next = videoCueSelection(cues, time, selectedCueId, lastAutoCueRef.current);
    lastAutoCueRef.current = next.targetId;
    if (next.selectedId !== selectedCueId) onSelectCue(next.selectedId);
  }, [active, time, cues, selectedCueId, onSelectCue]);

  const video = o.video;
  // 每幀問一次（不經過 React）
  const poseAtFrame = useCallback((): CuePoseMap | null => {
    const s = stateRef.current;
    return timelineFrame(timelineRef.current, { ...s, time: video.currentTime });
  }, [video]);

  // 手動點 cue → 有在放影片的話跳到那個 cue 的時間
  const { seek } = o;
  const selectCueByUser = useCallback((cue: C) => {
    onSelectCue(cue.id);
    const t = cueSeekTime(cue, stateRef.current.active);
    if (t != null) {
      lastAutoCueRef.current = cue.id;
      seek(t);
    }
  }, [onSelectCue, seek]);

  return { poseAtFrame, selectCueByUser };
}
