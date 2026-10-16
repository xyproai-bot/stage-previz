// LED 用的影片播放器（一頁只有一個 <video>，同時是 LED 貼圖、也是小視窗裡看到的畫面）：
//   本地檔案（拖進來的，只在這台電腦播，不上傳）或網址（歌曲影片版本 / 舊的 Drive 影片）
//   isVideoFile / formatClock — 純函式
//   useLocalVideo — 管這個 <video>（object URL、播放狀態、時間、循環、靜音、分頁在背景時暫停）
//   載入新的影片不會自己播：停在第一格，使用者按播放才開始（規則在 playbackPolicy.ts）
//   比較兩版（A/B）時多一個「後面」的 <video>（standby）：另一版先載好、跟著這一版同一個時間點播（沒聲音、看不到），
//   換版本時（replaceUrl 到那一版）直接把前後對調——不重新載入、LED 不會黑；規則在 abLedSync.ts。
//   沒有開比較的時候只有一個 <video>，跟以前完全一樣。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CANNOT_PLAY_TEXT, LOCAL_CANNOT_PLAY_TEXT } from './videoCheck';
import { recordPlayCheck, versionIdFromKey } from './versionPlayCheck';
import { playsAfterLoad } from './playbackPolicy';
import { decideSync, driftSeconds, planVersionSwitch, SYNC_INTERVAL_MS } from './abLedSync';

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
  /** 載好了要不要自己開始播。loadUrl 預設不要（停在第一格 / startAt，等使用者按播放）；replaceUrl 預設照換之前 */
  autoplay?: boolean;
  /** 載好了先跳到這一秒（打開留言：停在留言的那一格） */
  startAt?: number;
}

/** 比較兩版時，後面那一個 <video>（看不到、沒聲音，一直跟著前面播）：lib/abLedSync.ts */
export interface StandbyVideo {
  /** 後面那一版的 key；沒有 = null */
  key: string | null;
  /** 後面那一版載好了（可以馬上換） */
  ready: boolean;
  /** 載進後面（不影響現在看的）；同一版再載一次沒有作用 */
  load: (url: string, opts: LoadUrlOptions) => void;
  /** 不比了：後面的卸掉 */
  clear: () => void;
}

export interface LocalVideoState {
  /** 現在放的那個 <video>（比較時，換版本會換成另一個，所以用的地方要把它放進 effect 的依賴） */
  video: HTMLVideoElement;
  standby: StandbyVideo;
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

function createVideoElement(): HTMLVideoElement {
  const v = document.createElement('video');
  v.playsInline = true;
  v.loop = true;
  v.preload = 'auto';
  return v;
}

export function useLocalVideo(): LocalVideoState {
  // 第一個 <video>；比較兩版時才會多第二個（spare）。video = 現在放的那一個，換版本時（flipStandby）會換成另一個
  const [home] = useState(createVideoElement);
  const spareRef = useRef<HTMLVideoElement | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement>(home);
  const videoRef = useRef(video);
  videoRef.current = video;
  /** 不是 v 的那一個 <video>（沒有第二個 = null） */
  const otherOf = useCallback((v: HTMLVideoElement): HTMLVideoElement | null => (v === home ? spareRef.current : home), [home]);
  const urlRef = useRef<string | null>(null);
  const srcKeyRef = useRef<string | null>(null);
  const fileNameRef = useRef<string | null>(null);
  const kindRef = useRef<'file' | 'url' | null>(null);
  /** 分頁在背景時暫停的 → 切回來接著播；中間換了影片就不接（新的停在第一格） */
  const resumeOnShowRef = useRef(false);
  const [fileName, setFileNameState] = useState<string | null>(null);
  const [srcKey, setSrcKey] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loop, setLoopState] = useState(true);
  const [muted, setMutedState] = useState(false);
  const mutedRef = useRef(false);
  const [rate, setRateState] = useState(1);
  const rateRef = useRef(1);
  const [error, setError] = useState<string | null>(null);
  // 比較：後面那一版（key、名字）和它載好了沒
  const standbyRef = useRef<{ key: string; name: string } | null>(null);
  const [standbyKey, setStandbyKey] = useState<string | null>(null);
  const [standbyReady, setStandbyReady] = useState(false);

  const setFileName = useCallback((n: string | null) => {
    fileNameRef.current = n;
    setFileNameState(n);
  }, []);

  // 第一個 <video> 放到頁面上看不到的角落；離開頁面時全部卸掉
  useEffect(() => {
    parkVideo(home);
    return () => {
      for (const v of [home, spareRef.current]) {
        if (!v) continue;
        v.pause();
        v.removeAttribute('src');
        v.load();
        v.remove();
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [home]);

  // 現在放的這個 <video> 的事件（換版本、對調之後，換成聽新的那一個）
  useEffect(() => {
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
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (!video.paused) { resumeOnShowRef.current = true; video.pause(); }
      } else if (resumeOnShowRef.current) {
        resumeOnShowRef.current = false;
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
    };
  }, [video]);

  const setKey = useCallback((k: string | null) => {
    srcKeyRef.current = k;
    setSrcKey(k);
  }, []);

  const resetState = useCallback(() => {
    resumeOnShowRef.current = false;  // 背景時換了影片（例：交的影片好了）→ 切回來不要自己播
    setError(null);
    setReady(false);
    setTime(0);
    setDuration(0); // 新影片的長度等 loadedmetadata 再填（不然壞檔會顯示上一支的長度）
  }, []);

  const revokeObjectUrl = useCallback(() => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  // ── 比較（A/B）：後面那一版 ──

  /** 不比了：後面的卸掉（<video> 留著，下次比較再用） */
  const clearStandby = useCallback(() => {
    const meta = standbyRef.current;
    standbyRef.current = null;
    setStandbyKey(null);
    setStandbyReady(false);
    const other = meta ? otherOf(videoRef.current) : null;
    if (other) {
      other.pause();
      other.removeAttribute('src');
      other.load();
    }
  }, [otherOf]);

  const loadStandby = useCallback((url: string, opts: LoadUrlOptions) => {
    const cur = videoRef.current;
    let sb = otherOf(cur);
    if (!sb) {
      sb = createVideoElement();
      spareRef.current = sb;
      parkVideo(sb);
    }
    if (standbyRef.current?.key === opts.key && sb.getAttribute('src') === url) return;
    sb.pause();
    sb.muted = true;  // 後面那一版沒有聲音（換到前面時才照使用者的靜音設定）
    sb.loop = cur.loop;
    // crossOrigin 一定要在 src 之前設：LED 貼圖要讀畫面，沒有就會被瀏覽器擋
    sb.crossOrigin = opts.crossOrigin ?? 'anonymous';
    sb.src = url;
    sb.playbackRate = cur.playbackRate;
    standbyRef.current = { key: opts.key, name: opts.name };
    setStandbyKey(opts.key);
    setStandbyReady(false);
  }, [otherOf]);

  // 後面那一版：載好了就通知；跟著前面的時間、播放 / 暫停、速度（每 SYNC_INTERVAL_MS 檢查，前面一有動作就馬上檢查）
  useEffect(() => {
    if (!standbyKey) return;
    const master = video;
    const sb = otherOf(master);
    if (!sb) return;
    const checkReady = () => setStandbyReady(sb.readyState >= 2 && sb.videoWidth > 0);
    const onSbError = () => setStandbyReady(false);
    const tick = () => {
      if (standbyRef.current?.key !== standbyKey) return;
      const act = decideSync({
        masterTime: master.currentTime,
        masterDuration: master.duration,
        masterPaused: master.paused,
        masterRate: master.playbackRate,
        loop: master.loop,
        standbyTime: sb.currentTime,
        standbyPaused: sb.paused,
        standbyRate: sb.playbackRate,
        standbyReady: sb.readyState >= 2 && sb.videoWidth > 0,
      });
      if (act.rate !== undefined) sb.playbackRate = act.rate;
      if (act.seekTo !== undefined) { try { sb.currentTime = act.seekTo; } catch { /* 還不能跳就下次 */ } }
      if (act.pause) sb.pause();
      if (act.play) sb.play().catch(() => { /* 被擋就等下次 */ });
    };
    const onSbData = () => { checkReady(); tick(); };
    sb.addEventListener('loadeddata', onSbData);
    sb.addEventListener('canplay', onSbData);
    sb.addEventListener('error', onSbError);
    const masterEvents = ['seeked', 'play', 'pause', 'ratechange'] as const;
    masterEvents.forEach(ev => master.addEventListener(ev, tick));
    const id = window.setInterval(tick, SYNC_INTERVAL_MS);
    checkReady();
    tick();
    return () => {
      window.clearInterval(id);
      masterEvents.forEach(ev => master.removeEventListener(ev, tick));
      sb.removeEventListener('loadeddata', onSbData);
      sb.removeEventListener('canplay', onSbData);
      sb.removeEventListener('error', onSbError);
    };
  }, [standbyKey, video, otherOf]);

  /**
   * 把後面那一版換到前面（前後對調）：後面那個已經載好、時間也跟上了才行（abLedSync.planVersionSwitch）。
   * 不重新載入，所以 LED 不會黑一下；原本前面的退到後面，接著跟著新的前面播（再按一次還是馬上換）。
   * 換成功 true；不行 false（呼叫的人照原本的作法換網址）
   */
  const flipStandby = useCallback((): boolean => {
    const meta = standbyRef.current;
    const cur = videoRef.current;
    const next = meta ? otherOf(cur) : null;
    if (!meta || !next || kindRef.current !== 'url') return false;
    const plan = planVersionSwitch({
      targetKey: meta.key,
      activeKey: srcKeyRef.current,
      standbyKey: meta.key,
      standbyReady: next.readyState >= 2 && next.videoWidth > 0,
      drift: driftSeconds(cur.currentTime, next.currentTime, cur.duration, cur.loop),
    });
    if (plan !== 'instant') return false;
    const prevKey = srcKeyRef.current;
    const prevName = fileNameRef.current ?? '';
    // 聲音、循環、速度、播放狀態：新的前面照使用者的設定，退到後面的靜音
    next.muted = mutedRef.current;
    next.loop = cur.loop;
    if (next.playbackRate !== rateRef.current) next.playbackRate = rateRef.current;
    cur.muted = true;
    if (!cur.paused && next.paused) next.play().catch(() => {});
    else if (cur.paused && !next.paused) next.pause();
    resumeOnShowRef.current = false;
    videoRef.current = next;
    standbyRef.current = prevKey ? { key: prevKey, name: prevName } : null;
    setVideo(next);
    setKey(meta.key);
    setFileName(meta.name);
    setError(null);
    setReady(true);
    setTime(next.currentTime);
    setDuration(Number.isFinite(next.duration) ? next.duration : 0);
    setPlaying(!next.paused);
    setStandbyKey(prevKey);
    setStandbyReady(true);
    return true;
  }, [otherOf, setKey, setFileName]);

  const clear = useCallback(() => {
    const v = videoRef.current;
    resumeOnShowRef.current = false;
    v.pause();
    v.removeAttribute('src');
    v.load();
    revokeObjectUrl();
    kindRef.current = null;
    setKey(null);
    setFileName(null);
    setReady(false);
    setPlaying(false);
    setTime(0);
    setDuration(0);
    setError(null);
    clearStandby();
  }, [revokeObjectUrl, setKey, setFileName, clearStandby]);

  const load = useCallback((file: File, key?: string) => {
    if (!isVideoFile(file)) {
      setError(`「${file.name}」不是影片檔`);
      return false;
    }
    const v = videoRef.current;
    revokeObjectUrl();
    urlRef.current = URL.createObjectURL(file);
    resetState();
    setFileName(file.name);
    kindRef.current = 'file';
    setKey(key ?? `file:${file.name}:${file.size}:${file.lastModified}`);
    // 換檔案不會自己播：停在第一格等使用者按播放（先暫停：正在播的換 src 時瀏覽器不會通知「暫停了」）
    v.pause();
    v.removeAttribute('crossorigin');
    v.src = urlRef.current;
    clearStandby();  // 本地檔案不跟版本比較
    return true;
  }, [revokeObjectUrl, resetState, setKey, setFileName, clearStandby]);

  const loadUrl = useCallback((url: string, opts: LoadUrlOptions) => {
    const video = videoRef.current;
    if (srcKeyRef.current === opts.key && video.getAttribute('src') === url) return;
    revokeObjectUrl();  // 換掉本地檔案 → 收掉它的網址
    resetState();
    setFileName(opts.name);
    kindRef.current = 'url';
    setKey(opts.key);
    // 先暫停：正在播的換 src 時瀏覽器不會通知「暫停了」，播放鍵會一直顯示在播
    video.pause();
    // crossOrigin 一定要在 src 之前設：LED 貼圖要讀畫面，沒有就會被瀏覽器擋
    video.crossOrigin = opts.crossOrigin ?? 'anonymous';
    video.src = url;
    if (opts.startAt != null && opts.startAt > 0) {
      const at = opts.startAt;
      video.addEventListener('loadedmetadata', () => {
        try { video.currentTime = Math.min(at, video.duration || at); } catch { /* 跳不過去就從頭 */ }
      }, { once: true });
    }
    // 預設停在第一格（或 startAt 那一秒）等使用者按播放；明講要播的（點了區段留言）才播
    if (playsAfterLoad({ autoplay: opts.autoplay })) video.play().catch(() => { /* 被擋就等使用者按播放 */ });
  }, [revokeObjectUrl, resetState, setKey, setFileName]);

  const replaceUrl = useCallback((url: string, opts: LoadUrlOptions) => {
    // 比較：要換的那一版已經在後面準備好了 → 直接對調，不重新載入（同一秒、播放 / 暫停照舊）
    if (standbyRef.current?.key === opts.key && flipStandby()) {
      const now = videoRef.current;
      if (opts.startAt != null) {
        try { now.currentTime = Math.min(opts.startAt, now.duration || opts.startAt); } catch { /* 跳不過去就算了 */ }
      }
      if (opts.autoplay && now.paused) now.play().catch(() => {});
      return;
    }
    const video = videoRef.current;
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
    // 接著同一秒：播放 / 暫停照換之前（比較 A/B、有新版 · 切換、網址過期）
    const play = playsAfterLoad({ autoplay: opts.autoplay, sameSecond: true, wasPlaying });
    video.addEventListener('loadedmetadata', () => {
      try { video.currentTime = Math.min(to, video.duration || to); } catch { /* 跳不過去就從頭 */ }
      if (play) video.play().catch(() => {});
    }, { once: true });
  }, [revokeObjectUrl, setKey, setFileName, flipStandby]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }, []);
  const play = useCallback(() => { videoRef.current.play().catch(() => {}); }, []);
  const pause = useCallback(() => { resumeOnShowRef.current = false; videoRef.current.pause(); }, []);

  const seek = useCallback((t: number) => {
    if (!Number.isFinite(t)) return;
    const video = videoRef.current;
    video.currentTime = Math.max(0, Math.min(t, video.duration || t));
    setTime(video.currentTime);
  }, []);

  const setLoop = useCallback((on: boolean) => {
    videoRef.current.loop = on;
    const other = otherOf(videoRef.current);
    if (other) other.loop = on;
    setLoopState(on);
  }, [otherOf]);
  const setMuted = useCallback((on: boolean) => {
    mutedRef.current = on;
    videoRef.current.muted = on;
    setMutedState(on);
  }, []);
  const setRate = useCallback((r: number) => {
    const v = Math.max(0.25, Math.min(4, Number(r) || 1));
    rateRef.current = v;
    videoRef.current.playbackRate = v;
    setRateState(v);
  }, []);
  const getSrcKey = useCallback(() => srcKeyRef.current, []);

  const standby = useMemo<StandbyVideo>(
    () => ({ key: standbyKey, ready: standbyReady, load: loadStandby, clear: clearStandby }),
    [standbyKey, standbyReady, loadStandby, clearStandby],
  );

  return {
    video, standby, fileName, srcKey, getSrcKey, ready, playing, time, duration, loop, muted, error,
    load, loadUrl, replaceUrl, clear, togglePlay, play, pause, seek, setLoop, setMuted, rate, setRate,
  };
}
