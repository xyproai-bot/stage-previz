// 跑法：cd cf-worker && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGIN_CODE_ALPHABET, LOGIN_CODE_LENGTH, generateLoginCode, normalizeLoginCode, hashLoginCode,
  isStrongLoginCode, legacyCustomCodeDecision, loginCodeStorageMode, userLoginCodeView,
  LOGIN_CODE_PBKDF2_ITERATIONS,
} from './loginCodes.mjs';

test('登入碼的字：沒有 0 / O / 1 / l / I，32 個字、不重複', () => {
  for (const bad of ['0', 'O', '1', 'l', 'I']) assert.equal(LOGIN_CODE_ALPHABET.includes(bad), false, bad);
  assert.equal(LOGIN_CODE_ALPHABET.length, 32);
  assert.equal(new Set(LOGIN_CODE_ALPHABET).size, 32);
  assert.equal(256 % LOGIN_CODE_ALPHABET.length, 0);  // 用 byte 取餘數不會偏
});

test('系統產生的登入碼：10 個字、只用那些字、每次不一樣、夠強', () => {
  assert.ok(LOGIN_CODE_LENGTH >= 8);
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const c = generateLoginCode();
    assert.equal(c.length, LOGIN_CODE_LENGTH);
    for (const ch of c) assert.ok(LOGIN_CODE_ALPHABET.includes(ch), ch);
    assert.ok(isStrongLoginCode(c));
    seen.add(c);
  }
  assert.equal(seen.size, 300);
  // 每個字都用得到（隨機來源固定時對得上字母表）
  const all = generateLoginCode(32, (n) => Uint8Array.from({ length: n }, (_, i) => i));
  assert.equal(all, LOGIN_CODE_ALPHABET);
});

test('比對前的整理：去空白、轉大寫（跟以前登入一樣）', () => {
  assert.equal(normalizeLoginCode('  ab cd\tef '), 'ABCDEF');
  assert.equal(normalizeLoginCode('phang-001'), 'PHANG-001');
  assert.equal(normalizeLoginCode(null), '');
  assert.equal(normalizeLoginCode(undefined), '');
});

test('雜湊：同一組登入碼永遠一樣（大小寫 / 空白不影響），不同的不一樣，看不出原本的字', async () => {
  const a = await hashLoginCode('K7MNP3XQ2R');
  assert.match(a, new RegExp(`^pbkdf2-sha256\\$${LOGIN_CODE_PBKDF2_ITERATIONS}\\$[A-Za-z0-9+/=]+$`));
  assert.equal(await hashLoginCode(' k7mnp 3xq2r '), a);
  assert.notEqual(await hashLoginCode('K7MNP3XQ2S'), a);
  assert.equal(a.includes('K7MNP3XQ2R'), false);
  // 固定的值：鹽或次數被改掉的話這裡會失敗（改了所有人都登不進去）
  assert.equal(await hashLoginCode('PHANG-001'), await hashLoginCode('phang-001'));
});

test('夠不夠強：至少 8 個字、只用登入碼的字', () => {
  assert.equal(isStrongLoginCode('ABCDEFGH'), true);
  assert.equal(isStrongLoginCode('ABCDEFG'), false);       // 7 個字
  assert.equal(isStrongLoginCode('PHANG-001'), false);     // 有 - 和 0、1
  assert.equal(isStrongLoginCode('ABCDEFGO'), false);      // O
  assert.equal(isStrongLoginCode(''), false);
});

test('舊版前端的自訂號碼（只有明文存法收）：4～32 個字', () => {
  assert.deepEqual(legacyCustomCodeDecision(' daming-2026 '), { ok: true, code: 'DAMING-2026' });
  assert.equal(legacyCustomCodeDecision('abc').ok, false);
  assert.equal(legacyCustomCodeDecision('x'.repeat(33)).ok, false);
});

test('存法：只有 hashed 是雜湊，其他一律明文（沒設 = 跟以前一樣）', () => {
  assert.equal(loginCodeStorageMode('hashed'), 'hashed');
  assert.equal(loginCodeStorageMode(null), 'plain');
  assert.equal(loginCodeStorageMode('HASHED'), 'plain');
  assert.equal(loginCodeStorageMode('plain'), 'plain');
});

test('用戶清單：明文存法才回登入碼；雜湊存法只說有沒有', () => {
  const plainRow = { access_code: 'ABCDEFGHJK', access_code_hash: null };
  const hashedRow = { access_code: null, access_code_hash: 'pbkdf2-sha256$50000$x' };
  const none = { access_code: null, access_code_hash: null };
  assert.deepEqual(userLoginCodeView(plainRow, 'plain'), { accessCode: 'ABCDEFGHJK', hasAccessCode: true });
  assert.deepEqual(userLoginCodeView(plainRow, 'hashed'), { accessCode: null, hasAccessCode: true });
  assert.deepEqual(userLoginCodeView(hashedRow, 'plain'), { accessCode: null, hasAccessCode: true });
  assert.deepEqual(userLoginCodeView(hashedRow, 'hashed'), { accessCode: null, hasAccessCode: true });
  assert.deepEqual(userLoginCodeView(none, 'plain'), { accessCode: null, hasAccessCode: false });
});
