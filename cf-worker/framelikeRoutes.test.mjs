// 跑法：cd cf-worker && npm test
// 審片像 Frame.io（0026）走一遍真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1 + 記憶體假 R2）：
//   留言記住 3D 視角 / 畫記 / 區段 / 縮圖、區段檢查、縮圖網址；
//   分享連結「允許看的人留言」（只有製作能開）、訪客留言（名字、不收 HTML、防亂發、只看得到自己連結的串、密碼照舊）、
//   團隊看到「訪客：名字（連結名稱）」+ 小鈴鐺；migration 0026 在舊資料上、舊版前端的寫法照樣能用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, applyMigrations, freshDb, migrationFiles } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';

const BASE = 'https://proxy.test';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 0xff, 0xd9]);
const JPEG_URL = 'data:image/jpeg;base64,' + Buffer.from(JPEG).toString('base64');
const VIEW = { position: [6, 4, 9], target: [0, 1.5, 0], fov: 42, aspect: 1.6 };
const ANN = { v: 1, aspect: 1.6, shapes: [
  { t: 'arrow', c: '#ff3b30', w: 0.006, p: [0.2, 0.2, 0.45, 0.4] },
  { t: 'ellipse', c: '#ff3b30', w: 0.006, p: [0.5, 0.3, 0.7, 0.6] },
] };

async function setup() {
  const db = freshDb();
  const users = [
    ['u_admin', '製作', 'admin', 'ADMIN-1'], ['u_dir', '王導', 'director', 'DIR-1'],
    ['u_a1', '阿凱', 'animator', 'ANI-1'], ['u_a2', '小美', 'animator', 'ANI-2'],
  ];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, `${id}@x.test`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '金馬')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director'), ('p1', 'u_a1', 'animator'), ('p1', 'u_a2', 'animator')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, animator_user_id, code) VALUES ('s1', 'p1', '開場', 0, 'in_review', 'u_a1', 'S01')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, code) VALUES ('s2', 'p1', '安可', 1, 'todo', 'S02')`),
    db.prepare(`INSERT INTO song_videos (id, project_id, song_id, version, title, source, r2_key, mime, status, created_by, ready_at)
                VALUES ('sv_1', 'p1', 's1', 1, 'V1', 'upload', 'videos/p1/s1/sv_1.mp4', 'video/mp4', 'ready', 'u_a1', '2026-10-14T00:00:00.000Z')`),
  ]);
  const r2 = memoryR2();
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
  return { db, env, r2, call };
}

let n = 0;
const cid = () => `c_f${++n}`;
const COMMENTS = '/api/comments?session=p1-s1';
const guestCall = (call, base, method, sub, body, ip = '198.51.100.7', headers = {}) =>
  call(null, method, `${base}${sub}`, body, { 'cf-connecting-ip': ip, ...headers });

test('migration 0026：舊留言、舊分享連結都還在，新欄位是空的 / 關的；舊版的寫法照樣能寫', async () => {
  assert.ok(migrationFiles().includes('0026_framelike_review.sql'));
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0026' });
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role) VALUES ('u_x', 'x@x.test', 'X', 'director')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p', 'P')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order") VALUES ('s', 'p', 'S', 0)`),
    db.prepare(`INSERT INTO comments (id, project_id, song_id, time_in_video, text, author_name, author_role, created_at, video_version)
                VALUES ('c_old', 'p', 's', 3, '舊留言', 'X', 'director', '2026-10-01T00:00:00.000Z', 1)`),
    db.prepare(`INSERT INTO share_links (token, project_id, slug) VALUES ('tk_old', 'p', 'old-link')`),
  ]);
  applyMigrations(db, { only: '0026' });
  const c = await db.prepare(`SELECT * FROM comments WHERE id = 'c_old'`).first();
  assert.equal(c.text, '舊留言');
  assert.equal(c.video_version, 1);
  for (const k of ['time_end', 'view_json', 'cue_id', 'annotation_json', 'thumb_key', 'guest_name', 'share_token', 'share_label']) {
    assert.equal(c[k], null, k);
  }
  const l = await db.prepare(`SELECT * FROM share_links WHERE token = 'tk_old'`).first();
  assert.equal(l.allow_comments, 0);   // 舊連結一律關
  assert.equal(l.label, null);
  assert.equal(l.slug, 'old-link');
  // 舊版 worker 的 INSERT（沒有新欄位）照樣能寫
  await db.prepare(`INSERT INTO share_links (token, project_id, song_id, password, password_hash, password_salt, expires_at, created_by_user_id, slug)
                    VALUES ('tk_new', 'p', NULL, NULL, NULL, NULL, NULL, 'u_x', NULL)`).run();
  assert.equal((await db.prepare(`SELECT allow_comments FROM share_links WHERE token = 'tk_new'`).first()).allow_comments, 0);
});

test('團隊留言：記住 3D 視角、畫記、區段、cue、縮圖；縮圖網址拿得到；刪留言縮圖一起清掉', async () => {
  const { call, r2 } = await setup();
  const id = cid();
  let r = await call('u_dir', 'POST', COMMENTS, { comment: {
    id, text: '這裡升降台太快', time: 12, timeEnd: 18, videoId: 'sv_1', view: VIEW, cueId: 'cue_3', annotation: ANN,
    thumbnail: JPEG_URL, createdAt: new Date().toISOString(),
  } });
  assert.equal(r.status, 200, r.data?.error);
  const c = r.data.comments.find(x => x.id === id);
  assert.equal(c.time, 12);
  assert.equal(c.timeEnd, 18);
  assert.deepEqual(c.view, VIEW);
  assert.equal(c.cueId, 'cue_3');
  assert.equal(c.annotation.shapes.length, 2);
  assert.equal(c.videoVersion, 1);
  assert.match(c.thumbUrl, /^\/api\/comment-thumbs\/p1\/c_f\d+-[0-9a-f]{32}\.jpg$/);

  // 動畫師讀到同樣的東西
  r = await call('u_a1', 'GET', COMMENTS);
  assert.deepEqual(r.data.comments.find(x => x.id === id).view, VIEW);

  // 縮圖：不用登入（網址有隨機碼），JPEG、可以快取
  const img = await call(null, 'GET', c.thumbUrl);
  assert.equal(img.status, 200);
  assert.equal(img.res.headers.get('content-type'), 'image/jpeg');
  assert.match(img.res.headers.get('cache-control'), /immutable/);
  assert.deepEqual([...new Uint8Array(await img.res.arrayBuffer())], [...JPEG]);
  assert.equal((await call(null, 'GET', '/api/comment-thumbs/p1/nope.jpg')).status, 404);

  // 回覆底下的縮圖也一起清
  r = await call('u_a1', 'POST', COMMENTS, { comment: { id: cid(), text: '改好了', parentId: id, thumbnail: JPEG_URL } });
  assert.equal(r.status, 200, r.data?.error);
  assert.equal(r2.keys().filter(k => k.startsWith('comment-thumbs/')).length, 2);
  r = await call('u_dir', 'DELETE', `${COMMENTS}&id=${id}`);
  assert.equal(r.status, 200);
  assert.equal(r2.keys().filter(k => k.startsWith('comment-thumbs/')).length, 0);
  assert.equal((await call(null, 'GET', c.thumbUrl)).status, 404);
});

test('團隊留言：區段 / 畫記 / 縮圖不對 → 說清楚哪裡不對；舊版前端（沒有新欄位）照樣能留', async () => {
  const { call } = await setup();
  let r = await call('u_dir', 'POST', COMMENTS, { comment: { id: cid(), text: 'x', time: 20, timeEnd: 10 } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /結束要在開始之後/);
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: cid(), text: 'x', time: 0, timeEnd: 5000 } });
  assert.match(r.data.error, /太長/);
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: cid(), text: 'x', annotation: { ...ANN, shapes: [{ ...ANN.shapes[0], c: 'pink' }] } } });
  assert.equal(r.status, 400);
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: cid(), text: 'x', thumbnail: 'data:image/png;base64,AAAA' } });
  assert.equal(r.status, 400);
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: cid(), text: 'x', thumbnail: 'data:image/jpeg;base64,' + 'A'.repeat(260_000) } });
  assert.equal(r.status, 413);
  // 視角壞掉不擋（只是不記）
  const okId = cid();
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: okId, text: '視角壞掉', view: { position: [0, 0, 0], target: [0, 0, 0], fov: 50 } } });
  assert.equal(r.status, 200);
  assert.equal('view' in r.data.comments.find(x => x.id === okId), false);
  // 舊版前端的格式
  const oldId = cid();
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: oldId, text: '舊版', time: 3, x: 0.5, y: 0.5, email: null, createdAt: new Date().toISOString() } });
  assert.equal(r.status, 200);
  const old = r.data.comments.find(x => x.id === oldId);
  for (const k of ['timeEnd', 'view', 'annotation', 'thumbUrl']) assert.equal(k in old, false, k);
});

async function makeLink(call, who, body) {
  const r = await call(who, 'POST', '/api/projects/p1/share-links', body);
  return r;
}

test('分享連結「允許看的人留言」：只有製作能打開；導演可以關、可以取名；預設關；舊版只送網址名稱照樣能改', async () => {
  const { call } = await setup();
  let r = await makeLink(call, 'u_dir', { allowComments: true });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /只有製作/);
  r = await makeLink(call, 'u_dir', { label: '給經紀人' });
  assert.equal(r.status, 201);
  const dirLink = r.data.token;
  assert.equal(r.data.allowComments, false);
  r = await makeLink(call, 'u_admin', { allowComments: true, label: '<b>給客戶</b>' });
  assert.equal(r.status, 201);
  assert.equal(r.data.allowComments, true);
  assert.equal(r.data.label, '給客戶');
  const adminLink = r.data.token;

  r = await call('u_dir', 'GET', '/api/projects/p1/share-links');
  const byToken = Object.fromEntries(r.data.links.map(l => [l.token, l]));
  assert.equal(byToken[dirLink].allowComments, false);
  assert.equal(byToken[dirLink].label, '給經紀人');
  assert.equal(byToken[adminLink].allowComments, true);
  assert.equal(byToken[adminLink].guestCommentCount, 0);

  // 導演打開 → 403；關掉 → 可以
  assert.equal((await call('u_dir', 'PATCH', `/api/projects/p1/share-links/${dirLink}`, { allowComments: true })).status, 403);
  r = await call('u_dir', 'PATCH', `/api/projects/p1/share-links/${adminLink}`, { allowComments: false });
  assert.equal(r.status, 200);
  assert.equal(r.data.allowComments, false);
  r = await call('u_admin', 'PATCH', `/api/projects/p1/share-links/${adminLink}`, { allowComments: true, label: '給客戶 B' });
  assert.equal(r.data.allowComments, true);
  assert.equal(r.data.label, '給客戶 B');
  // 舊版前端：只送 slug
  r = await call('u_dir', 'PATCH', `/api/projects/p1/share-links/${adminLink}`, { slug: 'jinma-test' });
  assert.equal(r.status, 200);
  assert.equal(r.data.slug, 'jinma-test');
  assert.equal(r.data.allowComments, true);
  // 什麼都沒送 → 跟以前一樣 400
  assert.equal((await call('u_dir', 'PATCH', `/api/projects/p1/share-links/${adminLink}`, {})).status, 400);
  // 動畫師不能管分享連結
  assert.equal((await call('u_a1', 'PATCH', `/api/projects/p1/share-links/${adminLink}`, { allowComments: false })).status, 403);

  // 分享頁看得到有沒有開（看不到連結名稱）
  r = await call(null, 'GET', `/api/share/${adminLink}/data`);
  assert.equal(r.data.allowComments, true);
  assert.equal(JSON.stringify(r.data).includes('給客戶 B'), false);
  r = await call(null, 'GET', `/api/share/${dirLink}/data`);
  assert.equal(r.data.allowComments, false);
});

test('訪客留言：沒開的連結不行；名字一定要、HTML 拿掉；團隊看到「訪客：名字（連結名稱）」、每個成員收到通知', async () => {
  const { call, db, r2 } = await setup();
  const off = (await makeLink(call, 'u_admin', {})).data.token;
  let r = await guestCall(call, `/api/share/${off}`, 'GET', '/songs/s1/comments');
  assert.equal(r.status, 403);
  assert.equal(r.data.commentsDisabled, true);
  r = await guestCall(call, `/api/share/${off}`, 'POST', '/songs/s1/comments', { guestName: '小李', comment: { id: cid(), text: 'hi' } });
  assert.equal(r.status, 403);

  const on = (await makeLink(call, 'u_admin', { allowComments: true, label: '給經紀人' })).data.token;
  const base = `/api/share/${on}`;
  r = await guestCall(call, base, 'POST', '/songs/s1/comments', { comment: { id: cid(), text: '沒有名字' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /名字/);
  r = await guestCall(call, base, 'POST', '/songs/s1/comments', { guestName: '小李', comment: { id: cid(), text: '<script>x</script>' } });
  // 「<script>x</script>」拿掉標籤剩 x → 可以送
  assert.equal(r.status, 200);
  const gid = cid();
  r = await guestCall(call, base, 'POST', '/songs/s1/comments', {
    guestName: '<b>小李</b>', comment: {
      id: gid, text: '<i>0:12</i> 這段主牆可以再亮一點', time: 12, timeEnd: 16, view: VIEW, annotation: ANN, thumbnail: JPEG_URL,
      // 冒充團隊的欄位一律不算
      author: '製作', role: 'designer', authorUserId: 'u_admin', mentions: [{ userId: 'u_a1', name: '阿凱' }], status: 'resolved',
    },
  });
  assert.equal(r.status, 200, r.data?.error);
  const mine = r.data.comments.find(x => x.id === gid);
  assert.equal(mine.author, '小李');
  assert.equal(mine.role, 'guest');
  assert.equal(mine.text, '0:12 這段主牆可以再亮一點');
  assert.equal(mine.status, 'open');
  assert.equal(mine.timeEnd, 16);
  assert.deepEqual(mine.view, VIEW);
  assert.ok(mine.thumbUrl);
  assert.equal(mine.videoVersion, 1);   // 綁最新一版
  assert.equal('email' in mine, false);
  assert.ok(r2.keys().some(k => k.startsWith('comment-thumbs/p1/')));

  // 團隊看到
  r = await call('u_dir', 'GET', COMMENTS);
  const team = r.data.comments.find(x => x.id === gid);
  assert.equal(team.author, '訪客：小李（給經紀人）');
  assert.equal(team.role, 'guest');
  assert.deepEqual(team.guest, { name: '小李', linkName: '給經紀人' });
  assert.equal(team.authorUserId, undefined);
  assert.equal(team.mentions, undefined);

  // 小鈴鐺：每個成員都收到（導演、兩個動畫師、製作）
  for (const u of ['u_dir', 'u_a1', 'u_a2', 'u_admin']) {
    const nr = await call(u, 'GET', '/api/notifications');
    const item = nr.data.items.find(x => x.commentId === gid);
    assert.ok(item, u);
    assert.equal(item.kind, 'guest_comment');
    assert.equal(item.actorName, '訪客：小李（給經紀人）');
    assert.equal(item.songId, 's1');
  }
  // 留言數（連結清單上）
  r = await call('u_admin', 'GET', '/api/projects/p1/share-links');
  assert.equal(r.data.links.find(l => l.token === on).guestCommentCount, 2);
  const rows = (await db.prepare(`SELECT author_user_id, author_role, share_token FROM comments WHERE id = ?`).bind(gid).first());
  assert.deepEqual(rows, { author_user_id: null, author_role: 'guest', share_token: on });
});

test('訪客只看得到同一條連結的串 + 團隊在底下的回覆；不能回覆團隊自己的留言；改 / 刪 / 已改好都不行', async () => {
  const { call } = await setup();
  const a = (await makeLink(call, 'u_admin', { allowComments: true, label: 'A' })).data.token;
  const b = (await makeLink(call, 'u_admin', { allowComments: true, label: 'B' })).data.token;
  const teamId = cid();
  await call('u_dir', 'POST', COMMENTS, { comment: { id: teamId, text: '團隊內部：這首要重做' } });
  const ga = cid();
  await guestCall(call, `/api/share/${a}`, 'POST', '/songs/s1/comments', { guestName: '甲', comment: { id: ga, text: 'A 的留言', time: 3 } });
  const gb = cid();
  await guestCall(call, `/api/share/${b}`, 'POST', '/songs/s1/comments', { guestName: '乙', comment: { id: gb, text: 'B 的留言', time: 4 } });
  // 團隊回覆 A 的留言
  const reply = cid();
  let r = await call('u_a1', 'POST', COMMENTS, { comment: { id: reply, text: '收到，V2 會改', parentId: ga } });
  assert.equal(r.status, 200);

  r = await guestCall(call, `/api/share/${a}`, 'GET', '/songs/s1/comments');
  assert.deepEqual(r.data.comments.map(c => c.id), [ga, reply]);
  const rep = r.data.comments.find(c => c.id === reply);
  assert.equal(rep.author, '阿凱');
  assert.equal(rep.role, 'animator');
  assert.equal(rep.parentId, ga);
  r = await guestCall(call, `/api/share/${b}`, 'GET', '/songs/s1/comments');
  assert.deepEqual(r.data.comments.map(c => c.id), [gb]);

  // 訪客回覆自己連結的串 → 可以；回覆團隊的留言 / 別條連結的 → 不行
  const greply = cid();
  r = await guestCall(call, `/api/share/${a}`, 'POST', '/songs/s1/comments', { guestName: '甲', comment: { id: greply, text: '謝謝', parentId: reply } });
  assert.equal(r.status, 200);
  assert.equal(r.data.comments.find(c => c.id === greply).parentId, ga);   // 回覆的回覆掛在最上面那則
  assert.equal((await guestCall(call, `/api/share/${a}`, 'POST', '/songs/s1/comments', { guestName: '甲', comment: { id: cid(), text: 'x', parentId: teamId } })).status, 404);
  assert.equal((await guestCall(call, `/api/share/${a}`, 'POST', '/songs/s1/comments', { guestName: '甲', comment: { id: cid(), text: 'x', parentId: gb } })).status, 404);
  // 分享路由沒有改 / 刪
  assert.equal((await guestCall(call, `/api/share/${a}`, 'PATCH', '/songs/s1/comments', { id: ga, status: 'resolved' })).status, 405);
  assert.equal((await guestCall(call, `/api/share/${a}`, 'DELETE', '/songs/s1/comments')).status, 405);
  // 訪客沒有登入 → /api/comments 不行
  assert.equal((await call(null, 'GET', COMMENTS)).status, 401);
});

test('訪客留言：有密碼的連結要通行證；限定單首歌的連結不能留別首；10 分鐘最多 10 則（換 IP 不受影響）', async () => {
  const { call } = await setup();
  const tk = (await makeLink(call, 'u_admin', { allowComments: true, password: 'pw-123', songId: 's1' })).data.token;
  const base = `/api/share/${tk}`;
  let r = await guestCall(call, base, 'POST', '/songs/s1/comments', { guestName: '丙', comment: { id: cid(), text: '沒密碼' } });
  assert.equal(r.status, 401);
  r = await guestCall(call, base, 'GET', '/data', undefined, '198.51.100.7', { 'x-share-password': 'pw-123' });
  assert.equal(r.status, 200);
  const access = r.data.access.token;
  const H = { 'x-share-access': access };
  r = await guestCall(call, base, 'POST', '/songs/s2/comments', { guestName: '丙', comment: { id: cid(), text: '別首' } }, '198.51.100.7', H);
  assert.equal(r.status, 403);
  for (let i = 0; i < 10; i++) {
    r = await guestCall(call, base, 'POST', '/songs/s1/comments', { guestName: '丙', comment: { id: cid(), text: `第 ${i + 1} 則` } }, '198.51.100.7', H);
    assert.equal(r.status, 200, `${i}: ${r.data?.error}`);
  }
  r = await guestCall(call, base, 'POST', '/songs/s1/comments', { guestName: '丙', comment: { id: cid(), text: '第 11 則' } }, '198.51.100.7', H);
  assert.equal(r.status, 429);
  assert.match(r.data.error, /太快/);
  // 同一則重送（網路重試）不算新的一則，也不被擋
  r = await guestCall(call, base, 'POST', '/songs/s1/comments', { guestName: '丙', comment: { id: 'c_retry', text: '重送' } }, '203.0.113.5', H);
  assert.equal(r.status, 200);
  r = await guestCall(call, base, 'POST', '/songs/s1/comments', { guestName: '丙', comment: { id: 'c_retry', text: '重送' } }, '203.0.113.5', H);
  assert.equal(r.status, 200);
  assert.equal(r.data.duplicate, true);
  assert.equal(r.data.comments.filter(c => c.id === 'c_retry').length, 1);
});
