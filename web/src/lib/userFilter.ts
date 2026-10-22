// 用戶頁（全站用戶）的搜尋 / 專案篩選 / 依專案分組（純計算，userFilter.test.ts 有測）。
import { MEMBER_ROLE_NAME, MEMBER_ROLE_ORDER, type MemberRole } from './projectMembers';

/** 篩選專案：'all' 全部 / 'none' 沒有專案 / 其他 = 專案 id */
export type ProjectFilter = 'all' | 'none' | (string & {});

export const PROJECT_FILTER_ALL = 'all';
export const PROJECT_FILTER_NONE = 'none';

export interface FilterableUser {
  id: string;
  name: string;
  role: string;
  projects: ReadonlyArray<{ projectId: string; role: string }>;
}

/** 比對用的名字：去頭尾空白、英文不分大小寫、全形英數轉半形 */
export function normalizeSearchText(s: string): string {
  return s.normalize('NFKC').trim().toLowerCase();
}

/** 這個人在這個專案是什麼角色（不是成員 = null） */
export function roleInProject(u: FilterableUser, projectId: string): string | null {
  return u.projects.find(p => p.projectId === projectId)?.role ?? null;
}

/**
 * 搜尋名字 + 專案篩選
 *   all   不篩
 *   none  沒有專案的人（全站製作看得到全部專案，不算「沒有專案」）
 *   <id>  這個專案的成員
 */
export function filterUsers<U extends FilterableUser>(users: readonly U[], opts: { query?: string; project?: ProjectFilter }): U[] {
  const q = normalizeSearchText(opts.query ?? '');
  const project = opts.project ?? PROJECT_FILTER_ALL;
  return users.filter(u => {
    if (q && !normalizeSearchText(u.name).includes(q)) return false;
    if (project === PROJECT_FILTER_ALL) return true;
    if (project === PROJECT_FILTER_NONE) return u.role !== 'admin' && u.projects.length === 0;
    return u.projects.some(p => p.projectId === project);
  });
}

export interface UserGroup<U> {
  role: MemberRole;
  label: string;
  users: U[];
}

/** 選了某個專案時，依「他在這個專案的角色」分組：製作 → 導演 → 動畫師，組內照名字排 */
export function groupUsersByProjectRole<U extends FilterableUser>(users: readonly U[], projectId: string): UserGroup<U>[] {
  const out: UserGroup<U>[] = [];
  for (const role of MEMBER_ROLE_ORDER) {
    const list = users
      .filter(u => roleInProject(u, projectId) === role)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    if (list.length > 0) out.push({ role, label: MEMBER_ROLE_NAME[role], users: list });
  }
  return out;
}

/** 專案篩選的選項文字：專案名稱後面寫幾位成員 */
export function projectFilterLabel(name: string, memberCount: number): string {
  return `${name}（${memberCount}）`;
}

/** 每個專案有幾位用戶（篩選選單上顯示） */
export function countUsersByProject(users: readonly FilterableUser[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const u of users) for (const p of u.projects) m.set(p.projectId, (m.get(p.projectId) ?? 0) + 1);
  return m;
}

/** 目前篩選條件的白話說明（清單上方的小字） */
export function filterSummary(total: number, shown: number, opts: { query?: string; project?: ProjectFilter }): string {
  const filtering = !!(opts.query ?? '').trim() || (opts.project ?? PROJECT_FILTER_ALL) !== PROJECT_FILTER_ALL;
  return filtering ? `共 ${total} 位，符合的有 ${shown} 位` : `共 ${total} 位`;
}
