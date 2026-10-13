// 小播放器的「比較」（A/B）——導演頁、動畫師工作站共用同一套：
// 選第二個版本，按「切到 V2」（或按 C）在兩版之間切，停在同一秒、播放 / 暫停照舊。
// 只有一個 <video>：換網址再跳到同一秒（localVideo.replaceUrl），不會同時放兩支 → 電腦負擔跟只看一版一樣。
// 規則（純函式）在 abCompare.ts；這裡是把它接到版本清單、播放器、鍵盤 C 上。
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  compareOptions, defaultCompareKey, flipTarget, isCompareShortcut, otherKey, startCompare, syncPair, type AbPair,
} from './abCompare';
import type { LoadUrlOptions } from './localVideo';
import type { MiniPlayerCompare } from '../components/MiniPlayer';

interface CompareItem { key: string; label: string; url: string | null; crossOrigin?: LoadUrlOptions['crossOrigin'] }

export interface UseAbCompareOptions {
  /** 換歌（或換專案）→ 不比了 */
  resetKey: string | null;
  /** 這首歌的版本（V3、V2、V1…新的在前） */
  items: readonly CompareItem[];
  /** 正在看的那一版；沒有在看版本（例：工作站切到 AE 即時）= null */
  currentKey: string | null;
  /** 記住選了哪一版（工作站還會順便把 LED 切到「影片」） */
  select: (key: string) => void;
  player: { replaceUrl: (url: string, opts: LoadUrlOptions) => void };
  /** false = 現在不能比（C 不作用）；預設 true */
  enabled?: boolean;
}

export function useAbCompare({ resetKey, items, currentKey, select, player, enabled = true }: UseAbCompareOptions): MiniPlayerCompare {
  const [pair, setPair] = useState<AbPair | null>(null);
  const itemKeys = useMemo(() => items.filter(it => it.url).map(it => it.key), [items]);

  // 換歌 → 不比了；版本清單變了 / 自己點了別版 → 照 syncPair 決定留不留
  useEffect(() => { setPair(null); }, [resetKey]);
  useEffect(() => {
    setPair(p => { const next = syncPair(p, currentKey, itemKeys); return next === p ? p : next; });
  }, [currentKey, itemKeys]);

  const { replaceUrl } = player;
  const switchToVersion = useCallback((key: string) => {
    const it = items.find(x => x.key === key);
    if (!it?.url) return;
    // 先換網址（停在同一秒、播放 / 暫停照舊），再記住選了哪一版（頁面載入影片的 effect 看到同一個 key 就不會從頭載）
    replaceUrl(it.url, { key: it.key, name: it.label, crossOrigin: it.crossOrigin });
    select(it.key);
  }, [items, replaceUrl, select]);

  // 切到另一版；還沒選比較的版本 → 先跟上一版比、直接切過去（按 C、收起來時的「比較」按鈕）
  const onFlip = useCallback(() => {
    if (pair) { switchToVersion(flipTarget(pair, currentKey)); return; }
    const other = defaultCompareKey(items, currentKey);
    if (!other || !currentKey) return;
    setPair(startCompare(currentKey, other));
    switchToVersion(other);
  }, [pair, currentKey, items, switchToVersion]);

  const onPick = useCallback((key: string | null) => {
    setPair(key ? startCompare(currentKey, key) : null);
  }, [currentKey]);

  const options = useMemo(() => compareOptions(items, currentKey), [items, currentKey]);

  // 鍵盤 C（在打字、按著 Ctrl / Cmd / Alt 時不算）
  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      if (!isCompareShortcut(e)) return;
      if (options.length === 0) return;
      e.preventDefault();
      onFlip();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, options, onFlip]);

  return {
    options,
    value: pair ? otherKey(pair, currentKey) : null,
    onPick,
    onFlip,
  };
}
