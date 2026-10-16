// 比較兩版（A/B）時，3D 畫面左上角的徽章：「LED：V2」——現在 LED 上放的是哪一版（按 C 或切換鈕會跟著換）。
// 沒在比較就不顯示。規則在 lib/abLedSync.ts（ledBadgeText）；比較本身在 lib/useAbCompare.ts。

import { ledBadgeText } from '../lib/abLedSync';
import type { MiniPlayerCompare } from './MiniPlayer';
import './LedCompareBadge.css';

export default function LedCompareBadge({ compare }: { compare: MiniPlayerCompare }) {
  const text = ledBadgeText(!!compare.value, compare.ledLabel);
  if (!text) return null;
  return (
    <div className="led-compare-badge" role="status" aria-live="polite" title="3D 舞台的 LED 現在放的是這一版；按 C 在兩版之間切換">
      {text}
    </div>
  );
}
