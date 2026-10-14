// 跑法：cd cf-worker && npm test
// 機關 v2 第 1 階段（0027）：每個 cue 每個機關的「延遲 / 走幾秒」。走真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1）：
//   migration 0027 在舊資料上（舊的位置兩欄是空的、亂填的秒數資料庫也擋）；
//   製作可以設、導演 / 動畫師 403；舊版前端只送 { value } 時間不會被清掉；只送時間但這個 cue 沒有自己的位置 → 400；
//   整首歌的位置、分享連結（只看正式 cue）、機關總表都帶時間；沿用新增 cue / 常用擺位跟著複製。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, applyMigrations, freshDb } from './testing/d1-sqlite.mjs';
import worker from './worker.js';
import { loadSongPositions, cloneCuePositions, templateMechanismPositions, applyNamedPositions } from './mechanisms.mjs';

const BASE = 'https://proxy.test';

test('migration 0027：舊的位置還在、兩欄都是空的（= 跟著 cue）；超出 0 ~ 3600 秒資料庫也擋', async () => {
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0027' });
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p', 'P')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order") VALUES ('s', 'p', 'S', 0)`),
    db.prepare(`INSERT INTO cues (id, song_id, name, "order") VALUES ('c', 's', 'C', 0)`),
    db.prepare(`INSERT INTO mechanisms (id, project_id, name, kind) VALUES ('m', 'p', '升降台', 'linear')`),
    db.prepare(`INSERT INTO cue_mechanism_positions (cue_id, mechanism_id, value) VALUES ('c', 'm', 0.5)`),
  ]);
  applyMigrations(db, { only: '0027' });
  const row = await db.prepare(`SELECT * FROM cue_mechanism_positions`).first();
  assert.equal(row.value, 0.5);
  assert.equal(row.delay_sec, null);
  assert.equal(row.duration_sec, null);
  // 舊版 worker 的寫法（只寫 value）照樣能寫
  await db.prepare(`INSERT OR REPLACE INTO cue_mechanism_positions (cue_id, mechanism_id, value) VALUES ('c', 'm', 0.7)`).run();
  await assert.rejects(db.prepare(`UPDATE cue_mechanism_positions SET delay_sec = -1`).run(), /CHECK/);
  await assert.rejects(db.prepare(`UPDATE cue_mechanism_positions SET duration_sec = 4000`).run(), /CHECK/);
  const [pos] = await loadSongPositions({ DB: db }, 's');
  assert.deepEqual({ ...pos, updatedAt: undefined }, { cueId: 'c', mechanismId: 'm', value: 0.7, delaySec: null, durationSec: null, updatedAt: undefined });
});

async function setup() {
  const db = freshDb();
  const users = [['u_admin', '製作', 'admin', 'ADMIN-1'], ['u_dir', '王導', 'director', 'DIR-1'], ['u_ani', '阿凱', 'animator', 'ANI-1']];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, `${id}@x.test`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '巡演')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director'), ('p1', 'u_ani', 'animator')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order") VALUES ('s1', 'p1', '開場', 0)`),
    db.prepare(`INSERT INTO cues (id, song_id, name, "order", status, video_time_sec, crossfade_seconds) VALUES
      ('c1', 's1', '暗場', 0, 'master', 0, 0), ('c2', 's1', '升起', 1, 'master', 30, 5), ('c9', 's1', '提案', 2, 'proposal', NULL, 1)`),
    db.prepare(`INSERT INTO mechanisms (id, project_id, name, kind, travel_min, travel_max, max_speed) VALUES ('mech_lift', 'p1', '中央升降台', 'linear', 0, 3.5, 0.25)`),
  ]);
  const env = { DB: db, AUTH_SECRET: 'test-secret' };
  const tokens = {};
  for (const [id, , , code] of users) {
    const r = await worker.fetch(new Request(`${BASE}/api/auth/login`, {
      method: 'POST', body: JSON.stringify({ accessCode: code }), headers: { 'content-type': 'application/json' },
    }), env);
    tokens[id] = (await r.json()).token;
  }
  const call = async (who, method, path, body) => {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` };
    const r = await worker.fetch(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    let data = null;
    try { data = await r.json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data };
  };
  return { db, env, call };
}

const PUT_C2 = '/api/projects/p1/songs/s1/cues/c2/mechanisms/mech_lift';

test('製作設延遲 / 走幾秒；導演、動畫師 403；舊版只送位置不會清掉時間；只送時間要先有位置', async () => {
  const { db, env, call } = await setup();
  // 還沒有自己的位置、只送時間 → 400（前端會一起送位置）
  const need = await call('u_admin', 'PUT', PUT_C2, { delaySec: 2 });
  assert.equal(need.status, 400);
  assert.equal(need.data.error, '這個 cue 還沒有設定這個機關的位置，要一起送位置');

  const r1 = await call('u_admin', 'PUT', PUT_C2, { value: 3.5, delaySec: 2, durationSec: 8 });
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.data, { ok: true, value: 3.5, clamped: false, delaySec: 2, durationSec: 8 });

  // 舊版前端：只送 value → 時間照舊
  const old = await call('u_admin', 'PUT', PUT_C2, { value: 3 });
  assert.deepEqual(old.data, { ok: true, value: 3, clamped: false, delaySec: 2, durationSec: 8 });
  // 只改走幾秒、清掉延遲（null = 跟著 cue）
  const t = await call('u_admin', 'PUT', PUT_C2, { delaySec: null, durationSec: 12.5 });
  assert.deepEqual(t.data, { ok: true, value: 3, clamped: false, delaySec: null, durationSec: 12.5 });
  // 不合法
  const bad = await call('u_admin', 'PUT', PUT_C2, { durationSec: -1 });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.field, 'durationSec');
  assert.equal(bad.data.error, '走幾秒要是 0 到 3600 秒，或留空跟著轉場');

  for (const who of ['u_dir', 'u_ani']) {
    const r = await call(who, 'PUT', PUT_C2, { value: 1, delaySec: 1 });
    assert.equal(r.status, 403, who);
    assert.equal(r.data.error, '只有製作可以修改專案內容');
  }
  // 成員都看得到時間（播放要用）
  const list = await call('u_dir', 'GET', '/api/projects/p1/songs/s1/mechanism-positions');
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.positions.map(p => [p.cueId, p.value, p.delaySec, p.durationSec]), [['c2', 3, null, 12.5]]);
  // 機關總表（製作）也帶時間
  const sheet = await call('u_admin', 'GET', '/api/projects/p1/mechanism-sheet');
  assert.deepEqual(sheet.data.positions.map(p => [p.cueId, p.durationSec]), [['c2', 12.5]]);

  // 提案的時間：分享連結只看正式 cue
  await call('u_admin', 'PUT', '/api/projects/p1/songs/s1/cues/c9/mechanisms/mech_lift', { value: 1, delaySec: 4 });
  const share = await loadSongPositions(env, 's1', { masterOnly: true });
  assert.deepEqual(share.map(p => [p.cueId, p.delaySec, p.durationSec]), [['c2', null, 12.5]]);

  // 回到沿用（刪掉那一列）→ 時間一起清掉
  const del = await call('u_admin', 'DELETE', PUT_C2);
  assert.equal(del.data.removed, 1);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM cue_mechanism_positions WHERE cue_id = 'c2'`).first()).n, 0);
});

test('沿用新增 cue / 常用擺位：時間跟著複製', async () => {
  const { db, env, call } = await setup();
  await call('u_admin', 'PUT', PUT_C2, { value: 2, delaySec: 1.5, durationSec: 6 });
  await db.prepare(`INSERT INTO cues (id, song_id, name, "order") VALUES ('c3', 's1', 'C3', 3), ('c4', 's1', 'C4', 4)`).run();
  assert.equal(await cloneCuePositions(env, 'c2', 'c3'), 1);
  const c3 = await db.prepare(`SELECT value, delay_sec, duration_sec FROM cue_mechanism_positions WHERE cue_id = 'c3'`).first();
  assert.deepEqual({ ...c3 }, { value: 2, delay_sec: 1.5, duration_sec: 6 });
  const tpl = await templateMechanismPositions(env, 'c2');
  assert.deepEqual(tpl, [{ name: '中央升降台', value: 2, delaySec: 1.5, durationSec: 6 }]);
  assert.equal(await applyNamedPositions(env, 'p1', 'c4', [{ ...tpl[0], durationSec: 'x' }]), 1);
  const c4 = await db.prepare(`SELECT delay_sec, duration_sec FROM cue_mechanism_positions WHERE cue_id = 'c4'`).first();
  assert.deepEqual({ ...c4 }, { delay_sec: 1.5, duration_sec: null });   // 壞掉的秒數 → 跟著 cue
});
