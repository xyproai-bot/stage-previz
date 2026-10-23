// 工作站「錄成影片」：影片從頭（或從目前時間）播到尾，3D 舞台照影片時間切 cue、機關動作，
// 畫面固定畫成選的大小（不受視窗大小影響）→ canvas.captureStream + 影片聲音（WebAudio）→ MediaRecorder → 自動下載。
// 純函式（格式、檔名、範圍、進度、字幕）在 stageRecording.ts。

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { StageViewApi } from '../components/StageScene';
import type { LocalVideoState } from './localVideo';
import { downloadBlob } from './ledMapDraw';
import {
  drawCaption, pickRecordFormat, recordBitrate, recordProgress, recordRange, recordUnsupportedReason,
  type RecordFormat, type RecordProgress, type RecordRange, type RecordResolution, type RecordScope,
} from './stageRecording';

export interface RecordOptions {
  resolution: RecordResolution;
  scope: RecordScope;
  /** 要用的專案視角；null = 現在的視角 */
  view: { position: [number, number, number]; target: [number, number, number]; fov: number } | null;
  /** 疊 cue 名稱字幕 */
  caption: boolean;
  /** 下載的檔名（不含副檔名的那段由呼叫的人用 recordFileName 組，這裡給副檔名 → 回傳完整檔名） */
  fileName: (ext: 'mp4' | 'webm') => string;
}

export type RecordPhase = 'idle' | 'preparing' | 'recording' | 'saving';

export interface RecordDone {
  fileName: string;
  bytes: number;
  seconds: number;
  isMp4: boolean;
  /** 沒錄完（中途按停止 / 切到別的分頁） */
  partial: boolean;
}

export interface StageRecorder {
  phase: RecordPhase;
  /** 錄影中：播放控制、舞台都鎖住 */
  locked: boolean;
  progress: RecordProgress | null;
  /** 這個瀏覽器能不能錄；不能 = 原因 */
  unsupported: string | null;
  format: RecordFormat | null;
  error: string | null;
  lastDone: RecordDone | null;
  start: (o: RecordOptions) => Promise<void>;
  stop: () => void;
  clearDone: () => void;
}

interface AudioTap { ctx: AudioContext; src: MediaElementAudioSourceNode; speaker: GainNode }
const taps = new WeakMap<HTMLMediaElement, AudioTap>();

/** 把 <video> 的聲音接到 WebAudio（要在使用者按下去之後才做，不然 AudioContext 被擋、影片會變靜音）；已經接過就沿用 */
function audioTapFor(video: HTMLMediaElement): AudioTap | null {
  const had = taps.get(video);
  if (had) return had;
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    const src = ctx.createMediaElementSource(video);
    const speaker = ctx.createGain();
    src.connect(speaker);
    speaker.connect(ctx.destination);
    const tap = { ctx, src, speaker };
    taps.set(video, tap);
    return tap;
  } catch {
    return null;
  }
}

function envFormat(): RecordFormat | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return null;
  return pickRecordFormat(m => MediaRecorder.isTypeSupported(m));
}

function nextFrames(n: number): Promise<void> {
  return new Promise(res => {
    const step = (left: number) => (left <= 0 ? res() : requestAnimationFrame(() => step(left - 1)));
    step(n);
  });
}

function waitSeeked(video: HTMLVideoElement, target: number): Promise<void> {
  return new Promise(res => {
    if (Math.abs(video.currentTime - target) < 0.02 && !video.seeking) { res(); return; }
    const done = () => { video.removeEventListener('seeked', done); clearTimeout(t); res(); };
    const t = setTimeout(done, 4000);
    video.addEventListener('seeked', done);
    try { video.currentTime = target; } catch { done(); }
  });
}

export function useStageRecorder(opts: {
  player: LocalVideoState;
  viewApiRef: MutableRefObject<StageViewApi | null>;
  /** 現在這一秒的 cue 字幕（每一格都會問，要輕） */
  getCaption: () => string;
}): StageRecorder {
  const { player, viewApiRef } = opts;
  const playerRef = useRef(player);
  playerRef.current = player;
  const getCaptionRef = useRef(opts.getCaption);
  getCaptionRef.current = opts.getCaption;

  const [phase, setPhase] = useState<RecordPhase>('idle');
  const [progress, setProgress] = useState<RecordProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastDone, setLastDone] = useState<RecordDone | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const busyRef = useRef(false);

  const format = useMemo(envFormat, []);
  const unsupported = useMemo(() => recordUnsupportedReason({
    hasMediaRecorder: typeof MediaRecorder !== 'undefined',
    hasCaptureStream: typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function',
    format,
  }), [format]);

  const start = useCallback(async (o: RecordOptions) => {
    if (busyRef.current || unsupported || !format) return;
    const p0 = playerRef.current;
    const video = p0.video;
    const api = viewApiRef.current;
    const stageCanvas = api?.canvas() ?? null;
    if (!api || !stageCanvas || !p0.ready || !(video.duration > 0)) {
      setError('影片還沒準備好，等影片載好再錄');
      return;
    }
    busyRef.current = true;
    setError(null);
    setLastDone(null);
    setPhase('preparing');
    setProgress(null);

    const prev = {
      loop: p0.loop, muted: p0.muted, rate: p0.rate, time: video.currentTime,
      view: api.getView(),
    };
    const range: RecordRange = recordRange(o.scope, video.currentTime, video.duration);
    const { width, height } = o.resolution;

    let raf = 0;
    let recorder: MediaRecorder | null = null;
    let dest: MediaStreamAudioDestinationNode | null = null;
    const tap = audioTapFor(video);
    let finished = false;
    let partial = false;
    let lastProgressTs = 0;

    const keyBlock = (e: KeyboardEvent) => {
      if (e.key === 'F5' || e.key === 'F12' || e.ctrlKey || e.metaKey) return;  // 重新整理、開發者工具、複製等照常
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onHidden = () => { if (document.hidden) { partial = true; stopRef.current?.(); } };

    const restore = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', keyBlock, true);
      document.removeEventListener('visibilitychange', onHidden);
      try { if (dest && tap) tap.src.disconnect(dest); } catch { /* 已經斷了 */ }
      if (tap) tap.speaker.gain.value = 1;
      const a = viewApiRef.current;
      a?.setRecordSize(null);
      const p = playerRef.current;
      p.pause();
      p.setLoop(prev.loop);
      p.setMuted(prev.muted);
      p.setRate(prev.rate);
      if (o.view && prev.view) void a?.flyTo(prev.view, { durationMs: 1 });
      p.seek(prev.time);
    };

    try {
      window.addEventListener('keydown', keyBlock, true);
      document.addEventListener('visibilitychange', onHidden);

      // 1. 固定畫面大小、換視角、影片停在開頭
      p0.pause();
      p0.setLoop(false);
      p0.setRate(1);
      p0.setMuted(false);  // 錄聲音要先開聲音；原本靜音的話，喇叭那邊另外壓成 0
      if (tap) {
        await tap.ctx.resume().catch(() => {});
        tap.speaker.gain.value = prev.muted ? 0 : 1;
      }
      api.setRecordSize({ width, height });
      if (o.view) await api.flyTo({ ...o.view }, { durationMs: 1 });
      await waitSeeked(video, range.start);
      await nextFrames(4);  // 讓 3D 畫面照新大小、新視角、這一格影片畫好

      // 2. 錄影用的 2D 畫面（3D 畫面 + 字幕）→ captureStream
      const out = document.createElement('canvas');
      out.width = width;
      out.height = height;
      const ctx = out.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('沒辦法建立錄影畫面');
      const drawFrame = () => {
        ctx.drawImage(stageCanvas, 0, 0, width, height);
        if (o.caption) drawCaption(ctx, width, height, getCaptionRef.current());
      };
      drawFrame();
      const stream = out.captureStream(30);
      if (tap) {
        dest = tap.ctx.createMediaStreamDestination();
        tap.src.connect(dest);
        for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
      }

      // 3. 開錄
      const chunks: Blob[] = [];
      recorder = new MediaRecorder(stream, {
        mimeType: format.mimeType,
        videoBitsPerSecond: recordBitrate(width, height),
        ...(tap ? { audioBitsPerSecond: 192_000 } : {}),
      });
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      const stopped = new Promise<void>(res => { recorder!.onstop = () => res(); });
      recorder.onerror = () => { setError('錄影中斷了，這次沒有存下來'); partial = true; stopRef.current?.(); };

      const finish = () => {
        if (finished) return;
        finished = true;
        cancelAnimationFrame(raf);
        drawFrame();
        setPhase('saving');
        try { video.pause(); } catch { /* 無妨 */ }
        if (recorder && recorder.state !== 'inactive') recorder.stop();
      };
      stopRef.current = () => { partial = true; finish(); };  // 使用者按停止 / 切走 / 出錯：只有錄到的這一段
      video.addEventListener('ended', finish, { once: true });

      const tick = (ts: number) => {
        if (finished) return;
        drawFrame();
        const pr = recordProgress(range, video.currentTime);
        if (ts - lastProgressTs > 200) { lastProgressTs = ts; setProgress(pr); }
        if (pr.done) { finish(); return; }
        raf = requestAnimationFrame(tick);
      };

      recorder.start(1000);
      setPhase('recording');
      setProgress(recordProgress(range, range.start));
      try {
        await video.play();
      } catch {
        throw new Error('影片播不起來，沒辦法錄');
      }
      raf = requestAnimationFrame(tick);

      await stopped;
      video.removeEventListener('ended', finish);

      // 4. 存檔
      const seconds = recordProgress(range, video.currentTime).elapsed;
      const blob = new Blob(chunks, { type: format.mimeType.split(';')[0] });
      if (blob.size === 0 || seconds < 0.3) {
        setError('錄到的內容太短，沒有存檔');
      } else {
        const fileName = o.fileName(format.ext);
        downloadBlob(blob, fileName);
        setLastDone({ fileName, bytes: blob.size, seconds, isMp4: format.isMp4, partial });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '錄影失敗');
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* 無妨 */ }
    } finally {
      stopRef.current = null;
      restore();
      busyRef.current = false;
      setPhase('idle');
      setProgress(null);
    }
  }, [unsupported, format, viewApiRef]);

  const stop = useCallback(() => { stopRef.current?.(); }, []);
  const clearDone = useCallback(() => { setLastDone(null); setError(null); }, []);

  // 離開頁面：錄到一半就收掉
  useEffect(() => () => { stopRef.current?.(); }, []);

  return { phase, locked: phase !== 'idle', progress, unsupported, format, error, lastDone, start, stop, clearDone };
}
