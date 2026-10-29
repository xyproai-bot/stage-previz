// 調整舞台面板 / 提示列上的字（集中在這裡，才測得到：白話、沒有英文叫人的字、沒有 emoji）

import type { Mechanism } from '../mechanisms/model';
import { formatMechValue } from '../mechanisms/motion';
import type { ScopeKey } from './scope';

/** 機關是哪一種（面板上機關名字旁邊的小字） */
export function kindLabel(def: Pick<Mechanism, 'kind' | 'variant' | 'axis'>): string {
  if (def.variant === 'hoist') return '吊點';
  if (def.variant === 'arc') return '沿弧形軌道';
  if (def.kind === 'rotary') return Math.abs(def.axis.y) > 0.7 ? '旋轉' : '翻轉';
  return Math.abs(def.axis.y) > 0.7 ? '升降' : '直線';
}

export function valueText(v: number, kind: Mechanism['kind']): string {
  return formatMechValue(v, kind);
}

export function rangeText(def: Pick<Mechanism, 'kind' | 'travelMin' | 'travelMax'>): string {
  return `行程 ${valueText(def.travelMin, def.kind)} 到 ${valueText(def.travelMax, def.kind)}`;
}

export function scopeLabel(scope: ScopeKey, count: number): string {
  if (scope === 'all') return `整排一起（${count}）`;
  if (scope === 'left') return `左半（${count}）`;
  if (scope === 'right') return `右半（${count}）`;
  return '只有這個';
}

export function togetherHint(count: number): string {
  return count > 1 ? `${count} 個一起動，每個加一樣的量（各自不會超出行程）。` : '';
}

export function hoistHint(linked: boolean): string {
  return linked
    ? '左右一起動。取消「左右一起」可以單獨調一邊，讓它斜一點。'
    : '現在一邊一邊調；要一起動就按「左右一起」。';
}

/** 一排機關的名字：成員名字共同的開頭（去掉後面的編號）；看不出來 → 「一排機關」 */
export function groupLabel(names: string[]): string {
  if (names.length === 0) return '一排機關';
  let p = names[0];
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < p.length && i < n.length && p[i] === n[i]) i++;
    p = p.slice(0, i);
  }
  p = p.replace(/[\s\d\-_#（(]+$/u, '').trim();
  return p.length > 0 ? p : '一排機關';
}

export function barText(count: number): string {
  return `改了 ${count} 個機關`;
}

export const ADJUST_TEXT = {
  listTitle: '機關',
  listHint: '在 3D 畫面點有機關的物件，或從這裡選。黃色的是這個 cue 改過的。',
  noMechanisms: '這個專案還沒有設定機關（製作在編輯頁的「機關」設定）。',
  backToList: '清單',
  revert: '回到存的值',
  discardAll: '放棄全部改動',
  unsavedHint: '改的東西要按 3D 畫面下面的「存回 Cue 庫」或「另存成新 cue」才會存；沒存就換 cue、切回審片會放棄。',
  confirmTitle: '放棄這些改動？',
  confirmMessage: (n: number) => `調整舞台改了 ${n} 個機關，還沒存。`,
  confirmLabel: '放棄',
  unload: '調整舞台改的東西還沒存，離開就沒了',
  dropped: (n: number) => `換到別的 cue 了，剛剛調整舞台改的 ${n} 個機關已經放棄`,
  playHint: '180° 和 −180° 看起來一樣，差在轉的方向，按上面的「播轉場」看。',
  linked: '左右一起',
  modeReview: '審片',
  modeAdjust: '調整舞台',
  modeHint: '調整舞台：點 3D 物件、拖把手調機關，調好可以存回 Cue 庫',
} as const;
