import { describe, expect, it } from 'vitest';
import { canAdjustStage, showAdjustSwitch } from './permissions';

describe('canAdjustStage：誰看得到「調整舞台」', () => {
  it('導演、這個專案的製作、全站製作 → 看得到', () => {
    expect(canAdjustStage({ projectRole: 'director', accountRole: 'director' })).toBe(true);
    expect(canAdjustStage({ projectRole: 'admin', accountRole: 'director' })).toBe(true);
    expect(canAdjustStage({ projectRole: null, accountRole: 'admin' })).toBe(true);
  });
  it('動畫師、沒有角色 → 看不到', () => {
    expect(canAdjustStage({ projectRole: 'animator', accountRole: 'animator' })).toBe(false);
    expect(canAdjustStage({ projectRole: null, accountRole: null })).toBe(false);
    expect(canAdjustStage({ projectRole: undefined, accountRole: 'animator' })).toBe(false);
  });
});

describe('showAdjustSwitch：切換鈕出不出現', () => {
  it('看得到 + Cue 庫模式 + 有機關 → 出現', () => {
    expect(showAdjustSwitch({ canAdjust: true, mode: 'library', hasMechanisms: true })).toBe(true);
  });
  it('不是 Cue 庫模式（舊的沿用模式 / 還沒讀到）→ 不出現', () => {
    expect(showAdjustSwitch({ canAdjust: true, mode: 'legacy', hasMechanisms: true })).toBe(false);
    expect(showAdjustSwitch({ canAdjust: true, mode: null, hasMechanisms: true })).toBe(false);
  });
  it('沒有機關、或看不到 → 不出現', () => {
    expect(showAdjustSwitch({ canAdjust: true, mode: 'library', hasMechanisms: false })).toBe(false);
    expect(showAdjustSwitch({ canAdjust: false, mode: 'library', hasMechanisms: true })).toBe(false);
  });
});
