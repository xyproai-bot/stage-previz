// 跑法：cd cf-worker && npm test
// 機關 v2 第 2 階段（0030）：對開（兩邊往反方向）和翻轉（沿著邊緣翻）。走真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1）：
//   migration 0030 在舊資料上（三個新欄位都是空的 = 一般機關、舊版後台的 INSERT 照樣寫得進去、CHECK 擋壞值）；
//   製作可以新增 / 修改對開（A 邊 / B 邊），導演 403；檢查（旋轉對開要有 B 邊、對開不能當上層、改回一般清掉 B 邊）；
//   舊版前端（網址沒帶 ?mech=2）讀不到對開的機關和它的位置（零件靜止，不會往錯的方向動），翻轉照樣看得到；
//   舊版前端存別的機關不會動到對開；複製專案 / 匯出匯入帶著 B 邊和每個物件的邊；對開不能轉換 cue 位置。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, applyMigrations, freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import {
  loadMechanisms, loadSongPositions, rowToMechanism, copyMechanismsToProject, exportMechanisms, importMechanisms,
} from './mechanisms.mjs';

const BASE = 'https://proxy.test';

test('migration 0030：舊的機關三個新欄位都是空的（= 一般機關）；舊版後台的寫法照樣能寫；壞值資料庫也擋', async () => {
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0030' });
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p', 'P')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, category) VALUES ('o', 'p', 'LED', 'led_panel')`),
    db.prepare(`INSERT INTO mechanisms (id, project_id, name, kind) VALUES ('m', 'p', '升降台', 'linear')`),
    db.prepare(`INSERT INTO mechanism_objects (mechanism_id, stage_object_id) VALUES ('m', 'o')`),
  ]);
  applyMigrations(db, { only: '0030' });
  const m = await db.prepare(`SELECT * FROM mechanisms`).first();
  assert.equal(m.variant, null);
  assert.equal(m.mirror, null);
  assert.equal((await db.prepare(`SELECT side FROM mechanism_objects`).first()).side, null);
  // 舊版後台的 INSERT（明確欄位、沒有新欄位）照樣寫得進去
  await db.prepare(`INSERT INTO mechanisms (id, project_id, name, kind, axis, pivot, travel_min, travel_max, default_value, max_speed, presets, parent_id, console_label, "order", metadata, edited_at)
    VALUES ('m2', 'p', '轉台', 'rotary', '{"x":0,"y":1,"z":0}', '{"x":0,"y":0,"z":0}', -180, 180, 0, NULL, '[]', NULL, NULL, 1, NULL, datetime('now'))`).run();
  await assert.rejects(db.prepare(`UPDATE mechanisms SET variant = 'wobble' WHERE id = 'm'`).run(), /CHECK/);
  await assert.rejects(db.prepare(`UPDATE mechanism_objects SET side = 'c'`).run(), /CHECK/);
  // 舊的機關讀出來：一般機關
  const [old] = await loadMechanisms({ DB: db }, 'p', 'm');
  assert.equal(old.variant, null);
  assert.equal(old.mirror, null);
  assert.deepEqual(old.objectSides, {});
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
      ('c1', 's1', '關', 0, 'master', 0, 0), ('c2', 's1', '開', 1, 'master', 30, 5)`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order") VALUES
      ('ol1', 'p1', 'L1', '左 1', 'led_panel', 0), ('ol2', 'p1', 'L2', '左 2', 'led_panel', 1),
      ('or1', 'p1', 'R1', '右 1', 'led_panel', 2), ('or2', 'p1', 'R2', '右 2', 'led_panel', 3),
      ('oflip', 'p1', 'F', '翻板', 'led_panel', 4), ('olift', 'p1', 'T', '升降台', 'mechanism', 5)`),
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

const SPLIT = {
  name: '對開 LED', kind: 'linear', variant: 'split', axis: { x: -1, y: 0, z: 0 }, travelMin: 0, travelMax: 4, maxSpeed: 0.5,
  consoleLabel: 'Axis 7', mirror: { axis: { x: 1, y: 0, z: 0 }, pivot: null, consoleLabel: 'Axis 8' },
  objectIds: ['ol1', 'ol2', 'or1', 'or2'], objectSides: { ol1: 'a', ol2: 'a', or1: 'b', or2: 'b' },
};
const FLIP = {
  name: '翻板', kind: 'rotary', axis: { x: -1, y: 0, z: 0 }, pivot: { x: 0, y: 3, z: 5 }, travelMin: 0, travelMax: 90,
  metadata: { setup: { hinge: 'top', positive: 'first' } }, objectIds: ['oflip'],
};
const P = '/api/projects/p1';

test('製作新增對開：A 邊 / B 邊、B 邊的方向和控台編號都存得下來；導演 403', async () => {
  const { db, call } = await setup();
  const denied = await call('u_dir', 'POST', `${P}/mechanisms`, SPLIT);
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error, '只有製作可以修改專案內容');

  const r = await call('u_admin', 'POST', `${P}/mechanisms`, SPLIT);
  assert.equal(r.status, 201);
  const m = r.data.mechanism;
  assert.equal(m.variant, 'split');
  assert.deepEqual(m.mirror, { axis: { x: 1, y: 0, z: 0 }, pivot: null, consoleLabel: 'Axis 8' });
  assert.deepEqual(m.objectSides, { ol1: 'a', ol2: 'a', or1: 'b', or2: 'b' });
  assert.deepEqual(m.objectIds.sort(), ['ol1', 'ol2', 'or1', 'or2']);
  // 資料庫：variant / mirror 欄位、每個物件的邊
  const row = await db.prepare(`SELECT variant, mirror FROM mechanisms WHERE id = ?`).bind(m.id).first();
  assert.equal(row.variant, 'split');
  assert.deepEqual(JSON.parse(row.mirror), { axis: { x: 1, y: 0, z: 0 }, pivot: null, consoleLabel: 'Axis 8' });
  const sides = await db.prepare(`SELECT stage_object_id AS o, side FROM mechanism_objects WHERE mechanism_id = ? ORDER BY o`).bind(m.id).all();
  assert.deepEqual(sides.results.map(x => [x.o, x.side]), [['ol1', 'a'], ['ol2', 'a'], ['or1', 'b'], ['or2', 'b']]);

  // 導演（新版畫面，?mech=2）看得到
  const dir = await call('u_dir', 'GET', `${P}/mechanisms?mech=2`);
  assert.equal(dir.status, 200);
  assert.equal(dir.data.mechanisms.length, 1);
  assert.equal(dir.data.mechanisms[0].variant, 'split');
});

test('直線對開沒給 B 邊 → 後台補反方向；旋轉對開沒給 B 邊 → 400（field = mirror）', async () => {
  const { call } = await setup();
  const lin = await call('u_admin', 'POST', `${P}/mechanisms`, { ...SPLIT, mirror: undefined });
  assert.equal(lin.status, 201);
  assert.deepEqual(lin.data.mechanism.mirror, { axis: { x: 1, y: 0, z: 0 }, pivot: null, consoleLabel: null });

  const rot = await call('u_admin', 'POST', `${P}/mechanisms`, {
    ...SPLIT, name: '旋轉對開', kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: -4, y: 0, z: 0 }, travelMin: -90, travelMax: 90,
    mirror: undefined, objectIds: ['ol1'], objectSides: {},
  });
  assert.equal(rot.status, 400);
  assert.equal(rot.data.field, 'mirror');
  assert.equal(rot.data.error, '對開的 B 邊方向不正確');
});

test('修改：換邊、改回一般機關（B 邊和每個物件的邊都清掉）、只改名字不動對開', async () => {
  const { db, call } = await setup();
  const id = (await call('u_admin', 'POST', `${P}/mechanisms`, SPLIT)).data.mechanism.id;
  const sidesOf = async () => Object.fromEntries((await db.prepare(`SELECT stage_object_id AS o, side FROM mechanism_objects WHERE mechanism_id = ?`).bind(id).all()).results.map(x => [x.o, x.side]));

  // 只改名字（舊版前端也會這樣送）→ 對開、邊都不動
  const rn = await call('u_admin', 'PATCH', `${P}/mechanisms/${id}`, { name: '對開 LED 牆' });
  assert.equal(rn.status, 200);
  assert.equal(rn.data.mechanism.variant, 'split');
  assert.deepEqual(await sidesOf(), { ol1: 'a', ol2: 'a', or1: 'b', or2: 'b' });

  // 只換邊
  const sw = await call('u_admin', 'PATCH', `${P}/mechanisms/${id}`, { objectSides: { ol1: 'b', ol2: 'a', or1: 'b', or2: 'a' } });
  assert.equal(sw.status, 200);
  assert.deepEqual(sw.data.mechanism.objectSides, { ol1: 'b', ol2: 'a', or1: 'b', or2: 'a' });
  assert.deepEqual(await sidesOf(), { ol1: 'b', ol2: 'a', or1: 'b', or2: 'a' });

  // 改回一般機關
  const off = await call('u_admin', 'PATCH', `${P}/mechanisms/${id}`, { variant: null });
  assert.equal(off.status, 200);
  assert.equal(off.data.mechanism.variant, null);
  assert.equal(off.data.mechanism.mirror, null);
  assert.deepEqual(off.data.mechanism.objectSides, {});
  assert.deepEqual(await sidesOf(), { ol1: null, ol2: null, or1: null, or2: null });
  assert.equal((await db.prepare(`SELECT mirror FROM mechanisms WHERE id = ?`).bind(id).first()).mirror, null);

  // 再改成對開
  const on = await call('u_admin', 'PATCH', `${P}/mechanisms/${id}`, { variant: 'split', objectSides: { or1: 'b', or2: 'b' } });
  assert.equal(on.status, 200);
  assert.deepEqual(on.data.mechanism.objectSides, { ol1: 'a', ol2: 'a', or1: 'b', or2: 'b' });
  assert.deepEqual(on.data.mechanism.mirror, { axis: { x: 1, y: 0, z: 0 }, pivot: null, consoleLabel: null });
});

test('對開不能當別的機關的上層、不能裝了別人才改成對開', async () => {
  const { call } = await setup();
  const split = (await call('u_admin', 'POST', `${P}/mechanisms`, SPLIT)).data.mechanism;
  const kid = await call('u_admin', 'POST', `${P}/mechanisms`, { name: '升降台', kind: 'linear', travelMin: 0, travelMax: 1, objectIds: ['olift'], parentId: split.id });
  assert.equal(kid.status, 400);
  assert.equal(kid.data.field, 'parentId');
  assert.equal(kid.data.error, '對開的機關不能當別的機關的上層');

  const plain = (await call('u_admin', 'POST', `${P}/mechanisms`, { name: '轉台', kind: 'linear', travelMin: 0, travelMax: 1, objectIds: ['olift'] })).data.mechanism;
  await call('u_admin', 'POST', `${P}/mechanisms`, { ...SPLIT, name: '另一個', objectIds: ['oflip'], objectSides: {}, parentId: plain.id });  // 對開裝在別的機關上可以
  const late = await call('u_admin', 'POST', `${P}/mechanisms`, { name: '小弟', kind: 'linear', travelMin: 0, travelMax: 1, parentId: plain.id });
  assert.equal(late.status, 201);
  const mk = await call('u_admin', 'PATCH', `${P}/mechanisms/${plain.id}`, { variant: 'split' });
  assert.equal(mk.status, 400);
  assert.equal(mk.data.error, '有機關裝在它上面，不能改成對開');
});

test('翻轉：還是旋轉機關，選的邊緣記在 metadata.setup；舊版前端（沒帶 ?mech=2）照樣看得到、改得動，metadata 不會掉', async () => {
  const { call } = await setup();
  const f = await call('u_admin', 'POST', `${P}/mechanisms`, FLIP);
  assert.equal(f.status, 201);
  assert.deepEqual(f.data.mechanism.metadata, { setup: { hinge: 'top', positive: 'first' } });
  assert.equal(f.data.mechanism.variant, null);
  assert.deepEqual(f.data.mechanism.pivot, { x: 0, y: 3, z: 5 });

  // 舊版前端：沒帶 ?mech=2，看得到翻轉的機關
  const old = await call('u_admin', 'GET', `${P}/mechanisms`);
  assert.equal(old.data.mechanisms.length, 1);
  assert.equal(old.data.mechanisms[0].name, '翻板');
  // 舊版前端存它（把整份 metadata 原樣送回來）→ 不掉
  const patched = await call('u_admin', 'PATCH', `${P}/mechanisms/${f.data.mechanism.id}`, { name: '翻板 2', metadata: old.data.mechanisms[0].metadata, consoleLabel: 'Axis 9' });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.data.mechanism.metadata, { setup: { hinge: 'top', positive: 'first' } });
  // 新版改成另一個邊緣
  const re = await call('u_admin', 'PATCH', `${P}/mechanisms/${f.data.mechanism.id}`, {
    axis: { x: 1, y: 0, z: 0 }, pivot: { x: 0, y: 0.5, z: 5 }, metadata: { setup: { hinge: 'bottom', positive: 'second' } },
  });
  assert.deepEqual(re.data.mechanism.metadata, { setup: { hinge: 'bottom', positive: 'second' } });
});

test('舊版前端（網址沒帶 ?mech=2）：看不到對開的機關和它的位置，其他照常；新版（?mech=2）全部看得到', async () => {
  const { call, env } = await setup();
  const split = (await call('u_admin', 'POST', `${P}/mechanisms`, SPLIT)).data.mechanism;
  const lift = (await call('u_admin', 'POST', `${P}/mechanisms`, { name: '中央升降台', kind: 'linear', travelMin: 0, travelMax: 3.5, objectIds: ['olift'] })).data.mechanism;
  for (const m of [split, lift]) {
    const put = await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanisms/${m.id}`, { value: 2 });
    assert.equal(put.status, 200);
  }

  // 機關清單
  assert.deepEqual((await call('u_admin', 'GET', `${P}/mechanisms`)).data.mechanisms.map(m => m.name), ['中央升降台']);
  assert.deepEqual((await call('u_admin', 'GET', `${P}/mechanisms?mech=1`)).data.mechanisms.map(m => m.name), ['中央升降台']);
  assert.deepEqual((await call('u_admin', 'GET', `${P}/mechanisms?mech=2`)).data.mechanisms.map(m => m.name), ['對開 LED', '中央升降台']);
  // 整首歌的位置
  assert.deepEqual((await call('u_dir', 'GET', `${P}/songs/s1/mechanism-positions`)).data.positions.map(p => p.mechanismId), [lift.id]);
  assert.deepEqual((await call('u_dir', 'GET', `${P}/songs/s1/mechanism-positions?mech=2`)).data.positions.map(p => p.mechanismId).sort(), [split.id, lift.id].sort());
  // 機關總表
  const sheetOld = await call('u_admin', 'GET', `${P}/mechanism-sheet`);
  assert.deepEqual(sheetOld.data.mechanisms.map(m => m.name), ['中央升降台']);
  assert.deepEqual(sheetOld.data.positions.map(p => p.mechanismId), [lift.id]);
  const sheetNew = await call('u_admin', 'GET', `${P}/mechanism-sheet?mech=2`);
  assert.equal(sheetNew.data.mechanisms.length, 2);
  assert.equal(sheetNew.data.positions.length, 2);

  // 分享連結：資料（定義）和位置
  const link = await call('u_admin', 'POST', `${P}/share-links`, {});
  assert.equal(link.status, 201);
  const t = link.data.token;
  assert.deepEqual((await call(null, 'GET', `/api/share/${t}/data`)).data.mechanisms.map(m => m.name), ['中央升降台']);
  const shareNew = await call(null, 'GET', `/api/share/${t}/data?mech=2`);
  assert.deepEqual(shareNew.data.mechanisms.map(m => m.name), ['對開 LED', '中央升降台']);
  assert.deepEqual(shareNew.data.mechanisms[0].objectSides, SPLIT.objectSides);
  assert.deepEqual((await call(null, 'GET', `/api/share/${t}/songs/s1/mechanism-positions`)).data.positions.map(p => p.mechanismId), [lift.id]);
  assert.equal((await call(null, 'GET', `/api/share/${t}/songs/s1/mechanism-positions?mech=2`)).data.positions.length, 2);

  // 內部呼叫的預設：給全部
  assert.equal((await loadMechanisms(env, 'p1')).length, 2);
  assert.equal((await loadMechanisms(env, 'p1', null, { mech2: false })).length, 1);
  assert.equal((await loadSongPositions(env, 's1')).length, 2);
});

test('舊版前端存別的機關、排序、物件衝突，都不會弄壞對開', async () => {
  const { db, call } = await setup();
  const split = (await call('u_admin', 'POST', `${P}/mechanisms`, SPLIT)).data.mechanism;
  const lift = (await call('u_admin', 'POST', `${P}/mechanisms`, { name: '中央升降台', kind: 'linear', travelMin: 0, travelMax: 3.5, objectIds: ['olift'] })).data.mechanism;
  // 舊版只看得到升降台：改它、排序（只送它的 id）
  assert.equal((await call('u_admin', 'PATCH', `${P}/mechanisms/${lift.id}`, { travelMax: 4 })).status, 200);
  assert.equal((await call('u_admin', 'POST', `${P}/mechanisms/reorder`, { ids: [lift.id] })).status, 200);
  const row = await db.prepare(`SELECT variant, mirror FROM mechanisms WHERE id = ?`).bind(split.id).first();
  assert.equal(row.variant, 'split');
  assert.ok(row.mirror);
  const sides = await db.prepare(`SELECT COUNT(*) AS n FROM mechanism_objects WHERE mechanism_id = ? AND side IS NOT NULL`).bind(split.id).first();
  assert.equal(sides.n, 4);
  // 舊版前端新增一個普通機關（不知道對開）→ 一般機關
  const plain = await call('u_admin', 'POST', `${P}/mechanisms`, { name: '布幕', kind: 'linear', travelMin: 0, travelMax: 2 });
  assert.equal(plain.status, 201);
  assert.equal(plain.data.mechanism.variant, null);
  // 舊版前端想把對開裡的物件拿去自己的機關 → 409（它看不到對開，但後台會說「已經在「對開 LED」裡」）
  const clash = await call('u_admin', 'PATCH', `${P}/mechanisms/${plain.data.mechanism.id}`, { objectIds: ['ol1'] });
  assert.equal(clash.status, 409);
  assert.equal(clash.data.conflicts[0].mechanismName, '對開 LED');
});

test('對開不能轉換 cue 位置（兩邊的物件動法不一樣）', async () => {
  const { call } = await setup();
  const split = (await call('u_admin', 'POST', `${P}/mechanisms`, SPLIT)).data.mechanism;
  const r = await call('u_admin', 'POST', `${P}/mechanisms/${split.id}/convert-cue-positions`, { dryRun: true });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, '對開的機關不能轉換 cue 位置（兩邊的物件動法不一樣）');
});

test('複製專案 / 匯出匯入：對開的 B 邊和每個物件的邊都跟著（新 id），翻轉的 metadata 也在', async () => {
  const { db, env, call } = await setup();
  await call('u_admin', 'POST', `${P}/mechanisms`, SPLIT);
  await call('u_admin', 'POST', `${P}/mechanisms`, FLIP);
  await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanisms/${(await loadMechanisms(env, 'p1'))[0].id}`, { value: 3, delaySec: 1 });

  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p2', '副本')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, category) VALUES ('p2ol1', 'p2', 'L1', 'led_panel'), ('p2or1', 'p2', 'R1', 'led_panel'), ('p2flip', 'p2', 'F', 'led_panel')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order") VALUES ('s2', 'p2', '開場', 0)`),
    db.prepare(`INSERT INTO cues (id, song_id, name, "order") VALUES ('p2c2', 's2', '開', 1)`),
  ]);
  const objMap = new Map([['ol1', 'p2ol1'], ['or1', 'p2or1'], ['oflip', 'p2flip']]);
  const cueMap = new Map([['c2', 'p2c2']]);
  const r = await copyMechanismsToProject(env, 'p1', 'p2', objMap, cueMap);
  assert.equal(r.mechanisms, 2);
  const copies = await loadMechanisms(env, 'p2');
  const split = copies.find(m => m.variant === 'split');
  assert.ok(split);
  assert.equal(split.name, '對開 LED');
  assert.deepEqual(split.mirror, { axis: { x: 1, y: 0, z: 0 }, pivot: null, consoleLabel: 'Axis 8' });
  assert.deepEqual(split.objectSides, { p2ol1: 'a', p2or1: 'b' });
  assert.deepEqual(copies.find(m => m.name === '翻板').metadata, { setup: { hinge: 'top', positive: 'first' } });
  const pos = await db.prepare(`SELECT value, delay_sec FROM cue_mechanism_positions WHERE cue_id = 'p2c2'`).first();
  assert.deepEqual({ ...pos }, { value: 3, delay_sec: 1 });

  // 匯出檔 → 匯入到第三個專案
  const exp = await exportMechanisms(env, 'p1');
  assert.ok(exp.mechanismObjects.some(o => o.side === 'b'));
  await db.prepare(`INSERT INTO projects (id, name) VALUES ('p3', '匯入')`).run();
  await db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, category) VALUES ('p3or1', 'p3', 'R1', 'led_panel'), ('p3ol1', 'p3', 'L1', 'led_panel')`).run();
  await importMechanisms(env, 'p3', exp, new Map([['or1', 'p3or1'], ['ol1', 'p3ol1']]), new Map());
  const imp = (await loadMechanisms(env, 'p3')).find(m => m.variant === 'split');
  assert.deepEqual(imp.objectSides, { p3ol1: 'a', p3or1: 'b' });
  assert.equal(imp.mirror.consoleLabel, 'Axis 8');

  // 舊的匯出檔（沒有 variant / mirror / side）照樣匯得進去，都是一般機關
  const old = {
    mechanisms: [{ id: 'm_old', name: '舊升降台', kind: 'linear', axis: '{"x":0,"y":1,"z":0}', travel_min: 0, travel_max: 2, default_value: 0, presets: '[]', "order": 0 }],
    mechanismObjects: [{ mechanism_id: 'm_old', stage_object_id: 'ol1' }], cueMechanismPositions: [],
  };
  await db.prepare(`INSERT INTO projects (id, name) VALUES ('p4', '舊檔')`).run();
  await db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, category) VALUES ('p4ol1', 'p4', 'L1', 'led_panel')`).run();
  assert.equal((await importMechanisms(env, 'p4', old, new Map([['ol1', 'p4ol1']]), new Map())).mechanisms, 1);
  const [oldM] = await loadMechanisms(env, 'p4');
  assert.equal(oldM.variant, null);
  assert.deepEqual(oldM.objectSides, {});
});

test('資料庫一列 → API：壞掉的 mirror 不會讓畫面掛掉', () => {
  const base = { id: 'm', name: 'x', kind: 'linear', axis: '{"x":1,"y":0,"z":0}', pivot: null, travel_min: 0, travel_max: 1, default_value: 0, max_speed: null, presets: '[]', parent_id: null, console_label: null, order: 0, metadata: null, updated_at: '' };
  assert.equal(rowToMechanism({ ...base, variant: 'split', mirror: 'not json' }, ['a']).mirror.axis.x, -1);   // 直線：反方向
  assert.equal(rowToMechanism({ ...base, variant: 'split', mirror: null }, ['a']).variant, 'split');
  assert.equal(rowToMechanism({ ...base, kind: 'rotary', variant: 'split', mirror: 'not json' }, ['a']).variant, null);   // 旋轉：當一般機關
  assert.equal(rowToMechanism({ ...base, variant: 'hoist' }, []).variant, null);
});
