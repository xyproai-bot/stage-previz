// 跑法：cd cf-worker && npm test
// 用戶改自己的名字和頭像顏色（PATCH /api/auth/me）：走一遍真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1）。
//   只能改自己、只收名字和頭像顏色、其他欄位（角色、email、登入碼…）偷塞也不會改到；
//   名字規則跟全站製作改名 / 新增用戶是同一套（前後空白去掉、最多 80 字、不能空）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './testing/d1-sqlite.mjs';
import { cleanUserName, userNameProblem, cleanAvatarColor, planMyProfileUpdate, USER_NAME_MAX } from '../web/src/lib/userProfileRules.ts';
import worker from './worker.js';

const BASE = 'https://proxy.test';

// ─── 規則（前後台共用的那個檔） ───

test('名字：前後空白去掉、最多 80 字、不能是空的、一定要是文字', () => {
  assert.equal(cleanUserName('  小明  '), '小明');
  assert.equal(cleanUserName('a'.repeat(100)).length, USER_NAME_MAX);
  assert.equal(cleanUserName('a'.repeat(79) + ' ' + 'b'.repeat(10)), 'a'.repeat(79), '切在中間留下的空白也去掉');
  assert.equal(cleanUserName(null), '');
  assert.equal(userNameProblem('   '), '名字不能是空的');
  assert.equal(userNameProblem(''), '名字不能是空的');
  assert.equal(userNameProblem(12), '名字要是文字');
  assert.equal(userNameProblem(null), '名字要是文字');
  assert.equal(userNameProblem('阿凱'), null);
});

test('頭像顏色：#rrggbb（大小寫都收，存小寫）；其他一律不收', () => {
  assert.equal(cleanAvatarColor('#10c78a'), '#10c78a');
  assert.equal(cleanAvatarColor(' #FFAA44 '), '#ffaa44');
  for (const bad of ['', 'red', '#fff', '#12345', '#1234567', '10c78a', '#10c78g', 'url(x)', '#10c78a; background:red', 5, null, undefined]) {
    assert.equal(cleanAvatarColor(bad), null, String(bad));
  }
});

test('planMyProfileUpdate：只看名字和頭像顏色，其他欄位略過；有給卻不合格就整個不改', () => {
  assert.deepEqual(planMyProfileUpdate({ name: ' 新名字 ' }), { ok: true, name: '新名字' });
  assert.deepEqual(planMyProfileUpdate({ avatarColor: '#5294FF' }), { ok: true, avatarColor: '#5294ff' });
  assert.deepEqual(planMyProfileUpdate({ name: 'A', avatarColor: '#ff5470', role: 'admin', email: 'x@y.z', deactivated: true, id: 'u_x', accessCode: 'zzz' }),
    { ok: true, name: 'A', avatarColor: '#ff5470' });
  assert.equal(planMyProfileUpdate({ role: 'admin' }).ok, false, '只有偷塞的欄位 = 沒有要改的');
  assert.equal(planMyProfileUpdate({}).ok, false);
  assert.equal(planMyProfileUpdate(null).ok, false);
  assert.equal(planMyProfileUpdate([]).ok, false);
  assert.equal(planMyProfileUpdate({ name: '', avatarColor: '#ff5470' }).ok, false, '名字不合格，顏色也不改');
  assert.equal(planMyProfileUpdate({ name: 'A', avatarColor: 'red' }).ok, false, '顏色不合格，名字也不改');
});

// ─── 路由 ───

async function setup() {
  const db = freshDb();
  const users = [
    ['u_admin', '製作', 'admin', 'ADMIN-1'], ['u_dir', '王導', 'director', 'DIR-1'], ['u_a1', '阿凱', 'animator', 'ANI-1'], ['u_a2', '小美', 'animator', 'ANI-2'],
  ];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, avatar_color, access_code) VALUES (?, ?, ?, ?, '#10c78a', ?)`
  ).bind(id, `${id}@studio.example.com`, name, role, code)));
  const env = { DB: db, AUTH_SECRET: 'test-secret' };
  const tokens = {};
  for (const [id, , , code] of users) {
    const r = await worker.fetch(new Request(`${BASE}/api/auth/login`, {
      method: 'POST', body: JSON.stringify({ accessCode: code }), headers: { 'content-type': 'application/json' },
    }), env);
    tokens[id] = (await r.json()).token;
  }
  const call = async (who, method, path, body) => {
    const headers = { 'content-type': 'application/json' };
    if (who) headers.authorization = `Bearer ${tokens[who]}`;
    const r = await worker.fetch(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    let data = null;
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data };
  };
  const row = (id) => db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first();
  return { db, call, row };
}

test('自己改名字：改成功、前後空白去掉；重新讀 /api/auth/me 看得到新名字；登入沒有被登出', async () => {
  const { call, row } = await setup();
  const r = await call('u_a1', 'PATCH', '/api/auth/me', { name: '  凱凱  ' });
  assert.equal(r.status, 200, r.data?.error);
  assert.equal(r.data.user.name, '凱凱');
  assert.equal(r.data.user.id, 'u_a1');
  assert.equal(r.data.user.role, 'animator');
  assert.equal((await row('u_a1')).name, '凱凱');
  const me = await call('u_a1', 'GET', '/api/auth/me');
  assert.equal(me.status, 200, '同一個登入還能用');
  assert.equal(me.data.user.name, '凱凱');
  assert.equal(me.data.user.avatarColor, '#10c78a', '沒給的欄位不動');
});

test('自己換頭像顏色：存成小寫；名字沒動', async () => {
  const { call, row } = await setup();
  const r = await call('u_dir', 'PATCH', '/api/auth/me', { avatarColor: '#C264FF' });
  assert.equal(r.status, 200, r.data?.error);
  assert.equal(r.data.user.avatarColor, '#c264ff');
  const saved = await row('u_dir');
  assert.equal(saved.avatar_color, '#c264ff');
  assert.equal(saved.name, '王導');
  // 名字和顏色一起改
  const both = await call('u_dir', 'PATCH', '/api/auth/me', { name: '王大導', avatarColor: '#ffd84a' });
  assert.equal(both.status, 200);
  assert.deepEqual({ name: both.data.user.name, avatarColor: both.data.user.avatarColor }, { name: '王大導', avatarColor: '#ffd84a' });
});

test('每個角色都能改自己（製作、導演、動畫師）', async () => {
  const { call } = await setup();
  for (const [id, name] of [['u_admin', '製作二號'], ['u_dir', '導演二號'], ['u_a1', '動畫二號']]) {
    const r = await call(id, 'PATCH', '/api/auth/me', { name });
    assert.equal(r.status, 200, id);
    assert.equal(r.data.user.name, name);
  }
});

test('名字不合格就整個不改：空的、全空白、太長會切到 80 字、不是文字', async () => {
  const { call, row } = await setup();
  for (const bad of ['', '   ', null, 12, {}, ['x']]) {
    const r = await call('u_a1', 'PATCH', '/api/auth/me', { name: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await row('u_a1')).name, '阿凱');
  const long = await call('u_a1', 'PATCH', '/api/auth/me', { name: '字'.repeat(120) });
  assert.equal(long.status, 200);
  assert.equal([...long.data.user.name].length, 80);
  // 名字不合格 + 顏色合格：整個不改
  const mixed = await call('u_a2', 'PATCH', '/api/auth/me', { name: ' ', avatarColor: '#ff5470' });
  assert.equal(mixed.status, 400);
  assert.equal((await row('u_a2')).avatar_color, '#10c78a');
});

test('顏色不合格就擋掉（格式不對、不是文字）', async () => {
  const { call, row } = await setup();
  for (const bad of ['red', '#fff', '', 'url(javascript:alert(1))', '#10c78a;x', 5, null]) {
    const r = await call('u_a1', 'PATCH', '/api/auth/me', { avatarColor: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await row('u_a1')).avatar_color, '#10c78a');
});

test('偷塞別的欄位：角色、email、登入碼、停用、別人的 id 全部不收；只有偷塞的欄位 = 400', async () => {
  const { call, row } = await setup();
  const before = await row('u_a1');
  const r = await call('u_a1', 'PATCH', '/api/auth/me', {
    name: '改名而已', role: 'admin', email: 'evil@x.test', accessCode: 'HACK-1', access_code: 'HACK-2', deactivated: true,
    id: 'u_admin', userId: 'u_admin', sessions_revoked_at: 1,
  });
  assert.equal(r.status, 200, r.data?.error);
  assert.equal(r.data.user.role, 'animator');
  const after = await row('u_a1');
  assert.equal(after.name, '改名而已');
  assert.equal(after.role, 'animator');
  assert.equal(after.email, before.email);
  assert.equal(after.access_code, before.access_code);
  assert.equal(after.deactivated, 0);
  assert.equal(after.sessions_revoked_at, before.sessions_revoked_at);
  assert.equal((await row('u_admin')).name, '製作', '別人不受影響');

  const only = await call('u_a1', 'PATCH', '/api/auth/me', { role: 'admin' });
  assert.equal(only.status, 400);
  assert.equal((await row('u_a1')).role, 'animator');
  assert.equal((await call('u_a1', 'PATCH', '/api/auth/me', {})).status, 400);
  // 這一個登入還是動畫師，管理路由照樣進不去
  assert.equal((await call('u_a1', 'GET', '/api/users')).status, 403);
});

test('改別人被擋：非製作用 /api/users/:id 改別人、改自己的角色都是 403；製作照舊能改別人', async () => {
  const { call, row } = await setup();
  for (const who of ['u_a1', 'u_dir']) {
    assert.equal((await call(who, 'PATCH', '/api/users/u_a2', { name: '被改掉' })).status, 403, who);
    assert.equal((await call(who, 'PATCH', `/api/users/${who}`, { role: 'admin' })).status, 403, who);
  }
  assert.equal((await row('u_a2')).name, '小美');
  assert.equal((await call(null, 'PATCH', '/api/auth/me', { name: 'x' })).status, 401, '沒登入');
  const ok = await call('u_admin', 'PATCH', '/api/users/u_a2', { name: '  小美美  ', avatarColor: '#5294ff' });
  assert.equal(ok.status, 200, ok.data?.error);
  const saved = await row('u_a2');
  assert.equal(saved.name, '小美美', '製作改名也一樣去掉前後空白');
  assert.equal(saved.avatar_color, '#5294ff');
});

test('全站製作改名跟自己改名同一套：空的、全空白不收（以前會存成空名字）', async () => {
  const { call, row } = await setup();
  for (const bad of ['', '   ']) {
    assert.equal((await call('u_admin', 'PATCH', '/api/users/u_a2', { name: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await row('u_a2')).name, '小美');
  const created = await call('u_admin', 'POST', '/api/users', { name: '  新同事  ', role: 'animator' });
  assert.equal(created.status, 201, created.data?.error);
  assert.equal((await row(created.data.id)).name, '新同事');
  assert.equal((await call('u_admin', 'POST', '/api/users', { name: '   ', role: 'animator' })).status, 400);
});

test('停用的人拿著舊登入也改不了', async () => {
  const { call, row } = await setup();
  assert.equal((await call('u_admin', 'PATCH', '/api/users/u_a2', { deactivated: true })).status, 200);
  const r = await call('u_a2', 'PATCH', '/api/auth/me', { name: '偷改' });
  assert.equal(r.status, 401);
  assert.equal((await row('u_a2')).name, '小美');
});
