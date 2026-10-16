// 比較兩版（A/B）時，LED 跟著換：後面那一版先載好、跟著前面這一版同一個時間點播，按 C 馬上換過去。
// 這裡只放「純判斷」（abLedSync.test.ts 有測）；<video> 怎麼放、怎麼換在 lib/localVideo.ts（useLocalVideo 的 standby）。
//
// 兩個 <video>：
//   前面（active）= 小視窗和 LED 現在看的那一版
//   後面（standby）= 比較的另一版，看不到、沒聲音，但一直跟著前面播（暫停就暫停、跳到哪就跳到哪、速度一樣）
// 按 C：後面那一版直接變成前面（不用重新載入、不會黑一下），原本的前面退到後面接著跟；兩邊各自用自己那一版的 LED 版型快照。
// 手機不同時放兩支大影片（記憶體和解碼負擔）：維持原本的作法（換網址、同一秒），LED 換的時候會有一小段空檔。

/** 偏差在這個以內算「同步」：約 2 格（30 fps = 0.067 秒） */
export const SYNC_TOLERANCE_S = 0.06;
/** 暫停時要幾乎一模一樣（半格以內），不然拉到哪一格兩版看的不是同一格 */
export const PAUSED_TOLERANCE_S = 0.02;
/** 偏差超過這個就直接跳過去（比較小的用微調速度追，不會頓一下） */
export const HARD_SEEK_S = 0.25;
/** 跳過去時多抓一點（跳的當下前面又往前走了） */
export const SEEK_LEAD_S = 0.08;
/** 微調速度最多快 / 慢幾成 */
export const NUDGE_MAX = 0.1;
/** 按下去的那一刻，偏差超過這個就不走「馬上換」（還沒跟上，走原本載入的路） */
export const FLIP_MAX_DRIFT_S = 0.12;
/** 多久檢查一次（毫秒）；播放 / 暫停 / 跳時間的事件會馬上檢查 */
export const SYNC_INTERVAL_MS = 200;

export interface SyncInput {
  masterTime: number;
  masterDuration: number;
  masterPaused: boolean;
  masterRate: number;
  /** 循環播放：影片跳回開頭時，兩邊的時間差是一整段長度，不是真的差很多 */
  loop: boolean;
  standbyTime: number;
  standbyPaused: boolean;
  standbyRate: number;
  /** 後面那一版有畫面可以放了（readyState 夠） */
  standbyReady: boolean;
}

export interface SyncAction {
  pause?: true;
  play?: true;
  seekTo?: number;
  rate?: number;
}

/** 後面比前面快（正）或慢（負）幾秒；循環的影片在跳回開頭附近時取最短的那個方向 */
export function driftSeconds(masterTime: number, standbyTime: number, duration: number, loop: boolean): number {
  let d = standbyTime - masterTime;
  if (loop && Number.isFinite(duration) && duration > 0) {
    if (d > duration / 2) d -= duration;
    else if (d < -duration / 2) d += duration;
  }
  return d;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * 後面那一版這一刻要怎麼動才跟得上前面：
 *   - 還沒準備好 → 什麼都不動（等）
 *   - 前面暫停 → 後面也暫停，時間差超過半格就跳過去
 *   - 前面在播 → 後面也播；差在 2 格內 = 照前面的速度；差一點點 = 微調速度追（不頓）；差很多 = 直接跳過去
 */
export function decideSync(i: SyncInput): SyncAction {
  if (!i.standbyReady) return {};
  const act: SyncAction = {};
  const drift = driftSeconds(i.masterTime, i.standbyTime, i.masterDuration, i.loop);
  const rate = Number.isFinite(i.masterRate) && i.masterRate > 0 ? i.masterRate : 1;

  if (i.masterPaused) {
    if (!i.standbyPaused) act.pause = true;
    if (Math.abs(drift) > PAUSED_TOLERANCE_S) act.seekTo = i.masterTime;
    if (i.standbyRate !== rate) act.rate = rate;
    return act;
  }

  if (i.standbyPaused) act.play = true;
  if (Math.abs(drift) > HARD_SEEK_S) {
    act.seekTo = Math.max(0, i.masterTime + SEEK_LEAD_S * rate);
    if (i.standbyRate !== rate) act.rate = rate;
  } else if (Math.abs(drift) > SYNC_TOLERANCE_S) {
    // 後面快了（drift > 0）就慢一點、慢了就快一點；差越多調越多，最多一成
    const want = rate * (1 - clamp(drift, -NUDGE_MAX, NUDGE_MAX));
    if (Math.abs(i.standbyRate - want) > 0.005) act.rate = want;
  } else if (Math.abs(i.standbyRate - rate) > 0.005) {
    act.rate = rate;
  }
  return act;
}

export type SwitchPlan = 'none' | 'instant' | 'reload';

/**
 * 要換到 targetKey 這一版，怎麼換：
 *   'none'    已經是它
 *   'instant' 它就在後面、載好了、時間差在 FLIP_MAX_DRIFT_S 以內 → 直接對調前後（不重新載入、LED 不會黑）
 *   'reload'  其他（它不在後面、還沒載好、還沒跟上、手機沒有後面）→ 照原本的作法換網址、跳到同一秒
 */
export function planVersionSwitch(o: {
  targetKey: string;
  activeKey: string | null;
  standbyKey: string | null;
  standbyReady: boolean;
  /** 後面比前面快（正）或慢（負）幾秒 */
  drift: number;
}): SwitchPlan {
  if (o.targetKey === o.activeKey) return 'none';
  if (o.standbyKey === o.targetKey && o.standbyReady && Number.isFinite(o.drift) && Math.abs(o.drift) <= FLIP_MAX_DRIFT_S) return 'instant';
  return 'reload';
}

/**
 * 這台裝置要不要同時放兩支影片（後面那一版）：
 *   手機（窄螢幕）不要；瀏覽器回報記憶體 4 GB 以下不要（Chrome 才有這個數字，iPad 的 Safari 沒有 → 照做）
 */
export function standbyAllowed(o: { isPhone: boolean; deviceMemoryGb?: number | null }): boolean {
  if (o.isPhone) return false;
  if (typeof o.deviceMemoryGb === 'number' && o.deviceMemoryGb > 0 && o.deviceMemoryGb <= 4) return false;
  return true;
}

/** 比較中，LED 上現在放的是哪一版（徽章用）：「LED：V2」；沒在比較 = null */
export function ledBadgeText(comparing: boolean, currentLabel: string | null | undefined): string | null {
  const label = (currentLabel ?? '').trim();
  return comparing && label ? `LED：${label}` : null;
}

/** 手機上的小提醒（不同時放兩支影片，LED 換的時候要重新載入） */
export const LED_SWAP_PHONE_NOTE = '手機不同時放兩支影片：切換要重新載入，LED 會空一下';
