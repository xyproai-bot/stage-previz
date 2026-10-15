// 編輯 LED 版型的時候，3D 的 LED 上顯示的「測試圖」：版型一改就重畫（停手 0.12 秒才畫，拖的時候不會卡），
// 回傳一張 canvas 和版本號（畫好了就 +1，StageScene 看到就重傳貼圖）。
// 這張圖只在編輯版型的時候用，不經過影片的顏色那一條路；沒在編輯（preview = null）時回傳 null。
import { useEffect, useRef, useState } from 'react';
import type { LedTemplatePlan, ScreenDef } from './ledTemplate';
import { patternSize } from './ledTemplatePattern';
import { paintTemplatePattern } from './ledTemplateDraw';

export interface LedPatternSource { plan: LedTemplatePlan; defs: readonly ScreenDef[] }

const DEBOUNCE_MS = 120;

export function useLedPatternCanvas(source: LedPatternSource | null): { canvas: HTMLCanvasElement | null; version: number } {
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [version, setVersion] = useState(0);
  const elRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!source) {
      elRef.current = null;
      setCanvas(null);
      return;
    }
    const timer = window.setTimeout(() => {
      try {
        const size = patternSize(source.plan.canvas);
        let el = elRef.current;
        const fresh = !el || el.width !== size.width || el.height !== size.height;
        // 大小變了就換一張新的（貼圖的大小不能原地改）
        if (!el || fresh) { el = document.createElement('canvas'); el.width = size.width; el.height = size.height; }
        paintTemplatePattern(el, source.plan, source.defs, size.scale);
        elRef.current = el;
        if (fresh) setCanvas(el);
        setVersion(v => v + 1);
      } catch (e) {
        console.warn('[ledTemplate] test pattern draw failed:', e);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [source]);

  return { canvas, version };
}
