// 跑法：cd cf-worker && npm test
// 省空間（0029，storage.mjs）：刪掉的版本留 30 天再清檔案、救回來、專案結束清影片、搬到長期存放（假 R2）、
// 空間用量、重複的檔案（指紋跟瀏覽器算的一樣：web/src/lib/videoFingerprint.test.ts 用同一組資料、同一個答案）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { D1Sqlite, applyMigrations, freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import * as storage from './storage.mjs';
import { fingerprintBlocks } from '../web/src/lib/videoFingerprint.ts';

const BASE = 'https://proxy.test';
const MiB = 1 << 20;
const DAY = 86400_000;
const iso = (ms) => new Date(ms).toISOString();

// 同一組測試資料（videoFingerprint.test.ts 也是這個產生法）
function testBytes(size) {
  const b = new Uint8Array(size);
  let x = 2463534242;
  for (let i = 0; i < size; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 255; }
  return b;
}
const FP_BIG = 'fp1:0eba3f34c0a696a67eaee57fcc6ec5a9d588d73a1360818b05409f53d0a44278';   // 25 MiB + 12345 bytes
const FP_SMALL = 'fp1:6d520ba3076a376aa9faabe059323656cef34114f735d1972bfe0f0ea2343705'; // 3 MiB + 7 bytes

async function setup({ purge = 'on' } = {}) {
  const db = freshDb();
  const users = [
    ['u_admin', '製作', 'admin', 'ADMIN-1'], ['u_dir', '王導', 'director', 'DIR-1'],
    ['u_a1', '阿凱', 'animator', 'ANI-1'], ['u_a2', '小美', 'animator', 'ANI-2'], ['u_out', '外人', 'animator', 'OUT-1'],
  ];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, `${id}@x.test`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '金馬'), ('p2', '金曲')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director'), ('p1', 'u_a1', 'animator'), ('p1', 'u_a2', 'animator'), ('p2', 'u_a1', 'animator')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, animator_user_id, code) VALUES ('s1', 'p1', '開場', 0, 'approved', 'u_a1', 'S01')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, animator_user_id, code) VALUES ('s2', 'p1', '夜曲', 1, 'todo', 'u_a2', 'S03')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, code) VALUES ('s3', 'p2', '別的專案', 0, 'todo', 'S01')`),
  ]);
  const r2 = memoryR2();
  const env = { DB: db, AUTH_SECRET: 'test-secret', MODELS: r2, VIDEO_PURGE: purge };
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
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data };
  };
  return { db, env, r2, call };
}

let vn = 0;
/** 放一版影片進資料庫和假 R2 */
async function addVideo(t, { project = 'p1', song = 's1', version, by = 'u_a1', bytes = new Uint8Array([1, 2, 3, 4]), deletedAt = null, purgeAfter, fingerprint = null, readyAt = '2026-10-01T00:00:00.000Z', status = 'ready' }) {
  const id = `sv_t${++vn}`;
  const key = `videos/${project}/${song}/${id}.mp4`;
  await t.r2.put(key, bytes, { httpMetadata: { contentType: 'video/mp4' } });
  const pa = purgeAfter !== undefined ? purgeAfter : (deletedAt ? iso(Date.parse(deletedAt) + 30 * DAY) : null);
  await t.db.prepare(`
    INSERT INTO song_videos (id, project_id, song_id, version, title, source, r2_key, mime, size_bytes, status, created_by, ready_at, deleted_at, purge_after, fingerprint)
    VALUES (?, ?, ?, ?, ?, 'upload', ?, 'video/mp4', ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, project, song, version ?? null, `V${version}`, key, bytes.byteLength, status, by, readyAt, deletedAt, pa, fingerprint).run();
  return { id, key };
}

// ─── migration ───

test('migration 0029：舊的刪掉的版本，30 天從刪的時間算；刪的時間讀不懂從現在算；還在的版本不動', async () => {
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0029' });
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p', 'P')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order") VALUES ('s', 'p', 'S', 0)`),
    db.prepare(`INSERT INTO song_videos (id, project_id, song_id, version, source, r2_key, mime, status, deleted_at)
                VALUES ('a', 'p', 's', 1, 'upload', 'k1', 'video/mp4', 'ready', '2026-09-01T10:00:00.000Z'),
                       ('b', 'p', 's', 2, 'upload', 'k2', 'video/mp4', 'ready', 'not-a-date'),
                       ('c', 'p', 's', 3, 'upload', 'k3', 'video/mp4', 'ready', NULL)`),
  ]);
  const before = Date.now();
  applyMigrations(db, { only: '0029' });
  const rows = Object.fromEntries((await db.prepare(`SELECT id, purge_after, purged_at, fingerprint, storage_class FROM song_videos`).all()).results.map(r => [r.id, r]));
  assert.equal(rows.a.purge_after, '2026-10-01T10:00:00.000Z');
  const b = Date.parse(rows.b.purge_after);
  assert.ok(b >= before + 30 * DAY - 5000 && b <= Date.now() + 30 * DAY + 5000, rows.b.purge_after);
  assert.equal(rows.c.purge_after, null);
  assert.equal(rows.a.purged_at, null);
  assert.equal(rows.a.fingerprint, null);
  for (const tbl of ['video_storage_jobs', 'storage_usage']) {
    assert.ok(await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).bind(tbl).first(), tbl);
  }
});

// ─── 清檔案 ───

test('purgeEligible：刪掉剛好超過 30 天才清；還在的、清過的、剛刪的、時間讀不懂的都不清', () => {
  const now = Date.parse('2026-11-01T00:00:00.000Z');
  const del = (msAgo, extra = {}) => ({ deleted_at: iso(now - msAgo), purge_after: iso(now - msAgo + 30 * DAY), purged_at: null, ...extra });
  assert.equal(storage.purgeEligible(del(30 * DAY + 1), now), true);
  assert.equal(storage.purgeEligible(del(30 * DAY), now), true);
  assert.equal(storage.purgeEligible(del(30 * DAY - 1), now), false);
  assert.equal(storage.purgeEligible(del(2 * DAY), now), false);
  assert.equal(storage.purgeEligible({ deleted_at: null, purge_after: iso(now - DAY), purged_at: null }, now), false);
  assert.equal(storage.purgeEligible(del(40 * DAY, { purged_at: iso(now - DAY) }), now), false);
  // purge_after 被改得比較早也不行：刪的時間一定要超過 30 天
  assert.equal(storage.purgeEligible(del(5 * DAY, { purge_after: iso(now - DAY) }), now), false);
  // 刪的時間讀不懂 → 看 purge_after（migration 從當時算 30 天）
  assert.equal(storage.purgeEligible({ deleted_at: 'x', purge_after: iso(now - 1), purged_at: null }, now), true);
  assert.equal(storage.purgeEligible({ deleted_at: 'x', purge_after: 'y', purged_at: null }, now), false);
});

test('清檔案：只清刪掉超過 30 天的那幾版的檔案；還在的、剛刪的、別的專案的檔案都留著；dry-run 什麼都不刪', async () => {
  const t = await setup({ purge: 'dry-run' });
  const now = Date.now();
  const old1 = await addVideo(t, { version: 1, deletedAt: iso(now - 31 * DAY) });
  const recent = await addVideo(t, { version: 2, deletedAt: iso(now - 29 * DAY) });
  const live = await addVideo(t, { version: 3 });
  const otherLive = await addVideo(t, { project: 'p2', song: 's3', version: 1 });
  const otherOld = await addVideo(t, { project: 'p2', song: 's3', version: 2, deletedAt: iso(now - 45 * DAY) });
  const keys = t.r2.keys().length;

  const dry = await storage.runPurgeStep(t.env, { now });
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.candidates, 2);
  assert.deepEqual(dry.items.map(i => i.id).sort(), [old1.id, otherOld.id].sort());
  assert.equal(t.r2.keys().length, keys);
  assert.equal((await t.db.prepare(`SELECT COUNT(*) AS n FROM song_videos WHERE purged_at IS NOT NULL`).first()).n, 0);
  const st = await t.db.prepare(`SELECT value FROM ops_state WHERE key = 'video_purge'`).first();
  assert.equal(JSON.parse(st.value).last.mode, 'dry-run');

  const on = await storage.runPurgeStep(t.env, { now, mode: 'on' });
  assert.equal(on.purged, 2);
  assert.equal(t.r2.bytes(old1.key), null);
  assert.equal(t.r2.bytes(otherOld.key), null);
  for (const k of [recent.key, live.key, otherLive.key]) assert.ok(t.r2.bytes(k), k);
  const rows = Object.fromEntries((await t.db.prepare(`SELECT id, version, purged_at, deleted_at FROM song_videos`).all()).results.map(r => [r.id, r]));
  assert.ok(rows[old1.id].purged_at);
  assert.equal(rows[old1.id].version, 1);  // 號碼還在（不會再給別人用）
  assert.equal(rows[recent.id].purged_at, null);
  assert.equal(rows[live.id].purged_at, null);
  // 再跑一次：沒有東西要清
  assert.equal((await storage.runPurgeStep(t.env, { now, mode: 'on' })).candidates, 0);
});

// ─── 刪除 / 最近刪除 / 救回來 ───

test('刪掉一版 → 最近刪除看得到（還剩 30 天）→ 製作救回來，號碼不變；動畫師、導演不能救；清掉的救不回來', async () => {
  const t = await setup();
  const v1 = await addVideo(t, { version: 1 });
  const v2 = await addVideo(t, { version: 2 });
  await t.db.prepare(`UPDATE songs SET video_version_seq = 2 WHERE id = 's1'`).run();
  const base = '/api/projects/p1/songs/s1/videos';

  assert.equal((await t.call('u_a1', 'DELETE', `${base}/${v2.id}`)).status, 200);
  const row = await t.db.prepare(`SELECT deleted_at, purge_after, deleted_by FROM song_videos WHERE id = ?`).bind(v2.id).first();
  assert.equal(Date.parse(row.purge_after) - Date.parse(row.deleted_at), 30 * DAY);
  assert.equal(row.deleted_by, 'u_a1');
  assert.ok(t.r2.bytes(v2.key), '檔案留著');

  assert.equal((await t.call('u_a1', 'GET', `${base}/deleted`)).status, 403);
  assert.equal((await t.call('u_dir', 'GET', `${base}/deleted`)).status, 403);
  const list = await t.call('u_admin', 'GET', `${base}/deleted`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.videos.map(v => v.label), ['V2']);
  assert.equal(list.data.videos[0].daysLeft, 30);
  assert.equal(list.data.videos[0].deletedBy.name, '阿凱');
  assert.deepEqual((await t.call('u_admin', 'GET', base)).data.videos.map(v => v.label), ['V1']);

  assert.equal((await t.call('u_a1', 'POST', `${base}/${v2.id}/restore`)).status, 403);
  assert.equal((await t.call('u_dir', 'POST', `${base}/${v2.id}/restore`)).status, 403);
  // 別首歌的網址救不到這一版
  assert.equal((await t.call('u_admin', 'POST', `/api/projects/p1/songs/s2/videos/${v2.id}/restore`)).status, 404);
  const r = await t.call('u_admin', 'POST', `${base}/${v2.id}/restore`);
  assert.equal(r.status, 200);
  assert.equal(r.data.label, 'V2');
  const after = await t.call('u_admin', 'GET', base);
  assert.deepEqual(after.data.videos.map(v => v.label), ['V2', 'V1']);
  assert.equal(after.data.latestVideoId, v2.id);
  assert.equal((await t.call('u_admin', 'POST', `${base}/${v2.id}/restore`)).status, 409);  // 沒被刪掉
  // 下一版還是 V3（號碼不重複）
  const seq = await t.db.prepare(`SELECT video_version_seq FROM songs WHERE id = 's1'`).first();
  assert.equal(seq.video_version_seq, 2);

  // 清掉的救不回來
  await t.db.prepare(`UPDATE song_videos SET deleted_at = ?, purge_after = ?, purged_at = ? WHERE id = ?`)
    .bind(iso(Date.now() - 40 * DAY), iso(Date.now() - 10 * DAY), iso(Date.now()), v1.id).run();
  assert.equal((await t.call('u_admin', 'POST', `${base}/${v1.id}/restore`)).status, 410);
  assert.equal((await t.call('u_admin', 'GET', `${base}/deleted`)).data.videos.length, 0);
});

// ─── 專案結束清影片 ───

test('planWrapUp：每首歌留最後通過的那一版；沒通過過、通過的那版不在了 → 最新的', () => {
  const v = (id, song, version) => ({ id, song_id: song, version });
  const videos = [v('a1', 'A', 1), v('a2', 'A', 2), v('a3', 'A', 3), v('b1', 'B', 1), v('b2', 'B', 2), v('c1', 'C', 1), v('c3', 'C', 3), v('d1', 'D', 1)];
  const approvals = [
    { song_id: 'A', video_id: 'a1', created_at: '2026-10-01T00:00:00Z' },
    { song_id: 'A', video_id: 'a2', created_at: '2026-10-05T00:00:00Z' },
    { song_id: 'C', video_id: 'c2-deleted', created_at: '2026-10-09T00:00:00Z' },
    { song_id: 'C', video_id: 'c1', created_at: '2026-10-02T00:00:00Z' },
  ];
  const { keep, remove } = storage.planWrapUp({ videos, approvals });
  assert.deepEqual(Object.fromEntries([...keep].map(([s, k]) => [s, `${k.id}:${k.reason}`])), {
    A: 'a2:approved', B: 'b2:latest', C: 'c1:approved', D: 'd1:latest',
  });
  assert.deepEqual(remove.map(x => x.id).sort(), ['a1', 'a3', 'b1', 'c3']);
  // 只有一筆通過、而且那版刪掉了 → 最新
  const r2 = storage.planWrapUp({ videos: [v('x1', 'X', 1), v('x2', 'X', 2)], approvals: [{ song_id: 'X', video_id: 'gone', created_at: 'z' }] });
  assert.equal(r2.keep.get('X').id, 'x2');
});

test('專案結束清影片：先看會怎樣 → 只留最後通過的那一版（其他照 30 天刪除流程，可以救回來）；只有全站製作能做，封存後也可以', async () => {
  const t = await setup();
  const a1 = await addVideo(t, { version: 1, bytes: new Uint8Array(100) });
  const a2 = await addVideo(t, { version: 2, bytes: new Uint8Array(200) });
  const a3 = await addVideo(t, { version: 3, bytes: new Uint8Array(300) });
  const b1 = await addVideo(t, { song: 's2', version: 1, by: 'u_a2', bytes: new Uint8Array(50) });
  const b2 = await addVideo(t, { song: 's2', version: 2, by: 'u_a2', bytes: new Uint8Array(60) });
  const other = await addVideo(t, { project: 'p2', song: 's3', version: 1 });
  await t.db.prepare(`INSERT INTO song_reviews (id, project_id, song_id, video_id, video_version, status) VALUES ('r1', 'p1', 's1', ?, 2, 'approved')`).bind(a2.id).run();

  assert.equal((await t.call('u_a1', 'GET', '/api/projects/p1/wrap-up')).status, 403);
  const pv = await t.call('u_admin', 'GET', '/api/projects/p1/wrap-up');
  assert.equal(pv.status, 200);
  assert.deepEqual(pv.data.songs.map(s => `${s.code}:${s.keep.label}:${s.keep.reason}:${s.remove.map(r => r.label).join(',')}`), ['S01:V2:approved:V3,V1', 'S03:V2:latest:V1']);
  assert.equal(pv.data.totals.removeBytes, 450);
  assert.equal(pv.data.totals.keepBytes, 260);

  // 先封存再清（封存的專案也可以做）
  assert.equal((await t.call('u_admin', 'DELETE', '/api/projects/p1')).status, 200);
  assert.equal((await t.call('u_admin', 'POST', '/api/projects/p1/wrap-up', { keep: 'nope' })).status, 400);
  const ap = await t.call('u_admin', 'POST', '/api/projects/p1/wrap-up', { keep: 'final', storage: 'standard' });
  assert.equal(ap.status, 200);
  assert.equal(ap.data.removedCount, 3);
  const live = (await t.db.prepare(`SELECT id FROM song_videos WHERE deleted_at IS NULL ORDER BY id`).all()).results.map(r => r.id);
  assert.deepEqual(live.sort(), [a2.id, b2.id, other.id].sort());
  const gone = await t.db.prepare(`SELECT deleted_at, purge_after, deleted_by FROM song_videos WHERE id = ?`).bind(a3.id).first();
  assert.equal(gone.deleted_by, 'u_admin');
  assert.equal(Date.parse(gone.purge_after) - Date.parse(gone.deleted_at), 30 * DAY);
  for (const k of [a1.key, a3.key, b1.key]) assert.ok(t.r2.bytes(k), '檔案留 30 天');
  // 封存的專案也能救回來（30 天內）
  assert.equal((await t.call('u_admin', 'POST', `/api/projects/p1/songs/s1/videos/${a3.id}/restore`)).status, 200);
});

// ─── 搬到長期存放（假 R2） ───

test('搬到長期存放：分段搬到同一個位置，內容不變、存放方式變 InfrequentAccess；搬到一半還是原本那份；刪掉的不搬', async () => {
  const t = await setup();
  const big = testBytes(40 * MiB + 5);  // 32 MiB 一段 → 兩段
  const v = await addVideo(t, { version: 1, bytes: big });
  const small = await addVideo(t, { song: 's2', version: 1, by: 'u_a2', bytes: new Uint8Array([9, 9, 9]) });
  const ap = await t.call('u_admin', 'POST', '/api/projects/p1/wrap-up', { keep: 'all', storage: 'infrequent' });
  assert.equal(ap.data.queuedForInfrequent, 2);
  // 小的那版在排隊時被刪掉 → 不搬
  await t.db.prepare(`UPDATE song_videos SET deleted_at = ? WHERE id = ?`).bind(iso(Date.now()), small.id).run();

  const s1 = await storage.runStorageClassStep(t.env, { maxParts: 1 });
  assert.equal(s1.remaining, 1);
  assert.equal((await t.r2.head(v.key)).storageClass, 'Standard');
  const s2 = await storage.runStorageClassStep(t.env, { maxParts: 1 });
  assert.equal(s2.status, 'done');
  const head = await t.r2.head(v.key);
  assert.equal(head.storageClass, 'InfrequentAccess');
  assert.equal(head.size, big.byteLength);
  assert.equal(createHash('sha256').update(t.r2.bytes(v.key)).digest('hex'), createHash('sha256').update(big).digest('hex'));
  assert.equal((await t.db.prepare(`SELECT storage_class FROM song_videos WHERE id = ?`).bind(v.id).first()).storage_class, 'InfrequentAccess');
  const s3 = await storage.runStorageClassStep(t.env, {});
  assert.equal(s3.status, 'failed');
  assert.equal((await t.r2.head(small.key)).storageClass, 'Standard');
  assert.equal(t.r2.uploads.size, 0, '沒有留下做一半的分段上傳');
  assert.deepEqual(await storage.runStorageClassStep(t.env, {}), { idle: true });
  // 再按一次「改成長期存放」：已經是的不再排
  assert.equal((await t.call('u_admin', 'POST', '/api/projects/p1/wrap-up', { keep: 'all', storage: 'infrequent' })).data.queuedForInfrequent, 0);
});

// ─── 指紋（跟瀏覽器一樣） ───

test('指紋：後台從 R2 一段一段算（每輪最多幾段），結果跟規格（node:crypto 直接算）、瀏覽器的答案一樣', async () => {
  const t = await setup();
  const big = await addVideo(t, { version: 1, bytes: testBytes(25 * MiB + 12345), readyAt: '2026-10-02T00:00:00.000Z' });
  const small = await addVideo(t, { song: 's2', version: 1, by: 'u_a2', bytes: testBytes(3 * MiB + 7), readyAt: '2026-10-01T00:00:00.000Z' });
  assert.equal(fingerprintBlocks(25 * MiB + 12345).length, 24);
  assert.equal(fingerprintBlocks(3 * MiB + 7).length, 4);
  const gets0 = t.r2.calls.get;
  const first = await storage.runFingerprintStep(t.env, { maxBlocks: 5 });
  assert.equal(first.blocks, 5);
  assert.equal(t.r2.calls.get - gets0, 5, '一輪只讀 5 段');
  const prog = await t.db.prepare(`SELECT fp_progress, fingerprint FROM song_videos WHERE id = ?`).bind(big.id).first();
  assert.equal(prog.fingerprint, null);
  assert.equal(JSON.parse(prog.fp_progress).hashes.length, 5);
  let rounds = 1;
  while ((await t.db.prepare(`SELECT COUNT(*) AS n FROM song_videos WHERE fingerprint IS NULL`).first()).n > 0) {
    await storage.runFingerprintStep(t.env, { maxBlocks: 5 });
    if (++rounds > 20) throw new Error('算不完');
  }
  assert.equal(rounds, 6);  // 24 + 4 段，每輪 5 段
  const fps = Object.fromEntries((await t.db.prepare(`SELECT id, fingerprint, fp_progress FROM song_videos`).all()).results.map(r => [r.id, r]));
  assert.equal(fps[big.id].fingerprint, FP_BIG);
  assert.equal(fps[small.id].fingerprint, FP_SMALL);
  assert.equal(fps[big.id].fp_progress, null);
  assert.deepEqual(await storage.runFingerprintStep(t.env, { maxBlocks: 5 }), { blocks: 0, finished: 0 });
});

// ─── 重複的檔案 ───

test('上傳前問有沒有重複：只看這個專案（還在的 + 最近刪除的）；跟上傳一樣的權限；清單標「跟 V2 重複」；系統狀態列出來', async () => {
  const t = await setup();
  const FP = 'fp1:' + 'a'.repeat(64);
  const v2 = await addVideo(t, { version: 2, fingerprint: FP, readyAt: '2026-10-01T00:00:00.000Z' });
  await addVideo(t, { song: 's2', version: 1, by: 'u_a2', fingerprint: FP, deletedAt: iso(Date.now() - DAY), readyAt: '2026-10-02T00:00:00.000Z' });
  await addVideo(t, { project: 'p2', song: 's3', version: 1, fingerprint: FP });
  const url = '/api/projects/p1/songs/s1/videos/duplicates';

  const r = await t.call('u_a1', 'POST', url, { fingerprint: FP.toUpperCase() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.matches.map(m => `${m.songCode}:${m.label}:${m.sameSong}:${m.deleted}`), ['S01:V2:true:false', 'S03:V1:false:true']);
  assert.equal(r.data.matches[0].createdBy.name, '阿凱');
  assert.equal((await t.call('u_a1', 'POST', url, { fingerprint: 'nope' })).status, 400);
  assert.equal((await t.call('u_dir', 'POST', url, { fingerprint: FP })).status, 403);   // 導演不能上傳
  assert.equal((await t.call('u_a2', 'POST', url, { fingerprint: FP })).status, 403);   // 別人的歌
  assert.equal((await t.call('u_out', 'POST', url, { fingerprint: FP })).status, 403);  // 不是成員
  assert.equal((await t.call(null, 'POST', url, { fingerprint: FP })).status, 401);
  // p2 只看得到 p2 自己的
  const p2 = await t.call('u_a1', 'POST', '/api/projects/p2/songs/s3/videos/duplicates', { fingerprint: FP });
  assert.equal(p2.data.matches.length, 1);
  assert.equal(p2.data.matches[0].songName, '別的專案');

  // 上傳帶指紋 → 存起來；清單標「跟 V2 重複」
  const up = await t.call('u_a1', 'POST', '/api/projects/p1/songs/s1/videos/uploads', { filename: 'S01_x.mp4', sizeBytes: 4, mime: 'video/mp4', fingerprint: FP });
  assert.equal(up.status, 201);
  assert.equal((await t.db.prepare(`SELECT fingerprint FROM song_videos WHERE id = ?`).bind(up.data.video.id).first()).fingerprint, FP);
  await t.db.prepare(`UPDATE song_videos SET status = 'ready', version = 3, ready_at = '2026-10-03T00:00:00.000Z' WHERE id = ?`).bind(up.data.video.id).run();
  const list = await t.call('u_a1', 'GET', '/api/projects/p1/songs/s1/videos');
  const byLabel = Object.fromEntries(list.data.videos.map(v => [v.label, v]));
  assert.equal(byLabel.V3.duplicateOf.label, 'V2');
  assert.equal(byLabel.V3.duplicateOf.videoId, v2.id);
  assert.equal(byLabel.V2.duplicateOf, null);

  // 系統狀態：一組重複（p1 的 V2 + V3；刪掉的、別的專案的不算進同一組）
  assert.equal((await t.call('u_a1', 'GET', '/api/admin/storage')).status, 403);
  const sum = await t.call('u_admin', 'GET', '/api/admin/storage');
  assert.equal(sum.status, 200);
  assert.equal(sum.data.duplicates.groupCount, 1);
  assert.deepEqual(sum.data.duplicates.groups[0].versions.map(x => x.label), ['V2', 'V3']);
  assert.equal(sum.data.duplicates.wasteBytes, 4);
});

// ─── 空間用量 ───

test('空間用量：R2 照位置分類（排程列一次存起來），影片 / 已刪除用資料庫的數字；費用要的數字對得上', async () => {
  assert.deepEqual(storage.categorizeKey('models/p1/123-abc.glb'), { projectId: 'p1', category: 'models' });
  assert.deepEqual(storage.categorizeKey('comment-thumbs/p1/c_1-x.jpg'), { projectId: 'p1', category: 'comment-images' });
  assert.deepEqual(storage.categorizeKey('comment-attachments/p1/x.png'), { projectId: 'p1', category: 'comment-images' });
  assert.deepEqual(storage.categorizeKey('videos/p1/s1/sv.mp4'), { projectId: 'p1', category: 'videos' });
  assert.deepEqual(storage.categorizeKey('assets/models/a.glb'), { projectId: '', category: 'assets' });
  assert.deepEqual(storage.categorizeKey('backups/d1/2026-10-14.sql.gz'), { projectId: '', category: 'backups' });
  assert.deepEqual(storage.categorizeKey('thumbnails/p1/x.jpg', new Set(['p1'])), { projectId: 'p1', category: 'other' });
  assert.deepEqual(storage.categorizeKey('weird.bin'), { projectId: '', category: 'other' });

  const t = await setup();
  await addVideo(t, { version: 1, bytes: new Uint8Array(1000) });
  await addVideo(t, { version: 2, bytes: new Uint8Array(500), deletedAt: iso(Date.now() - DAY) });
  await t.r2.put('models/p1/1-a.glb', new Uint8Array(300));
  await t.r2.put('comment-thumbs/p1/c-1.jpg', new Uint8Array(20));
  await t.r2.put('comment-attachments/p1/x.png', new Uint8Array(30));
  await t.r2.put('backups/d1/2026-10-14.sql.gz', new Uint8Array(7));
  const lists0 = t.r2.calls.list;
  const scan = await storage.runStorageScanStep(t.env, {});
  assert.equal(scan.done, true);
  assert.deepEqual(await storage.runStorageScanStep(t.env, {}), { idle: true });  // 6 小時內不再列
  const s1 = await t.call('u_admin', 'GET', '/api/admin/storage');
  const s2 = await t.call('u_admin', 'GET', '/api/admin/storage');
  assert.equal(t.r2.calls.list - lists0, 1, '看頁面不會去列 R2');
  assert.deepEqual(s1.data, { ...s2.data, generatedAt: s1.data.generatedAt });
  const p1 = s1.data.projects.find(p => p.id === 'p1');
  assert.equal(p1.videoBytes, 1000);
  assert.equal(p1.videoCount, 1);
  assert.equal(p1.deletedBytes, 500);
  assert.equal(p1.deletedCount, 1);
  assert.equal(p1.modelBytes, 300);
  assert.equal(p1.commentImageBytes, 50);
  assert.equal(p1.totalBytes, 1850);
  assert.equal(s1.data.account.backups, 7);
  assert.equal(s1.data.account.totalBytes, 1857);
  assert.equal(s1.data.account.r2.bytes, 1857);
  assert.equal(s1.data.purge.mode, 'on');
  // 重新計算 → 下一輪馬上列
  assert.equal((await t.call('u_admin', 'POST', '/api/admin/storage/rescan')).status, 200);
  assert.equal((await storage.runStorageScanStep(t.env, {})).done, true);
});
