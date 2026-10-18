// 這個畫面現在要不要加浮水印、寫誰：頁面（分享頁 / 導演頁 / 動畫師工作站 / 編輯頁）進來時登記，離開時撤掉。
// 3D 畫面（StageScene）和小播放器（MiniPlayer）自己去看這裡，所以頁面只要在最上面呼叫一次 useWatermarkScope，
// 不用把東西一層一層傳下去（動畫師工作站只多這一行）。
import { useEffect, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { sameIdentity, type WatermarkIdentity } from './text';
import { nextTickDelay } from './schedule';

interface WatermarkState {
  identity: WatermarkIdentity | null;
  /** 現在登記的是誰（撤掉時只撤自己登記的，換頁時不會把新頁面的撤掉） */
  owner: number;
}

export const useWatermarkStore = create<WatermarkState>(() => ({ identity: null, owner: 0 }));

let nextOwner = 1;

/** 登記；回傳「撤掉」。identity 是 null = 不加浮水印 */
export function claimWatermark(identity: WatermarkIdentity | null): () => void {
  const owner = nextOwner++;
  useWatermarkStore.setState({ identity, owner });
  return () => {
    if (useWatermarkStore.getState().owner === owner) useWatermarkStore.setState({ identity: null, owner: 0 });
  };
}

/**
 * 頁面用：identity 有東西 = 這一頁的畫面要加浮水印；null = 不加。
 * 內容一樣就不重新登記（頁面每次重畫都會傳新的物件進來）。
 */
export function useWatermarkScope(identity: WatermarkIdentity | null): void {
  const key = identity ? JSON.stringify(identity) : '';
  useEffect(() => {
    const id = key ? (JSON.parse(key) as WatermarkIdentity) : null;
    return claimWatermark(id);
  }, [key]);
}

export { sameIdentity };

// ── 共用的時鐘：所有浮水印（3D 畫面一個、小播放器一個）共用一個計時器，每分鐘換字、每 45 秒換位置 ──

let nowMs = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule() {
  if (timer !== null || listeners.size === 0) return;
  timer = setTimeout(() => {
    timer = null;
    nowMs = Date.now();
    for (const l of [...listeners]) l();
    schedule();
  }, nextTickDelay(Date.now()));
}

// 分頁在背景時計時器會被瀏覽器拖慢 → 切回來馬上對一次時間（不然截圖會是幾分鐘前的時間）
function onVisible() {
  if (document.visibilityState !== 'visible' || listeners.size === 0) return;
  nowMs = Date.now();
  for (const l of [...listeners]) l();
  if (timer !== null) { clearTimeout(timer); timer = null; }
  schedule();
}

function subscribe(cb: () => void) {
  if (listeners.size === 0) {
    nowMs = Date.now();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  }
  listeners.add(cb);
  schedule();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

const getSnapshot = () => nowMs;

/** 現在的時間（毫秒），只在「該換字 / 換位置」時才變 */
export function useWatermarkNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
