// 拖把手 / 拉滑桿時自動對齊：先吸常用位置，不靠近就對齊 0.1 公尺 / 1 度；按住 Alt（free）不對齊。一律不超出行程。

import { clampValue, type MechanismKind } from '../mechanisms/model';

/** 對齊的格子：直線 0.1 公尺、旋轉 1 度 */
export const SNAP_STEP: Record<MechanismKind, number> = { linear: 0.1, rotary: 1 };
/** 離常用位置多近就吸過去：直線 0.15 公尺、旋轉 3 度 */
export const PRESET_SNAP: Record<MechanismKind, number> = { linear: 0.15, rotary: 3 };

export interface SnapOptions {
  kind: MechanismKind;
  /** 常用位置的值 */
  presets: number[];
  min: number;
  max: number;
  /** true = 不對齊（按住 Alt） */
  free?: boolean;
}

export function snapValue(raw: number, o: SnapOptions): number {
  const v = clampValue(raw, o.min, o.max);
  if (o.free) return v;
  const thr = PRESET_SNAP[o.kind];
  let best: number | null = null;
  for (const p of o.presets) {
    if (!Number.isFinite(p)) continue;
    const d = Math.abs(v - p);
    if (d <= thr && (best === null || d < Math.abs(v - best))) best = p;
  }
  if (best !== null) return clampValue(best, o.min, o.max);
  const step = SNAP_STEP[o.kind];
  const g = Number((Math.round(v / step) * step).toFixed(6));
  return clampValue(Object.is(g, -0) ? 0 : g, o.min, o.max);
}
