// LED 用的影片播放器（一頁只有一個 <video>，同時是 LED 貼圖、也是小視窗裡看到的畫面）：
//   本地檔案（拖進來的，只在這台電腦播，不上傳）或網址（歌曲影片版本 / 舊的 Drive 影片）
//   isVideoFile / formatClock — 純函式
//   useLocalVideo — 管這個 <video>（object URL、播放狀態、時間、循環、靜音、分頁在背景時暫停）

import { useCallback, useEffect, useRef, useState } from 'react';

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|ogv)$/i;

export function isVideoFile(file: { name: string; type: string }): boolean {
  if (file.type) return file.type.startsWith('video/');
  return VIDEO_EXT.test(file.name);
}

export function formatClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 影片元素平常放在頁面上一個看不到的角落（不是拿掉）：
 * 瀏覽器規定 <video> 從頁面拿掉就會自己暫停 → 小視窗收起來 / 換來源時不能把它拿掉，只能搬回這裡。
 */
let parkingLot: HTMLDivElement | null = null;
export function parkVideo(video: HTMLVideoElement) {
  if (typeof document === 'undefined') return;
  if (!parkingLot || !parkingLot.isConnected) {
    parkingLot = document.createElement('div');
    parkingLot.setAttribute('aria-hidden', 'true');
    parkingLot.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1;';
    document.body.appendChild(parkingLot);
  }
  if (video.parentNode !== parkingLot) parkingLot.appendChild(video);
}

export interface LoadUrlOptions {
  /** 畫面上顯示的名字 */
  name: string;
  /** 這支是什麼（例：'v:<影片 id>'）；同一支再 load 一次不會從頭播 */
  key: string;
  /** 版本網址（帶通行證）→ 'anonymous'；舊的 Drive 直播要登入 cookie → 'use-credentials' */
  crossOrigin?: 'anonymous' | 'use-credentials';
  /** 載好了要不要自己開始播（預設要） */
  autoplay?: boolean;
}

export interface LocalVideoState {
  video: HTMLVideoElement;
  fileName: string | null;
  /** 現在載的是什麼：本地檔案 'local:<清單 id>'、網址 = LoadUrlOptions.key；沒有 = null */
  srcKey: string | null;
  /** 不經過 React 拿現在載的是什麼（換來源時要馬上知道） */
  getSrcKey: () => string | null;
  ready: boolean;
  playing: boolean;
  time: number;
  duration: number;
  loop: boolean;
  muted: boolean;
  error: string | null;
  load: (file: File, key?: string) => boolean;
  loadUrl: (url: string, opts: LoadUrlOptions) => void;
  /** 網址播到一半壞掉（通行證過期）→ 換新網址接著同一秒播 */
  replaceUrl: (url: string, opts: LoadUrlOptions) => void;
  clear: () => void;
  togglePlay: () => void;
  play: () => void;
  pause: () => void;
  seek: (t: number) => void;
  setLoop: (on: boolean) => void;
  setMuted: (on: boolean) => void;
}

export function useLocalVideo(): LocalVideoState {
  const [video] = useState(() => {
    const v = document.createElement('video');
    v.playsInline = true;
    v.loop = true;
    v.preload = 'auto';
    return v;
  });
  const urlRef = useRef<string | null>(null);
  const srcKeyRef = useRef<string | null>(null);
  const kindRef = useRef<'file' | 'url' | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [srcKey, setSrcKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loop, setLoopState] = useState(true);
  const [muted, setMutedState] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    parkVideo(video);
    const onMeta = () => {
      setDuration(video.duration || 0);
      if (!video.videoWidth) {
        setError('這個影片只有聲音、沒有畫面');
        return;
      }
      setReady(true);
    };
    const onDuration = () => setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    const onTime = () => setTime(video.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => {
      if (!video.getAttribute('src')) return;
      setReady(false);
      setPlaying(false);
      setError(kindRef.current === 'url'
        ? '影片載入失敗：可能是網路斷了，或播放網址過期了，請按「重新載入」'
        : '瀏覽器播不了這個影片：可能是編碼不支援（例如 ProRes / HAP）或解析度太大。請轉成 H.264 MP4，寬度在 8192 以內再試');
    };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('durationchange', onDuration);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('seeked', onTime);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onPause);
    video.addEventListener('error', onError);

    // 分頁在背景 → 先暫停（不解碼、不佔電腦），切回來接著播
    let resumeOnShow = false;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (!video.paused) { resumeOnShow = true; video.pause(); }
      } else if (resumeOnShow) {
        resumeOnShow = false;
        video.play().catch(() => { /* 被擋就等使用者按播放 */ });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('durationchange', onDuration);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('seeked', onTime);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onPause);
      video.removeEventListener('error', onError);
      document.removeEventListener('visibilitychange', onVisibility);
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.remove();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [video]);

  const setKey = useCallback((k: string | null) => {
    srcKeyRef.current = k;
    setSrcKey(k);
  }, []);

  const resetState = useCallback(() => {
    setError(null);
    setReady(false);
    setTime(0);
    setDuration(0); // 新影片的長度等 loadedmetadata 再填（不然壞檔會顯示上一支的長度）
  }, []);

  const revokeObjectUrl = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  const clear = useCallback(() => {
    video.pause();
    video.removeAttribute('src');
    video.load();
    revokeObjectUrl();
    kindRef.current = null;
    setKey(null);
    setFileName(null);
    setReady(false);
    setPlaying(false);
    setTime(0);
    setDuration(0);
    setError(null);
  }, [video, revokeObjectUrl, setKey]);

  const load = useCallback((file: File, key?: string) => {
    if (!isVideoFile(file)) {
      setError(`「${file.name}」不是影片檔`);
      return false;
    }
    revokeObjectUrl();
    urlRef.current = URL.createObjectURL(file);
    resetState();
    setFileName(file.name);
    kindRef.current = 'file';
    setKey(key ?? `file:${file.name}:${file.size}:${file.lastModified}`);
    video.removeAttribute('crossorigin');
    video.src = urlRef.current;
    video.play().catch(() => { /* 自動播放被擋就等使用者按播放 */ });
    return true;
  }, [video, revokeObjectUrl, resetState, setKey]);

  const loadUrl = useCallback((url: string, opts: LoadUrlOptions) => {
    if (srcKeyRef.current === opts.key && video.getAttribute('src') === url) return;
    revokeObjectUrl();  // 換掉本地檔案 → 收掉它的網址
    resetState();
    setFileName(opts.name);
    kindRef.current = 'url';
    setKey(opts.key);
    // crossOrigin 一定要在 src 之前設：LED 貼圖要讀畫面，沒有就會被瀏覽器擋
    video.crossOrigin = opts.crossOrigin ?? 'anonymous';
    video.src = url;
    if (opts.autoplay !== false) video.play().catch(() => { /* 自動播放被擋就等使用者按播放 */ });
  }, [video, revokeObjectUrl, resetState, setKey]);

  const replaceUrl = useCallback((url: string, opts: LoadUrlOptions) => {
    const at = video.currentTime;
    const wasPlaying = !video.paused;
    revokeObjectUrl();
    setError(null);
    setReady(false);
    setFileName(opts.name);
    kindRef.current = 'url';
    setKey(opts.key);
    video.crossOrigin = opts.crossOrigin ?? 'anonymous';
    video.src = url;
    video.addEventListener('loadedmetadata', () => {
      try { video.currentTime = Math.min(at, video.duration || at); } catch { /* 跳不過去就從頭 */ }
      if (wasPlaying) video.play().catch(() => {});
    }, { once: true });
  }, [video, revokeObjectUrl, setKey]);

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
  const getSrcKey = useCallback(() => srcKeyRef.current, []);

  return {
    video, fileName, srcKey, getSrcKey, ready, playing, time, duration, loop, muted, error,
    load, loadUrl, replaceUrl, clear, togglePlay, play, pause, seek, setLoop, setMuted,
  };
}
