// 編輯頁左右兩欄可以拖邊緣調寬度（物件、cue 名字很長時看得到全名）。
// 寬度記在這台電腦（localStorage，讀寫失敗就用預設）；雙擊邊緣回到預設。
import { useCallback, useRef, useState } from 'react';

/** 把寬度夾在合理範圍：最小 min；最大 max，也不超過視窗的一半 */
export function clampPanelWidth(w: number, min: number, max: number, viewport: number): number {
  const hi = Math.max(min, Math.min(max, Math.floor(viewport * 0.5)));
  if (!Number.isFinite(w)) return min;
  return Math.round(Math.min(hi, Math.max(min, w)));
}

function readSaved(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * side = 'left'：把手在這一欄的右邊（往右拖變寬）；side = 'right'：把手在左邊（往左拖變寬）。
 * width = null 代表用 CSS 的預設寬度（沒調過）。
 */
export function usePanelWidth(key: string, opts: { side: 'left' | 'right'; min: number; max: number }) {
  const { side, min, max } = opts;
  const [width, setWidth] = useState<number | null>(() => readSaved(key));
  const drag = useRef<{ x: number; w: number } | null>(null);

  const save = useCallback((w: number | null) => {
    try {
      if (w === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, String(w));
    } catch { /* 存不了就只在這次有效 */ }
  }, [key]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const panel = e.currentTarget.parentElement;
    if (!panel) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w: panel.getBoundingClientRect().width };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const next = clampPanelWidth(side === 'left' ? d.w + dx : d.w - dx, min, max, window.innerWidth);
    setWidth(next);
  }, [side, min, max]);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    drag.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 已經放開 */ }
    setWidth(w => { save(w); return w; });
  }, [save]);

  const reset = useCallback(() => { setWidth(null); save(null); }, [save]);

  return { width, handleProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onDoubleClick: reset } };
}
