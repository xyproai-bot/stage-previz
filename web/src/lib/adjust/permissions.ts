// 誰看得到導演頁的「審片 / 調整舞台」切換：導演、這個專案的製作、全站製作；動畫師、分享連結的訪客看不到。
// 專案不是 Cue 庫模式（或沒有機關）就不出現。這一段只是預覽，不存任何東西，所以「預覽導演畫面」時也可以用。

import type { PositionsMode } from '../mechanisms/track';

export function canAdjustStage(o: { projectRole: string | null | undefined; accountRole: string | null | undefined }): boolean {
  return o.projectRole === 'director' || o.projectRole === 'admin' || o.accountRole === 'admin';
}

export function showAdjustSwitch(o: { canAdjust: boolean; mode: PositionsMode | null | undefined; hasMechanisms: boolean }): boolean {
  return o.canAdjust && o.mode === 'library' && o.hasMechanisms;
}
