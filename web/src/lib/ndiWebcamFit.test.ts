import { describe, it, expect } from 'vitest';
import { placeWebcamFrame, visibleCanvasRange } from './ndiWebcamFit';

const AE = 10496 / 5120; // 動畫師的 AE 畫面，約 2.05:1

describe('placeWebcamFrame', () => {
  it('實測：10496×5120 進 720p → 左右各被切掉 98 px（畫面像素）', () => {
    expect(placeWebcamFrame(1280, 720, AE)).toEqual({ canvasW: 1476, canvasH: 720, x: 98, y: 0, w: 1280, h: 720 });
  });
  it('1080p / 4K 同樣比例放大', () => {
    expect(placeWebcamFrame(1920, 1080, AE)).toEqual({ canvasW: 2214, canvasH: 1080, x: 147, y: 0, w: 1920, h: 1080 });
    expect(placeWebcamFrame(3840, 2160, AE)).toEqual({ canvasW: 4428, canvasH: 2160, x: 294, y: 0, w: 3840, h: 2160 });
  });
  it('畫布比 16:9 高（例 4:3）→ 上下補黑', () => {
    expect(placeWebcamFrame(1280, 720, 4 / 3)).toEqual({ canvasW: 1280, canvasH: 960, x: 0, y: 120, w: 1280, h: 720 });
  });
  it('本來就是 16:9 → 原樣', () => {
    expect(placeWebcamFrame(1920, 1080, 16 / 9)).toEqual({ canvasW: 1920, canvasH: 1080, x: 0, y: 0, w: 1920, h: 1080 });
  });
  it('數字壞掉（還沒拿到畫面）→ 原樣、不爆', () => {
    expect(placeWebcamFrame(0, 0, AE)).toEqual({ canvasW: 0, canvasH: 0, x: 0, y: 0, w: 0, h: 0 });
    expect(placeWebcamFrame(1280, 720, NaN)).toEqual({ canvasW: 1280, canvasH: 720, x: 0, y: 0, w: 1280, h: 720 });
    expect(placeWebcamFrame(1280, 720, -2)).toEqual({ canvasW: 1280, canvasH: 720, x: 0, y: 0, w: 1280, h: 720 });
  });
});

describe('visibleCanvasRange', () => {
  it('2.05:1 進 16:9 → 左右各約 6.6% 看不到，上下完整', () => {
    const r = visibleCanvasRange(1280, 720, AE);
    expect(r.u0).toBeCloseTo(0.0664, 3);
    expect(r.u1).toBeCloseTo(0.9336, 3);
    expect(r.v0).toBe(0);
    expect(r.v1).toBe(1);
  });
});
