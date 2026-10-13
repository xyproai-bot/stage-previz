// 畫面上顯示的角色名稱（全站統一）：製作 / 動畫師 / 導演。
// 程式裡的代號（admin / animator / director）不要直接顯示給使用者看。
import type { UserRole } from './api';

export const ROLE_LABEL: Record<UserRole, string> = {
  admin: '製作',
  animator: '動畫師',
  director: '導演',
};

/** 任何角色代號 → 顯示名稱；舊留言的 designer、admin、不認得的 → 製作 */
export function roleLabel(role: string | null | undefined): string {
  if (role === 'animator') return ROLE_LABEL.animator;
  if (role === 'director') return ROLE_LABEL.director;
  return ROLE_LABEL.admin;
}
