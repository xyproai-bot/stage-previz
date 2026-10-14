// 跑法：cd cf-worker && npm test
// 機關 v2 第 3 階段（0031）：一排機關（一次建立 N 個、共用設定、解散 / 刪除）和一次寫很多個 cue 位置（花樣）。
// 走真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1）：
//   migration 0031 在舊資料上（兩個新欄位是空的 = 不在任何一排裡、舊版後台的 INSERT 照樣寫得進去、排被刪掉 → 機關留著）；
//   製作可以一次建立 / 改共用設定 / 解散 / 刪掉，導演 403；檢查（至少 2 個、名字重複、物件已經在別的機關 409）；
//   舊版前端（網址沒帶 ?mech=2）看到的是一個一個普通機關，回應沒有 groups；它存、排序、刪機關都不會弄壞排；
//   一次寫很多個 cue 位置：位置 + 延遲、夾進行程、null = 回到沿用、整批要嘛全寫要嘛都不動、上限；
//   複製專案 / 匯出匯入帶著一排（新 id），舊的匯出檔當一般機關。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, applyMigrations, freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import { loadMechanisms, loadMechanismGroups, copyMechanismsToProject, exportMechanisms, importMechanisms, rowToMechanism } from './mechanisms.mjs';

const BASE = 'https://proxy.test';
const P = '/api/projects/p1';

test('migration 0031：舊的機關兩個新欄位是空的；舊版後台的寫法照樣能寫；一排被刪掉機關留著', async () => {
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0031' });
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p', 'P')`),
    db.prepare(`INSERT INTO mechanisms (id, project_id, name, kind) VALUES ('m', 'p', '升降台', 'linear')`),
  ]);
  applyMigrations(db, { only: '0031' });
  const m = await db.prepare(`SELECT * FROM mechanisms`).first();
  assert.equal(m.group_id, null);
  assert.equal(m.group_index, null);
  // 舊版後台的 INSERT（明確欄位、沒有 group 欄位）
  await db.prepare(`INSERT INTO mechanisms (id, project_id, name, kind, axis, pivot, travel_min, travel_max, default_value, max_speed, presets, parent_id, console_label, "order", metadata, edited_at)
    VALUES ('m2', 'p', '轉台', 'rotary', '{"x":0,"y":1,"z":0}', '{"x":0,"y":0,"z":0}', -180, 180, 0, NULL, '[]', NULL, NULL, 1, NULL, datetime('now'))`).run();
  // 一排被刪 → 機關的 group_id 回到 NULL，機關本身留著
  await db.prepare(`INSERT INTO mechanism_groups (id, project_id, name) VALUES ('g', 'p', '一排')`).run();
  await db.prepare(`UPDATE mechanisms SET group_id = 'g', group_index = 0 WHERE id = 'm'`).run();
  await db.prepare(`DELETE FROM mechanism_groups WHERE id = 'g'`).run();
  const after = await db.prepare(`SELECT group_id FROM mechanisms WHERE id = 'm'`).first();
  assert.equal(after.group_id, null);
  // 專案刪掉 → 一排跟著刪
  await db.prepare(`INSERT INTO mechanism_groups (id, project_id, name) VALUES ('g2', 'p', '又一排')`).run();
  await db.prepare(`DELETE FROM projects WHERE id = 'p'`).run();
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM mechanism_groups`).first()).n, 0);
});

async function setup() {
  const db = freshDb();
  const users = [['u_admin', '製作', 'admin', 'ADMIN-1'], ['u_dir', '王導', 'director', 'DIR-1']];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, `${id}@x.test`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '巡演')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p2', '別的專案')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order") VALUES ('s1', 'p1', '開場', 0)`),
    db.prepare(`INSERT INTO cues (id, song_id, name, "order", status, video_time_sec, crossfade_seconds) VALUES
      ('c1', 's1', '關', 0, 'master', 0, 0), ('c2', 's1', '開', 1, 'master', 30, 5), ('c3', 's1', '收', 2, 'master', 60, 5)`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order") VALUES
      ('o1', 'p1', 'L1', 'LED 1', 'led_panel', 0), ('o2', 'p1', 'L2', 'LED 2', 'led_panel', 1),
      ('o3', 'p1', 'L3', 'LED 3', 'led_panel', 2), ('o4', 'p1', 'L4', 'LED 4', 'led_panel', 3),
      ('o5', 'p1', 'L5', 'LED 5', 'led_panel', 4), ('o6', 'p1', 'L6', 'LED 6', 'led_panel', 5),
      ('x1', 'p2', 'X1', '別的專案', 'led_panel', 0)`),
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

const BATCH = {
  base: { kind: 'linear', axis: { x: 0, y: 1, z: 0 }, travelMin: 0, travelMax: 3, maxSpeed: 0.5, defaultValue: 0 },
  objectIds: ['o1', 'o2', 'o3', 'o4'], namePrefix: 'LED 升降', groupName: 'LED 升降', numbering: 'leftToRight',
};

test('製作一次建立 4 個機關：名稱「LED 升降 1…4」、同一排、照順序編號；導演 403', async () => {
  const { db, call } = await setup();
  const denied = await call('u_dir', 'POST', `${P}/mechanisms/batch`, BATCH);
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error, '只有製作可以修改專案內容');

  const r = await call('u_admin', 'POST', `${P}/mechanisms/batch`, BATCH);
  assert.equal(r.status, 201);
  assert.equal(r.data.group.name, 'LED 升降');
  assert.deepEqual(r.data.group.settings, { namePrefix: 'LED 升降', numbering: 'leftToRight' });
  assert.deepEqual(r.data.mechanisms.map(m => m.name), ['LED 升降 1', 'LED 升降 2', 'LED 升降 3', 'LED 升降 4']);
  assert.deepEqual(r.data.mechanisms.map(m => m.groupIndex), [0, 1, 2, 3]);
  assert.deepEqual(r.data.mechanisms.map(m => m.objectIds), [['o1'], ['o2'], ['o3'], ['o4']]);
  for (const m of r.data.mechanisms) {
    assert.equal(m.groupId, r.data.group.id);
    assert.equal(m.variant, null);   // 一排裡每個都是普通機關
    assert.equal(m.travelMax, 3);
    assert.equal(m.maxSpeed, 0.5);
    assert.equal(m.consoleLabel, null);
  }
  // 順序號接在原本最後一個後面
  const orders = (await db.prepare(`SELECT "order" AS o FROM mechanisms ORDER BY "order"`).all()).results.map(x => x.o);
  assert.deepEqual(orders, [0, 1, 2, 3]);

  // 第二排接在後面、順序號繼續
  const second = await call('u_admin', 'POST', `${P}/mechanisms/batch`, { ...BATCH, objectIds: ['o5', 'o6'], namePrefix: '後排', groupName: undefined });
  assert.equal(second.status, 201);
  assert.equal(second.data.group.name, '後排');   // 沒給 groupName → 名稱開頭
  assert.equal(second.data.group.order, 1);
  assert.deepEqual(second.data.mechanisms.map(m => m.name), ['後排 1', '後排 2']);

  // 讀回來（新版）：機關 + 一排
  const list = await call('u_dir', 'GET', `${P}/mechanisms?mech=2`);
  assert.equal(list.data.mechanisms.length, 6);
  assert.deepEqual(list.data.groups.map(g => g.name), ['LED 升降', '後排']);
});

test('一次建立的檢查：至少 2 個、名字重複、物件不在這個專案、不能對開、開頭太長', async () => {
  const { call } = await setup();
  const post = (b) => call('u_admin', 'POST', `${P}/mechanisms/batch`, { ...BATCH, ...b });
  const one = await post({ objectIds: ['o1'] });
  assert.equal(one.status, 400);
  assert.equal(one.data.error, '一排至少要 2 個機關，請多選幾個物件');
  assert.equal((await post({ objectIds: ['o1', 'x1'] })).data.error, '有物件不在這個專案裡');
  assert.equal((await post({ namePrefix: '  ' })).data.field, 'namePrefix');
  assert.equal((await post({ namePrefix: '長'.repeat(40) })).data.field, 'namePrefix');
  const split = await post({ base: { ...BATCH.base, variant: 'split' } });
  assert.equal(split.status, 400);
  assert.equal(split.data.error, '一次建立的機關不能是對開，請一個一個設定');
  assert.equal((await post({ base: { ...BATCH.base, travelMax: -1 } })).data.field, 'travel');   // 行程錯 → 跟單獨新增同樣的訊息

  assert.equal((await post({})).status, 201);
  // 同樣的名字、同樣的排名再建一次
  const again = await post({ objectIds: ['o5', 'o6'] });
  assert.equal(again.status, 400);
  assert.equal(again.data.error, '這個專案已經有叫「LED 升降」的一排機關');
  // 排名不同，但機關名字「LED 升降 1」重複
  const dupName = await post({ objectIds: ['o5', 'o6'], groupName: '另一排' });
  assert.equal(dupName.status, 400);
  assert.equal(dupName.data.error, '這個專案已經有叫「LED 升降 1」的機關');
});

test('物件已經在別的機關 → 409，問過後帶 moveObjects 移過來（整批一起，要嘛全成功）', async () => {
  const { db, call } = await setup();
  const lift = (await call('u_admin', 'POST', `${P}/mechanisms`, { name: '舊升降', kind: 'linear', travelMin: 0, travelMax: 2, objectIds: ['o2'] })).data.mechanism;
  const r = await call('u_admin', 'POST', `${P}/mechanisms/batch`, BATCH);
  assert.equal(r.status, 409);
  assert.equal(r.data.conflicts[0].mechanismName, '舊升降');
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM mechanism_groups`).first()).n, 0);   // 什麼都沒建
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM mechanisms`).first()).n, 1);
  const moved = await call('u_admin', 'POST', `${P}/mechanisms/batch`, { ...BATCH, moveObjects: true });
  assert.equal(moved.status, 201);
  const objs = await db.prepare(`SELECT stage_object_id AS o FROM mechanism_objects WHERE mechanism_id = ?`).bind(lift.id).all();
  assert.equal(objs.results.length, 0);   // 物件被移走了
});

test('沿著邊緣翻的一排：每個物件有自己的轉軸（overrides），metadata 的邊緣選擇每個都在', async () => {
  const { call } = await setup();
  const r = await call('u_admin', 'POST', `${P}/mechanisms/batch`, {
    base: { kind: 'rotary', axis: { x: -1, y: 0, z: 0 }, pivot: { x: 0, y: 0, z: 0 }, travelMin: 0, travelMax: 90, metadata: { setup: { hinge: 'top', positive: 'first' } } },
    objectIds: ['o1', 'o2'], namePrefix: '翻板',
    overrides: { o1: { pivot: { x: 1, y: 3, z: 5 } }, o2: { pivot: { x: 2, y: 3, z: 5 } } },
  });
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.mechanisms.map(m => m.pivot), [{ x: 1, y: 3, z: 5 }, { x: 2, y: 3, z: 5 }]);
  assert.deepEqual(r.data.mechanisms.map(m => m.metadata), [{ setup: { hinge: 'top', positive: 'first' } }, { setup: { hinge: 'top', positive: 'first' } }]);
});

test('舊版前端（沒帶 ?mech=2）：看到一個一個普通機關、回應沒有 groups；它存、排序、刪機關都不會弄壞這一排', async () => {
  const { db, call } = await setup();
  const made = (await call('u_admin', 'POST', `${P}/mechanisms/batch`, BATCH)).data;
  const old = await call('u_admin', 'GET', `${P}/mechanisms`);
  assert.equal(old.data.groups, undefined);
  assert.equal(old.data.mechanisms.length, 4);
  // 舊版的 parseMechanism 只讀認得的欄位，多的欄位不會讓它掛掉；這裡確認舊欄位都還在
  const m1 = old.data.mechanisms[0];
  for (const k of ['id', 'name', 'kind', 'axis', 'pivot', 'travelMin', 'travelMax', 'defaultValue', 'maxSpeed', 'presets', 'parentId', 'objectIds', 'consoleLabel', 'order', 'metadata', 'cueCount', 'updatedAt']) {
    assert.ok(k in m1, k);
  }
  // 舊版存其中一個（它送的是完整的舊欄位）→ 還在這一排裡、物件不掉
  const patched = await call('u_admin', 'PATCH', `${P}/mechanisms/${m1.id}`, { name: '舊版改名', travelMax: 3.5, objectIds: m1.objectIds, consoleLabel: 'Axis 3' });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.mechanism.groupId, made.group.id);
  assert.equal(patched.data.mechanism.groupIndex, 0);
  // 舊版排序（只改 order）
  const ids = old.data.mechanisms.map(m => m.id).reverse();
  assert.equal((await call('u_admin', 'POST', `${P}/mechanisms/reorder`, { ids })).status, 200);
  const rows = (await db.prepare(`SELECT id, group_id, group_index FROM mechanisms ORDER BY "order"`).all()).results;
  assert.deepEqual(rows.map(r => r.group_index), [3, 2, 1, 0]);   // 排的編號不受排序影響
  assert.ok(rows.every(r => r.group_id === made.group.id));
  // 舊版刪掉一個 → 其他還在這一排；刪到最後一個 → 這一排也不留空殼
  assert.equal((await call('u_admin', 'DELETE', `${P}/mechanisms/${ids[0]}`)).status, 200);
  assert.equal((await loadMechanismGroups({ DB: db }, 'p1')).length, 1);
  for (const id of ids.slice(1)) await call('u_admin', 'DELETE', `${P}/mechanisms/${id}`);
  assert.equal((await loadMechanismGroups({ DB: db }, 'p1')).length, 0);
});

test('改共用設定：名字、行程、速度、常用位置一次套到每個成員；重名、行程錯、導演都擋', async () => {
  const { call } = await setup();
  const made = (await call('u_admin', 'POST', `${P}/mechanisms/batch`, BATCH)).data;
  const gid = made.group.id;
  for (const [i, m] of made.mechanisms.entries()) {
    await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanisms/${m.id}`, { value: i === 3 ? 3 : 1 });
  }
  assert.equal((await call('u_dir', 'PATCH', `/api/projects/p1/mechanism-groups/${gid}`, { name: 'x' })).status, 403);

  const r = await call('u_admin', 'PATCH', `${P}/mechanism-groups/${gid}`, {
    name: '舞台前緣', travelMax: 2, maxSpeed: 0.25, presets: [{ name: '全開', value: 2 }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.group.name, '舞台前緣');
  assert.ok(r.data.mechanisms.every(m => m.travelMax === 2 && m.maxSpeed === 0.25 && m.presets.length === 1));
  assert.equal(r.data.outOfRangeCount, 1);   // 有一個 cue 存了 3，超出新的行程 2（存的值不改，播放時夾住）
  assert.deepEqual(r.data.mechanisms.map(m => m.name), ['LED 升降 1', 'LED 升降 2', 'LED 升降 3', 'LED 升降 4']);   // 成員名字不跟著排名改

  assert.equal((await call('u_admin', 'PATCH', `${P}/mechanism-groups/${gid}`, { travelMax: -5 })).status, 400);
  assert.equal((await call('u_admin', 'PATCH', `${P}/mechanism-groups/${gid}`, { name: '  ' })).data.field, 'groupName');
  // 失敗不會改到一半
  const after = await call('u_admin', 'GET', `${P}/mechanisms?mech=2`);
  assert.ok(after.data.mechanisms.every(m => m.travelMax === 2));

  const other = (await call('u_admin', 'POST', `${P}/mechanisms/batch`, { ...BATCH, objectIds: ['o5', 'o6'], namePrefix: '後排' })).data;
  const clash = await call('u_admin', 'PATCH', `${P}/mechanism-groups/${other.group.id}`, { name: '舞台前緣' });
  assert.equal(clash.status, 400);
  assert.equal(clash.data.error, '這個專案已經有叫「舞台前緣」的一排機關');
  assert.equal((await call('u_admin', 'PATCH', `${P}/mechanism-groups/nope`, { name: 'x' })).status, 404);
});

test('解散只拆開這一排（機關、位置、時間都留著）；刪除一排連同機關和位置一起刪', async () => {
  const { db, call } = await setup();
  const a = (await call('u_admin', 'POST', `${P}/mechanisms/batch`, BATCH)).data;
  const b = (await call('u_admin', 'POST', `${P}/mechanisms/batch`, { ...BATCH, objectIds: ['o5', 'o6'], namePrefix: '後排', groupName: undefined })).data;
  await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanisms/${a.mechanisms[0].id}`, { value: 2, delaySec: 1.5 });
  await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanisms/${b.mechanisms[0].id}`, { value: 1 });

  assert.equal((await call('u_dir', 'DELETE', `${P}/mechanism-groups/${a.group.id}?dissolve=1`)).status, 403);
  const d = await call('u_admin', 'DELETE', `${P}/mechanism-groups/${a.group.id}?dissolve=1`);
  assert.equal(d.status, 200);
  assert.deepEqual(d.data, { ok: true, dissolved: true, mechanisms: 4 });
  const list = await call('u_admin', 'GET', `${P}/mechanisms?mech=2`);
  assert.equal(list.data.mechanisms.length, 6);
  assert.ok(list.data.mechanisms.filter(m => m.name.startsWith('LED 升降')).every(m => m.groupId === null && m.groupIndex === null));
  assert.deepEqual(list.data.groups.map(g => g.name), ['後排']);
  const pos = await db.prepare(`SELECT value, delay_sec FROM cue_mechanism_positions WHERE mechanism_id = ?`).bind(a.mechanisms[0].id).first();
  assert.deepEqual({ ...pos }, { value: 2, delay_sec: 1.5 });

  const del = await call('u_admin', 'DELETE', `${P}/mechanism-groups/${b.group.id}`);
  assert.equal(del.status, 200);
  assert.deepEqual(del.data, { ok: true, removedMechanisms: 2, removedPositions: 1 });
  assert.equal((await call('u_admin', 'GET', `${P}/mechanisms?mech=2`)).data.mechanisms.length, 4);
  assert.equal((await call('u_admin', 'DELETE', `${P}/mechanism-groups/${b.group.id}`)).status, 404);
});

test('一次寫很多個 cue 位置：位置 + 延遲一次寫好、夾進行程、null 回到沿用、沒放的欄位不改', async () => {
  const { db, call } = await setup();
  const made = (await call('u_admin', 'POST', `${P}/mechanisms/batch`, BATCH)).data.mechanisms;
  const put = (items, who = 'u_admin', cue = 'c2') => call(who, 'PUT', `${P}/songs/s1/cues/${cue}/mechanism-positions`, { items });

  assert.equal((await put([{ mechanismId: made[0].id, value: 1 }], 'u_dir')).status, 403);
  const r = await put([
    { mechanismId: made[0].id, value: 1, delaySec: null },
    { mechanismId: made[1].id, value: 2.5, delaySec: 0.5 },
    { mechanismId: made[2].id, value: 9, delaySec: 1 },          // 超出行程 → 夾到 3
    { mechanismId: made[3].id, value: 0, delaySec: 1.5 },
  ]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.items.map(i => i.value), [1, 2.5, 3, 0]);
  assert.deepEqual(r.data.items.map(i => i.clamped), [false, false, true, false]);
  assert.deepEqual(r.data.items.map(i => i.delaySec), [null, 0.5, 1, 1.5]);

  // 新版畫面讀回來：每個機關一列
  const list = await call('u_admin', 'GET', `${P}/songs/s1/mechanism-positions?mech=2`);
  assert.equal(list.data.positions.length, 4);
  assert.equal(list.data.positions.find(p => p.mechanismId === made[1].id).delaySec, 0.5);

  // 先給走幾秒，再用花樣只改位置和延遲 → 走幾秒不動（沒放 durationSec = 不改）
  await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanisms/${made[1].id}`, { durationSec: 8 });
  await put([{ mechanismId: made[1].id, value: 1, delaySec: 2 }]);
  const row = await db.prepare(`SELECT value, delay_sec, duration_sec FROM cue_mechanism_positions WHERE cue_id = 'c2' AND mechanism_id = ?`).bind(made[1].id).first();
  assert.deepEqual({ ...row }, { value: 1, delay_sec: 2, duration_sec: 8 });
  // delaySec 沒放 → 延遲不動
  await put([{ mechanismId: made[1].id, value: 2 }]);
  assert.equal((await db.prepare(`SELECT delay_sec FROM cue_mechanism_positions WHERE cue_id = 'c2' AND mechanism_id = ?`).bind(made[1].id).first()).delay_sec, 2);

  // 舊版前端的單筆寫法（只送 value）一樣不會動到時間
  await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanisms/${made[2].id}`, { value: 0.5 });
  assert.equal((await db.prepare(`SELECT delay_sec FROM cue_mechanism_positions WHERE cue_id = 'c2' AND mechanism_id = ?`).bind(made[2].id).first()).delay_sec, 1);

  // value: null → 刪掉這個 cue 自己的那一列（時間一起清掉），其他列不動
  const undo = await put([{ mechanismId: made[0].id, value: null }, { mechanismId: made[3].id, value: null }]);
  assert.deepEqual(undo.data.items, [{ mechanismId: made[0].id, removed: true }, { mechanismId: made[3].id, removed: true }]);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM cue_mechanism_positions WHERE cue_id = 'c2'`).first()).n, 2);
  // 復原：把花樣之前的樣子寫回去（延遲 / 走幾秒明確給 null 就是清掉）
  await put([{ mechanismId: made[1].id, value: 2.5, delaySec: null, durationSec: null }]);
  const back = await db.prepare(`SELECT delay_sec, duration_sec FROM cue_mechanism_positions WHERE cue_id = 'c2' AND mechanism_id = ?`).bind(made[1].id).first();
  assert.deepEqual({ ...back }, { delay_sec: null, duration_sec: null });
});

test('一次寫很多個：整批要嘛全寫要嘛都不動；機關不在專案、重複、太多、格式不對都 400', async () => {
  const { db, call } = await setup();
  const made = (await call('u_admin', 'POST', `${P}/mechanisms/batch`, BATCH)).data.mechanisms;
  await db.prepare(`INSERT INTO mechanisms (id, project_id, name, kind) VALUES ('mx', 'p2', '別的專案的機關', 'linear')`).run();
  const put = (body) => call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanism-positions`, body);
  const count = async () => Number((await db.prepare(`SELECT COUNT(*) AS n FROM cue_mechanism_positions`).first()).n);

  const foreign = await put({ items: [{ mechanismId: made[0].id, value: 1 }, { mechanismId: 'mx', value: 1 }] });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.data.error, '有機關不在這個專案裡');
  assert.equal(await count(), 0);   // 第一列也沒寫進去
  assert.equal((await put({ items: [{ mechanismId: made[0].id, value: 1 }, { mechanismId: made[0].id, value: 2 }] })).data.error, '同一個機關在這一次只能出現一次');
  assert.equal((await put({ items: [] })).status, 400);
  assert.equal((await put({})).status, 400);
  assert.equal((await put({ items: [{ mechanismId: made[0].id, value: 'abc' }] })).data.error, '位置要是數字');
  assert.equal((await put({ items: [{ mechanismId: made[0].id, value: 1, delaySec: 4000 }] })).data.error, '延遲要是 0 到 3600 秒，或留空跟著 cue');
  assert.equal((await put({ items: [{ mechanismId: made[0].id, value: 1, durationSec: -1 }] })).data.field, 'durationSec');
  const tooMany = Array.from({ length: 201 }, (_, i) => ({ mechanismId: `m${i}`, value: 0 }));
  assert.equal((await put({ items: tooMany })).data.error, '一次最多設定 200 個機關的位置');
  assert.equal(await count(), 0);
  // 別的 cue 不在這首歌 → 404（router 先擋）
  assert.equal((await call('u_admin', 'PUT', `${P}/songs/s1/cues/nope/mechanism-positions`, { items: [{ mechanismId: made[0].id, value: 1 }] })).status, 404);
  assert.equal((await call('u_admin', 'POST', `${P}/songs/s1/cues/c2/mechanism-positions`, { items: [] })).status, 405);
});

test('複製專案 / 匯出匯入：一排跟著（新 id、順序），舊的匯出檔當一般機關', async () => {
  const { db, env, call } = await setup();
  const made = (await call('u_admin', 'POST', `${P}/mechanisms/batch`, BATCH)).data;
  await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/mechanisms/${made.mechanisms[1].id}`, { value: 2, delaySec: 0.5 });

  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p3', '副本')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, category) VALUES ('p3o1', 'p3', 'L1', 'led_panel'), ('p3o2', 'p3', 'L2', 'led_panel'), ('p3o3', 'p3', 'L3', 'led_panel')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order") VALUES ('s3', 'p3', '開場', 0)`),
    db.prepare(`INSERT INTO cues (id, song_id, name, "order") VALUES ('p3c2', 's3', '開', 1)`),
  ]);
  // 只有 3 個物件有對應：第 4 個機關（o4）沒對到物件，一樣複製（物件對不到只是沒帶物件）
  const objMap = new Map([['o1', 'p3o1'], ['o2', 'p3o2'], ['o3', 'p3o3']]);
  const r = await copyMechanismsToProject(env, 'p1', 'p3', objMap, new Map([['c2', 'p3c2']]));
  assert.equal(r.mechanisms, 4);
  assert.equal(r.groups, 1);
  const copies = await loadMechanisms(env, 'p3');
  const gs = await loadMechanismGroups(env, 'p3');
  assert.equal(gs.length, 1);
  assert.notEqual(gs[0].id, made.group.id);
  assert.equal(gs[0].name, 'LED 升降');
  assert.deepEqual(gs[0].settings, { namePrefix: 'LED 升降', numbering: 'leftToRight' });
  assert.deepEqual(copies.map(m => [m.name, m.groupId === gs[0].id, m.groupIndex]), [
    ['LED 升降 1', true, 0], ['LED 升降 2', true, 1], ['LED 升降 3', true, 2], ['LED 升降 4', true, 3],
  ]);
  const pos = await db.prepare(`SELECT value, delay_sec FROM cue_mechanism_positions WHERE cue_id = 'p3c2'`).first();
  assert.deepEqual({ ...pos }, { value: 2, delay_sec: 0.5 });

  // 匯出檔多 mechanismGroups
  const exp = await exportMechanisms(env, 'p1');
  assert.equal(exp.mechanismGroups.length, 1);
  await db.prepare(`INSERT INTO projects (id, name) VALUES ('p4', '匯入')`).run();
  const imp = await importMechanisms(env, 'p4', exp, new Map(), new Map());
  assert.equal(imp.groups, 1);
  assert.equal((await loadMechanismGroups(env, 'p4')).length, 1);

  // 舊的匯出檔（沒有 mechanismGroups、機關列也沒有 group 欄位）→ 一般機關
  const old = {
    mechanisms: [{ id: 'm_old', name: '舊升降台', kind: 'linear', axis: '{"x":0,"y":1,"z":0}', travel_min: 0, travel_max: 2, default_value: 0, presets: '[]', order: 0 }],
    mechanismObjects: [], cueMechanismPositions: [],
  };
  await db.prepare(`INSERT INTO projects (id, name) VALUES ('p5', '舊檔')`).run();
  const oldR = await importMechanisms(env, 'p5', old, new Map(), new Map());
  assert.equal(oldR.mechanisms, 1);
  assert.equal(oldR.groups, 0);
  const [oldM] = await loadMechanisms(env, 'p5');
  assert.equal(oldM.groupId, null);
  assert.equal(oldM.groupIndex, null);

  // 匯出檔裡指到不存在的一排 → 當一般機關，不會因為外鍵掛掉
  const dangling = { ...old, mechanisms: [{ ...old.mechanisms[0], group_id: 'ghost', group_index: 2 }] };
  await db.prepare(`INSERT INTO projects (id, name) VALUES ('p6', '壞檔')`).run();
  assert.equal((await importMechanisms(env, 'p6', dangling, new Map(), new Map())).mechanisms, 1);
  assert.equal((await loadMechanisms(env, 'p6'))[0].groupId, null);
});

test('資料庫一列 → API：沒有 group 欄位的舊資料讀成不在任何一排裡', () => {
  const base = { id: 'm', name: 'x', kind: 'linear', axis: '{"x":0,"y":1,"z":0}', pivot: null, travel_min: 0, travel_max: 1, default_value: 0, max_speed: null, presets: '[]', parent_id: null, console_label: null, order: 0, metadata: null, updated_at: '' };
  assert.equal(rowToMechanism(base, []).groupId, null);
  assert.equal(rowToMechanism(base, []).groupIndex, null);
  const g = rowToMechanism({ ...base, group_id: 'g1', group_index: 2 }, []);
  assert.equal(g.groupId, 'g1');
  assert.equal(g.groupIndex, 2);
  assert.equal(rowToMechanism({ ...base, group_id: 'g1', group_index: null }, []).groupIndex, null);
});
