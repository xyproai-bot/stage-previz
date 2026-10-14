// 從 LED 貼圖像素算出某塊發光面（UV 範圍）的平均顏色 → 拿去當那盞燈的顏色。
// 平均要在「線性」空間做，不然暗的顏色權重會不對。

import type { UvRect } from './ledEmitters';
import type { NdiColorLut } from '../ndiColor';

const LUT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LUT[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function srgb8ToLinear(v: number): number {
  return LUT[v] ?? 0;
}

/**
 * pixels：RGBA、第 0 排在最上面（canvas getImageData 的排法）
 * flipY：貼圖的 flipY（NDI live 是 false → v=0 在上面；一般圖片 true → v=0 在下面）
 * colorLut：AE 即時的顏色校正（跟 LED 畫面一樣先套曲線再平均；沒有 = 不套）
 */
export function averageUvRect(
  pixels: ArrayLike<number>, w: number, h: number,
  rect: UvRect, flipY: boolean, samples = 8, colorLut: NdiColorLut | null = null,
): [number, number, number] {
  if (w <= 0 || h <= 0) return [0, 0, 0];
  let r = 0, g = 0, b = 0, n = 0;
  for (let j = 0; j < samples; j++) {
    const v = rect.v0 + ((j + 0.5) / samples) * (rect.v1 - rect.v0);
    const fv = v - Math.floor(v);
    const ty = flipY ? 1 - fv : fv;
    const y = Math.min(h - 1, Math.max(0, Math.floor(ty * h)));
    for (let i = 0; i < samples; i++) {
      const u = rect.u0 + ((i + 0.5) / samples) * (rect.u1 - rect.u0);
      const fu = u - Math.floor(u);
      const x = Math.min(w - 1, Math.max(0, Math.floor(fu * w)));
      const o = (y * w + x) * 4;
      if (colorLut) {
        r += LUT[colorLut.r[pixels[o]]];
        g += LUT[colorLut.g[pixels[o + 1]]];
        b += LUT[colorLut.b[pixels[o + 2]]];
      } else {
        r += LUT[pixels[o]];
        g += LUT[pixels[o + 1]];
        b += LUT[pixels[o + 2]];
      }
      n++;
    }
  }
  return [r / n, g / n, b / n];
}
