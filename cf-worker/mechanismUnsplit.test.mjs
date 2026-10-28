// 跑法：cd cf-worker && npm test
// 「對開」機關拆成兩個各自動的機關：POST /api/projects/:id/mechanisms/:mechId/unsplit（docs/superpowers/specs/2026-10-29-director-stage-control-design.md 3.4）。
// 走真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1）：
//   A 邊留在原機關（id 不變、變成一般機關、名字「原名 A」）、B 邊變新機關（方向 / 轉軸中心用原本 mirror 的、名字「原名 B」、行程等照抄）；
//   原本在 B 邊的物件改掛到 B 機關；每個 cue（舊路徑的每首歌 / 提案、Cue 庫）存的位置和時間都抄一份給 B（畫面一模一樣）；
//   一次做完（要嘛全好，要嘛都沒動）；只有製作能做；不是對開 → 400；別的專案的機關 → 404。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import { loadMechanisms } from './mechanisms.mjs';

const BASE = 'https://proxy.test';
const P = '/api/projects/p1';

async function setup() {
  const db = freshDb();
  const users = [['u_admin', '製作', 'admin', 'ADMIN-1'], ['u_dir', '王導', 'director', 'DIR-1'], ['u_anim', '小動', 'animator', 'ANIM-1']];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, `${id}@x.test`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '巡演'), ('p2', '別的專案')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director'), ('p1', 'u_anim', 'animator')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order") VALUES ('s1', 'p1', '開場', 0), ('s2', 'p1', '安可', 1)`),
    db.prepare(`INSERT INTO cues (id, song_id, name, "order", status, video_time_sec, crossfade_seconds, base_cue_id) VALUES
      ('c1', 's1', '關', 0, 'master', 0, 0, NULL), ('c2', 's1', '開', 1, 'master', 30, 5, NULL),
      ('c3', 's1', '開（提案）', 2, 'proposal', 31, 5, 'c2'), ('c4', 's2', '安可開', 0, 'master', 0, 2, NULL)`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order") VALUES
      ('ol1', 'p1', 'L1', '左 1', 'led_panel', 0), ('ol2', 'p1', 'L2', '左 2', 'led_panel', 1),
      ('or1', 'p1', 'R1', '右 1', 'led_panel', 2), ('or2', 'p1', 'R2', '右 2', 'led_panel', 3),
      ('ox', 'p1', 'X', '轉台', 'mechanism', 4), ('oplain', 'p1', 'P', '一般板', 'led_panel', 5), ('orig', 'p1', 'G', '吊的板', 'led_panel', 6),
      ('op2', 'p2', 'Q1', '別的專案的板', 'led_panel', 0), ('op3', 'p2', 'Q2', '別的專案的板 2', 'led_panel', 1)`),
  ]);
  const env = { DB: db, AUTH_SECRET: 'test-secret', MODELS: memoryR2() };
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
  return { db, env, call };
}

/** 直線對開：A 邊往 -X、B 邊往 +X；裝在「轉台」上；控台編號兩邊各自的 */
const LINEAR_SPLIT = {
  name: '側面 LED', kind: 'linear', variant: 'split', axis: { x: -1, y: 0, z: 0 }, travelMin: 0, travelMax: 4, defaultValue: 1, maxSpeed: 0.5,
  presets: [{ name: '全開', value: 4 }, { name: '半開', value: 2 }],
  consoleLabel: 'Axis 7', mirror: { axis: { x: 1, y: 0, z: 0 }, pivot: null, consoleLabel: 'Axis 8' },
  objectIds: ['ol1', 'ol2', 'or1', 'or2'], objectSides: { ol1: 'a', ol2: 'a', or1: 'b', or2: 'b' },
};
/** 旋轉對開（兩片門繞各自的門軸）：B 邊的轉軸中心在另一邊 */
const ROTARY_SPLIT = {
  name: '對開門', kind: 'rotary', variant: 'split', axis: { x: 0, y: 1, z: 0 }, pivot: { x: -4, y: 0, z: 2 }, travelMin: -90, travelMax: 90, defaultValue: 0,
  presets: [{ name: '全開', value: 90 }],
  mirror: { axis: { x: 0, y: -1, z: 0 }, pivot: { x: 4, y: 0, z: 2 }, consoleLabel: null },
  objectIds: ['ol1', 'or1'], objectSides: { ol1: 'a', or1: 'b' },
};
const TURNTABLE = { name: '轉台', kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: 0, y: 0, z: 0 }, travelMin: -180, travelMax: 180, objectIds: ['ox'] };

const create = async (call, body) => {
  const r = await call('u_admin', 'POST', `${P}/mechanisms`, body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.mechanism;
};
const row = (db, id) => db.prepare(`SELECT * FROM mechanisms WHERE id = ?`).bind(id).first();
const objectsOf = async (db, id) => Object.fromEntries((await db.prepare(
  `SELECT stage_object_id AS o, side FROM mechanism_objects WHERE mechanism_id = ? ORDER BY o`).bind(id).all()).results.map(x => [x.o, x.side]));
const cuePositions = async (db, id) => (await db.prepare(
  `SELECT cue_id, value, delay_sec, duration_sec, updated_at FROM cue_mechanism_positions WHERE mechanism_id = ? ORDER BY cue_id`).bind(id).all()).results;
const libPositions = async (db, id) => (await db.prepare(
  `SELECT library_cue_id, value, delay_sec, duration_sec, carried, updated_at FROM library_cue_mechanism_positions WHERE mechanism_id = ? ORDER BY library_cue_id`).bind(id).all()).results;

/** 一個對開機關 + 它在各個地方存的位置（舊路徑的 4 個 cue 含提案 + Cue 庫的 3 個 cue） */
async function splitWithPositions(ctx, input = LINEAR_SPLIT) {
  const { db, call } = ctx;
  const parent = await create(call, TURNTABLE);
  const a = await create(call, { ...input, parentId: parent.id });
  await db.batch([
    db.prepare(`INSERT INTO cue_mechanism_positions (cue_id, mechanism_id, value, delay_sec, duration_sec) VALUES
      ('c1', ?1, 0, NULL, NULL), ('c2', ?1, 3.5, 1.5, 4), ('c3', ?1, 2, 0, NULL), ('c4', ?1, 4, NULL, 0)`).bind(a.id),
    db.prepare(`INSERT INTO cue_mechanism_positions (cue_id, mechanism_id, value) VALUES ('c2', ?, 45)`).bind(parent.id),
    db.prepare(`INSERT INTO library_cues (id, project_id, label, name, rev) VALUES
      ('lc1', 'p1', '1', '關', 3), ('lc2', 'p1', '2', '開', 5), ('lc3', 'p1', '3', '沿用', 7), ('lc4', 'p1', '4', '沒設側面', 9)`),
    db.prepare(`INSERT INTO library_cue_mechanism_positions (library_cue_id, mechanism_id, value, delay_sec, duration_sec, carried) VALUES
      ('lc1', ?1, 0, NULL, NULL, 0), ('lc2', ?1, 3.5, 2, 6, 0), ('lc3', ?1, 3.5, NULL, NULL, 1)`).bind(a.id),
    db.prepare(`INSERT INTO library_cue_mechanism_positions (library_cue_id, mechanism_id, value) VALUES ('lc4', ?, 90)`).bind(parent.id),
  ]);
  return { parent, a };
}

test('拆開：A 邊留在原機關（id 不變、變一般機關、名字「原名 A」）、B 邊是新機關（方向用 mirror 的、行程 / 預設 / 常用位置 / 上層照抄），回傳 { a, b }', async () => {
  const ctx = await setup();
  const { db, call } = ctx;
  const { parent, a } = await splitWithPositions(ctx);
  const before = await row(db, a.id);

  const r = await call('u_admin', 'POST', `${P}/mechanisms/${a.id}/unsplit`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { a: ra, b: rb } = r.data;

  // A：id 不變，不再是對開
  assert.equal(ra.id, a.id);
  assert.equal(ra.name, '側面 LED A');
  assert.equal(ra.variant, null);
  assert.equal(ra.mirror, null);
  assert.deepEqual(ra.objectSides, {});
  assert.deepEqual(ra.objectIds.sort(), ['ol1', 'ol2']);
  assert.deepEqual(ra.axis, { x: -1, y: 0, z: 0 });
  assert.equal(ra.consoleLabel, 'Axis 7');
  assert.equal(ra.parentId, parent.id);
  const rowA = await row(db, a.id);
  assert.equal(rowA.variant, null);
  assert.equal(rowA.mirror, null);
  assert.equal(rowA.axis, before.axis);
  assert.equal(rowA.travel_max, before.travel_max);
  assert.equal(rowA.presets, before.presets);

  // B：新機關，axis = 原本 mirror 的、其他照抄
  assert.ok(rb.id && rb.id !== a.id);
  assert.equal(rb.name, '側面 LED B');
  assert.equal(rb.kind, 'linear');
  assert.equal(rb.variant, null);
  assert.equal(rb.mirror, null);
  assert.deepEqual(rb.axis, { x: 1, y: 0, z: 0 });
  assert.equal(rb.pivot, null);
  assert.equal(rb.travelMin, 0);
  assert.equal(rb.travelMax, 4);
  assert.equal(rb.defaultValue, 1);
  assert.equal(rb.maxSpeed, 0.5);
  assert.deepEqual(rb.presets, [{ name: '半開', value: 2 }, { name: '全開', value: 4 }]);
  assert.equal(rb.parentId, parent.id);
  assert.equal(rb.consoleLabel, 'Axis 8', 'B 邊的控台編號用原本 mirror 的');
  assert.deepEqual(rb.objectIds.sort(), ['or1', 'or2']);
  const rowB = await row(db, rb.id);
  assert.equal(rowB.project_id, 'p1');
  assert.equal(rowB.variant, null);
  assert.equal(rowB.mirror, null);
  assert.equal(rowB.presets, rowA.presets);
  assert.equal(rowB.legacy_object_id, null);
  assert.equal(rowB.rig_id, null);
  assert.ok(rowB.edited_at, '算在新介面改過的');

  // 重新讀：兩個都是一般機關，舊版前端（網址沒帶 ?mech）也看得到
  const old = await call('u_dir', 'GET', `${P}/mechanisms`);
  const ids = old.data.mechanisms.map(m => m.id);
  assert.ok(ids.includes(a.id) && ids.includes(rb.id));
});

test('拆開：原本在 B 邊的物件改掛到 B 機關，A 邊和沒標邊的留在 A；mechanism_objects 的 side 都清掉', async () => {
  const ctx = await setup();
  const { db, call } = ctx;
  const { a } = await splitWithPositions(ctx);
  // 沒標邊的物件（舊資料 side = NULL）算 A 邊
  await db.prepare(`UPDATE mechanism_objects SET side = NULL WHERE mechanism_id = ? AND stage_object_id = 'ol2'`).bind(a.id).run();

  const r = await call('u_admin', 'POST', `${P}/mechanisms/${a.id}/unsplit`, {});
  assert.equal(r.status, 200);
  assert.deepEqual(await objectsOf(db, a.id), { ol1: null, ol2: null });
  assert.deepEqual(await objectsOf(db, r.data.b.id), { or1: null, or2: null });
  // 每個物件還是只在一個機關（資料庫的唯一索引）
  const n = await db.prepare(`SELECT COUNT(*) AS n FROM mechanism_objects WHERE stage_object_id IN ('ol1','ol2','or1','or2')`).first();
  assert.equal(n.n, 4);
});

test('拆開：每個地方存的位置都抄一份給 B（舊路徑每首歌的 cue 含提案、Cue 庫的 cue），value / 延遲 / 走幾秒 / carried 一樣，A 的不動', async () => {
  const ctx = await setup();
  const { db, call } = ctx;
  const { a } = await splitWithPositions(ctx);
  const beforeCue = await cuePositions(db, a.id);
  const beforeLib = await libPositions(db, a.id);
  assert.equal(beforeCue.length, 4);
  assert.equal(beforeLib.length, 3);

  const r = await call('u_admin', 'POST', `${P}/mechanisms/${a.id}/unsplit`, {});
  assert.equal(r.status, 200);
  const bId = r.data.b.id;

  assert.deepEqual(await cuePositions(db, a.id), beforeCue, 'A 的不動');
  assert.deepEqual(await libPositions(db, a.id), beforeLib);
  assert.deepEqual(await cuePositions(db, bId), beforeCue, 'B 一筆對一筆（含 c3 提案、第二首歌的 c4）');
  assert.deepEqual(await libPositions(db, bId), beforeLib, 'Cue 庫 B 一筆對一筆（含 carried = 1 的沿用）');
  // 時間也抄了
  const c2 = (await cuePositions(db, bId)).find(x => x.cue_id === 'c2');
  assert.deepEqual([c2.value, c2.delay_sec, c2.duration_sec], [3.5, 1.5, 4]);
  const lc2 = (await libPositions(db, bId)).find(x => x.library_cue_id === 'lc2');
  assert.deepEqual([lc2.value, lc2.delay_sec, lc2.duration_sec, lc2.carried], [3.5, 2, 6, 0]);
  const lc3 = (await libPositions(db, bId)).find(x => x.library_cue_id === 'lc3');
  assert.deepEqual([lc3.value, lc3.delay_sec, lc3.duration_sec, lc3.carried], [3.5, null, null, 1]);
  // 別的機關（轉台）的位置沒被誤抄
  const all = await db.prepare(`SELECT COUNT(*) AS n FROM cue_mechanism_positions`).first();
  assert.equal(all.n, 4 + 4 + 1);
  const allLib = await db.prepare(`SELECT COUNT(*) AS n FROM library_cue_mechanism_positions`).first();
  assert.equal(allLib.n, 3 + 3 + 1);
});

test('拆開：有 A 邊位置的 Cue 庫 cue 版本號 +1（還開著舊畫面的人存檔會被擋下，不會把 B 的位置蓋掉）；沒用到的不動', async () => {
  const ctx = await setup();
  const { db, call } = ctx;
  const { a } = await splitWithPositions(ctx);
  const rev = async () => Object.fromEntries((await db.prepare(`SELECT id, rev FROM library_cues ORDER BY id`).all()).results.map(x => [x.id, Number(x.rev)]));
  assert.deepEqual(await rev(), { lc1: 3, lc2: 5, lc3: 7, lc4: 9 });
  const r = await call('u_admin', 'POST', `${P}/mechanisms/${a.id}/unsplit`, {});
  assert.equal(r.status, 200);
  assert.deepEqual(await rev(), { lc1: 4, lc2: 6, lc3: 8, lc4: 9 });
});

test('拆開：旋轉對開 → B 的轉軸和轉軸中心用 mirror 的，A 的不動；Cue 庫模式的專案兩個機關各算 cue 數', async () => {
  const ctx = await setup();
  const { db, call } = ctx;
  const { a } = await splitWithPositions(ctx, ROTARY_SPLIT);
  await db.prepare(`UPDATE projects SET cue_library = 1 WHERE id = 'p1'`).run();

  const r = await call('u_admin', 'POST', `${P}/mechanisms/${a.id}/unsplit`, { nameA: '左門', nameB: '右門' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { a: ra, b: rb } = r.data;
  assert.equal(ra.name, '左門');
  assert.equal(rb.name, '右門');
  assert.equal(ra.kind, 'rotary');
  assert.deepEqual(ra.axis, { x: 0, y: 1, z: 0 });
  assert.deepEqual(ra.pivot, { x: -4, y: 0, z: 2 });
  assert.equal(rb.kind, 'rotary');
  assert.deepEqual(rb.axis, { x: 0, y: -1, z: 0 });
  assert.deepEqual(rb.pivot, { x: 4, y: 0, z: 2 });
  assert.equal(rb.travelMin, -90);
  assert.equal(rb.travelMax, 90);
  assert.equal(rb.cueCount, 3, 'Cue 庫模式：B 有 3 個 Cue 庫的 cue 設了位置');
  assert.equal(ra.cueCount, 3);
  assert.deepEqual(ra.objectIds, ['ol1']);
  assert.deepEqual(rb.objectIds, ['or1']);
});

test('拆開：B 排在 A 後面（後面的機關往後挪一格）；A 在某一排裡 B 也放同一排、排在最後', async () => {
  const ctx = await setup();
  const { db, call } = ctx;
  const { parent, a } = await splitWithPositions(ctx);
  const after = await create(call, { name: '另一個', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, travelMin: 0, travelMax: 1, objectIds: ['oplain'] });
  await db.batch([
    db.prepare(`INSERT INTO mechanism_groups (id, project_id, name, "order") VALUES ('g1', 'p1', '側面', 0)`),
    db.prepare(`UPDATE mechanisms SET group_id = 'g1', group_index = 0 WHERE id = ?`).bind(a.id),
    // 同一排裡已經有別的機關（B 要排在它後面）
    db.prepare(`INSERT INTO mechanisms (id, project_id, name, kind, "order", group_id, group_index) VALUES ('mg2', 'p1', '同排的', 'linear', 50, 'g1', 1)`),
  ]);
  const orderOf = async (id) => Number((await row(db, id)).order);
  const [oParent, oA, oAfter] = [await orderOf(parent.id), await orderOf(a.id), await orderOf(after.id)];
  assert.ok(oParent < oA && oA < oAfter);

  const r = await call('u_admin', 'POST', `${P}/mechanisms/${a.id}/unsplit`, {});
  assert.equal(r.status, 200);
  const bRow = await row(db, r.data.b.id);
  assert.equal(Number(bRow.order), oA + 1);
  assert.equal(await orderOf(a.id), oA, 'A 的順序不動');
  assert.equal(await orderOf(after.id), oAfter + 1, 'A 後面的往後挪一格');
  assert.equal(await orderOf('mg2'), 51);
  assert.equal(bRow.group_id, 'g1');
  assert.equal(bRow.group_index, 2, '同一排的最後');
  assert.equal(r.data.b.groupId, 'g1');
  // 順序沒有重複
  const orders = (await db.prepare(`SELECT "order" AS o FROM mechanisms WHERE project_id = 'p1'`).all()).results.map(x => x.o);
  assert.equal(new Set(orders).size, orders.length);

  // A 不在任何一排 → B 也不在
  const ctx2 = await setup();
  const w = await splitWithPositions(ctx2);
  const r2 = await ctx2.call('u_admin', 'POST', `${P}/mechanisms/${w.a.id}/unsplit`, {});
  assert.equal(r2.data.b.groupId, null);
  assert.equal((await row(ctx2.db, r2.data.b.id)).group_index, null);
});

test('拆開：metadata 照抄但翻轉的設定（setup）不抄給 B（B 的轉軸是 mirror 的，不能被重新算）', async () => {
  const ctx = await setup();
  const { db, call } = ctx;
  const { a } = await splitWithPositions(ctx, ROTARY_SPLIT);
  await db.prepare(`UPDATE mechanisms SET metadata = ? WHERE id = ?`).bind(JSON.stringify({ setup: { hinge: 'left', positive: 'first' }, note: 'x' }), a.id).run();
  const r = await call('u_admin', 'POST', `${P}/mechanisms/${a.id}/unsplit`, {});
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse((await row(db, a.id)).metadata), { setup: { hinge: 'left', positive: 'first' }, note: 'x' });
  assert.deepEqual(JSON.parse((await row(db, r.data.b.id)).metadata), { note: 'x' });
});

test('名字：預設「原名 A」「原名 B」、body 帶 { nameA, nameB } 蓋過去；空白 / 兩個一樣 / 跟別的機關重複 → 400，什麼都沒動', async () => {
  const ctx = await setup();
  const { db, call } = ctx;
  const { a } = await splitWithPositions(ctx);
  await create(call, { name: '被佔走了', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, travelMin: 0, travelMax: 1, objectIds: ['oplain'] });
  const snapshot = async () => JSON.stringify([
    (await db.prepare(`SELECT id, name, variant, mirror, "order" FROM mechanisms ORDER BY id`).all()).results,
    (await db.prepare(`SELECT * FROM mechanism_objects ORDER BY mechanism_id, stage_object_id`).all()).results,
    (await db.prepare(`SELECT * FROM cue_mechanism_positions ORDER BY cue_id, mechanism_id`).all()).results,
    (await db.prepare(`SELECT * FROM library_cue_mechanism_positions ORDER BY library_cue_id, mechanism_id`).all()).results,
    (await db.prepare(`SELECT id, rev FROM library_cues ORDER BY id`).all()).results,
  ]);
  const before = await snapshot();
  const url = `${P}/mechanisms/${a.id}/unsplit`;

  const empty = await call('u_admin', 'POST', url, { nameA: '   ' });
  assert.equal(empty.status, 400);
  assert.equal(empty.data.field, 'nameA');
  assert.equal(empty.data.error, '機關名稱不能空白');
  const emptyB = await call('u_admin', 'POST', url, { nameB: '' });
  assert.equal(emptyB.status, 400);
  assert.equal(emptyB.data.field, 'nameB');
  const same = await call('u_admin', 'POST', url, { nameA: '門', nameB: ' 門 ' });
  assert.equal(same.status, 400);
  assert.equal(same.data.field, 'nameB');
  assert.equal(same.data.error, '這個專案已經有叫「門」的機關');
  const takenA = await call('u_admin', 'POST', url, { nameA: '被佔走了' });
  assert.equal(takenA.status, 400);
  assert.equal(takenA.data.field, 'nameA');
  assert.equal(takenA.data.error, '這個專案已經有叫「被佔走了」的機關');
  const takenB = await call('u_admin', 'POST', url, { nameB: '被佔走了' });
  assert.equal(takenB.status, 400);
  assert.equal(takenB.data.field, 'nameB');
  const notText = await call('u_admin', 'POST', url, { nameA: 5 });
  assert.equal(notText.status, 400);
  assert.equal(notText.data.field, 'nameA');
  assert.equal(await snapshot(), before, '400 的時候什麼都沒動');

  // 名字可以用原本自己的名字當 A（不算跟自己重複）
  const keep = await call('u_admin', 'POST', url, { nameA: '側面 LED', nameB: '側面 LED（右）' });
  assert.equal(keep.status, 200, JSON.stringify(keep.data));
  assert.equal(keep.data.a.name, '側面 LED');
  assert.equal(keep.data.b.name, '側面 LED（右）');
});

test('名字：原名太長，預設名字也會縮短到 40 字以內（留給「 A」「 B」）', async () => {
  const ctx = await setup();
  const { call } = ctx;
  const long = '很長的機關名稱'.repeat(6).slice(0, 40);
  const a = await create(call, { ...LINEAR_SPLIT, name: long });
  const r = await call('u_admin', 'POST', `${P}/mechanisms/${a.id}/unsplit`, {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(long.length, 40);
  assert.equal(r.data.a.name.length, 40);
  assert.ok(r.data.a.name.endsWith(' A'));
  assert.ok(r.data.b.name.endsWith(' B'));
});

test('不是對開 → 400「這個機關不是對開」（一般 / 弧形 / 吊掛），什麼都沒動', async () => {
  const ctx = await setup();
  const { db, call } = ctx;
  const plain = await create(call, { name: '升降台', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, travelMin: 0, travelMax: 3, objectIds: ['oplain'] });
  const arc = await create(call, { name: '橫移', kind: 'linear', variant: 'arc', axis: { x: 0, y: 1, z: 0 }, pivot: { x: 0, y: 0, z: 10 }, arcRadius: 5, travelMin: -3, travelMax: 3, objectIds: ['ox'] });
  const rig = await create(call, {
    name: '吊掛', variant: 'hoist_rig', objectIds: ['orig'],
    hoists: [{ attach: { x: 0, y: 0, z: 0 } }, { attach: { x: 2, y: 0, z: 0 } }],
  });
  const count = async () => Number((await db.prepare(`SELECT COUNT(*) AS n FROM mechanisms`).first()).n);
  const n = await count();
  for (const m of [plain, arc, rig]) {
    const r = await call('u_admin', 'POST', `${P}/mechanisms/${m.id}/unsplit`, {});
    assert.equal(r.status, 400, m.name);
    assert.equal(r.data.error, '這個機關不是對開');
  }
  assert.equal(await count(), n);
  // 已經拆過的（A 不再是對開）再拆一次 → 400
  const a = await create(call, LINEAR_SPLIT);
  assert.equal((await call('u_admin', 'POST', `${P}/mechanisms/${a.id}/unsplit`, {})).status, 200);
  const again = await call('u_admin', 'POST', `${P}/mechanisms/${a.id}/unsplit`, {});
  assert.equal(again.status, 400);
  assert.equal(again.data.error, '這個機關不是對開');
});

test('權限：導演 / 動畫師 403（什麼都沒動）；別的專案的機關 404；不存在的機關 404；沒登入 401', async () => {
  const ctx = await setup();
  const { db, call } = ctx;
  const { a } = await splitWithPositions(ctx);
  const url = `${P}/mechanisms/${a.id}/unsplit`;

  for (const who of ['u_dir', 'u_anim']) {
    const r = await call(who, 'POST', url, {});
    assert.equal(r.status, 403, who);
    assert.equal(r.data.error, '只有製作可以修改專案內容');
  }
  assert.equal(await call(null, 'POST', url, {}).then(r => r.status), 401);
  assert.equal((await row(db, a.id)).variant, 'split');
  assert.equal(Number((await db.prepare(`SELECT COUNT(*) AS n FROM mechanisms WHERE name LIKE '%B'`).first()).n), 0);

  // 別的專案（p2）的對開機關，從 p1 的網址拆 → 404，p2 的沒被動
  const other = (await call('u_admin', 'POST', `/api/projects/p2/mechanisms`, {
    ...LINEAR_SPLIT, name: '別的專案的對開', objectIds: ['op2', 'op3'], objectSides: { op2: 'a', op3: 'b' },
  })).data.mechanism;
  assert.ok(other?.id);
  const r404 = await call('u_admin', 'POST', `${P}/mechanisms/${other.id}/unsplit`, {});
  assert.equal(r404.status, 404);
  assert.equal(r404.data.error, '這個專案裡找不到這個機關');
  assert.equal((await row(db, other.id)).variant, 'split');
  assert.equal(await call('u_admin', 'POST', `${P}/mechanisms/nope_nope/unsplit`, {}).then(r => r.status), 404);

  // 方法不對 → 405
  assert.equal((await call('u_admin', 'GET', url)).status, 405);
  assert.equal((await call('u_admin', 'PATCH', url, {})).status, 405);
});

test('一次做完：中間任何一步失敗 → 500，全部都沒動（沒有 B、A 還是對開、物件和位置和順序都原樣）', async () => {
  const ctx = await setup();
  const { db, call } = ctx;
  const { a } = await splitWithPositions(ctx);
  await create(call, { name: '另一個', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, travelMin: 0, travelMax: 1, objectIds: ['oplain'] });
  const snap = async () => JSON.stringify([
    (await db.prepare(`SELECT id, name, variant, mirror, "order", group_id, edited_at, updated_at FROM mechanisms ORDER BY id`).all()).results,
    (await db.prepare(`SELECT * FROM mechanism_objects ORDER BY mechanism_id, stage_object_id`).all()).results,
    (await db.prepare(`SELECT * FROM cue_mechanism_positions ORDER BY cue_id, mechanism_id`).all()).results,
    (await db.prepare(`SELECT * FROM library_cue_mechanism_positions ORDER BY library_cue_id, mechanism_id`).all()).results,
    (await db.prepare(`SELECT id, rev FROM library_cues ORDER BY id`).all()).results,
    (await db.prepare(`SELECT * FROM activity_log ORDER BY id`).all()).results.filter(x => x.action === 'update' || x.action === 'unsplit'),
  ]);
  const before = await snap();
  // 最後一步（Cue 庫的位置）被資料庫拒絕
  db.raw.exec(`CREATE TRIGGER boom BEFORE INSERT ON library_cue_mechanism_positions BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
  const r = await call('u_admin', 'POST', `${P}/mechanisms/${a.id}/unsplit`, {});
  assert.equal(r.status, 500);
  assert.match(r.data.error, /什麼都沒有改/);
  assert.equal(await snap(), before);
  // 修好之後同一個機關可以正常拆
  db.raw.exec(`DROP TRIGGER boom;`);
  assert.equal((await call('u_admin', 'POST', `${P}/mechanisms/${a.id}/unsplit`, {})).status, 200);
});

test('常用擺位（cue_templates，用機關名稱存）：這個專案的常用擺位裡原機關那一列換成 A、B 兩列（數字一樣）；全站的、別的專案的不動', async () => {
  const ctx = await setup();
  const { db, call } = ctx;
  const { a } = await splitWithPositions(ctx);
  const payload = (name) => JSON.stringify({
    position: { x: 0, y: 0, z: 0 }, snapshotStates: [],
    mechanismPositions: [{ name: '轉台', value: 45 }, { name, value: 3.5, delaySec: 1.5, durationSec: 4 }, { name: '別的', value: 1 }],
  });
  await db.batch([
    db.prepare(`INSERT INTO cue_templates (id, project_id, name, payload) VALUES ('t_mine', 'p1', '我的', ?)`).bind(payload('側面 LED')),
    db.prepare(`INSERT INTO cue_templates (id, project_id, name, payload) VALUES ('t_none', 'p1', '沒用到', ?)`).bind(JSON.stringify({ position: { x: 0, y: 0, z: 0 }, snapshotStates: [] })),
    db.prepare(`INSERT INTO cue_templates (id, project_id, name, payload) VALUES ('t_global', NULL, '全站', ?)`).bind(payload('側面 LED')),
    db.prepare(`INSERT INTO cue_templates (id, project_id, name, payload) VALUES ('t_other', 'p2', '別的專案', ?)`).bind(payload('側面 LED')),
  ]);
  const get = async (id) => JSON.parse((await db.prepare(`SELECT payload FROM cue_templates WHERE id = ?`).bind(id).first()).payload);
  const untouched = { t_none: await get('t_none'), t_global: await get('t_global'), t_other: await get('t_other') };

  const r = await call('u_admin', 'POST', `${P}/mechanisms/${a.id}/unsplit`, { nameA: '側 A', nameB: '側 B' });
  assert.equal(r.status, 200);
  const mine = await get('t_mine');
  assert.deepEqual(mine.mechanismPositions, [
    { name: '轉台', value: 45 },
    { name: '側 A', value: 3.5, delaySec: 1.5, durationSec: 4 },
    { name: '側 B', value: 3.5, delaySec: 1.5, durationSec: 4 },
    { name: '別的', value: 1 },
  ]);
  assert.deepEqual(mine.position, { x: 0, y: 0, z: 0 });
  assert.deepEqual(await get('t_none'), untouched.t_none);
  assert.deepEqual(await get('t_global'), untouched.t_global);
  assert.deepEqual(await get('t_other'), untouched.t_other);
});

test('活動紀錄記一筆（誰、原名、拆成哪兩個、抄了幾筆位置）', async () => {
  const ctx = await setup();
  const { db, call } = ctx;
  const { a } = await splitWithPositions(ctx);
  const r = await call('u_admin', 'POST', `${P}/mechanisms/${a.id}/unsplit`, {});
  assert.equal(r.status, 200);
  const logs = (await db.prepare(`SELECT * FROM activity_log WHERE project_id = 'p1' AND target_id = ? AND action = 'update'`).bind(a.id).all()).results
    .map(x => ({ ...x, payload: JSON.parse(x.payload) })).filter(x => x.payload.unsplit === true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].target_type, 'mechanism');
  assert.equal(logs[0].user_id, 'u_admin');
  assert.deepEqual(logs[0].payload, {
    unsplit: true, name: '側面 LED', nameA: '側面 LED A', nameB: '側面 LED B', bId: r.data.b.id, positions: 4, libraryPositions: 3,
  });
});

test('拆完：loadMechanisms 讀出來兩個都是一般機關，物件各自一邊；再編輯 A 或 B 都是普通機關的規則', async () => {
  const ctx = await setup();
  const { db, call } = ctx;
  const { a } = await splitWithPositions(ctx);
  const r = await call('u_admin', 'POST', `${P}/mechanisms/${a.id}/unsplit`, {});
  const all = await loadMechanisms({ DB: db }, 'p1');
  const ra = all.find(m => m.id === a.id), rb = all.find(m => m.id === r.data.b.id);
  assert.equal(ra.variant, null);
  assert.equal(rb.variant, null);
  // B 可以單獨改行程（普通 PATCH）
  const patch = await call('u_admin', 'PATCH', `${P}/mechanisms/${rb.id}`, { travelMax: 5 });
  assert.equal(patch.status, 200);
  assert.equal(patch.data.mechanism.travelMax, 5);
  assert.equal((await row(db, a.id)).travel_max, 4, 'A 不受影響');
  // 單獨設 B 在某個 cue 的位置，A 不動
  const put = await call('u_admin', 'PUT', `${P}/songs/s1/cues/c1/mechanisms/${rb.id}`, { value: 4 });
  assert.equal(put.status, 200);
  const rows = await cuePositions(db, a.id);
  assert.equal(rows.find(x => x.cue_id === 'c1').value, 0);
});
