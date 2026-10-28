// 跑法：cd cf-worker && npm test
// 機關「沿弧形軌道」（0047；variant arc + arc_radius 公尺）。走真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1）：
//   migration 0047 在舊資料上（arc_radius 是空的 = 一般機關、舊版後台的 INSERT 照樣寫得進去）；
//   0030 的 variant 欄位有 CHECK 不收 'arc' → 資料庫裡弧形機關是 variant = NULL + arc_radius，API 讀出來才是 variant 'arc'；
//   製作新增 / 修改 / 改回直線（半徑和圓心清掉）；檢查（只能用在直線、要圓心、半徑 0~1000）；
//   舊版前端（網址沒帶 ?mech）讀得到它、當一般直線，不會壞；弧形可以當別的機關的上層；不能轉換 cue 位置；
//   複製專案 / 匯出匯入帶著半徑和圓心（新 id）；舊的匯出檔（沒有 arc_radius）照樣匯得進去。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, applyMigrations, freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import {
  loadMechanisms, rowToMechanism, inputToColumns, copyMechanismsToProject, exportMechanisms, importMechanisms,
} from './mechanisms.mjs';

const BASE = 'https://proxy.test';
const P = '/api/projects/p1';

test('migration 0047：舊的機關 arc_radius 是空的（= 一般機關）；舊版後台的寫法照樣能寫；新欄位寫得進去', async () => {
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0047' });
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p', 'P')`),
    db.prepare(`INSERT INTO mechanisms (id, project_id, name, kind) VALUES ('m', 'p', '升降台', 'linear')`),
  ]);
  applyMigrations(db, { only: '0047' });
  assert.equal((await db.prepare(`SELECT arc_radius FROM mechanisms WHERE id = 'm'`).first()).arc_radius, null);
  // 舊版後台的 INSERT（明確欄位、沒有 arc_radius）照樣寫得進去
  await db.prepare(`INSERT INTO mechanisms (id, project_id, name, kind, axis, pivot, travel_min, travel_max, default_value, max_speed, presets, parent_id, console_label, "order", metadata, edited_at)
    VALUES ('m2', 'p', '滑軌', 'linear', '{"x":1,"y":0,"z":0}', NULL, -3, 3, 0, NULL, '[]', NULL, NULL, 1, NULL, datetime('now'))`).run();
  const [old] = await loadMechanisms({ DB: db }, 'p', 'm2');
  assert.equal(old.variant, null);
  assert.equal(old.arcRadius, null);
  assert.equal(old.pivot, null);
  // 新欄位：實數
  await db.prepare(`UPDATE mechanisms SET arc_radius = 12.5 WHERE id = 'm2'`).run();
  assert.equal((await db.prepare(`SELECT arc_radius FROM mechanisms WHERE id = 'm2'`).first()).arc_radius, 12.5);
});

test('rowToMechanism / inputToColumns：弧形 = variant 空 + arc_radius；圓心存在 pivot；壞資料當一般直線', () => {
  const row = {
    id: 'a', name: '橫移', kind: 'linear', axis: '{"x":0,"y":-1,"z":0}', pivot: '{"x":0,"y":0,"z":10}', travel_min: -30, travel_max: 30,
    default_value: 0, max_speed: null, presets: '[]', parent_id: null, console_label: null, order: 0, metadata: null, updated_at: 'x',
    variant: null, arc_radius: 5,
  };
  const m = rowToMechanism(row, ['o1']);
  assert.equal(m.variant, 'arc');
  assert.equal(m.arcRadius, 5);
  assert.deepEqual(m.pivot, { x: 0, y: 0, z: 10 });
  assert.deepEqual(m.axis, { x: 0, y: -1, z: 0 });
  // 半徑 0 / 沒填 / 不是數字 → 一般直線（不會壞）
  for (const bad of [null, 0, -2, 'abc']) {
    const g = rowToMechanism({ ...row, arc_radius: bad });
    assert.equal(g.variant, null, String(bad));
    assert.equal(g.arcRadius, null);
    assert.equal(g.pivot, null);
  }
  // 沒有圓心 → 一般直線
  assert.equal(rowToMechanism({ ...row, pivot: null }).variant, null);
  assert.equal(rowToMechanism({ ...row, pivot: 'not json' }).variant, null);
  // 旋轉機關 / 對開 / 吊掛帶了半徑也不當弧形
  assert.equal(rowToMechanism({ ...row, kind: 'rotary' }).variant, null);
  assert.equal(rowToMechanism({ ...row, kind: 'rotary' }).arcRadius, null);
  assert.equal(rowToMechanism({ ...row, variant: 'hoist_rig' }).variant, 'hoist_rig');
  assert.equal(rowToMechanism({ ...row, variant: 'hoist_rig' }).arcRadius, null);
  assert.equal(rowToMechanism({ ...row, variant: 'split', mirror: '{"axis":{"x":0,"y":1,"z":0}}' }).arcRadius, null);

  // 寫進資料庫：variant 一定是 NULL（0030 的 CHECK 不收 'arc'）
  const c = inputToColumns({
    name: '橫移', kind: 'linear', axis: { x: 0, y: -1, z: 0 }, pivot: { x: 0, y: 0, z: 10 }, travelMin: -30, travelMax: 30, defaultValue: 0,
    maxSpeed: null, presets: [], parentId: null, objectIds: [], consoleLabel: null, metadata: null, variant: 'arc', mirror: null,
    objectSides: {}, arcRadius: 5,
  });
  assert.equal(c.variant, null);
  assert.equal(c.arc_radius, 5);
  assert.equal(c.pivot, JSON.stringify({ x: 0, y: 0, z: 10 }));
  // 不是弧形：半徑和直線的圓心都清掉
  const plain = inputToColumns({ ...{ name: 'x', kind: 'linear', axis: { x: 1, y: 0, z: 0 }, pivot: { x: 1, y: 1, z: 1 }, travelMin: 0, travelMax: 1, defaultValue: 0,
    maxSpeed: null, presets: [], parentId: null, objectIds: [], consoleLabel: null, metadata: null, variant: null, mirror: null, objectSides: {} }, arcRadius: 9 });
  assert.equal(plain.arc_radius, null);
  assert.equal(plain.pivot, null);
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
      ('c1', 's1', '合', 0, 'master', 0, 0), ('c2', 's1', '開', 1, 'master', 30, 5)`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order") VALUES
      ('oa', 'p1', 'A', '旋轉 LED 1', 'led_panel', 0), ('ob', 'p1', 'B', '旋轉 LED 2', 'led_panel', 1), ('oc', 'p1', 'C', '別的板', 'led_panel', 2)`),
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

const ARC = {
  name: '橫移 1', kind: 'linear', variant: 'arc', axis: { x: 0, y: -1, z: 0 }, pivot: { x: 0, y: 0, z: 10 }, arcRadius: 20,
  travelMin: -30, travelMax: 30, objectIds: ['oa'],
};

async function createArc(call, body = ARC) {
  const r = await call('u_admin', 'POST', `${P}/mechanisms`, body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.mechanism;
}

test('製作新增弧形機關：讀回來半徑 / 圓心 / 轉軸一樣；資料庫 variant 是空的、arc_radius 有值；導演 403', async () => {
  const { db, call } = await setup();
  const denied = await call('u_dir', 'POST', `${P}/mechanisms`, ARC);
  assert.equal(denied.status, 403);

  const m = await createArc(call);
  assert.equal(m.variant, 'arc');
  assert.equal(m.kind, 'linear');
  assert.equal(m.arcRadius, 20);
  assert.deepEqual(m.pivot, { x: 0, y: 0, z: 10 });
  assert.deepEqual(m.axis, { x: 0, y: -1, z: 0 });
  assert.deepEqual(m.objectIds, ['oa']);
  assert.equal(m.travelMax, 30);
  assert.deepEqual(m.objectSides, {});
  assert.equal(m.mirror, null);
  const row = await db.prepare(`SELECT variant, arc_radius, pivot, kind FROM mechanisms WHERE id = ?`).bind(m.id).first();
  assert.deepEqual({ ...row }, { variant: null, arc_radius: 20, pivot: JSON.stringify({ x: 0, y: 0, z: 10 }), kind: 'linear' });

  // 列表（新版畫面 ?mech=3）也讀得到
  const list = await call('u_dir', 'GET', `${P}/mechanisms?mech=3`);
  assert.equal(list.status, 200);
  assert.equal(list.data.mechanisms[0].variant, 'arc');
  assert.equal(list.data.mechanisms[0].arcRadius, 20);
  // cue 的位置（公尺）照一般直線機關存、夾進行程
  const put = await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanisms/${m.id}`, { value: 45 });
  assert.equal(put.status, 200);
  assert.equal((await db.prepare(`SELECT value FROM cue_mechanism_positions WHERE mechanism_id = ?`).bind(m.id).first()).value, 30);
});

test('舊版前端（網址沒帶 ?mech）也讀得到弧形機關：是一般的直線機關，欄位多了不會壞', async () => {
  const { call } = await setup();
  const m = await createArc(call);
  const oldList = await call('u_dir', 'GET', `${P}/mechanisms`);
  assert.equal(oldList.status, 200);
  const got = oldList.data.mechanisms.find(x => x.id === m.id);
  assert.ok(got, '舊版前端要讀得到（資料庫裡 variant 是空的）');
  assert.equal(got.kind, 'linear');
  assert.equal(got.travelMax, 30);
  assert.deepEqual(got.objectIds, ['oa']);
  // 舊版畫面只認得 split / hoist，其他的 variant 都當一般機關 → 這裡只確認舊欄位原樣在
  assert.deepEqual(got.axis, { x: 0, y: -1, z: 0 });
  assert.equal(oldList.data.groups, undefined);
});

test('檢查：只能用在直線、要圓心、半徑要在 0 到 1000 公尺之間；錯誤訊息和欄位跟著回', async () => {
  const { call, db } = await setup();
  const cases = [
    [{ ...ARC, kind: 'rotary', travelMin: -90, travelMax: 90 }, '沿弧形軌道只能用在直線機關', 'variant'],
    [{ ...ARC, pivot: null }, '沿弧形軌道要設圓心', 'pivot'],
    [{ ...ARC, arcRadius: 0 }, '軌道半徑要在 0 到 1000 公尺之間', 'arcRadius'],
    [{ ...ARC, arcRadius: -5 }, '軌道半徑要在 0 到 1000 公尺之間', 'arcRadius'],
    [{ ...ARC, arcRadius: 1001 }, '軌道半徑要在 0 到 1000 公尺之間', 'arcRadius'],
    [{ ...ARC, arcRadius: 'abc' }, '軌道半徑要在 0 到 1000 公尺之間', 'arcRadius'],
    [{ ...ARC, arcRadius: undefined }, '軌道半徑要在 0 到 1000 公尺之間', 'arcRadius'],
  ];
  for (const [body, msg, field] of cases) {
    const r = await call('u_admin', 'POST', `${P}/mechanisms`, body);
    assert.equal(r.status, 400, msg);
    assert.equal(r.data.error, msg);
    assert.equal(r.data.field, field);
  }
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM mechanisms`).first()).n, 0);
});

test('修改：改半徑；改回直線 → 半徑和圓心清掉；一般直線改成弧形要一起送圓心和半徑；旋轉不能改成弧形', async () => {
  const { call, db } = await setup();
  const m = await createArc(call);
  const r1 = await call('u_admin', 'PATCH', `${P}/mechanisms/${m.id}`, { arcRadius: 8 });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.mechanism.arcRadius, 8);
  assert.equal(r1.data.mechanism.variant, 'arc');
  assert.deepEqual(r1.data.mechanism.pivot, { x: 0, y: 0, z: 10 });
  assert.equal((await db.prepare(`SELECT arc_radius FROM mechanisms WHERE id = ?`).bind(m.id).first()).arc_radius, 8);
  // 半徑壞掉：原本的不動
  const bad = await call('u_admin', 'PATCH', `${P}/mechanisms/${m.id}`, { arcRadius: 0 });
  assert.equal(bad.status, 400);
  assert.equal((await db.prepare(`SELECT arc_radius FROM mechanisms WHERE id = ?`).bind(m.id).first()).arc_radius, 8);
  // 改回直線：半徑、圓心清掉，物件還在
  const back = await call('u_admin', 'PATCH', `${P}/mechanisms/${m.id}`, { variant: null, axis: { x: 1, y: 0, z: 0 } });
  assert.equal(back.status, 200);
  assert.equal(back.data.mechanism.variant, null);
  assert.equal(back.data.mechanism.arcRadius, null);
  assert.equal(back.data.mechanism.pivot, null);
  assert.deepEqual(back.data.mechanism.objectIds, ['oa']);
  assert.deepEqual({ ...(await db.prepare(`SELECT variant, arc_radius, pivot FROM mechanisms WHERE id = ?`).bind(m.id).first()) }, { variant: null, arc_radius: null, pivot: null });
  // 一般直線改成弧形：沒送圓心 → 要圓心；一起送 → 通過
  const noPivot = await call('u_admin', 'PATCH', `${P}/mechanisms/${m.id}`, { variant: 'arc', arcRadius: 6 });
  assert.equal(noPivot.status, 400);
  assert.equal(noPivot.data.error, '沿弧形軌道要設圓心');
  const again = await call('u_admin', 'PATCH', `${P}/mechanisms/${m.id}`, { variant: 'arc', arcRadius: 6, pivot: { x: 1, y: 0, z: 2 }, axis: { x: 0, y: 1, z: 0 } });
  assert.equal(again.status, 200);
  assert.equal(again.data.mechanism.arcRadius, 6);
  assert.deepEqual(again.data.mechanism.pivot, { x: 1, y: 0, z: 2 });
  // 弧形改成旋轉 → 不行
  const rot = await call('u_admin', 'PATCH', `${P}/mechanisms/${m.id}`, { kind: 'rotary' });
  assert.equal(rot.status, 400);
  assert.equal(rot.data.error, '沿弧形軌道只能用在直線機關');
  // 弧形不能改成吊掛 / 對開的邏輯照舊：吊掛不能從一般機關換過去
  const toHoist = await call('u_admin', 'PATCH', `${P}/mechanisms/${m.id}`, { variant: 'hoist_rig' });
  assert.equal(toHoist.status, 400);
});

test('弧形可以當別的機關的上層（旋轉 LED 的自轉裝在橫移上），也可以裝在一般機關上；資料庫的 variant 欄位一直是空的', async () => {
  const { call, db } = await setup();
  const arc = await createArc(call);
  const spin = await call('u_admin', 'POST', `${P}/mechanisms`, {
    name: '自轉 1', kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: 0, y: 0, z: -10 }, travelMin: -360, travelMax: 360, parentId: arc.id, objectIds: ['ob'],
  });
  assert.equal(spin.status, 201, JSON.stringify(spin.data));
  assert.equal(spin.data.mechanism.parentId, arc.id);
  const lift = (await call('u_admin', 'POST', `${P}/mechanisms`, { name: '升降台', kind: 'linear', travelMin: 0, travelMax: 3 })).data.mechanism;
  const arc2 = await call('u_admin', 'POST', `${P}/mechanisms`, { ...ARC, name: '橫移 2', objectIds: ['oc'], parentId: lift.id });
  assert.equal(arc2.status, 201, JSON.stringify(arc2.data));
  assert.equal(arc2.data.mechanism.parentId, lift.id);
  // 把一般機關改成弧形（它底下裝著別的機關）也行
  const toArc = await call('u_admin', 'PATCH', `${P}/mechanisms/${lift.id}`, { variant: 'arc', pivot: { x: 0, y: 0, z: 0 }, arcRadius: 3 });
  assert.equal(toArc.status, 200, JSON.stringify(toArc.data));
  assert.equal(await db.prepare(`SELECT COUNT(*) AS n FROM mechanisms WHERE variant IS NOT NULL`).first().then(r => r.n), 0);
});

test('弧形不能轉換 cue 位置（走的是圓弧，不是直線）', async () => {
  const { call } = await setup();
  const m = await createArc(call);
  const r = await call('u_admin', 'POST', `${P}/mechanisms/${m.id}/convert-cue-positions`, { dryRun: true });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, '沿弧形軌道的機關不能轉換 cue 位置（走的是圓弧，不是直線）');
});

test('複製專案 / 匯出匯入：弧形的半徑、圓心、轉軸帶著走（新 id）；位置也在；舊的匯出檔（沒有 arc_radius）照樣匯得進去', async () => {
  const { db, env, call } = await setup();
  const arc = await createArc(call);
  const spin = (await call('u_admin', 'POST', `${P}/mechanisms`, {
    name: '自轉 1', kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: 0, y: 0, z: -10 }, travelMin: -360, travelMax: 360, parentId: arc.id, objectIds: ['ob'],
  })).data.mechanism;
  await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanisms/${arc.id}`, { value: 12, delaySec: 1 });

  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p2', '副本')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, category) VALUES ('p2oa', 'p2', 'A', 'led_panel'), ('p2ob', 'p2', 'B', 'led_panel')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order") VALUES ('s2', 'p2', '開場', 0)`),
    db.prepare(`INSERT INTO cues (id, song_id, name, "order") VALUES ('p2c2', 's2', '開', 1)`),
  ]);
  const r = await copyMechanismsToProject(env, 'p1', 'p2', new Map([['oa', 'p2oa'], ['ob', 'p2ob']]), new Map([['c2', 'p2c2']]));
  assert.equal(r.mechanisms, 2);
  const copies = await loadMechanisms(env, 'p2');
  const narc = copies.find(m => m.variant === 'arc');
  assert.ok(narc && narc.id !== arc.id);
  assert.equal(narc.arcRadius, 20);
  assert.deepEqual(narc.pivot, { x: 0, y: 0, z: 10 });
  assert.deepEqual(narc.axis, { x: 0, y: -1, z: 0 });
  assert.deepEqual(narc.objectIds, ['p2oa']);
  const nspin = copies.find(m => m.kind === 'rotary');
  assert.equal(nspin.parentId, narc.id);
  assert.notEqual(nspin.id, spin.id);
  const pos = await db.prepare(`SELECT mechanism_id, value, delay_sec FROM cue_mechanism_positions WHERE cue_id = 'p2c2'`).first();
  assert.deepEqual({ ...pos }, { mechanism_id: narc.id, value: 12, delay_sec: 1 });
  // 原本專案的沒被動到
  assert.equal((await loadMechanisms(env, 'p1')).find(m => m.id === arc.id).arcRadius, 20);

  // 匯出檔 → 匯入到第三個專案
  const exp = await exportMechanisms(env, 'p1');
  const expArc = exp.mechanisms.find(m => m.id === arc.id);
  assert.equal(expArc.arc_radius, 20);
  assert.equal(expArc.variant, null);
  await db.prepare(`INSERT INTO projects (id, name) VALUES ('p3', '匯入')`).run();
  await db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, category) VALUES ('p3oa', 'p3', 'A', 'led_panel')`).run();
  assert.equal((await importMechanisms(env, 'p3', exp, new Map([['oa', 'p3oa']]), new Map())).mechanisms, 2);
  const imp = (await loadMechanisms(env, 'p3')).find(m => m.variant === 'arc');
  assert.equal(imp.arcRadius, 20);
  assert.deepEqual(imp.pivot, { x: 0, y: 0, z: 10 });
  assert.deepEqual(imp.objectIds, ['p3oa']);

  // 舊的匯出檔：機關列沒有 arc_radius 這個欄位 → 一般直線
  const oldExp = { ...exp, mechanisms: exp.mechanisms.map(({ arc_radius, ...rest }) => rest) };
  await db.prepare(`INSERT INTO projects (id, name) VALUES ('p4', '舊檔')`).run();
  assert.equal((await importMechanisms(env, 'p4', oldExp, new Map(), new Map())).mechanisms, 2);
  const old = await loadMechanisms(env, 'p4');
  assert.ok(old.every(m => m.variant === null && m.arcRadius === null));
});
