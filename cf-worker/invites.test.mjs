// 跑法：cd cf-worker && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateInviteToken, isInviteTokenShape, hashInviteToken, newInviteId,
  parseInviteCreate, inviteUserDecision, inviteState, inviteProblem, inviteLandingPath, inviteToApi, inviteProjectRole,
  INVITE_DEFAULT_DAYS, INVITE_MAX_DAYS, INVITE_MULTI_USE_MAX, INVITE_TOKEN_BYTES, INVITE_MESSAGES,
  INVITE_ROLES, INVITE_PROJECT_ROLES, INVITE_ADMIN_MAX_DAYS,
} from './invites.mjs';

const DAY = 86400_000;
const NOW = Date.UTC(2026, 9, 14, 3, 0, 0);

test('邀請碼：至少 128 bits 隨機、網址安全、每次不一樣', () => {
  assert.ok(INVITE_TOKEN_BYTES * 8 >= 128);
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const t = generateInviteToken();
    assert.equal(t.length, 43);
    assert.match(t, /^[A-Za-z0-9_-]+$/);
    assert.ok(isInviteTokenShape(t));
    seen.add(t);
  }
  assert.equal(seen.size, 200);
  assert.equal(isInviteTokenShape('short'), false);
  assert.equal(isInviteTokenShape('a'.repeat(42) + '='), false);
  assert.equal(isInviteTokenShape(null), false);
});

test('邀請碼存雜湊：同一個邀請碼算出一樣的、不同的不一樣、看不出原本的', async () => {
  const t = generateInviteToken();
  const h = await hashInviteToken(t);
  assert.equal(h, await hashInviteToken(t));
  assert.notEqual(h, await hashInviteToken(generateInviteToken()));
  assert.notEqual(h, t);
  assert.equal(h.includes(t), false);
  assert.match(h, /^[A-Za-z0-9_-]{43}$/);
  // 已知的 SHA-256（避免哪天不小心換了算法，舊的邀請全部對不上）
  assert.equal(await hashInviteToken('abc'), 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
});

test('邀請的 id 跟邀請碼不一樣、符合一般 id 格式', () => {
  const id = newInviteId();
  assert.match(id, /^inv_[A-Za-z0-9_-]{12}$/);
  assert.notEqual(newInviteId(), id);
});

test('建立邀請：預設 7 天、只能用一次', () => {
  const r = parseInviteCreate({ role: 'director', name: '  王  小明 ' }, NOW);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { role: 'director', projectRole: 'director', userId: null, name: '王 小明', expiresAt: NOW + INVITE_DEFAULT_DAYS * DAY, maxUses: 1 });
  assert.equal(INVITE_DEFAULT_DAYS, 7);
});

test('建立邀請：已經有帳號的人、自訂天數、可以用好幾次', () => {
  const r = parseInviteCreate({ role: 'animator', userId: 'u_abc', expiresInDays: 3, singleUse: false }, NOW);
  assert.deepEqual(r.value, { role: 'animator', projectRole: 'animator', userId: 'u_abc', name: null, expiresAt: NOW + 3 * DAY, maxUses: INVITE_MULTI_USE_MAX });
});

test('建立邀請：角色只能製作（只在這個專案）/ 導演 / 動畫師，名字 / 天數不對就擋', () => {
  for (const role of ['viewer', 'owner', '', undefined, null, 'ADMIN']) {
    const r = parseInviteCreate({ role, name: 'A' }, NOW);
    assert.equal(r.ok, false, String(role));
    assert.equal(r.status, 400);
  }
  assert.equal(parseInviteCreate({ role: 'director' }, NOW).ok, false);
  assert.equal(parseInviteCreate({ role: 'director', name: '   ' }, NOW).ok, false);
  assert.equal(parseInviteCreate({ role: 'director', name: 'x'.repeat(81) }, NOW).ok, false);
  assert.equal(parseInviteCreate({ role: 'director', userId: 'bad id!' }, NOW).ok, false);
  for (const d of [0, -1, 1.5, INVITE_MAX_DAYS + 1, 'abc']) {
    assert.equal(parseInviteCreate({ role: 'director', name: 'A', expiresInDays: d }, NOW).ok, false, String(d));
  }
  assert.equal(parseInviteCreate({ role: 'director', name: 'A', expiresInDays: INVITE_MAX_DAYS }, NOW).ok, true);
});

test('邀請已經有帳號的人：停用的、製作帳號不行', () => {
  assert.equal(inviteUserDecision({ role: 'animator', deactivated: 0 }).ok, true);
  assert.equal(inviteUserDecision(null).status, 404);
  assert.equal(inviteUserDecision({ role: 'director', deactivated: 1 }).ok, false);
  assert.equal(inviteUserDecision({ role: 'admin', deactivated: 0 }).ok, false);
  // 打開時：說給對方聽的話
  const d = inviteUserDecision({ role: 'director', deactivated: 1 }, 'redeem');
  assert.equal(d.reason, 'deactivated');
  assert.equal(d.error, INVITE_MESSAGES.deactivated);
  assert.equal(inviteUserDecision({ role: 'admin', deactivated: 0 }, 'redeem').reason, 'admin_account');
});

const row = (extra = {}) => ({ revoked_at: null, expires_at: NOW + DAY, use_count: 0, max_uses: 1, project_status: 'active', ...extra });

test('邀請狀態：有效 / 過期 / 用過 / 撤銷 / 專案封存 / 找不到', () => {
  assert.equal(inviteState(row(), NOW), 'ok');
  assert.equal(inviteState(null, NOW), 'not_found');
  // 過期：剛好到期那一刻就不能用
  assert.equal(inviteState(row({ expires_at: NOW }), NOW), 'expired');
  assert.equal(inviteState(row({ expires_at: NOW - 1 }), NOW), 'expired');
  assert.equal(inviteState(row({ expires_at: NOW + 1 }), NOW), 'ok');
  // 只能用一次
  assert.equal(inviteState(row({ use_count: 1 }), NOW), 'used');
  // 可以用好幾次
  assert.equal(inviteState(row({ max_uses: 10, use_count: 9 }), NOW), 'ok');
  assert.equal(inviteState(row({ max_uses: 10, use_count: 10 }), NOW), 'used_up');
  // 撤銷最優先（就算也過期了）
  assert.equal(inviteState(row({ revoked_at: NOW - 5, expires_at: NOW - 1 }), NOW), 'revoked');
  assert.equal(inviteState(row({ project_status: 'archived' }), NOW), 'archived');
});

test('不能用的邀請：中文說明，都叫對方跟製作要新的', () => {
  for (const s of ['not_found', 'revoked', 'expired', 'used', 'used_up']) {
    const p = inviteProblem(s);
    assert.equal(p.reason, s);
    assert.ok(p.status === 404 || p.status === 410);
    assert.match(p.error, /請跟製作要一個新的連結/);
    assert.equal(/[A-Za-z]{4,}/.test(p.error), false, p.error);  // 不要英文
  }
  assert.equal(inviteProblem('not_found').status, 404);
  assert.equal(inviteProblem('expired').status, 410);
});

test('用了邀請去哪：動畫師進工作站、導演進審片頁', () => {
  assert.equal(inviteLandingPath('animator', 'p_1'), '/studio/p_1');
  assert.equal(inviteLandingPath('director', 'p_1'), '/preview/p_1');
  assert.equal(inviteLandingPath('director', 'p 2'), '/preview/p%202');
});

test('管理頁清單：沒有邀請碼、時間是 ISO、剩幾次', () => {
  const api = inviteToApi({
    id: 'inv_x', project_id: 'p_1', project_name: '金馬', role: 'director', user_id: null, new_user_name: '王小明',
    created_at: NOW, expires_at: NOW + 7 * DAY, max_uses: 1, use_count: 0, created_by_name: 'Phang', last_used_at: null,
    token_hash: 'should-not-leak',
  });
  assert.equal(api.personName, '王小明');
  assert.equal(api.isNewPerson, true);
  assert.equal(api.expiresAt, new Date(NOW + 7 * DAY).toISOString());
  assert.equal(api.usesLeft, 1);
  assert.equal(JSON.stringify(api).includes('should-not-leak'), false);
  const existing = inviteToApi({ id: 'inv_y', project_id: 'p_1', role: 'animator', user_id: 'u_1', user_name: '小華', new_user_name: null, created_at: NOW, expires_at: NOW, max_uses: 10, use_count: 3 });
  assert.equal(existing.personName, '小華');
  assert.equal(existing.isNewPerson, false);
  assert.equal(existing.usesLeft, 7);
});

test('邀請製作：只在這個專案是製作，帳號的預設角色是動畫師（永遠不是全站製作）、只能用一次、最長 7 天', () => {
  assert.deepEqual(INVITE_PROJECT_ROLES.slice().sort(), ['admin', 'animator', 'director']);
  // 資料表 invites.role 的值永遠不會是 admin（CHECK 只收 animator / director）
  assert.deepEqual(INVITE_ROLES, ['animator', 'director']);
  const r = parseInviteCreate({ role: 'admin', name: '小陳' }, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.value.projectRole, 'admin');
  assert.equal(r.value.role, 'animator');
  assert.ok(INVITE_ROLES.includes(r.value.role));
  assert.equal(r.value.maxUses, 1);
  assert.equal(r.value.expiresAt, NOW + INVITE_DEFAULT_DAYS * DAY);
  // 想勾「可以用好幾次」也一律只能用一次
  assert.equal(parseInviteCreate({ role: 'admin', name: '小陳', singleUse: false }, NOW).value.maxUses, 1);
  // 已經有帳號的人
  const e = parseInviteCreate({ role: 'admin', userId: 'u_x' }, NOW);
  assert.equal(e.value.projectRole, 'admin');
  assert.equal(e.value.role, 'animator');
  // 天數最長 7 天（導演 / 動畫師最長 30 天照舊）
  assert.equal(INVITE_ADMIN_MAX_DAYS, 7);
  assert.equal(parseInviteCreate({ role: 'admin', name: 'A', expiresInDays: 7 }, NOW).ok, true);
  const long = parseInviteCreate({ role: 'admin', name: 'A', expiresInDays: 8 }, NOW);
  assert.equal(long.ok, false);
  assert.equal(long.status, 400);
  assert.match(long.error, /最長 7 天/);
  assert.equal(parseInviteCreate({ role: 'director', name: 'A', expiresInDays: 30 }, NOW).ok, true);
});

test('用了邀請之後的專案角色：project_role 有值用它，舊的邀請（沒有）就是 role', () => {
  assert.equal(inviteProjectRole({ role: 'animator', project_role: 'admin' }), 'admin');
  assert.equal(inviteProjectRole({ role: 'director', project_role: null }), 'director');
  assert.equal(inviteProjectRole({ role: 'animator' }), 'animator');
  // 看不懂的值不當真（不會因此變成別的角色）
  assert.equal(inviteProjectRole({ role: 'animator', project_role: 'superuser' }), 'animator');
  assert.equal(inviteProjectRole(null), undefined);
});

test('用了邀請去哪：這個專案的製作進專案編輯頁', () => {
  assert.equal(inviteLandingPath('admin', 'p_1'), '/admin/projects/p_1');
  assert.equal(inviteLandingPath('admin', 'p 2'), '/admin/projects/p%202');
});

test('管理頁清單：製作邀請的角色寫「製作」（舊版前端用 ROLE_LABEL 也看得懂）', () => {
  const api = inviteToApi({
    id: 'inv_a', project_id: 'p_1', role: 'animator', project_role: 'admin', user_id: null, new_user_name: '小陳',
    created_at: NOW, expires_at: NOW + DAY, max_uses: 1, use_count: 0,
  });
  assert.equal(api.role, 'admin');
  // 舊的邀請（0041 之前）照舊
  assert.equal(inviteToApi({ id: 'inv_b', project_id: 'p_1', role: 'director', user_id: 'u_1', created_at: NOW, expires_at: NOW, max_uses: 1, use_count: 0 }).role, 'director');
});
