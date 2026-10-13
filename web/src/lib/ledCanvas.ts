// AE 畫布尺寸（LED 內容的合成大小）：admin 每個專案填一次，存在 projects.led_canvas。
// 動畫師用 NDI Webcam 預覽時，瀏覽器收到的是 16:9 的虛擬攝影機畫面，要知道 AE 合成原本的寬高
// 才能把畫面放回 LED 的 UV 排版上（例：金馬 2026 = 10496 × 5120）。
// 範圍要跟 cf-worker/worker.js 的 sanitizeLedCanvas 一致。

export interface LedCanvas {
  width: number;
  height: number;
}

export const LED_CANVAS_RANGE: [number, number] = [16, 32768];

function dim(raw: unknown): number | null {
  if (typeof raw === 'string') {
    if (!/^\s*\d+\s*$/.test(raw)) return null;
  } else if (typeof raw !== 'number') {
    return null;
  }
  const n = Number(raw);
  const [min, max] = LED_CANVAS_RANGE;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** 合法 → { width, height }；空的 / 壞資料 / 超出範圍 / 不是整數 → null（= 還沒填） */
export function normalizeLedCanvas(raw: unknown): LedCanvas | null {
  let obj = raw;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return null; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const src = obj as Record<string, unknown>;
  const width = dim(src.width);
  const height = dim(src.height);
  if (width === null || height === null) return null;
  return { width, height };
}

export function sameLedCanvas(a: LedCanvas | null, b: LedCanvas | null): boolean {
  if (!a || !b) return a === b;
  return a.width === b.width && a.height === b.height;
}
