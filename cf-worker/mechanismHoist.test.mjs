// 跑法：cd cf-worker && npm test
// 機關 v2 第 4 階段（0032）：吊掛（多點）。走真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1）：
//   migration 0032 在舊資料上（三個新欄位都是空的 = 一般機關、舊版後台的 INSERT 照樣寫得進去）；
//   製作新增 / 修改 / 刪除一整組吊掛（整組 + 2～4 個吊點一個交易），導演 403；檢查（吊點數量、位置疊在一起 / 排一直線、沒有物件）；
//   整組沒有自己的位置；吊點不能單獨新增 / 刪除、結構欄位不能單獨改；
//   正式站上還在跑的前端（網址只帶 ?mech=2，或什麼都沒帶）讀不到整組和吊點（零件靜止，不會往錯的方向動），?mech=3 才看得到；
//   舊版前端存別的機關、排序、沿用 cue 都不會弄壞吊掛；複製專案 / 匯出匯入帶著整組和吊點（新 id、接回新的整組）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, applyMigrations, freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import {
  loadMechanisms, loadSongPositions, rowToMechanism, copyMechanismsToProject, exportMechanisms, importMechanisms, snapshotCuePositions,
} from './mechanisms.mjs';

const BASE = 'https://proxy.test';
const P = '/api/projects/p1';

test('migration 0032：舊的機關三個新欄位都是空的（= 一般機關）；舊版後台的寫法照樣能寫；整組刪掉吊點跟著刪', async () => {
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0032' });
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p', 'P')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, category) VALUES ('o', 'p', 'LED', 'led_panel')`),
    db.prepare(`INSERT INTO mechanisms (id, project_id, name, kind) VALUES ('m', 'p', '升降台', 'linear')`),
    db.prepare(`INSERT INTO mechanism_objects (mechanism_id, stage_object_id) VALUES ('m', 'o')`),
  ]);
  applyMigrations(db, { only: '0032' });
  const m = await db.prepare(`SELECT * FROM mechanisms`).first();
  assert.equal(m.rig_id, null);
  assert.equal(m.rig_index, null);
  assert.equal(m.attach, null);
  // 舊版後台的 INSERT（明確欄位、沒有新欄位）照樣寫得進去
  await db.prepare(`INSERT INTO mechanisms (id, project_id, name, kind, axis, pivot, travel_min, travel_max, default_value, max_speed, presets, parent_id, console_label, "order", metadata, edited_at)
    VALUES ('m2', 'p', '轉台', 'rotary', '{"x":0,"y":1,"z":0}', '{"x":0,"y":0,"z":0}', -180, 180, 0, NULL, '[]', NULL, NULL, 1, NULL, datetime('now'))`).run();
  // 舊的機關讀出來：一般機關，吊掛的欄位都是空的
  const [old] = await loadMechanisms({ DB: db }, 'p', 'm');
  assert.equal(old.variant, null);
  assert.equal(old.rigId, null);
  assert.equal(old.attach, null);
  // 吊點指到整組；整組被刪 → 吊點跟著刪（外鍵）
  await db.batch([
    db.prepare(`INSERT INTO mechanisms (id, project_id, name, kind, variant) VALUES ('rig', 'p', '吊掛', 'linear', 'hoist_rig')`),
    db.prepare(`INSERT INTO mechanisms (id, project_id, name, kind, variant, rig_id, rig_index, attach) VALUES ('h1', 'p', '吊點', 'linear', 'hoist', 'rig', 0, '{"x":0,"y":1,"z":0}')`),
  ]);
  await db.prepare(`DELETE FROM mechanisms WHERE id = 'rig'`).run();
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM mechanisms WHERE id = 'h1'`).first()).n, 0);
});

async function setup() {
  const db = freshDb();
  const users = [['u_admin', '製作', 'admin', 'ADMIN-1'], ['u_dir', '王導', 'director', 'DIR-1']];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, `${id}@x.test`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '巡演')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order") VALUES ('s1', 'p1', '開場', 0)`),
    db.prepare(`INSERT INTO cues (id, song_id, name, "order", status, video_time_sec, crossfade_seconds) VALUES
      ('c1', 's1', '落地', 0, 'master', 0, 0), ('c2', 's1', '吊起', 1, 'master', 30, 5)`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order") VALUES
      ('oa', 'p1', 'A', '吊板 1', 'led_panel', 0), ('ob', 'p1', 'B', '吊板 2', 'led_panel', 1),
      ('olift', 'p1', 'T', '升降台', 'mechanism', 2), ('oc', 'p1', 'C', '別的板', 'led_panel', 3)`),
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

const RIG = {
  variant: 'hoist_rig', name: '舞台吊板', objectIds: ['oa', 'ob'],
  hoists: [
    { name: '左吊點', attach: { x: -2, y: 4, z: 0 }, travelMin: 0, travelMax: 6, maxSpeed: 0.5, consoleLabel: 'Axis 5' },
    { name: '右吊點', attach: { x: 2, y: 4, z: 0 }, travelMin: 0, travelMax: 6, maxSpeed: 0.5, consoleLabel: 'Axis 6' },
  ],
};
const LIFT = { name: '中央升降台', kind: 'linear', travelMin: 0, travelMax: 3.5, objectIds: ['olift'] };

async function createRig(call, body = RIG) {
  const r = await call('u_admin', 'POST', `${P}/mechanisms`, body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

test('製作新增一組吊掛：整組 + 吊點一個交易建好，吊點固定是往上的直線、沒有物件；導演 403', async () => {
  const { db, call } = await setup();
  const denied = await call('u_dir', 'POST', `${P}/mechanisms`, RIG);
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error, '只有製作可以修改專案內容');

  const { mechanism: rig, hoists } = await createRig(call);
  assert.equal(rig.variant, 'hoist_rig');
  assert.deepEqual(rig.objectIds.sort(), ['oa', 'ob']);
  assert.equal(rig.rigId, null);
  assert.equal(hoists.length, 2);
  assert.deepEqual(hoists.map(h => h.name), ['左吊點', '右吊點']);
  assert.deepEqual(hoists.map(h => h.rigIndex), [0, 1]);
  assert.ok(hoists.every(h => h.variant === 'hoist' && h.rigId === rig.id && h.kind === 'linear' && h.objectIds.length === 0 && h.parentId === null));
  assert.deepEqual(hoists[0].axis, { x: 0, y: 1, z: 0 });
  assert.deepEqual(hoists[1].attach, { x: 2, y: 4, z: 0 });
  assert.equal(hoists[1].consoleLabel, 'Axis 6');
  assert.equal(hoists[1].maxSpeed, 0.5);
  const rows = (await db.prepare(`SELECT id, variant, rig_id, rig_index, attach FROM mechanisms ORDER BY "order"`).all()).results;
  assert.deepEqual(rows.map(r => r.variant), ['hoist_rig', 'hoist', 'hoist']);
  assert.deepEqual(rows.map(r => r.rig_id), [null, rig.id, rig.id]);
  assert.deepEqual(JSON.parse(rows[2].attach), { x: 2, y: 4, z: 0 });
  // 物件在整組裡
  const mo = (await db.prepare(`SELECT mechanism_id, stage_object_id FROM mechanism_objects ORDER BY stage_object_id`).all()).results;
  assert.deepEqual(mo.map(r => [r.mechanism_id, r.stage_object_id]), [[rig.id, 'oa'], [rig.id, 'ob']]);
  // 新版畫面（?mech=3）讀得到
  const list = await call('u_dir', 'GET', `${P}/mechanisms?mech=3`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.mechanisms.map(m => m.name), ['舞台吊板', '左吊點', '右吊點']);
});

test('3 個、4 個吊點也行；吊點沒取名字 → 「整組 吊點 N」，行程預設 0 ~ 5 m', async () => {
  const { call } = await setup();
  const { hoists } = await createRig(call, {
    variant: 'hoist_rig', name: '四點吊', objectIds: ['oa'],
    hoists: [{ attach: { x: -2, y: 4, z: -1 } }, { attach: { x: 2, y: 4, z: -1 } }, { attach: { x: -2, y: 4, z: 1 } }, { attach: { x: 2, y: 4, z: 1 } }],
  });
  assert.deepEqual(hoists.map(h => h.name), ['四點吊 吊點 1', '四點吊 吊點 2', '四點吊 吊點 3', '四點吊 吊點 4']);
  assert.ok(hoists.every(h => h.travelMin === 0 && h.travelMax === 5 && h.defaultValue === 0));
});

test('檢查：吊點要 2 到 4 個、位置要分開、要有物件、吊點不能單獨新增（說清楚是哪裡）', async () => {
  const { call, db } = await setup();
  const post = (body) => call('u_admin', 'POST', `${P}/mechanisms`, body);
  const h = (x, z = 0, y = 4) => ({ attach: { x, y, z } });
  let r = await post({ ...RIG, hoists: [h(0)] });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'hoists');
  assert.equal(r.data.error, '吊掛要有 2 到 4 個吊點');
  r = await post({ ...RIG, hoists: [h(0), h(1), h(2, 1), h(3, 1), h(4, 1)] });
  assert.equal(r.data.error, '吊掛要有 2 到 4 個吊點');
  r = await post({ ...RIG, hoists: undefined });
  assert.equal(r.data.field, 'hoists');
  r = await post({ ...RIG, objectIds: [] });
  assert.equal(r.data.field, 'objectIds');
  r = await post({ ...RIG, hoists: [h(0), h(0, 0, 9)] });
  assert.equal(r.data.field, 'attach');
  assert.equal(r.data.error, '兩個吊點不能在同一個位置，請把它們分開');
  r = await post({ ...RIG, hoists: [h(0), h(1), h(2)] });
  assert.equal(r.data.error, '三個以上的吊點不能排成一直線，請把其中一個移開');
  r = await post({ ...RIG, hoists: [h(0), { attach: { x: 'x', y: 0, z: 0 } }] });
  assert.equal(r.data.error, '吊點的位置要填 X、Y、Z 三個數字');
  r = await post({ ...RIG, hoists: [h(0), { ...h(2), travelMin: 3, travelMax: 1 }] });
  assert.equal(r.data.field, 'travel');
  r = await post({ ...RIG, objectIds: ['nobody'] });
  assert.equal(r.status, 400);
  // 吊點不能單獨新增（要用整組）
  r = await post({ name: '偷偷的吊點', variant: 'hoist', rigId: 'x', rigIndex: 0, attach: { x: 0, y: 0, z: 0 } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /新增吊掛/);
  // 全部失敗 = 什麼都沒寫
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM mechanisms`).first()).n, 0);
  // 名稱不能跟別的機關重複
  await createRig(call);
  r = await post({ ...RIG, objectIds: ['oc'] });
  assert.equal(r.status, 400);
  assert.equal(r.data.field, 'name');
});

test('物件已經在別的機關 → 409，帶 moveObjects 才移（跟單獨新增一樣）', async () => {
  const { call } = await setup();
  await call('u_admin', 'POST', `${P}/mechanisms`, { name: '別的', kind: 'linear', travelMin: 0, travelMax: 1, objectIds: ['oa'] });
  const clash = await call('u_admin', 'POST', `${P}/mechanisms`, RIG);
  assert.equal(clash.status, 409);
  assert.equal(clash.data.conflicts[0].objectId, 'oa');
  const moved = await call('u_admin', 'POST', `${P}/mechanisms`, { ...RIG, moveObjects: true });
  assert.equal(moved.status, 201);
});

test('正式站上還在跑的前端（沒帶 ?mech / ?mech=2）看不到整組和吊點，也看不到它們的位置；?mech=3 全部看得到（含分享連結、機關總表）', async () => {
  const { env, call } = await setup();
  const { mechanism: rig, hoists } = await createRig(call);
  const lift = (await call('u_admin', 'POST', `${P}/mechanisms`, LIFT)).data.mechanism;
  for (const m of [...hoists, lift]) assert.equal((await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanisms/${m.id}`, { value: 2 })).status, 200);

  const names = async (q) => (await call('u_admin', 'GET', `${P}/mechanisms${q}`)).data.mechanisms.map(m => m.name);
  assert.deepEqual(await names(''), ['中央升降台']);
  assert.deepEqual(await names('?mech=1'), ['中央升降台']);
  assert.deepEqual(await names('?mech=2'), ['中央升降台']);   // 正式站現在的版本（看得懂對開、不懂吊掛）
  assert.deepEqual(await names('?mech=3'), ['舞台吊板', '左吊點', '右吊點', '中央升降台']);
  const ids = async (q) => (await call('u_dir', 'GET', `${P}/songs/s1/mechanism-positions${q}`)).data.positions.map(p => p.mechanismId).sort();
  assert.deepEqual(await ids('?mech=2'), [lift.id]);
  assert.deepEqual(await ids('?mech=3'), [...hoists.map(h => h.id), lift.id].sort());
  const sheet = async (q) => (await call('u_admin', 'GET', `${P}/mechanism-sheet${q}`)).data;
  assert.equal((await sheet('?mech=2')).mechanisms.length, 1);
  assert.equal((await sheet('?mech=2')).positions.length, 1);
  assert.equal((await sheet('?mech=3')).mechanisms.length, 4);
  assert.equal((await sheet('?mech=3')).positions.length, 3);

  const link = await call('u_admin', 'POST', `${P}/share-links`, {});
  assert.equal(link.status, 201);
  const t = link.data.token;
  assert.deepEqual((await call(null, 'GET', `/api/share/${t}/data?mech=2`)).data.mechanisms.map(m => m.name), ['中央升降台']);
  const shareNew = await call(null, 'GET', `/api/share/${t}/data?mech=3`);
  assert.deepEqual(shareNew.data.mechanisms.map(m => m.name), ['舞台吊板', '左吊點', '右吊點', '中央升降台']);
  assert.deepEqual(shareNew.data.mechanisms[1].attach, { x: -2, y: 4, z: 0 });
  assert.equal((await call(null, 'GET', `/api/share/${t}/songs/s1/mechanism-positions?mech=2`)).data.positions.length, 1);
  assert.equal((await call(null, 'GET', `/api/share/${t}/songs/s1/mechanism-positions?mech=3`)).data.positions.length, 3);

  // 內部呼叫的預設：給全部；只要一般的
  assert.equal((await loadMechanisms(env, 'p1')).length, 4);
  assert.equal((await loadMechanisms(env, 'p1', null, { mech2: true, mech3: false })).length, 1);
  assert.equal((await loadMechanisms(env, 'p1', null, { mech2: false })).length, 1);
  assert.equal((await loadSongPositions(env, 's1')).length, 3);
  assert.equal(rig.variant, 'hoist_rig');
});

test('位置：吊點跟普通機關一樣（夾進行程、延遲 / 走幾秒）；整組沒有自己的位置（單獨寫或一次寫很多個都 400）', async () => {
  const { call, db } = await setup();
  const { mechanism: rig, hoists } = await createRig(call);
  const put = await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanisms/${hoists[0].id}`, { value: 99, delaySec: 1, durationSec: 4 });
  assert.equal(put.status, 200);
  assert.equal(put.data.value, 6);
  assert.equal(put.data.clamped, true);
  assert.equal(put.data.delaySec, 1);
  const bad = await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanisms/${rig.id}`, { value: 1 });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, '這是整組吊掛，沒有自己的位置，請設定它的每個吊點');
  const bulk = await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanism-positions`, { items: hoists.map((h, i) => ({ mechanismId: h.id, value: i + 1 })) });
  assert.equal(bulk.status, 200);
  assert.deepEqual(bulk.data.items.map(x => x.value), [1, 2]);
  const bulkBad = await call('u_admin', 'PUT', `${P}/songs/s1/cues/c1/mechanism-positions`, { items: [{ mechanismId: hoists[0].id, value: 1 }, { mechanismId: rig.id, value: 1 }] });
  assert.equal(bulkBad.status, 400);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM cue_mechanism_positions WHERE cue_id = 'c1'`).first()).n, 0);   // 整批都不動
  // 從目前 3D 畫面建立 cue：整組的 id 略過、吊點照存
  const n = await snapshotCuePositions({ DB: db }, 'p1', 'c1', { [rig.id]: 3, [hoists[1].id]: 1.5 });
  assert.equal(n, 1);
  assert.equal((await db.prepare(`SELECT value FROM cue_mechanism_positions WHERE cue_id = 'c1' AND mechanism_id = ?`).bind(hoists[1].id).first()).value, 1.5);
});

test('吊點單獨修改：名稱 / 行程 / 速度 / 預設位置可以改；位置、屬於哪一組、物件、類型都鎖住；吊點不能單獨刪', async () => {
  const { call } = await setup();
  const { mechanism: rig, hoists } = await createRig(call);
  const h = hoists[0];
  const ok = await call('u_admin', 'PATCH', `${P}/mechanisms/${h.id}`, {
    name: '左鍊條', travelMax: 8, defaultValue: 1, maxSpeed: 0.25,
    attach: { x: 99, y: 99, z: 99 }, objectIds: ['oc'], parentId: rig.id, variant: 'hoist', rigId: 'zzz', kind: 'rotary', axis: { x: 1, y: 0, z: 0 },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const m = ok.data.mechanism;
  assert.deepEqual([m.name, m.travelMax, m.defaultValue, m.maxSpeed], ['左鍊條', 8, 1, 0.25]);
  assert.deepEqual(m.attach, { x: -2, y: 4, z: 0 });
  assert.deepEqual(m.objectIds, []);
  assert.equal(m.parentId, null);
  assert.equal(m.rigId, rig.id);
  assert.equal(m.kind, 'linear');
  assert.deepEqual(m.axis, { x: 0, y: 1, z: 0 });
  // 變類型鎖住
  const lock = await call('u_admin', 'PATCH', `${P}/mechanisms/${h.id}`, { variant: null });
  assert.equal(lock.status, 400);
  assert.match(lock.data.error, /新增吊掛/);
  const lock2 = await call('u_admin', 'PATCH', `${P}/mechanisms/${rig.id}`, { variant: null });
  assert.equal(lock2.status, 400);
  const plain = (await call('u_admin', 'POST', `${P}/mechanisms`, LIFT)).data.mechanism;
  const lock3 = await call('u_admin', 'PATCH', `${P}/mechanisms/${plain.id}`, { variant: 'hoist_rig' });
  assert.equal(lock3.status, 400);
  // 吊點不能單獨刪
  const del = await call('u_admin', 'DELETE', `${P}/mechanisms/${h.id}`);
  assert.equal(del.status, 400);
  assert.match(del.data.error, /至少要有 2 個吊點/);
  // 不能當別的機關的上層
  const under = await call('u_admin', 'PATCH', `${P}/mechanisms/${plain.id}`, { parentId: rig.id });
  assert.equal(under.status, 400);
  assert.equal(under.data.error, '吊掛的機關不能當別的機關的上層');
  // 導演 403
  assert.equal((await call('u_dir', 'PATCH', `${P}/mechanisms/${h.id}`, { name: 'x' })).status, 403);
});

test('修改整組吊掛：改名字；吊點清單整個換（有 id 的改、沒有 id 的新增、沒列出來的刪掉連同位置）；物件衝突 409', async () => {
  const { call, db } = await setup();
  const { mechanism: rig, hoists } = await createRig(call);
  for (const [i, h] of hoists.entries()) await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanisms/${h.id}`, { value: i + 2 });
  // 只改名字：吊點不動
  const rn = await call('u_admin', 'PATCH', `${P}/mechanisms/${rig.id}`, { name: '大吊板' });
  assert.equal(rn.status, 200);
  assert.equal(rn.data.mechanism.name, '大吊板');
  assert.deepEqual(rn.data.hoists.map(x => x.id), hoists.map(x => x.id));
  // 加第三個吊點、改右吊點的行程（變小 → 位置 3 超出）、換物件
  const up = await call('u_admin', 'PATCH', `${P}/mechanisms/${rig.id}`, {
    objectIds: ['oa', 'ob', 'oc'],
    hoists: [
      { id: hoists[0].id, attach: hoists[0].attach },
      { id: hoists[1].id, attach: hoists[1].attach, travelMax: 2, name: '右鍊條' },
      { name: '後吊點', attach: { x: 0, y: 4, z: -2 } },
    ],
  });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.hoists.length, 3);
  assert.deepEqual(up.data.hoists.map(x => x.name), ['左吊點', '右鍊條', '後吊點']);
  assert.deepEqual(up.data.hoists.map(x => x.rigIndex), [0, 1, 2]);
  assert.equal(up.data.hoists[0].id, hoists[0].id);   // 沒新建，是改原本的
  assert.equal(up.data.outOfRangeCount, 1);
  assert.deepEqual(up.data.mechanism.objectIds.sort(), ['oa', 'ob', 'oc']);
  // 刪掉左吊點（沒列出來）：它在 c2 的位置跟著刪掉
  const rm = await call('u_admin', 'PATCH', `${P}/mechanisms/${rig.id}`, {
    hoists: [{ id: hoists[1].id, attach: hoists[1].attach }, { id: up.data.hoists[2].id, attach: up.data.hoists[2].attach }],
  });
  assert.equal(rm.status, 200);
  assert.deepEqual(rm.data.hoists.map(x => x.id), [hoists[1].id, up.data.hoists[2].id]);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM mechanisms WHERE id = ?`).bind(hoists[0].id).first()).n, 0);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM cue_mechanism_positions WHERE mechanism_id = ?`).bind(hoists[0].id).first()).n, 0);
  // 少於 2 個、別的整組的 id、位置疊在一起 → 400，什麼都不動
  assert.equal((await call('u_admin', 'PATCH', `${P}/mechanisms/${rig.id}`, { hoists: [{ id: hoists[1].id, attach: hoists[1].attach }] })).status, 400);
  assert.equal((await call('u_admin', 'PATCH', `${P}/mechanisms/${rig.id}`, { hoists: [{ id: 'zzz', attach: { x: 0, y: 0, z: 0 } }, { id: hoists[1].id, attach: hoists[1].attach }] })).status, 400);
  assert.equal((await call('u_admin', 'PATCH', `${P}/mechanisms/${rig.id}`, { hoists: [{ id: hoists[1].id, attach: { x: 0, y: 4, z: 0 } }, { attach: { x: 0, y: 7, z: 0 } }] })).status, 400);
  assert.equal((await call('u_admin', 'GET', `${P}/mechanisms?mech=3`)).data.mechanisms.length, 3);
  // 物件在別的機關 → 409，帶 moveObjects 才移
  await call('u_admin', 'POST', `${P}/mechanisms`, LIFT);
  const clash = await call('u_admin', 'PATCH', `${P}/mechanisms/${rig.id}`, { objectIds: ['oa', 'olift'] });
  assert.equal(clash.status, 409);
  assert.equal((await call('u_admin', 'PATCH', `${P}/mechanisms/${rig.id}`, { objectIds: ['oa', 'olift'], moveObjects: true })).status, 200);
});

test('刪除整組吊掛：吊點和它們每個 cue 的位置一起刪（說出刪了幾筆）', async () => {
  const { call, db } = await setup();
  const { mechanism: rig, hoists } = await createRig(call);
  for (const h of hoists) for (const c of ['c1', 'c2']) await call('u_admin', 'PUT', `${P}/songs/s1/cues/${c}/mechanisms/${h.id}`, { value: 1 });
  const lift = (await call('u_admin', 'POST', `${P}/mechanisms`, LIFT)).data.mechanism;
  await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanisms/${lift.id}`, { value: 1 });
  const del = await call('u_admin', 'DELETE', `${P}/mechanisms/${rig.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.removedPositions, 4);
  assert.deepEqual((await db.prepare(`SELECT id FROM mechanisms`).all()).results.map(r => r.id), [lift.id]);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM cue_mechanism_positions`).first()).n, 1);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM mechanism_objects WHERE mechanism_id = ?`).bind(rig.id).first()).n, 0);
});

test('舊版前端存別的機關、排序、沿用 cue、新增普通機關，都不會弄壞吊掛', async () => {
  const { db, call } = await setup();
  const { mechanism: rig, hoists } = await createRig(call);
  const lift = (await call('u_admin', 'POST', `${P}/mechanisms`, LIFT)).data.mechanism;
  await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanisms/${hoists[0].id}`, { value: 3, delaySec: 2 });
  // 舊版只看得到升降台：改它、排序（只送它的 id）
  assert.equal((await call('u_admin', 'PATCH', `${P}/mechanisms/${lift.id}`, { travelMax: 4 })).status, 200);
  assert.equal((await call('u_admin', 'POST', `${P}/mechanisms/reorder`, { ids: [lift.id] })).status, 200);
  const row = await db.prepare(`SELECT variant, rig_id, rig_index, attach FROM mechanisms WHERE id = ?`).bind(hoists[0].id).first();
  assert.deepEqual({ ...row }, { variant: 'hoist', rig_id: rig.id, rig_index: 0, attach: JSON.stringify({ x: -2, y: 4, z: 0 }) });
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM mechanism_objects WHERE mechanism_id = ?`).bind(rig.id).first()).n, 2);
  // 舊版新增 cue 沿用上一個 cue：吊點的位置和延遲照樣複製
  const clone = await call('u_admin', 'POST', `${P}/songs/s1/cues`, { name: '再吊', cloneFrom: 'c2', status: 'master', order: 2 });
  assert.ok(clone.status === 200 || clone.status === 201, JSON.stringify(clone.data));
  const copied = await db.prepare(`SELECT value, delay_sec FROM cue_mechanism_positions WHERE cue_id = ? AND mechanism_id = ?`).bind(clone.data.cue?.id ?? clone.data.id, hoists[0].id).first();
  assert.deepEqual({ ...copied }, { value: 3, delay_sec: 2 });
  // 舊版前端新增普通機關 → 一般機關；想把吊掛裡的物件拿走 → 409（說「已經在「舞台吊板」裡」）
  const plain = await call('u_admin', 'POST', `${P}/mechanisms`, { name: '布幕', kind: 'linear', travelMin: 0, travelMax: 2 });
  assert.equal(plain.data.mechanism.variant, null);
  const clash = await call('u_admin', 'PATCH', `${P}/mechanisms/${plain.data.mechanism.id}`, { objectIds: ['oa'] });
  assert.equal(clash.status, 409);
  assert.equal(clash.data.conflicts[0].mechanismName, '舞台吊板');
});

test('吊掛不能轉換 cue 位置', async () => {
  const { call } = await setup();
  const { mechanism: rig, hoists } = await createRig(call);
  for (const id of [rig.id, hoists[0].id]) {
    const r = await call('u_admin', 'POST', `${P}/mechanisms/${id}/convert-cue-positions`, { dryRun: true });
    assert.equal(r.status, 400);
    assert.equal(r.data.error, '吊掛的機關不能轉換 cue 位置');
  }
});

test('複製專案 / 匯出匯入：整組和吊點跟著（新 id、吊點接回新的整組），位置和延遲也在；不完整的整組略過；舊的匯出檔照樣匯得進去', async () => {
  const { db, env, call } = await setup();
  const { mechanism: rig, hoists } = await createRig(call);
  await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanisms/${hoists[1].id}`, { value: 3, delaySec: 1.5 });

  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p2', '副本')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, category) VALUES ('p2oa', 'p2', 'A', 'led_panel'), ('p2ob', 'p2', 'B', 'led_panel')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order") VALUES ('s2', 'p2', '開場', 0)`),
    db.prepare(`INSERT INTO cues (id, song_id, name, "order") VALUES ('p2c2', 's2', '吊起', 1)`),
  ]);
  const r = await copyMechanismsToProject(env, 'p1', 'p2', new Map([['oa', 'p2oa'], ['ob', 'p2ob']]), new Map([['c2', 'p2c2']]));
  assert.equal(r.mechanisms, 3);
  const copies = await loadMechanisms(env, 'p2');
  const nrig = copies.find(m => m.variant === 'hoist_rig');
  assert.ok(nrig && nrig.id !== rig.id);
  assert.deepEqual(nrig.objectIds.sort(), ['p2oa', 'p2ob']);
  const nh = copies.filter(m => m.variant === 'hoist').sort((a, b) => a.rigIndex - b.rigIndex);
  assert.deepEqual(nh.map(h => h.name), ['左吊點', '右吊點']);
  assert.ok(nh.every(h => h.rigId === nrig.id && !hoists.some(o => o.id === h.id)));
  assert.deepEqual(nh[1].attach, { x: 2, y: 4, z: 0 });
  assert.equal(nh[1].maxSpeed, 0.5);
  assert.equal(nh[1].consoleLabel, 'Axis 6');
  const pos = await db.prepare(`SELECT mechanism_id, value, delay_sec FROM cue_mechanism_positions WHERE cue_id = 'p2c2'`).first();
  assert.deepEqual({ ...pos }, { mechanism_id: nh[1].id, value: 3, delay_sec: 1.5 });
  // 原本專案的整組還在、沒被動到
  assert.equal((await loadMechanisms(env, 'p1')).length, 3);

  // 匯出檔 → 匯入到第三個專案
  const exp = await exportMechanisms(env, 'p1');
  assert.ok(exp.mechanisms.some(m => m.variant === 'hoist' && m.rig_id === rig.id && m.attach));
  await db.prepare(`INSERT INTO projects (id, name) VALUES ('p3', '匯入')`).run();
  await db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, category) VALUES ('p3oa', 'p3', 'A', 'led_panel')`).run();
  assert.equal((await importMechanisms(env, 'p3', exp, new Map([['oa', 'p3oa']]), new Map())).mechanisms, 3);
  const imp = await loadMechanisms(env, 'p3');
  const irig = imp.find(m => m.variant === 'hoist_rig');
  assert.deepEqual(irig.objectIds, ['p3oa']);
  assert.deepEqual(imp.filter(m => m.variant === 'hoist').map(h => h.rigId), [irig.id, irig.id]);

  // 不完整的整組（只剩 1 個吊點 / 吊點指到不存在的整組）連同吊點略過；其他機關照匯
  const broken = {
    mechanisms: [
      ...exp.mechanisms.filter(m => m.id !== hoists[1].id),
      { id: 'orphan', name: '孤兒吊點', kind: 'linear', variant: 'hoist', rig_id: 'ghost', rig_index: 0, attach: '{"x":0,"y":1,"z":0}', axis: '{"x":0,"y":1,"z":0}', travel_min: 0, travel_max: 1, default_value: 0, presets: '[]', "order": 9 },
      { id: 'plain', name: '一般', kind: 'linear', axis: '{"x":0,"y":1,"z":0}', travel_min: 0, travel_max: 1, default_value: 0, presets: '[]', "order": 10 },
    ],
    mechanismObjects: exp.mechanismObjects, cueMechanismPositions: exp.cueMechanismPositions,
  };
  await db.prepare(`INSERT INTO projects (id, name) VALUES ('p4', '壞檔')`).run();
  await db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, category) VALUES ('p4oa', 'p4', 'A', 'led_panel')`).run();
  const res = await importMechanisms(env, 'p4', broken, new Map([['oa', 'p4oa']]), new Map());
  assert.equal(res.mechanisms, 1);
  assert.deepEqual((await loadMechanisms(env, 'p4')).map(m => m.name), ['一般']);

  // 舊的匯出檔（沒有 rig_id / attach）照樣匯得進去，都是一般機關
  const old = {
    mechanisms: [{ id: 'm_old', name: '舊升降台', kind: 'linear', axis: '{"x":0,"y":1,"z":0}', travel_min: 0, travel_max: 2, default_value: 0, presets: '[]', "order": 0 }],
    mechanismObjects: [{ mechanism_id: 'm_old', stage_object_id: 'oa' }], cueMechanismPositions: [],
  };
  await db.prepare(`INSERT INTO projects (id, name) VALUES ('p5', '舊檔')`).run();
  await db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, category) VALUES ('p5oa', 'p5', 'A', 'led_panel')`).run();
  assert.equal((await importMechanisms(env, 'p5', old, new Map([['oa', 'p5oa']]), new Map())).mechanisms, 1);
  assert.equal((await loadMechanisms(env, 'p5'))[0].variant, null);
});

test('資料庫一列 → API：壞掉的吊點（沒有位置 / 沒有整組）當一般機關，不會讓畫面掛掉', () => {
  const base = { id: 'm', name: 'x', kind: 'linear', axis: '{"x":0,"y":1,"z":0}', pivot: null, travel_min: 0, travel_max: 1, default_value: 0, max_speed: null, presets: '[]', parent_id: null, console_label: null, order: 0, metadata: null, updated_at: '' };
  assert.equal(rowToMechanism({ ...base, variant: 'hoist', rig_id: 'r', rig_index: 1, attach: '{"x":1,"y":2,"z":3}' }).attach.y, 2);
  assert.equal(rowToMechanism({ ...base, variant: 'hoist', rig_id: 'r', rig_index: 1, attach: 'not json' }).variant, null);
  assert.equal(rowToMechanism({ ...base, variant: 'hoist', rig_id: null, rig_index: 1, attach: '{"x":1,"y":2,"z":3}' }).variant, null);
  assert.equal(rowToMechanism({ ...base, variant: 'hoist_rig' }, ['o']).variant, 'hoist_rig');
  assert.equal(rowToMechanism({ ...base, variant: 'hoist_rig' }, ['o']).rigId, null);
});
