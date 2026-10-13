// NDI Webcam（NDI Tools 內建的虛擬攝影機）畫面 → 放回 AE 整張畫布上的位置（純函式）
//
// 實測（2026-10-13，NDI Tools 6.3.2，Video 1 設 720p30，AE 送 10496×5120 的畫面）：
//   NDI Webcam 一律輸出 16:9。比 16:9 寬的畫面會「等比放大到填滿高度，左右多出來的直接切掉」，
//   不是加黑邊、也不是壓扁。10496×5120 → 1280×720 只剩中間那段，左右各少 697 px（AE 像素）。
//   LED 的 UV 是照整張 AE 畫布排的，所以收到的畫面要放回畫布中間，被切掉的兩邊補黑，
//   不然整個畫面會往外撐、每塊 LED 都對歪。
//
// 用法（每幀）：
//   const p = placeWebcamFrame(video.videoWidth, video.videoHeight, 10496 / 5120);
//   canvas.width = p.canvasW; canvas.height = p.canvasH;
//   ctx.fillRect(0, 0, p.canvasW, p.canvasH);            // 黑底
//   ctx.drawImage(video, p.x, p.y, p.w, p.h);
//   → 這張 canvas 再當 LED 貼圖（跟 NDI 小程序那條一樣用 RepeatWrapping，不能用 texture.repeat/offset，
//     因為有些 LED 的 UV 本來就超出 0~1、要靠繞回來）

export interface WebcamPlacement {
  /** 補回整張畫布後的大小（跟收到的畫面同一個像素密度） */
  canvasW: number;
  canvasH: number;
  /** 收到的畫面要畫在畫布的哪裡 */
  x: number;
  y: number;
  w: number;
  h: number;
}

function valid(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/**
 * NDI Webcam 給的畫面（frameW×frameH，已被裁成 16:9）放回寬高比 canvasAspect 的整張畫布。
 * 畫布比畫面寬 → 左右補黑；畫布比畫面高 → 上下補黑；一樣比例或數字壞掉 → 原樣。
 */
export function placeWebcamFrame(frameW: number, frameH: number, canvasAspect: number): WebcamPlacement {
  const same: WebcamPlacement = { canvasW: frameW, canvasH: frameH, x: 0, y: 0, w: frameW, h: frameH };
  if (!valid(frameW) || !valid(frameH) || !valid(canvasAspect)) return same;
  const frameAspect = frameW / frameH;
  if (canvasAspect > frameAspect) {
    const canvasW = Math.round(frameH * canvasAspect);
    if (canvasW <= frameW) return same;
    return { canvasW, canvasH: frameH, x: Math.round((canvasW - frameW) / 2), y: 0, w: frameW, h: frameH };
  }
  if (canvasAspect < frameAspect) {
    const canvasH = Math.round(frameW / canvasAspect);
    if (canvasH <= frameH) return same;
    return { canvasW: frameW, canvasH, x: 0, y: Math.round((canvasH - frameH) / 2), w: frameW, h: frameH };
  }
  return same;
}

/** 整張畫布裡真的有收到畫面的範圍（0~1）。例：u0 = 0.066 → 最左邊 6.6% 看不到 */
export function visibleCanvasRange(frameW: number, frameH: number, canvasAspect: number) {
  const p = placeWebcamFrame(frameW, frameH, canvasAspect);
  return {
    u0: p.x / p.canvasW,
    u1: (p.x + p.w) / p.canvasW,
    v0: p.y / p.canvasH,
    v1: (p.y + p.h) / p.canvasH,
  };
}
