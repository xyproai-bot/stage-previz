import { describe, expect, it } from 'vitest';
import { ROLE_LABEL, roleLabel } from './roleLabels';

describe('角色顯示名稱', () => {
  it('三個角色用統一的中文', () => {
    expect(ROLE_LABEL).toEqual({ admin: '製作', animator: '動畫師', director: '導演' });
  });

  it('留言的舊角色代號 designer / 不認得的都顯示成「製作」', () => {
    expect(roleLabel('animator')).toBe('動畫師');
    expect(roleLabel('director')).toBe('導演');
    expect(roleLabel('admin')).toBe('製作');
    expect(roleLabel('designer')).toBe('製作');
    expect(roleLabel(undefined)).toBe('製作');
  });
});
