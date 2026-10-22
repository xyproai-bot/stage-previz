// 跑法：cd cf-worker && npm test
// Cue 庫第 4 階段：舊的編輯方式在 Cue 庫專案照樣能改（規格 4.2 相容寫入表每一列），加上複製 / 匯出 / 匯入專案（4.4）。
// 測資用後台路由建，再用搬家程式把專案切成 Cue 庫模式（跟 cueLibraryRoutes.test.mjs 一樣）。舊模式專案的行為由原本的測試守著。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './testing/d1-sqlite.mjs';
import worker from './worker.js';
import { loadExportDb, runMigration } from './scripts/migrate-cue-library.mjs';

const BASE = 'https://proxy.test';
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

function dumpSql(raw) {
  const out = [];
  const objs = raw.prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`).all();
  for (const o of objs.filter(o => o.type === 'table')) out.push(o.sql + ';');
  for (const o of objs.filter(o => o.type === 'table')) {
    for (const r of raw.prepare(`SELECT * FROM "${o.name}"`).all()) {
      const cols = Object.keys(r);
      out.push(`INSERT OR REPLACE INTO "${o.name}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(c => q(r[c])).join(', ')});`);
    }
  }
  for (const o of objs.filter(o => o.type === 'index')) out.push(o.sql + ';');
  return out.join('\n');
}

function client(db) {
  const env = { DB: db, AUTH_SECRET: 'test-secret' };
  let token = null;
  const call = async (method, path, body) => {
    if (!token) {
      const login = await worker.fetch(new Request(`${BASE}/api/auth/login`, { method: 'POST', body: JSON.stringify({ accessCode: 'ADMIN-1' }), headers: { 'content-type': 'application/json' } }), env);
      token = (await login.json()).token;
    }
    const r = await worker.fetch(new Request(BASE + path, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    let data = null;
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data };
  };
  return { call };
}

async function build() {
  const db = freshDb();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_admin', 'a@x.test', '製作', 'admin', 'ADMIN-1')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '巡演'), ('p2', '舊模式的專案')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", code) VALUES ('s1', 'p1', '開場曲', 0, 'S01'), ('s2', 'p1', '安可', 1, 'S02'), ('z1', 'p2', '別的歌', 0, 'Z1')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order", default_hidden) VALUES
      ('o_a', 'p1', 'A', '主牆', 'led_panel', 0, 0), ('o_b', 'p1', 'B', '側牆', 'led_panel', 1, 0),
      ('o_hid', 'p1', 'RIBBON', '緞帶', 'other', 2, 1), ('o_c', 'p1', 'LIFT', '升降台', 'other', 3, 0), ('o_e', 'p1', 'E', '會被轉換的', 'other', 4, 0),
      ('z_a', 'p2', 'A', '主牆', 'other', 0, 0), ('z_lift', 'p2', 'LIFT', '升降台', 'other', 1, 0)`),
  ]);
  const { call } = client(db);
  const P = '/api/projects/p1';
  const mk = async (song, name, extra = {}) => { const r = await call('POST', `${P}/songs/${song}/cues`, { name, ...extra }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; };
  const state = async (song, cue, obj, body) => assert.ok([200, 201].includes((await call('PUT', `${P}/songs/${song}/cues/${cue}/states/${obj}`, body)).status));
  const mech = async (body) => { const r = await call('POST', `${P}/mechanisms`, body); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.mechanism.id; };
  const pos = async (song, cue, m, body) => assert.ok([200, 201].includes((await call('PUT', `${P}/songs/${song}/cues/${cue}/mechanisms/${m}`, body)).status));
  const m1 = await mech({ name: '升降台', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, travelMin: 0, travelMax: 3, defaultValue: 0, objectIds: ['o_c'] });
  const m2 = await mech({ name: '轉盤', kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: 0, y: 0, z: 0 }, travelMin: 0, travelMax: 90, defaultValue: 10, objectIds: [] });
  const c1 = await mk('s1', '開場');
  const c2 = await mk('s1', '副歌');
  const c3 = await mk('s1', '間奏');
  const d1 = await mk('s2', '安可開場');
  await state('s1', c1, 'o_a', { position: { x: 1, y: 2, z: 3 } });
  await state('s1', c2, 'o_a', { visible: false });
  await state('s1', c2, 'o_b', { position: { x: 5, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } });
  await state('s1', c3, 'o_hid', { visible: true });
  await state('s2', d1, 'o_a', { position: { x: 9, y: 9, z: 9 } });
  await pos('s1', c1, m1, { value: 1, delaySec: 2, durationSec: 3 });
  await pos('s1', c2, m1, { value: 2.5 });
  await pos('s1', c3, m2, { value: 45, delaySec: 0.5 });
  // 舊模式的專案 p2（不搬）
  await db.batch([
    db.prepare(`INSERT INTO cues (id, song_id, name, "order", status) VALUES ('zc1', 'z1', 'Z 開場', 0, 'master')`),
    db.prepare(`INSERT INTO cue_object_states (id, cue_id, stage_object_id, position) VALUES ('cos_z', 'zc1', 'z_a', '{"x":4,"y":4,"z":4}')`),
  ]);
  const mig = loadExportDb(dumpSql(db.raw));
  const { report } = await runMigration(mig, { projectId: 'p1' });
  assert.equal(report.totalDifferences, 0);
  return { db: mig, legacy: db, ids: { c1, c2, c3, d1, m1, m2 } };
}

const lib = (db, cueId) => db.raw.prepare(`SELECT l.* FROM library_cues l JOIN cues c ON c.library_cue_id = l.id WHERE c.id = ?`).get(cueId);
const objRows = (db, lcId) => db.raw.prepare(`SELECT * FROM library_cue_object_states WHERE library_cue_id = ? ORDER BY stage_object_id`).all(lcId);
const mechRows = (db, lcId) => db.raw.prepare(`SELECT * FROM library_cue_mechanism_positions WHERE library_cue_id = ? ORDER BY mechanism_id`).all(lcId);
const legacyCount = (db) => db.raw.prepare(`SELECT (SELECT COUNT(*) FROM cue_object_states) a, (SELECT COUNT(*) FROM cue_mechanism_positions) b`).get();
const P = '/api/projects/p1';

test('PUT/DELETE cues/:c/states/:o：只改這個 cue 指到的 Cue 庫的 cue，不沿用到後面，舊的表不動', async () => {
  const { db, ids } = await build();
  const { call } = client(db);
  const before = legacyCount(db);
  const l3 = lib(db, ids.c3);
  const l3Before = JSON.stringify(objRows(db, l3.id));
  // c1 改一個物件的位置
  const r = await call('PUT', `${P}/songs/s1/cues/${ids.c1}/states/o_b`, { position: { x: 7, y: 7, z: 7 } });
  assert.equal(r.status, 201);
  const r2 = await call('PUT', `${P}/songs/s1/cues/${ids.c1}/states/o_b`, { rotation: { pitch: 1, yaw: 2, roll: 3 } });
  assert.equal(r2.status, 200);
  const st = (await call('GET', `${P}/songs/s1/cues/${ids.c1}/states`)).data.states.find(s => s.objectId === 'o_b');
  assert.deepEqual(st.effective.position, { x: 7, y: 7, z: 7 });
  assert.deepEqual(st.effective.rotation, { pitch: 1, yaw: 2, roll: 3 });
  assert.equal(st.override.position.x, 7);
  // 後面的 cue（c2、c3）完全沒有被影響（沒有沿用）
  assert.equal(JSON.stringify(objRows(db, l3.id)), l3Before);
  const c3b = (await call('GET', `${P}/songs/s1/cues/${ids.c3}/states`)).data.states.find(s => s.objectId === 'o_b');
  assert.deepEqual(c3b.effective.position, { x: 5, y: 0, z: 0 });   // 搬家時帶過來的值，沒有被這次的修改改到
  // 舊的表沒動
  assert.deepEqual(legacyCount(db), before);
  // rev 有加
  assert.ok(lib(db, ids.c1).rev >= 2);
  // 只送 visible
  assert.equal((await call('PUT', `${P}/songs/s1/cues/${ids.c1}/states/o_hid`, { visible: true })).status, 201);
  assert.equal((await call('GET', `${P}/songs/s1/cues/${ids.c1}/states`)).data.states.find(s => s.objectId === 'o_hid').effective.visible, true);
  // 什麼都沒送 → noop
  assert.equal((await call('PUT', `${P}/songs/s1/cues/${ids.c1}/states/o_b`, {})).data.noop, true);
  // DELETE → 回到預設（不是沿用）
  const del = await call('DELETE', `${P}/songs/s1/cues/${ids.c1}/states/o_b`);
  assert.equal(del.data.removed, 1);
  assert.equal((await call('GET', `${P}/songs/s1/cues/${ids.c1}/states`)).data.states.find(s => s.objectId === 'o_b').override, null);
  assert.equal((await call('DELETE', `${P}/songs/s1/cues/${ids.c1}/states/o_b`)).data.removed, 0);
});

test('搬家帶過來「沿用」的列：自己改其中一個欄位，其他欄位的值保留，改的欄位變成自己設的', async () => {
  const { db, ids } = await build();
  const { call } = client(db);
  // c3（間奏）原本沿用 c2 的 o_b 位置和大小 → 搬家後是 own=0 的列
  const before = objRows(db, lib(db, ids.c3).id).find(r => r.stage_object_id === 'o_b');
  assert.equal(before.own, 0);
  await call('PUT', `${P}/songs/s1/cues/${ids.c3}/states/o_b`, { rotation: { pitch: 5, yaw: 0, roll: 0 } });
  const after = objRows(db, lib(db, ids.c3).id).find(r => r.stage_object_id === 'o_b');
  assert.equal(after.own, 1);
  assert.equal(after.own_fields, 2);            // 只有角度算自己設的
  assert.equal(after.position, before.position); // 沿用來的位置保留
  const st = (await call('GET', `${P}/songs/s1/cues/${ids.c3}/states`)).data.states.find(s => s.objectId === 'o_b');
  assert.deepEqual(st.effective.position, { x: 5, y: 0, z: 0 });
  assert.equal(st.override.rotation.pitch, 5);
  assert.equal(st.override.position, null);
});

test('POST cues/:c/reset：Cue 庫的 cue 的物件和機關列全部刪掉', async () => {
  const { db, ids } = await build();
  const { call } = client(db);
  const l = lib(db, ids.c1);
  assert.ok(objRows(db, l.id).length > 0 && mechRows(db, l.id).length > 0);
  const r = await call('POST', `${P}/songs/s1/cues/${ids.c1}/reset`);
  assert.equal(r.status, 200);
  assert.ok(r.data.removed > 0 && r.data.removedMechanismPositions > 0);
  assert.equal(objRows(db, l.id).length, 0);
  assert.equal(mechRows(db, l.id).length, 0);
  // 其他 cue 不受影響
  assert.ok(objRows(db, lib(db, ids.c2).id).length > 0);
  const pos = (await call('GET', `${P}/songs/s1/mechanism-positions?mech=3&cuelib=1`)).data;
  assert.equal(pos.mode, 'library');
  assert.ok(!pos.positions.some(p => p.cueId === ids.c1));
});

test('機關位置 PUT / DELETE / 一批：寫進 Cue 庫的 cue，PUT 之後是自己設的（carried = 0），時間規則跟以前一樣', async () => {
  const { db, ids } = await build();
  const { call } = client(db);
  const M = (cue, m) => `${P}/songs/s1/cues/${cue}/mechanisms/${m}`;
  const before = legacyCount(db);
  // c2 的 m1 是搬家時從 c1 帶過來的？不是：c2 自己設了 2.5。c3 的 m1 沿用 → carried = 1
  const l3 = lib(db, ids.c3);
  assert.equal(mechRows(db, l3.id).find(r => r.mechanism_id === ids.m1).carried, 1);
  // 只送時間：這個 cue 對這個機關是沿用 → 400
  const t = await call('PUT', M(ids.c3, ids.m1), { delaySec: 1 });
  assert.equal(t.status, 400);
  // 送位置：變成自己設的
  const p = await call('PUT', M(ids.c3, ids.m1), { value: 2, delaySec: 1, durationSec: 2 });
  assert.equal(p.status, 200);
  assert.equal(p.data.value, 2); assert.equal(p.data.delaySec, 1);
  const row = mechRows(db, l3.id).find(r => r.mechanism_id === ids.m1);
  assert.deepEqual([row.value, row.carried, row.delay_sec, row.duration_sec], [2, 0, 1, 2]);
  // 只送時間：現在可以
  const t2 = await call('PUT', M(ids.c3, ids.m1), { durationSec: 5 });
  assert.equal(t2.data.durationSec, 5); assert.equal(t2.data.delaySec, 1);
  // 超出行程 → 夾進去
  const big = await call('PUT', M(ids.c3, ids.m1), { value: 99 });
  assert.equal(big.data.value, 3); assert.equal(big.data.clamped, true);
  // 其他 cue 沒動
  assert.equal(mechRows(db, lib(db, ids.c2).id).find(r => r.mechanism_id === ids.m1).value, 2.5);
  // 一批：寫 m2、刪 m1
  const bulk = await call('PUT', `${P}/songs/s1/cues/${ids.c3}/mechanism-positions`, { items: [{ mechanismId: ids.m2, value: 30, delaySec: 0 }, { mechanismId: ids.m1, value: null }] });
  assert.equal(bulk.status, 200);
  assert.deepEqual(bulk.data.items.map(i => !!i.removed), [false, true]);
  assert.equal(mechRows(db, l3.id).find(r => r.mechanism_id === ids.m1), undefined);
  assert.equal(mechRows(db, l3.id).find(r => r.mechanism_id === ids.m2).value, 30);
  const bad = await call('PUT', `${P}/songs/s1/cues/${ids.c3}/mechanism-positions`, { items: [{ mechanismId: 'nope', value: 1 }] });
  assert.equal(bad.status, 400);
  // DELETE：刪掉這一列（回到預設，不是沿用）
  const d = await call('DELETE', M(ids.c3, ids.m2));
  assert.equal(d.data.removed, 1);
  assert.equal(mechRows(db, l3.id).length, 0);
  assert.deepEqual(legacyCount(db), before);
  // 舊前端（不帶 ?cuelib=1）只看到自己設的列
  const stale = (await call('GET', `${P}/songs/s1/mechanism-positions?mech=3`)).data;
  assert.ok(stale.positions.every(x => !('carried' in x)));
});

test('POST cues 舊格式：blank / cloneFrom / snapshotStates + snapshotMechanisms / fromTemplateId 都建 Cue 庫的 cue，編號接在最大的後面', async () => {
  const { db, ids } = await build();
  const { call } = client(db);
  const legacyBefore = legacyCount(db);
  const labelsBefore = db.raw.prepare(`SELECT label FROM library_cues WHERE project_id = 'p1'`).all().map(r => r.label);
  const maxLabel = Math.max(...labelsBefore.map(Number));
  // blank：複製前一個 cue（c3，這首歌最後一個）的畫面，全部標成沿用
  const blank = await call('POST', `${P}/songs/s1/cues`, { name: '空白' });
  const lb = lib(db, blank.data.id);
  assert.equal(lb.label, String(maxLabel + 1)); assert.equal(lb.name, '空白');
  const prevRows = objRows(db, lib(db, ids.c3).id);
  const bRows = objRows(db, lb.id);
  assert.equal(bRows.length, prevRows.length);
  assert.ok(bRows.every(r => r.own === 0 && r.own_fields === 0));
  assert.ok(mechRows(db, lb.id).every(r => r.carried === 1 && r.delay_sec === null));
  // 畫面跟前一個 cue 一樣
  const sA = (await call('GET', `${P}/songs/s1/cues/${blank.data.id}/states`)).data.states;
  const sB = (await call('GET', `${P}/songs/s1/cues/${ids.c3}/states`)).data.states;
  assert.deepEqual(sA.map(s => s.effective), sB.map(s => s.effective));
  // cloneFrom：完整複製 c2，其中 c2 自己設的仍是自己設的
  const cl = await call('POST', `${P}/songs/s2/cues`, { name: '複製副歌', cloneFrom: ids.c2 });
  const lc = lib(db, cl.data.id);
  assert.notEqual(lc.id, lib(db, ids.c2).id);
  assert.equal(JSON.stringify(objRows(db, lc.id).map(({ library_cue_id, updated_at, ...r }) => r)),
    JSON.stringify(objRows(db, lib(db, ids.c2).id).map(({ library_cue_id, updated_at, ...r }) => r)));
  assert.equal(JSON.stringify(mechRows(db, lc.id).map(({ library_cue_id, updated_at, ...r }) => r)),
    JSON.stringify(mechRows(db, lib(db, ids.c2).id).map(({ library_cue_id, updated_at, ...r }) => r)));
  // snapshotStates + snapshotMechanisms：自己設的列（顯示 = 1）
  const sn = await call('POST', `${P}/songs/s2/cues`, {
    name: '快照', snapshotStates: [{ objectId: 'o_a', position: { x: 3, y: 3, z: 3 } }, { objectId: 'z_a', position: { x: 1, y: 1, z: 1 } }],
    snapshotMechanisms: { [ids.m1]: 1.5, nope: 3 },
  });
  const ls = lib(db, sn.data.id);
  const sr = objRows(db, ls.id);
  assert.equal(sr.length, 1);                       // 別的專案的物件略過
  assert.deepEqual([sr[0].own, sr[0].visible, sr[0].own_fields], [1, 1, OWN_P_V]);
  assert.deepEqual(mechRows(db, ls.id).map(r => [r.mechanism_id, r.value, r.carried]), [[ids.m1, 1.5, 0]]);
  // fromTemplateId：先從 c2 存成常用擺位，再套用
  const tpl = await call('POST', `${P}/cue-templates`, { name: '副歌擺位', fromCueId: ids.c2 });
  assert.equal(tpl.status, 201);
  const ap = await call('POST', `${P}/songs/s2/cues`, { name: '套用', fromTemplateId: tpl.data.id });
  const la = lib(db, ap.data.id);
  const ar = objRows(db, la.id);
  const c2rows = objRows(db, lib(db, ids.c2).id);
  assert.equal(ar.length, c2rows.length);
  const aSt = (await call('GET', `${P}/songs/s2/cues/${ap.data.id}/states`)).data.states;
  const c2St = (await call('GET', `${P}/songs/s1/cues/${ids.c2}/states`)).data.states;
  // 位置 / 角度 / 大小一樣；顯示用範本裡有的值
  assert.deepEqual(aSt.map(s => [s.effective.position, s.effective.rotation, s.effective.scale, s.effective.visible]),
    c2St.map(s => [s.effective.position, s.effective.rotation, s.effective.scale, s.effective.visible]));
  assert.deepEqual(mechRows(db, la.id).map(r => [r.mechanism_id, r.value]), mechRows(db, lib(db, ids.c2).id).map(r => [r.mechanism_id, r.value]));
  // 編號都不重複
  const labels = db.raw.prepare(`SELECT label FROM library_cues WHERE project_id = 'p1'`).all().map(r => r.label.toLowerCase());
  assert.equal(new Set(labels).size, labels.length);
  // 沒有寫舊的表
  assert.deepEqual(legacyCount(db), legacyBefore);
});
const OWN_P_V = 1 | 8;

test('cue-object-states 清單 / 清掉 / 寫回：作用在這首歌用到的 Cue 庫的 cue，清單多 shared，寫回可以用 libraryCueId 或 cueId', async () => {
  const { db, ids } = await build();
  const { call } = client(db);
  // 讓 s2 也用 c2 的 Cue 庫的 cue（共用）
  const l2 = lib(db, ids.c2);
  db.raw.prepare(`UPDATE cues SET library_cue_id = ? WHERE id = ?`).run(l2.id, ids.d1);
  const list = (await call('GET', `${P}/songs/s1/cue-object-states`)).data;
  assert.equal(list.cueCount, 3);
  const l1 = lib(db, ids.c1), l3 = lib(db, ids.c3);
  const want = [l1.id, l2.id, l3.id].flatMap(id => objRows(db, id).map(r => `${id}|${r.stage_object_id}`)).sort();
  assert.deepEqual(list.states.map(s => `${s.libraryCueId}|${s.objectId}`).sort(), want);
  assert.ok(list.states.every(s => typeof s.cueId === 'string'));
  assert.deepEqual(list.shared.map(s => [s.libraryCueId, s.songs.map(x => x.id)]), [[l2.id, ['s2']]]);
  // 清掉 → 回傳被清掉的內容
  const clear = await call('POST', `${P}/songs/s1/cue-object-states/clear`);
  assert.equal(clear.data.removed, want.length);
  for (const id of [l1.id, l2.id, l3.id]) assert.equal(objRows(db, id).length, 0);
  assert.ok(objRows(db, lib(db, ids.d1).id).length === 0); // 共用的那個也清掉了（別首歌看得到）
  const cleared = (await call('GET', `${P}/songs/s1/cues/${ids.c2}/states`)).data.states;
  assert.ok(cleared.every(s => s.override === null && !s.tracked));
  // 寫回（原樣）→ 一樣
  const rest = await call('POST', `${P}/songs/s1/cue-object-states/restore`, { states: clear.data.states });
  assert.equal(rest.data.restored, want.length);
  const after = [l1.id, l2.id, l3.id].flatMap(id => objRows(db, id).map(r => `${id}|${r.stage_object_id}|${r.own}|${r.own_fields}`)).sort();
  assert.equal(after.length, want.length);
  // 用 cueId（舊格式，沒有 libraryCueId / own）寫回
  await call('POST', `${P}/songs/s1/cue-object-states/clear`);
  const legacyShape = clear.data.states.map(({ libraryCueId, own, ownFields, ...rest }) => rest);
  const rest2 = await call('POST', `${P}/songs/s1/cue-object-states/restore`, { states: legacyShape });
  assert.equal(rest2.data.restored, want.length);
  assert.equal(objRows(db, l2.id).length, clear.data.states.filter(s => s.libraryCueId === l2.id).length);
  // 不在這首歌的 cue → 404
  const nf = await call('POST', `${P}/songs/s1/cue-object-states/restore`, { states: [{ cueId: 'nope', objectId: 'o_a', position: null, rotation: null, scale: null, visible: null, customProps: null }] });
  assert.equal(nf.status, 404);
  // 回到舊模式專案，行為不變（p2 沒有 shared）
  const z = (await client(db).call('GET', '/api/projects/p2/songs/z1/cue-object-states')).data;
  assert.ok(!('shared' in z));
});

test('常用擺位（cue-templates）：從 slot 或 Cue 庫的 cue 存，內容是 Cue 庫的 cue 的完整畫面', async () => {
  const { db, ids } = await build();
  const { call } = client(db);
  const l3 = lib(db, ids.c3);
  const a = await call('POST', `${P}/cue-templates`, { name: '從 slot', fromCueId: ids.c3 });
  const b = await call('POST', `${P}/cue-templates`, { name: '從 Cue 庫', fromLibraryCueId: l3.id });
  assert.equal(a.status, 201); assert.equal(b.status, 201);
  const tpls = (await call('GET', `${P}/cue-templates`)).data.templates;
  const pa = tpls.find(t => t.id === a.data.id).payload, pb = tpls.find(t => t.id === b.data.id).payload;
  assert.deepEqual(pa.snapshotStates, pb.snapshotStates);
  assert.deepEqual(pa.mechanismPositions, pb.mechanismPositions);
  // 完整畫面：包含沿用來的列（c3 沿用的 o_b）和顯示 / 隱藏
  assert.equal(pa.snapshotStates.length, objRows(db, l3.id).length);
  assert.ok(pa.snapshotStates.some(s => s.meshName === 'B' && s.position.x === 5));
  assert.ok(pa.snapshotStates.some(s => s.meshName === 'RIBBON' && s.visible === true));
  assert.ok(pa.mechanismPositions.some(m => m.name === '轉盤' && m.value === 45 && m.delaySec === 0.5));
  // 別的專案的 Cue 庫 cue 不行
  db.raw.exec(`INSERT INTO library_cues (id, project_id, label, name) VALUES ('lc_other', 'p2', '1', 'x')`);
  assert.equal((await call('POST', `${P}/cue-templates`, { name: 'x', fromLibraryCueId: 'lc_other' })).status, 404);
  assert.equal((await call('POST', `${P}/cue-templates`, { name: 'x' })).status, 400);
});

test('機關：刪掉機關回報的 removedPositions 數 Cue 庫的列；convert-cue-positions 作用在 Cue 庫的 cue', async () => {
  const { db, ids } = await build();
  const { call } = client(db);
  // 新機關 m3 帶 o_e；兩個 Cue 庫的 cue 的 o_e 被擺高了（一個自己設的、一個沿用來的）
  const m3 = (await call('POST', `${P}/mechanisms`, { name: '新升降', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, travelMin: 0, travelMax: 5, defaultValue: 0, objectIds: ['o_e'] })).data.mechanism.id;
  await call('PUT', `${P}/songs/s1/cues/${ids.c1}/states/o_e`, { position: { x: 0, y: 2, z: 0 } });
  const l2 = lib(db, ids.c2);
  db.raw.prepare(`INSERT INTO library_cue_object_states (library_cue_id, stage_object_id, position, own, own_fields) VALUES (?, 'o_e', '{"x":0,"y":3,"z":0}', 0, 0)`).run(l2.id);
  const dry = await call('POST', `${P}/mechanisms/${m3}/convert-cue-positions`, { dryRun: true });
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.equal(dry.data.converted, 2);
  const run = await call('POST', `${P}/mechanisms/${m3}/convert-cue-positions`, {});
  assert.equal(run.status, 200);
  const r1 = mechRows(db, lib(db, ids.c1).id).find(r => r.mechanism_id === m3);
  const r2 = mechRows(db, l2.id).find(r => r.mechanism_id === m3);
  assert.deepEqual([r1.value, r1.carried], [2, 0]);
  assert.deepEqual([r2.value, r2.carried], [3, 1]);      // 來源物件的列是沿用的 → 位置也標成沿用
  // 轉完畫面一樣：機關位置 + 物件剩下的位置 = 原來的高度
  const st = (await call('GET', `${P}/songs/s1/cues/${ids.c1}/states`)).data.states.find(s => s.objectId === 'o_e');
  assert.equal(st.effective.position.y, 0);
  // 已經有 cue 設過位置 → 不能再轉
  assert.equal((await call('POST', `${P}/mechanisms/${m3}/convert-cue-positions`, {})).status, 409);
  // 刪機關：removedPositions 是 Cue 庫的列數
  const list = (await call('GET', `${P}/mechanisms?mech=3`)).data.mechanisms;
  assert.equal(list.find(m => m.id === ids.m1).cueCount, 3);
  const del = await call('DELETE', `${P}/mechanisms/${ids.m1}`);
  assert.equal(del.data.removedPositions, 3);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM library_cue_mechanism_positions WHERE mechanism_id = ?`).get(ids.m1).n, 0);
});

// 一個專案現在的樣子（用名稱，不用 id）：每首歌每個 cue 的名稱、編號、物件狀態、機關位置
async function view(db, project) {
  const { call } = client(db);
  const P_ = `/api/projects/${project}`;
  const mechs = (await call('GET', `${P_}/mechanisms?mech=3`)).data.mechanisms;
  const mname = new Map(mechs.map(m => [m.id, m.name]));
  const out = [];
  const songs = (await call('GET', `${P_}/songs`)).data.songs;
  for (const s of songs) {
    const cues = (await call('GET', `${P_}/songs/${s.id}/cues`)).data.cues;
    const pos = (await call('GET', `${P_}/songs/${s.id}/mechanism-positions?mech=3&cuelib=1`)).data;
    const list = [];
    for (const c of cues) {
      const states = (await call('GET', `${P_}/songs/${s.id}/cues/${c.id}/states`)).data.states;
      list.push({
        name: c.name, order: c.order, video: c.videoTimeSec, label: c.libraryCue?.label ?? null, libName: c.libraryCue?.name ?? null,
        states: states.map(x => [x.meshName, x.effective, x.override && { ...x.override, updatedAt: null }, x.tracked]),
        mech: pos.positions.filter(p => p.cueId === c.id).map(p => [mname.get(p.mechanismId), p.value, p.delaySec, p.durationSec, p.carried ?? null]).sort(),
      });
    }
    out.push({ song: s.name, cues: list });
  }
  return { out, mechs: mechs.map(m => [m.name, m.cueCount]), mode: (await call('GET', P_)).data.project.cueLibrary };
}

test('複製 Cue 庫專案：新專案也是 Cue 庫，內容跟來源一樣；舊的表在副本裡是空的；Cue 庫的 id 全部是新的', async () => {
  const { db, ids } = await build();
  const { call } = client(db);
  // 讓一個 Cue 庫的 cue 被兩首歌共用，並有備註 / based_on
  const l2 = lib(db, ids.c2);
  db.raw.prepare(`UPDATE cues SET library_cue_id = ? WHERE id = ?`).run(l2.id, ids.d1);
  db.raw.prepare(`UPDATE library_cues SET note = '備註', based_on_id = ? WHERE id = ?`).run(lib(db, ids.c1).id, l2.id);
  const dup = await call('POST', `${P}/duplicate`, { newName: '副本' });
  assert.equal(dup.status, 201, JSON.stringify(dup.data));
  const nid = dup.data.id;
  const a = await view(db, 'p1'), b = await view(db, nid);
  assert.equal(b.mode, true);
  assert.equal(JSON.stringify(b.out), JSON.stringify(a.out));
  assert.equal(JSON.stringify(b.mechs), JSON.stringify(a.mechs));
  // 內部：沒有共用舊 id；共用關係保留；note / based_on 跟著；舊的表是空的
  const src = db.raw.prepare(`SELECT id FROM library_cues WHERE project_id = 'p1'`).all().map(r => r.id);
  const dst = db.raw.prepare(`SELECT * FROM library_cues WHERE project_id = ?`).all(nid);
  assert.equal(dst.length, src.length);
  assert.ok(dst.every(l => !src.includes(l.id)));
  const dl2 = dst.find(l => l.note === '備註');
  assert.ok(dl2 && dst.some(l => l.id === dl2.based_on_id));
  const shared = db.raw.prepare(`SELECT COUNT(*) n FROM cues c JOIN songs s ON s.id = c.song_id WHERE s.project_id = ? AND c.library_cue_id = ?`).get(nid, dl2.id).n;
  assert.equal(shared, 2);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM cue_object_states cos JOIN cues c ON c.id = cos.cue_id JOIN songs s ON s.id = c.song_id WHERE s.project_id = ?`).get(nid).n, 0);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM cue_mechanism_positions p JOIN cues c ON c.id = p.cue_id JOIN songs s ON s.id = c.song_id WHERE s.project_id = ?`).get(nid).n, 0);
  // 改副本不影響來源
  const nc = (await call('GET', `/api/projects/${nid}/songs`)).data.songs[0];
  const ncue = (await call('GET', `/api/projects/${nid}/songs/${nc.id}/cues`)).data.cues[0];
  await call('PUT', `/api/projects/${nid}/songs/${nc.id}/cues/${ncue.id}/states/${db.raw.prepare(`SELECT id FROM stage_objects WHERE project_id = ? AND mesh_name = 'B'`).get(nid).id}`, { visible: false });
  assert.equal(JSON.stringify((await view(db, 'p1')).out), JSON.stringify(a.out));
  // 舊模式的專案複製：照舊（不是 Cue 庫）
  const dz = await call('POST', `/api/projects/p2/duplicate`, {});
  assert.equal(dz.status, 201);
  assert.equal((await call('GET', `/api/projects/${dz.data.id}`)).data.project.cueLibrary, false);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM library_cues WHERE project_id = ?`).get(dz.data.id).n, 0);
});

test('匯出 / 匯入：Cue 庫專案匯出 v2、匯入後內容一樣；舊模式專案還是 v1', async () => {
  const { db, ids } = await build();
  const { call } = client(db);
  db.raw.prepare(`UPDATE cues SET library_cue_id = ? WHERE id = ?`).run(lib(db, ids.c2).id, ids.d1);
  const raw = db.raw;
  const exp = await call('GET', `${P}/export`);
  assert.equal(exp.status, 200);
  const file = exp.data;
  assert.equal(file.schemaVersion, 2);
  assert.equal(file.project.cueLibrary, true);
  assert.equal(file.libraryCues.length, raw.prepare(`SELECT COUNT(*) n FROM library_cues WHERE project_id = 'p1'`).get().n);
  assert.ok(file.libraryCueObjectStates.length > 0 && file.libraryCueMechanismPositions.length > 0);
  assert.ok(file.cues.every(c => 'library_cue_id' in c));
  const imp = await call('POST', '/api/projects/import', { ...file, newName: '匯入的' });
  assert.equal(imp.status, 201, JSON.stringify(imp.data));
  const a = await view(db, 'p1'), b = await view(db, imp.data.id);
  assert.equal(b.mode, true);
  assert.equal(JSON.stringify(b.out), JSON.stringify(a.out));
  assert.equal(JSON.stringify(b.mechs), JSON.stringify(a.mechs));
  assert.equal(raw.prepare(`SELECT COUNT(*) n FROM cue_object_states cos JOIN cues c ON c.id = cos.cue_id JOIN songs s ON s.id = c.song_id WHERE s.project_id = ?`).get(imp.data.id).n, 0);
  // 舊模式專案：還是 v1，沒有 Cue 庫欄位
  const z = (await call('GET', '/api/projects/p2/export')).data;
  assert.equal(z.schemaVersion, 1);
  assert.ok(!('libraryCues' in z) && !z.project.cueLibrary);
});

test('匯入舊格式（v1）：目標是 Cue 庫模式就烤成 Cue 庫（畫面跟舊算法一樣），不然照舊', async () => {
  // 舊模式的來源專案（搬家前）匯出 v1
  const { legacy, ids } = await build();
  const lc = client(legacy);
  const v1 = (await lc.call('GET', `${P}/export`)).data;
  assert.equal(v1.schemaVersion, 1);
  // 目標：另一個資料庫（還沒搬）。不指定 → 舊模式，照舊匯入
  const t = await build();      // 取一個乾淨的資料庫環境，匯入到 t.db
  const { call } = client(t.db);
  const plain = await call('POST', '/api/projects/import', { ...v1, newName: '舊格式照舊' });
  assert.equal(plain.status, 201);
  assert.equal((await call('GET', `/api/projects/${plain.data.id}`)).data.project.cueLibrary, false);
  // 指定 Cue 庫 → 烤成 Cue 庫
  const baked = await call('POST', '/api/projects/import', { ...v1, newName: '烤成 Cue 庫', cueLibrary: true });
  assert.equal(baked.status, 201, JSON.stringify(baked.data));
  const a = await view(t.db, plain.data.id), b = await view(t.db, baked.data.id);
  assert.equal(b.mode, true);
  const strip = (v) => v.out.map(s => ({ song: s.song, cues: s.cues.map(c => ({ name: c.name, order: c.order, states: c.states.map(([m, eff]) => [m, eff]), mech: c.mech.map(([n, val, d, du]) => [n, val, d, du]) })) }));
  // 每個 cue 實際看到的畫面和機關位置（值 / 時間）跟舊算法一樣
  const toEff = (v) => v.out.map(s => s.cues.map(c => c.states.map(([m, eff]) => [m, eff])));
  assert.equal(JSON.stringify(toEff(b)), JSON.stringify(toEff(a)));
  assert.ok(strip(b).length === strip(a).length);
  assert.ok(b.out.every(s => s.cues.every(c => c.label !== null)));
  const labels = t.db.raw.prepare(`SELECT label FROM library_cues WHERE project_id = ?`).all(baked.data.id).map(r => r.label);
  assert.ok(labels.includes('1'));
  // app_settings 的「新專案用 Cue 庫」打開 → 不指定也烤
  t.db.raw.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('cue_library_new_projects', '1')`).run();
  const auto = await call('POST', '/api/projects/import', { ...v1, newName: '設定打開' });
  assert.equal((await call('GET', `/api/projects/${auto.data.id}`)).data.project.cueLibrary, true);
  assert.ok(ids.c1);
});

test('import-cues：同一個專案 → 新的 cue 指到來源歌的 Cue 庫的 cue；別的專案 → 複製成這個專案新的 Cue 庫的 cue（物件按 mesh 名稱、機關按名稱）', async () => {
  const { db, ids } = await build();
  const { call } = client(db);
  // 先加一首空的歌
  const s3 = (await call('POST', `${P}/songs`, { name: '第三首' })).data;
  const sid = s3.id || s3.song?.id;
  const same = await call('POST', `${P}/songs/${sid}/import-cues`, { fromSongId: 's1' });
  assert.equal(same.status, 201, JSON.stringify(same.data));
  const cuesA = (await call('GET', `${P}/songs/s1/cues`)).data.cues;
  const cuesB = (await call('GET', `${P}/songs/${sid}/cues`)).data.cues;
  assert.deepEqual(cuesB.map(c => c.libraryCueId), cuesA.map(c => c.libraryCueId));
  assert.deepEqual(cuesB.map(c => c.name), cuesA.map(c => c.name));
  // 同一個 Cue 庫的 cue 被兩首歌用：改其中一首的 cue，另一首也看到（Cue 庫的設計）
  await call('PUT', `${P}/songs/${sid}/cues/${cuesB[0].id}/states/o_b`, { visible: false });
  assert.equal((await call('GET', `${P}/songs/s1/cues/${cuesA[0].id}/states`)).data.states.find(s => s.objectId === 'o_b').effective.visible, false);
  // 別的專案（舊模式的 p2）→ p1
  const before = db.raw.prepare(`SELECT COUNT(*) n FROM library_cues WHERE project_id = 'p1'`).get().n;
  const cross = await call('POST', `${P}/songs/${sid}/import-cues`, { fromSongId: 'z1' });
  assert.equal(cross.status, 201, JSON.stringify(cross.data));
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM library_cues WHERE project_id = 'p1'`).get().n, before + 1);
  const last = (await call('GET', `${P}/songs/${sid}/cues`)).data.cues.find(c => c.name === 'Z 開場');
  assert.equal(last.libraryCue.name, 'Z 開場');
  const st = (await call('GET', `${P}/songs/${sid}/cues/${last.id}/states`)).data.states.find(s => s.objectId === 'o_a');
  assert.deepEqual(st.effective.position, { x: 4, y: 4, z: 4 });
  // replace：只拿掉這首歌的 cue，Cue 庫的 cue 留著
  const rep = await call('POST', `${P}/songs/${sid}/import-cues`, { fromSongId: 's2', replace: true });
  assert.equal(rep.status, 201);
  assert.equal((await call('GET', `${P}/songs/${sid}/cues`)).data.cues.length, 1);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM library_cues WHERE project_id = 'p1'`).get().n, before + 1);
});

test('舊模式專案：寫入行為不變（不會碰 Cue 庫的表）', async () => {
  const { db } = await build();
  const { call } = client(db);
  const before = db.raw.prepare(`SELECT COUNT(*) n FROM library_cues`).get().n;
  const r = await call('PUT', `/api/projects/p2/songs/z1/cues/zc1/states/z_a`, { visible: false });
  assert.ok([200, 201].includes(r.status));
  assert.equal(db.raw.prepare(`SELECT visible FROM cue_object_states WHERE cue_id = 'zc1' AND stage_object_id = 'z_a'`).get().visible, 0);
  const n = await call('POST', `/api/projects/p2/songs/z1/cues`, { name: '新的' });
  assert.equal(n.status, 201);
  assert.equal(db.raw.prepare(`SELECT library_cue_id FROM cues WHERE id = ?`).get(n.data.id).library_cue_id, null);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM library_cues`).get().n, before);
  assert.equal((await call('POST', `/api/projects/p2/songs/z1/cues/zc1/reset`)).status, 200);
});
