// LED 用的影片播放器（一頁只有一個 <video>，同時是 LED 貼圖、也是小視窗裡看到的畫面）：
//   本地檔案（拖進來的，只在這台電腦播，不上傳）或網址（歌曲影片版本 / 舊的 Drive 影片）
//   isVideoFile / formatClock — 純函式
//   useLocalVideo — 管這個 <video>（object URL、播放狀態、時間、循環、靜音、分頁在背景時暫停）

import { useCallback, useEffect, useRef, useState } from 'react';
import { CANNOT_PLAY_TEXT, LOCAL_CANNOT_PLAY_TEXT } from './videoCheck';
import { recordPlayCheck, versionIdFromKey } from './versionPlayCheck';

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
  /** 載好了先跳到這一秒（打開留言：停在留言的那一格） */
  startAt?: number;
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
  /** 播放速度（0.5 / 1 / 2…）；換影片照舊 */
  rate: number;
  setRate: (r: number) => void;
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
  const [rate, setRateState] = useState(1);
  const rateRef = useRef(1);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    parkVideo(video);
    // 播的是影片版本（'v:<id>'）→ 記下這台電腦播不播得了（貼連結的版本沒辦法先檢查，版本列上會寫出來）
    const versionId = () => (kindRef.current === 'url' ? versionIdFromKey(srcKeyRef.current) : null);
    const onMeta = () => {
      // 換來源時瀏覽器會把速度改回 1 → 照使用者選的
      if (video.playbackRate !== rateRef.current) video.playbackRate = rateRef.current;
      setDuration(video.duration || 0);
      if (!video.videoWidth) {
        // ProRes 的 .mov 在 Chrome 常常只讀得到聲音
        setError(kindRef.current === 'url' ? CANNOT_PLAY_TEXT : LOCAL_CANNOT_PLAY_TEXT);
        const id = versionId();
        if (id) recordPlayCheck(id, { status: 'cannotPlay', reason: 'noVideo', at: Date.now() });
        return;
      }
      setReady(true);
    };
    const onData = () => {
      const id = versionId();
      if (!id || !video.videoWidth || !video.videoHeight) return;
      recordPlayCheck(id, {
        status: 'ok', width: video.videoWidth, height: video.videoHeight,
        durationSec: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null, at: Date.now(),
      });
    };
    const onDuration = () => setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    const onTime = () => setTime(video.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    let reachCheck: AbortController | null = null;
    const onError = () => {
      const src = video.getAttribute('src');
      if (!src) return;
      setReady(false);
      setPlaying(false);
      if (kindRef.current !== 'url') { setError(LOCAL_CANNOT_PLAY_TEXT); return; }
      setError('影片載入失敗：可能是網路斷了，或播放網址過期了，請按「重新載入」');
      // 網址拿得到檔案（不是過期、不是斷網）→ 是瀏覽器解不開這個影片
      reachCheck?.abort();
      const ctrl = new AbortController();
      reachCheck = ctrl;
      const key = srcKeyRef.current;
      fetch(src, { signal: ctrl.signal, credentials: video.crossOrigin === 'use-credentials' ? 'include' : 'omit' })
        .then((resp) => {
          ctrl.abort();  // 只要看回應，不用下載整支
          if (!resp.ok || video.getAttribute('src') !== src || srcKeyRef.current !== key) return;
          setError(CANNOT_PLAY_TEXT);
          const id = versionIdFromKey(key);
          if (id) recordPlayCheck(id, { status: 'cannotPlay', reason: 'decode', at: Date.now() });
        })
        .catch(() => { /* 真的是網路 / 過期 → 照原本的說明 */ });
    };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('loadeddata', onData);
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
      video.removeEventListener('loadeddata', onData);
      reachCheck?.abort();
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
    if (opts.startAt != null && opts.startAt > 0) {
      const at = opts.startAt;
      video.addEventListener('loadedmetadata', () => {
        try { video.currentTime = Math.min(at, video.duration || at); } catch { /* 跳不過去就從頭 */ }
      }, { once: true });
    }
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
    const to = opts.startAt != null ? opts.startAt : at;
    const play = opts.autoplay ?? wasPlaying;
    video.addEventListener('loadedmetadata', () => {
      try { video.currentTime = Math.min(to, video.duration || to); } catch { /* 跳不過去就從頭 */ }
      if (play) video.play().catch(() => {});
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
  const setRate = useCallback((r: number) => {
    const v = Math.max(0.25, Math.min(4, Number(r) || 1));
    rateRef.current = v;
    video.playbackRate = v;
    setRateState(v);
  }, [video]);
  const getSrcKey = useCallback(() => srcKeyRef.current, []);

  return {
    video, fileName, srcKey, getSrcKey, ready, playing, time, duration, loop, muted, error,
    load, loadUrl, replaceUrl, clear, togglePlay, play, pause, seek, setLoop, setMuted, rate, setRate,
  };
}
