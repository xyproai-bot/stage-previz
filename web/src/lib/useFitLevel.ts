import { useLayoutEffect, type RefObject } from 'react';

/**
 * 從 0 級開始一級一級試，放得下就停在那一級；到 max 還放不下就停在 max。
 * setLevel 換級（CSS 照級數決定收哪些），overflows 量現在是不是還超出。
 */
export function pickFitLevel(max: number, setLevel: (n: number) => void, overflows: () => boolean): number {
  for (let n = 0; n < max; n++) {
    setLevel(n);
    if (!overflows()) return n;
  }
  setLevel(max);
  return max;
}

/**
 * 一排放不下時一級一級收起來：在元素上設 data-fit="0"…"max"（CSS 照它收字、收進「⋯」）。
 * 用量的、不用固定寬度：按鈕多少看身分（全站製作在 1280 寬就要約 1670px，動畫師少很多），寫死的寬度一定會有人超出。
 * 只改 DOM 屬性、不 setState：量的時候不會重畫整頁、不會閃。
 * 寬度變了、裡面的東西變寬變窄（按鈕多了、復原步數變了）都會重量；排到下一格畫面再量，避免 ResizeObserver 自己觸發自己的警告。
 */
export function useFitLevel(ref: RefObject<HTMLElement | null>, max: number): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      pickFitLevel(max, n => { el.dataset.fit = String(n); }, () => el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
    });
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => { ro.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [ref, max]);
}
