// 「現在 LED 上這一格畫面是影片的第幾秒」——中途換版型要在「換版型的那一格」剛好換，不能早也不能晚一格。
//
// <video>.currentTime 是播放時鐘，播放中可能比正在畫的那一格早或晚一點；拉時間軸（seek）的時候更會先跳到新時間、
// 畫面還是舊的那一格 → 用它決定版型會閃一下。
// 所以優先用 requestVideoFrameCallback：瀏覽器每送出新的一格就叫一次，並告訴我們「這一格的時間」（mediaTime），
// 它跟接下來上傳到貼圖的是同一格（回呼在 requestAnimationFrame 之前，StageScene 的 tick 在 rAF 裡讀）。
//   - 播放中：每一格的 mediaTime
//   - 暫停後拉時間軸：seeked 事件（新的那一格已經準備好）→ currentTime；requestVideoFrameCallback 也會再報一次
//   - 換影片（emptied / loadstart）：清掉，回到 currentTime，直到下一格
//   - 瀏覽器沒有 requestVideoFrameCallback：一律用 currentTime
// 純邏輯（吃一個像 <video> 的物件），ledFrameClock.test.ts 用假的 video 測。

export interface FrameCallbackMeta { mediaTime: number }

/** 像 <video> 的最小介面（測試用假的） */
export interface VideoLike {
  currentTime: number;
  requestVideoFrameCallback?: (cb: (now: number, meta: FrameCallbackMeta) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface FrameClock {
  /** 現在畫在貼圖上的那一格的時間（秒） */
  time(): number;
  /** 有沒有用到「每一格回報」（false = 只靠 currentTime） */
  readonly precise: boolean;
  dispose(): void;
}

export function createFrameClock(video: VideoLike): FrameClock {
  let frameTime: number | null = null;
  let handle: number | null = null;
  let disposed = false;
  const hasRvfc = typeof video.requestVideoFrameCallback === 'function';

  const onFrame = (_now: number, meta: FrameCallbackMeta) => {
    if (disposed) return;
    if (Number.isFinite(meta.mediaTime)) frameTime = meta.mediaTime;
    handle = video.requestVideoFrameCallback!(onFrame);
  };
  if (hasRvfc) handle = video.requestVideoFrameCallback!(onFrame);

  // 拉完時間軸：新的一格準備好了
  const onSeeked = () => { frameTime = video.currentTime; };
  // 換影片 / 重新載入：舊的時間不算數
  const onReset = () => { frameTime = null; };
  video.addEventListener('seeked', onSeeked);
  video.addEventListener('emptied', onReset);
  video.addEventListener('loadstart', onReset);

  return {
    time: () => (hasRvfc && frameTime !== null ? frameTime : video.currentTime),
    precise: hasRvfc,
    dispose() {
      disposed = true;
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('emptied', onReset);
      video.removeEventListener('loadstart', onReset);
      if (handle !== null && video.cancelVideoFrameCallback) { try { video.cancelVideoFrameCallback(handle); } catch { /* 沒關係 */ } }
      handle = null;
    },
  };
}
