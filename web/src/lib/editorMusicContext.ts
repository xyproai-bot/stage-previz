// 編輯頁的音樂接線（把頁面上的音樂傳給底下的機關時間軸、cue 的欄位，不用一層一層傳 props）：
//   clock    音樂是這首歌的時間（沒影片、有音樂）時 = 音樂的 TimelineClock，機關時間軸的播放頭跟著它；不是 = null
//   setNow   「設在現在這一秒」：有音樂可以聽、而且能改 cue 時間（製作）時才有

import { createContext } from 'react';
import type { TimelineClock } from './mechanisms/stageTimeline';

export interface EditorMusicSetNow {
  /** 選中的 cue 叫什麼（沒選 cue = null，按鈕按不下去） */
  cueLabel: string | null;
  busy: boolean;
  run: () => void;
}

export interface EditorMusicValue {
  clock: TimelineClock | null;
  setNow: EditorMusicSetNow | null;
}

export const EditorMusicContext = createContext<EditorMusicValue>({ clock: null, setNow: null });
