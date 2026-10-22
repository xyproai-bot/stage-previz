// 跑法：cd cf-worker && npm test
// 拖拉改 cue 順序：POST songs/:s/cues/rearrange。時間對調 / 跨好幾格重新分配 / 沒時間的 / 復原 / 錯誤。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './testing/d1-sqlite.mjs';
import worker from './worker.js';
import { rearrangeSlots } from './cueLibrary.mjs';

const BASE = 'https://proxy.test';

async function setup(cues) {
  const db = freshDb();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_admin', 'a@x.test', '製作', 'admin', 'ADMIN-1')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '巡演')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order") VALUES ('s1', 'p1', '開場曲', 0)`),
    ...cues.map(([id, order, t, fade]) => db.prepare(`INSERT INTO cues (id, song_id, name, "order", status, video_time_sec, crossfade_seconds) VALUES (?, 's1', ?, ?, 'master', ?, ?)`).bind(id, id, order, t, fade ?? 1)),
  ]);
  const env = { DB: db, AUTH_SECRET: 'test-secret' };
  let token = null;
  const call = async (method, path, body) => {
    if (!token) {
      const login = await worker.fetch(new Request(`${BASE}/api/auth/login`, { method: 'POST', body: JSON.stringify({ accessCode: 'ADMIN-1' }), headers: { 'content-type': 'application/json' } }), env);
      token = (await login.json()).token;
    }
    const r = await worker.fetch(new Request(BASE + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const rows = async () => (await call('GET', '/api/projects/p1/songs/s1/cues')).data.cues.map(c => [c.id, c.videoTimeSec, c.crossfadeSeconds]);
  return { call, rows };
}
const URL_ = '/api/projects/p1/songs/s1/cues/rearrange';

test('有時間的兩個 cue 互拖 = 時間對調，轉場跟著 cue 走', async () => {
  const { call, rows } = await setup([['a', 0, 10, 2], ['b', 1, 30, 5]]);
  const r = await call('POST', URL_, { orderedIds: ['b', 'a'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(await rows(), [['b', 10, 5], ['a', 30, 2]]);
});

test('跨好幾格：時間集合不變，依序重新分配', async () => {
  const { call, rows } = await setup([['a', 0, 5], ['b', 1, 10], ['c', 2, 20], ['d', 3, 30], ['e', 4, 40]]);
  const r = await call('POST', URL_, { orderedIds: ['a', 'e', 'b', 'c', 'd'] });
  assert.equal(r.status, 200);
  assert.deepEqual((await rows()).map(x => [x[0], x[1]]), [['a', 5], ['e', 10], ['b', 20], ['c', 30], ['d', 40]]);
});

test('沒時間的只在沒時間的位置之間換，有時間的位置不動', async () => {
  const { call, rows } = await setup([['a', 0, 10], ['x', 1, null], ['b', 2, 30], ['y', 3, null]]);
  const r = await call('POST', URL_, { orderedIds: ['y', 'b', 'x', 'a'] });
  assert.equal(r.status, 200);
  assert.deepEqual((await rows()).map(x => [x[0], x[1]]), [['b', 10], ['y', null], ['a', 30], ['x', null]]);
});

test('復原：傳舊順序 + 舊時間，一步回到原樣；時間亂塞會被擋', async () => {
  const { call, rows } = await setup([['a', 0, 10], ['b', 1, 30]]);
  await call('POST', URL_, { orderedIds: ['b', 'a'] });
  const bad = await call('POST', URL_, { orderedIds: ['a', 'b'], times: { a: 10, b: 99 } });
  assert.equal(bad.status, 400);
  const r = await call('POST', URL_, { orderedIds: ['a', 'b'], times: { a: 10, b: 30 } });
  assert.equal(r.status, 200);
  assert.deepEqual((await rows()).map(x => [x[0], x[1]]), [['a', 10], ['b', 30]]);
});

test('順序缺 cue / 重複 / 別的歌的 cue → 400', async () => {
  const { call } = await setup([['a', 0, 10], ['b', 1, 30]]);
  assert.equal((await call('POST', URL_, { orderedIds: ['a'] })).status, 400);
  assert.equal((await call('POST', URL_, { orderedIds: ['a', 'a'] })).status, 400);
  assert.equal((await call('POST', URL_, { orderedIds: ['a', 'zzz'] })).status, 400);
  assert.equal((await call('POST', URL_, {})).status, 400);
});

test('rearrangeSlots：結果永遠照時間排', () => {
  const slots = [{ id: 'a', order: 0, videoTimeSec: 1 }, { id: 'n', order: 1, videoTimeSec: null }, { id: 'b', order: 2, videoTimeSec: 2 }, { id: 'c', order: 3, videoTimeSec: 3 }];
  const r = rearrangeSlots(slots, ['c', 'n', 'a', 'b']);
  assert.deepEqual(r.ids, ['c', 'n', 'a', 'b']);
  assert.deepEqual([r.times.c, r.times.a, r.times.b], [1, 2, 3]);
});
