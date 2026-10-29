// 導演頁的機關時間軸（只能看）：什麼時候出現、播放頭跟誰走、能不能改——規則都放這裡（純函式，方便測）。
// 畫面在 components/mechanisms/MechanismTimeline.tsx（編輯頁和導演頁共用同一份，導演頁多給 readOnly）；
// 接線在 lib/mechanisms/useStageTimeline.ts 和 pages/Preview.tsx。

import type { EditorMechanisms } from './useMechanisms';
import type { MechanismValues } from './model';

/** 時間軸畫面需要的資料：編輯頁給整個 useEditorMechanisms 的結果；導演頁只給看得到的這幾樣（沒有 commitTiming = 改不了） */
export type TimelineMech =
  Pick<EditorMechanisms, 'timeline' | 'mechanisms' | 'groups' | 'focusedId' | 'setFocusedId' | 'setPreviewTime' | 'previewTimeRef'>
  & Partial<Pick<EditorMechanisms, 'commitTiming'>>;

/** 播放頭跟著別人的時間走（導演頁放影片時是影片；沒影片、有音樂的歌是音樂，介面跟影片一樣：lib/useMusicPlayer.ts）；不給 = 時間軸自己播 */
export interface TimelineClock {
  /** 現在是第幾秒（每幀讀） */
  now: () => number;
  playing: boolean;
  /** 播放 / 暫停 */
  toggle: () => void;
  /** 跳到第幾秒 */
  seek: (t: number) => void;
  /** 總長度（秒），時間尺至少畫到這裡；不知道 = 不給 */
  duration?: number;
}

export const STAGE_TIMELINE_TEXT = {
  /** 導演頁按鈕 */
  button: '機關時間軸',
  buttonOpenTitle: '看每個機關什麼時候動、走幾秒（只能看）',
  buttonCloseTitle: '收起機關時間軸',
  /** 時間軸上面的說明列（只能看時） */
  readOnlyHint: '只能看，要改機關的時間請找製作。點一下時間尺可以跳到那個時間',
  readOnlyHintVideo: '只能看，要改機關的時間請找製作。點一下時間尺，影片（沒影片的歌是音樂）和 3D 畫面會跳到那個時間',
  /** 色塊的提示最後一行 */
  barTip: '點一下跳到這個 cue',
  /** 時間尺的提示 */
  rulerTipVideo: '點一下 / 拖：影片（沒影片的歌是音樂）和 3D 畫面跳到這個時間',
  /** 播放鈕的提示（跟著影片時） */
  playVideoTitle: '播放影片（沒影片的歌是音樂）；機關跟著它的時間動',
  pauseVideoTitle: '暫停影片（沒影片的歌是音樂）',
  /** 空的時候 */
  noMechanisms: '這個專案還沒有機關',
  noCueTimes: '這首歌的 cue 還沒有設「對應影片時間」，機關排不上時間軸（要設定請找製作）',
} as const;

// ─────────────────────────────────────────────
// 什麼時候出現
// ─────────────────────────────────────────────

/** 「機關時間軸」按鈕：專案有機關、而且在審片（調整舞台時不出現） */
export function showTimelineButton(o: { hasMechanisms: boolean; adjustOn: boolean }): boolean {
  return o.hasMechanisms && !o.adjustOn;
}

/** 時間軸本人：按鈕按開了，而且不是調整舞台、不是全螢幕預演（給客戶看的畫面不能有它） */
export function showTimeline(o: { open: boolean; hasMechanisms: boolean; adjustOn: boolean; fullscreen: boolean }): boolean {
  return o.open && o.hasMechanisms && !o.adjustOn && !o.fullscreen;
}

// ─────────────────────────────────────────────
// 播放頭跟誰走
// ─────────────────────────────────────────────

export type TimelineSource = 'video' | 'free';

/**
 * 這一版影片已經載好（3D 的機關本來就跟著影片時間走）→ 'video'：播放頭跟影片、點時間尺讓影片跳過去，時間軸不去搶 3D；
 * 沒有影片（或還在載）→ 'free'：時間軸自己播，3D 的機關跟著時間軸（關掉後回到目前的 cue）
 */
export function timelineSource(o: { videoMode: boolean; videoReady: boolean }): TimelineSource {
  return o.videoMode && o.videoReady ? 'video' : 'free';
}

/** 時間軸自己播的時候，3D 每幀要的機關位置；時間軸沒在預覽（沒有時間）→ null = 照目前的 cue 走 */
export function freeFrameValues(
  previewTime: number | null,
  timeline: { valuesAt: (t: number) => MechanismValues } | null,
): MechanismValues | null {
  return previewTime !== null && timeline ? timeline.valuesAt(previewTime) : null;
}

/** 時間尺要畫多長：機關最後走完再多一點；跟著影片時至少畫到影片的長度 */
export function timelineLength(o: { endTime: number; single: boolean; clockDuration?: number | null }): number {
  const base = o.single ? Math.max(4, o.endTime + 1.5) : Math.max(10, o.endTime + 4);
  const d = o.clockDuration;
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? Math.max(base, d) : base;
}

// ─────────────────────────────────────────────
// 能不能改
// ─────────────────────────────────────────────

/** 色塊上有哪些「改」的操作：只能看 → 都沒有（拖整條、拖右邊、鍵盤 ← → ↑ ↓） */
export function timelineEditing(readOnly: boolean): { drag: boolean; resize: boolean; keyboard: boolean } {
  const on = !readOnly;
  return { drag: on, resize: on, keyboard: on };
}

/** 色塊上要掛的「改」的事件：只能看 → 一個都不掛（拖不動、鍵盤改不了）；點一下選 cue 另外掛，不在這裡 */
export function editHandlers<T extends object>(readOnly: boolean, handlers: T): Partial<T> {
  return readOnly ? {} : handlers;
}
