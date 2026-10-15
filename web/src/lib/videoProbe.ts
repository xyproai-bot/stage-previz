// 交影片前，在這台電腦先試播（不上傳）：隱藏的 <video> 讀本地檔案 → 等第一格出來 → 往後跳一點 → 看有沒有畫面。
// 順便讀 MP4 / MOV 裡寫的影像編碼（ProRes / HAP / H.264…），說明可以講得清楚一點。
// 怎麼判斷、話怎麼說在 videoCheck.ts（純函式）。

import {
  assessVideo, codecFromFourcc, readBoxHeader, videoFourccFromBoxes,
  type CodecInfo, type ProbeResult, type VideoCheck,
} from './videoCheck';
import type { CanvasSize } from './ledMap';

/** 等多久都沒有畫面就當作播不了 */
export const PROBE_TIMEOUT_MS = 15000;
/** moov 太大（很長的影片）就不讀了，只靠試播 */
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

/** 試播：等第一格 → 往後跳一點（最多 1 秒）→ 有長寬、有畫面才算可以 */
export function probeVideoFile(file: Blob, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    return Promise.resolve({ ok: false, reason: 'decode' });
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement('video');
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    let done = false;
    const finish = (r: ProbeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // 先停掉這個暫時的播放器再收網址（不然它還會去讀已經收掉的網址）
      el.removeAttribute('src');
      el.load();
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
    const duration = () => (Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    const check = () => {
      if (el.videoWidth > 0 && el.videoHeight > 0 && el.readyState >= 2) {
        finish({ ok: true, width: el.videoWidth, height: el.videoHeight, durationSec: duration() });
      } else {
        finish({ ok: false, reason: 'noVideo' });
      }
    };
    el.addEventListener('error', () => finish({ ok: false, reason: 'decode' }));
    // ProRes 的 .mov 在 Chrome 常常只讀得到聲音：長寬是 0
    el.addEventListener('loadedmetadata', () => {
      if (!el.videoWidth || !el.videoHeight) finish({ ok: false, reason: 'noVideo' });
    });
    el.addEventListener('loadeddata', () => {
      const d = duration();
      const to = d ? Math.min(1, d * 0.1) : 0;
      if (to <= 0) { check(); return; }
      el.addEventListener('seeked', check, { once: true });
      try { el.currentTime = to; } catch { check(); }
    }, { once: true });
    el.src = url;
  });
}

async function readBytes(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** MP4 / MOV 裡寫的影像編碼；不是 MP4 / MOV、讀不到 → null（不影響上傳） */
export async function sniffVideoCodec(file: Blob): Promise<CodecInfo | null> {
  try {
    let offset = 0;
    for (let i = 0; i < 64 && offset + 8 <= file.size; i++) {
      const head = readBoxHeader(await readBytes(file, offset, Math.min(file.size, offset + 16)));
      if (!head) return null;
      // 第一個 box 不像 MP4 / MOV（例：WebM）→ 不讀了
      if (i === 0 && !/^[\x20-\x7e]{4}$/.test(head.type)) return null;
      const size = head.size === 0 ? file.size - offset : head.size;
      if (size < head.header) return null;
      if (head.type === 'moov') {
        if (size > MAX_MOOV_BYTES) return null;
        const fourcc = videoFourccFromBoxes(await readBytes(file, offset, offset + size));
        return fourcc ? codecFromFourcc(fourcc) : null;
      }
      offset += size;
    }
  } catch { /* 讀不到就算了 */ }
  return null;
}

/** 選好檔案 → 試播 + 讀編碼 → 要不要擋、要提醒什麼 */
export async function checkVideoFile(
  file: File, ledCanvas: CanvasSize | null | undefined, timeoutMs = PROBE_TIMEOUT_MS,
  template: { name: string; canvas: CanvasSize } | null = null,
): Promise<{ check: VideoCheck; probe: ProbeResult; codec: CodecInfo | null }> {
  const [probe, codec] = await Promise.all([probeVideoFile(file, timeoutMs), sniffVideoCodec(file)]);
  return { check: assessVideo({ probe, sizeBytes: file.size, ledCanvas, codec, template }), probe, codec };
}
