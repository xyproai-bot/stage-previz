// 畫面自動更新：每 25 秒一次 + 切回這個分頁 / 視窗時馬上一次。
// 分頁在背景時不打（瀏覽器也會把計時器放慢），切回來立刻補一次。
// 上一次還沒回來就不再打第二次；切回分頁跟計時器同時到也只打一次（間隔至少 2 秒）。

import { useEffect, useRef } from 'react';

export const LIVE_REFRESH_MS = 25_000;
const MIN_GAP_MS = 2_000;

export interface LiveRefresher {
  /** 要更新了（計時器到 / 切回分頁）；真的有打回 true */
  trigger(): Promise<boolean>;
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
  let last = now();  // 頁面自己剛載入過，不用馬上再打
  return {
    async trigger() {
      if (inFlight || !isVisible() || now() - last < minGap) return false;
      inFlight = true;
      last = now();
      try { await run(); } catch { /* 自動更新失敗就等下一輪 */ } finally { inFlight = false; }
      return true;
    },
  };
}

function pageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/** 頁面用：run 會一直拿最新的那個（不用 useCallback 也不會重設計時器） */
export function useLiveRefresh(run: () => unknown, opts: { enabled?: boolean; intervalMs?: number } = {}) {
  const { enabled = true, intervalMs = LIVE_REFRESH_MS } = opts;
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    if (!enabled) return;
    const r = createLiveRefresher(() => runRef.current(), { isVisible: pageVisible });
    const id = window.setInterval(() => { void r.trigger(); }, intervalMs);
    const onBack = () => { if (pageVisible()) void r.trigger(); };
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onBack);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onBack);
      document.removeEventListener('visibilitychange', onBack);
    };
  }, [enabled, intervalMs]);
}
