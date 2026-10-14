// 「校正 AE 即時顏色」要一張收到的畫面：3D 舞台有在收的話直接拿那張（AE 停住也有最後一格）；
// 設定頁沒有在收 → 自己連一次小程序，等下一張畫面（AE 要在播放 / 畫面有變化才會送）。

import { NdiClient } from './ndiClient';
import { parseHello, type NdiColorPipeline } from './ndiSteps';
import type { RgbaFrame } from './ndiCalibration';

/** canvas / ImageBitmap → RGBA（解好的 JPEG，還沒進 3D） */
export function readPixels(source: CanvasImageSource & { width: number; height: number }): RgbaFrame | null {
  const w = source.width, h = source.height;
  if (!w || !h) return null;
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    return { data: img.data, width: w, height: h };
  } catch {
    return null;
  }
}

export interface GrabbedFrame {
  frame: RgbaFrame;
  colorPipeline: NdiColorPipeline | null;
}

/** 連小程序拿一張畫面；timeoutMs 內沒有 → reject（訊息是中文，可以直接顯示） */
export function grabNdiFrame(url: string | undefined, timeoutMs = 6000): Promise<GrabbedFrame> {
  return new Promise((resolve, reject) => {
    let pipeline: NdiColorPipeline | null = null;
    let done = false;
    let connected = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      client.destroy();
      fn();
    };
    const client = new NdiClient({
      url,
      reconnectIntervalMs: 0,
      onMessage: (m) => {
        if (m.type === 'hello') {
          connected = true;
          pipeline = parseHello(m).colorPipeline;
        }
      },
      onStatus: (s) => {
        if (s.kind === 'disconnected') finish(() => reject(new Error(connected ? '跟小程序的連線斷了' : '連不到 NDI 小程序（有開著嗎？）')));
      },
      onFrame: (bitmap) => {
        const frame = readPixels(bitmap);
        bitmap.close?.();
        if (frame) finish(() => resolve({ frame, colorPipeline: pipeline }));
      },
    });
    const timer = window.setTimeout(() => {
      finish(() => reject(new Error(connected
        ? '沒收到 AE 的畫面：請在 AE 按空白鍵播放（畫面有變化才會送）'
        : '連不到 NDI 小程序（有開著嗎？）')));
    }, timeoutMs);
    client.connect();
  });
}
