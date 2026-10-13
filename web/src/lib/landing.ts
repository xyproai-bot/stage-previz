// 登入後 / 打開首頁時要去哪裡，以及哪些頁面誰可以開（純判斷，方便測試）
//
//   製作（admin）    → /admin
//   動畫師（animator）→ /studio；只有一個專案就直接進 /studio/<那個專案>
//   導演（director）  → /preview；只有一個專案就直接進 /preview/<那個專案>
//
// 管理頁（/admin/...）只有製作能開；設定頁在 /settings，每個登入的人都能開（動畫師要用 NDI 檢查連線）。

import type { UserRole } from './api';

/** 這個角色要不要先拿專案清單才知道去哪（只有一個專案要直接進去） */
export function landingNeedsProjects(role: UserRole | null | undefined): boolean {
  return role === 'animator' || role === 'director';
}

/** 這個角色的專案清單頁 */
export function projectListPath(role: UserRole | null | undefined): string {
  if (role === 'admin') return '/admin';
  if (role === 'director') return '/preview';
  return '/studio';
}

/**
 * 登入後該去的頁面。
 * projects：這個人看得到的專案（後台已經只回他被加入的）；還沒拿到 / 拿失敗給 null → 去清單頁。
 */
export function landingPath(
  role: UserRole | null | undefined,
  projects: ReadonlyArray<{ id: string }> | null | undefined,
): string {
  if (!role) return '/login';
  if (role === 'admin') return '/admin';
  const base = projectListPath(role);
  if (projects && projects.length === 1) return `${base}/${encodeURIComponent(projects[0].id)}`;
  return base;
}

/** 只有製作能開的頁面：/admin 跟 /admin/...（舊的 /admin/settings 會轉去 /settings，不算） */
export function isAdminOnlyPath(pathname: string): boolean {
  const p = pathname.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  if (p === '/admin/settings') return false;
  return p === '/admin' || p.startsWith('/admin/');
}

/** 這個角色能不能開這個網址 */
export function canOpenPath(role: UserRole | null | undefined, pathname: string): boolean {
  if (!role) return false;
  if (isAdminOnlyPath(pathname)) return role === 'admin';
  return true;
}

/**
 * 登入前想去的頁面（被要求登入時記下來的），登入後還要不要回去：
 * 是自己能開的站內網址才回去；首頁 / 登入頁 / 不能開的 → null（改去 landingPath）。
 */
export function returnPathAfterLogin(role: UserRole | null | undefined, from: unknown): string | null {
  if (typeof from !== 'string') return null;
  if (!from.startsWith('/') || from.startsWith('//')) return null;  // 只收站內網址
  const p = from.split(/[?#]/)[0];
  if (p === '/' || p === '/login') return null;
  return canOpenPath(role, p) ? from : null;
}
