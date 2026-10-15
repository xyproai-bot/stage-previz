// 版型編輯器用的「整張畫布的測試圖」：排法（layout）換了才重畫一次，拖曳的時候一直用同一張。
// 排法 = null（面板關著、模型還沒載好）→ 不畫、也把舊的放掉（大畫布那張圖很吃記憶體）。
import { useEffect, useRef, useState } from 'react';
import type { LedLayout } from './ledMap';
import { releaseFullMap, renderFullMap, type FullMap } from './ledTemplateContentDraw';

export interface LedFullMapState {
  map: FullMap | null;
  /** 畫失敗的原因（畫布太大、瀏覽器沒有 2D 畫布…）；沒事 = ''  */
  error: string;
  /** 正在畫 */
  busy: boolean;
}

export function useLedFullMap(layout: LedLayout | null): LedFullMapState {
  const [state, setState] = useState<LedFullMapState>({ map: null, error: '', busy: false });
  const current = useRef<FullMap | null>(null);

  // 換掉 / 不要了 → 放掉舊的（晚一下子，確保畫面已經換成新的、不會有一幀用到放掉的）
  const retire = (old: FullMap | null) => { if (old) window.setTimeout(() => releaseFullMap(old), 300); };

  useEffect(() => {
    if (!layout) {
      retire(current.current);
      current.current = null;
      setState({ map: null, error: '', busy: false });
      return;
    }
    let cancelled = false;
    setState(s => ({ ...s, busy: true, error: '' }));
    // 讓「畫圖中」先顯示出來再開始畫（大畫布要一下子）
    const timer = window.setTimeout(() => {
      try {
        const made = renderFullMap(layout);
        if (cancelled) { releaseFullMap(made); return; }
        retire(current.current);
        current.current = made;
        setState({ map: made, error: '', busy: false });
      } catch (e) {
        console.warn('[ledTemplate] full map draw failed:', e);
        if (!cancelled) setState(s => ({ map: s.map, error: e instanceof Error ? e.message : String(e), busy: false }));
      }
    }, 30);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [layout]);

  useEffect(() => () => { retire(current.current); current.current = null; }, []);

  return state;
}
