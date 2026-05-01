import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SongComment } from '../lib/api';
import { getThumb, putThumb, thumbKey } from '../lib/thumbCache';
import './VideoTimeline.css';

const THUMB_COUNT = 24;        // 一條時間軸切 24 張縮圖（密度夠看流向 + 不爆 GPU）
const THUMB_W = 96;            // 縮圖原始寬（裝置實際渲染靠 CSS）
const THUMB_H = 54;            // 16:9
const SEEK_TIMEOUT_MS = 4000;  // 抓不到就跳過

interface Props {
  videoEl: HTMLVideoElement | null;
  duration: number;             // seconds
  currentTime: number;
  comments: SongComment[];      // 顯示為 ▲ pin
  onSeek: (time: number) => void;
  onCommentPinClick?: (c: SongComment) => void;
  onAddCommentHere?: (time: number) => void;   // 「在當前時間加留言」按鈕
  /** 用 srcKey 判斷影片切換 → 重抽縮圖（換歌、換版本時觸發） */
  srcKey: string;
}

interface Thumb {
  index: number;
  time: number;
  url: string;     // ObjectURL（jpeg blob）
}

export default function VideoTimeline({
  videoEl, duration, currentTime, comments, onSeek, onCommentPinClick, onAddCommentHere, srcKey,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  // Pin hover popover：hover ▲ 顯示留言預覽（不用點，懸停 250ms 出現）
  const [pinHover, setPinHover] = useState<{ comment: SongComment; x: number } | null>(null);
  const pinHoverTimerRef = useRef<number | null>(null);

  const [thumbs, setThumbs] = useState<Thumb[]>([]);
  const [thumbsProgress, setThumbsProgress] = useState<number>(0); // 0~1

  // 抽縮圖 — 用 hidden <canvas> + seek video，每次 seeked 後 drawImage
  // 為了不打架到主 video player，做一個 cloned <video> 抽圖
  // （主 video 的 seek 會干擾用戶播放）
  useEffect(() => {
    if (!videoEl || !duration || !srcKey) {
      setThumbs([]);
      setThumbsProgress(0);
      return;
    }

    let cancelled = false;
    const src = videoEl.currentSrc || videoEl.src;
    if (!src) return;

    const work = document.createElement('video');
    work.crossOrigin = 'anonymous';
    work.preload = 'auto';
    work.muted = true;
    work.playsInline = true;
    work.src = src;

    const canvas = document.createElement('canvas');
    canvas.width = THUMB_W;
    canvas.height = THUMB_H;
    const ctx = canvas.getContext('2d', { alpha: false });

    const collected: Thumb[] = [];

    function captureAt(idx: number): Promise<Thumb | null> {
      const t = (idx + 0.5) / THUMB_COUNT * duration;
      return new Promise(resolve => {
        let timer: number | null = null;
        const onSeeked = () => {
          if (cancelled) { cleanup(); resolve(null); return; }
          try {
            ctx?.drawImage(work, 0, 0, THUMB_W, THUMB_H);
            canvas.toBlob(blob => {
              if (cancelled || !blob) { cleanup(); resolve(null); return; }
              const url = URL.createObjectURL(blob);
              cleanup();
              resolve({ index: idx, time: t, url });
            }, 'image/jpeg', 0.6);
          } catch {
            cleanup();
            resolve(null);
          }
        };
        function cleanup() {
          work.removeEventListener('seeked', onSeeked);
          if (timer !== null) clearTimeout(timer);
        }
        work.addEventListener('seeked', onSeeked);
        timer = window.setTimeout(() => { cleanup(); resolve(null); }, SEEK_TIMEOUT_MS);
        try { work.currentTime = t; }
        catch { cleanup(); resolve(null); }
      });
    }

    (async () => {
      // 1. 先試 IndexedDB cache — 命中的可以瞬間填上來不用 seek
      const cacheHits: Thumb[] = [];
      const missingIdx: number[] = [];
      for (let i = 0; i < THUMB_COUNT; i++) {
        const key = thumbKey(srcKey, i, THUMB_COUNT, THUMB_W, THUMB_H);
        const blob = await getThumb(key);
        if (cancelled) return;
        if (blob) {
          const url = URL.createObjectURL(blob);
          const t: Thumb = { index: i, time: (i + 0.5) / THUMB_COUNT * duration, url };
          cacheHits.push(t);
          collected.push(t);
        } else {
          missingIdx.push(i);
        }
      }
      if (cacheHits.length > 0) {
        setThumbs(cacheHits.sort((a, b) => a.index - b.index));
        setThumbsProgress(cacheHits.length / THUMB_COUNT);
      }
      if (missingIdx.length === 0) {
        setThumbsProgress(1);
        return;
      }

      // 2. miss 的 → 用離屏 video seek 抽 + 寫入 cache
      await new Promise<void>(res => {
        if (work.readyState >= 1) return res();
        const onMeta = () => { work.removeEventListener('loadedmetadata', onMeta); res(); };
        work.addEventListener('loadedmetadata', onMeta);
      });
      if (cancelled) return;

      let done = cacheHits.length;
      for (const i of missingIdx) {
        if (cancelled) return;
        const t = await captureAt(i);
        if (cancelled) return;
        if (t) {
          collected.push(t);
          setThumbs(curr => [...curr, t].sort((a, b) => a.index - b.index));
          // 寫 cache（fetch blob from ObjectURL）
          fetch(t.url).then(r => r.blob()).then(blob => {
            putThumb(thumbKey(srcKey, i, THUMB_COUNT, THUMB_W, THUMB_H), blob);
          }).catch(() => { /* swallow */ });
        }
        done++;
        setThumbsProgress(done / THUMB_COUNT);
      }
    })();

    return () => {
      cancelled = true;
      try { work.removeAttribute('src'); work.load(); } catch {}
      // revoke ObjectURLs（async 收集的 + 同步 thumbs 清理）
      collected.forEach(t => { try { URL.revokeObjectURL(t.url); } catch {} });
    };
  }, [videoEl, duration, srcKey]);

  // srcKey 換了 → 重置（保留 cleanup 在上面 effect 處理 revoke）
  useEffect(() => {
    setThumbs([]);
    setThumbsProgress(0);
  }, [srcKey]);

  // ── Mouse interaction ──
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track || !duration) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  }, [duration, onSeek]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track || !duration) return;
    const rect = track.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    setHover({ x, time: ratio * duration });
  }, [duration]);

  const handleMouseLeave = useCallback(() => setHover(null), []);

  const playheadPct = duration > 0 ? (currentTime / duration) * 100 : 0;

  // 把 comments 依 time 排序、過濾無效
  const validComments = useMemo(
    () => (comments || [])
      .filter(c => c && typeof c.time === 'number' && c.time >= 0 && (!duration || c.time <= duration + 1))
      .sort((a, b) => a.time - b.time),
    [comments, duration]
  );

  return (
    <div className="video-tl">
      {/* Pins layer (above thumbs) */}
      <div className="video-tl__pins">
        {validComments.map(c => {
          const pct = duration > 0 ? (c.time / duration) * 100 : 0;
          return (
            <button
              key={c.id}
              className={'video-tl__pin video-tl__pin--' + c.role}
              style={{ left: `${pct}%` }}
              onMouseEnter={(e) => {
                if (pinHoverTimerRef.current !== null) clearTimeout(pinHoverTimerRef.current);
                const target = e.currentTarget;
                const rect = trackRef.current?.getBoundingClientRect();
                const btnRect = target.getBoundingClientRect();
                const x = rect ? (btnRect.left + btnRect.width / 2 - rect.left) : 0;
                pinHoverTimerRef.current = window.setTimeout(() => setPinHover({ comment: c, x }), 250);
              }}
              onMouseLeave={() => {
                if (pinHoverTimerRef.current !== null) {
                  clearTimeout(pinHoverTimerRef.current);
                  pinHoverTimerRef.current = null;
                }
                // 延遲關閉，讓 mouse 移到 popover 上不會立刻消失
                window.setTimeout(() => setPinHover(curr => curr?.comment.id === c.id ? null : curr), 200);
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (onCommentPinClick) onCommentPinClick(c);
                else onSeek(c.time);
              }}
            >
              ▲
            </button>
          );
        })}
        {pinHover && (
          <div
            className={'video-tl__pin-popover video-tl__pin-popover--' + pinHover.comment.role}
            style={{ left: pinHover.x }}
            onMouseEnter={() => {
              if (pinHoverTimerRef.current !== null) clearTimeout(pinHoverTimerRef.current);
            }}
            onMouseLeave={() => setPinHover(null)}
          >
            <div className="video-tl__pin-popover-head">
              <strong>{pinHover.comment.author}</strong>
              <span className="muted small">{roleLabel(pinHover.comment.role)}</span>
              <span className="grow" />
              <span className="video-tl__pin-popover-time">📍 {formatTime(pinHover.comment.time)}</span>
            </div>
            <div className="video-tl__pin-popover-text">{pinHover.comment.text}</div>
          </div>
        )}
      </div>

      {/* Thumb track */}
      <div
        ref={trackRef}
        className="video-tl__track"
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {/* 縮圖 — 漸進填充，先給 N 個 placeholder */}
        {Array.from({ length: THUMB_COUNT }).map((_, i) => {
          const thumb = thumbs.find(t => t.index === i);
          return (
            <div
              key={i}
              className={'video-tl__thumb' + (thumb ? ' video-tl__thumb--ready' : '')}
              style={thumb ? { backgroundImage: `url(${thumb.url})` } : undefined}
            />
          );
        })}

        {/* Playhead */}
        <div
          className="video-tl__playhead"
          style={{ left: `${playheadPct}%` }}
        />

        {/* Hover line + tooltip */}
        {hover && (
          <>
            <div className="video-tl__hover-line" style={{ left: hover.x }} />
            <div className="video-tl__hover-time" style={{ left: hover.x }}>
              {formatTime(hover.time)}
            </div>
          </>
        )}
      </div>

      {/* Bottom row: time + actions */}
      <div className="video-tl__row">
        <span className="video-tl__time">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
        {thumbsProgress < 1 && (
          <span className="video-tl__progress">
            縮圖 {Math.round(thumbsProgress * 100)}%
          </span>
        )}
        <span className="grow" />
        {onAddCommentHere && (
          <button
            className="video-tl__add"
            onClick={() => onAddCommentHere(currentTime)}
            title="在當前時間加留言（會 pin 在時間軸上）"
          >
            💬 在 {formatTime(currentTime)} 加留言
          </button>
        )}
      </div>
    </div>
  );
}

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return '00:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function roleLabel(r: SongComment['role']): string {
  if (r === 'animator') return '動畫師';
  if (r === 'director') return '導演';
  return '製作';
}
