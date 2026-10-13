// 跑法：cd cf-worker && npm test
// 系統狀態 API（只有全站製作）、備份清單 / 下載、排程（worker.scheduled）會做備份和更新下載檔
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import { describeOpsRoute, opsAccessDecision, runOpsCron } from './ops.mjs';
import { backupKey } from './backups.mjs';
import { NDI_RELEASE_API } from './downloads.mjs';

const segs = (p) => p.split('/').filter(Boolean);

test('路由：只有這幾個、只能讀、全部要全站製作', () => {
  assert.deepEqual(describeOpsRoute('GET', segs('/api/admin/system-status')), { kind: 'ops.status', need: 'globalAdmin' });
  assert.deepEqual(describeOpsRoute('GET', segs('/api/admin/backups')), { kind: 'ops.backups', need: 'globalAdmin' });
  assert.deepEqual(describeOpsRoute('GET', segs('/api/admin/backups/2026-10-14.sql.gz')), { kind: 'ops.backupDownload', need: 'globalAdmin', file: '2026-10-14.sql.gz' });
  assert.equal(describeOpsRoute('GET', segs('/api/admin/backups/state.json')), null);
  assert.equal(describeOpsRoute('GET', segs('/api/admin/backups/2026-10-14.sql.gz/x')), null);
  assert.equal(describeOpsRoute('DELETE', segs('/api/admin/backups/2026-10-14.sql.gz')).methodNotAllowed, true);
  assert.equal(describeOpsRoute('GET', segs('/api/admin/other')), null);
  assert.deepEqual(opsAccessDecision(null), { ok: false, status: 401, error: '未登入' });
  assert.equal(opsAccessDecision({ role: 'director' }).status, 403);
  assert.equal(opsAccessDecision({ role: 'admin' }).ok, true);
});

async function setup() {
  const db = freshDb();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_admin', 'a@x.test', '製作', 'admin', 'ADMIN-1')`),
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_dir', 'd@x.test', '導演', 'director', 'DIR-1')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '金馬')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'admin')`),
  ]);
  const env = { DB: db, MODELS: memoryR2(), AUTH_SECRET: 's' };
  const login = async (code) => (await (await worker.fetch(new Request('https://proxy.test/api/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: code }) }), env)).json()).token;
  return { db, env, admin: await login('ADMIN-1'), dir: await login('DIR-1') };
}

/** 假的 GitHub（排程會問 NDI 小程序有沒有新版） */
function withFakeFetch(fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url) === NDI_RELEASE_API) return new Response(JSON.stringify({ tag_name: 'v1', assets: [] }), { status: 200, headers: { etag: '"e"' } });
    return new Response('no', { status: 404 });
  };
  return Promise.resolve(fn(calls)).finally(() => { globalThis.fetch = real; });
}

test('排程（worker.scheduled）：做今天的備份、問一次 GitHub；備份清單和下載只有全站製作可以用', async () => {
  const { env, admin, dir } = await setup();
  await withFakeFetch(async (calls) => {
    const waits = [];
    await worker.scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
    assert.ok(calls.includes(NDI_RELEASE_API));
  });
  const keys = env.MODELS.keys().filter(k => k.startsWith('backups/d1/'));
  assert.equal(keys.length, 1);
  const day = keys[0].slice('backups/d1/'.length, -'.sql.gz'.length);

  const get = (path, token, method = 'GET') => worker.fetch(new Request('https://proxy.test' + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {} }), env);
  assert.equal((await get('/api/admin/backups')).status, 401);
  assert.equal((await get('/api/admin/backups', dir)).status, 403, '專案裡的製作不算，要全站的製作');
  const list = await (await get('/api/admin/backups', admin)).json();
  assert.equal(list.backups.length, 1);
  assert.equal(list.backups[0].day, day);
  assert.equal(list.status.last.day, day);

  const dl = await get(`/api/admin/backups/${day}.sql.gz`, admin);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/gzip');
  assert.equal(dl.headers.get('content-disposition'), `attachment; filename="stage-previz-db-${day}.sql.gz"`);
  const sql = gunzipSync(Buffer.from(await dl.arrayBuffer())).toString('utf8');
  assert.match(sql, /INSERT INTO "projects"/);
  assert.equal((await get(`/api/admin/backups/${day}.sql.gz`, dir)).status, 403);
  assert.equal((await get('/api/admin/backups/1999-01-01.sql.gz', admin)).status, 404);

  const status = await (await get('/api/admin/system-status', admin)).json();
  assert.equal(status.backup.count, 1);
  assert.equal(status.backup.latest.day, day);
  assert.ok(status.backup.last.finishedAt);
});

test('runOpsCron：每件事自己接錯誤（備份壞了不影響其他的）', async () => {
  const { env } = await setup();
  env.MODELS.put = async () => { throw new Error('R2 壞了'); };
  const now = Date.parse('2026-10-14T00:02:00Z');   // 整點後 2 分鐘 → 也會清舊錯誤
  const out = await withFakeFetch(() => runOpsCron(env, { now }));
  assert.equal(out.backup.action, 'error');
  assert.ok(out.downloads);
  assert.deepEqual(out.clientErrorsPrune, { errors: 0, counters: 0 });
  const later = await withFakeFetch(() => runOpsCron(env, { now: now + 10 * 60_000 }));
  assert.equal(later.clientErrorsPrune, undefined, '一小時只清一次');
  assert.ok(!env.MODELS.keys().includes(backupKey('2026-10-14')));
});
