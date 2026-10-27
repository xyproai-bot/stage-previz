// 跑法：cd cf-worker && npm test
// 專案成員（「成員」面板）：純判斷 + 走真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1）
//   - 全站製作和「這個專案的製作」都能管這個專案的成員 / 邀請；專案製作碰不到別的專案、改不了全站角色、管不了用戶
//   - 邀請可以邀製作：只在這個專案是製作，帳號的預設角色不是製作（永遠不會變成全站製作）
//   - 面板上那一行「專案的製作能做什麼」的說明，每一項都對過真的路由
//   - migration 0041 只加欄位，舊的邀請照舊
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, D1Sqlite, applyMigrations } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import { describeProjectRoute, roleMeetsNeed } from './access.mjs';
import {
  memberChangeDecision, parseMemberRole, parseCandidateQuery, likePattern, memberToApi, candidateToApi,
  memberChangeSummary, MEMBER_ROLES, CANDIDATE_LIMIT, CANDIDATE_QUERY_MAX,
} from './members.mjs';
import {
  PROJECT_ADMIN_SCOPE_TEXT, PROJECT_ADMIN_CAN, PROJECT_ADMIN_CANNOT, groupMembersByRole, MEMBER_ROLE_ORDER,
} from '../web/src/lib/projectMembers.ts';

const BASE = 'https://proxy.test';

// ─── 純判斷 ───

const admin = { id: 'u_pm', role: 'animator' };
const target = (extra = {}) => ({ id: 'u_t', name: '小華', role: 'animator', deactivated: 0, ...extra });
const decide = (extra) => memberChangeDecision({ actor: admin, actorProjectRole: 'admin', target: target(), currentRole: null, nextRole: 'director', ...extra });

test('成員變更：加進專案 / 改角色 / 同一個角色不動 / 移出專案', () => {
  assert.deepEqual(decide({}), { ok: true, kind: 'add', from: null, to: 'director' });
  assert.deepEqual(decide({ currentRole: 'animator', nextRole: 'admin' }), { ok: true, kind: 'change', from: 'animator', to: 'admin' });
  assert.deepEqual(decide({ currentRole: 'director', nextRole: 'director' }), { ok: true, kind: 'noop', from: 'director', to: 'director' });
  assert.deepEqual(decide({ currentRole: 'director', nextRole: null }), { ok: true, kind: 'remove', from: 'director', to: null });
});

test('成員變更：不是這個專案的製作（導演 / 動畫師 / 不是成員）一律不行', () => {
  for (const role of ['director', 'animator', null, undefined]) {
    const d = decide({ actorProjectRole: role });
    assert.equal(d.ok, false, String(role));
    assert.equal(d.status, 403);
    assert.equal(d.error, '只有這個專案的製作可以管理成員');
  }
});

test('成員變更：全站製作不能被加進專案 / 改 / 移出（本來就看得到全部專案）', () => {
  for (const next of ['admin', 'director', null]) {
    const d = decide({ target: target({ role: 'admin', name: '陳製作' }), currentRole: 'admin', nextRole: next });
    assert.equal(d.ok, false, String(next));
    assert.equal(d.status, 400);
    assert.match(d.error, /陳製作.*全站製作/);
  }
});

test('成員變更：不能改自己的角色、不能把自己移出專案', () => {
  const self = target({ id: 'u_pm', name: '阿宏' });
  const change = decide({ target: self, currentRole: 'admin', nextRole: 'animator' });
  assert.equal(change.ok, false);
  assert.match(change.error, /不能改自己/);
  const remove = decide({ target: self, currentRole: 'admin', nextRole: null });
  assert.equal(remove.ok, false);
  assert.match(remove.error, /不能把自己移出專案/);
});

test('成員變更：停用的帳號不能新加；已經在專案裡的可以改角色 / 移出；找不到的人 404', () => {
  assert.equal(decide({ target: target({ deactivated: 1 }) }).ok, false);
  assert.equal(decide({ target: target({ deactivated: 1 }), currentRole: 'animator', nextRole: 'director' }).ok, true);
  assert.equal(decide({ target: target({ deactivated: 1 }), currentRole: 'animator', nextRole: null }).ok, true);
  assert.equal(decide({ target: null }).status, 404);
  assert.equal(decide({ target: null, nextRole: null }).status, 404);
  // 不是成員還要移出
  const gone = decide({ currentRole: null, nextRole: null });
  assert.equal(gone.ok, false);
  assert.equal(gone.status, 404);
  // 角色不認識
  assert.equal(decide({ nextRole: 'owner' }).status, 400);
  assert.equal(decide({ nextRole: 'superadmin' }).ok, false);
});

test('成員角色：只收 admin / director / animator', () => {
  assert.deepEqual(MEMBER_ROLES.slice().sort(), ['admin', 'animator', 'director']);
  for (const r of MEMBER_ROLES) assert.deepEqual(parseMemberRole(r), { ok: true, role: r });
  for (const r of ['ADMIN', 'owner', '', null, undefined, 1, {}]) assert.equal(parseMemberRole(r).ok, false, String(r));
});

test('找人的名字：整理空白、最多 40 個字；LIKE 的 % _ \\ 不當萬用字元', () => {
  assert.equal(parseCandidateQuery('  王   小明 '), '王 小明');
  assert.equal(parseCandidateQuery(null), '');
  assert.equal(parseCandidateQuery(undefined), '');
  assert.equal(parseCandidateQuery('x'.repeat(100)).length, CANDIDATE_QUERY_MAX);
  assert.equal(likePattern('50%_a\\b'), '%50\\%\\_a\\\\b%');
});

test('成員清單一列：沒有登入碼這類欄位', () => {
  const m = memberToApi({ user_id: 'u_1', name: '小華', role: 'director', user_role: 'animator', avatar_color: '#fff', last_seen_at: null, deactivated: 0, access_code: 'SECRET', access_code_hash: 'H' }, 'u_me');
  assert.deepEqual(m, { id: 'u_1', name: '小華', avatarColor: '#fff', role: 'director', globalAdmin: false, deactivated: false, lastSeenAt: null, isMe: false });
  assert.equal(JSON.stringify(m).includes('SECRET'), false);
  assert.equal(memberToApi({ user_id: 'u_me', name: 'A', role: 'admin', user_role: 'admin', avatar_color: '#000' }, 'u_me').isMe, true);
  assert.equal(memberToApi({ user_id: 'u_x', name: 'A', role: 'admin', user_role: 'admin', avatar_color: '#000' }, 'u_me').globalAdmin, true);
  assert.deepEqual(candidateToApi({ id: 'u_2', name: 'B', role: 'animator', avatar_color: '#111', project_role: 'bogus', access_code: 'X' }),
    { id: 'u_2', name: 'B', avatarColor: '#111', role: 'animator', projectRole: null });
  assert.equal(memberChangeSummary({ kind: 'add', to: 'director' }, '小華'), '把「小華」加進專案（導演）');
  assert.equal(memberChangeSummary({ kind: 'change', from: 'animator', to: 'admin' }, '小華'), '把「小華」從動畫師改成製作');
  assert.equal(memberChangeSummary({ kind: 'remove', from: 'animator' }, '小華'), '把「小華」移出專案');
});

test('面板分組：製作 → 導演 → 動畫師，組內照名字排，沒人的角色不出現', () => {
  const groups = groupMembersByRole([
    { id: '1', name: '丙', role: 'animator' }, { id: '2', name: '乙', role: 'director' }, { id: '3', name: '甲', role: 'animator' },
  ]);
  assert.deepEqual(groups.map(g => g.role), ['director', 'animator']);
  assert.deepEqual(groups.map(g => g.label), ['導演', '動畫師']);
  assert.equal(groups[1].members.length, 2);
  assert.deepEqual(MEMBER_ROLE_ORDER, ['admin', 'director', 'animator']);
});

// ─── 路由 ───

async function setup() {
  const db = freshDb();
  const users = [
    // id, 名字, 帳號預設角色, 登入碼
    ['u_admin', '陳製作', 'admin', 'ADMIN-1'],
    ['u_admin2', '林製作', 'admin', 'ADMIN-2'],
    ['u_pm', '阿宏', 'animator', 'PM-CODE-1'],      // p1 的製作（帳號是動畫師）
    ['u_pm2', '小豪', 'director', 'PM-CODE-2'],     // p2 的製作（帳號是導演）
    ['u_dir', '王導', 'director', 'DIR-CODE-1'],
    ['u_ani', '李動畫', 'animator', 'ANI-CODE-1'],
    ['u_free', '小華', 'animator', 'FREE-CODE-1'],  // 沒加進任何專案
    ['u_p2', '小美', 'animator', 'P2-CODE-1'],      // 只在 p2
    ['u_off', '停用的小安', 'animator', 'OFF-CODE-1'],
  ];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code, deactivated) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, `${id}@x.test`, name, role, code, id === 'u_off' ? 1 : 0)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '金馬')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p2', '另一個專案')`),
    db.prepare(`INSERT INTO projects (id, name, status) VALUES ('p3', '封存的專案', 'archived')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_admin', 'admin')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_pm', 'admin')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_ani', 'animator')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p2', 'u_pm2', 'admin')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p2', 'u_p2', 'animator')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p3', 'u_pm', 'admin')`),
  ]);
  const env = { DB: db, AUTH_SECRET: 'test-secret', MODELS: memoryR2() };
  const tokens = {};
  for (const [id, , , code] of users) {
    if (id === 'u_off') continue;
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
  const role = async (project, user) => (await db.prepare(`SELECT role FROM project_members WHERE project_id = ? AND user_id = ?`).bind(project, user).first())?.role ?? null;
  const globalRole = async (user) => (await db.prepare(`SELECT role FROM users WHERE id = ?`).bind(user).first())?.role ?? null;
  return { db, env, call, role, globalRole };
}

test('看成員：全站製作和這個專案的製作看得到；導演、動畫師、別的專案的製作、沒登入都不行', async () => {
  const { call } = await setup();
  for (const who of ['u_admin', 'u_pm']) {
    const r = await call(who, 'GET', '/api/projects/p1/members');
    assert.equal(r.status, 200, who);
    const byId = Object.fromEntries(r.data.members.map(m => [m.id, m]));
    assert.deepEqual(Object.keys(byId).sort(), ['u_admin', 'u_ani', 'u_dir', 'u_pm']);
    assert.equal(byId.u_pm.role, 'admin');
    assert.equal(byId.u_pm.globalAdmin, false);
    assert.equal(byId.u_admin.globalAdmin, true);
    assert.equal(byId.u_pm.isMe, who === 'u_pm');
    // 不能有登入碼這類欄位
    assert.equal(JSON.stringify(r.data).includes('CODE'), false);
    assert.equal('accessCode' in byId.u_pm, false);
  }
  for (const who of ['u_dir', 'u_ani', 'u_pm2', 'u_free']) {
    const r = await call(who, 'GET', '/api/projects/p1/members');
    assert.equal(r.status, 403, who);
  }
  assert.equal((await call(null, 'GET', '/api/projects/p1/members')).status, 401);
  // 別的專案的製作看自己專案的 OK、看 p1 不行
  assert.equal((await call('u_pm2', 'GET', '/api/projects/p2/members')).status, 200);
});

test('專案製作加人 / 改角色：只動 project_members，不動帳號的預設角色', async () => {
  const { call, role, globalRole, db } = await setup();
  // 加進專案
  const add = await call('u_pm', 'PUT', '/api/projects/p1/members/u_free', { role: 'director' });
  assert.equal(add.status, 200, JSON.stringify(add.data));
  assert.equal(add.data.kind, 'add');
  assert.equal(await role('p1', 'u_free'), 'director');
  assert.equal(await globalRole('u_free'), 'animator');
  // 改成這個專案的製作 —— 帳號的預設角色還是動畫師
  const up = await call('u_pm', 'PUT', '/api/projects/p1/members/u_free', { role: 'admin' });
  assert.equal(up.status, 200);
  assert.equal(up.data.kind, 'change');
  assert.equal(await role('p1', 'u_free'), 'admin');
  assert.equal(await globalRole('u_free'), 'animator');
  // 多塞一個想變成全站製作的欄位 → 沒有用
  const sneaky = await call('u_pm', 'PUT', '/api/projects/p1/members/u_free', { role: 'admin', globalRole: 'admin', accountRole: 'admin', userRole: 'admin' });
  assert.equal(sneaky.status, 200);
  assert.equal(await globalRole('u_free'), 'animator');
  // 他現在是這個專案的製作 → 看得到成員了；p2 還是不行
  assert.equal((await call('u_free', 'GET', '/api/projects/p1/members')).status, 200);
  assert.equal((await call('u_free', 'GET', '/api/projects/p2/members')).status, 403);
  // 同一個角色再按一次不動
  assert.equal((await call('u_pm', 'PUT', '/api/projects/p1/members/u_free', { role: 'admin' })).data.kind, 'noop');
  // 活動紀錄有寫（誰、做了什麼）
  const logs = (await db.prepare(`SELECT user_id, action, target_type, target_id, payload FROM activity_log WHERE project_id = 'p1' AND target_type = 'member' ORDER BY created_at, rowid`).all()).results;
  assert.deepEqual(logs.map(l => [l.user_id, l.action, l.target_id]), [['u_pm', 'create', 'u_free'], ['u_pm', 'update', 'u_free']]);
  assert.equal(JSON.parse(logs[0].payload).summary, '把「小華」加進專案（導演）');
  assert.equal(JSON.parse(logs[1].payload).summary, '把「小華」從導演改成製作');
});

test('專案製作不能做的事：角色亂填、全站製作、自己、停用的人、不存在的人', async () => {
  const { call, role, globalRole } = await setup();
  for (const bad of [{ role: 'owner' }, { role: '' }, {}, { role: 'ADMIN' }]) {
    const r = await call('u_pm', 'PUT', '/api/projects/p1/members/u_free', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(await role('p1', 'u_free'), null);
  // 全站製作：加 / 改 / 移出都擋（資料不動）
  for (const [m, body] of [['PUT', { role: 'animator' }], ['DELETE', undefined]]) {
    const r = await call('u_pm', m, '/api/projects/p1/members/u_admin', body);
    assert.equal(r.status, 400, m);
    assert.match(r.data.error, /全站製作/);
  }
  assert.equal(await role('p1', 'u_admin'), 'admin');
  const admin2 = await call('u_pm', 'PUT', '/api/projects/p1/members/u_admin2', { role: 'animator' });
  assert.equal(admin2.status, 400);
  assert.equal(await role('p1', 'u_admin2'), null);
  // 自己
  assert.equal((await call('u_pm', 'PUT', '/api/projects/p1/members/u_pm', { role: 'animator' })).status, 400);
  assert.equal((await call('u_pm', 'DELETE', '/api/projects/p1/members/u_pm')).status, 400);
  assert.equal(await role('p1', 'u_pm'), 'admin');
  // 停用的人不能新加
  assert.equal((await call('u_pm', 'PUT', '/api/projects/p1/members/u_off', { role: 'animator' })).status, 400);
  assert.equal(await role('p1', 'u_off'), null);
  // 不存在的人
  assert.equal((await call('u_pm', 'PUT', '/api/projects/p1/members/u_nobody', { role: 'animator' })).status, 404);
  assert.equal((await call('u_pm', 'PUT', '/api/projects/p1/members/bad%20id', { role: 'animator' })).status, 400);
  // 沒有任何人的帳號預設角色被改
  assert.equal(await globalRole('u_pm'), 'animator');
  assert.equal(await globalRole('u_admin'), 'admin');
});

test('專案製作碰不到別的專案：加人 / 改 / 移出 / 看都是 403，別的專案的成員不動', async () => {
  const { call, role } = await setup();
  assert.equal((await call('u_pm', 'PUT', '/api/projects/p2/members/u_free', { role: 'animator' })).status, 403);
  assert.equal((await call('u_pm', 'PUT', '/api/projects/p2/members/u_p2', { role: 'admin' })).status, 403);
  assert.equal((await call('u_pm', 'DELETE', '/api/projects/p2/members/u_p2')).status, 403);
  assert.equal((await call('u_pm', 'GET', '/api/projects/p2/members')).status, 403);
  assert.equal((await call('u_pm', 'GET', '/api/projects/p2/member-candidates?q=a')).status, 403);
  assert.equal(await role('p2', 'u_free'), null);
  assert.equal(await role('p2', 'u_p2'), 'animator');
  // 用自己專案的網址去動「別的專案的人」也只會動到自己的專案：u_p2 被加進 p1，p2 的資料不變
  const r = await call('u_pm', 'PUT', '/api/projects/p1/members/u_p2', { role: 'animator' });
  assert.equal(r.status, 200);
  assert.equal(await role('p1', 'u_p2'), 'animator');
  assert.equal(await role('p2', 'u_p2'), 'animator');
  // 封存的專案：專案製作看不到（404）
  assert.equal((await call('u_pm', 'GET', '/api/projects/p3/members')).status, 404);
  assert.equal((await call('u_pm', 'PUT', '/api/projects/p3/members/u_free', { role: 'animator' })).status, 404);
  // 全站製作可以看，但不能改（要先還原）
  assert.equal((await call('u_admin', 'GET', '/api/projects/p3/members')).status, 200);
  assert.equal((await call('u_admin', 'PUT', '/api/projects/p3/members/u_free', { role: 'animator' })).status, 409);
  assert.equal(await role('p3', 'u_free'), null);
});

test('導演、動畫師、不是成員的人：不能加、改、移出', async () => {
  const { call, role } = await setup();
  for (const who of ['u_dir', 'u_ani', 'u_free']) {
    assert.equal((await call(who, 'PUT', '/api/projects/p1/members/u_free', { role: 'admin' })).status, 403, who);
    assert.equal((await call(who, 'DELETE', '/api/projects/p1/members/u_ani')).status, 403, who);
  }
  assert.equal((await call(null, 'PUT', '/api/projects/p1/members/u_free', { role: 'admin' })).status, 401);
  assert.equal(await role('p1', 'u_free'), null);
  assert.equal(await role('p1', 'u_ani'), 'animator');
});

test('移出專案：成員被拿掉，再移一次 404；全站製作也可以操作', async () => {
  const { call, role } = await setup();
  assert.equal((await call('u_pm', 'DELETE', '/api/projects/p1/members/u_ani')).status, 200);
  assert.equal(await role('p1', 'u_ani'), null);
  assert.equal((await call('u_pm', 'DELETE', '/api/projects/p1/members/u_ani')).status, 404);
  // 他看不到這個專案了
  assert.equal((await call('u_ani', 'GET', '/api/projects/p1/songs')).status, 403);
  // 全站製作改別人的角色
  assert.equal((await call('u_admin', 'PUT', '/api/projects/p1/members/u_dir', { role: 'animator' })).status, 200);
  assert.equal(await role('p1', 'u_dir'), 'animator');
  // 專案製作也可以降級另一個專案製作（同一個專案裡大家一樣大）
  assert.equal((await call('u_admin', 'PUT', '/api/projects/p1/members/u_ani', { role: 'admin' })).status, 200);
  assert.equal((await call('u_pm', 'PUT', '/api/projects/p1/members/u_ani', { role: 'director' })).status, 200);
});

test('找現有用戶：一定要輸入名字；不列停用的和全站製作；有標出已經在專案裡；LIKE 符號不當萬用字元', async () => {
  const { call, db } = await setup();
  const none = await call('u_pm', 'GET', '/api/projects/p1/member-candidates');
  assert.equal(none.status, 200);
  assert.deepEqual(none.data, { users: [], needQuery: true });
  assert.deepEqual((await call('u_pm', 'GET', '/api/projects/p1/member-candidates?q=%20%20')).data.users, []);

  const r = await call('u_pm', 'GET', '/api/projects/p1/member-candidates?q=' + encodeURIComponent('小'));
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.data.users.map(u => [u.id, u]));
  assert.deepEqual(Object.keys(byId).sort(), ['u_free', 'u_p2', 'u_pm2']);   // 停用的小安不列
  assert.equal(byId.u_free.projectRole, null);
  assert.equal(byId.u_free.role, 'animator');
  assert.equal(JSON.stringify(r.data).includes('CODE'), false);
  // 製作不列
  const adm = await call('u_pm', 'GET', '/api/projects/p1/member-candidates?q=' + encodeURIComponent('製作'));
  assert.deepEqual(adm.data.users, []);
  // 已經在這個專案的有標出角色
  const inProject = await call('u_pm', 'GET', '/api/projects/p1/member-candidates?q=' + encodeURIComponent('李動畫'));
  assert.equal(inProject.data.users[0].projectRole, 'animator');
  // % 不當萬用字元
  assert.deepEqual((await call('u_pm', 'GET', '/api/projects/p1/member-candidates?q=%25')).data.users, []);
  await db.prepare(`UPDATE users SET name = '100%好人' WHERE id = 'u_free'`).run();
  assert.deepEqual((await call('u_pm', 'GET', '/api/projects/p1/member-candidates?q=%25')).data.users.map(u => u.id), ['u_free']);
  // 最多 20 個
  await db.batch(Array.from({ length: 30 }, (_, i) => db.prepare(
    `INSERT INTO users (id, email, name, role) VALUES (?, ?, ?, 'animator')`
  ).bind(`u_bulk${i}`, `b${i}@x.test`, `批次${i}`)));
  assert.equal((await call('u_pm', 'GET', '/api/projects/p1/member-candidates?q=' + encodeURIComponent('批次'))).data.users.length, CANDIDATE_LIMIT);
  // 導演、動畫師不能找人
  assert.equal((await call('u_dir', 'GET', '/api/projects/p1/member-candidates?q=a')).status, 403);
  assert.equal((await call('u_ani', 'GET', '/api/projects/p1/member-candidates?q=a')).status, 403);
  assert.equal((await call(null, 'GET', '/api/projects/p1/member-candidates?q=a')).status, 401);
});

test('專案製作管不了全站的東西：用戶清單、指派 API、改帳號角色、所有專案的邀請清單、看別的專案', async () => {
  const { call, role, globalRole } = await setup();
  assert.equal((await call('u_pm', 'GET', '/api/users')).status, 403);
  assert.equal((await call('u_pm', 'POST', '/api/users/u_free/projects', { projectId: 'p1', role: 'animator' })).status, 403);
  assert.equal((await call('u_pm', 'PATCH', '/api/users/u_free', { role: 'admin' })).status, 403);
  assert.equal((await call('u_pm', 'PATCH', '/api/users/u_pm', { role: 'admin' })).status, 403);
  assert.equal((await call('u_pm', 'POST', '/api/users/u_free/access-code', {})).status, 403);
  assert.equal((await call('u_pm', 'POST', '/api/users', { name: '新人', role: 'admin' })).status, 403);
  assert.equal((await call('u_pm', 'GET', '/api/invites')).status, 403);
  assert.equal((await call('u_pm', 'GET', '/api/projects/p2')).status, 403);
  assert.equal(await role('p1', 'u_free'), null);
  assert.equal(await globalRole('u_pm'), 'animator');
  assert.equal(await globalRole('u_free'), 'animator');
  // 專案列表只有自己的（p1，加上封存的 p3 不列）
  const list = await call('u_pm', 'GET', '/api/projects');
  assert.deepEqual(list.data.projects.map(p => p.id), ['p1']);
  assert.equal(list.data.projects[0].myRole, 'admin');
});

// ─── 邀請 ───

const createInvite = (call, who, project, body) => call(who, 'POST', `/api/projects/${project}/invites`, body);

test('邀請製作：新的人用了之後只在這個專案是製作，帳號是動畫師；看不到別的專案、管不了用戶', async () => {
  const { call, db, role, globalRole } = await setup();
  const made = await createInvite(call, 'u_pm', 'p1', { role: 'admin', name: '小陳', singleUse: false, expiresInDays: 7 });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.invite.role, 'admin');
  assert.equal(made.data.invite.maxUses, 1);        // 製作的邀請一律只能用一次
  const row = await db.prepare(`SELECT role, project_role, max_uses FROM invites WHERE id = ?`).bind(made.data.invite.id).first();
  assert.deepEqual({ ...row }, { role: 'animator', project_role: 'admin', max_uses: 1 });   // role 欄位永遠不是 admin

  // 資料庫裡只存雜湊
  assert.equal(JSON.stringify(made.data.invite).includes(made.data.token), false);

  // 打開前先看：寫的是「製作」
  const peek = await call(null, 'POST', '/api/invites/peek', { token: made.data.token });
  assert.equal(peek.status, 200);
  assert.equal(peek.data.invite.role, 'admin');

  const redeem = await call(null, 'POST', '/api/invites/redeem', { token: made.data.token });
  assert.equal(redeem.status, 200, JSON.stringify(redeem.data));
  assert.equal(redeem.data.projectRole, 'admin');
  assert.equal(redeem.data.landingPath, '/admin/projects/p1');
  assert.equal(redeem.data.user.role, 'animator');          // 帳號的預設角色：動畫師，不是全站製作
  const newId = redeem.data.user.id;
  assert.equal(await globalRole(newId), 'animator');
  assert.equal(await role('p1', newId), 'admin');
  assert.equal(await role('p2', newId), null);

  // 用邀請進來的登入狀態：能管 p1 的成員，看不到 p2、管不了用戶
  const hdr = { 'content-type': 'application/json', authorization: `Bearer ${redeem.data.token}` };
  const get = async (path, method = 'GET', body) => {
    const r = await worker.fetch(new Request(BASE + path, { method, headers: hdr, body: body ? JSON.stringify(body) : undefined }), { DB: db, AUTH_SECRET: 'test-secret', MODELS: memoryR2() });
    return r.status;
  };
  assert.equal(await get('/api/projects/p1/members'), 200);
  assert.equal(await get('/api/projects/p1/songs'), 200);
  assert.equal(await get('/api/projects/p2/songs'), 403);
  assert.equal(await get('/api/projects/p2/members'), 403);
  assert.equal(await get('/api/users'), 403);
  assert.equal(await get(`/api/users/${newId}`, 'PATCH', { role: 'admin' }), 403);
  assert.equal(await get('/api/projects/p1/members/u_free', 'PUT', { role: 'animator' }), 200);
  assert.equal(await globalRole(newId), 'animator');

  // 用掉了 → 不能再用
  assert.equal((await call(null, 'POST', '/api/invites/redeem', { token: made.data.token })).status, 410);
});

test('邀請製作給已經有帳號的人：只改他在這個專案的角色，帳號角色不變；全站製作的帳號不能邀', async () => {
  const { call, role, globalRole } = await setup();
  const made = await createInvite(call, 'u_pm', 'p1', { role: 'admin', userId: 'u_free' });
  assert.equal(made.status, 201);
  const redeem = await call(null, 'POST', '/api/invites/redeem', { token: made.data.token });
  assert.equal(redeem.status, 200);
  assert.equal(redeem.data.user.id, 'u_free');
  assert.equal(await role('p1', 'u_free'), 'admin');
  assert.equal(await globalRole('u_free'), 'animator');
  // 導演帳號被邀成這個專案的製作 → 帳號還是導演
  const dirInv = await createInvite(call, 'u_pm', 'p1', { role: 'admin', userId: 'u_dir' });
  await call(null, 'POST', '/api/invites/redeem', { token: dirInv.data.token });
  assert.equal(await role('p1', 'u_dir'), 'admin');
  assert.equal(await globalRole('u_dir'), 'director');
  // 全站製作 / 停用的帳號：不能邀
  for (const uid of ['u_admin', 'u_admin2', 'u_off']) {
    const r = await createInvite(call, 'u_pm', 'p1', { role: 'admin', userId: uid });
    assert.equal(r.status, 400, uid);
  }
});

test('邀請的限制：製作最長 7 天、不能用好幾次；導演 / 動畫師照舊；角色亂填擋掉', async () => {
  const { call } = await setup();
  const long = await createInvite(call, 'u_pm', 'p1', { role: 'admin', name: 'A', expiresInDays: 8 });
  assert.equal(long.status, 400);
  assert.match(long.data.error, /最長 7 天/);
  const director = await createInvite(call, 'u_pm', 'p1', { role: 'director', name: 'B', expiresInDays: 30, singleUse: false });
  assert.equal(director.status, 201);
  assert.equal(director.data.invite.maxUses, 10);
  assert.equal(director.data.invite.role, 'director');
  for (const role of ['owner', '', undefined, 'ADMIN']) {
    assert.equal((await createInvite(call, 'u_pm', 'p1', { role, name: 'C' })).status, 400, String(role));
  }
});

test('邀請：只有全站製作和這個專案的製作；別的專案的邀請碰不到；清單只有自己專案的', async () => {
  const { call } = await setup();
  for (const who of ['u_dir', 'u_ani', 'u_free', 'u_pm2']) {
    assert.equal((await createInvite(call, who, 'p1', { role: 'animator', name: 'X' })).status, 403, who);
    assert.equal((await call(who, 'GET', '/api/projects/p1/invites')).status, 403, who);
  }
  assert.equal((await createInvite(call, null, 'p1', { role: 'animator', name: 'X' })).status, 401);
  // 專案製作不能幫別的專案建邀請
  assert.equal((await createInvite(call, 'u_pm', 'p2', { role: 'admin', name: 'X' })).status, 403);

  const mine = await createInvite(call, 'u_pm', 'p1', { role: 'animator', name: '自己的' });
  const theirs = await createInvite(call, 'u_pm2', 'p2', { role: 'director', name: '別人的' });
  assert.equal(mine.status, 201);
  assert.equal(theirs.status, 201);
  const list = await call('u_pm', 'GET', '/api/projects/p1/invites');
  assert.deepEqual(list.data.invites.map(i => i.personName), ['自己的']);
  assert.equal(JSON.stringify(list.data).includes(mine.data.token), false);
  // 撤銷：自己專案的可以；用自己專案的網址撤銷別的專案的邀請 → 找不到
  assert.equal((await call('u_pm', 'DELETE', `/api/projects/p1/invites/${theirs.data.invite.id}`)).status, 404);
  assert.equal((await call('u_pm2', 'DELETE', `/api/projects/p2/invites/${theirs.data.invite.id}`)).status, 200);
  assert.equal((await call('u_pm', 'DELETE', `/api/projects/p1/invites/${mine.data.invite.id}`)).status, 200);
  assert.equal((await call(null, 'POST', '/api/invites/peek', { token: mine.data.token })).status, 410);
  // 全站製作看得到所有專案的邀請清單（專案製作不行）
  const a = await createInvite(call, 'u_admin', 'p1', { role: 'animator', name: 'a' });
  assert.equal(a.status, 201);
  assert.equal((await call('u_admin', 'GET', '/api/invites')).status, 200);
  assert.equal((await call('u_pm', 'GET', '/api/invites')).status, 403);
});

test('舊的邀請（沒有 project_role）照舊：導演邀請進專案是導演；0041 之前的邀請清單角色不變', async () => {
  const { call, db, role } = await setup();
  const made = await createInvite(call, 'u_admin', 'p1', { role: 'director', userId: 'u_free' });
  assert.equal(made.status, 201);
  // 假裝是 0041 之前建的
  await db.prepare(`UPDATE invites SET project_role = NULL WHERE id = ?`).bind(made.data.invite.id).run();
  const list = await call('u_admin', 'GET', '/api/projects/p1/invites');
  assert.equal(list.data.invites[0].role, 'director');
  const redeem = await call(null, 'POST', '/api/invites/redeem', { token: made.data.token });
  assert.equal(redeem.status, 200);
  assert.equal(redeem.data.projectRole, 'director');
  assert.equal(redeem.data.landingPath, '/preview/p1');
  assert.equal(await role('p1', 'u_free'), 'director');
});

test('migration 0041：只加一個欄位，舊的邀請原封不動（沒有重建表）', async () => {
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0041' });
  await db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', 'A')`).run();
  await db.prepare(
    `INSERT INTO invites (id, token_hash, project_id, role, new_user_name, created_at, expires_at) VALUES ('inv_old', 'h', 'p1', 'director', '舊的', 1, 2)`
  ).run();
  const before = await db.prepare(`SELECT * FROM invites WHERE id = 'inv_old'`).first();
  assert.equal('project_role' in before, false);
  applyMigrations(db, { only: '0041' });
  const after = await db.prepare(`SELECT * FROM invites WHERE id = 'inv_old'`).first();
  assert.equal(after.project_role, null);
  for (const k of Object.keys(before)) assert.equal(after[k], before[k], k);
  // 舊的 CHECK 還在（invites.role 只收 animator / director）；新欄位只收三種
  await assert.rejects(() => db.prepare(`INSERT INTO invites (id, token_hash, project_id, role, created_at, expires_at) VALUES ('i2', 'h2', 'p1', 'admin', 1, 2)`).run());
  await assert.rejects(() => db.prepare(`INSERT INTO invites (id, token_hash, project_id, role, project_role, created_at, expires_at) VALUES ('i3', 'h3', 'p1', 'animator', 'owner', 1, 2)`).run());
  await db.prepare(`INSERT INTO invites (id, token_hash, project_id, role, project_role, created_at, expires_at) VALUES ('i4', 'h4', 'p1', 'animator', 'admin', 1, 2)`).run();
});

// ─── 說明文字 ───

test('說明那一行：每一項「能做」「不能做」都對過真的路由（專案製作，帳號是動畫師）', async () => {
  const { call } = await setup();
  const as = 'u_pm';
  // 先有一首歌，才能測 cue
  const song = await call(as, 'POST', '/api/projects/p1/songs', { name: '測試歌' });
  assert.equal(song.status, 201, JSON.stringify(song.data));
  const songId = song.data.id || song.data.song?.id;
  assert.ok(songId);

  /** 能做 = 這個專案的製作請求不會被權限擋掉（不是 401 / 403；資料不完整的 400 也算「沒被擋」） */
  const canProbes = {
    '模型': ['PUT', '/api/projects/p1/model', undefined],
    '歌單': ['POST', '/api/projects/p1/songs', { name: '第二首' }],
    'cue': ['POST', `/api/projects/p1/songs/${songId}/cues`, { name: 'A' }],
    '機關': ['POST', '/api/projects/p1/mechanisms', {}],
    '版型': ['POST', '/api/projects/p1/led-templates', {}],
    '分享': ['GET', '/api/projects/p1/share-links', undefined],
    '專案狀態': ['PATCH', '/api/projects/p1', { status: 'in_review' }],
    '成員': ['GET', '/api/projects/p1/members', undefined],
  };
  assert.deepEqual(Object.keys(canProbes).sort(), [...PROJECT_ADMIN_CAN].sort());
  for (const [label, [method, path, body]] of Object.entries(canProbes)) {
    const r = await call(as, method, path, body);
    assert.ok(r.status !== 401 && r.status !== 403 && r.status !== 404 && r.status < 500, `${label} 應該能做，卻是 ${r.status} ${JSON.stringify(r.data)}`);
  }
  // 同樣的請求，導演 / 動畫師不行（確認上面不是「什麼人都能做」）
  assert.equal((await call('u_dir', 'POST', '/api/projects/p1/songs', { name: 'x' })).status, 403);
  assert.equal((await call('u_ani', 'POST', '/api/projects/p1/mechanisms', {})).status, 403);

  /** 不能做 = 一定是 403 */
  const cannotProbes = {
    '別的專案': ['GET', '/api/projects/p2/songs', undefined],
    '全站用戶': ['GET', '/api/users', undefined],
    '3D 檢視設定': ['PATCH', '/api/projects/p1', { look_settings: {} }],
    'Drive 來源': ['PATCH', '/api/projects/p1', { drive_folder_id: 'abc' }],
    '封存或複製專案': ['DELETE', '/api/projects/p1', undefined],
  };
  assert.deepEqual(Object.keys(cannotProbes).sort(), PROJECT_ADMIN_CANNOT.map(c => c.label).sort());
  for (const [label, [method, path, body]] of Object.entries(cannotProbes)) {
    const r = await call(as, method, path, body);
    assert.equal(r.status, 403, `${label} 應該不能做，卻是 ${r.status}`);
  }
  assert.equal((await call(as, 'POST', '/api/projects/p1/duplicate', {})).status, 403);
  assert.equal((await call(as, 'PATCH', '/api/projects/p1', { status: 'archived' })).status, 403);
  assert.equal((await call(as, 'PATCH', '/api/projects/p1', { led_canvas: { width: 100, height: 100 } })).status, 403);
  // 專案還在（沒被封存）
  assert.equal((await call(as, 'GET', '/api/projects/p1')).status, 200);
  // 同樣的請求，全站製作做得到（確認 403 是「權限」不是別的原因）
  assert.equal((await call('u_admin', 'GET', '/api/users')).status, 200);

  // 路由表也一樣：這些路由的權限，專案製作（帳號是動畫師）過得了，導演過不了
  const segs = (p) => p.split('/').filter(Boolean);
  for (const [, [method, path]] of Object.entries(canProbes)) {
    const route = describeProjectRoute(method, segs(path));
    assert.ok(route && !route.methodNotAllowed, path);
    assert.equal(roleMeetsNeed(route.need, { role: 'admin', globalRole: 'animator' }), true, `${path} (${route.need})`);
  }

  // 說明文字把每一項都寫出來
  for (const item of PROJECT_ADMIN_CAN.filter(x => x !== '成員')) assert.ok(PROJECT_ADMIN_SCOPE_TEXT.includes(item), item);
  assert.ok(PROJECT_ADMIN_SCOPE_TEXT.includes('管理它的成員'));
  for (const c of PROJECT_ADMIN_CANNOT) assert.ok(PROJECT_ADMIN_SCOPE_TEXT.includes(c.phrase.replace(/^(看不到|管|改)/, '')) || PROJECT_ADMIN_SCOPE_TEXT.includes(c.phrase), c.phrase);
  assert.match(PROJECT_ADMIN_SCOPE_TEXT, /^專案的「製作」可以編輯這個專案（模型、歌單、cue、機關、版型、分享、專案狀態）/);
  assert.equal(PROJECT_ADMIN_SCOPE_TEXT.includes('\n'), false);
  assert.ok(PROJECT_ADMIN_SCOPE_TEXT.includes('直接打開導演頁和動畫師工作站'));
});

// ─── 專案製作打開導演頁 / 動畫師工作站（帳號是動畫師，只在 p1 當製作） ───

test('專案製作看導演頁 / 工作站要的資料：自己的專案讀得到、能留言；別的專案、全站的東西碰不到', async () => {
  const { call } = await setup();
  const mk = async (who, project) => {
    const r = await call(who, 'POST', `/api/projects/${project}/songs`, { name: '歌' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.id || r.data.song?.id;
  };
  const s1 = await mk('u_admin', 'p1');
  const s2 = await mk('u_pm2', 'p2');
  const as = 'u_pm';

  // 自己專案：導演頁 / 工作站會讀的東西都讀得到
  for (const path of [
    '/api/projects/p1', '/api/projects/p1/songs', '/api/projects/p1/activity', '/api/projects/p1/comments/summary',
    `/api/projects/p1/songs/${s1}/reviews`, `/api/projects/p1/songs/${s1}/videos`,
    `/api/comments?session=p1-${s1}`, '/api/projects', '/api/notifications',
  ]) {
    const r = await call(as, 'GET', path);
    assert.equal(r.status, 200, `${path} → ${r.status} ${JSON.stringify(r.data)}`);
  }
  // 能留言（以自己的名字）
  const id = 'c_' + Math.random().toString(36).slice(2, 10);
  const posted = await call(as, 'POST', `/api/comments?session=p1-${s1}`, { comment: { id, text: '整合一下意見' } });
  assert.ok(posted.status === 200 || posted.status === 201, JSON.stringify(posted.data));
  const list = await call(as, 'GET', `/api/comments?session=p1-${s1}`);
  const mine = (list.data.comments || []).find(c => c.id === id);
  assert.ok(mine, '剛留的言讀得回來');
  assert.equal(mine.author, '阿宏');
  // 專案裡的導演看得到他的留言
  const dirList = await call('u_dir', 'GET', `/api/comments?session=p1-${s1}`);
  assert.ok((dirList.data.comments || []).some(c => c.id === id));

  // 路由表：這幾條讀取只要是成員就行
  const segs = (p) => p.split('/').filter(Boolean);
  for (const p of ['/api/projects/p1/comments/summary', `/api/projects/p1/songs/${s1}/reviews`, `/api/projects/p1/songs/${s1}/videos`, '/api/projects/p1/activity']) {
    const route = describeProjectRoute('GET', segs(p));
    assert.equal(route.need, 'member', p);
    assert.equal(roleMeetsNeed(route.need, { role: 'admin', globalRole: 'animator' }), true, p);
    assert.equal(roleMeetsNeed(route.need, { role: null, globalRole: 'animator' }), false, p);
  }

  // 別的專案：讀不到、不能留言
  for (const path of [
    '/api/projects/p2', '/api/projects/p2/songs', '/api/projects/p2/comments/summary',
    `/api/projects/p2/songs/${s2}/reviews`, `/api/projects/p2/songs/${s2}/videos`, `/api/comments?session=p2-${s2}`,
  ]) {
    const r = await call(as, 'GET', path);
    assert.ok(r.status === 403 || r.status === 404, `${path} → ${r.status}`);
  }
  const other = await call(as, 'POST', `/api/comments?session=p2-${s2}`, { comment: { id: 'c_other01', text: '亂入' } });
  assert.equal(other.status, 403);
  // 全站的東西還是碰不到
  assert.equal((await call(as, 'GET', '/api/users')).status, 403);
  assert.equal((await call(as, 'GET', '/api/invites')).status, 403);
  assert.equal((await call(as, 'PATCH', '/api/projects/p1', { look_settings: {} })).status, 403);
  assert.equal((await call(as, 'PATCH', '/api/projects/p1', { drive_folder_id: 'x' })).status, 403);
});

test('專案狀態（10-27 放寬）：專案製作可以切進行中 ⇄ 審查中；封存 / 取消封存、導演、別的專案都不行', async () => {
  const { call } = await setup();
  const status = async () => (await call('u_admin', 'GET', '/api/projects/p1')).data.project.status;
  let r = await call('u_pm', 'PATCH', '/api/projects/p1', { status: 'in_review' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await status(), 'in_review');
  r = await call('u_pm', 'PATCH', '/api/projects/p1', { status: 'active' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await status(), 'active');
  r = await call('u_pm', 'PATCH', '/api/projects/p1', { status: 'archived' });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /封存/);
  assert.equal(await status(), 'active');
  assert.equal((await call('u_pm', 'PATCH', '/api/projects/p1', { status: 'done' })).status, 400);
  assert.equal((await call('u_dir', 'PATCH', '/api/projects/p1', { status: 'in_review' })).status, 403);
  assert.equal((await call('u_ani', 'PATCH', '/api/projects/p1', { status: 'in_review' })).status, 403);
  assert.equal((await call('u_pm', 'PATCH', '/api/projects/p2', { status: 'in_review' })).status, 403);
  // 全站製作照舊什麼都能改
  assert.equal((await call('u_admin', 'PATCH', '/api/projects/p1', { status: 'in_review' })).status, 200);
});
