// 專案的 LED 版型清單（讀一次，改了呼叫 reload）。舊的後台沒有這個功能 → list = null（畫面不顯示版型的東西）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { listLedTemplates, type LedTemplateList } from './ledTemplateApi';

export function useLedTemplates(projectId: string | undefined) {
  const [list, setList] = useState<LedTemplateList | null>(null);
  const [loaded, setLoaded] = useState(false);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!projectId) { setList(null); setLoaded(true); return null; }
    const mine = ++seq.current;
    try {
      const next = await listLedTemplates(projectId);
      if (mine === seq.current) { setList(next); setLoaded(true); }
      return next;
    } catch {
      // 讀不到（沒網路、沒權限）：當作沒有版型，不擋其他功能
      if (mine === seq.current) { setList(null); setLoaded(true); }
      return null;
    }
  }, [projectId]);
  useEffect(() => { void reload(); }, [reload]);
  return { list, loaded, reload };
}
