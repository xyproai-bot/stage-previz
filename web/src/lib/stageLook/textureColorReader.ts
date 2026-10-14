// 把 LED 貼圖（NDI canvas / mock canvas / 自訂圖片）縮畫到 64×32 小 canvas 讀像素，
// 同一輪取色裡同一張貼圖只畫一次。跨網域沒 CORS 的圖片會讀不到 → 回 null（燈就不跟畫面變色）。

import { averageUvRect } from './ledColorSampler';
import type { UvRect } from './ledEmitters';
import type { NdiColorLut } from '../ndiColor';

export interface LedColorSource {
  image: CanvasImageSource;
  flipY: boolean;
  /** AE 即時：現在的顏色校正曲線（燈色跟 LED 畫面一樣先校正）；null = 不套 */
  colorLut?: () => NdiColorLut | null;
}

export class TextureColorReader {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private cache = new Map<CanvasImageSource, ImageData | null>();

  constructor(private w = 64, private h = 32) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  /** 每一輪取色開始前呼叫（清掉上一輪的像素快取） */
  beginFrame() {
    this.cache.clear();
  }

  sample(source: LedColorSource, rect: UvRect): [number, number, number] | null {
    if (!this.ctx) return null;
    let data = this.cache.get(source.image);
    if (data === undefined) {
      try {
        this.ctx.clearRect(0, 0, this.w, this.h);
        this.ctx.drawImage(source.image, 0, 0, this.w, this.h);
        data = this.ctx.getImageData(0, 0, this.w, this.h);
      } catch {
        data = null;
      }
      this.cache.set(source.image, data);
    }
    if (!data) return null;
    return averageUvRect(data.data, this.w, this.h, rect, source.flipY, 8, source.colorLut?.() ?? null);
  }
}
