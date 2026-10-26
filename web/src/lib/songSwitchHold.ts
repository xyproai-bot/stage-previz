// 換歌時 3D 畫面直接跳到新歌的 cue：
//   新歌的 cue 清單 / 物件狀態 / 機關位置還沒都讀到之前，畫面停在上一首的樣子（不先跳回預設位置）；
//   都讀到的那一次不走轉場（不從預設位置慢慢走過來）。同一首歌裡換 cue 照舊走轉場秒數。
// 讀太久（例如讀失敗）就不等了，照當下的畫面顯示，免得卡在上一首。

import { useEffect, useReducer, useRef } from 'react';

/** 等新歌讀好最多等幾毫秒 */
export const SONG_SWITCH_MAX_HOLD_MS = 4000;

export interface SongSwitchState {
  /** 剛換到、還沒套上的歌（null = 沒有在換歌） */
  pendingSongId: string | null;
  lastSongId: string | null;
  /** 開始等的時間 */
  since: number;
}

export interface SongSwitchStep {
  state: SongSwitchState;
  /** true = 畫面先停在上一首 */
  hold: boolean;
  /** true = 這一次直接跳（轉場 0 秒、機關不走） */
  snap: boolean;
}

export const initialSongSwitch = (songId: string | null): SongSwitchState => ({ pendingSongId: null, lastSongId: songId, since: 0 });

/** 每次畫面更新算一次：現在選的歌、新歌的資料讀好了沒、現在時間 */
export function stepSongSwitch(s: SongSwitchState, songId: string | null, ready: boolean, now: number): SongSwitchStep {
  let state = s;
  if (songId !== s.lastSongId) state = { pendingSongId: songId, lastSongId: songId, since: now };
  if (state.pendingSongId === null) return { state, hold: false, snap: false };
  const timedOut = now - state.since >= SONG_SWITCH_MAX_HOLD_MS;
  return { state, hold: !ready && !timedOut, snap: true };
}

/**
 * live = 這一刻要給 3D 畫面的東西（物件狀態、cue、機關目標…）。
 * 回傳 scene = 真的要給畫面的那份（換歌讀取中 = 上一首最後的樣子），snap = 這次直接跳。
 */
export function useSongSwitchHold<T>(songId: string | null, ready: boolean, live: T): { scene: T; snap: boolean } {
  const stateRef = useRef<SongSwitchState>(initialSongSwitch(songId));
  const heldRef = useRef<T>(live);
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const step = stepSongSwitch(stateRef.current, songId, ready, performance.now());
  stateRef.current = step.state;
  if (!step.hold) heldRef.current = live;
  const pending = step.state.pendingSongId !== null;
  // 套上了 → 之後換 cue 照常走轉場；還在等 → 時間到再看一次（讀失敗也不會一直停在上一首）
  useEffect(() => {
    if (!pending) return;
    if (!step.hold) { stateRef.current = { ...stateRef.current, pendingSongId: null }; return; }
    const t = window.setTimeout(tick, SONG_SWITCH_MAX_HOLD_MS);
    return () => window.clearTimeout(t);
  });
  return { scene: heldRef.current, snap: step.snap };
}
