// 本地影片（分享頁拖進來的檔案）：只在這台電腦播到 LED 上，不上傳。
//   isVideoFile / formatClock — 純函式
//   useLocalVideo — 管一個 <video>（object URL、播放狀態、時間、循環、靜音）

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

export interface LocalVideoState {
  video: HTMLVideoElement;
  fileName: string | null;
  ready: boolean;
  playing: boolean;
  time: number;
  duration: number;
  loop: boolean;
  muted: boolean;
  error: string | null;
  load: (file: File) => boolean;
  clear: () => void;
  togglePlay: () => void;
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
  const [fileName, setFileName] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loop, setLoopState] = useState(true);
  const [muted, setMutedState] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onMeta = () => {
      setDuration(video.duration || 0);
      if (!video.videoWidth) {
        setError('這個影片只有聲音、沒有畫面');
        return;
      }
      setReady(true);
    };
    const onTime = () => setTime(video.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => {
      if (!video.getAttribute('src')) return;
      setReady(false);
      setPlaying(false);
      setError('瀏覽器播不了這個影片：可能是編碼不支援（例如 ProRes / HAP）或解析度太大。請轉成 H.264 MP4，寬度在 8192 以內再試');
    };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('timeupdate', onTime);
    video.addEventListener('seeked', onTime);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onPause);
    video.addEventListener('error', onError);
    return () => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('seeked', onTime);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onPause);
      video.removeEventListener('error', onError);
      video.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [video]);

  const clear = useCallback(() => {
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setFileName(null);
    setReady(false);
    setPlaying(false);
    setTime(0);
    setDuration(0);
    setError(null);
  }, [video]);

  const load = useCallback((file: File) => {
    if (!isVideoFile(file)) {
      setError(`「${file.name}」不是影片檔`);
      return false;
    }
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = URL.createObjectURL(file);
    setError(null);
    setReady(false);
    setTime(0);
    setDuration(0); // 新影片的長度等 loadedmetadata 再填（不然壞檔會顯示上一支的長度）
    setFileName(file.name);
    video.src = urlRef.current;
    video.play().catch(() => { /* 自動播放被擋就等使用者按播放 */ });
    return true;
  }, [video]);

  const togglePlay = useCallback(() => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }, [video]);

  const seek = useCallback((t: number) => {
    if (!Number.isFinite(t)) return;
    video.currentTime = Math.max(0, Math.min(t, video.duration || t));
    setTime(video.currentTime);
  }, [video]);

  const setLoop = useCallback((on: boolean) => { video.loop = on; setLoopState(on); }, [video]);
  const setMuted = useCallback((on: boolean) => { video.muted = on; setMutedState(on); }, [video]);

  return { video, fileName, ready, playing, time, duration, loop, muted, error, load, clear, togglePlay, seek, setLoop, setMuted };
}
