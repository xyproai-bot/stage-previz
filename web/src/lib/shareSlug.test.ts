import { describe, it, expect } from 'vitest';
import {
  SLUG_MAX_LEN, SLUG_SUFFIX_ALPHABET, SLUG_SUFFIX_LEN, RESERVED_SLUGS,
  composeSlug, isValidSlug, looksLikeShareToken, normalizeSlugInput, randomSlugSuffix,
  slugBaseFromName, slugProblem, slugProblemMessage, splitSlug,
} from './shareSlug';

describe('normalizeSlugInput', () => {
  it('大寫轉小寫、前後空白去掉、空白和底線變成 -', () => {
    expect(normalizeSlugInput('  JinMa 2026_Final ')).toBe('jinma-2026-final');
    expect(normalizeSlugInput('a  b')).toBe('a-b');
  });
  it('全形英數字轉半形', () => {
    expect(normalizeSlugInput('ＪＩＮＭＡ２０２６')).toBe('jinma2026');
  });
  it('不合法的字不偷刪（讓檢查說哪裡不對）', () => {
    expect(normalizeSlugInput('金馬2026')).toBe('金馬2026');
    expect(normalizeSlugInput('a/b')).toBe('a/b');
  });
  it('不是字串 → 空字串', () => {
    expect(normalizeSlugInput(undefined)).toBe('');
    expect(normalizeSlugInput(null)).toBe('');
    expect(normalizeSlugInput(123)).toBe('');
  });
});

describe('slugProblem', () => {
  it('合法的', () => {
    for (const s of ['jinma2026-k7p2', 'abc', '2026', 'a-b-c', 'a--b', 'x'.repeat(SLUG_MAX_LEN)]) {
      expect(slugProblem(s), s).toBeNull();
      expect(isValidSlug(s)).toBe(true);
    }
  });
  it('長度', () => {
    expect(slugProblem('')).toBe('empty');
    expect(slugProblem('ab')).toBe('too_short');
    expect(slugProblem('x'.repeat(SLUG_MAX_LEN + 1))).toBe('too_long');
  });
  it('只能小寫英數字和 -', () => {
    expect(slugProblem('JinMa')).toBe('bad_chars');
    expect(slugProblem('金馬2026')).toBe('bad_chars');
    expect(slugProblem('a_b_c')).toBe('bad_chars');
    expect(slugProblem('a.b.c')).toBe('bad_chars');
    expect(slugProblem('a/bc')).toBe('bad_chars');
    expect(slugProblem('abc ')).toBe('bad_chars');
  });
  it('開頭要英數字、結尾不能是 -', () => {
    expect(slugProblem('-abc')).toBe('bad_start');
    expect(slugProblem('abc-')).toBe('bad_end');
  });
  it('保留字', () => {
    for (const s of ['admin', 'api', 'share', 'login', 'new', 'settings', 'studio', 'preview']) {
      expect(slugProblem(s), s).toBe('reserved');
    }
    expect(RESERVED_SLUGS.has('s')).toBe(true);
    // 保留字只擋「整個一模一樣」
    expect(slugProblem('admin-2026')).toBeNull();
    expect(slugProblem('new-show')).toBeNull();
  });
  it('長得像舊式連結碼（32 個 0-9a-f）→ 不行；其他 32 字的可以', () => {
    const tokenLike = '0123456789abcdef0123456789abcdef';
    expect(looksLikeShareToken(tokenLike)).toBe(true);
    expect(slugProblem(tokenLike)).toBe('looks_like_token');
    expect(slugProblem('0123456789abcdef0123456789abcdeg')).toBeNull();
    expect(slugProblem('0123456789abcdef0123456789abcde')).toBeNull();   // 31 字
    expect(slugProblem('0123456789abcdef0123456789abcdef0')).toBeNull(); // 33 字
  });
  it('每種問題都有中文說明', () => {
    const problems = ['empty', 'too_short', 'too_long', 'bad_chars', 'bad_start', 'bad_end', 'reserved', 'looks_like_token'] as const;
    for (const p of problems) expect(slugProblemMessage(p, 'admin').length).toBeGreaterThan(3);
    expect(slugProblemMessage('reserved', 'admin')).toContain('admin');
  });
});

describe('slugBaseFromName', () => {
  it('英文名稱 → 小寫加 -', () => {
    expect(slugBaseFromName('Golden Horse 2026')).toBe('golden-horse-2026');
    expect(slugBaseFromName('  Jinma—2026!! ')).toBe('jinma-2026');
    expect(slugBaseFromName('Café Tour')).toBe('cafe-tour');
  });
  it('中英混合 → 留英數字', () => {
    expect(slugBaseFromName('金馬 2026')).toBe('2026');
    expect(slugBaseFromName('金馬獎 Jinma 2026 彩排')).toBe('jinma-2026');
  });
  it('全中文 / 空的 → stage', () => {
    expect(slugBaseFromName('金馬獎')).toBe('stage');
    expect(slugBaseFromName('')).toBe('stage');
  });
  it('太長會切短，留位置給隨機碼，切完不會以 - 結尾', () => {
    const base = slugBaseFromName('a'.repeat(30) + ' ' + 'b'.repeat(30));
    expect(base.length).toBeLessThanOrEqual(SLUG_MAX_LEN - SLUG_SUFFIX_LEN - 1);
    expect(base.endsWith('-')).toBe(false);
    expect(slugProblem(composeSlug(base, 'k7p2'))).toBeNull();
  });
});

describe('randomSlugSuffix', () => {
  it('4 個字、都在字母表裡、沒有容易看錯的字', () => {
    for (let i = 0; i < 200; i++) {
      const s = randomSlugSuffix();
      expect(s).toHaveLength(SLUG_SUFFIX_LEN);
      for (const ch of s) expect(SLUG_SUFFIX_ALPHABET).toContain(ch);
      expect(s).not.toMatch(/[0o1li]/);
    }
  });
  it('字母表沒有 0 o 1 l i', () => {
    expect(SLUG_SUFFIX_ALPHABET).not.toMatch(/[0o1li]/);
  });
  it('超出整除範圍的亂數會丟掉重抽（每個字機率一樣）', () => {
    // 31 個字：248 以上要丟掉；給 [255, 250, 0, 1, 30, 31] → 取 0,1,30,31 → a b 9 a
    const queue = [255, 250, 0, 1, 30, 31, 0, 0];
    const fake = (n: number) => new Uint8Array(queue.splice(0, n));
    expect(randomSlugSuffix(fake)).toBe('ab9a');
  });
  it('亂數不夠時會再抽一次', () => {
    let calls = 0;
    const allBad = (n: number) => { calls++; return new Uint8Array(n).fill(calls === 1 ? 255 : 2); };
    expect(randomSlugSuffix(allBad)).toBe('cccc');
    expect(calls).toBe(2);
  });
});

describe('composeSlug / splitSlug', () => {
  it('名稱 + 隨機碼', () => {
    expect(composeSlug('jinma2026', 'k7p2')).toBe('jinma2026-k7p2');
    expect(composeSlug('JinMa 2026', 'k7p2')).toBe('jinma-2026-k7p2');
  });
  it('不加隨機碼 → 就是名稱', () => {
    expect(composeSlug('jinma2026', null)).toBe('jinma2026');
    expect(composeSlug('jinma2026', '')).toBe('jinma2026');
  });
  it('名稱太長 → 切短到加上隨機碼剛好 40 字', () => {
    const s = composeSlug('x'.repeat(60), 'k7p2');
    expect(s).toHaveLength(SLUG_MAX_LEN);
    expect(s.endsWith('-k7p2')).toBe(true);
    expect(slugProblem(s)).toBeNull();
  });
  it('名稱空的 → 只剩隨機碼（太短，檢查會擋）', () => {
    expect(composeSlug('', 'k7p2')).toBe('k7p2');
  });
  it('拆回名稱 + 隨機碼', () => {
    expect(splitSlug('jinma2026-k7p2')).toEqual({ base: 'jinma2026', suffix: 'k7p2' });
    expect(splitSlug('my-show-2026')).toEqual({ base: 'my-show-2026', suffix: null }); // 2026 有 0，不是隨機碼
    expect(splitSlug('jinma2026')).toEqual({ base: 'jinma2026', suffix: null });
    expect(splitSlug('k7p2')).toEqual({ base: 'k7p2', suffix: null });
  });
  it('組起來再拆開會一樣', () => {
    for (let i = 0; i < 50; i++) {
      const suffix = randomSlugSuffix();
      expect(splitSlug(composeSlug('jinma2026', suffix))).toEqual({ base: 'jinma2026', suffix });
    }
  });
});
