// 跑法：cd cf-worker && npm test
// 審片 v2 走一遍真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1 + 記憶體假 R2）：
// 留言綁版本 / 回覆 / 已改好的權限、需修改要原因、審片紀錄、交新版自動回審查中、通知、舊版前端相容。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './testing/d1-sqlite.mjs';
import worker from './worker.js';

const BASE = 'https://proxy.test';

/** 很小的假 R2（只夠分段上傳用） */
function fakeR2() {
  const objects = new Map();
  const uploads = new Map();
  let n = 0;
  return {
    objects,
    async createMultipartUpload(key) { const uploadId = `up${++n}`; uploads.set(uploadId, { key, parts: new Map() }); return { uploadId, key }; },
    resumeMultipartUpload(key, uploadId) {
      const u = uploads.get(uploadId);
      return {
        async uploadPart(num, body) {
          const buf = new Uint8Array(await new Response(body).arrayBuffer());
          u.parts.set(num, buf);
          return { partNumber: num, etag: `e${num}` };
        },
        async complete(parts) {
          const size = parts.reduce((s, p) => s + u.parts.get(p.partNumber).length, 0);
          objects.set(key, size);
          return { size };
        },
        async abort() { uploads.delete(uploadId); },
      };
    },
    async delete(key) { objects.delete(key); },
  };
}

async function setup() {
  const db = freshDb();
  const users = [
    ['u_admin', '製作', 'admin', 'ADMIN-1'], ['u_dir', '王小明', 'director', 'DIR-1'],
    ['u_a1', '阿凱', 'animator', 'ANI-1'], ['u_a2', '小美', 'animator', 'ANI-2'], ['u_out', '路人', 'director', 'OUT-1'],
  ];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, `${id}@x.test`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '金馬')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director'), ('p1', 'u_a1', 'animator'), ('p1', 'u_a2', 'animator')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, animator_user_id, code) VALUES ('s1', 'p1', '開場', 0, 'todo', 'u_a1', 'S01')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, code) VALUES ('s2', 'p1', '安可', 1, 'todo', 'S02')`),
  ]);
  const env = { DB: db, AUTH_SECRET: 'test-secret', MODELS: fakeR2() };
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
    try { data = await r.json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data };
  };
  /** 走真的上傳流程交一版（一段） */
  const upload = async (who, songId, note = '') => {
    const bytes = new Uint8Array(1024).fill(7);
    let r = await call(who, 'POST', `/api/projects/p1/songs/${songId}/videos/uploads`, { filename: 'v.mp4', sizeBytes: bytes.length, mime: 'video/mp4', note });
    assert.equal(r.status, 201, r.data?.error);
    const vid = r.data.video.id;
    const put = await worker.fetch(new Request(`${BASE}/api/projects/p1/songs/${songId}/videos/${vid}/parts/1`, {
      method: 'PUT', body: bytes, headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
    }), env);
    assert.equal(put.status, 200, await put.text());
    r = await call(who, 'POST', `/api/projects/p1/songs/${songId}/videos/${vid}/complete`, {});
    assert.equal(r.status, 200, r.data?.error);
    assert.equal(r.data.video.status, 'ready');
    return r.data.video;
  };
  return { db, env, call, upload };
}

const commentsPath = '/api/comments?session=p1-s1';
let n = 0;
const newComment = (extra) => ({ comment: { id: `c_r${++n}`, createdAt: new Date(Date.UTC(2026, 9, 14, 7, 0, n)).toISOString(), ...extra } });

test('整套：交 V1 → 提交 → 導演 @ 動畫師留言 → 需修改（要原因）→ 回覆 → 交 V2 自動回審查中 → 已改好 → 通過', async () => {
  const { call, upload } = await setup();
  const v1 = await upload('u_a1', 's1', '第一版');
  assert.equal(v1.version, 1);

  // 提交審查 → 導演收到「新版等你審」
  let r = await call('u_a1', 'PATCH', '/api/projects/p1/songs/s1', { status: 'in_review', expectedStatus: 'todo' });
  assert.equal(r.status, 200, r.data?.error);
  r = await call('u_dir', 'GET', '/api/notifications');
  assert.equal(r.status, 200);
  assert.equal(r.data.unreadCount, 1);
  assert.equal(r.data.items[0].kind, 'new_version');
  assert.equal(r.data.items[0].versionLabel, 'V1');
  assert.equal(r.data.items[0].projectRole, 'director');

  // 導演在 V1 留言 @阿凱
  r = await call('u_dir', 'POST', commentsPath, newComment({ text: '@阿凱 第二段太亮', time: 12.5, videoId: v1.id, mentions: [{ userId: 'u_a1', name: '阿凱' }] }));
  assert.equal(r.status, 200, r.data?.error);
  const c1 = r.data.comments.at(-1);
  assert.equal(c1.videoVersion, 1);

  // 需修改沒寫原因 → 400，狀態沒變
  r = await call('u_dir', 'PATCH', '/api/projects/p1/songs/s1', { status: 'needs_changes', expectedStatus: 'in_review', reason: ' ', reviewVideoId: v1.id });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /原因/);
  r = await call('u_dir', 'PATCH', '/api/projects/p1/songs/s1', { status: 'needs_changes', expectedStatus: 'in_review', reason: '第二段 LED 太亮', reviewVideoId: v1.id });
  assert.equal(r.status, 200, r.data?.error);
  assert.ok(r.data.reviewId);
  // 原因發成留言
  r = await call('u_a1', 'GET', commentsPath);
  assert.ok(r.data.comments.some(c => c.kind === 'needs_changes' && c.text === '需修改：第二段 LED 太亮' && c.videoVersion === 1));

  // 動畫師：兩則通知（@我、被退）
  r = await call('u_a1', 'GET', '/api/notifications');
  assert.deepEqual(r.data.items.map(i => i.kind).sort(), ['mention', 'needs_changes']);
  assert.equal(r.data.unreadCount, 2);

  // 回覆
  r = await call('u_a1', 'POST', commentsPath, newComment({ text: '收到，調暗', parentId: c1.id }));
  assert.equal(r.status, 200, r.data?.error);
  const reply = r.data.comments.at(-1);
  assert.equal(reply.parentId, c1.id);

  // 交 V2 → 自動回到審查中、導演收到新版
  const v2 = await upload('u_a1', 's1', '調暗了');
  assert.equal(v2.version, 2);
  r = await call('u_dir', 'GET', '/api/projects/p1/songs');
  const s1 = r.data.songs.find(s => s.id === 's1');
  assert.equal(s1.status, 'in_review');
  assert.equal(s1.latestVideoVersion, 2);
  assert.equal(s1.reviewedVersion, 1, '看過 V1 → 有新版 V2');
  assert.equal(s1.lastReview.status, 'needs_changes');
  assert.equal(s1.lastReview.reason, '第二段 LED 太亮');
  r = await call('u_dir', 'GET', '/api/notifications');
  assert.equal(r.data.items[0].kind, 'new_version');
  assert.equal(r.data.items[0].versionLabel, 'V2');
  assert.equal(r.data.items.filter(i => i.kind === 'reply').length, 1);

  // 導演不能幫別人標「已改好」（自己的留言可以收回）；動畫師可以（V2）
  r = await call('u_dir', 'PATCH', commentsPath, { id: reply.id, status: 'resolved' });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /重新打開/);
  r = await call('u_a1', 'PATCH', commentsPath, { id: c1.id, status: 'resolved', resolvedVideoId: v2.id });
  assert.equal(r.status, 200, r.data?.error);
  assert.equal(r.data.comments.find(c => c.id === c1.id).resolvedVersion, 2);

  // 通過 V2（409 安全照舊：以為還在需修改 → 409）
  r = await call('u_dir', 'PATCH', '/api/projects/p1/songs/s1', { status: 'approved', expectedStatus: 'needs_changes', reason: '', reviewVideoId: v2.id });
  assert.equal(r.status, 409);
  assert.equal(r.data.currentStatus, 'in_review');
  r = await call('u_dir', 'PATCH', '/api/projects/p1/songs/s1', { status: 'approved', expectedStatus: 'in_review', reason: '', reviewVideoId: v2.id });
  assert.equal(r.status, 200, r.data?.error);
  r = await call('u_a1', 'GET', '/api/notifications');
  assert.equal(r.data.items[0].kind, 'approved');
  assert.equal(r.data.items[0].versionLabel, 'V2');

  // 審片紀錄兩筆
  r = await call('u_a1', 'GET', '/api/projects/p1/songs/s1/reviews');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.reviews.map(x => `${x.versionLabel} ${x.statusLabel} ${x.by.name}`), ['V2 已通過 王小明', 'V1 需修改 王小明']);

  // 全部標為已讀
  r = await call('u_a1', 'POST', '/api/notifications/read', { all: true });
  assert.equal(r.data.unreadCount, 0);
});

test('舊版前端：留言不帶版本、需修改不帶原因照樣可以；別首歌 / 別人的歌的權限', async () => {
  const { call } = await setup();
  let r = await call('u_dir', 'POST', '/api/comments?session=p1-s2', newComment({ text: '舊版前端的留言' }));
  assert.equal(r.status, 200);
  assert.equal('videoId' in r.data.comments[0], false);
  await call('u_admin', 'PATCH', '/api/projects/p1/songs/s2', { status: 'in_review' });
  r = await call('u_dir', 'PATCH', '/api/projects/p1/songs/s2', { status: 'needs_changes', expectedStatus: 'in_review' });
  assert.equal(r.status, 200, r.data?.error);
  r = await call('u_dir', 'GET', '/api/projects/p1/songs/s2/reviews');
  assert.equal(r.data.reviews[0].reason, '');
  assert.equal(r.data.reviews[0].version, null);

  // 小美不能在阿凱的歌留言；可以在沒指派的歌
  r = await call('u_a2', 'POST', commentsPath, newComment({ text: '我也想留' }));
  assert.equal(r.status, 403);
  r = await call('u_a2', 'POST', '/api/comments?session=p1-s2', newComment({ text: '沒指派的歌' }));
  assert.equal(r.status, 200);
  // 不是成員
  r = await call('u_out', 'GET', commentsPath);
  assert.equal(r.status, 403);
  r = await call('u_out', 'GET', '/api/projects/p1/songs/s1/reviews');
  assert.equal(r.status, 403);
});

test('通知要登入（分享連結的訪客沒有）；指派動畫師會通知他', async () => {
  const { call } = await setup();
  assert.equal((await call(null, 'GET', '/api/notifications')).status, 401);
  assert.equal((await call(null, 'POST', '/api/notifications/read', { all: true })).status, 401);
  assert.equal((await call('u_a2', 'DELETE', '/api/notifications')).status, 405);
  let r = await call('u_admin', 'PATCH', '/api/projects/p1/songs/s2', { animator_user_id: 'u_a2' });
  assert.equal(r.status, 200, r.data?.error);
  r = await call('u_a2', 'GET', '/api/notifications');
  assert.deepEqual(r.data.items.map(i => [i.kind, i.songName, i.actorName]), [['assigned', '安可', '製作']]);
  // 封存的專案不能留言
  await call('u_admin', 'DELETE', '/api/projects/p1');
  assert.equal((await call('u_dir', 'POST', commentsPath, newComment({ text: 'x' }))).status, 404);
  assert.equal((await call('u_admin', 'POST', commentsPath, newComment({ text: 'x' }))).status, 409);
});
