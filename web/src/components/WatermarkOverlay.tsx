import { useEffect, useMemo, useRef, useState } from 'react';
import { useWatermarkNow, useWatermarkStore } from '../lib/watermark/store';
import { identityText, watermarkLines } from '../lib/watermark/text';
import { moveIndex, offsetPx } from '../lib/watermark/schedule';
import { buildWatermarkTile, watermarkScale, WATERMARK_BASE_FONT_PX } from '../lib/watermark/tile';
import './WatermarkOverlay.css';

interface Props {
  /** 小播放器裡用：字小一點 */
  compact?: boolean;
}

/**
 * 浮水印：疊在 3D 畫面 / 影片上面的一層（DOM，不是畫進 LED 貼圖，所以不會動到 LED 的顏色）。
 * 誰在看 + 現在的日期時間，斜的、半透明、整片貼滿；每分鐘換時間、每 45 秒慢慢換位置。
 * pointer-events: none → 不擋任何操作。頁面沒有登記要加浮水印（lib/watermark/store.ts）就什麼都不畫。
 */
export default function WatermarkOverlay({ compact = false }: Props) {
  const identity = useWatermarkStore(s => s.identity);
  const nowMs = useWatermarkNow();
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const active = identity !== null;

  // 量自己多寬，決定字多大（只在跨過門檻時才重畫）
  const scale = watermarkScale(width, compact);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [active]);

  const minute = Math.floor(nowMs / 60_000);
  const key = identity ? JSON.stringify(identity) : '';
  // 同一分鐘內字不變；identity 內容一樣就不重算
  const lines = useMemo(
    () => (identity ? watermarkLines(identity, new Date(minute * 60_000)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, minute],
  );
  const tile = useMemo(
    () => (lines ? buildWatermarkTile(lines, Math.round(WATERMARK_BASE_FONT_PX * scale * 10) / 10) : null),
    [lines, scale],
  );

  if (!identity || !tile) return null;
  const pos = offsetPx(moveIndex(nowMs), identityText(identity), tile);
  return (
    <div
      ref={ref}
      className={'wm-overlay' + (compact ? ' wm-overlay--compact' : '')}
      data-watermark="on"
      aria-hidden="true"
      style={{
        backgroundImage: `url("${tile.url}")`,
        backgroundSize: `${tile.width}px ${tile.height}px`,
        backgroundPosition: `${pos.x}px ${pos.y}px`,
      }}
    />
  );
}
