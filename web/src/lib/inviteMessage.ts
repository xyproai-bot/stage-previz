// 邀請連結 / 登入碼：要貼到 LINE、微信的訊息，和畫面上怎麼顯示（純計算，inviteMessage.test.ts 有測）

import { ROLE_LABEL } from './roleLabels';
import type { UserRole } from './api';

const DAY_MS = 86400_000;

/** 「7 天內有效，只能用一次」/「7 天內有效，最多可以用 10 次」 */
export function inviteValidityText(days: number, maxUses: number): string {
  const d = Math.max(1, Math.round(days));
  const uses = maxUses > 1 ? `最多可以用 ${maxUses} 次` : '只能用一次';
  return `${d} 天內有效，${uses}`;
}

/**
 * 邀請連結的訊息（直接貼給對方）
 * 例：王小明你好，這是「金馬 2026」的 Stage Previz 連結，點開就能進去看：https://…（7 天內有效，只能用一次）
 */
export function buildInviteMessage(p: {
  personName: string;
  projectName: string;
  url: string;
  days: number;
  maxUses: number;
}): string {
  const name = p.personName.trim();
  const hello = name ? `${name}你好，` : '你好，';
  return `${hello}這是「${p.projectName.trim() || '專案'}」的 Stage Previz 連結，點開就能進去看：${p.url}（${inviteValidityText(p.days, p.maxUses)}）`;
}

/**
 * 登入碼的訊息（建立 / 重設後貼給對方）
 * 例：王小明你好，這是你的 Stage Previz 登入碼：K7MNP3XQ2R，打開 https://…/login 輸入就能登入。登入碼請不要給別人。
 */
export function buildLoginCodeMessage(p: { name: string; code: string; loginUrl: string }): string {
  const name = p.name.trim();
  const hello = name ? `${name}你好，` : '你好，';
  return `${hello}這是你的 Stage Previz 登入碼：${p.code}，打開 ${p.loginUrl} 輸入就能登入。登入碼請不要給別人。`;
}

/** 顯示用：長的登入碼每 5 個字空一格比較好念（登入時空白會被拿掉，照著打也可以） */
export function formatLoginCodeForDisplay(code: string): string {
  if (code.length < 8 || /[^A-Z0-9]/.test(code)) return code;
  return code.replace(/(.{5})(?=.)/g, '$1 ');
}

/** 用戶清單上登入碼那一格要顯示什麼（後台還是舊版、沒有 hasAccessCode 也看得懂） */
export type LoginCodeDisplay =
  | { kind: 'plain'; code: string }   // 後台還是明文存法：照以前顯示
  | { kind: 'hidden' }                // 雜湊存法：只在建立 / 重設時顯示過
  | { kind: 'none' };                 // 還沒有登入碼（用邀請連結進來的）

export function loginCodeDisplay(u: { accessCode?: string | null; hasAccessCode?: boolean }): LoginCodeDisplay {
  if (typeof u.accessCode === 'string' && u.accessCode) return { kind: 'plain', code: u.accessCode };
  if (u.hasAccessCode) return { kind: 'hidden' };
  return { kind: 'none' };
}

export const LOGIN_CODE_HIDDEN_TEXT = '登入碼只在建立時顯示，忘記了請按重設';

/** 邀請只開放這兩個角色（製作帳號在用戶頁建、用登入碼登入） */
export const INVITE_ROLE_OPTIONS: ReadonlyArray<{ role: Extract<UserRole, 'animator' | 'director'>; label: string; hint: string }> = [
  { role: 'director', label: ROLE_LABEL.director, hint: '進審片頁：看影片、留言、通過或要求修改' },
  { role: 'animator', label: ROLE_LABEL.animator, hint: '進工作站：交影片、看導演的留言' },
];

export const INVITE_DAY_OPTIONS: readonly number[] = [1, 3, 7, 14, 30];

/** 清單上「還有幾天」：還有 3 天 / 今天到期 / 已過期 */
export function inviteExpiryText(expiresAt: string | null, now = Date.now()): string {
  if (!expiresAt) return '';
  const left = Date.parse(expiresAt) - now;
  if (!(left > 0)) return '已過期';
  if (left < DAY_MS) {
    const hours = Math.max(1, Math.ceil(left / 3600_000));
    return `還有 ${hours} 小時`;
  }
  return `還有 ${Math.ceil(left / DAY_MS)} 天`;
}

/** 清單上的使用次數：還沒用 / 用了 2 次，還剩 8 次 */
export function inviteUsesText(useCount: number, maxUses: number): string {
  if (maxUses <= 1) return useCount > 0 ? '已經用過' : '還沒用';
  if (useCount <= 0) return `還沒用（最多 ${maxUses} 次）`;
  return `用了 ${useCount} 次，還剩 ${Math.max(0, maxUses - useCount)} 次`;
}
