// web/src/lib/tutorial/tourPlacement.ts
// 帶著做的說明框擺哪裡（純函式，好測）。畫面：components/TourOverlay.tsx。
//   視窗寬 < 640 → 貼在畫面底部（sheet）；沒有目標 → 放中間；
//   有目標 → 下面放得下就下面，不然上面，不然右邊、左邊；
//   四邊都放不下但目標夠大（例：整個 3D 舞台）→ 放在目標裡面靠下，不要蓋住正中間；都不行 → 放中間。
//   座標一律夾在視窗內、離邊至少 gutter。

export interface Rect { x: number; y: number; w: number; h: number }
export type Placement =
  | { mode: 'center' }
  | { mode: 'sheet' }
  | { mode: 'anchored'; side: 'below' | 'above' | 'right' | 'left' | 'inside'; x: number; y: number };

/** 說明框和目標之間留的空（亮框外面多 6px，再留 8px） */
const GAP = 14;
/** 視窗寬小於這個就改成貼底部 */
export const TOUR_SHEET_MAX_WIDTH = 640;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

export function placeBubble(
  target: Rect | null,
  bubble: { w: number; h: number },
  viewport: { w: number; h: number },
  gutter = 16,
): Placement {
  if (viewport.w < TOUR_SHEET_MAX_WIDTH) return { mode: 'sheet' };
  if (!target) return { mode: 'center' };

  const minX = gutter;
  const maxX = viewport.w - gutter - bubble.w;
  const minY = gutter;
  const maxY = viewport.h - gutter - bubble.h;
  const centeredX = clamp(target.x + target.w / 2 - bubble.w / 2, minX, maxX);
  const centeredY = clamp(target.y + target.h / 2 - bubble.h / 2, minY, maxY);

  // 下面
  const belowY = target.y + target.h + GAP;
  if (belowY <= maxY) return { mode: 'anchored', side: 'below', x: centeredX, y: belowY };
  // 上面
  const aboveY = target.y - GAP - bubble.h;
  if (aboveY >= minY) return { mode: 'anchored', side: 'above', x: centeredX, y: aboveY };
  // 右邊
  const rightX = target.x + target.w + GAP;
  if (rightX <= maxX) return { mode: 'anchored', side: 'right', x: rightX, y: centeredY };
  // 左邊
  const leftX = target.x - GAP - bubble.w;
  if (leftX >= minX) return { mode: 'anchored', side: 'left', x: leftX, y: centeredY };
  // 目標夠大 → 放在目標裡面靠左下
  if (target.w >= bubble.w + gutter * 2 && target.h >= bubble.h + gutter * 2) {
    return {
      mode: 'anchored', side: 'inside',
      x: clamp(target.x + gutter, minX, maxX),
      y: clamp(target.y + target.h - gutter - bubble.h, minY, maxY),
    };
  }
  return { mode: 'center' };
}
