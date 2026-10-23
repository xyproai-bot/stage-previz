// 跑法：cd cf-worker && npm test
// 專案的製作（帳號是動畫師，只在 p1 當製作）直接用導演頁 / 動畫師工作站：走真的 worker 路由
//   在自己的專案：替任何一首歌（包含指派給別人的）上傳影片、刪任何一版（永久）、改審片狀態、留言 / 畫記
//   別的專案、全站用戶 / 邀請 / 3D 檢視設定 / Drive 一律擋
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './testing/d1-sqlite.mjs';
import worker from './worker.js';

const BASE = 'https://proxy.test';

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
          u.parts.set(num, new Uint8Array(await new Response(body).arrayBuffer()));
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
    async get() { return null; },
    async head() { return null; },
  };
}

async function setup() {
  const db = freshDb();
  const users = [
    ['u_admin', '陳製作', 'admin', 'ADMIN-1'], ['u_pm', '阿宏', 'animator', 'PM-1'], ['u_pm2', '小豪', 'director', 'PM-2'],
    ['u_dir', '王導', 'director', 'DIR-1'], ['u_ani', '李動畫', 'animator', 'ANI-1'],
  ];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, `${id}@x.test`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '金馬')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p2', '另一個')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_pm', 'admin'), ('p1', 'u_dir', 'director'), ('p1', 'u_ani', 'animator'), ('p2', 'u_pm2', 'admin')`),
    // s1 指派給李動畫（不是 PM）；s2 沒指派；x1 在別的專案
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, animator_user_id, code) VALUES ('s1', 'p1', '開場', 0, 'todo', 'u_ani', 'S01')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, code) VALUES ('s2', 'p1', '安可', 1, 'todo', 'S02')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, code) VALUES ('x1', 'p2', '別專案的歌', 0, 'todo', 'X01')`),
  ]);
  const r2 = fakeR2();
  const env = { DB: db, AUTH_SECRET: 'test-secret', MODELS: r2 };
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
  const upload = async (who, project, songId) => {
    const bytes = new Uint8Array(1024).fill(7);
    const r = await call(who, 'POST', `/api/projects/${project}/songs/${songId}/videos/uploads`, { filename: 'v.mp4', sizeBytes: bytes.length, mime: 'video/mp4' });
    if (r.status !== 201) return r;
    const vid = r.data.video.id;
    const put = await worker.fetch(new Request(`${BASE}/api/projects/${project}/songs/${songId}/videos/${vid}/parts/1`, {
      method: 'PUT', body: bytes, headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
    }), env);
    assert.equal(put.status, 200, await put.text());
    return call(who, 'POST', `/api/projects/${project}/songs/${songId}/videos/${vid}/complete`, {});
  };
  return { db, r2, call, upload };
}

test('專案製作在自己的專案：替指派給別人 / 沒指派的歌上傳影片、刪任何一版（含別人交的）', async () => {
  const { db, call, upload } = await setup();
  const a = await upload('u_pm', 'p1', 's1');
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.video.status, 'ready');
  assert.equal(a.data.video.createdBy.name, '阿宏');
  const b = await upload('u_pm', 'p1', 's2');
  assert.equal(b.status, 200, JSON.stringify(b.data));
  // 動畫師交的版本，製作也能刪（永久）
  const byAni = await upload('u_ani', 'p1', 's1');
  assert.equal(byAni.status, 200, JSON.stringify(byAni.data));
  const del = await call('u_pm', 'DELETE', `/api/projects/p1/songs/s1/videos/${byAni.data.video.id}`);
  assert.equal(del.status, 200, JSON.stringify(del.data));
  const gone = await db.prepare(`SELECT id FROM song_videos WHERE id = ?`).bind(byAni.data.video.id).first();
  assert.equal(gone, null);
  // 自己交的也能刪
  const del2 = await call('u_pm', 'DELETE', `/api/projects/p1/songs/s2/videos/${b.data.video.id}`);
  assert.equal(del2.status, 200, JSON.stringify(del2.data));
  const list = await call('u_pm', 'GET', '/api/projects/p1/songs/s1/videos');
  assert.equal(list.status, 200);
  assert.equal(list.data.videos.length, 1);
});

test('專案製作在自己的專案：審片（通過 / 需修改）、留言、畫記', async () => {
  const { call, upload } = await setup();
  const v = await upload('u_pm', 'p1', 's1');
  assert.equal(v.status, 200, JSON.stringify(v.data));
  const vid = v.data.video.id;
  let r = await call('u_pm', 'PATCH', '/api/projects/p1/songs/s1', { status: 'approved', reviewVideoId: vid });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call('u_pm', 'PATCH', '/api/projects/p1/songs/s1', { status: 'needs_changes', reason: '第二段太亮', reviewVideoId: vid });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await call('u_pm', 'POST', '/api/comments?session=p1-s1', {
    comment: { id: 'c_pm_draw1', text: '這裡', time: 3.2, videoId: vid, drawing: { v: 1, strokes: [{ color: '#ff0000', width: 4, points: [[0.1, 0.1], [0.4, 0.4]] }] } },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const mine = r.data.comments.find(c => c.id === 'c_pm_draw1');
  assert.ok(mine);
  assert.equal(mine.author, '阿宏');
});

test('專案製作碰不到別的專案、全站用戶 / 邀請 / 3D 檢視設定 / Drive', async () => {
  const { call, upload } = await setup();
  const other = await upload('u_pm', 'p2', 'x1');
  assert.ok(other.status === 403 || other.status === 404, String(other.status));
  assert.equal((await call('u_pm', 'POST', '/api/projects/p2/songs/x1/videos/link', { url: 'https://cdn.example.com/a.mp4' })).status, 403);
  assert.equal((await call('u_pm', 'PATCH', '/api/projects/p2/songs/x1', { status: 'approved' })).status, 403);
  assert.equal((await call('u_pm', 'POST', '/api/comments?session=p2-x1', { comment: { id: 'c_x', text: '亂入' } })).status, 403);
  assert.equal((await call('u_pm', 'GET', '/api/users')).status, 403);
  assert.equal((await call('u_pm', 'GET', '/api/invites')).status, 403);
  assert.equal((await call('u_pm', 'PATCH', '/api/projects/p1', { look_settings: {} })).status, 403);
  assert.equal((await call('u_pm', 'PATCH', '/api/projects/p1', { drive_folder_id: 'x' })).status, 403);
});
