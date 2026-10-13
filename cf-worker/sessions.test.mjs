// 跑法：cd cf-worker && npm test
// 重設登入碼 / 停用帳號 → 那個人其他裝置的登入失效；製作自己的登入留著（純函式 + 走一遍真的 worker 路由）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { freshDb } from './testing/d1-sqlite.mjs';
import worker from './worker.js';
import {
  SESSION_TTL_SEC, sessionIssuedAtSec, sessionTokenExp, sessionTokenHash, sessionAllowed,
  revokeSessionsUpdate, sessionIssueSec, deactivateDecision,
} from './sessions.mjs';

test('登入是什麼時候發的：到期時間 − 90 天', () => {
  assert.equal(SESSION_TTL_SEC, 90 * 24 * 3600);
  assert.equal(sessionIssuedAtSec(1_000_000 + SESSION_TTL_SEC), 1_000_000);
  assert.equal(sessionTokenExp('u_1.1777000000.sig'), 1777000000);
  assert.equal(sessionTokenExp('bad'), null);
  assert.equal(sessionTokenExp('a.b.c.d'), null);
});

test('切點：以前發的不算、之後發的算、留下來的那一個算', async () => {
  const user = { revokedAt: 1000, keepHash: 'keep' };
  assert.equal(await sessionAllowed({ issuedAtSec: 999 }, { revokedAt: null }), true);   // 沒重設過
  assert.equal(await sessionAllowed({ issuedAtSec: 999 }, user, async () => 'other'), false);
  assert.equal(await sessionAllowed({ issuedAtSec: 1000 }, user), true);
  assert.equal(await sessionAllowed({ issuedAtSec: 999 }, user, async () => 'keep'), true);
  assert.equal(await sessionAllowed({ issuedAtSec: NaN }, user), false);
  assert.equal(await sessionAllowed({ issuedAtSec: 999 }, { revokedAt: 1000, keepHash: null }, async () => 'keep'), false);
});

test('切點在下一秒；同一秒內重設後登入的也算數', () => {
  const now = 1_700_000_000_123;
  const r = revokeSessionsUpdate({ nowMs: now, targetUserId: 'u_b', actorUserId: 'u_admin', actorTokenHash: 'h' });
  assert.deepEqual(r, { revokedAt: 1_700_000_001, keepHash: null });
  const self = revokeSessionsUpdate({ nowMs: now, targetUserId: 'u_admin', actorUserId: 'u_admin', actorTokenHash: 'h' });
  assert.equal(self.keepHash, 'h');
  assert.equal(sessionIssueSec(now, r.revokedAt), 1_700_000_001);   // 同一秒內登入 → 算切點那一秒發的
  assert.equal(sessionIssueSec(now + 5000, r.revokedAt), 1_700_000_005);
  assert.equal(sessionIssueSec(now, null), 1_700_000_000);
});

test('停用：要登出；不能停用自己；重新啟用不用動', () => {
  assert.deepEqual(deactivateDecision({ targetUserId: 'u_b', actorUserId: 'u_a', deactivated: true }), { ok: true, revoke: true });
  assert.equal(deactivateDecision({ targetUserId: 'u_a', actorUserId: 'u_a', deactivated: true }).ok, false);
  assert.deepEqual(deactivateDecision({ targetUserId: 'u_a', actorUserId: 'u_a', deactivated: false }), { ok: true, revoke: false });
});

test('登入字串的雜湊是 SHA-256 hex', async () => {
  const h = await sessionTokenHash('abc');
  assert.equal(h, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

// ─── 走一遍真的路由 ───

const BASE = 'https://proxy.test';

async function setup() {
  const db = freshDb();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_admin', 'a@x.test', '製作', 'admin', 'ADMIN-CODE-1')`),
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_admin2', 'a2@x.test', '製作二', 'admin', 'ADMIN-CODE-2')`),
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_b', 'b@x.test', '阿凱', 'animator', 'ANIM-CODE-1')`),
    db.prepare(`INSERT INTO users (id, email, name, role) VALUES ('u_inv', 'i@x.test', '邀請來的', 'director')`),
  ]);
  const env = { DB: db, AUTH_SECRET: 'test-secret' };
  const call = (path, { token, method = 'GET', body } = {}) => worker.fetch(new Request(BASE + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  const login = async (code) => {
    const r = await call('/api/auth/login', { method: 'POST', body: { accessCode: code } });
    assert.equal(r.status, 200, `login ${code}`);
    return (await r.json()).token;
  };
  const me = async (token) => (await call('/api/auth/me', { token })).status;
  return { db, env, call, login, me };
}

/** 自己簽一個「幾秒前發的」登入字串（跟 worker.js newSessionToken 一樣的格式；同一秒登入兩次會拿到一模一樣的字串） */
function tokenIssuedAgo(userId, agoSec, secret = 'test-secret') {
  const exp = Math.floor(Date.now() / 1000) - agoSec + SESSION_TTL_SEC;
  const sig = createHmac('sha256', secret).update(`${userId}.${exp}`).digest('base64url');
  return `${userId}.${exp}.${sig}`;
}

test('製作重設某人的登入碼 → 那個人每台裝置都登出；用新的登入碼馬上可以登入；製作自己不受影響', async () => {
  const { call, login, me } = await setup();
  const admin = await login('ADMIN-CODE-1');
  const bPhone = await login('ANIM-CODE-1');
  const bLaptop = await login('ANIM-CODE-1');
  assert.equal(await me(bPhone), 200);

  const r = await call('/api/users/u_b/access-code', { token: admin, method: 'POST', body: {} });
  assert.equal(r.status, 200);
  const { accessCode } = await r.json();

  assert.equal(await me(bPhone), 401);
  assert.equal(await me(bLaptop), 401);
  assert.equal(await me(admin), 200);
  // 舊的登入碼不能登入了，新的可以（同一秒內也可以）
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { accessCode: 'ANIM-CODE-1' } })).status, 401);
  const bNew = await login(accessCode);
  assert.equal(await me(bNew), 200);
  // 別的 API 也一樣不認舊的
  assert.equal((await call('/api/projects', { token: bPhone })).status, 401);
  assert.equal((await call('/api/projects', { token: bNew })).status, 200);
});

test('製作重設自己的登入碼 → 自己這一個登入留著，其他裝置登出', async () => {
  const { call, login, me } = await setup();
  const here = await login('ADMIN-CODE-1');
  const otherDevice = tokenIssuedAgo('u_admin', 3600);   // 一小時前在別台電腦登入的
  assert.equal(await me(otherDevice), 200);
  const r = await call('/api/users/u_admin/access-code', { token: here, method: 'POST', body: {} });
  assert.equal(r.status, 200);
  assert.equal(await me(here), 200);
  assert.equal(await me(otherDevice), 401);
  // 留下的這一個還能繼續管理
  assert.equal((await call('/api/users', { token: here })).status, 200);
  // 再重設一次自己的：還是留著
  assert.equal((await call('/api/users/u_admin/access-code', { token: here, method: 'POST', body: {} })).status, 200);
  assert.equal(await me(here), 200);
});

test('另一個製作重設我的登入碼 → 我全部登出', async () => {
  const { call, login, me } = await setup();
  const a1 = await login('ADMIN-CODE-1');
  const a2 = await login('ADMIN-CODE-2');
  assert.equal((await call('/api/users/u_admin/access-code', { token: a2, method: 'POST', body: {} })).status, 200);
  assert.equal(await me(a1), 401);
  assert.equal(await me(a2), 200);
});

test('停用 → 登出；重新啟用後舊的登入不會活回來，要重新登入；不能停用自己', async () => {
  const { call, login, me } = await setup();
  const admin = await login('ADMIN-CODE-1');
  const b = await login('ANIM-CODE-1');
  assert.equal((await call('/api/users/u_b', { token: admin, method: 'PATCH', body: { deactivated: true } })).status, 200);
  assert.equal(await me(b), 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { accessCode: 'ANIM-CODE-1' } })).status, 403);
  assert.equal((await call('/api/users/u_b', { token: admin, method: 'PATCH', body: { deactivated: false } })).status, 200);
  assert.equal(await me(b), 401, '重新啟用不會讓舊的登入活回來');
  const b2 = await login('ANIM-CODE-1');
  assert.equal(await me(b2), 200);

  const self = await call('/api/users/u_admin', { token: admin, method: 'PATCH', body: { deactivated: true } });
  assert.equal(self.status, 400);
  assert.equal((await self.json()).error, '不能停用自己的帳號');
  assert.equal(await me(admin), 200);
  // 改名字之類的不會登出
  assert.equal((await call('/api/users/u_b', { token: admin, method: 'PATCH', body: { name: '阿凱凱' } })).status, 200);
  assert.equal(await me(b2), 200);
});

test('本來沒有登入碼的人（邀請連結進來的）第一次拿登入碼 → 不會被登出', async () => {
  const { db, env, call, login, me } = await setup();
  const admin = await login('ADMIN-CODE-1');
  // 假裝他用邀請連結登入過（拿到一個登入狀態）
  const tokenR = await worker.fetch(new Request(BASE + '/api/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: 'NOPE' }) }), env);
  assert.equal(tokenR.status, 401);
  await db.prepare(`UPDATE users SET access_code = 'TEMP-INV-1' WHERE id = 'u_inv'`).run();
  const inv = await login('TEMP-INV-1');
  await db.prepare(`UPDATE users SET access_code = NULL WHERE id = 'u_inv'`).run();
  assert.equal(await me(inv), 200);
  const r = await call('/api/users/u_inv/access-code', { token: admin, method: 'POST', body: {} });
  assert.equal(r.status, 200);
  assert.equal(await me(inv), 200);
  // 之後再重設 → 就會登出
  assert.equal((await call('/api/users/u_inv/access-code', { token: admin, method: 'POST', body: {} })).status, 200);
  assert.equal(await me(inv), 401);
});

test('從來沒重設過的人：以前發的登入照樣有效（舊的登入字串格式不變）', async () => {
  const { login, me } = await setup();
  const t = await login('ANIM-CODE-1');
  assert.equal(t.split('.').length, 3);
  assert.equal(await me(t), 200);
  assert.equal(await me(tokenIssuedAgo('u_b', 80 * 86400)), 200);   // 80 天前登入的也還有效
  assert.equal(await me(tokenIssuedAgo('u_b', 91 * 86400)), 401);   // 超過 90 天過期
});

test('重設以前一個小時登入的、同一個人另一台裝置也登出（不是只有同一秒的）', async () => {
  const { call, login, me } = await setup();
  const admin = await login('ADMIN-CODE-1');
  const old = tokenIssuedAgo('u_b', 3600);
  assert.equal(await me(old), 200);
  assert.equal((await call('/api/users/u_b/access-code', { token: admin, method: 'POST', body: {} })).status, 200);
  assert.equal(await me(old), 401);
});
