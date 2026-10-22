// 物件「預設隱藏」（0040）的前端：沒有 cue 的時候這個物件顯不顯示、畫面上的字、物件狀態旁邊的說明（純函式）
//
// 規則在後台（cf-worker/cueStates.mjs，GET …/states 的 effective.visible 已經算好）：
//   - 這個 cue 自己設了顯示 / 隱藏 → 用自己的（明確設定永遠優先）
//   - 沒設 → 前面的 cue 最近一次設的；前面都沒設過 → 預設隱藏的物件隱藏、其他顯示
// 前端只有兩件事要自己算：沒有選 cue 的時候（物件預設位置那份）這個物件顯不顯示，和畫面上寫的字。

import type { CueState, StageObject } from './api';

export const DEFAULT_HIDDEN_LABEL = '預設隱藏';
export const DEFAULT_HIDDEN_HINT = '沒有 cue 設定過顯示的歌，這個物件不會出現；要在哪首歌出現，就在那首歌的 cue 裡把它設成顯示。';

/** 舊的後台沒有這個欄位 = 不隱藏 */
export const isDefaultHidden = (o: { defaultHidden?: boolean } | null | undefined): boolean => !!o?.defaultHidden;

/** 沒有 cue 時（物件預設那一份）這個物件顯不顯示 */
export const defaultVisible = (o: { defaultHidden?: boolean } | null | undefined): boolean => !isDefaultHidden(o);

/** 物件清單上的開關：按鈕的說明（現在是預設隱藏 → 按了就取消） */
export function defaultHiddenToggleText(o: Pick<StageObject, 'displayName' | 'defaultHidden'>): { title: string; label: string } {
  return isDefaultHidden(o)
    ? { title: `「${DEFAULT_HIDDEN_LABEL}」開著：${DEFAULT_HIDDEN_HINT}按一下取消`, label: `取消「${o.displayName}」的${DEFAULT_HIDDEN_LABEL}` }
    : { title: `設成「${DEFAULT_HIDDEN_LABEL}」：${DEFAULT_HIDDEN_HINT}`, label: `把「${o.displayName}」設成${DEFAULT_HIDDEN_LABEL}` };
}

/** 改了以後跳出來的一句話 */
export function defaultHiddenToast(name: string, on: boolean): string {
  return on
    ? `「${name}」現在是${DEFAULT_HIDDEN_LABEL}：沒有 cue 設定過顯示的歌，它不會出現。`
    : `「${name}」不再${DEFAULT_HIDDEN_LABEL}：沒設定的歌照舊顯示。`;
}

/**
 * 物件狀態裡這個物件的顯示 / 隱藏是怎麼來的（只有預設隱藏的物件才有說明）：
 *   - 預設隱藏、這個 cue 自己沒設、現在是隱藏 → 這首歌到這裡還沒有 cue 把它設成顯示
 *   - 預設隱藏、現在是顯示 → 是這個 cue（或前面的 cue）明確設成顯示的
 */
export function visibilityNote(s: Pick<CueState, 'defaultHidden' | 'override' | 'effective'>): string | null {
  if (!isDefaultHidden(s)) return null;
  const own = s.override?.visible;
  if (own === true) return `${DEFAULT_HIDDEN_LABEL}，這個 cue 設成顯示`;
  if (own === false) return `${DEFAULT_HIDDEN_LABEL}，這個 cue 也設成隱藏`;
  return s.effective.visible
    ? `${DEFAULT_HIDDEN_LABEL}，前面的 cue 設成顯示，這個 cue 沿用`
    : `${DEFAULT_HIDDEN_LABEL}：這首歌到這個 cue 還沒有設定過顯示`;
}
