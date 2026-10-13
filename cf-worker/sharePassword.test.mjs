// 跑法：cd cf-worker && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashSharePassword, verifySharePassword, shareLinkHasPassword, shareCredential,
  signShareAccess, verifyShareAccess, timingSafeEqualStr, SHARE_PBKDF2_ITERATIONS, SHARE_ACCESS_TTL_MS,
} from './sharePassword.mjs';

const SECRET = 'test-secret';

test('密碼存成加鹽雜湊，不是明文；同一個密碼每條連結的雜湊都不一樣', async () => {
  const a = await hashSharePassword('jinma2026');
  const b = await hashSharePassword('jinma2026');
  assert.match(a.hash, new RegExp(`^pbkdf2-sha256\\$${SHARE_PBKDF2_ITERATIONS}\\$`));
  assert.ok(!a.hash.includes('jinma2026'));
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
});

test('密碼對 / 錯', async () => {
  const { hash, salt } = await hashSharePassword('jinma2026', { iterations: 1000 });
  const link = { password_hash: hash, password_salt: salt, password: null };
  assert.deepEqual(await verifySharePassword('jinma2026', link), { ok: true });
  assert.deepEqual(await verifySharePassword('jinma2025', link), { ok: false });
  assert.deepEqual(await verifySharePassword('', link), { ok: false });
  assert.equal(shareLinkHasPassword(link), true);
});

test('同樣的鹽 + 次數 → 同樣的雜湊（給一次性轉換用）', async () => {
  const a = await hashSharePassword('pw', { iterations: 1000 });
  const b = await hashSharePassword('pw', { iterations: 1000, salt: a.salt });
  assert.equal(a.hash, b.hash);
});

test('舊的明文密碼還能用，並且標記要換成雜湊', async () => {
  const legacy = { password: 'old-pass', password_hash: null };
  assert.deepEqual(await verifySharePassword('old-pass', legacy), { ok: true, legacy: true });
  assert.deepEqual(await verifySharePassword('old-pas', legacy), { ok: false, legacy: true });
  assert.equal(shareLinkHasPassword(legacy), true);
  assert.equal(shareLinkHasPassword({ password: null, password_hash: null }), false);
});

test('雜湊格式壞掉 → 一律不通過', async () => {
  assert.deepEqual(await verifySharePassword('x', { password_hash: 'plain', password_salt: 'AA==' }), { ok: false });
  assert.deepEqual(await verifySharePassword('x', { password_hash: 'pbkdf2-sha256$5$AAAA', password_salt: 'AA==' }), { ok: false });
});

test('通行證：簽了就能用；過期、換連結、換密碼、改內容都不行', async () => {
  const now = 1_800_000_000_000;
  const credential = 'pbkdf2-sha256$1000$abc';
  const { token, expiresAt } = await signShareAccess(SECRET, { linkToken: 'tok1', credential, now });
  assert.equal(expiresAt, now + SHARE_ACCESS_TTL_MS);
  const v = (o) => verifyShareAccess(SECRET, { linkToken: 'tok1', credential, token, now: now + 1000, ...o });
  assert.equal(await v({}), true);
  assert.equal(await v({ now: expiresAt }), false);                    // 到期
  assert.equal(await v({ linkToken: 'tok2' }), false);                 // 別條連結
  assert.equal(await v({ credential: 'pbkdf2-sha256$1000$xyz' }), false); // 密碼換了
  assert.equal(await v({ token: token.replace(/^\d+/, String(expiresAt + 9e6)) }), false); // 偷改到期時間
  assert.equal(await v({ token: 'garbage' }), false);
  assert.equal(await verifyShareAccess('other-secret', { linkToken: 'tok1', credential, token, now }), false);
});

test('舊明文連結的通行證不會把明文放進去', async () => {
  const c = await shareCredential({ password: 'old-pass' });
  assert.ok(c.startsWith('legacy$'));
  assert.ok(!c.includes('old-pass'));
  assert.equal(await shareCredential({ password_hash: 'h' }), 'h');
  assert.equal(await shareCredential({}), '');
});

test('timingSafeEqualStr', () => {
  assert.equal(timingSafeEqualStr('abc', 'abc'), true);
  assert.equal(timingSafeEqualStr('abc', 'abd'), false);
  assert.equal(timingSafeEqualStr('abc', 'abcd'), false);
  assert.equal(timingSafeEqualStr('', ''), true);
});
