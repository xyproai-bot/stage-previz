// 跑法：cd cf-worker && npm test
// 前端錯誤回報：網址 / 鑰匙遮掉、大小上限、每個 IP / 每天的上限、同一個訊息算一組、30 天清掉、只有製作看得到
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './testing/d1-sqlite.mjs';
import worker from './worker.js';
import {
  stripUrlPath, scrubText, trimStack, sanitizeClientError, errorFingerprint, rateLimitDecision,
  handleClientErrorPost, listClientErrorGroups, pruneClientErrors, CLIENT_ERROR_LIMITS, ipDayBucket,
} from './clientErrors.mjs';

test('網址只留路徑：? # 後面拿掉，分享連結碼、邀請碼、長的隨機碼遮掉', () => {
  assert.equal(stripUrlPath('https://previz.haimiaan.com/admin/projects/p_abc123?tab=cues#x'), '/admin/projects/p_abc123');
  assert.equal(stripUrlPath('https://previz.haimiaan.com/share/Kq8sTt2kLm9pQr4sZz7x/songs?pw=secret'), '/share/:token/songs');
  assert.equal(stripUrlPath('/s/jinma2026-k7p2'), '/s/:token');
  assert.equal(stripUrlPath('/invite/abcdEFGH1234ijklMNOP5678'), '/invite/:token');
  assert.equal(stripUrlPath('/api/videos/v1/stream?pass=1777.u_1.sig'), '/api/videos/v1/stream');
  assert.equal(stripUrlPath('/studio/p_1/x9F2kQ7mZp3LwR8tY6vB1nC4'), '/studio/p_1/:token');
  assert.equal(stripUrlPath('/help'), '/help');
  assert.equal(stripUrlPath(''), '');
  assert.equal(stripUrlPath(null), '');
  assert.ok(stripUrlPath('/' + 'a'.repeat(1000)).length <= CLIENT_ERROR_LIMITS.pathMax);
});

test('訊息和 stack 裡的網址 / 鑰匙 / email 遮掉', () => {
  const s = scrubText('Failed to fetch https://proxy.haimiaan.com/api/share/Kq8sTt2kLm9pQr4sZz7x/songs?x-share-access=abc token=SECRET123 Bearer abc.def.ghi1234 from phang@example.com');
  assert.doesNotMatch(s, /Kq8sTt2kLm9pQr4sZz7x/);
  assert.doesNotMatch(s, /x-share-access=abc/);
  assert.doesNotMatch(s, /SECRET123/);
  assert.doesNotMatch(s, /abc\.def\.ghi1234/);
  assert.doesNotMatch(s, /phang@example\.com/);
  assert.match(s, /https:\/\/proxy\.haimiaan\.com\/api\/share\/:token\/songs/);
  const stack = trimStack(Array.from({ length: 60 }, (_, i) => `    at f${i} (https://previz.haimiaan.com/assets/index-Bx1.js?v=2:1:${i})`).join('\n'));
  assert.equal(stack.split('\n').length, CLIENT_ERROR_LIMITS.stackLines);
  assert.doesNotMatch(stack, /\?v=2/);
  assert.match(stack, /index-Bx1\.js:1:0/);
});

test('前端送來的內容 → 要存的欄位', () => {
  assert.equal(sanitizeClientError(null).ok, false);
  assert.equal(sanitizeClientError({ message: '   ' }).ok, false);
  const r = sanitizeClientError({
    message: 'TypeError:   x is\nundefined', stack: 'Error\n at a', url: 'https://previz.haimiaan.com/share/Kq8sTt2kLm9pQr4sZz7x?p=1',
    appVersion: '2.0.0<script>', userId: 'u_fake', email: 'x@y.z',
  }, { userAgent: 'Mozilla/5.0 Test' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, {
    message: 'TypeError: x is undefined', stack: 'Error\n at a', path: '/share/:token',
    userAgent: 'Mozilla/5.0 Test', appVersion: '2.0.0script',
  });
  assert.equal(sanitizeClientError({ message: 'x'.repeat(5000) }).value.message.length, CLIENT_ERROR_LIMITS.messageMax);
});

test('同一組：數字不一樣也算同一組', async () => {
  assert.equal(await errorFingerprint('HTTP 502 at song 3'), await errorFingerprint('HTTP 504 at song 12'));
  assert.notEqual(await errorFingerprint('TypeError: a'), await errorFingerprint('TypeError: b'));
});

test('上限判斷', () => {
  assert.equal(rateLimitDecision({ ipCount: 50, dayCount: 10 }).allowed, true);
  assert.deepEqual(rateLimitDecision({ ipCount: 51, dayCount: 10 }), { allowed: false, reason: 'ip' });
  assert.deepEqual(rateLimitDecision({ ipCount: 1, dayCount: 2001 }), { allowed: false, reason: 'day' });
});

test('IP 只存加了鹽的雜湊，每天不一樣', async () => {
  const a = await ipDayBucket('1.2.3.4', '2026-10-14', 's');
  assert.match(a, /^ip:[0-9a-f]{24}$/);
  assert.doesNotMatch(a, /1\.2\.3\.4/);
  assert.notEqual(a, await ipDayBucket('1.2.3.4', '2026-10-15', 's'));
});

const BASE = 'https://proxy.test';
function post(body, { ip = '1.1.1.1', token, raw, headers = {} } = {}) {
  return new Request(BASE + '/api/client-errors', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, 'user-agent': 'UA/1', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw ?? JSON.stringify(body),
  });
}

test('每個 IP 一天的上限、全站一天的上限、太大的不收', async () => {
  const db = freshDb();
  const env = { DB: db, AUTH_SECRET: 's' };
  const limits = { ...CLIENT_ERROR_LIMITS, perIpPerDay: 3, perDay: 5 };
  const now = Date.parse('2026-10-14T10:00:00Z');
  for (let i = 0; i < 3; i++) assert.equal((await handleClientErrorPost(post({ message: `e${i}` }), env, { now, limits })).status, 204);
  const blocked = await handleClientErrorPost(post({ message: 'e3' }), env, { now, limits });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // 同一個 IP 一直送也不會吃掉全站的額度
  for (let i = 0; i < 10; i++) assert.equal((await handleClientErrorPost(post({ message: 'spam' }), env, { now, limits })).status, 429);
  // 別的 IP 還可以，直到全站上限
  assert.equal((await handleClientErrorPost(post({ message: 'x1' }, { ip: '2.2.2.2' }), env, { now, limits })).status, 204);
  assert.equal((await handleClientErrorPost(post({ message: 'x2' }, { ip: '3.3.3.3' }), env, { now, limits })).status, 204);
  const dayFull = await handleClientErrorPost(post({ message: 'x3' }, { ip: '4.4.4.4' }), env, { now, limits });
  assert.equal(dayFull.status, 429);
  assert.equal((await dayFull.json()).reason, 'day');
  // 隔天重新算
  assert.equal((await handleClientErrorPost(post({ message: 'e9' }), env, { now: now + 86400_000, limits })).status, 204);
  const n = await db.prepare(`SELECT COUNT(*) AS n FROM client_errors`).first('n');
  assert.equal(n, 6);
  // 資料庫裡沒有 IP
  const counters = (await db.prepare(`SELECT bucket FROM client_error_counts`).all()).results.map(r => r.bucket).join(' ');
  assert.doesNotMatch(counters, /1\.1\.1\.1/);

  // 太大：Content-Length 說太大、或實際內容太大
  const big = JSON.stringify({ message: 'x', stack: 'y'.repeat(20 * 1024) });
  assert.equal((await handleClientErrorPost(post(null, { raw: big, ip: '9.9.9.9' }), env, { now: now + 86400_000 })).status, 413);
  assert.equal((await handleClientErrorPost(post(null, { raw: '{bad', ip: '9.9.9.9' }), env, { now: now + 86400_000 })).status, 400);
  assert.equal((await handleClientErrorPost(post({ nope: 1 }, { ip: '9.9.9.9' }), env, { now: now + 86400_000 })).status, 400);
});

test('走真的路由：不用登入也能送；有登入記 user id（不信 body 裡的）；製作看得到一組一列；別人看不到', async () => {
  const db = freshDb();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_admin', 'a@x.test', '製作', 'admin', 'ADMIN-1')`),
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_b', 'b@x.test', '阿凱', 'animator', 'ANI-1')`),
  ]);
  const env = { DB: db, AUTH_SECRET: 's' };
  const login = async (code) => (await (await worker.fetch(new Request(BASE + '/api/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: code }) }), env)).json()).token;
  const admin = await login('ADMIN-1');
  const b = await login('ANI-1');

  assert.equal((await worker.fetch(post({ message: 'TypeError: cannot read 1', path: '/studio/p_1?x=1', appVersion: '2.0.0' }), env)).status, 204);
  assert.equal((await worker.fetch(post({ message: 'TypeError: cannot read 2', userId: 'u_admin' }, { token: b }), env)).status, 204);
  assert.equal((await worker.fetch(post({ message: 'ChunkLoadError' }, { ip: '5.5.5.5' }), env)).status, 204);
  assert.equal((await worker.fetch(new Request(BASE + '/api/client-errors'), env)).status, 405);
  // 瀏覽器先問的 OPTIONS
  assert.equal((await worker.fetch(new Request(BASE + '/api/client-errors', { method: 'OPTIONS', headers: { origin: 'https://previz.haimiaan.com' } }), env)).status, 200);

  const rows = (await db.prepare(`SELECT user_id, path FROM client_errors ORDER BY id`).all()).results;
  assert.deepEqual(rows.map(r => r.user_id), [null, 'u_b', null]);
  assert.equal(rows[0].path, '/studio/p_1');

  const get = (token, q = '') => worker.fetch(new Request(BASE + '/api/admin/client-errors' + q, { headers: token ? { authorization: `Bearer ${token}` } : {} }), env);
  assert.equal((await get()).status, 401);
  assert.equal((await get(b)).status, 403);
  const r = await get(admin, '?days=7');
  assert.equal(r.status, 200);
  const { groups } = await r.json();
  assert.equal(groups.length, 2);
  const te = groups.find(g => g.message.startsWith('TypeError'));
  assert.equal(te.count, 2);
  assert.equal(te.users, 1);
  assert.equal(te.message, 'TypeError: cannot read 2');   // 最新的一則
  assert.equal(te.sample.userName, '阿凱');
  assert.equal(te.sample.userAgent, 'UA/1');

  // 系統狀態也有
  const st = await worker.fetch(new Request(BASE + '/api/admin/system-status', { headers: { authorization: `Bearer ${admin}` } }), env);
  assert.equal(st.status, 200);
  const body = await st.json();
  assert.equal(body.clientErrors.groups.length, 2);
  assert.equal(body.backup.last, null);
  assert.equal((await worker.fetch(new Request(BASE + '/api/admin/system-status', { method: 'POST', headers: { authorization: `Bearer ${admin}` } }), env)).status, 405);
});

test('30 天以前的清掉、昨天以前的計數清掉', async () => {
  const db = freshDb();
  const now = Date.parse('2026-10-14T10:00:00Z');
  const ins = (t) => db.prepare(`INSERT INTO client_errors (fingerprint, message, created_at) VALUES ('f', 'm', ?)`).bind(t);
  await db.batch([ins(now - 31 * 86400_000), ins(now - 29 * 86400_000), ins(now)]);
  await db.batch([
    db.prepare(`INSERT INTO client_error_counts (bucket, day, n) VALUES ('day:2026-10-12', '2026-10-12', 3)`),
    db.prepare(`INSERT INTO client_error_counts (bucket, day, n) VALUES ('day:2026-10-13', '2026-10-13', 3)`),
    db.prepare(`INSERT INTO client_error_counts (bucket, day, n) VALUES ('day:2026-10-14', '2026-10-14', 3)`),
  ]);
  const r = await pruneClientErrors(db, now);
  assert.deepEqual(r, { errors: 1, counters: 1 });
  const groups = await listClientErrorGroups(db, { now, days: 30 });
  assert.equal(groups[0].count, 2);
  assert.equal((await listClientErrorGroups(db, { now, days: 7 }))[0].count, 1);
});
