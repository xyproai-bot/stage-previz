// 誰看得到導演頁的「審片 / 調整舞台」切換：導演、這個專案的製作、全站製作；動畫師、分享連結的訪客看不到。
// 專案不是 Cue 庫模式（或沒有機關）就不出現。
// 調整舞台可以存回 Cue 庫（第 3 段）：後台的規則是「導演改舞台」（cf-worker/access.mjs canEditStage）——這個專案的導演，
// 或能編輯這個專案的人（專案的製作、全站製作）；動畫師 403。這裡只是決定畫面上出不出現，真正擋的是後台。
// 「預覽導演畫面」（用其他身分看）時切換鈕照樣出現，但存的動作會被擋住（只能看）。

import type { PositionsMode } from '../mechanisms/track';

export function canAdjustStage(o: { projectRole: string | null | undefined; accountRole: string | null | undefined }): boolean {
  return o.projectRole === 'director' || o.projectRole === 'admin' || o.accountRole === 'admin';
}

export function showAdjustSwitch(o: { canAdjust: boolean; mode: PositionsMode | null | undefined; hasMechanisms: boolean }): boolean {
  return o.canAdjust && o.mode === 'library' && o.hasMechanisms;
}
