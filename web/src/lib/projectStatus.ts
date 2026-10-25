// 專案的狀態：進行中 ⇄ 審查中（首頁的篩選按鈕「審查中」看的就是這個）。
//   後台 PATCH /api/projects/:id { status }：只有全站製作能改；封存要走「封存」，不在這裡切。
//   以前畫面上沒有地方可以改，「審查中」永遠是 0 個。

export type ProjectStatusValue = 'active' | 'in_review' | 'archived';

export interface ReviewToggle {
  /** 按下去會變成的狀態 */
  next: 'active' | 'in_review';
  /** 選單上的字 */
  menuLabel: string;
  /** 改好後的通知 */
  doneMessage: (projectName: string) => string;
}

/** 這個專案的選單要不要有「標成審查中 / 改回進行中」；封存的專案沒有 */
export function reviewToggle(status: ProjectStatusValue): ReviewToggle | null {
  if (status === 'active') {
    return {
      next: 'in_review',
      menuLabel: '標成審查中',
      doneMessage: (name) => `「${name}」標成審查中了（首頁可以用「審查中」篩出來）`,
    };
  }
  if (status === 'in_review') {
    return {
      next: 'active',
      menuLabel: '改回進行中',
      doneMessage: (name) => `「${name}」改回進行中了`,
    };
  }
  return null;
}
