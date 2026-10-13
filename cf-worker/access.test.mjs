// 跑法：cd cf-worker && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectRoleOf, canEditProjectContent, canManageShareLinks,
  songStatusDecision, describeProjectRoute, roleMeetsNeed,
  commentSessionFor, parseCommentSession, commentAuthorRole, canModifyComment,
  scrubActivityPayload, animatorAssignmentDecision, commentSummaryRow, canBrowseSharedAssets,
} from './access.mjs';

const segs = (path) => path.split('/').filter(Boolean);

test('專案角色：全站 admin 一律 admin；其他人看這個專案的角色；不是成員 = null', () => {
  assert.equal(projectRoleOf('admin', null), 'admin');
  assert.equal(projectRoleOf('admin', 'animator'), 'admin');
  // 帳號預設是動畫師，但在這個專案被設成導演 → 照專案的
  assert.equal(projectRoleOf('animator', 'director'), 'director');
  assert.equal(projectRoleOf('director', 'animator'), 'animator');
  assert.equal(projectRoleOf('director', null), null);
  assert.equal(projectRoleOf('animator', 'hacker'), null);
});

test('改內容只有 admin；分享連結 admin + 導演', () => {
  assert.equal(canEditProjectContent('admin'), true);
  assert.equal(canEditProjectContent('director'), false);
  assert.equal(canEditProjectContent('animator'), false);
  assert.equal(canManageShareLinks('director'), true);
  assert.equal(canManageShareLinks('animator'), false);
  assert.equal(canManageShareLinks(null), false);
});

// ── 歌曲狀態 ──
const song = (status, animator_user_id = null) => ({ status, animator_user_id });
const ok = (d) => assert.equal(d.ok, true, d.error);
const no = (d, status) => { assert.equal(d.ok, false); assert.equal(d.status, status); assert.ok(d.error && !/[\u{1F300}-\u{1FAFF}]/u.test(d.error)); };

test('動畫師：待製作 → 審查中、需修改 → 審查中、審查中 → 撤回', () => {
  ok(songStatusDecision({ role: 'animator', userId: 'u1', song: song('todo'), to: 'in_review' }));
  ok(songStatusDecision({ role: 'animator', userId: 'u1', song: song('needs_changes'), to: 'in_review' }));
  ok(songStatusDecision({ role: 'animator', userId: 'u1', song: song('in_review'), to: 'todo' }));
});

test('動畫師不能自己通過 / 標需修改（403）', () => {
  no(songStatusDecision({ role: 'animator', userId: 'u1', song: song('in_review'), to: 'approved' }), 403);
  no(songStatusDecision({ role: 'animator', userId: 'u1', song: song('in_review'), to: 'needs_changes' }), 403);
});

test('動畫師撤回時導演已經標了需修改 → 409（不會把導演的決定蓋掉）', () => {
  const d = songStatusDecision({ role: 'animator', userId: 'u1', song: song('needs_changes'), to: 'todo' });
  no(d, 409);
  assert.equal(d.currentStatus, 'needs_changes');
  // 已通過的歌也不能撤回
  no(songStatusDecision({ role: 'animator', userId: 'u1', song: song('approved'), to: 'todo' }), 409);
});

test('前端帶了以為的目前狀態，跟資料庫不一樣 → 409', () => {
  const d = songStatusDecision({ role: 'animator', userId: 'u1', song: song('needs_changes'), to: 'todo', expected: 'in_review' });
  no(d, 409);
  assert.match(d.error, /需修改/);
  // 一樣就照規則走
  ok(songStatusDecision({ role: 'animator', userId: 'u1', song: song('in_review'), to: 'todo', expected: 'in_review' }));
  // admin 帶了也要一致
  no(songStatusDecision({ role: 'admin', userId: 'u0', song: song('approved'), to: 'todo', expected: 'in_review' }), 409);
});

test('指派給別的動畫師的歌不能動；沒指派 / 指派給自己可以', () => {
  no(songStatusDecision({ role: 'animator', userId: 'u1', song: song('todo', 'u2'), to: 'in_review' }), 403);
  ok(songStatusDecision({ role: 'animator', userId: 'u1', song: song('todo', 'u1'), to: 'in_review' }));
  ok(songStatusDecision({ role: 'animator', userId: 'u1', song: song('todo', null), to: 'in_review' }));
});

test('導演：審查中 → 通過 / 需修改；已通過 → 撤回通過', () => {
  ok(songStatusDecision({ role: 'director', userId: 'u3', song: song('in_review'), to: 'approved' }));
  ok(songStatusDecision({ role: 'director', userId: 'u3', song: song('in_review'), to: 'needs_changes' }));
  ok(songStatusDecision({ role: 'director', userId: 'u3', song: song('approved'), to: 'in_review' }));
});

test('導演不能改回待製作（403）；還沒提交的歌不能直接通過（409）', () => {
  no(songStatusDecision({ role: 'director', userId: 'u3', song: song('in_review'), to: 'todo' }), 403);
  no(songStatusDecision({ role: 'director', userId: 'u3', song: song('todo'), to: 'approved' }), 409);
});

test('admin 什麼都可以；不是成員 403；狀態值亂填 400；沒變 = noop', () => {
  ok(songStatusDecision({ role: 'admin', userId: 'u0', song: song('approved'), to: 'todo' }));
  no(songStatusDecision({ role: null, userId: 'u9', song: song('todo'), to: 'in_review' }), 403);
  no(songStatusDecision({ role: 'admin', userId: 'u0', song: song('todo'), to: 'done' }), 400);
  const d = songStatusDecision({ role: 'director', userId: 'u3', song: song('approved'), to: 'approved' });
  ok(d); assert.equal(d.noop, true);
  // 動畫師按兩次提交（已經是審查中）→ 沒事
  ok(songStatusDecision({ role: 'animator', userId: 'u1', song: song('in_review'), to: 'in_review' }));
});

// ── 專案路由權限 ──
const route = (m, p) => describeProjectRoute(m, segs(p));

test('路由：讀都是 member，改內容是 editor', () => {
  assert.equal(route('GET', '/api/projects/p1').need, 'member');
  assert.equal(route('GET', '/api/projects/p1/songs').need, 'member');
  assert.equal(route('POST', '/api/projects/p1/songs').need, 'editor');
  assert.equal(route('POST', '/api/projects/p1/songs/reorder').need, 'editor');
  assert.deepEqual(route('PATCH', '/api/projects/p1/songs/s1'), { kind: 'songs.patch', need: 'songPatch', songId: 's1' });
  assert.equal(route('DELETE', '/api/projects/p1/songs/s1').need, 'editor');
  assert.deepEqual(route('GET', '/api/projects/p1/songs/s1/cues/c1/states'),
    { kind: 'states.list', need: 'member', songId: 's1', cueId: 'c1' });
  assert.deepEqual(route('PUT', '/api/projects/p1/songs/s1/cues/c1/states/o1'),
    { kind: 'states.item', need: 'editor', songId: 's1', cueId: 'c1', objId: 'o1' });
  assert.equal(route('POST', '/api/projects/p1/songs/s1/cues/c1/reset').need, 'editor');
  assert.equal(route('POST', '/api/projects/p1/songs/s1/cues/reorder').cueId, undefined);
  assert.equal(route('PATCH', '/api/projects/p1/stage-objects/o1').objId, 'o1');
  assert.equal(route('POST', '/api/projects/p1/stage-objects/bulk').need, 'editor');
  assert.equal(route('PUT', '/api/projects/p1/model').need, 'editor');
  assert.equal(route('GET', '/api/projects/p1/model/versions').need, 'member');
  assert.equal(route('GET', '/api/projects/p1/activity').need, 'member');
  assert.equal(route('GET', '/api/projects/p1/export').need, 'editor');
});

test('路由：只有全站 admin 的', () => {
  assert.equal(route('DELETE', '/api/projects/p1').need, 'globalAdmin');
  assert.equal(route('POST', '/api/projects/p1/duplicate').need, 'globalAdmin');
  assert.deepEqual(route('POST', '/api/projects/p1/restore'), { kind: 'restore', need: 'globalAdmin', allowArchived: true });
});

test('路由：邀請連結只有全站 admin（等於幫專案加人）', () => {
  assert.deepEqual(route('GET', '/api/projects/p1/invites'), { kind: 'invites.list', need: 'globalAdmin' });
  assert.deepEqual(route('POST', '/api/projects/p1/invites'), { kind: 'invites.create', need: 'globalAdmin' });
  assert.deepEqual(route('DELETE', '/api/projects/p1/invites/inv_1'), { kind: 'invites.revoke', need: 'globalAdmin', inviteId: 'inv_1' });
  assert.equal(route('PATCH', '/api/projects/p1/invites').methodNotAllowed, true);
  assert.equal(route('GET', '/api/projects/p1/invites/inv_1').methodNotAllowed, true);
  assert.equal(route('DELETE', '/api/projects/p1/invites/inv_1/x'), null);
  // 專案的 admin（不是全站 admin）、導演都不行
  assert.equal(roleMeetsNeed('globalAdmin', { role: 'admin', globalRole: 'director' }), false);
  assert.equal(roleMeetsNeed('globalAdmin', { role: 'director', globalRole: 'director' }), false);
});

test('共用模型庫清單：全站 admin 或某個專案的 admin 才看得到', () => {
  assert.equal(canBrowseSharedAssets({ globalRole: 'admin', isProjectAdminSomewhere: false }), true);
  assert.equal(canBrowseSharedAssets({ globalRole: 'director', isProjectAdminSomewhere: true }), true);
  assert.equal(canBrowseSharedAssets({ globalRole: 'animator', isProjectAdminSomewhere: false }), false);
  assert.equal(canBrowseSharedAssets({ globalRole: 'director', isProjectAdminSomewhere: false }), false);
});

test('路由：Drive 同步成員都可以（動畫師提交前要同步），手動歸類要 editor', () => {
  assert.equal(route('POST', '/api/projects/p1/drive/sync').need, 'member');
  assert.equal(route('GET', '/api/projects/p1/drive/files').need, 'member');
  assert.equal(route('POST', '/api/projects/p1/drive/files/f1/assign').need, 'editor');
});

test('路由：分享連結 = shareManager；沒有的路徑 null；方法不對 methodNotAllowed', () => {
  assert.equal(route('GET', '/api/projects/p1/share-links').need, 'shareManager');
  assert.equal(route('DELETE', '/api/projects/p1/share-links/tok').need, 'shareManager');
  assert.equal(route('GET', '/api/projects/p1/nope'), null);
  assert.equal(route('PUT', '/api/projects/p1/activity').methodNotAllowed, true);
});

test('路由：歌曲影片（看 = 成員；交 / 改 = videoUploader；網址上的 id 都要檢查）', () => {
  const base = '/api/projects/p1/songs/s1/videos';
  assert.deepEqual(route('GET', base), { kind: 'videos.list', need: 'member', songId: 's1' });
  assert.equal(route('POST', base).methodNotAllowed, true);
  assert.deepEqual(route('POST', `${base}/uploads`), { kind: 'videos.createUpload', need: 'videoUploader', songId: 's1' });
  assert.equal(route('GET', `${base}/uploads`).methodNotAllowed, true);
  assert.equal(route('POST', `${base}/link`).need, 'videoUploader');
  assert.deepEqual(route('GET', `${base}/sv_1`), { kind: 'videos.get', need: 'member', songId: 's1', videoId: 'sv_1' });
  assert.equal(route('PATCH', `${base}/sv_1`).kind, 'videos.patch');
  assert.equal(route('DELETE', `${base}/sv_1`).need, 'videoUploader');
  assert.deepEqual(route('PUT', `${base}/sv_1/parts/3`), { kind: 'videos.part', need: 'videoUploader', songId: 's1', videoId: 'sv_1', partNumber: '3' });
  assert.equal(route('POST', `${base}/sv_1/parts/3`).methodNotAllowed, true);
  assert.equal(route('POST', `${base}/sv_1/complete`).kind, 'videos.complete');
  assert.equal(route('POST', `${base}/sv_1/abort`).kind, 'videos.abort');
  assert.equal(route('POST', `${base}/sv_1/retry`).kind, 'videos.retry');
  assert.equal(route('GET', `${base}/sv_1/complete`).methodNotAllowed, true);
  assert.deepEqual(route('HEAD', `${base}/sv_1/stream`), { kind: 'videos.stream', need: 'member', songId: 's1', videoId: 'sv_1' });
  assert.equal(route('GET', `${base}/sv_1/nope`), null);
  assert.equal(route('GET', `${base}/sv_1/parts`), null);
});

test('角色 vs 需要的權限', () => {
  const as = (role, globalRole = role) => ({ role, globalRole });
  assert.equal(roleMeetsNeed('videoUploader', as('animator')), true);
  assert.equal(roleMeetsNeed('videoUploader', as('admin', 'director')), true);
  assert.equal(roleMeetsNeed('videoUploader', as('director')), false);
  assert.equal(roleMeetsNeed('member', as('animator')), true);
  assert.equal(roleMeetsNeed('editor', as('animator')), false);
  assert.equal(roleMeetsNeed('editor', as('director')), false);
  assert.equal(roleMeetsNeed('editor', as('admin', 'director')), true);  // 這個專案的 admin
  assert.equal(roleMeetsNeed('globalAdmin', as('admin', 'director')), false);
  assert.equal(roleMeetsNeed('globalAdmin', as('admin')), true);
  assert.equal(roleMeetsNeed('shareManager', as('director')), true);
  assert.equal(roleMeetsNeed('shareManager', as('animator')), false);
  assert.equal(roleMeetsNeed('member', as(null, 'director')), false);
});

// ── 留言 ──
test('留言 session id 跟前端一樣；猜得回 project / song', () => {
  assert.equal(commentSessionFor('p_cu2eqmtwmoix576h', 's_fpjcuhy0moix5h7w'), 'p_cu2eqmtwmoix576h-s_fpjcuhy0moix5h7w');
  assert.deepEqual(parseCommentSession('p_cu2eqmtwmoix576h-s_fpjcuhy0moix5h7w'),
    { projectId: 'p_cu2eqmtwmoix576h', songId: 's_fpjcuhy0moix5h7w' });
  const longP = 'p_' + 'a'.repeat(40);
  const sess = commentSessionFor(longP, 's1');
  assert.equal(sess.length, 28 + 1 + 2);
  assert.equal(parseCommentSession(sess), null);         // 被截斷 → 猜不出來
  assert.equal(parseCommentSession('3fc2e0ca1473c824'), null);  // 舊版單頁工具的留言串
  assert.equal(parseCommentSession('a-b-c'), null);
});

test('留言：自己的或 admin 才能改文字 / 刪', () => {
  const c = { authorUserId: 'u1' };
  assert.equal(canModifyComment(c, 'u1', 'animator'), true);
  assert.equal(canModifyComment(c, 'u2', 'director'), false);
  assert.equal(canModifyComment(c, 'u2', 'admin'), true);
  assert.equal(canModifyComment({}, 'u1', 'animator'), false);  // 舊留言沒記作者 → 只有 admin
  assert.equal(commentAuthorRole('admin'), 'designer');
  assert.equal(commentAuthorRole('director'), 'director');
  assert.equal(commentAuthorRole('animator'), 'animator');
});

test('活動紀錄遮掉號碼 / 密碼', () => {
  const out = scrubActivityPayload({
    name: 'x', accessCode: 'ABCD1234', changes: { access_code: 'Z', password: 'p', nested: [{ refresh_token: 't' }], keep: 1 },
  });
  assert.deepEqual(out, {
    name: 'x', accessCode: '[已隱藏]',
    changes: { access_code: '[已隱藏]', password: '[已隱藏]', nested: [{ refresh_token: '[已隱藏]' }], keep: 1 },
  });
  assert.equal(scrubActivityPayload(null), null);
});

test('指派動畫師：只能指派這個專案的動畫師；null / 空 = 取消指派', () => {
  assert.deepEqual(animatorAssignmentDecision(null, null), { ok: true, clear: true });
  assert.deepEqual(animatorAssignmentDecision('', null), { ok: true, clear: true });
  assert.deepEqual(animatorAssignmentDecision('u_a', 'animator'), { ok: true });
  const outsider = animatorAssignmentDecision('u_x', null);
  assert.equal(outsider.ok, false);
  assert.equal(outsider.status, 400);
  assert.match(outsider.error, /不是這個專案的成員/);
  const director = animatorAssignmentDecision('u_d', 'director');
  assert.equal(director.status, 400);
  assert.match(director.error, /不是動畫師/);
  assert.equal(animatorAssignmentDecision('u_adm', 'admin').ok, false, '專案 admin 也不是動畫師');
  assert.equal(animatorAssignmentDecision('bad id!', 'animator').status, 400);
  assert.equal(animatorAssignmentDecision(123, 'animator').ok, false);
});

test('路由：留言摘要 = 成員都可以看；只收 GET', () => {
  assert.deepEqual(route('GET', '/api/projects/p1/comments/summary'), { kind: 'comments.summary', need: 'member' });
  assert.equal(route('POST', '/api/projects/p1/comments/summary').methodNotAllowed, true);
  assert.equal(route('GET', '/api/projects/p1/comments'), null);
  assert.equal(route('GET', '/api/projects/p1/comments/summary/x'), null);
});

test('留言摘要一列的格式', () => {
  assert.deepEqual(commentSummaryRow({ song_id: 's1', count: 3, open_count: 2, latest_at: '2026-10-01T00:00:00Z', latest_id: 'c3', others_count: 1, others_latest_at: '2026-09-30T00:00:00Z' }), {
    songId: 's1', count: 3, openCount: 2, latestAt: '2026-10-01T00:00:00Z', latestId: 'c3', fromOthersCount: 1, latestFromOthersAt: '2026-09-30T00:00:00Z',
  });
  assert.deepEqual(commentSummaryRow({ song_id: 's2', count: 0, open_count: null, latest_at: null, latest_id: null, others_count: null, others_latest_at: null }), {
    songId: 's2', count: 0, openCount: 0, latestAt: null, latestId: null, fromOthersCount: 0, latestFromOthersAt: null,
  });
});

test('路由：機關（看 = 成員；新增 / 改 / 刪 / 排序 / 每個 cue 的位置 / 總表 = editor；網址上的 id 都要檢查）', () => {
  const p = '/api/projects/p1';
  assert.deepEqual(route('GET', `${p}/mechanisms`), { kind: 'mechanisms.list', need: 'member' });
  assert.deepEqual(route('POST', `${p}/mechanisms`), { kind: 'mechanisms.create', need: 'editor' });
  assert.equal(route('PUT', `${p}/mechanisms`).methodNotAllowed, true);
  assert.deepEqual(route('POST', `${p}/mechanisms/reorder`), { kind: 'mechanisms.reorder', need: 'editor' });
  assert.equal(route('GET', `${p}/mechanisms/reorder`).methodNotAllowed, true);
  assert.deepEqual(route('PATCH', `${p}/mechanisms/m1`), { kind: 'mechanisms.item', need: 'editor', mechId: 'm1' });
  assert.deepEqual(route('DELETE', `${p}/mechanisms/m1`), { kind: 'mechanisms.item', need: 'editor', mechId: 'm1' });
  assert.equal(route('GET', `${p}/mechanisms/m1`).methodNotAllowed, true);
  assert.deepEqual(route('POST', `${p}/mechanisms/m1/convert-cue-positions`), { kind: 'mechanisms.convert', need: 'editor', mechId: 'm1' });
  assert.equal(route('GET', `${p}/mechanisms/m1/convert-cue-positions`).methodNotAllowed, true);
  assert.equal(route('GET', `${p}/mechanisms/m1/nope`), null);
  assert.deepEqual(route('GET', `${p}/mechanism-sheet`), { kind: 'mechanisms.sheet', need: 'editor' });
  assert.equal(route('POST', `${p}/mechanism-sheet`).methodNotAllowed, true);
  assert.equal(route('GET', `${p}/mechanism-sheet/x`), null);
  assert.deepEqual(route('GET', `${p}/songs/s1/mechanism-positions`), { kind: 'mechPositions.list', need: 'member', songId: 's1' });
  assert.equal(route('POST', `${p}/songs/s1/mechanism-positions`).methodNotAllowed, true);
  assert.equal(route('GET', `${p}/songs/s1/mechanism-positions/x`), null);
  assert.deepEqual(route('PUT', `${p}/songs/s1/cues/c1/mechanisms/m1`),
    { kind: 'mechPositions.item', need: 'editor', songId: 's1', cueId: 'c1', mechId: 'm1' });
  assert.deepEqual(route('DELETE', `${p}/songs/s1/cues/c1/mechanisms/m1`),
    { kind: 'mechPositions.item', need: 'editor', songId: 's1', cueId: 'c1', mechId: 'm1' });
  assert.equal(route('GET', `${p}/songs/s1/cues/c1/mechanisms/m1`).methodNotAllowed, true);
  assert.equal(route('GET', `${p}/songs/s1/cues/c1/mechanisms`), null);
  // 導演 / 動畫師看得到、改不了（403）
  const as = (role) => ({ role, globalRole: role });
  assert.equal(roleMeetsNeed('editor', as('director')), false);
  assert.equal(roleMeetsNeed('editor', as('animator')), false);
  assert.equal(roleMeetsNeed('member', as('director')), true);
});
