// 跑法：cd cf-worker && npm test
// 審片 v2（reviews.mjs）：用 node:sqlite 開記憶體資料庫、跑真的 migration 和 SQL。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, applyMigrations, freshDb, migrationFiles } from './testing/d1-sqlite.mjs';
import * as rv from './reviews.mjs';
import {
  commentPostDecision, commentResolveDecision, commentReopenDecision, describeNotificationRoute,
  describeProjectRoute, roleMeetsNeed, projectRoleOf,
} from './access.mjs';

const T0 = new Date('2026-10-14T07:00:00.000Z');
const at = (min) => new Date(T0.getTime() + min * 60_000);

const ME = {
  admin: { id: 'u_admin', name: '製作小花', role: 'admin' },
  dir: { id: 'u_dir', name: '王小明', role: 'director' },
  dir2: { id: 'u_dir2', name: '李導', role: 'director' },
  a1: { id: 'u_a1', name: '阿凱', role: 'animator' },
  a2: { id: 'u_a2', name: '小美', role: 'animator' },
  out: { id: 'u_out', name: '路人', role: 'animator' },
};
const ROLE_IN_P1 = { admin: 'admin', dir: 'director', dir2: 'director', a1: 'animator', a2: 'animator', out: null };

async function seed(db) {
  const users = Object.values(ME);
  await db.batch(users.map((u, i) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(u.id, `${u.id}@x.test`, u.name, u.role, `CODE-${i}`)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '金馬 2026')`),
    db.prepare(`INSERT INTO projects (id, name, status) VALUES ('p_old', '封存的', 'archived')`),
    ...['dir', 'dir2', 'a1', 'a2'].map(k => db.prepare(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', ?, ?)`
    ).bind(ME[k].id, ROLE_IN_P1[k])),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p_old', 'u_a1', 'animator')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, animator_user_id, code) VALUES ('s1', 'p1', '開場', 0, 'in_review', 'u_a1', 'S01')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, animator_user_id, code) VALUES ('s2', 'p1', '沒指派', 1, 'todo', NULL, 'S02')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, animator_user_id, code) VALUES ('s3', 'p1', '小美的歌', 2, 'todo', 'u_a2', 'S03')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, code) VALUES ('s_old', 'p_old', '舊歌', 0, 'todo', 'S01')`),
  ]);
  await addVideo(db, { id: 'sv_1', songId: 's1', version: 1, by: 'u_a1' });
}

async function addVideo(db, { id, songId, version, by = null, status = 'ready', projectId = 'p1', note = '' }) {
  await db.prepare(`
    INSERT INTO song_videos (id, project_id, song_id, version, title, note, source, r2_key, mime, status, created_by, ready_at)
    VALUES (?, ?, ?, ?, ?, ?, 'upload', ?, 'video/mp4', ?, ?, ?)
  `).bind(id, projectId, songId, version, `V${version}`, note, `videos/${projectId}/${songId}/${id}.mp4`, status, by,
    status === 'ready' ? T0.toISOString() : null).run();
  if (version) await db.prepare(`UPDATE songs SET video_version_seq = MAX(video_version_seq, ?) WHERE id = ?`).bind(version, songId).run();
}

async function setup() {
  const db = freshDb();
  await seed(db);
  return db;
}

const thread = (who, songId = 's1') => ({ projectId: 'p1', songId, archived: false, role: projectRoleOf(ME[who].role, ROLE_IN_P1[who]) });
let seq = 0;
const cid = () => `c_t${++seq}`;
const post = (db, who, songId, comment, now = T0) =>
  rv.postComment(db, { me: ME[who], thread: thread(who, songId), body: { comment: { id: cid(), createdAt: now.toISOString(), ...comment } }, now });
const patch = (db, who, songId, body, now = T0) => rv.patchComment(db, { me: ME[who], thread: thread(who, songId), body, now });
const notes = async (db, userId) => (await db.prepare(
  `SELECT kind, song_id, video_version, comment_id, actor_name, excerpt, read_at FROM notifications WHERE user_id = ? ORDER BY rowid`
).bind(userId).all()).results;

// ─────────────────────────────────────────────
// migration
// ─────────────────────────────────────────────

test('migration 0024：舊留言、舊資料都還在；舊版前端那種寫法照樣能寫', async () => {
  assert.ok(migrationFiles().includes('0024_review_v2.sql'));
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0024' });
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role) VALUES ('u_x', 'x@x.test', 'X', 'director')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p', 'P')`),
    db.prepare(`INSERT INTO songs (id, project_id, name) VALUES ('s', 'p', '歌')`),
    db.prepare(`INSERT INTO comments (id, project_id, song_id, time_in_video, anchor_screen_xy, text, status, author_user_id, author_name, author_role, created_at)
                VALUES ('c_old', 'p', 's', 12.5, '{"x":0.5,"y":0.5}', '舊的留言', 'resolved', 'u_x', 'X', 'director', '2026-10-01T00:00:00.000Z')`),
  ]);
  applyMigrations(db, { only: '0024' });
  const list = await rv.listSongComments(db, 's');
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '舊的留言');
  assert.equal(list[0].time, 12.5);
  assert.equal(list[0].status, 'resolved');
  for (const k of ['videoId', 'videoVersion', 'parentId', 'resolvedVersion', 'kind']) assert.equal(k in list[0], false, k);
  // 舊版 worker 的 INSERT（沒有新欄位）
  await db.prepare(`INSERT INTO comments (id, project_id, song_id, time_in_video, text, status, author_name, author_role, created_at)
                    VALUES ('c_old2', 'p', 's', 0, '還是可以寫', 'open', 'Y', 'animator', '2026-10-02T00:00:00.000Z')`).run();
  assert.equal((await rv.listSongComments(db, 's')).length, 2);
  // 新的表都在、一開始是空的
  for (const t of ['song_reviews', 'notifications']) {
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n, 0);
  }
});

// ─────────────────────────────────────────────
// 權限（access.mjs）
// ─────────────────────────────────────────────

test('權限：發留言 / 回覆 — 導演、製作哪首都可以；動畫師只能自己的或沒指派的', () => {
  const mine = { animator_user_id: 'u_a1' }, none = { animator_user_id: null };
  assert.equal(commentPostDecision({ role: 'director', userId: 'u_dir', song: mine }).ok, true);
  assert.equal(commentPostDecision({ role: 'admin', userId: 'u_admin', song: mine }).ok, true);
  assert.equal(commentPostDecision({ role: 'animator', userId: 'u_a1', song: mine }).ok, true);
  assert.equal(commentPostDecision({ role: 'animator', userId: 'u_a2', song: none }).ok, true);
  const no = commentPostDecision({ role: 'animator', userId: 'u_a2', song: mine });
  assert.equal(no.ok, false); assert.equal(no.status, 403); assert.match(no.error, /其他動畫師/);
  assert.equal(commentPostDecision({ role: null, userId: 'u_out', song: none }).ok, false);
});

test('權限：已改好 — 製作、負責的動畫師、留言的人自己；導演不行（但可以重新打開）', () => {
  const song = { animator_user_id: 'u_a1' };
  const byDir = { authorUserId: 'u_dir' };
  const r = (role, userId, comment = byDir) => commentResolveDecision({ role, userId, song, comment }).ok;
  assert.equal(r('admin', 'u_admin'), true);
  assert.equal(r('animator', 'u_a1'), true);
  assert.equal(r('animator', 'u_a2'), false);
  assert.equal(r('director', 'u_dir2'), false);
  assert.equal(r('director', 'u_dir'), true, '自己的留言可以自己收回');
  assert.equal(r(null, 'u_out'), false);
  const o = (role, userId, comment = byDir) => commentReopenDecision({ role, userId, song, comment }).ok;
  assert.equal(o('director', 'u_dir2'), true);
  assert.equal(o('admin', 'u_admin'), true);
  assert.equal(o('animator', 'u_a1'), true);
  assert.equal(o('animator', 'u_a2'), false);
  assert.equal(o('animator', 'u_a2', { authorUserId: 'u_a2' }), true);
});

test('路由：通知只有 GET 清單 / POST 已讀；審片紀錄是成員都能看', () => {
  const segs = (p) => p.split('/').filter(Boolean);
  assert.deepEqual(describeNotificationRoute('GET', segs('/api/notifications')), { kind: 'notifications.list' });
  assert.deepEqual(describeNotificationRoute('POST', segs('/api/notifications/read')), { kind: 'notifications.read' });
  assert.equal(describeNotificationRoute('DELETE', segs('/api/notifications')).methodNotAllowed, true);
  assert.equal(describeNotificationRoute('GET', segs('/api/notifications/read')).methodNotAllowed, true);
  assert.equal(describeNotificationRoute('GET', segs('/api/notifications/x/y')), null);
  const r = describeProjectRoute('GET', segs('/api/projects/p1/songs/s1/reviews'));
  assert.equal(r.kind, 'reviews.list'); assert.equal(r.songId, 's1');
  for (const role of ['admin', 'director', 'animator']) assert.equal(roleMeetsNeed(r.need, { role }), true);
  assert.equal(roleMeetsNeed(r.need, { role: null }), false);
  assert.equal(describeProjectRoute('POST', segs('/api/projects/p1/songs/s1/reviews')).methodNotAllowed, true);
});

// ─────────────────────────────────────────────
// 留言綁版本 / 回覆 / 已改好
// ─────────────────────────────────────────────

test('留言綁版本：帶 videoId 記下 V1；舊版前端沒帶照樣能留言（舊留言沒有版本）；亂帶的版本當沒帶', async () => {
  const db = await setup();
  let r = await post(db, 'dir', 's1', { text: '第二段太暗', time: 12, videoId: 'sv_1' });
  assert.equal(r.status, 200, r.body.error);
  const c1 = r.body.comments.at(-1);
  assert.equal(c1.videoId, 'sv_1');
  assert.equal(c1.videoVersion, 1);
  assert.equal(c1.time, 12);
  assert.equal(c1.authorUserId, 'u_dir');
  r = await post(db, 'dir', 's1', { text: '舊版前端' });
  assert.equal(r.status, 200);
  assert.equal('videoId' in r.body.comments.at(-1), false);
  r = await post(db, 'dir', 's1', { text: '別首歌的版本', videoId: 'sv_nope' });
  assert.equal('videoVersion' in r.body.comments.at(-1), false);
});

test('留言權限（handler）：動畫師不能在別人的歌留言；沒指派 / 自己的可以', async () => {
  const db = await setup();
  let r = await post(db, 'a2', 's1', { text: '我來留言' });
  assert.equal(r.status, 403);
  assert.equal((await rv.listSongComments(db, 's1')).length, 0);
  assert.equal((await post(db, 'a2', 's2', { text: '沒指派的歌' })).status, 200);
  assert.equal((await post(db, 'a2', 's3', { text: '我自己的歌' })).status, 200);
  assert.equal((await post(db, 'a1', 's1', { text: '我自己的歌' })).status, 200);
});

test('回覆：只有一層（回覆的回覆掛在最上面那則）、沒帶版本就跟著那則；回覆會通知原本留言的人', async () => {
  const db = await setup();
  const root = (await post(db, 'dir', 's1', { text: 'LED 太亮', videoId: 'sv_1' })).body.comments.at(-1);
  let r = await post(db, 'a1', 's1', { text: '收到，我調暗', parentId: root.id });
  assert.equal(r.status, 200, r.body.error);
  const reply = r.body.comments.at(-1);
  assert.equal(reply.parentId, root.id);
  assert.equal(reply.videoVersion, 1, '沒帶版本 → 跟著那則');
  r = await post(db, 'dir', 's1', { text: '回覆的回覆', parentId: reply.id });
  assert.equal(r.body.comments.at(-1).parentId, root.id, '掛在最上面那則');
  assert.equal((await post(db, 'a1', 's1', { text: 'x', parentId: 'c_nope' })).status, 404);
  // 導演收到「阿凱回覆你」；自己回覆自己不通知
  const dn = await notes(db, 'u_dir');
  assert.deepEqual(dn.map(n => n.kind), ['reply']);
  assert.equal(dn[0].actor_name, '阿凱');
  assert.equal(dn[0].excerpt, '收到，我調暗');
  assert.equal((await notes(db, 'u_a1')).filter(n => n.kind === 'reply').length, 1, '導演回覆阿凱的回覆 → 阿凱收到');
});

test('@提及：通知被 @ 的專案成員；不是成員、自己都不通知；同一個人又被 @ 又是回覆對象只收一則', async () => {
  const db = await setup();
  const root = (await post(db, 'a1', 's1', { text: '交了 V1' })).body.comments.at(-1);
  await post(db, 'dir', 's1', {
    text: '@阿凱 @路人 @王小明 第三段再快一點', parentId: root.id, videoId: 'sv_1',
    mentions: [{ userId: 'u_a1', name: '阿凱' }, { userId: 'u_out', name: '路人' }, { userId: 'u_dir', name: '王小明' }],
  });
  const a1 = await notes(db, 'u_a1');
  assert.deepEqual(a1.map(n => n.kind), ['mention']);
  assert.equal(a1[0].video_version, 1);
  assert.equal(a1[0].song_id, 's1');
  assert.equal((await notes(db, 'u_out')).length, 0);
  assert.equal((await notes(db, 'u_dir')).length, 0);
});

test('全站 admin（不是專案成員）留的言被回覆也會收到通知；停用的人不會', async () => {
  const db = await setup();
  const root = (await post(db, 'admin', 's1', { text: '製作看了一下' })).body.comments.at(-1);
  await post(db, 'dir', 's1', { text: '同意', parentId: root.id });
  assert.deepEqual((await notes(db, 'u_admin')).map(n => n.kind), ['reply']);
  await db.prepare(`UPDATE users SET deactivated = 1 WHERE id = 'u_a1'`).run();
  await post(db, 'dir', 's1', { text: '@阿凱 x', mentions: [{ userId: 'u_a1', name: '阿凱' }] });
  assert.equal((await notes(db, 'u_a1')).length, 0);
});

test('同一則留言重送（網路重試）不會重複新增、也不會重複通知', async () => {
  const db = await setup();
  const body = { comment: { id: 'c_same', text: '@阿凱 看一下', mentions: [{ userId: 'u_a1', name: '阿凱' }], createdAt: T0.toISOString() } };
  await rv.postComment(db, { me: ME.dir, thread: thread('dir'), body });
  const again = await rv.postComment(db, { me: ME.dir, thread: thread('dir'), body });
  assert.equal(again.body.duplicate, true);
  assert.equal((await rv.listSongComments(db, 's1')).length, 1);
  assert.equal((await notes(db, 'u_a1')).length, 1);
});

test('已改好（V2）：記下哪一版改好的（沒選 = 最新一版）；導演不能標別人的、可以重新打開；重新打開清掉版本', async () => {
  const db = await setup();
  const c = (await post(db, 'dir', 's1', { text: '轉場太慢', videoId: 'sv_1' })).body.comments.at(-1);
  await addVideo(db, { id: 'sv_2', songId: 's1', version: 2, by: 'u_a1' });
  // 導演標別人的 → 不行
  let r = await patch(db, 'dir2', 's1', { id: c.id, status: 'resolved' });
  assert.equal(r.status, 403);
  // 別的動畫師 → 不行
  assert.equal((await patch(db, 'a2', 's1', { id: c.id, status: 'resolved' })).status, 403);
  // 負責的動畫師 → 可以，沒選版本 = 最新（V2）
  r = await patch(db, 'a1', 's1', { id: c.id, status: 'resolved' });
  assert.equal(r.status, 200, r.body.error);
  let got = r.body.comments.find(x => x.id === c.id);
  assert.equal(got.status, 'resolved');
  assert.equal(got.resolvedVersion, 2);
  assert.equal(got.resolvedVideoId, 'sv_2');
  assert.equal(got.resolvedByUserId, 'u_a1');
  assert.equal(got.resolvedBy, '阿凱');
  // 指定版本
  r = await patch(db, 'admin', 's1', { id: c.id, status: 'resolved', resolvedVideoId: 'sv_1' });
  assert.equal(r.body.comments.find(x => x.id === c.id).resolvedVersion, 1);
  assert.equal((await patch(db, 'admin', 's1', { id: c.id, status: 'resolved', resolvedVideoId: 'sv_x' })).status, 400);
  // 導演重新打開
  r = await patch(db, 'dir2', 's1', { id: c.id, status: 'open' });
  assert.equal(r.status, 200, r.body.error);
  got = r.body.comments.find(x => x.id === c.id);
  assert.equal(got.status, 'open');
  for (const k of ['resolvedVersion', 'resolvedVideoId', 'resolvedByUserId']) assert.equal(k in got, false, k);
  // 別的動畫師也不能重新打開
  assert.equal((await patch(db, 'a2', 's1', { id: c.id, status: 'open' })).status, 403);
  // 改文字還是只有留言的人或製作
  assert.equal((await patch(db, 'a1', 's1', { id: c.id, text: '改掉' })).status, 403);
  assert.equal((await patch(db, 'dir', 's1', { id: c.id, text: '轉場慢一點點' })).status, 200);
});

test('刪掉一則留言，底下的回覆一起刪；別人的不能刪', async () => {
  const db = await setup();
  const root = (await post(db, 'dir', 's1', { text: '整體偏藍' })).body.comments.at(-1);
  await post(db, 'a1', 's1', { text: '好', parentId: root.id });
  await post(db, 'a1', 's1', { text: '另一則' });
  assert.equal((await rv.deleteComment(db, { me: ME.a1, thread: thread('a1'), id: root.id })).status, 403);
  const r = await rv.deleteComment(db, { me: ME.dir, thread: thread('dir'), id: root.id });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.comments.map(c => c.text), ['另一則']);
});

// ─────────────────────────────────────────────
// 通過 / 需修改（審片紀錄）
// ─────────────────────────────────────────────

test('需修改一定要寫原因（新版前端會帶 reason）；舊版前端沒帶 reason 照以前可以改', () => {
  assert.equal(rv.songDecisionInput({ status: 'needs_changes', reason: '  ' }, 'needs_changes').ok, false);
  assert.equal(rv.songDecisionInput({ status: 'needs_changes', reason: '  ' }, 'needs_changes').status, 400);
  assert.equal(rv.songDecisionInput({ status: 'needs_changes', reason: 3 }, 'needs_changes').ok, false);
  assert.equal(rv.songDecisionInput({ status: 'needs_changes' }, 'needs_changes').ok, true);
  assert.equal(rv.songDecisionInput({ status: 'approved', reason: '' }, 'approved').ok, true);
  const d = rv.songDecisionInput({ reason: ' 第二段 LED 太亮 ', reviewVideoId: 'sv_1' }, 'needs_changes');
  assert.deepEqual(d, { ok: true, reason: '第二段 LED 太亮', reviewVideoId: 'sv_1' });
  assert.equal(rv.songDecisionInput({ reason: 'x'.repeat(900) }, 'needs_changes').reason.length, rv.REVIEW_REASON_MAX);
  assert.equal(rv.songDecisionInput({ reason: 'x', reviewVideoId: '../x' }, 'needs_changes').ok, false);
});

async function decide(db, who, songId, to, body = {}, now = T0) {
  const song = await db.prepare(`SELECT * FROM songs WHERE id = ?`).bind(songId).first();
  const prepared = await rv.prepareStatusChange(db, { song, body: { status: to, ...body }, to });
  if (!prepared.ok) return prepared;
  await db.prepare(`UPDATE songs SET status = ? WHERE id = ?`).bind(to, songId).run();
  const role = projectRoleOf(ME[who].role, ROLE_IN_P1[who]);
  return rv.afterSongStatusChange(db, { me: ME[who], role, song, from: song.status, to, prepared, now });
}

test('需修改：記下看的是哪一版、原因發成留言（綁那一版）、通知負責的動畫師；通過也記、也通知', async () => {
  const db = await setup();
  const out = await decide(db, 'dir', 's1', 'needs_changes', { reason: '第二段 LED 太亮', reviewVideoId: 'sv_1' });
  assert.ok(out.reviewId);
  assert.ok(out.commentId);
  const list = await rv.listSongComments(db, 's1');
  const reasonComment = list.find(c => c.id === out.commentId);
  assert.equal(reasonComment.text, '需修改：第二段 LED 太亮');
  assert.equal(reasonComment.kind, 'needs_changes');
  assert.equal(reasonComment.videoVersion, 1);
  assert.equal(reasonComment.authorUserId, 'u_dir');
  const a1 = await notes(db, 'u_a1');
  assert.deepEqual(a1.map(n => [n.kind, n.video_version, n.excerpt]), [['needs_changes', 1, '第二段 LED 太亮']]);

  await addVideo(db, { id: 'sv_2', songId: 's1', version: 2, by: 'u_a1' });
  await db.prepare(`UPDATE songs SET status = 'in_review' WHERE id = 's1'`).run();
  await decide(db, 'dir', 's1', 'approved', { reason: '', reviewVideoId: 'sv_2' }, at(10));
  const r = (await rv.listSongReviews(db, 's1')).body.reviews;
  assert.deepEqual(r.map(x => [x.versionLabel, x.status, x.statusLabel, x.by.name, x.by.role]), [
    ['V2', 'approved', '已通過', '王小明', 'director'],
    ['V1', 'needs_changes', '需修改', '王小明', 'director'],
  ]);
  assert.equal(r[1].reason, '第二段 LED 太亮');
  assert.equal(r[1].commentId, out.commentId);
  assert.equal(r[1].fromStatus, 'in_review');
  assert.deepEqual((await notes(db, 'u_a1')).map(n => n.kind), ['needs_changes', 'approved']);
  // 歌單用的摘要：最近一次 + 看過的最新版本號
  const sum = await rv.reviewSummaryBySong(db, 'p1');
  assert.equal(sum.get('s1').lastReview.status, 'approved');
  assert.equal(sum.get('s1').lastReview.version, 2);
  assert.equal(sum.get('s1').reviewedVersion, 2);
  assert.equal(sum.has('s2'), false);
});

test('看的版本：沒帶 = 最新一版；帶了不是這首歌的 → 400（不改狀態）；看舊版也照實記', async () => {
  const db = await setup();
  await addVideo(db, { id: 'sv_2', songId: 's1', version: 2, by: 'u_a1' });
  const bad = await decide(db, 'dir', 's1', 'needs_changes', { reason: 'x', reviewVideoId: 'sv_other' });
  assert.equal(bad.ok, false); assert.equal(bad.status, 400);
  assert.equal((await db.prepare(`SELECT status FROM songs WHERE id = 's1'`).first()).status, 'in_review');
  await decide(db, 'dir', 's1', 'needs_changes', { reason: '看 V1 比較' , reviewVideoId: 'sv_1' });
  await db.prepare(`UPDATE songs SET status = 'in_review' WHERE id = 's1'`).run();
  await decide(db, 'dir', 's1', 'approved', {});  // 舊版前端：沒帶版本
  const r = (await rv.listSongReviews(db, 's1')).body.reviews;
  assert.deepEqual(r.map(x => x.version), [2, 1]);
  assert.equal((await rv.reviewSummaryBySong(db, 'p1')).get('s1').reviewedVersion, 2);
});

test('沒指派的歌被退 → 通知交這一版的人；自己退自己的（製作）不通知自己', async () => {
  const db = await setup();
  await addVideo(db, { id: 'sv_s2', songId: 's2', version: 1, by: 'u_a2' });
  await db.prepare(`UPDATE songs SET status = 'in_review' WHERE id = 's2'`).run();
  await decide(db, 'dir', 's2', 'needs_changes', { reason: '顏色' });
  assert.deepEqual((await notes(db, 'u_a2')).map(n => n.kind), ['needs_changes']);
  await addVideo(db, { id: 'sv_s3', songId: 's3', version: 1, by: 'u_admin' });
  await db.prepare(`UPDATE songs SET status = 'in_review', animator_user_id = NULL WHERE id = 's3'`).run();
  await decide(db, 'admin', 's3', 'needs_changes', { reason: '我自己交的' });
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = 'u_admin'`).first()).n, 0);
});

test('提交審查（待製作 → 審查中）→ 通知專案的導演（不通知動畫師自己、不通知不是導演的人）', async () => {
  const db = await setup();
  await addVideo(db, { id: 'sv_s3', songId: 's3', version: 1, by: 'u_a2', note: '第一版' });
  const song = await db.prepare(`SELECT * FROM songs WHERE id = 's3'`).first();
  await db.prepare(`UPDATE songs SET status = 'in_review' WHERE id = 's3'`).run();
  await rv.afterSongStatusChange(db, { me: ME.a2, role: 'animator', song, from: 'todo', to: 'in_review', prepared: null, now: T0 });
  for (const d of ['u_dir', 'u_dir2']) {
    const n = await notes(db, d);
    assert.deepEqual(n.map(x => [x.kind, x.video_version, x.actor_name, x.excerpt]), [['new_version', 1, '小美', '第一版']]);
  }
  assert.equal((await notes(db, 'u_a2')).length, 0);
  assert.equal((await notes(db, 'u_a1')).length, 0);
  // 導演撤回通過（已通過 → 審查中）不算新版
  await rv.afterSongStatusChange(db, { me: ME.dir, role: 'director', song: { ...song, status: 'approved' }, from: 'approved', to: 'in_review', prepared: null, now: T0 });
  assert.equal((await notes(db, 'u_dir2')).length, 1);
});

// ─────────────────────────────────────────────
// 新版交上來
// ─────────────────────────────────────────────

test('新版好了：需修改 → 自動回到審查中 + 通知導演；待製作不動也不通知；審查中照樣通知', async () => {
  const db = await setup();
  await db.prepare(`UPDATE songs SET status = 'needs_changes' WHERE id = 's1'`).run();
  await addVideo(db, { id: 'sv_2', songId: 's1', version: 2, by: 'u_a1', note: '調暗了' });
  let out = await rv.afterVideoReady(db, { videoId: 'sv_2', now: T0 });
  assert.equal(out.autoSubmitted, true);
  assert.equal(out.version, 2);
  assert.equal((await db.prepare(`SELECT status FROM songs WHERE id = 's1'`).first()).status, 'in_review');
  assert.deepEqual((await notes(db, 'u_dir')).map(n => [n.kind, n.video_version, n.actor_name, n.excerpt]), [['new_version', 2, '阿凱', '調暗了']]);
  assert.equal((await notes(db, 'u_a1')).length, 0);

  // 審查中又交一版 → 狀態不變、照樣通知
  await addVideo(db, { id: 'sv_3', songId: 's1', version: 3, by: 'u_a1' });
  out = await rv.afterVideoReady(db, { videoId: 'sv_3', now: at(1) });
  assert.equal(out.autoSubmitted, false);
  assert.equal((await notes(db, 'u_dir')).length, 2);

  // 待製作 → 不動
  await addVideo(db, { id: 'sv_s2', songId: 's2', version: 1, by: 'u_a2' });
  out = await rv.afterVideoReady(db, { videoId: 'sv_s2', now: T0 });
  assert.equal(out.autoSubmitted, false);
  assert.equal((await db.prepare(`SELECT status FROM songs WHERE id = 's2'`).first()).status, 'todo');
  assert.equal((await notes(db, 'u_dir')).length, 2);
  // 還沒好的版本 → 什麼都不做
  await addVideo(db, { id: 'sv_up', songId: 's1', version: null, status: 'uploading', by: 'u_a1' });
  assert.equal((await rv.afterVideoReady(db, { videoId: 'sv_up' })).notified, 0);
});

test('導演貼連結交的一版好了：狀態不動（需修改不會自動變審查中）、不通知導演；通知這首歌的動畫師和製作', async () => {
  const db = await setup();
  await db.prepare(`UPDATE songs SET status = 'needs_changes' WHERE id = 's1'`).run();
  await addVideo(db, { id: 'sv_d', songId: 's1', version: 2, by: 'u_dir', note: '客戶給的參考' });
  const out = await rv.afterVideoReady(db, { videoId: 'sv_d', now: T0 });
  assert.equal(out.byDirector, true);
  assert.equal(out.autoSubmitted, false);
  assert.equal((await db.prepare(`SELECT status FROM songs WHERE id = 's1'`).first()).status, 'needs_changes');
  // 這首歌的動畫師 + 製作（全站 admin）各一則；導演（自己、別的導演）、別的動畫師都沒有
  assert.deepEqual((await notes(db, 'u_a1')).map(n => [n.kind, n.video_version, n.actor_name, n.song_id, n.excerpt]),
    [['director_video', 2, '王小明', 's1', '客戶給的參考']]);
  assert.deepEqual((await notes(db, 'u_admin')).map(n => n.kind), ['director_video']);
  assert.equal((await notes(db, 'u_dir')).length, 0);
  assert.equal((await notes(db, 'u_dir2')).length, 0);
  assert.equal((await notes(db, 'u_a2')).length, 0);
  // 收到的人：動畫師 + 所有製作（全站 admin；migration 也放了一個 u_phang）
  const who = (await db.prepare(`SELECT user_id FROM notifications WHERE kind = 'director_video' ORDER BY user_id`).all()).results.map(r => r.user_id);
  assert.deepEqual(who, ['u_a1', 'u_admin', 'u_phang']);
  assert.equal(out.notified, 3);

  // 審查中的歌：一樣不通知導演「新版等你審」
  await db.prepare(`UPDATE songs SET status = 'in_review' WHERE id = 's1'`).run();
  await addVideo(db, { id: 'sv_d2', songId: 's1', version: 3, by: 'u_dir2' });
  await rv.afterVideoReady(db, { videoId: 'sv_d2', now: at(1) });
  assert.equal((await notes(db, 'u_dir')).length, 0);
  assert.equal((await notes(db, 'u_a1')).length, 2);

  // 沒指派的歌 → 只通知製作
  await addVideo(db, { id: 'sv_d3', songId: 's2', version: 1, by: 'u_dir' });
  const o3 = await rv.afterVideoReady(db, { videoId: 'sv_d3', now: at(2) });
  assert.equal(o3.notified, 2);  // u_admin、u_phang
  assert.equal((await notes(db, 'u_a2')).length, 0);
  assert.equal((await db.prepare(`SELECT status FROM songs WHERE id = 's2'`).first()).status, 'todo');
});

test('全站 admin 在專案裡是導演身分交的 → 算製作（照一般的新版流程）', async () => {
  const db = await setup();
  await db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_admin', 'director')`).run();
  await db.prepare(`UPDATE songs SET status = 'needs_changes' WHERE id = 's1'`).run();
  await addVideo(db, { id: 'sv_x', songId: 's1', version: 2, by: 'u_admin' });
  const out = await rv.afterVideoReady(db, { videoId: 'sv_x', now: T0 });
  assert.equal(out.byDirector, undefined);
  assert.equal(out.autoSubmitted, true);
  assert.deepEqual((await notes(db, 'u_dir')).map(n => n.kind), ['new_version']);
});

test('指派動畫師 → 通知被指派的人（自己指派自己、本來就是他 → 不通知）', async () => {
  const db = await setup();
  const s2 = await db.prepare(`SELECT * FROM songs WHERE id = 's2'`).first();
  assert.equal(await rv.afterAnimatorAssigned(db, { me: ME.admin, song: s2, toUserId: 'u_a2', now: T0 }), 1);
  assert.deepEqual((await notes(db, 'u_a2')).map(n => [n.kind, n.song_id, n.actor_name]), [['assigned', 's2', '製作小花']]);
  const s1 = await db.prepare(`SELECT * FROM songs WHERE id = 's1'`).first();
  assert.equal(await rv.afterAnimatorAssigned(db, { me: ME.admin, song: s1, toUserId: 'u_a1', now: T0 }), 0);
  assert.equal(await rv.afterAnimatorAssigned(db, { me: ME.a2, song: s2, toUserId: 'u_a2', now: T0 }), 0);
  assert.equal(await rv.afterAnimatorAssigned(db, { me: ME.admin, song: s2, toUserId: 'u_out', now: T0 }), 0, '不是成員');
});

// ─────────────────────────────────────────────
// 通知清單
// ─────────────────────────────────────────────

test('通知清單：最新的在前、未讀數、我在那個專案的角色；被移出專案 / 封存的看不到；只能標自己的已讀', async () => {
  const db = await setup();
  await post(db, 'dir', 's1', { text: '@阿凱 一', mentions: [{ userId: 'u_a1', name: '阿凱' }] }, at(1));
  await post(db, 'dir', 's1', { text: '@阿凱 二', mentions: [{ userId: 'u_a1', name: '阿凱' }] }, at(2));
  // 封存專案裡的舊通知
  await db.prepare(`INSERT INTO notifications (id, user_id, project_id, song_id, kind, created_at) VALUES ('n_old', 'u_a1', 'p_old', 's_old', 'assigned', ?)`)
    .bind(at(3).toISOString()).run();
  let r = (await rv.listNotifications(db, ME.a1)).body;
  assert.equal(r.unreadCount, 2);
  assert.deepEqual(r.items.map(i => i.excerpt), ['@阿凱 二', '@阿凱 一']);
  const first = r.items[0];
  assert.equal(first.kind, 'mention');
  assert.equal(first.projectName, '金馬 2026');
  assert.equal(first.projectRole, 'animator');
  assert.equal(first.songName, '開場');
  assert.equal(first.songCode, 'S01');
  assert.equal(first.actorName, '王小明');
  assert.equal(first.read, false);
  assert.ok(first.commentId);

  // 別人不能幫我標已讀
  await rv.markNotificationsRead(db, ME.dir, { ids: [first.id] });
  assert.equal((await rv.listNotifications(db, ME.a1)).body.unreadCount, 2);
  r = (await rv.markNotificationsRead(db, ME.a1, { ids: [first.id] }, at(5))).body;
  assert.equal(r.unreadCount, 1);
  assert.equal((await rv.markNotificationsRead(db, ME.a1, { ids: [] })).status, 400);
  r = (await rv.markNotificationsRead(db, ME.a1, { all: true }, at(6))).body;
  assert.equal(r.unreadCount, 0);
  assert.equal((await rv.listNotifications(db, ME.a1)).body.items.every(i => i.read), true);

  // 被移出專案 → 看不到那個專案的通知
  await db.prepare(`DELETE FROM project_members WHERE project_id = 'p1' AND user_id = 'u_a1'`).run();
  assert.equal((await rv.listNotifications(db, ME.a1)).body.items.length, 0);
  // 全站 admin 看得到封存專案的
  await db.prepare(`INSERT INTO notifications (id, user_id, project_id, kind) VALUES ('n_adm', 'u_admin', 'p_old', 'mention')`).run();
  assert.equal((await rv.listNotifications(db, ME.admin)).body.items[0].projectRole, 'admin');
});

test('排程清掉 60 天以前的通知', async () => {
  const db = await setup();
  const old = new Date(T0.getTime() - 61 * 86400_000).toISOString();
  const recent = new Date(T0.getTime() - 59 * 86400_000).toISOString();
  await db.batch([
    db.prepare(`INSERT INTO notifications (id, user_id, project_id, kind, created_at) VALUES ('n1', 'u_a1', 'p1', 'mention', ?)`).bind(old),
    db.prepare(`INSERT INTO notifications (id, user_id, project_id, kind, created_at) VALUES ('n2', 'u_a1', 'p1', 'mention', ?)`).bind(recent),
  ]);
  assert.equal(await rv.pruneNotifications(db, T0), 1);
  assert.equal((await db.prepare(`SELECT id FROM notifications`).all()).results.map(r => r.id).join(), 'n2');
});

test('pickRecipients / excerptOf（純函式）', () => {
  const members = new Set(['a', 'b', 'c']);
  assert.deepEqual(rv.pickRecipients([
    { userId: 'a', kind: 'mention' }, { userId: 'a', kind: 'reply' }, { userId: 'me', kind: 'mention' },
    { userId: 'zz', kind: 'mention' }, { userId: 'b', kind: 'bogus' }, { userId: 'c', kind: 'reply' },
  ], members, 'me'), [{ userId: 'a', kind: 'mention' }, { userId: 'c', kind: 'reply' }]);
  assert.equal(rv.excerptOf('  一\n二  三 '), '一 二 三');
  assert.equal(rv.excerptOf('x'.repeat(200)).length, 140);
  assert.equal(rv.versionLabel(3), 'V3');
  assert.equal(rv.versionLabel(null), '');
});
