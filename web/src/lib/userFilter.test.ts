import { describe, expect, it } from 'vitest';
import {
  countUsersByProject, filterSummary, filterUsers, groupUsersByProjectRole, normalizeSearchText, projectFilterLabel, roleInProject,
} from './userFilter';

const u = (id: string, name: string, role: string, projects: Array<[string, string]> = []) => ({
  id, name, role, projects: projects.map(([projectId, r]) => ({ projectId, role: r })),
});
const USERS = [
  u('1', '陳製作', 'admin'),
  u('2', 'Hao', 'animator', [['p1', 'admin'], ['p2', 'animator']]),
  u('3', 'Mina', 'animator', [['p1', 'animator']]),
  u('4', '王導', 'director', [['p1', 'director']]),
  u('5', '小華', 'animator'),
  u('6', 'mina lin', 'director', [['p2', 'director']]),
];

describe('用戶頁：搜尋名字', () => {
  it('包含就算，英文不分大小寫，頭尾空白不管', () => {
    expect(filterUsers(USERS, { query: 'mina' }).map(x => x.id)).toEqual(['3', '6']);
    expect(filterUsers(USERS, { query: '  MINA ' }).map(x => x.id)).toEqual(['3', '6']);
    expect(filterUsers(USERS, { query: '導' }).map(x => x.id)).toEqual(['4']);
    expect(filterUsers(USERS, { query: 'zzz' })).toEqual([]);
  });
  it('沒打字 = 全部；全形英文也找得到', () => {
    expect(filterUsers(USERS, {}).length).toBe(6);
    expect(filterUsers(USERS, { query: '' }).length).toBe(6);
    expect(filterUsers(USERS, { query: 'ｈａｏ' }).map(x => x.id)).toEqual(['2']);
    expect(normalizeSearchText('  ＡＢＣ ')).toBe('abc');
  });
});

describe('用戶頁：專案篩選', () => {
  it('某個專案 = 那個專案的成員', () => {
    expect(filterUsers(USERS, { project: 'p1' }).map(x => x.id)).toEqual(['2', '3', '4']);
    expect(filterUsers(USERS, { project: 'p2' }).map(x => x.id)).toEqual(['2', '6']);
    expect(filterUsers(USERS, { project: 'nope' })).toEqual([]);
  });
  it('沒有專案 = 還沒加進任何專案的人；全站製作不算（他看得到全部）', () => {
    expect(filterUsers(USERS, { project: 'none' }).map(x => x.id)).toEqual(['5']);
  });
  it('搜尋和專案可以一起用', () => {
    expect(filterUsers(USERS, { project: 'p1', query: 'mina' }).map(x => x.id)).toEqual(['3']);
    expect(filterUsers(USERS, { project: 'p2', query: 'mina' }).map(x => x.id)).toEqual(['6']);
    expect(filterUsers(USERS, { project: 'all', query: 'hao' }).map(x => x.id)).toEqual(['2']);
  });
});

describe('用戶頁：選了專案就依他在這個專案的角色分組', () => {
  it('製作 → 導演 → 動畫師；用他在這個專案的角色，不是帳號的角色', () => {
    const inP1 = filterUsers(USERS, { project: 'p1' });
    const groups = groupUsersByProjectRole(inP1, 'p1');
    expect(groups.map(g => [g.label, g.users.map(x => x.name)])).toEqual([
      ['製作', ['Hao']],       // 帳號是動畫師，但在 p1 是製作
      ['導演', ['王導']],
      ['動畫師', ['Mina']],
    ]);
    // 同一個人在 p2 是動畫師
    expect(roleInProject(USERS[1], 'p2')).toBe('animator');
    expect(groupUsersByProjectRole(filterUsers(USERS, { project: 'p2' }), 'p2').map(g => g.label)).toEqual(['導演', '動畫師']);
    expect(roleInProject(USERS[4], 'p1')).toBeNull();
    expect(groupUsersByProjectRole([], 'p1')).toEqual([]);
  });
});

describe('用戶頁：小字', () => {
  it('每個專案幾位、清單上方的說明', () => {
    const counts = countUsersByProject(USERS);
    expect(counts.get('p1')).toBe(3);
    expect(counts.get('p2')).toBe(2);
    expect(counts.get('p3')).toBeUndefined();
    expect(projectFilterLabel('金馬', 3)).toBe('金馬（3）');
    expect(filterSummary(6, 6, {})).toBe('共 6 位');
    expect(filterSummary(6, 2, { query: 'mina' })).toBe('共 6 位，符合的有 2 位');
    expect(filterSummary(6, 3, { project: 'p1' })).toBe('共 6 位，符合的有 3 位');
    expect(filterSummary(6, 6, { project: 'all', query: ' ' })).toBe('共 6 位');
  });
});
