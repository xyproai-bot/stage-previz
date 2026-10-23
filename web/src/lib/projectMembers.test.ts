import { describe, expect, it } from 'vitest';
import {
  MEMBER_ROLE_NAME, MEMBER_ROLE_ORDER, PROJECT_ADMIN_CAN, PROJECT_ADMIN_CANNOT, PROJECT_ADMIN_SCOPE_TEXT, groupMembersByRole, groupTitle, memberRowLock,
} from './projectMembers';

describe('專案成員：分組', () => {
  it('依製作、導演、動畫師排，組內照名字，沒有人的角色不出現', () => {
    const groups = groupMembersByRole([
      { id: '1', name: 'Cathy', role: 'animator' as const },
      { id: '2', name: 'Bob', role: 'director' as const },
      { id: '3', name: 'Anna', role: 'animator' as const },
    ]);
    expect(groups.map(g => g.label)).toEqual(['導演', '動畫師']);
    expect(groups[1].members.map(m => m.name)).toEqual(['Anna', 'Cathy']);
    expect(groupMembersByRole([])).toEqual([]);
    expect(MEMBER_ROLE_ORDER).toEqual(['admin', 'director', 'animator']);
    expect(groupTitle('導演', 2)).toBe('導演（2）');
  });

  it('角色名稱都是中文', () => {
    expect(MEMBER_ROLE_NAME).toEqual({ admin: '製作', director: '導演', animator: '動畫師' });
  });

  it('全站製作和自己鎖住，其他人可以改', () => {
    expect(memberRowLock({ globalAdmin: true })).toBe('globalAdmin');
    expect(memberRowLock({ isMe: true })).toBe('me');
    expect(memberRowLock({ globalAdmin: false, isMe: false })).toBeNull();
  });
});

describe('專案的製作能做什麼：說明文字', () => {
  it('一行字，寫出能做的和不能做的', () => {
    expect(PROJECT_ADMIN_SCOPE_TEXT).not.toContain('\n');
    expect(PROJECT_ADMIN_SCOPE_TEXT).toMatch(/^專案的「製作」可以編輯這個專案（模型、歌單、cue、機關、版型、分享）/);
    expect(PROJECT_ADMIN_SCOPE_TEXT).toContain('打開導演頁和動畫師工作站');
    expect(PROJECT_ADMIN_SCOPE_TEXT).toContain('看不到別的專案');
    expect(PROJECT_ADMIN_SCOPE_TEXT).toContain('管全站用戶');
    for (const c of PROJECT_ADMIN_CANNOT) expect(PROJECT_ADMIN_SCOPE_TEXT).toContain(c.phrase);
    for (const c of PROJECT_ADMIN_CAN.filter(x => x !== '成員')) expect(PROJECT_ADMIN_SCOPE_TEXT).toContain(c);
  });
});
