// 跑法：cd cf-worker && npm test
// 自己設定登入碼（新增用戶、重設、修改我的登入碼）：
//   - 規則（6～32 個字、英文數字連字號、不分大小寫、擋全部同一個字 / 連續的字；名字只提醒不擋）
//   - 不能跟別人重複（跟登入查人的同一招：雜湊 + 索引；連還沒換成雜湊的舊明文一起查）
//   - 'hashed' 存法：自己設定的也只存雜湊、不存明文，跟系統產生的一樣
//   - 誰能做：別人的只有全站製作；自己的每個人都能改（要先輸入現在的）
//   - 防猜：撞到別人的 / 現在的登入碼打錯，15 分鐘 10 次就鎖；登入本身的防猜照舊
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SESSION_TTL_SEC } from './sessions.mjs';
import { freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import {
  hashLoginCode, loginCodeRequest, checkCustomCode, safeEqual, currentCodeMatches, hasLoginCode, codeProbeKey,
  CODE_IN_USE_MESSAGE, CURRENT_CODE_WRONG_MESSAGE,
} from './loginCodes.mjs';
import { containsName, isAllSameChar, isPlainSequence, isRepeatedChunk, normalizeCode } from '../web/src/lib/loginCodeRules.ts';
import { normalizeLoginCode } from './loginCodes.mjs';

const BASE = 'https://proxy.test';

/** 自己簽一個「幾秒前發的」登入字串（另一台裝置的登入；同一秒登入兩次會是一模一樣的字串，所以要往前推） */
function tokenIssuedAgo(userId, agoSec, secret = 'test-secret') {
  const exp = Math.floor(Date.now() / 1000) - agoSec + SESSION_TTL_SEC;
  const sig = createHmac('sha256', secret).update(`${userId}.${exp}`).digest('base64url');
  return `${userId}.${exp}.${sig}`;
}

// ─── 規則 ───

test('規則：6～32 個字、只能英文字母數字連字號，小寫 / 空白會先整理（跟登入一樣）', () => {
  const spaced = checkCustomCode(' mina mina ');
  assert.equal(spaced.ok, true);
  assert.equal(spaced.code, 'MINAMINA');
  assert.equal(checkCustomCode('Stage-2026').ok, true);
  assert.equal(checkCustomCode('a1b2c3d4'.repeat(4)).ok, true);          // 32 個字
  assert.equal(checkCustomCode('a1b2c3d4'.repeat(4) + 'x').ok, false);   // 33 個字
  for (const short of ['', '   ', 'ab1', 'k7m2p']) {
    assert.equal(checkCustomCode(short).ok, false, short);
  }
  assert.equal(checkCustomCode('k7m2pq').ok, true);                      // 剛好 6 個字
  for (const bad of ['ab 12*45', 'ab_cd12', '小明小明小明', 'ab.cd12', 'ab@cd12', 'ab/cd12']) {
    const r = checkCustomCode(bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.error, /英文字母、數字和連字號/);
  }
  assert.equal(checkCustomCode(null).ok, false);
  assert.equal(checkCustomCode(undefined).ok, false);
  assert.equal(checkCustomCode(135792468).ok, true);                     // 數字也行（轉成字串）
  // 整理方式跟登入的 normalizeLoginCode 完全一樣
  for (const raw of ['  ab cd\tef ', 'phang-001', 'x', '', null]) assert.equal(normalizeCode(raw), normalizeLoginCode(raw));
});

test('規則：全部同一個字、單純往上或往下數的連續字，直接擋', () => {
  for (const same of ['aaaaaa', '111111', '000000', 'ZZZZZZZZ', '------']) {
    const r = checkCustomCode(same);
    assert.equal(r.ok, false, same);
    assert.match(r.error, /同一個字/);
  }
  for (const seq of ['123456', '234567', '0123456789', 'abcdef', 'ABCDEFGH', 'uvwxyz', '654321', '987654', 'fedcba', 'zyxwvu', '9876543210']) {
    const r = checkCustomCode(seq);
    assert.equal(r.ok, false, seq);
    assert.match(r.error, /連續/);
  }
  // 不是單純的連續：照樣可以（最多提醒）
  for (const ok of ['123457', 'abcdeg', '12345a', '135791', 'a1b2c3', 'ab-cd-ef', '1-2-3-4']) {
    assert.equal(checkCustomCode(ok).ok, true, ok);
  }
  assert.equal(isAllSameChar('aa'), true);
  assert.equal(isAllSameChar('ab'), false);
  assert.equal(isPlainSequence('ABC123'), false);
  assert.equal(isPlainSequence('12-34'), false);
});

test('規則：名字只提醒、不擋（mina 可以用 minamina）；短的、全數字、重複的樣子也只提醒', () => {
  const mina = checkCustomCode('minamina', { name: 'mina' });
  assert.equal(mina.ok, true);
  assert.deepEqual(mina.warnings, ['用名字當登入碼比較容易被猜到']);   // 只提醒這一句，不再多唸「重複」
  assert.equal(checkCustomCode('MINA2026', { name: 'Mina' }).warnings.includes('用名字當登入碼比較容易被猜到'), true);
  // 名字的每個英文單字都算（Mina Lin → lin 也算）
  assert.equal(containsName('LINSTAGE9', 'Mina Lin'), true);
  assert.equal(containsName('SOMETHING9', 'Mina Lin'), false);
  // 中文名字不會出現在登入碼裡：不誤判
  assert.equal(containsName('K7M2PQXR', '王小明'), false);
  assert.equal(checkCustomCode('k7m2pqxr', { name: '王小明' }).warnings.length, 0);
  // 沒給名字就不比
  assert.equal(checkCustomCode('minamina').warnings.some(w => w.includes('名字')), false);
  // 其他提醒
  assert.equal(checkCustomCode('k7m2pq').warnings.some(w => w.includes('6 個字')), true);
  assert.equal(checkCustomCode('13572468').warnings.some(w => w.includes('只有數字')), true);
  assert.equal(checkCustomCode('abcabc12abc12').ok, true);
  assert.equal(checkCustomCode('abcabc').warnings.some(w => w.includes('重複')), true);
  assert.equal(isRepeatedChunk('abcabc'), true);
  assert.equal(isRepeatedChunk('abcabd'), false);
  assert.equal(checkCustomCode('password').warnings.some(w => w.includes('很常見')), true);
  assert.equal(checkCustomCode('QWERTY123').ok, true);
  // 夠長又亂的沒有提醒
  assert.deepEqual(checkCustomCode('tulip-River-93').warnings, []);
});

test('loginCodeRequest：沒填 = 系統產生；有填 = 自己設定（過了硬規則才收）', () => {
  assert.deepEqual(loginCodeRequest(''), { ok: true, custom: null });
  assert.deepEqual(loginCodeRequest(undefined), { ok: true, custom: null });
  assert.deepEqual(loginCodeRequest('   '), { ok: true, custom: null });
  assert.deepEqual(loginCodeRequest(' mina-mina '), { ok: true, custom: 'MINA-MINA' });
  const bad = loginCodeRequest('12345');
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.equal(loginCodeRequest('111111').ok, false);
  assert.equal(loginCodeRequest('abcdef').ok, false);
});

test('比對工具：safeEqual / currentCodeMatches / hasLoginCode / codeProbeKey', async () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual(null, undefined), true);
  assert.equal(await currentCodeMatches({ access_code: 'PHANG-001' }, ' phang-001 '), true);
  assert.equal(await currentCodeMatches({ access_code: 'PHANG-001' }, 'phang-002'), false);
  assert.equal(await currentCodeMatches({ access_code_hash: await hashLoginCode('minamina') }, 'MINAMINA'), true);
  assert.equal(await currentCodeMatches({ access_code_hash: await hashLoginCode('minamina') }, 'minamino'), false);
  assert.equal(await currentCodeMatches({ access_code: null, access_code_hash: null }, 'anything'), false);
  assert.equal(await currentCodeMatches({ access_code: 'X' }, ''), false);
  assert.equal(hasLoginCode({ access_code: 'A' }), true);
  assert.equal(hasLoginCode({ access_code_hash: 'h' }), true);
  assert.equal(hasLoginCode({}), false);
  assert.equal(codeProbeKey('u_1', '1.2.3.4'), 'codeset:u_1:1.2.3.4');
  // 登入防猜用的 key 是純 IP，兩邊不會混在一起
  assert.equal(codeProbeKey('u_1', '1.2.3.4').startsWith('codeset:'), true);
});

// ─── 路由 ───

async function setup({ hashed = false } = {}) {
  const db = freshDb();
  if (hashed) await db.prepare(`INSERT INTO app_settings (key, value) VALUES ('login_code_storage', 'hashed')`).run();
  const users = [
    ['u_admin', '陳製作', 'admin', 'ADMIN-001'],
    ['u_pm', '阿宏', 'animator', 'PM-CODE-1'],         // p1 的製作（帳號是動畫師）
    ['u_ani', 'mina', 'animator', 'ANIMATOR-1'],
    ['u_dir', '王導', 'director', 'DIRECTOR-1'],
    ['u_none', '沒有登入碼的人', 'animator', null],     // 用邀請連結進來的
  ];
  for (const [id, name, role, code] of users) {
    await db.prepare(`INSERT INTO users (id, email, name, role, access_code, access_code_hash) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, `${id}@x.test`, name, role, hashed || !code ? null : code, hashed && code ? await hashLoginCode(code) : null).run();
  }
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '金馬')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_pm', 'admin'), ('p1', 'u_ani', 'animator')`),
  ]);
  const env = { DB: db, AUTH_SECRET: 'test-secret', MODELS: memoryR2() };
  const fetchJson = async (headers, method, path, body) => {
    const r = await worker.fetch(new Request(BASE + path, {
      method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    let data = null;
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data, res: r };
  };
  const login = async (code, ip = '9.9.9.9') => fetchJson({ 'cf-connecting-ip': ip }, 'POST', '/api/auth/login', { accessCode: code });
  const tokens = {};
  for (const [id, , , code] of users) {
    if (!code) continue;
    tokens[id] = (await login(code)).data.token;
  }
  // 沒有登入碼的人靠邀請連結進來
  tokens.u_none = await (async () => {
    const mk = await fetchJson({ authorization: `Bearer ${tokens.u_admin}` }, 'POST', '/api/projects/p1/invites', { role: 'animator', userId: 'u_none' });
    const rd = await fetchJson({}, 'POST', '/api/invites/redeem', { token: mk.data.token });
    return rd.data.token;
  })();
  const call = (who, method, path, body, ip = '9.9.9.9') =>
    fetchJson({ ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), 'cf-connecting-ip': ip }, method, path, body);
  const row = async (id) => ({ ...(await db.prepare(`SELECT access_code, access_code_hash FROM users WHERE id = ?`).bind(id).first()) });
  return { db, env, call, login, row, tokens };
}

for (const hashed of [false, true]) {
  const mode = hashed ? '雜湊存法' : '明文存法';

  test(`[${mode}] 新增用戶可以自己設定登入碼，馬上登入得了；沒填就系統產生`, async () => {
    const { call, login, row } = await setup({ hashed });
    const made = await call('u_admin', 'POST', '/api/users', { name: 'mina2', role: 'animator', accessCode: ' Mina-Mina ' });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    assert.equal(made.data.accessCode, 'MINA-MINA');
    assert.equal(made.data.shownOnce, hashed);
    const stored = await row(made.data.id);
    if (hashed) {
      assert.equal(stored.access_code, null);                                   // 不存明文
      assert.equal(stored.access_code_hash, await hashLoginCode('MINA-MINA'));  // 跟系統產生的同一種雜湊
    } else {
      assert.equal(stored.access_code, 'MINA-MINA');
    }
    for (const typed of ['MINA-MINA', 'mina-mina', ' mina-mina ']) {
      const r = await login(typed);
      assert.equal(r.status, 200, typed);
      assert.equal(r.data.user.id, made.data.id);
    }
    // 沒填 = 系統產生（照舊）
    const auto = await call('u_admin', 'POST', '/api/users', { name: '自動的', role: 'animator' });
    assert.equal(auto.status, 201);
    assert.equal(auto.data.accessCode.length, 10);
  });

  test(`[${mode}] 規則不過就擋（400），沒有建立帳號；名字不擋`, async () => {
    const { call, db } = await setup({ hashed });
    const before = (await db.prepare(`SELECT COUNT(*) AS n FROM users`).first()).n;
    for (const bad of ['12345', '111111', 'aaaaaa', '123456', 'abcdef', '654321', 'ab cd*', 'x'.repeat(33)]) {
      const r = await call('u_admin', 'POST', '/api/users', { name: '新人', role: 'animator', accessCode: bad });
      assert.equal(r.status, 400, bad);
      assert.ok(r.data.error);
    }
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM users`).first()).n, before);
    // 用名字當登入碼：可以（只有前端提醒）
    const ok = await call('u_admin', 'POST', '/api/users', { name: 'mina', role: 'animator', accessCode: 'minamina' });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
  });

  test(`[${mode}] 不能跟別人的登入碼一樣（新增、重設、自己改都一樣），大小寫 / 空白不同也算一樣`, async () => {
    const { call, row } = await setup({ hashed });
    // 新增
    const dup = await call('u_admin', 'POST', '/api/users', { name: '撞到的', role: 'animator', accessCode: ' animator-1 ' });
    assert.equal(dup.status, 409);
    assert.equal(dup.data.error, CODE_IN_USE_MESSAGE);
    // 重設別人的
    const reset = await call('u_admin', 'POST', '/api/users/u_dir/access-code', { accessCode: 'pm-code-1' });
    assert.equal(reset.status, 409);
    assert.equal(reset.data.error, CODE_IN_USE_MESSAGE);
    // 改自己的
    const mine = await call('u_dir', 'POST', '/api/auth/change-code', { currentCode: 'DIRECTOR-1', newCode: 'ADMIN-001' });
    assert.equal(mine.status, 409);
    assert.equal(mine.data.error, CODE_IN_USE_MESSAGE);
    // 沒有人的登入碼被動到
    const dir = await row('u_dir');
    assert.equal(hashed ? dir.access_code_hash : dir.access_code, hashed ? await hashLoginCode('DIRECTOR-1') : 'DIRECTOR-1');
    // 重設成自己現在的（全站製作幫他重設成同一組）不算撞到別人
    const same = await call('u_admin', 'POST', '/api/users/u_dir/access-code', { accessCode: 'director-1' });
    assert.equal(same.status, 200);
  });

  test(`[${mode}] 重設別人的登入碼可以自己設定：舊的馬上不能用，其他裝置登出；沒填就系統產生`, async () => {
    const { call, login, row } = await setup({ hashed });
    const r = await call('u_admin', 'POST', '/api/users/u_ani/access-code', { accessCode: 'tulip-River-93' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.accessCode, 'TULIP-RIVER-93');
    assert.equal(r.data.shownOnce, hashed);
    assert.equal((await login('ANIMATOR-1')).status, 401);
    assert.equal((await login('tulip-river-93')).status, 200);
    // 舊的登入狀態失效
    assert.equal((await call('u_ani', 'GET', '/api/projects/p1/songs')).status, 401);
    const stored = await row('u_ani');
    assert.equal(hashed ? stored.access_code : stored.access_code_hash, null);
    // 規則不過
    assert.equal((await call('u_admin', 'POST', '/api/users/u_ani/access-code', { accessCode: '123456' })).status, 400);
    // 沒填 = 系統產生
    const auto = await call('u_admin', 'POST', '/api/users/u_ani/access-code', {});
    assert.equal(auto.status, 200);
    assert.equal(auto.data.accessCode.length, 10);
    assert.equal((await call('u_admin', 'POST', '/api/users/u_nobody/access-code', { accessCode: 'tulip-river-94' })).status, 404);
  });

  test(`[${mode}] 誰能做：別人的只有全站製作（專案的製作、導演、動畫師、沒登入都不行）`, async () => {
    const { call, row } = await setup({ hashed });
    const before = await row('u_dir');
    for (const who of ['u_pm', 'u_ani', 'u_dir']) {
      assert.equal((await call(who, 'POST', '/api/users/u_dir/access-code', { accessCode: 'tulip-river-93' })).status, 403, who);
      assert.equal((await call(who, 'POST', '/api/users', { name: 'x', role: 'animator', accessCode: 'tulip-river-93' })).status, 403, who);
    }
    assert.equal((await call(null, 'POST', '/api/users/u_dir/access-code', { accessCode: 'tulip-river-93' })).status, 401);
    assert.deepEqual(await row('u_dir'), before);
    // 改自己的要登入
    assert.equal((await call(null, 'POST', '/api/auth/change-code', { currentCode: 'x', newCode: 'tulip-river-93' })).status, 401);
  });

  test(`[${mode}] 修改我的登入碼：要先輸入現在的；改好之後新的能登入、舊的不行、這一台留著其他裝置登出`, async () => {
    const { call, login, row, tokens } = await setup({ hashed });
    // 現在的打錯 / 沒填
    const wrong = await call('u_ani', 'POST', '/api/auth/change-code', { currentCode: 'WRONG-CODE', newCode: 'mina-secret-7' });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.data.error, CURRENT_CODE_WRONG_MESSAGE);
    assert.equal((await call('u_ani', 'POST', '/api/auth/change-code', { newCode: 'mina-secret-7' })).status, 403);
    assert.equal((await login('mina-secret-7')).status, 401);
    // 新的不合規則
    assert.equal((await call('u_ani', 'POST', '/api/auth/change-code', { currentCode: 'animator-1', newCode: '123456' })).status, 400);
    assert.equal((await call('u_ani', 'POST', '/api/auth/change-code', { currentCode: 'animator-1', newCode: 'animator-1' })).status, 400);
    // 另一台裝置（5 秒前登入的）
    tokens.otherDevice = tokenIssuedAgo('u_ani', 5);
    assert.equal((await call('otherDevice', 'GET', '/api/auth/me')).status, 200);
    // 改好
    const ok = await call('u_ani', 'POST', '/api/auth/change-code', { currentCode: ' animator-1 ', newCode: 'mina-secret-7' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.accessCode, 'MINA-SECRET-7');
    assert.equal(ok.data.shownOnce, hashed);
    const stored = await row('u_ani');
    assert.equal(hashed ? stored.access_code : stored.access_code_hash, null);
    assert.equal(hashed ? stored.access_code_hash : stored.access_code, hashed ? await hashLoginCode('MINA-SECRET-7') : 'MINA-SECRET-7');
    assert.equal((await login('animator-1')).status, 401);
    assert.equal((await login('mina-secret-7')).status, 200);
    // 這一台還在，其他裝置登出
    assert.equal((await call('u_ani', 'GET', '/api/projects/p1/songs')).status, 200);
    assert.equal((await call('otherDevice', 'GET', '/api/auth/me')).status, 401);
  });

  test(`[${mode}] 修改我的登入碼：沒填新的 = 系統產生；專案的製作 / 導演也只能改自己的；全站製作改自己也要輸入現在的`, async () => {
    const { call, login } = await setup({ hashed });
    const auto = await call('u_pm', 'POST', '/api/auth/change-code', { currentCode: 'PM-CODE-1' });
    assert.equal(auto.status, 200);
    assert.equal(auto.data.accessCode.length, 10);
    assert.equal((await login('PM-CODE-1')).status, 401);
    assert.equal((await login(auto.data.accessCode)).status, 200);
    // 全站製作改自己
    assert.equal((await call('u_admin', 'POST', '/api/auth/change-code', { newCode: 'owner-secret-1' })).status, 403);
    const own = await call('u_admin', 'POST', '/api/auth/change-code', { currentCode: 'admin-001', newCode: 'owner-secret-1' });
    assert.equal(own.status, 200);
    assert.equal((await login('owner-secret-1')).status, 200);
    assert.equal((await login('ADMIN-001')).status, 401);
  });

  test(`[${mode}] 還沒有登入碼的人（用邀請連結進來的）設自己的登入碼，不用輸入現在的；設好之後這一台不會被登出`, async () => {
    const { call, login, row } = await setup({ hashed });
    const ok = await call('u_none', 'POST', '/api/auth/change-code', { newCode: 'invited-guest-5' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const stored = await row('u_none');
    assert.equal(hashed ? stored.access_code_hash : stored.access_code, hashed ? await hashLoginCode('INVITED-GUEST-5') : 'INVITED-GUEST-5');
    assert.equal((await login('invited-guest-5')).data.user.id, 'u_none');
    assert.equal((await call('u_none', 'GET', '/api/auth/me')).status, 200);
  });
}

test('雜湊存法：還沒換成雜湊的舊明文也算「有人在用」；自己設定的也不留明文', async () => {
  const { call, db, row } = await setup({ hashed: true });
  // 一個還沒換成雜湊的舊用戶（明文）
  await db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_legacy', 'l@x.test', '舊明文', 'animator', 'LEGACY-777')`).run();
  const dup = await call('u_admin', 'POST', '/api/users', { name: '撞舊的', role: 'animator', accessCode: 'legacy-777' });
  assert.equal(dup.status, 409);
  const made = await call('u_admin', 'POST', '/api/users', { name: '新的', role: 'animator', accessCode: 'fresh-secret-3' });
  assert.equal(made.status, 201);
  const stored = await row(made.data.id);
  assert.equal(stored.access_code, null);
  assert.ok(stored.access_code_hash.startsWith('pbkdf2-sha256$'));
  assert.equal(JSON.stringify(stored).includes('FRESH-SECRET-3'), false);
  // 整個資料庫裡的 users 表找不到這組明文
  const all = JSON.stringify((await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(made.data.id).all()).results);
  assert.equal(all.toUpperCase().includes('FRESH-SECRET-3'), false);
  // 用戶清單也不回登入碼
  const list = await call('u_admin', 'GET', '/api/users');
  assert.equal(JSON.stringify(list.data).toUpperCase().includes('FRESH-SECRET-3'), false);
  assert.equal(list.data.users.find(u => u.id === made.data.id).accessCode, null);
});

test('防猜：現在的登入碼連續打錯 10 次就鎖 15 分鐘（429），鎖住時就算打對也擋；不會鎖到登入', async () => {
  const { call, login, row } = await setup({ hashed: true });
  const before = await row('u_ani');
  for (let i = 0; i < 10; i++) {
    const r = await call('u_ani', 'POST', '/api/auth/change-code', { currentCode: `GUESS-${i}-ABC`, newCode: 'mina-secret-7' });
    assert.equal(r.status, 403, String(i));
  }
  const locked = await call('u_ani', 'POST', '/api/auth/change-code', { currentCode: 'ANIMATOR-1', newCode: 'mina-secret-7' });
  assert.equal(locked.status, 429);
  assert.match(locked.data.error, /分鐘後再試/);
  assert.ok(locked.data.retryAfterSec > 0);
  assert.deepEqual(await row('u_ani'), before);         // 鎖住時什麼都沒改
  // 登入沒被鎖到（登入的防猜另外算）
  assert.equal((await login('ANIMATOR-1')).status, 200);
  // 別人不受影響
  assert.equal((await call('u_dir', 'POST', '/api/auth/change-code', { currentCode: 'DIRECTOR-1', newCode: 'dir-secret-12' })).status, 200);
});

test('防猜：一直試別人的登入碼（撞到「已經有人在用」）也會被鎖；登入本身的防猜照舊（10 次錯鎖 429）', async () => {
  const { call, login } = await setup({ hashed: true });
  for (let i = 0; i < 10; i++) {
    const r = await call('u_dir', 'POST', '/api/auth/change-code', { currentCode: 'DIRECTOR-1', newCode: 'ADMIN-001' });
    assert.equal(r.status, 409, String(i));
  }
  const locked = await call('u_dir', 'POST', '/api/auth/change-code', { currentCode: 'DIRECTOR-1', newCode: 'ADMIN-001' });
  assert.equal(locked.status, 429);
  // 換成沒人用的也被鎖著（15 分鐘內不能再試）
  assert.equal((await call('u_dir', 'POST', '/api/auth/change-code', { currentCode: 'DIRECTOR-1', newCode: 'dir-secret-12' })).status, 429);
  // 全站製作幫他們設不受這個人的鎖影響（key 是「誰、從哪裡」）
  assert.equal((await call('u_admin', 'POST', '/api/users/u_dir/access-code', { accessCode: 'dir-secret-12' })).status, 200);
  // 登入的防猜：同一個 IP 打錯 10 次 → 429
  for (let i = 0; i < 10; i++) assert.equal((await login(`NOPE-${i}-XYZ`, '7.7.7.7')).status, 401);
  assert.equal((await login('DIR-SECRET-12', '7.7.7.7')).status, 429);
  assert.equal((await login('DIR-SECRET-12', '8.8.8.8')).status, 200);
});

test('速度：查重只算一次雜湊，用戶很多時也一樣（沒有一個一個驗證）', async () => {
  const { call, db } = await setup({ hashed: true });
  const hash = await hashLoginCode('FAKE-FILL-0');
  await db.batch(Array.from({ length: 300 }, (_, i) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code_hash) VALUES (?, ?, ?, 'animator', ?)`
  ).bind(`u_fill${i}`, `f${i}@x.test`, `填充${i}`, `${hash}-${i}`)));
  const t0 = performance.now();
  const r = await call('u_admin', 'POST', '/api/users', { name: '很多人之後', role: 'animator', accessCode: 'many-users-ok-9' });
  const ms = performance.now() - t0;
  assert.equal(r.status, 201);
  // 一次 PBKDF2（約 5ms）+ 幾個查詢；如果是一個一個驗證 300 個人會是 1.5 秒以上
  assert.ok(ms < 800, `花了 ${Math.round(ms)}ms`);
});
