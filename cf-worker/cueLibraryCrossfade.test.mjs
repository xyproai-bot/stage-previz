// 跑法：cd cf-worker && npm test
// Cue 庫的轉場秒數：Cue 庫給預設，每首歌的 cue 可以另外設；沒另外設就用 Cue 庫的，Cue 庫改了它跟著變。
// 現有資料不變（0044 之前就有的 cue = 「這首歌另外設」，值照舊）。cues.crossfade_seconds 永遠是有效值（其他讀轉場的地方不用改）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './testing/d1-sqlite.mjs';
import worker from './worker.js';

const BASE = 'https://proxy.test';
const P = '/api/projects/p1';

async function build() {
  const db = freshDb();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_admin', 'a@x.test', '製作', 'admin', 'ADMIN-1')`),
    db.prepare(`INSERT INTO projects (id, name, cue_library) VALUES ('p1', '巡演', 1), ('p2', '舊模式', 0)`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", code) VALUES ('s1', 'p1', '開場曲', 0, 'S01'), ('s2', 'p1', '安可', 1, 'S02'), ('z1', 'p2', '別的歌', 0, 'Z1')`),
  ]);
  const env = { DB: db, AUTH_SECRET: 'test-secret' };
  const r = await worker.fetch(new Request(`${BASE}/api/auth/login`, { method: 'POST', body: JSON.stringify({ accessCode: 'ADMIN-1' }), headers: { 'content-type': 'application/json' } }), env);
  const token = (await r.json()).token;
  const call = async (method, path, body) => {
    const res = await worker.fetch(new Request(BASE + path, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    let data = null;
    try { data = await res.clone().json(); } catch { /* 不是 JSON */ }
    return { status: res.status, data };
  };
  return { db, call };
}

const row = (db, id) => ({ ...db.raw.prepare(`SELECT crossfade_seconds cf, crossfade_own own FROM cues WHERE id = ?`).get(id) });

test('新的 Cue 庫的 cue 預設 1 秒；加到歌裡沒另外設 = 用 Cue 庫的，Cue 庫改了跟著變；另外設的不受影響', async () => {
  const { db, call } = await build();
  const lc = (await call('POST', `${P}/library-cues`, { name: '副歌' })).data.libraryCue;
  assert.equal(lc.crossfadeSeconds, 1);
  const a = (await call('POST', `${P}/songs/s1/cues`, { libraryCueId: lc.id, videoTimeSec: 10 })).data.slot;
  const b = (await call('POST', `${P}/songs/s2/cues`, { libraryCueId: lc.id, videoTimeSec: 20, crossfadeSeconds: 4 })).data.slot;
  assert.deepEqual([a.crossfadeSeconds, a.crossfadeOwn, a.libraryCrossfadeSeconds], [1, false, 1]);
  assert.deepEqual([b.crossfadeSeconds, b.crossfadeOwn], [4, true]);
  const p = await call('PATCH', `${P}/library-cues/${lc.id}`, { crossfadeSeconds: 2.5 });
  assert.equal(p.status, 200, JSON.stringify(p.data));
  assert.equal(p.data.libraryCue.crossfadeSeconds, 2.5);
  assert.deepEqual(row(db, a.id), { cf: 2.5, own: 0 });      // 跟著變
  assert.deepEqual(row(db, b.id), { cf: 4, own: 1 });        // 另外設的不動
  // cue 清單（導演頁 / 工作站讀的）：有效值 + 來源
  const l = (await call('GET', `${P}/songs/s1/cues`)).data.cues[0];
  assert.deepEqual([l.crossfadeSeconds, l.crossfadeOwn, l.libraryCrossfadeSeconds], [2.5, false, 2.5]);
  // 壞值
  for (const v of [-1, 'x', null, 99999]) assert.equal((await call('PATCH', `${P}/library-cues/${lc.id}`, { crossfadeSeconds: v })).status, 400);
});

test('這首歌另外設、改回 Cue 庫的', async () => {
  const { db, call } = await build();
  const lc = (await call('POST', `${P}/library-cues`, { name: '副歌', crossfadeSeconds: 3 })).data.libraryCue;
  assert.equal(lc.crossfadeSeconds, 3);
  const a = (await call('POST', `${P}/songs/s1/cues`, { libraryCueId: lc.id, videoTimeSec: 10 })).data.slot;
  assert.equal(a.crossfadeSeconds, 3);
  const set = await call('PATCH', `${P}/songs/s1/cues/${a.id}`, { crossfadeSeconds: 0 });   // 0 = 硬切，也是有效的另外設
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.deepEqual(row(db, a.id), { cf: 0, own: 1 });
  await call('PATCH', `${P}/library-cues/${lc.id}`, { crossfadeSeconds: 5 });
  assert.deepEqual(row(db, a.id), { cf: 0, own: 1 });        // Cue 庫改了，另外設的不動
  const back = await call('PATCH', `${P}/songs/s1/cues/${a.id}`, { crossfadeSeconds: null });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.deepEqual(row(db, a.id), { cf: 5, own: 0 });        // 改回用 Cue 庫的
  assert.equal((await call('PATCH', `${P}/songs/s1/cues/${a.id}`, { crossfadeSeconds: -2 })).status, 400);
});

test('換指向：用 Cue 庫轉場的跟著新的 cue 的值；另外設的不變。另存成新的 cue 帶著來源的轉場', async () => {
  const { db, call } = await build();
  const x = (await call('POST', `${P}/library-cues`, { name: 'X', crossfadeSeconds: 2 })).data.libraryCue;
  const y = (await call('POST', `${P}/library-cues`, { name: 'Y', crossfadeSeconds: 6 })).data.libraryCue;
  const a = (await call('POST', `${P}/songs/s1/cues`, { libraryCueId: x.id, videoTimeSec: 1 })).data.slot;
  const b = (await call('POST', `${P}/songs/s1/cues`, { libraryCueId: x.id, videoTimeSec: 2, crossfadeSeconds: 9 })).data.slot;
  await call('PATCH', `${P}/songs/s1/cues/${a.id}`, { libraryCueId: y.id });
  await call('PATCH', `${P}/songs/s1/cues/${b.id}`, { libraryCueId: y.id });
  assert.deepEqual(row(db, a.id), { cf: 6, own: 0 });
  assert.deepEqual(row(db, b.id), { cf: 9, own: 1 });
  const copy = (await call('POST', `${P}/library-cues`, { basedOnId: y.id, label: 'Y2', place: { songId: 's1', replaceCueId: a.id } })).data;
  assert.equal(copy.libraryCue.crossfadeSeconds, 6);
  assert.deepEqual(row(db, a.id), { cf: 6, own: 0 });
});

test('現有資料轉場不變：0044 之前的 cue 是「另外設」，值照舊；Cue 庫改預設也不影響；舊模式專案不受影響', async () => {
  const { db, call } = await build();
  const lc = (await call('POST', `${P}/library-cues`, { name: '舊' })).data.libraryCue;
  // 模擬搬家後就存在的 slot：沒指定 crossfade_own（欄位預設）、值 2.5
  db.raw.prepare(`INSERT INTO cues (id, song_id, name, "order", crossfade_seconds, video_time_sec, status, library_cue_id) VALUES ('c_old', 's1', '舊', 0, 2.5, 5, 'master', ?)`).run(lc.id);
  assert.deepEqual(row(db, 'c_old'), { cf: 2.5, own: 1 });
  await call('PATCH', `${P}/library-cues/${lc.id}`, { crossfadeSeconds: 8 });
  assert.deepEqual(row(db, 'c_old'), { cf: 2.5, own: 1 });
  const l = (await call('GET', `${P}/songs/s1/cues`)).data.cues[0];
  assert.deepEqual([l.crossfadeSeconds, l.crossfadeOwn, l.libraryCrossfadeSeconds], [2.5, true, 8]);
  // 舊模式專案：照舊直接改 crossfadeSeconds，清單沒有新欄位
  const old = (await call('POST', `/api/projects/p2/songs/z1/cues`, { name: '甲' })).data;
  const id = old.id || old.cue?.id;
  const up = await call('PATCH', `/api/projects/p2/songs/z1/cues/${id}`, { crossfadeSeconds: 3 });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const l2 = (await call('GET', `/api/projects/p2/songs/z1/cues`)).data.cues[0];
  assert.equal(l2.crossfadeSeconds, 3);
  assert.equal('crossfadeOwn' in l2, false);
});
