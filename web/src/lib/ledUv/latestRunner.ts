// 自動貼 UV：3D 預覽的節流（純函式，不碰 React / DOM）
//
// 拖曳螢幕的時候排法每秒變幾十次，預覽要「邊拖邊更新」但不能每次都重算：
//   - 同一時間最多算一次（上一次還沒算完，後來的要求只記一筆「還要再算」）
//   - 兩次開始之間至少隔 gapMs
//   - 算的時候永遠拿「最新的」排法（task 自己去讀最新的），中間的不用補算
// trigger() 隨時可以呼叫（很多次也沒關係）；dispose() 之後什麼都不會再跑。

export interface LatestRunner {
  trigger(): void;
  dispose(): void;
  /** 現在有沒有在算（測試、畫面狀態用） */
  readonly running: boolean;
}

export interface RunnerOptions {
  gapMs: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export function createLatestRunner(task: () => Promise<void>, opts: RunnerOptions): LatestRunner {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let running = false;
  let dirty = false;
  let disposed = false;
  let timer: unknown = null;
  let lastStart = -Infinity;

  const schedule = () => {
    if (disposed || running || timer !== null) return;
    const wait = Math.max(0, lastStart + opts.gapMs - now());
    timer = setTimer(go, wait);
  };

  const go = async () => {
    timer = null;
    if (disposed) return;
    running = true;
    dirty = false;
    lastStart = now();
    try {
      await task();
    } catch {
      /* task 自己處理錯誤；這裡不讓一次失敗卡住後面的 */
    } finally {
      running = false;
      if (dirty) schedule();
    }
  };

  return {
    trigger() {
      if (disposed) return;
      dirty = true;
      schedule();
    },
    dispose() {
      disposed = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
    },
    get running() { return running; },
  };
}
