// 調整舞台的「草稿」：只放導演改過的機關（機關 id → 值）。畫面用的值 = 這個 cue 存的值 + 草稿。
// 只是預覽：草稿不存到任何地方（存回 Cue 庫是下一段）。

import { clampValue, type MechanismValues } from '../mechanisms/model';

export type Draft = MechanismValues;

const EPS = 1e-9;

/** 改一個機關（回傳新的草稿）；改回跟存的一樣 → 從草稿拿掉 */
export function setDraftValue(draft: Draft, saved: MechanismValues, id: string, v: number): Draft {
  const out = { ...draft };
  const s = saved[id];
  if (typeof s === 'number' && Math.abs(v - s) < EPS) delete out[id];
  else out[id] = v;
  return out;
}

/** 這些機關回到存的值 */
export function revertDraft(draft: Draft, ids: string[]): Draft {
  const out = { ...draft };
  for (const id of ids) delete out[id];
  return out;
}

/** 畫面用的值：存的值 + 草稿 */
export function effectiveValues(saved: MechanismValues, draft: Draft): MechanismValues {
  return { ...saved, ...draft };
}

/** 改了哪些機關 */
export function changedIds(draft: Draft): string[] {
  return Object.keys(draft);
}

export type TravelRange = { travelMin: number; travelMax: number };

/**
 * 一起動：主要的走到 primaryTarget（夾在它的行程內），其他的「加一樣的量」，各自夾在自己的行程內。
 * start = 開始拖那一刻每個的值（用開始的值算，夾住的不會越拖越歪）；沒有開始值的跳過。
 */
export function moveTogether(
  start: MechanismValues, ids: string[], primaryId: string, primaryTarget: number,
  ranges: Record<string, TravelRange | undefined>,
): MechanismValues {
  const out: MechanismValues = {};
  const p0 = start[primaryId];
  const pr = ranges[primaryId];
  if (typeof p0 !== 'number') return out;
  const target = pr ? clampValue(primaryTarget, pr.travelMin, pr.travelMax) : primaryTarget;
  const delta = target - p0;
  for (const id of ids) {
    const s = start[id];
    if (typeof s !== 'number') continue;
    const r = ranges[id];
    out[id] = id === primaryId ? target : r ? clampValue(s + delta, r.travelMin, r.travelMax) : s + delta;
  }
  return out;
}
