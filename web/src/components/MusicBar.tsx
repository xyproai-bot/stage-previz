// 音樂播放列：沒有影片、有音樂的歌，在 3D 畫面下面放一條。播放 / 暫停、時間（取到 0.1 秒）、可以拖、聲音。
//   編輯頁（製作）多一顆「設在現在這一秒」（把選中的 cue 的對應影片時間設成音樂現在的時間）和「停止」；導演頁沒有這兩顆。
//   播放器是 useMusicPlayer（介面跟影片播放器一樣）：播放頭、3D、cue 列都跟著它的時間走，這裡只管畫面。
//   時間和拖曳條每幀直接改 DOM（不經過 React，才跟得上 0.1 秒）。
import { useEffect, useRef } from 'react';
import { Clock, Pause, Play, RefreshCw, Square, Volume2, VolumeX } from 'lucide-react';
import Icon from './Icon';
import './MusicBar.css';
import type { LocalVideoState } from '../lib/localVideo';
import { MUSIC_TEXT, formatMusicClock, formatMusicDuration } from '../lib/songMusic';

export interface MusicBarSetNow {
  /** 選中的 cue 叫什麼；沒選 cue = null（按鈕按不下去） */
  cueLabel: string | null;
  busy: boolean;
  onClick: () => void;
}

interface Props {
  player: LocalVideoState;
  /** 檔名 */
  label: string;
  /** 停止：暫停並回到開頭（機關回到目前選的 cue）；不給 = 沒有這顆 */
  onStop?: () => void;
  /** 設在現在這一秒（編輯頁才給） */
  setNow?: MusicBarSetNow | null;
  /** 載入失敗（播放網址過期）→ 重新載入 */
  onReload?: () => void;
  /** 拿播放網址失敗的說明（player 還沒有來源時顯示） */
  loadError?: string | null;
}

export default function MusicBar({ player, label, onStop, setNow, onReload, loadError }: Props) {
  const { video } = player;
  const timeRef = useRef<HTMLSpanElement>(null);
  const seekRef = useRef<HTMLInputElement>(null);
  const dragging = useRef(false);

  // 時間字和拖曳條：每幀讀音樂現在幾秒，只改 DOM
  useEffect(() => {
    let raf = 0;
    let lastText = '';
    const step = () => {
      const t = video.currentTime;
      const text = formatMusicClock(t);
      if (timeRef.current && text !== lastText) { timeRef.current.textContent = text; lastText = text; }
      const seek = seekRef.current;
      if (seek && !dragging.current) {
        seek.value = String(t);
        const d = Number(seek.max) || 0;
        seek.style.setProperty('--music-pos', d > 0 ? `${Math.min(100, (t / d) * 100)}%` : '0%');
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [video]);

  const duration = player.duration;
  const disabled = !player.ready;
  const total = formatMusicDuration(duration);
  const err = player.error ?? loadError ?? null;

  return (
    <div className="music-bar" role="group" aria-label="音樂播放列">
      <button
        type="button"
        className="music-bar__btn music-bar__play"
        onClick={player.togglePlay}
        disabled={disabled}
        title={player.playing ? MUSIC_TEXT.pauseTitle : MUSIC_TEXT.playTitle}
        aria-label={player.playing ? '暫停' : '播放'}
      ><Icon icon={player.playing ? Pause : Play} size="md" /></button>
      {onStop && (
        <button type="button" className="music-bar__btn" onClick={onStop} disabled={disabled} title={MUSIC_TEXT.stopTitle} aria-label="停止"><Icon icon={Square} size="md" /></button>
      )}
      <span className="music-bar__time" aria-label="音樂時間">
        <span ref={timeRef}>0:00.0</span>
        {total && <span className="music-bar__total"> / {total}</span>}
      </span>
      <input
        ref={seekRef}
        className="music-bar__seek"
        type="range"
        min={0}
        max={duration > 0 ? duration : 0}
        step={0.05}
        defaultValue={0}
        disabled={disabled || duration <= 0}
        aria-label="音樂播放位置"
        onPointerDown={() => { dragging.current = true; }}
        onPointerUp={() => { dragging.current = false; }}
        onPointerCancel={() => { dragging.current = false; }}
        onBlur={() => { dragging.current = false; }}
        onInput={(e) => {
          const t = Number(e.currentTarget.value);
          const d = Number(e.currentTarget.max) || 0;
          e.currentTarget.style.setProperty('--music-pos', d > 0 ? `${(t / d) * 100}%` : '0%');
          player.seek(t);
        }}
      />
      <button
        type="button"
        className="music-bar__btn"
        onClick={() => player.setMuted(!player.muted)}
        title={player.muted ? MUSIC_TEXT.unmuteTitle : MUSIC_TEXT.muteTitle}
        aria-label={player.muted ? '打開聲音' : '關掉聲音'}
        aria-pressed={player.muted}
      ><Icon icon={player.muted ? VolumeX : Volume2} size="md" /></button>
      <span className="music-bar__name" title={label}>{label}</span>
      {setNow && (
        <span className="music-bar__setnow">
          <button
            type="button"
            className="btn btn--sm btn--primary music-bar__setnow-btn"
            onClick={setNow.onClick}
            disabled={disabled || setNow.busy || !setNow.cueLabel}
            title={setNow.cueLabel ? MUSIC_TEXT.setNowHint : MUSIC_TEXT.setNowNoCue}
          ><Icon icon={Clock} /> {MUSIC_TEXT.setNow}</button>
          <span className="music-bar__cue muted small" title={setNow.cueLabel ?? undefined}>{setNow.cueLabel ? `→ ${setNow.cueLabel}` : MUSIC_TEXT.setNowNoCue}</span>
        </span>
      )}
      {err && (
        <span className="music-bar__error field-error small" role="alert">
          {err}
          {onReload && <button type="button" className="link-btn" onClick={onReload}><Icon icon={RefreshCw} size="xs" /> {MUSIC_TEXT.reload}</button>}
        </span>
      )}
    </div>
  );
}
