// 教學頁每一步的畫面位置：圖片，或 10～20 秒的短片。
//   image：<img loading="lazy">。
//   clip：沒有聲音、循環；一頁有十幾支，所以不能一打開就全部下載、全部播放：
//         - 還沒捲到的時候 preload="none"，只顯示封面（一支短片都還沒下載）；
//         - 捲到有一半進畫面才開始載、開始播，捲走就暫停（IntersectionObserver）；
//         - 使用者設了「減少動態」（prefers-reduced-motion: reduce）、或瀏覽器沒有 IntersectionObserver：
//           不自動播，只顯示封面和播放鍵，按了才播。
import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import Icon from './Icon';
import type { TutorialMediaItem } from '../lib/tutorial/animatorTutorialContent';

/** 短片有多少比例進畫面才開始播 */
export const CLIP_PLAY_RATIO = 0.5;

/** 自動播（捲到才播）還是手動（封面 + 播放鍵） */
export function clipAutoplayMode(o: { reducedMotion: boolean; hasObserver: boolean }): 'visible' | 'manual' {
  return !o.reducedMotion && o.hasObserver ? 'visible' : 'manual';
}

interface EntryLike { isIntersecting: boolean; intersectionRatio: number }
interface ObserverLike { observe(el: Element): void; disconnect(): void }
type ObserverCtor = new (cb: (entries: EntryLike[]) => void, opts: { threshold: number[] }) => ObserverLike;
type PlayerLike = Pick<HTMLVideoElement, 'pause'> & { play(): Promise<void> | void };

/**
 * 看著這支短片有沒有進畫面：一半進來就播（onStart 讓畫面把 preload 改成要載），掉到一半以下就暫停。
 * 回傳關掉的函式。
 */
export function watchClipVisibility(video: PlayerLike, target: Element, Observer: ObserverCtor, onStart?: () => void): () => void {
  const io = new Observer((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && e.intersectionRatio >= CLIP_PLAY_RATIO) {
        onStart?.();
        const p = video.play();
        // 瀏覽器不讓播（省電模式…）就算了，不要跳錯誤
        if (p && typeof p.catch === 'function') p.catch(() => { /* 不讓播就維持封面 */ });
      } else {
        video.pause();
      }
    }
  }, { threshold: [0, CLIP_PLAY_RATIO] });
  io.observe(target);
  return () => io.disconnect();
}

/** 使用者有沒有設「減少動態」；伺服器端 / 舊瀏覽器 = false */
function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/** 瀏覽器有沒有 IntersectionObserver（伺服器端 / 舊瀏覽器 = false，這時候顯示封面和播放鍵） */
function hasIntersectionObserver(): boolean {
  return typeof window !== 'undefined' && typeof (window as { IntersectionObserver?: unknown }).IntersectionObserver === 'function';
}

function Clip({ item }: { item: Extract<TutorialMediaItem, { kind: 'clip' }> }) {
  const reduced = usePrefersReducedMotion();
  const [observer] = useState(hasIntersectionObserver);
  const mode = clipAutoplayMode({ reducedMotion: reduced, hasObserver: observer });
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  // 進過畫面（或按過播放鍵）就可以開始載
  const [wanted, setWanted] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (mode !== 'visible' || !v) return;
    return watchClipVisibility(v, v, (window as unknown as { IntersectionObserver: ObserverCtor }).IntersectionObserver, () => setWanted(true));
  }, [mode]);

  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    setWanted(true);
    if (v.paused) { void v.play().catch(() => { /* 瀏覽器不讓播就算了 */ }); } else { v.pause(); }
  };

  return (
    <figure className="tut-media tut-media--clip">
      <video
        ref={ref}
        src={item.src}
        poster={item.poster}
        width={item.width}
        height={item.height}
        muted
        loop
        playsInline
        preload={wanted ? 'auto' : 'none'}
        aria-label={item.alt}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      {mode === 'manual' && (
        <button type="button" className="tut-media__play" onClick={toggle} aria-label={playing ? '暫停這段短片' : '播放這段短片'}>
          <Icon icon={playing ? Pause : Play} size="md" />
        </button>
      )}
    </figure>
  );
}

export default function TutorialMedia({ item }: { item: TutorialMediaItem }) {
  if (item.kind === 'clip') return <Clip item={item} />;
  return (
    <figure className="tut-media">
      <img src={item.src} alt={item.alt} width={item.width} height={item.height} loading="lazy" decoding="async" />
    </figure>
  );
}
