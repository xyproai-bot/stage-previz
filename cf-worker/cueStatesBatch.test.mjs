// 跑法：cd cf-worker && npm test
// 「所有 cue 的物件回到預設位置」的後台：一首歌所有 cue 的物件覆寫（cue_object_states）一次看 / 一次清 / 一次寫回（復原）。
// 走真的 worker 路由（node:sqlite 假 D1）。重點：只動物件覆寫 —— cue 的名字、時間、轉場、機關位置、別首歌、別的專案都不碰；清掉的內容原樣寫得回來。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './testing/d1-sqlite.mjs';
import worker from './worker.js';

const BASE = 'https://proxy.test';
const P = '/api/projects/p1';
const S1 = `${P}/songs/s1/cue-object-states`;

async function setup() {
  const db = freshDb();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_admin', 'a@x.test', '製作', 'admin', 'ADMIN-1'), ('u_dir', 'd@x.test', '王導', 'director', 'DIR-1'), ('u_ani', 'n@x.test', '小動', 'animator', 'ANI-1')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '巡演'), ('p2', '別的專案')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director'), ('p1', 'u_ani', 'animator')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", code) VALUES ('s1', 'p1', '開場', 0, 'S01'), ('s2', 'p1', '安可', 1, 'S02'), ('sx', 'p2', '別專案的歌', 0, 'S01')`),
    db.prepare(`INSERT INTO cues (id, song_id, name, "order", crossfade_seconds, video_time_sec, status) VALUES
      ('c1', 's1', '開場亮燈', 0, 2.5, 12.5, 'master'), ('c2', 's1', '升降台', 1, 1, 30, 'master'), ('c3', 's1', '提案', 2, 0, NULL, 'proposal'), ('c4', 's1', '沒調整過', 3, 0, NULL, 'master'),
      ('d1', 's2', '安可 1', 0, 0, NULL, 'master'), ('x1', 'sx', '別專案', 0, 0, NULL, 'master')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order") VALUES
      ('oa', 'p1', 'LED_A', '主牆', 'led_panel', 0), ('ob', 'p1', 'MECH_B', '升降台', 'mechanism', 1), ('ox', 'p2', 'LED_X', '別專案', 'led_panel', 0)`),
    // 各種欄位的覆寫：位置 + 角度 + 顯示 + 自訂、只有顯示、只有位置
    db.prepare(`INSERT INTO cue_object_states (id, cue_id, stage_object_id, position, rotation, scale, visible, custom_props, updated_at) VALUES
      ('k1', 'c1', 'oa', '{"x":1,"y":2,"z":3}', '{"pitch":10,"yaw":20,"roll":30}', '{"x":1,"y":1,"z":2}', 0, '{"brightness":0.5}', '2026-10-01 10:00:00'),
      ('k2', 'c1', 'ob', NULL, NULL, NULL, 1, NULL, '2026-10-02 11:00:00'),
      ('k3', 'c2', 'ob', '{"x":0,"y":4,"z":0}', NULL, NULL, NULL, NULL, '2026-10-03 12:00:00'),
      ('k4', 'c3', 'oa', '{"x":9,"y":9,"z":9}', NULL, NULL, NULL, NULL, '2026-10-04 13:00:00'),
      ('k5', 'd1', 'oa', '{"x":5,"y":5,"z":5}', NULL, NULL, NULL, NULL, '2026-10-05 14:00:00'),
      ('k6', 'x1', 'ox', '{"x":7,"y":7,"z":7}', NULL, NULL, NULL, NULL, '2026-10-06 15:00:00')`),
    db.prepare(`INSERT INTO mechanisms (id, project_id, name, kind, travel_min, travel_max) VALUES ('m1', 'p1', '升降', 'linear', 0, 5)`),
    db.prepare(`INSERT INTO cue_mechanism_positions (cue_id, mechanism_id, value) VALUES ('c1', 'm1', 2.5), ('c2', 'm1', 4)`),
  ]);
  const env = { DB: db, AUTH_SECRET: 'test-secret' };
  const tokens = {};
  for (const [id, code] of [['u_admin', 'ADMIN-1'], ['u_dir', 'DIR-1'], ['u_ani', 'ANI-1']]) {
    const r = await worker.fetch(new Request(`${BASE}/api/auth/login`, { method: 'POST', body: JSON.stringify({ accessCode: code }), headers: { 'content-type': 'application/json' } }), env);
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
  const rows = async () => (await db.prepare(`SELECT * FROM cue_object_states ORDER BY cue_id, stage_object_id`).all()).results;
  return { db, call, rows };
}

test('看：這首歌每個 cue 自己設過的物件，欄位原樣；別首歌、別專案的不在裡面', async () => {
  const { call } = await setup();
  const r = await call('u_admin', 'GET', S1);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.cueCount, 4);
  assert.deepEqual(r.data.states.map(s => `${s.cueId}/${s.objectId}`), ['c1/oa', 'c1/ob', 'c2/ob', 'c3/oa']);
  assert.deepEqual(r.data.states[0], {
    cueId: 'c1', objectId: 'oa', position: { x: 1, y: 2, z: 3 }, rotation: { pitch: 10, yaw: 20, roll: 30 }, scale: { x: 1, y: 1, z: 2 },
    visible: false, customProps: { brightness: 0.5 }, updatedAt: '2026-10-01 10:00:00',
  });
  assert.deepEqual(r.data.states[1], { cueId: 'c1', objectId: 'ob', position: null, rotation: null, scale: null, visible: true, customProps: null, updatedAt: '2026-10-02 11:00:00' });
  assert.equal(r.data.states[2].visible, null);
});

test('權限：只有製作；導演、動畫師 403；沒登入 401；歌不在這個專案 404', async () => {
  const { call, rows } = await setup();
  const before = await rows();
  for (const who of ['u_dir', 'u_ani']) {
    assert.equal((await call(who, 'GET', S1)).status, 403);
    assert.equal((await call(who, 'POST', `${S1}/clear`, {})).status, 403);
    assert.equal((await call(who, 'POST', `${S1}/restore`, { states: [] })).status, 403);
  }
  assert.equal((await call(null, 'GET', S1)).status, 401);
  assert.equal((await call(null, 'POST', `${S1}/clear`, {})).status, 401);
  assert.equal((await call('u_admin', 'POST', `${P}/songs/sx/cue-object-states/clear`, {})).status, 404);
  assert.equal((await call('u_admin', 'GET', `${P}/songs/nope/cue-object-states`)).status, 404);
  assert.deepEqual(await rows(), before);
});

test('清掉：這首歌所有 cue 的覆寫全沒了，回傳被清掉的內容；cue 的名字 / 時間 / 轉場 / 機關位置、別首歌、別的專案都不變', async () => {
  const { call, db, rows } = await setup();
  const cuesBefore = (await db.prepare(`SELECT * FROM cues ORDER BY id`).all()).results;
  const mechBefore = (await db.prepare(`SELECT * FROM cue_mechanism_positions ORDER BY cue_id`).all()).results;
  const r = await call('u_admin', 'POST', `${S1}/clear`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.removed, 4);
  assert.deepEqual(r.data.states.map(s => `${s.cueId}/${s.objectId}`), ['c1/oa', 'c1/ob', 'c2/ob', 'c3/oa']);
  // 剩下的只有別首歌、別專案的
  assert.deepEqual((await rows()).map(x => x.id), ['k5', 'k6']);
  assert.deepEqual((await db.prepare(`SELECT * FROM cues ORDER BY id`).all()).results, cuesBefore);
  assert.deepEqual((await db.prepare(`SELECT * FROM cue_mechanism_positions ORDER BY cue_id`).all()).results, mechBefore);
  // 每個物件在每個 cue 都回到預設位置（沒有覆寫、沒有「沿用前面的 cue」）
  for (const cue of ['c1', 'c2', 'c3', 'c4']) {
    const st = (await call('u_admin', 'GET', `${P}/songs/s1/cues/${cue}/states`)).data.states;
    for (const s of st) {
      assert.equal(s.override, null);
      assert.equal(s.tracked, false);
      assert.deepEqual(s.effective.position, s.default.position);
      assert.equal(s.effective.visible, true);
    }
  }
  // 再清一次：沒東西可清，不是錯誤
  const again = await call('u_admin', 'POST', `${S1}/clear`, {});
  assert.equal(again.status, 200);
  assert.equal(again.data.removed, 0);
  assert.deepEqual(again.data.states, []);
  // 活動紀錄只有第一次有
  const logs = (await db.prepare(`SELECT action, target_type, payload FROM activity_log WHERE target_type = 'song_cue_states'`).all()).results;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'reset');
  assert.ok(logs[0].payload.includes('開場'));
});

test('復原：清掉的內容原樣寫回（位置 / 角度 / 縮放 / 顯示 / 自訂 / 沒設的欄位仍是沒設 / 修改時間），再讀出來跟清掉之前一模一樣', async () => {
  const { call, rows } = await setup();
  const before = await rows();
  const listBefore = (await call('u_admin', 'GET', S1)).data;
  const cleared = await call('u_admin', 'POST', `${S1}/clear`, {});
  const back = await call('u_admin', 'POST', `${S1}/restore`, { states: cleared.data.states });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(back.data.restored, 4);
  const listAfter = (await call('u_admin', 'GET', S1)).data;
  assert.deepEqual(listAfter, listBefore);
  // 資料庫裡的欄位（除了新產生的 id）也一樣，包含 NULL 的欄位還是 NULL
  const strip = (r) => ({ ...r, id: undefined });
  assert.deepEqual((await rows()).map(strip), before.map(strip));
  // 「沿用前面的 cue」又恢復了：c2 的升降台有自己的位置，c4 沒設過但沿用前面
  const c4 = (await call('u_admin', 'GET', `${P}/songs/s1/cues/c4/states`)).data.states.find(s => s.objectId === 'oa');
  assert.equal(c4.tracked, true);
});

test('復原：同一個 cue 同一個物件現在又有新設定 → 以寫回的為準（蓋掉）；不會變成兩列', async () => {
  const { call, db, rows } = await setup();
  const cleared = await call('u_admin', 'POST', `${S1}/clear`, {});
  await db.prepare(`INSERT INTO cue_object_states (id, cue_id, stage_object_id, position) VALUES ('new1', 'c1', 'oa', '{"x":100,"y":0,"z":0}')`).run();
  const back = await call('u_admin', 'POST', `${S1}/restore`, { states: cleared.data.states });
  assert.equal(back.status, 200);
  const oa = (await rows()).filter(r => r.cue_id === 'c1' && r.stage_object_id === 'oa');
  assert.equal(oa.length, 1);
  assert.equal(oa[0].position, '{"x":1,"y":2,"z":3}');
});

test('復原：很多列也行（分段寫入，一次幾百列）', async () => {
  const { call, db, rows } = await setup();
  const stmts = [];
  for (let i = 0; i < 200; i++) {
    stmts.push(db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order") VALUES (?, 'p1', ?, ?, 'other', ?)`).bind(`o${i}`, `M${i}`, `物件${i}`, 10 + i));
  }
  await db.batch(stmts);
  const ins = [];
  for (let i = 0; i < 200; i++) ins.push(db.prepare(`INSERT INTO cue_object_states (id, cue_id, stage_object_id, position, visible) VALUES (?, ?, ?, ?, ?)`).bind(`b${i}`, ['c1', 'c2', 'c4'][i % 3], `o${i}`, JSON.stringify({ x: i, y: 0, z: 0 }), i % 2));
  await db.batch(ins);
  const before = (await rows()).filter(r => r.cue_id !== 'x1');
  const cleared = await call('u_admin', 'POST', `${S1}/clear`, {});
  assert.equal(cleared.data.removed, 204);
  assert.equal((await rows()).length, 2);
  const back = await call('u_admin', 'POST', `${S1}/restore`, { states: cleared.data.states });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(back.data.restored, 204);
  const strip = (r) => ({ ...r, id: undefined });
  const key = (r) => `${r.cue_id}/${r.stage_object_id}`;
  const after = (await rows()).filter(r => r.cue_id !== 'x1');
  assert.deepEqual(after.map(strip).sort((a, b) => key(a).localeCompare(key(b))), before.map(strip).sort((a, b) => key(a).localeCompare(key(b))));
});

test('復原：格式不對 / cue 不是這首歌的 / 物件不是這個專案的 → 整批不寫（什麼都沒變）', async () => {
  const { call, rows } = await setup();
  await call('u_admin', 'POST', `${S1}/clear`, {});
  const before = await rows();
  const good = { cueId: 'c1', objectId: 'oa', position: { x: 1, y: 2, z: 3 }, rotation: null, scale: null, visible: true, customProps: null };
  const post = (states) => call('u_admin', 'POST', `${S1}/restore`, { states });
  assert.equal((await call('u_admin', 'POST', `${S1}/restore`, {})).status, 400);
  assert.equal((await call('u_admin', 'POST', `${S1}/restore`, { states: 'x' })).status, 400);
  assert.equal((await post([good, { ...good, cueId: 5 }])).status, 400);
  assert.equal((await post([good, { ...good, cueId: 'c2', position: { x: 'a', y: 0, z: 0 } }])).status, 400);
  assert.equal((await post([good, { ...good, cueId: 'c2', visible: 'yes' }])).status, 400);
  assert.equal((await post([good, { ...good, cueId: 'c2', customProps: [1] }])).status, 400);
  assert.equal((await post([good, good])).status, 400);                                  // 重複
  assert.equal((await post([good, { ...good, cueId: 'd1' }])).status, 404);              // 別首歌的 cue
  assert.equal((await post([good, { ...good, cueId: 'x1' }])).status, 404);              // 別專案的 cue
  assert.equal((await post([good, { ...good, cueId: 'c2', objectId: 'ox' }])).status, 404); // 別專案的物件
  assert.equal((await post(Array.from({ length: 5001 }, (_, i) => ({ ...good, cueId: `c${i}` })))).status, 413);
  assert.deepEqual(await rows(), before);
  // 空的 = 什麼都不做
  const empty = await post([]);
  assert.equal(empty.status, 200);
  assert.equal(empty.data.restored, 0);
});

test('一般編輯照舊：單一物件的 PUT / DELETE 跟新的一次清掉互不影響', async () => {
  const { call, rows } = await setup();
  assert.equal((await call('u_admin', 'DELETE', `${P}/songs/s1/cues/c1/states/oa`)).status, 200);
  assert.deepEqual((await rows()).map(r => r.id), ['k2', 'k3', 'k4', 'k5', 'k6']);
  const cleared = await call('u_admin', 'POST', `${S1}/clear`, {});
  assert.equal(cleared.data.removed, 3);
  assert.equal((await call('u_admin', 'PUT', `${P}/songs/s1/cues/c4/states/oa`, { position: { x: 1, y: 1, z: 1 } })).status, 201);
  assert.equal((await rows()).length, 3);
});
