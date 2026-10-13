import { describe, it, expect } from 'vitest';
import {
  canOpenPath, isAdminOnlyPath, landingNeedsProjects, landingPath, projectListPath, returnPathAfterLogin,
} from './landing';

describe('landingPath', () => {
  it('製作 → 管理頁（不用專案清單）', () => {
    expect(landingPath('admin', null)).toBe('/admin');
    expect(landingPath('admin', [{ id: 'p1' }])).toBe('/admin');
    expect(landingNeedsProjects('admin')).toBe(false);
  });
  it('動畫師：一個專案直接進工作站，零個 / 多個去清單', () => {
    expect(landingPath('animator', [{ id: 'p_abc' }])).toBe('/studio/p_abc');
    expect(landingPath('animator', [])).toBe('/studio');
    expect(landingPath('animator', [{ id: 'a' }, { id: 'b' }])).toBe('/studio');
    expect(landingNeedsProjects('animator')).toBe(true);
  });
  it('導演：一個專案直接進審片頁，零個 / 多個去清單', () => {
    expect(landingPath('director', [{ id: 'p_xyz' }])).toBe('/preview/p_xyz');
    expect(landingPath('director', [])).toBe('/preview');
    expect(landingPath('director', [{ id: 'a' }, { id: 'b' }])).toBe('/preview');
    expect(landingNeedsProjects('director')).toBe(true);
  });
  it('專案清單拿不到（null）→ 去清單頁（清單頁會顯示錯誤）', () => {
    expect(landingPath('animator', null)).toBe('/studio');
    expect(landingPath('director', undefined)).toBe('/preview');
  });
  it('沒登入 → 登入頁', () => {
    expect(landingPath(null, null)).toBe('/login');
  });
  it('專案代號會編碼（不會被當成別的路徑）', () => {
    expect(landingPath('animator', [{ id: 'a/b' }])).toBe('/studio/a%2Fb');
  });
  it('projectListPath', () => {
    expect(projectListPath('admin')).toBe('/admin');
    expect(projectListPath('animator')).toBe('/studio');
    expect(projectListPath('director')).toBe('/preview');
  });
});

describe('isAdminOnlyPath / canOpenPath', () => {
  it('/admin 底下全部只給製作', () => {
    for (const p of ['/admin', '/admin/', '/admin/projects/p1', '/admin/users', '/admin/drive-sources',
      '/admin/templates', '/admin/archived', '/admin/shows', '/admin/shows/s1', '/admin/whatever']) {
      expect(isAdminOnlyPath(p)).toBe(true);
      expect(canOpenPath('admin', p)).toBe(true);
      expect(canOpenPath('animator', p)).toBe(false);
      expect(canOpenPath('director', p)).toBe(false);
    }
  });
  it('舊的 /admin/settings 會轉去 /settings → 誰都能開', () => {
    expect(isAdminOnlyPath('/admin/settings')).toBe(false);
    expect(canOpenPath('animator', '/admin/settings')).toBe(true);
  });
  it('設定、工作站、審片頁、說明：登入的人都能開', () => {
    for (const p of ['/settings', '/studio', '/studio/p1', '/preview', '/preview/p1', '/help']) {
      expect(canOpenPath('animator', p)).toBe(true);
      expect(canOpenPath('director', p)).toBe(true);
      expect(canOpenPath('admin', p)).toBe(true);
    }
  });
  it('/administrator 這種不是 /admin 底下', () => {
    expect(isAdminOnlyPath('/administrator')).toBe(false);
  });
  it('帶 ?query 也認得', () => {
    expect(isAdminOnlyPath('/admin/users?x=1')).toBe(true);
  });
  it('沒登入什麼都不能開', () => {
    expect(canOpenPath(null, '/studio')).toBe(false);
  });
});

describe('returnPathAfterLogin', () => {
  it('能開的站內頁 → 回去', () => {
    expect(returnPathAfterLogin('animator', '/studio/p1')).toBe('/studio/p1');
    expect(returnPathAfterLogin('admin', '/admin/users')).toBe('/admin/users');
    expect(returnPathAfterLogin('director', '/settings')).toBe('/settings');
  });
  it('不能開的（動畫師想去管理頁）→ null，改去自己的頁面', () => {
    expect(returnPathAfterLogin('animator', '/admin')).toBeNull();
    expect(returnPathAfterLogin('director', '/admin/projects/p1')).toBeNull();
  });
  it('首頁 / 登入頁 / 沒給 → null', () => {
    expect(returnPathAfterLogin('admin', '/')).toBeNull();
    expect(returnPathAfterLogin('admin', '/login')).toBeNull();
    expect(returnPathAfterLogin('admin', undefined)).toBeNull();
    expect(returnPathAfterLogin('admin', 42)).toBeNull();
  });
  it('站外網址不收', () => {
    expect(returnPathAfterLogin('admin', 'https://evil.example/')).toBeNull();
    expect(returnPathAfterLogin('admin', '//evil.example/admin')).toBeNull();
  });
});
