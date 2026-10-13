// 畫面自動更新：每 25 秒一次 + 切回這個分頁 / 視窗時馬上一次。
// 分頁在背景時不打（瀏覽器也會把計時器放慢），切回來立刻補一次。
// 上一次還沒回來就不再打第二次；切回分頁跟計時器同時到也只打一次（間隔至少 2 秒）。
// 專案看不到了（被封存 / 刪除、被移出專案）→ run 回 STOP_LIVE_REFRESH，之後就不再打
// （不然開著的頁面會每 25 秒拿一次 404 / 403）。

import { useEffect, useRef } from 'react';

export const LIVE_REFRESH_MS = 25_000;
const MIN_GAP_MS = 2_000;

/** run 回這個 = 不用再自動更新了（再問也只會一直拿到 404 / 403） */
export const STOP_LIVE_REFRESH = 'stop-live-refresh' as const;

/** 這個錯誤 = 專案看不到了：封存 / 刪除（404）、被移出專案（403）。網路一時不通、伺服器出錯不算 */
export function isProjectGoneError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 404 || status === 403;
}

/** 頁面上的自動更新要不要開：專案看不到了 / 已封存（不會再有人改）/ 還在第一次讀 → 不開 */
export function liveRefreshWanted(s: { gone: boolean; archived?: boolean; loading?: boolean }): boolean {
  return !s.gone && !s.archived && !s.loading;
}

export interface LiveRefresher {
  /** 要更新了（計時器到 / 切回分頁）；真的有打回 true */
  trigger(): Promise<boolean>;
  /** 不再更新（之後 trigger 一律不打） */
  stop(): void;
  readonly stopped: boolean;
}

/** 核心（不靠 React / 瀏覽器，測試用得到） */
export function createLiveRefresher(
  run: () => unknown,
  opts: { isVisible?: () => boolean; now?: () => number; minGapMs?: number } = {},
): LiveRefresher {
  const isVisible = opts.isVisible ?? (() => true);
  const now = opts.now ?? (() => Date.now());
  const minGap = opts.minGapMs ?? MIN_GAP_MS;
  let inFlight = false;
  let stopped = false;
  let last = now();  // 頁面自己剛載入過，不用馬上再打
  return {
    get stopped() { return stopped; },
    stop() { stopped = true; },
    async trigger() {
      if (stopped || inFlight || !isVisible() || now() - last < minGap) return false;
      inFlight = true;
      last = now();
      try {
        if ((await run()) === STOP_LIVE_REFRESH) stopped = true;
      } catch { /* 自動更新失敗就等下一輪 */ } finally { inFlight = false; }
      return true;
    },
  };
}

function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * 頁面用：run 會一直拿最新的那個（不用 useCallback 也不會重設計時器）。
 * run 回 STOP_LIVE_REFRESH → 計時器、切回分頁的監聽都拿掉（enabled 關掉再打開才會重新開始）
 */
export function useLiveRefresh(run: () => unknown, opts: { enabled?: boolean; intervalMs?: number } = {}) {
  const { enabled = true, intervalMs = LIVE_REFRESH_MS } = opts;
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!enabled) return;
    const r = createLiveRefresher(() => runRef.current(), { isVisible: pageVisible });
    let id: number | null = null;
    const onBack = () => { if (pageVisible()) void tick(); };
    const cleanup = () => {
      if (id !== null) window.clearInterval(id);
      id = null;
      window.removeEventListener('focus', onBack);
      document.removeEventListener('visibilitychange', onBack);
    };
    const tick = async () => {
      await r.trigger();
      if (r.stopped) cleanup();
    };
    id = window.setInterval(() => { void tick(); }, intervalMs);
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onBack);
    return () => { r.stop(); cleanup(); };
  }, [enabled, intervalMs]);
}
