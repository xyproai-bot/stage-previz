// 教學頁每一步的畫面位置：圖片，或 10～20 秒的短片（第二階段換成短片，資料換 kind 就好）。
//   image：<img loading="lazy">。
//   clip：沒聲音、循環、自動播（muted loop playsInline autoPlay），第一格當封面；
//         使用者設了「減少動態」（prefers-reduced-motion: reduce）就不自動播，改成給播放鍵。
import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import Icon from './Icon';
import type { TutorialMediaItem } from '../lib/tutorial/animatorTutorialContent';

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

function Clip({ item }: { item: Extract<TutorialMediaItem, { kind: 'clip' }> }) {
  const reduced = usePrefersReducedMotion();
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  const toggle = () => {
    const v = ref.current;
    if (!v) return;
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
        autoPlay={!reduced}
        preload="metadata"
        aria-label={item.alt}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      {reduced && (
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
