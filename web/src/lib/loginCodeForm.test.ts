import { describe, expect, it } from 'vitest';
import { EMPTY_CHOICE, loginCodeFormState } from './loginCodeForm';

describe('登入碼輸入框：自動產生', () => {
  it('不用打字，隨時可以送出，不送登入碼（後台產生）', () => {
    expect(loginCodeFormState(EMPTY_CHOICE)).toEqual({ canSubmit: true, payload: undefined, error: null, warnings: [], weakSummary: null });
    // 之前在「自己設定」打過的字，切回自動就不算
    const s = loginCodeFormState({ mode: 'auto', value: '123456' });
    expect(s.canSubmit).toBe(true);
    expect(s.payload).toBeUndefined();
  });
});

describe('登入碼輸入框：自己設定', () => {
  it('還沒打字：不能送出，但不顯示紅字', () => {
    const s = loginCodeFormState({ mode: 'custom', value: '' });
    expect(s.canSubmit).toBe(false);
    expect(s.error).toBeNull();
    expect(loginCodeFormState({ mode: 'custom', value: '   ' }).error).toBeNull();
  });

  it('不合規則：不能送出，說原因', () => {
    for (const [v, part] of [['abc', '至少 6 個字'], ['111111', '同一個字'], ['abcdef', '連續'], ['654321', '連續'], ['ab_cd1234', '英文字母、數字和連字號']] as const) {
      const s = loginCodeFormState({ mode: 'custom', value: v });
      expect(s.canSubmit, v).toBe(false);
      expect(s.error, v).toContain(part);
      expect(s.payload).toBeUndefined();
    }
  });

  it('合規則：可以送出，送整理過的（大寫、去空白）', () => {
    const s = loginCodeFormState({ mode: 'custom', value: ' tulip-river-93 ' });
    expect(s.canSubmit).toBe(true);
    expect(s.payload).toBe('TULIP-RIVER-93');
    expect(s.error).toBeNull();
    expect(s.warnings).toEqual([]);
    expect(s.weakSummary).toBeNull();
  });

  it('太短、太好猜：照樣可以送出，只提醒', () => {
    const short = loginCodeFormState({ mode: 'custom', value: 'k7m2pq' });
    expect(short.canSubmit).toBe(true);
    expect(short.warnings.length).toBeGreaterThan(0);
    expect(short.weakSummary).toBe('太短或太好猜（像 123456、名字）別人容易猜到');
    expect(loginCodeFormState({ mode: 'custom', value: 'password' }).canSubmit).toBe(true);
  });

  it('用名字：不擋（mina 可以用 minamina），只提醒', () => {
    const s = loginCodeFormState({ mode: 'custom', value: 'minamina' }, { name: 'mina' });
    expect(s.canSubmit).toBe(true);
    expect(s.payload).toBe('MINAMINA');
    expect(s.warnings).toEqual(['用名字當登入碼比較容易被猜到']);
    // 沒告訴它名字就不提醒
    expect(loginCodeFormState({ mode: 'custom', value: 'minamina' }).warnings.some(w => w.includes('名字'))).toBe(false);
  });
});
