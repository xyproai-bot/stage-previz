// 音樂播放器：介面跟影片播放器（localVideo.ts 的 useLocalVideo）一樣（LocalVideoState）。
//
// 這首歌沒有影片、有音樂的時候，「歌的時間」跟音樂走：把這個播放器當成影片播放器交給
// useVideoCueTimeline（videoCueSync.ts）、機關時間軸（TimelineClock）、cue 列，它們不用改內部就能吃——
// 它們只讀 video.currentTime / duration、呼叫 play / pause / seek。
//
// 底下是一個看不到的 <video>（只放聲音；跟影片播放器一樣是 HTMLVideoElement，型別才接得起來）：
//   - 一頁一個，放在頁面上看不到的角落（parkVideo：從頁面拿掉瀏覽器會自己暫停）
//   - 載入新的音樂不會自己播：停在開頭，使用者按播放才開始
//   - 不循環（影片預設循環，音樂播完就停）；分頁在背景也繼續播（聲音不吃效能，不像影片要解碼）
//   - 沒有 LED 貼圖、沒有 A/B 比較：standby 是空的

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parkVideo, type LoadUrlOptions, type LocalVideoState, type StandbyVideo } from './localVideo';
import { MUSIC_TEXT } from './songMusic';

const finite = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

function createMusicElement(): HTMLVideoElement {
  const v = document.createElement('video');
  v.playsInline = true;
  v.preload = 'auto';
  v.loop = false;
  return v;
}

const NO_STANDBY: StandbyVideo = { key: null, ready: false, load: () => {}, clear: () => {} };

export function useMusicPlayer(): LocalVideoState {
  const [video] = useState(createMusicElement);
  const srcKeyRef = useRef<string | null>(null);
  const [fileName, setFileNameState] = useState<string | null>(null);
  const [srcKey, setSrcKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loop, setLoopState] = useState(false);
  const [muted, setMutedState] = useState(false);
  const [rate, setRateState] = useState(1);
  const rateRef = useRef(1);
  const [error, setError] = useState<string | null>(null);

  const setKey = useCallback((k: string | null) => { srcKeyRef.current = k; setSrcKey(k); }, []);

  // 看不到的角落；離開頁面時卸掉
  useEffect(() => {
    parkVideo(video);
    return () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
    };
  }, [video]);

  useEffect(() => {
    const onMeta = () => {
      if (video.playbackRate !== rateRef.current) video.playbackRate = rateRef.current;  // 換來源時瀏覽器會把速度改回 1
      setDuration(finite(video.duration));
      setError(null);
      setReady(true);
    };
    const onDuration = () => setDuration(finite(video.duration));
    const onTime = () => setTime(video.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => {
      if (!video.getAttribute('src')) return;  // 自己清掉來源時的「錯誤」不算
      setReady(false);
      setPlaying(false);
      setError(MUSIC_TEXT.loadFailed);
    };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('durationchange', onDuration);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('seeked', onTime);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onPause);
    video.addEventListener('error', onError);
    return () => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('durationchange', onDuration);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('seeked', onTime);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onPause);
      video.removeEventListener('error', onError);
    };
  }, [video]);

  const reset = useCallback(() => {
    setError(null);
    setReady(false);
    setTime(0);
    setDuration(0);
  }, []);

  const clear = useCallback(() => {
    video.pause();
    video.removeAttribute('src');
    video.load();
    setKey(null);
    setFileNameState(null);
    setReady(false);
    setPlaying(false);
    setTime(0);
    setDuration(0);
    setError(null);
  }, [video, setKey]);

  const loadUrl = useCallback((url: string, opts: LoadUrlOptions) => {
    if (srcKeyRef.current === opts.key && video.getAttribute('src') === url) return;
    reset();
    setFileNameState(opts.name);
    setKey(opts.key);
    video.pause();  // 正在播的換來源時瀏覽器不會通知「暫停了」，播放鍵會一直顯示在播
    video.removeAttribute('crossorigin');  // 音樂只聽、不讀樣本，不用跨網站授權
    video.src = url;
    const at = opts.startAt != null && opts.startAt > 0 ? opts.startAt : 0;
    if (at > 0 || opts.autoplay) {
      video.addEventListener('loadedmetadata', () => {
        if (at > 0) { try { video.currentTime = Math.min(at, video.duration || at); } catch { /* 跳不過去就從頭 */ } }
        if (opts.autoplay) video.play().catch(() => { /* 被擋就等使用者按播放 */ });
      }, { once: true });
    }
  }, [video, reset, setKey]);

  /** 網址過期 / 斷線 → 換新網址，接著同一秒、播放 / 暫停照舊 */
  const replaceUrl = useCallback((url: string, opts: LoadUrlOptions) => {
    const at = video.currentTime;
    const wasPlaying = !video.paused;
    setError(null);
    setReady(false);
    setFileNameState(opts.name);
    setKey(opts.key);
    video.removeAttribute('crossorigin');
    video.src = url;
    const to = opts.startAt != null ? opts.startAt : at;
    video.addEventListener('loadedmetadata', () => {
      try { video.currentTime = Math.min(to, video.duration || to); } catch { /* 跳不過去就從頭 */ }
      if (opts.autoplay ?? wasPlaying) video.play().catch(() => {});
    }, { once: true });
  }, [video, setKey]);

  const togglePlay = useCallback(() => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }, [video]);
  const play = useCallback(() => { video.play().catch(() => {}); }, [video]);
  const pause = useCallback(() => { video.pause(); }, [video]);
  const seek = useCallback((t: number) => {
    if (!Number.isFinite(t)) return;
    video.currentTime = Math.max(0, Math.min(t, video.duration || t));
    setTime(video.currentTime);
  }, [video]);
  const setLoop = useCallback((on: boolean) => { video.loop = on; setLoopState(on); }, [video]);
  const setMuted = useCallback((on: boolean) => { video.muted = on; setMutedState(on); }, [video]);
  const setRate = useCallback((r: number) => {
    const v = Math.max(0.25, Math.min(4, Number(r) || 1));
    rateRef.current = v;
    video.playbackRate = v;
    setRateState(v);
  }, [video]);
  const getSrcKey = useCallback(() => srcKeyRef.current, []);
  /** 音樂只放網址（上傳好的檔案）；沒有「拖本地檔案進來」 */
  const load = useCallback(() => false, []);

  return useMemo(() => ({
    video, standby: NO_STANDBY, fileName, srcKey, getSrcKey, ready, playing, time, duration, loop, muted, error,
    load, loadUrl, replaceUrl, clear, togglePlay, play, pause, seek, setLoop, setMuted, rate, setRate,
  }), [video, fileName, srcKey, getSrcKey, ready, playing, time, duration, loop, muted, error,
    load, loadUrl, replaceUrl, clear, togglePlay, play, pause, seek, setLoop, setMuted, rate, setRate]);
}
