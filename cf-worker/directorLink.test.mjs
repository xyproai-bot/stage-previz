// 跑法：cd cf-worker && npm test
// 導演貼連結交一版：走一遍真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1 + 記憶體假 R2 + 假的來源網站）
//   導演可以貼連結 → 後台複製 → 變成下一個版本；上傳檔案還是不行；
//   好了之後歌的狀態不動（需修改不會自動變審查中）、不通知導演，通知這首歌的動畫師和製作；
//   導演只能動自己貼的那一版；動畫師貼的照舊（需修改 → 審查中、通知導演）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';

const BASE = 'https://proxy.test';
const CLIP_URL = 'https://cdn.example.com/director-ref.mp4';
const CLIP = new Uint8Array(4096).map((_, i) => (i * 31) & 255);

/** 假的來源網站：支援 Range（跟一般 CDN 一樣） */
function fakeSource(realFetch) {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('https://cdn.example.com/')) return realFetch(input, init);
    const h = new Headers(init.headers || (typeof input === 'string' ? undefined : input.headers));
    const range = /^bytes=(\d+)-(\d*)$/.exec(h.get('range') || '');
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(CLIP.length - 1, range[2] ? Number(range[2]) : CLIP.length - 1);
      return new Response(CLIP.slice(start, end + 1), {
        status: 206,
        headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${CLIP.length}`, 'content-length': String(end - start + 1) },
      });
    }
    return new Response(CLIP, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(CLIP.length) } });
  };
}

/** 記憶體假 R2 再加上分段上傳（後台複製用） */
function r2WithMultipart() {
  const r2 = memoryR2();
  const uploads = new Map();
  const handle = (key, uploadId) => ({
    key, uploadId,
    async uploadPart(partNumber, body) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      uploads.get(uploadId).set(partNumber, bytes);
      return { partNumber, etag: `etag-${partNumber}` };
    },
    async complete(parts) {
      const got = uploads.get(uploadId);
      const chunks = [...parts].sort((a, b) => a.partNumber - b.partNumber).map(p => got.get(p.partNumber));
      const all = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
      let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      uploads.delete(uploadId);
      return r2.put(key, all, { httpMetadata: { contentType: 'video/mp4' } });
    },
    async abort() { uploads.delete(uploadId); },
  });
  r2.createMultipartUpload = async (key) => {
    const id = 'up_' + Math.random().toString(36).slice(2);
    uploads.set(id, new Map());
    return handle(key, id);
  };
  r2.resumeMultipartUpload = (key, uploadId) => handle(key, uploadId);
  return r2;
}

async function setup() {
  const db = freshDb();
  const users = [
    ['u_admin', '製作', 'admin', 'ADMIN-1'], ['u_dir', '王導', 'director', 'DIR-1'], ['u_dir2', '李導', 'director', 'DIR-2'],
    ['u_a1', '阿凱', 'animator', 'ANI-1'], ['u_a2', '小美', 'animator', 'ANI-2'],
  ];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, `${id}@x.test`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '金馬')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_admin', 'admin'), ('p1', 'u_dir', 'director'), ('p1', 'u_dir2', 'director'), ('p1', 'u_a1', 'animator'), ('p1', 'u_a2', 'animator')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, animator_user_id, code) VALUES ('s1', 'p1', '夜曲', 0, 'needs_changes', 'u_a1', 'S03')`),
    db.prepare(`INSERT INTO song_videos (id, project_id, song_id, version, title, source, r2_key, mime, status, created_by, ready_at)
                VALUES ('sv_1', 'p1', 's1', 2, 'V2', 'upload', 'videos/p1/s1/sv_1.mp4', 'video/mp4', 'ready', 'u_a1', '2026-10-14T00:00:00.000Z')`),
    db.prepare(`UPDATE songs SET video_version_seq = 2 WHERE id = 's1'`),
  ]);
  const env = { DB: db, AUTH_SECRET: 'test-secret', MODELS: r2WithMultipart() };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
  const tokens = {};
  for (const [id, , , code] of users) {
    const r = await worker.fetch(new Request(`${BASE}/api/auth/login`, {
      method: 'POST', body: JSON.stringify({ accessCode: code }), headers: { 'content-type': 'application/json' },
    }), env, ctx);
    tokens[id] = (await r.json()).token;
  }
  const call = async (who, method, path, body) => {
    const headers = { 'content-type': 'application/json' };
    if (who) headers.authorization = `Bearer ${tokens[who]}`;
    const r = await worker.fetch(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
    let data = null;
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data };
  };
  /** 等背景複製做完（每次叫清單都會推一下） */
  const settle = async (who = 'u_dir') => {
    for (let i = 0; i < 20; i++) {
      while (pending.length) await pending.shift();
      const list = await call(who, 'GET', '/api/projects/p1/songs/s1/videos');
      if (!list.data.videos.some(v => v.status === 'processing')) return list.data;
    }
    throw new Error('複製一直沒好');
  };
  return { db, call, settle };
}

const notesOf = async (db, userId) => (await db.prepare(
  `SELECT kind, video_version, actor_name, song_id FROM notifications WHERE user_id = ? ORDER BY rowid`
).bind(userId).all()).results;

test('導演貼連結 → 複製好變成下一版（V3）；狀態不動；通知動畫師和製作，不通知導演', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeSource(realFetch);
  t.after(() => { globalThis.fetch = realFetch; });
  const { db, call, settle } = await setup();

  // 上傳檔案還是不行
  const up = await call('u_dir', 'POST', '/api/projects/p1/songs/s1/videos/uploads', { filename: 'a.mp4', sizeBytes: 1000, mime: 'video/mp4' });
  assert.equal(up.status, 403);
  assert.match(up.data.error, /貼連結/);

  const r = await call('u_dir', 'POST', '/api/projects/p1/songs/s1/videos/link', { url: CLIP_URL, note: '客戶給的參考' });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal(r.data.video.source, 'link');
  assert.equal(r.data.video.createdBy.name, '王導');

  const list = await settle();
  const mine = list.videos.find(v => v.id === r.data.video.id);
  assert.equal(mine.status, 'ready', mine.error);
  assert.equal(mine.version, 3);
  assert.equal(mine.label, 'V3');
  assert.equal(list.latestVideoId, mine.id);

  // 歌還是「需修改」（導演貼的不算動畫師改好重交）
  assert.equal((await db.prepare(`SELECT status FROM songs WHERE id = 's1'`).first()).status, 'needs_changes');
  // 通知：這首歌的動畫師、製作；導演（自己、別的導演）和別的動畫師沒有
  assert.deepEqual(await notesOf(db, 'u_a1'), [{ kind: 'director_video', video_version: 3, actor_name: '王導', song_id: 's1' }]);
  assert.deepEqual((await notesOf(db, 'u_admin')).map(n => n.kind), ['director_video']);
  assert.equal((await notesOf(db, 'u_dir')).length, 0);
  assert.equal((await notesOf(db, 'u_dir2')).length, 0);
  assert.equal((await notesOf(db, 'u_a2')).length, 0);
  // 動畫師的小鈴鐺 API 看得到
  const bell = await call('u_a1', 'GET', '/api/notifications?limit=10');
  assert.equal(bell.status, 200);
  assert.equal(bell.data.items[0].kind, 'director_video');
  assert.equal(bell.data.items[0].versionLabel, 'V3');

  // 導演可以改自己貼的那一版的說明、刪掉；別的導演、動不了；也動不了動畫師交的
  assert.equal((await call('u_dir', 'PATCH', `/api/projects/p1/songs/s1/videos/${mine.id}`, { note: '改一下' })).status, 200);
  assert.equal((await call('u_dir2', 'DELETE', `/api/projects/p1/songs/s1/videos/${mine.id}`)).status, 403);
  assert.equal((await call('u_dir', 'DELETE', '/api/projects/p1/songs/s1/videos/sv_1')).status, 403);
  assert.equal((await call('u_dir', 'DELETE', `/api/projects/p1/songs/s1/videos/${mine.id}`)).status, 200);
});

test('動畫師貼連結照舊：需修改 → 審查中、通知導演「新版等你審」', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeSource(realFetch);
  t.after(() => { globalThis.fetch = realFetch; });
  const { db, call, settle } = await setup();
  const r = await call('u_a1', 'POST', '/api/projects/p1/songs/s1/videos/link', { url: CLIP_URL });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  await settle('u_a1');
  assert.equal((await db.prepare(`SELECT status FROM songs WHERE id = 's1'`).first()).status, 'in_review');
  assert.deepEqual((await notesOf(db, 'u_dir')).map(n => n.kind), ['new_version']);
  assert.equal((await notesOf(db, 'u_a1')).length, 0);
  // 指派給別人的動畫師還是不能貼
  assert.equal((await call('u_a2', 'POST', '/api/projects/p1/songs/s1/videos/link', { url: CLIP_URL })).status, 403);
});
