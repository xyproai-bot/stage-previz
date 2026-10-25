// 跑法：cd cf-worker && npm test
// 分享連結建好以後改密碼 / 有效期 / 分享的歌：
//   純判斷（shareLinkEdit.mjs）+ 走一遍真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import { parseShareLinkEdits, hasShareLinkEdits, SHARE_EXPIRES_MAX_DAYS } from './shareLinkEdit.mjs';
import { SHARE_PASSWORD_MAX } from './sharePassword.mjs';
import worker from './worker.js';

const BASE = 'https://proxy.test';
const DAY = 86400_000;

// ─── 純判斷 ───

test('parseShareLinkEdits：什麼都沒給 = 沒有要改的（舊版前端）', () => {
  assert.deepEqual(parseShareLinkEdits({}), { ok: true, edits: {} });
  assert.deepEqual(parseShareLinkEdits({ slug: 'x', watermark: true }), { ok: true, edits: {} });
  assert.deepEqual(parseShareLinkEdits(null), { ok: true, edits: {} });
  assert.equal(hasShareLinkEdits({}), false);
  assert.equal(hasShareLinkEdits({ password: null }), true);
});

test('parseShareLinkEdits：密碼 — 字串 = 設新密碼（最多 60 字）、null = 拿掉、空字串和其他型別不收', () => {
  assert.deepEqual(parseShareLinkEdits({ password: 'sesame' }).edits, { password: 'sesame' });
  assert.deepEqual(parseShareLinkEdits({ password: null }).edits, { password: null });
  assert.equal(parseShareLinkEdits({ password: 'x'.repeat(100) }).edits.password.length, SHARE_PASSWORD_MAX);
  for (const bad of ['', 0, 123, true, false, {}, []]) {
    const r = parseShareLinkEdits({ password: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, /密碼/);
  }
});

test('parseShareLinkEdits：有效期 — 天數從現在算起、null = 不會過期、最多 365 天、亂給的不收', () => {
  const now = Date.parse('2026-10-26T00:00:00.000Z');
  assert.equal(parseShareLinkEdits({ expiresInDays: 7 }, { now }).edits.expiresAt, '2026-11-02T00:00:00.000Z');
  assert.equal(parseShareLinkEdits({ expiresInDays: null }, { now }).edits.expiresAt, null);
  assert.equal(parseShareLinkEdits({ expiresInDays: 1000 }, { now }).edits.expiresAt, new Date(now + SHARE_EXPIRES_MAX_DAYS * DAY).toISOString());
  for (const bad of [0, -3, NaN, Infinity, '7', true, {}]) {
    assert.equal(parseShareLinkEdits({ expiresInDays: bad }, { now }).ok, false, String(bad));
  }
  // 絕對日期：要是未來、最多 365 天
  assert.equal(parseShareLinkEdits({ expiresAt: '2026-12-31T00:00:00Z' }, { now }).edits.expiresAt, '2026-12-31T00:00:00.000Z');
  assert.equal(parseShareLinkEdits({ expiresAt: null }, { now }).edits.expiresAt, null);
  assert.equal(parseShareLinkEdits({ expiresAt: '2026-10-25T00:00:00Z' }, { now }).ok, false, '過去的時間不收');
  assert.equal(parseShareLinkEdits({ expiresAt: 'not a date' }, { now }).ok, false);
  assert.equal(parseShareLinkEdits({ expiresAt: 12345 }, { now }).ok, false);
  assert.equal(parseShareLinkEdits({ expiresAt: '2030-01-01T00:00:00Z' }, { now }).ok, false, '超過 365 天不收');
  assert.equal(parseShareLinkEdits({ expiresInDays: 3, expiresAt: '2026-12-31T00:00:00Z' }, { now }).ok, false, '兩種寫法一起給不收');
});

test('parseShareLinkEdits：分享的歌 — 歌的代碼 = 只分享那一首、null = 整個專案、空字串和亂給的不收', () => {
  assert.deepEqual(parseShareLinkEdits({ songId: 's1' }).edits, { songId: 's1' });
  assert.deepEqual(parseShareLinkEdits({ songId: null }).edits, { songId: null });
  for (const bad of ['', ' ', 'a b', 'x'.repeat(65), 5, [], ['s1'], {}]) {
    const r = parseShareLinkEdits({ songId: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, /歌/);
  }
});

// ─── 走一遍真的路由 ───

async function setup() {
  const db = freshDb();
  const users = [
    ['u_admin', '製作', 'admin', 'ADMIN-1'], ['u_dir', '王導', 'director', 'DIR-1'],
    ['u_dir2', '別案導演', 'director', 'DIR-2'], ['u_a1', '阿凱', 'animator', 'ANI-1'],
  ];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, id === 'u_a1' ? `${id}@auto.local` : `${id}@studio.example.com`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '金馬')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p2', '別的專案')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director'), ('p1', 'u_a1', 'animator'), ('p2', 'u_dir2', 'director')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, code) VALUES ('s1', 'p1', '開場', 0, 'in_review', 'S01')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, code) VALUES ('s2', 'p1', '安可', 1, 'todo', 'S02')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, code) VALUES ('x1', 'p2', '別案的歌', 0, 'todo', 'X01')`),
    db.prepare(`INSERT INTO song_videos (id, project_id, song_id, version, title, source, r2_key, mime, size_bytes, status, created_by, ready_at)
                VALUES ('sv_1', 'p1', 's1', 1, 'V1', 'upload', 'videos/p1/s1/sv_1.mp4', 'video/mp4', 8, 'ready', 'u_a1', '2026-10-14T00:00:00.000Z')`),
    db.prepare(`INSERT INTO song_videos (id, project_id, song_id, version, title, source, r2_key, mime, size_bytes, status, created_by, ready_at)
                VALUES ('sv_2', 'p1', 's2', 1, 'V1', 'upload', 'videos/p1/s2/sv_2.mp4', 'video/mp4', 8, 'ready', 'u_a1', '2026-10-14T00:00:00.000Z')`),
  ]);
  const r2 = memoryR2();
  await r2.put('videos/p1/s1/sv_1.mp4', new Uint8Array(8), { httpMetadata: { contentType: 'video/mp4' } });
  await r2.put('videos/p1/s2/sv_2.mp4', new Uint8Array(8), { httpMetadata: { contentType: 'video/mp4' } });
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
  const mk = async (body = {}, who = 'u_dir') => (await call(who, 'POST', '/api/projects/p1/share-links', body)).data;
  const patch = (token, body, who = 'u_dir', project = 'p1') => call(who, 'PATCH', `/api/projects/${project}/share-links/${token}`, body);
  const row = (token) => db.prepare(`SELECT * FROM share_links WHERE token = ?`).bind(token).first();
  return { db, env, call, mk, patch, row };
}

const openData = (call, token, headers = {}) => call(null, 'GET', `/api/share/${token}/data`, undefined, headers);

test('改密碼：沒有密碼的連結設上密碼 → 之後要輸入密碼才能開；存法跟建立時一樣（加鹽雜湊、不存明文）', async () => {
  const { call, mk, patch, row } = await setup();
  const link = await mk({});
  assert.equal((await openData(call, link.token)).status, 200);
  const r = await patch(link.token, { password: 'sesame' });
  assert.equal(r.status, 200, r.data?.error);
  assert.equal(r.data.hasPassword, true);
  assert.ok(!JSON.stringify(r.data).includes('pbkdf2'), '回應裡不給雜湊');
  const saved = await row(link.token);
  assert.match(saved.password_hash, /^pbkdf2-sha256\$\d+\$/);
  assert.ok(saved.password_salt);
  assert.equal(saved.password, null, '不存明文');
  assert.equal((await openData(call, link.token)).status, 401);
  assert.equal((await openData(call, link.token, { 'x-share-password': 'wrong' })).status, 401);
  assert.equal((await openData(call, link.token, { 'x-share-password': 'sesame' })).status, 200);
  // 清單看得到「有密碼」
  const list = (await call('u_dir', 'GET', '/api/projects/p1/share-links')).data.links;
  assert.equal(list.find(l => l.token === link.token).hasPassword, true);
});

test('換密碼：舊密碼馬上不能用，用舊密碼拿到的通行證也一起失效；新密碼可以', async () => {
  const { call, mk, patch, row } = await setup();
  const link = await mk({ password: 'old-pass' });
  const before = await row(link.token);
  // 客戶用舊密碼進來，拿到通行證
  const first = await openData(call, link.token, { 'x-share-password': 'old-pass' });
  assert.equal(first.status, 200);
  const pass = first.data.access.token;
  assert.equal((await openData(call, link.token, { 'x-share-access': pass })).status, 200, '通行證本來可以用');

  const r = await patch(link.token, { password: 'new-pass' });
  assert.equal(r.status, 200, r.data?.error);
  const after = await row(link.token);
  assert.notEqual(after.password_hash, before.password_hash);
  assert.notEqual(after.password_salt, before.password_salt, '每次換密碼都用新的鹽');

  assert.equal((await openData(call, link.token, { 'x-share-password': 'old-pass' })).status, 401, '舊密碼不能用');
  const oldPass = await openData(call, link.token, { 'x-share-access': pass });
  assert.equal(oldPass.status, 401, '舊通行證失效');
  assert.equal(oldPass.data.requiresPassword, true);
  assert.equal((await openData(call, link.token, { 'x-share-password': 'new-pass' })).status, 200, '新密碼可以');
  // 影片串流也一樣：舊通行證放在網址上也不行
  const streamOld = await call(null, 'GET', `/api/share/${link.token}/song-videos/sv_1/stream?access=${encodeURIComponent(pass)}&play=x`);
  assert.equal(streamOld.status, 401);
});

test('拿掉密碼：不用密碼就能開；再設回「同一個」密碼，之前的通行證也不能用', async () => {
  const { call, mk, patch, row } = await setup();
  const link = await mk({ password: 'sesame' });
  const pass = (await openData(call, link.token, { 'x-share-password': 'sesame' })).data.access.token;
  const r = await patch(link.token, { password: null });
  assert.equal(r.status, 200, r.data?.error);
  assert.equal(r.data.hasPassword, false);
  const saved = await row(link.token);
  assert.equal(saved.password_hash, null);
  assert.equal(saved.password_salt, null);
  assert.equal(saved.password, null);
  assert.equal((await openData(call, link.token)).status, 200);
  // 再設回同一個密碼 → 新的鹽 → 舊通行證不算
  assert.equal((await patch(link.token, { password: 'sesame' })).status, 200);
  assert.equal((await openData(call, link.token, { 'x-share-access': pass })).status, 401);
  assert.equal((await openData(call, link.token, { 'x-share-password': 'sesame' })).status, 200);
});

test('舊的明文密碼連結：換密碼 / 拿掉密碼都會把明文清掉', async () => {
  const { db, call, patch, row } = await setup();
  await db.prepare(`INSERT INTO share_links (token, project_id, password) VALUES ('tk_plain', 'p1', 'plain-old')`).run();
  assert.equal((await openData(call, 'tk_plain', { 'x-share-password': 'plain-old' })).status, 200);
  // 上面那一下已經把明文換成雜湊了；再造一條還沒被打開過的
  await db.prepare(`INSERT INTO share_links (token, project_id, password) VALUES ('tk_plain2', 'p1', 'plain-two')`).run();
  assert.equal((await patch('tk_plain2', { password: 'fresh-one' })).status, 200);
  let saved = await row('tk_plain2');
  assert.equal(saved.password, null);
  assert.ok(saved.password_hash);
  assert.equal((await openData(call, 'tk_plain2', { 'x-share-password': 'plain-two' })).status, 401);
  assert.equal((await openData(call, 'tk_plain2', { 'x-share-password': 'fresh-one' })).status, 200);
  await db.prepare(`INSERT INTO share_links (token, project_id, password) VALUES ('tk_plain3', 'p1', 'plain-three')`).run();
  assert.equal((await patch('tk_plain3', { password: null })).status, 200);
  saved = await row('tk_plain3');
  assert.equal(saved.password, null);
  assert.equal((await openData(call, 'tk_plain3')).status, 200);
});

test('改密碼：空字串、非字串不收（不會手滑把密碼清掉）；密碼太長會切到 60 字', async () => {
  const { call, mk, patch, row } = await setup();
  const link = await mk({ password: 'keep-me' });
  const before = await row(link.token);
  for (const bad of ['', 123, true, {}]) {
    const r = await patch(link.token, { password: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await row(link.token)).password_hash, before.password_hash, '沒被動到');
  assert.equal((await patch(link.token, { password: 'x'.repeat(90) })).status, 200);
  assert.equal((await openData(call, link.token, { 'x-share-password': 'x'.repeat(60) })).status, 200);
});

test('改有效期：改日期、改成不會過期；過期的連結改日期之後又能開', async () => {
  const { db, call, mk, patch, row } = await setup();
  const link = await mk({ expiresInDays: 1 });
  let r = await patch(link.token, { expiresInDays: 30 });
  assert.equal(r.status, 200, r.data?.error);
  const ms = Date.parse(r.data.expiresAt) - Date.now();
  assert.ok(Math.abs(ms - 30 * DAY) < 60_000, '從現在起算 30 天');
  assert.equal((await row(link.token)).expires_at, r.data.expiresAt);

  // 已經過期的連結
  await db.prepare(`UPDATE share_links SET expires_at = ? WHERE token = ?`).bind(new Date(Date.now() - DAY).toISOString(), link.token).run();
  assert.equal((await openData(call, link.token)).status, 410);
  assert.equal((await patch(link.token, { expiresInDays: 7 })).status, 200);
  assert.equal((await openData(call, link.token)).status, 200, '改了日期又能開');

  r = await patch(link.token, { expiresInDays: null });
  assert.equal(r.status, 200);
  assert.equal(r.data.expiresAt, null);
  assert.equal((await row(link.token)).expires_at, null);
  assert.equal((await openData(call, link.token)).status, 200);

  // 指定日期
  const target = new Date(Date.now() + 10 * DAY).toISOString();
  r = await patch(link.token, { expiresAt: target });
  assert.equal(r.status, 200, r.data?.error);
  assert.equal(r.data.expiresAt, target);
  r = await patch(link.token, { expiresAt: null });
  assert.equal(r.data.expiresAt, null);
});

test('改有效期：0、負數、亂給、過去的日期、兩種寫法一起給 → 擋掉，原本的不動', async () => {
  const { mk, patch, row } = await setup();
  const link = await mk({ expiresInDays: 7 });
  const original = (await row(link.token)).expires_at;
  const bads = [
    { expiresInDays: 0 }, { expiresInDays: -1 }, { expiresInDays: '7' }, { expiresInDays: 'abc' },
    { expiresAt: new Date(Date.now() - DAY).toISOString() }, { expiresAt: 'tomorrow' },
    { expiresInDays: 3, expiresAt: new Date(Date.now() + DAY).toISOString() },
  ];
  for (const b of bads) assert.equal((await patch(link.token, b)).status, 400, JSON.stringify(b));
  assert.equal((await row(link.token)).expires_at, original);
  const huge = await patch(link.token, { expiresInDays: 9999 });
  assert.equal(huge.status, 200);
  assert.ok(Math.abs(Date.parse(huge.data.expiresAt) - Date.now() - 365 * DAY) < 60_000, '最多 365 天');
});

test('換分享的歌：單首 ↔ 整個專案；換了之後訪客只看得到那一首、別首的影片擋掉', async () => {
  const { call, mk, patch, row } = await setup();
  const link = await mk({ noDownload: false });   // 整個專案（沒開禁止下載：影片網址不用播放通行證）
  let data = (await openData(call, link.token)).data;
  assert.equal(data.songs.length, 2);
  assert.equal(data.restrictedToSongId, null);

  let r = await patch(link.token, { songId: 's2' });
  assert.equal(r.status, 200, r.data?.error);
  assert.equal(r.data.songId, 's2');
  assert.equal((await row(link.token)).song_id, 's2');
  data = (await openData(call, link.token)).data;
  assert.deepEqual(data.songs.map(s => s.id), ['s2']);
  assert.equal(data.restrictedToSongId, 's2');
  assert.equal((await call(null, 'GET', `/api/share/${link.token}/song-videos/sv_1/stream`)).status, 403, '別首的影片不給看');
  assert.equal((await call(null, 'GET', `/api/share/${link.token}/song-videos/sv_2/stream`)).status, 200);

  r = await patch(link.token, { songId: 's1' });
  assert.equal(r.status, 200);
  assert.deepEqual((await openData(call, link.token)).data.songs.map(s => s.id), ['s1']);

  r = await patch(link.token, { songId: null });
  assert.equal(r.status, 200);
  assert.equal(r.data.songId, null);
  assert.equal((await row(link.token)).song_id, null);
  assert.equal((await openData(call, link.token)).data.songs.length, 2);
});

test('換分享的歌：別的專案的歌、不存在的歌擋掉（404）；一首都沒選（空字串）、亂給的擋掉（400）；原本的不動', async () => {
  const { mk, patch, row } = await setup();
  const link = await mk({ songId: 's1' });
  let r = await patch(link.token, { songId: 'x1' });
  assert.equal(r.status, 404, '別的專案的歌');
  assert.match(r.data.error, /找不到這首歌/);
  assert.equal((await patch(link.token, { songId: 'nope' })).status, 404);
  for (const bad of ['', 'a b', 5, [], ['s2'], {}]) {
    assert.equal((await patch(link.token, { songId: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await row(link.token)).song_id, 's1');
});

test('一次改好幾樣：其中一樣不合格就整包不動（網址名稱、密碼、有效期都不會只改一半）', async () => {
  const { mk, patch, row } = await setup();
  const link = await mk({ slug: 'jinma-old' });
  const before = await row(link.token);
  let r = await patch(link.token, { slug: 'jinma-new', password: 'pw-1', expiresInDays: 5, songId: 'x1' });
  assert.equal(r.status, 404);
  let after = await row(link.token);
  assert.equal(after.slug, 'jinma-old');
  assert.equal(after.password_hash, before.password_hash);
  assert.equal(after.expires_at, before.expires_at);
  assert.equal(after.song_id, before.song_id);
  r = await patch(link.token, { slug: 'jinma-new', password: 'pw-1', expiresInDays: 5, songId: 's2', label: '給經紀人' });
  assert.equal(r.status, 200, r.data?.error);
  after = await row(link.token);
  assert.equal(after.slug, 'jinma-new');
  assert.ok(after.password_hash);
  assert.ok(after.expires_at);
  assert.equal(after.song_id, 's2');
  assert.equal(after.label, '給經紀人');
});

test('權限跟原本的 PATCH 一樣：製作、這個專案的導演可以；動畫師、別的專案的人、沒登入不行；用別的專案的網址也改不到', async () => {
  const { call, mk, patch, row } = await setup();
  const link = await mk({ password: 'keep', songId: 's1', expiresInDays: 7 });
  const before = await row(link.token);
  const attempt = { password: 'hacked', expiresInDays: null, songId: null };
  assert.equal((await patch(link.token, attempt, 'u_a1')).status, 403, '動畫師');
  assert.equal((await patch(link.token, attempt, 'u_dir2')).status, 403, '別的專案的導演（用這個專案的網址）');
  assert.equal((await patch(link.token, attempt, null)).status, 401, '沒登入');
  // 別的專案的導演用「自己專案」的網址去改這個專案的連結碼
  const cross = await patch(link.token, attempt, 'u_dir2', 'p2');
  assert.equal(cross.status, 404);
  // 製作用別的專案的網址也一樣改不到
  assert.equal((await patch(link.token, attempt, 'u_admin', 'p2')).status, 404);
  const after = await row(link.token);
  assert.equal(after.password_hash, before.password_hash);
  assert.equal(after.expires_at, before.expires_at);
  assert.equal(after.song_id, 's1');
  // 該能改的人
  assert.equal((await patch(link.token, { expiresInDays: 3 }, 'u_dir')).status, 200);
  assert.equal((await patch(link.token, { expiresInDays: 4 }, 'u_admin')).status, 200);
  assert.equal((await call(null, 'GET', `/api/share/${link.token}/data`)).status, 401, '還是有密碼');
});

test('舊版前端：只送網址名稱 / 浮水印照樣能用，不會動到密碼、有效期、分享的歌；什麼都沒送 = 400', async () => {
  const { mk, patch, row } = await setup();
  const link = await mk({ password: 'keep', songId: 's1', expiresInDays: 7 });
  const before = await row(link.token);
  assert.equal((await patch(link.token, { slug: 'old-front' })).status, 200);
  assert.equal((await patch(link.token, { watermark: false })).status, 200);
  assert.equal((await patch(link.token, { label: '給主辦' })).status, 200);
  const after = await row(link.token);
  assert.equal(after.password_hash, before.password_hash);
  assert.equal(after.password_salt, before.password_salt);
  assert.equal(after.expires_at, before.expires_at);
  assert.equal(after.song_id, 's1');
  assert.equal((await patch(link.token, {})).status, 400);
  assert.equal((await patch(link.token, { unknown: 1 })).status, 400);
});

test('找不到的連結 → 404', async () => {
  const { patch } = await setup();
  assert.equal((await patch('nope', { password: 'x' })).status, 404);
  assert.equal((await patch('nope', { songId: 's1' })).status, 404);
});
