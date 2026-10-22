import { describe, expect, it } from 'vitest';
import {
  CUSTOM_CODE_MAX, CUSTOM_CODE_MIN, WEAK_CODE_SUMMARY, checkCustomCode, containsName, isAllSameChar, isPlainSequence, isRepeatedChunk, normalizeCode,
} from './loginCodeRules';

describe('自己設定登入碼：硬規則', () => {
  it('6～32 個字，小寫和空白會先整理成大寫（跟登入一樣）', () => {
    expect(CUSTOM_CODE_MIN).toBe(6);
    expect(CUSTOM_CODE_MAX).toBe(32);
    const r = checkCustomCode(' tulip river 93 ');
    expect(r.ok).toBe(true);
    expect(r.code).toBe('TULIPRIVER93');
    expect(checkCustomCode('k7m2p').ok).toBe(false);
    expect(checkCustomCode('k7m2pq').ok).toBe(true);
    expect(checkCustomCode('a1b2c3d4'.repeat(4)).ok).toBe(true);
    expect(checkCustomCode('a1b2c3d4'.repeat(4) + 'x').ok).toBe(false);
    expect(checkCustomCode('').ok).toBe(false);
    expect(checkCustomCode(null).ok).toBe(false);
  });

  it('只能英文字母、數字、連字號', () => {
    for (const bad of ['ab_cd12', 'ab.cd12', 'ab@cd12', '小明小明小明', 'ab*cd12']) {
      const r = checkCustomCode(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('英文字母、數字和連字號');
    }
    expect(checkCustomCode('mina-2026').ok).toBe(true);
  });

  it('全部同一個字、單純往上或往下數的連續字，直接擋', () => {
    for (const bad of ['aaaaaa', '111111', '000000', 'ZZZZZZZZ']) {
      const r = checkCustomCode(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error).toContain('同一個字');
    }
    for (const bad of ['123456', 'abcdef', '654321', 'fedcba', '0123456789', '9876543210']) {
      const r = checkCustomCode(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error).toContain('連續');
    }
    for (const ok of ['123457', 'abcdeg', '12345a', 'a1b2c3', 'ab-cd-ef']) expect(checkCustomCode(ok).ok, ok).toBe(true);
    expect(isAllSameChar('aaaaaa')).toBe(true);
    expect(isPlainSequence('12-34')).toBe(false);
  });
});

describe('自己設定登入碼：只提醒、不擋', () => {
  it('用名字當登入碼：允許，只提醒一句（mina 可以用 minamina）', () => {
    const r = checkCustomCode('minamina', { name: 'mina' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toEqual(['用名字當登入碼比較容易被猜到']);
    expect(containsName('MINA2026', 'Mina')).toBe(true);
    expect(containsName('LINSTAGE9', 'Mina Lin')).toBe(true);
    expect(containsName('K7M2PQXR', '王小明')).toBe(false);
    expect(containsName('MINAMINA', null)).toBe(false);
  });

  it('太短、全數字、重複的樣子、常見的字：提醒', () => {
    const w = (code: string) => { const r = checkCustomCode(code); return r.ok ? r.warnings.join('|') : ''; };
    expect(w('k7m2pq')).toContain('6 個字');
    expect(w('13572468')).toContain('只有數字');
    expect(w('abcabc')).toContain('重複');
    expect(w('password')).toContain('很常見');
    expect(w('tulip-River-93')).toBe('');
    expect(isRepeatedChunk('abcabc')).toBe(true);
    expect(isRepeatedChunk('abcabd')).toBe(false);
    expect(WEAK_CODE_SUMMARY).toContain('太短或太好猜');
  });

  it('整理方式跟登入完全一樣', () => {
    expect(normalizeCode('  ab cd\tef ')).toBe('ABCDEF');
    expect(normalizeCode(null)).toBe('');
  });
});
