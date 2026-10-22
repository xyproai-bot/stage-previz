// 跑法：cd cf-worker && npm test
// 浮水印與禁止下載（0038）走一遍真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1 + 記憶體假 R2）：
//   新連結預設兩個都開、舊連結（0038 以前建的）兩個都關、舊版前端的寫法照樣能用、
//   禁止下載的連結：影片網址要帶綁連結 + 影片的短效播放通行證，沒帶 / 過期 / 別條連結的 / 別支影片的一律 401，不碰 R2；
//   沒開的連結：影片網址跟以前一模一樣；密碼通行證照舊；專案「成員看片也加浮水印」只有製作能改。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, applyMigrations, freshDb, migrationFiles } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import { signSharePlay, shortLinkId, SHARE_PLAY_BUCKET_MS } from './shareMedia.mjs';
import worker from './worker.js';

const BASE = 'https://proxy.test';
const VIDEO_BYTES = new Uint8Array(Array.from({ length: 64 }, (_, i) => i));

async function setup() {
  const db = freshDb();
  const users = [
    ['u_admin', '製作', 'admin', 'ADMIN-1'], ['u_dir', '王導', 'director', 'DIR-1'], ['u_a1', '阿凱', 'animator', 'ANI-1'],
  ];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, id === 'u_a1' ? `${id}@auto.local` : `${id}@studio.example.com`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '金馬')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director'), ('p1', 'u_a1', 'animator')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, code) VALUES ('s1', 'p1', '開場', 0, 'in_review', 'S01')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, code) VALUES ('s2', 'p1', '安可', 1, 'todo', 'S02')`),
    db.prepare(`INSERT INTO song_videos (id, project_id, song_id, version, title, source, r2_key, mime, size_bytes, status, created_by, ready_at)
                VALUES ('sv_1', 'p1', 's1', 1, 'V1', 'upload', 'videos/p1/s1/sv_1.mp4', 'video/mp4', 64, 'ready', 'u_a1', '2026-10-14T00:00:00.000Z')`),
    db.prepare(`INSERT INTO song_videos (id, project_id, song_id, version, title, source, r2_key, mime, size_bytes, status, created_by, ready_at)
                VALUES ('sv_2', 'p1', 's2', 1, 'V1', 'upload', 'videos/p1/s2/sv_2.mp4', 'video/mp4', 64, 'ready', 'u_a1', '2026-10-14T00:00:00.000Z')`),
  ]);
  const r2 = memoryR2();
  await r2.put('videos/p1/s1/sv_1.mp4', VIDEO_BYTES, { httpMetadata: { contentType: 'video/mp4' } });
  await r2.put('videos/p1/s2/sv_2.mp4', VIDEO_BYTES, { httpMetadata: { contentType: 'video/mp4' } });
  const env = { DB: db, AUTH_SECRET: 'test-secret', MODELS: r2 };
  const tokens = {};
  for (const [id, , , code] of users) {
    const r = await worker.fetch(new Request(`${BASE}/api/auth/login`, {
      method: 'POST', body: JSON.stringify({ accessCode: code }), headers: { 'content-type': 'application/json' },
    }), env);
    tokens[id] = (await r.json()).token;
  }
  const call = async (who, method, path, body, extraHeaders = {}) => {
    const headers = { 'content-type': 'application/json', ...extraHeaders };
    if (who) headers.authorization = `Bearer ${tokens[who]}`;
    const r = await worker.fetch(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    let data = null;
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data, res: r };
  };
  const bytesOf = async (res) => [...new Uint8Array(await res.arrayBuffer())];
  return { db, env, r2, call, bytesOf };
}

const streamPath = (token, id = 'sv_1') => `/api/share/${token}/song-videos/${id}/stream`;
const queryOf = (url) => new URL(url, BASE).searchParams;

test('migration 0038：舊連結兩個都是關、舊專案成員浮水印是關；舊版 worker 的 INSERT 照樣能寫', async () => {
  assert.ok(migrationFiles().includes('0038_share_watermark.sql'));
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0038' });
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role) VALUES ('u_x', 'x@x.test', 'X', 'director')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p', 'P')`),
    db.prepare(`INSERT INTO share_links (token, project_id, slug, label) VALUES ('tk_old', 'p', 'old-link', '給經紀人')`),
  ]);
  applyMigrations(db, { only: '0038' });
  const l = await db.prepare(`SELECT * FROM share_links WHERE token = 'tk_old'`).first();
  assert.equal(l.watermark, 0);
  assert.equal(l.no_download, 0);
  assert.equal(l.slug, 'old-link');
  assert.equal(l.label, '給經紀人');
  assert.equal((await db.prepare(`SELECT watermark_members FROM projects WHERE id = 'p'`).first()).watermark_members, 0);
  // 舊版 worker 的 INSERT（沒有新欄位）照樣能寫，而且是關的
  await db.prepare(`INSERT INTO share_links (token, project_id) VALUES ('tk_new', 'p')`).run();
  const n = await db.prepare(`SELECT watermark, no_download FROM share_links WHERE token = 'tk_new'`).first();
  assert.deepEqual({ ...n }, { watermark: 0, no_download: 0 });
});

test('建連結：舊版前端（沒送這兩個欄位）建的新連結 = 浮水印關、禁止下載開；新版前端送什麼就是什麼；清單帶連結編號', async () => {
  const { call } = await setup();
  let r = await call('u_dir', 'POST', '/api/projects/p1/share-links', {});
  assert.equal(r.status, 201, r.data?.error);
  assert.equal(r.data.watermark, false);
  assert.equal(r.data.noDownload, true);
  assert.match(r.data.shortId, /^[0-9A-HJ-NP-Z]{6}$/);
  assert.equal(r.data.shortId, await shortLinkId(r.data.token));
  const defaultToken = r.data.token;

  r = await call('u_dir', 'POST', '/api/projects/p1/share-links', { watermark: false, noDownload: false });
  assert.equal(r.status, 201);
  assert.equal(r.data.watermark, false);
  assert.equal(r.data.noDownload, false);
  const offToken = r.data.token;

  r = await call('u_dir', 'POST', '/api/projects/p1/share-links', { watermark: 'maybe' });
  assert.equal(r.status, 400);

  r = await call('u_dir', 'GET', '/api/projects/p1/share-links');
  const byToken = Object.fromEntries(r.data.links.map(l => [l.token, l]));
  assert.equal(byToken[defaultToken].watermark, false);
  assert.equal(byToken[defaultToken].noDownload, true);
  assert.equal(byToken[offToken].watermark, false);
  assert.equal(byToken[offToken].noDownload, false);
  assert.equal(byToken[defaultToken].shortId, await shortLinkId(defaultToken));
});

test('改連結：只改有給的；導演、製作都能改；舊版前端只送 slug 照樣能用', async () => {
  const { call } = await setup();
  const { data: { token } } = await call('u_dir', 'POST', '/api/projects/p1/share-links', {});
  let r = await call('u_dir', 'PATCH', `/api/projects/p1/share-links/${token}`, { watermark: false });
  assert.equal(r.status, 200, r.data?.error);
  assert.equal(r.data.watermark, false);
  assert.equal(r.data.noDownload, true, '沒給的不動');
  r = await call('u_admin', 'PATCH', `/api/projects/p1/share-links/${token}`, { noDownload: false, watermark: true });
  assert.equal(r.data.watermark, true);
  assert.equal(r.data.noDownload, false);
  r = await call('u_dir', 'PATCH', `/api/projects/p1/share-links/${token}`, { slug: 'jinma-test' });
  assert.equal(r.status, 200);
  assert.equal(r.data.slug, 'jinma-test');
  assert.equal(r.data.watermark, true, '改網址名稱不動這兩個');
  r = await call('u_dir', 'PATCH', `/api/projects/p1/share-links/${token}`, {});
  assert.equal(r.status, 400);
  r = await call('u_dir', 'PATCH', `/api/projects/p1/share-links/${token}`, { noDownload: 'no' });
  assert.equal(r.status, 400);
  // 動畫師不能管分享連結
  r = await call('u_a1', 'PATCH', `/api/projects/p1/share-links/${token}`, { watermark: false });
  assert.equal(r.status, 403);
});

test('禁止下載的連結：data / versions 給的影片網址帶播放通行證；沒通行證、改過的、別條連結的、別支影片的、過期的都 401，而且不碰 R2', async () => {
  const { call, r2, bytesOf, env } = await setup();
  const { data: link } = await call('u_dir', 'POST', '/api/projects/p1/share-links', { watermark: true, noDownload: true });
  const data = (await call(null, 'GET', `/api/share/${link.token}/data`)).data;
  const url = data.songs.find(s => s.id === 's1').latestVideo.streamUrl;
  assert.ok(url.startsWith(streamPath(link.token)), url);
  assert.ok(queryOf(url).get('play'), '有播放通行證');
  assert.ok(!JSON.stringify(data).includes('videos/p1/'), '回應裡沒有 R2 的檔案位置');
  assert.deepEqual(data.protection, { watermark: true, noDownload: true, linkId: await shortLinkId(link.token), linkName: null });

  const versions = (await call(null, 'GET', `/api/share/${link.token}/songs/s1/versions`)).data;
  assert.ok(queryOf(versions.videos[0].streamUrl).get('play'));
  assert.ok(!JSON.stringify(versions).includes('r2_key') && !JSON.stringify(versions).includes('videos/p1/'));

  // 帶通行證 → 播得到（含 Range）
  const getsBefore = r2.calls.get;
  let r = await call(null, 'GET', url);
  assert.equal(r.status, 200);
  assert.deepEqual(await bytesOf(r.res), [...VIDEO_BYTES]);
  assert.equal(r.res.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.res.headers.get('content-disposition'), 'inline');
  r = await call(null, 'GET', url, undefined, { range: 'bytes=10-19' });
  assert.equal(r.status, 206);
  assert.deepEqual(await bytesOf(r.res), [...VIDEO_BYTES.slice(10, 20)]);
  r = await call(null, 'HEAD', url);
  assert.equal(r.status, 200);
  assert.ok(r2.calls.get + r2.calls.head > getsBefore);

  // 沒通行證 / 亂寫 / 改過
  const touched = () => r2.calls.get + r2.calls.head;
  const before = touched();
  for (const bad of [
    streamPath(link.token),
    `${streamPath(link.token)}?play=`,
    `${streamPath(link.token)}?play=abc`,
    `${streamPath(link.token)}?play=${queryOf(url).get('play')}x`,
  ]) {
    const x = await call(null, 'GET', bad);
    assert.equal(x.status, 401, bad);
    assert.ok(x.data.error, bad);
  }
  // HEAD 也一樣
  assert.equal((await call(null, 'HEAD', streamPath(link.token))).status, 401);
  assert.equal(touched(), before, '被拒絕的請求完全沒碰 R2');

  // 別支影片：拿 sv_1 的通行證開 sv_2
  const other = await call(null, 'GET', `${streamPath(link.token, 'sv_2')}?play=${encodeURIComponent(queryOf(url).get('play'))}`);
  assert.equal(other.status, 401);
  // 別條連結：拿這條的通行證開另一條
  const { data: link2 } = await call('u_dir', 'POST', '/api/projects/p1/share-links', { noDownload: true });
  const cross = await call(null, 'GET', `${streamPath(link2.token)}?play=${encodeURIComponent(queryOf(url).get('play'))}`);
  assert.equal(cross.status, 401);
  // 過期的（簽在很久以前的）
  const old = await signSharePlay(env.AUTH_SECRET, { linkToken: link.token, mediaId: 'sv_1', now: Date.now() - 3 * SHARE_PLAY_BUCKET_MS });
  const expired = await call(null, 'GET', `${streamPath(link.token)}?play=${encodeURIComponent(old)}`);
  assert.equal(expired.status, 401);
  assert.equal(expired.data.passExpired, true);
  // 直接猜 R2 的路徑也拿不到影片（/r2/ 只放模型和模型庫）
  assert.equal((await call(null, 'GET', '/r2/videos/p1/s1/sv_1.mp4')).status, 404);
});

test('禁止下載 + 好讀網址 + 密碼：影片網址同時帶 access（密碼通行證）和 play；少一個都不行', async () => {
  const { call, bytesOf } = await setup();
  const { data: link } = await call('u_dir', 'POST', '/api/projects/p1/share-links', { password: 'sesame', slug: 'jinma-wm', noDownload: true, watermark: false });
  let r = await call(null, 'GET', '/api/s/jinma-wm/data');
  assert.equal(r.status, 401);
  r = await call(null, 'GET', '/api/s/jinma-wm/data', undefined, { 'x-share-password': 'sesame' });
  assert.equal(r.status, 200, r.data?.error);
  const url = r.data.songs.find(s => s.id === 's1').latestVideo.streamUrl;
  assert.ok(url.startsWith('/api/s/jinma-wm/song-videos/sv_1/stream?'), '用好讀網址開的人，網址裡沒有連結碼');
  assert.ok(!url.includes(link.token));
  const q = queryOf(url);
  assert.ok(q.get('access') && q.get('play'));
  assert.equal(r.data.protection.linkId, await shortLinkId(link.token));
  assert.equal(r.data.protection.linkName, null, '沒開浮水印不給連結名稱');

  r = await call(null, 'GET', url);
  assert.equal(r.status, 200);
  assert.deepEqual(await bytesOf(r.res), [...VIDEO_BYTES]);
  // 只有 access、沒有 play
  r = await call(null, 'GET', `/api/s/jinma-wm/song-videos/sv_1/stream?access=${encodeURIComponent(q.get('access'))}`);
  assert.equal(r.status, 401);
  // 只有 play、沒有 access
  r = await call(null, 'GET', `/api/s/jinma-wm/song-videos/sv_1/stream?play=${encodeURIComponent(q.get('play'))}`);
  assert.equal(r.status, 401);
});

test('沒開禁止下載的連結：影片網址跟以前一模一樣（沒有 play）、不用通行證就能播、照舊可以快取', async () => {
  const { call, bytesOf } = await setup();
  const { data: link } = await call('u_dir', 'POST', '/api/projects/p1/share-links', { watermark: false, noDownload: false });
  const data = (await call(null, 'GET', `/api/share/${link.token}/data`)).data;
  const url = data.songs.find(s => s.id === 's1').latestVideo.streamUrl;
  assert.equal(url, streamPath(link.token));
  assert.deepEqual(data.protection, { watermark: false, noDownload: false, linkId: await shortLinkId(link.token), linkName: null });
  const r = await call(null, 'GET', url);
  assert.equal(r.status, 200);
  assert.deepEqual(await bytesOf(r.res), [...VIDEO_BYTES]);
  assert.match(r.res.headers.get('cache-control'), /immutable/);
});

test('舊連結（0038 以前建的，兩個都是 0）：行為完全不變', async () => {
  const { call, db, bytesOf } = await setup();
  await db.prepare(`INSERT INTO share_links (token, project_id, label) VALUES ('tk_legacy_0000000000000000000000', 'p1', '舊連結')`).run();
  const tk = 'tk_legacy_0000000000000000000000';
  const data = (await call(null, 'GET', `/api/share/${tk}/data`)).data;
  assert.equal(data.songs.find(s => s.id === 's1').latestVideo.streamUrl, streamPath(tk));
  assert.equal(data.protection.watermark, false);
  assert.equal(data.protection.noDownload, false);
  const r = await call(null, 'GET', streamPath(tk));
  assert.equal(r.status, 200);
  assert.deepEqual(await bytesOf(r.res), [...VIDEO_BYTES]);
  const list = (await call('u_dir', 'GET', '/api/projects/p1/share-links')).data.links.find(l => l.token === tk);
  assert.equal(list.watermark, false);
  assert.equal(list.noDownload, false);
});

test('浮水印的字：開了浮水印才給連結名稱（先用連結名稱，沒有就用好讀網址名稱）', async () => {
  const { call } = await setup();
  const { data: a } = await call('u_dir', 'POST', '/api/projects/p1/share-links', { watermark: true, label: '給經紀人', slug: 'agent-k7p2' });
  let d = (await call(null, 'GET', `/api/share/${a.token}/data`)).data;
  assert.equal(d.protection.linkName, '給經紀人');
  const { data: b } = await call('u_dir', 'POST', '/api/projects/p1/share-links', { watermark: true, slug: 'plain-k7p2' });
  d = (await call(null, 'GET', `/api/share/${b.token}/data`)).data;
  assert.equal(d.protection.linkName, 'plain-k7p2');
  const { data: c } = await call('u_dir', 'POST', '/api/projects/p1/share-links', { watermark: false, label: '不要印出來' });
  d = (await call(null, 'GET', `/api/share/${c.token}/data`)).data;
  assert.equal(d.protection.linkName, null);
});

test('禁止下載的連結改成關掉 / 打開，馬上生效', async () => {
  const { call } = await setup();
  const { data: link } = await call('u_dir', 'POST', '/api/projects/p1/share-links', { noDownload: true });
  assert.equal((await call(null, 'GET', streamPath(link.token))).status, 401);
  await call('u_dir', 'PATCH', `/api/projects/p1/share-links/${link.token}`, { noDownload: false });
  assert.equal((await call(null, 'GET', streamPath(link.token))).status, 200);
  await call('u_dir', 'PATCH', `/api/projects/p1/share-links/${link.token}`, { noDownload: true });
  assert.equal((await call(null, 'GET', streamPath(link.token))).status, 401);
});

test('成員看片也加浮水印：預設關，只有製作能改，清單和專案資料都看得到', async () => {
  const { call } = await setup();
  let r = await call('u_dir', 'GET', '/api/projects');
  assert.equal(r.data.projects.find(p => p.id === 'p1').watermarkMembers, false);

  r = await call('u_dir', 'PATCH', '/api/projects/p1', { watermarkMembers: true });
  assert.equal(r.status, 403);
  r = await call('u_a1', 'PATCH', '/api/projects/p1', { watermark_members: true });
  assert.equal(r.status, 403);
  r = await call('u_admin', 'PATCH', '/api/projects/p1', { watermarkMembers: 'yes' });
  assert.equal(r.status, 400);
  r = await call('u_admin', 'PATCH', '/api/projects/p1', { watermarkMembers: true });
  assert.equal(r.status, 200, r.data?.error);

  r = await call('u_dir', 'GET', '/api/projects');
  assert.equal(r.data.projects.find(p => p.id === 'p1').watermarkMembers, true, '導演看得到，不用另外查');
  r = await call('u_a1', 'GET', '/api/projects/p1');
  assert.equal(r.data.project.watermark_members, 1);
  r = await call('u_admin', 'PATCH', '/api/projects/p1', { watermarkMembers: false });
  assert.equal(r.status, 200);
  r = await call('u_dir', 'GET', '/api/projects');
  assert.equal(r.data.projects.find(p => p.id === 'p1').watermarkMembers, false);
});

test('登入資料：有真的 email 就帶（浮水印用），系統塞的假 email 不帶；舊的欄位都還在', async () => {
  const { call } = await setup();
  let r = await call('u_dir', 'GET', '/api/auth/me');
  assert.equal(r.status, 200);
  assert.equal(r.data.user.email, 'u_dir@studio.example.com');
  assert.equal(r.data.user.name, '王導');
  assert.equal(r.data.user.role, 'director');
  r = await call('u_a1', 'GET', '/api/auth/me');
  assert.equal('email' in r.data.user, false);
  assert.equal(r.data.user.name, '阿凱');
});
