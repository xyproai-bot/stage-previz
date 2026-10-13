// 跑法：cd cf-worker && npm test
// 用 Node 內建的 node:sqlite 做一個跟 D1 一樣的資料庫：把 migrations 全部跑一次，
// 檢查 0023 把舊的機關滑桿轉成機關的結果 = 前端 legacyOffsetsToMechanisms、重跑不會多、刪物件 / 刪 cue 會一起清掉；
// 再測後台的機關 API（新增 / 修改 / 刪除、每個 cue 的位置、舊滑桿同步、轉換）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { legacyOffsetsToMechanisms } from '../web/src/lib/mechanisms/model.ts';
import {
  rowToMechanism, findObjectConflicts, conflictMessage, inputToColumns,
  loadMechanisms, createMechanism, updateMechanism, deleteMechanism, reorderMechanisms,
  putCuePosition, deleteCuePosition, loadSongPositions, mechanismSheet, syncLegacyMechanismOffsets,
  copyMechanismsToProject, exportMechanisms, cloneCuePositions, snapshotCuePositions, templateMechanismPositions,
  applyNamedPositions, clearCuePositions, countMechanismObjects, convertCuePositions,
} from './mechanisms.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, 'migrations');
const migrationFiles = readdirSync(MIGRATIONS).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort();
const upTo = (n) => migrationFiles.filter(f => Number(f.slice(0, 4)) <= n);

function freshDb(lastMigration = 22) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const f of upTo(lastMigration)) db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  return db;
}
const apply0023 = (db) => db.exec(readFileSync(join(MIGRATIONS, '0023_mechanisms.sql'), 'utf8'));

// D1 的介面（prepare / bind / all / first / run / batch）包在 node:sqlite 外面
function d1(db) {
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a.map(norm)),
    async all() { return { results: db.prepare(sql).all(...args).map(r => ({ ...r })) }; },
    async first() { const r = db.prepare(sql).get(...args); return r ? { ...r } : null; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    exec() {
      const p = db.prepare(sql);
      if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: p.all(...args).map(r => ({ ...r })) };
      const r = p.run(...args);
      return { results: [], meta: { changes: Number(r.changes) } };
    },
  });
  return {
    prepare: (sql) => stmt(sql),
    async batch(list) {
      db.exec('BEGIN');
      try { const out = list.map(s => s.exec()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

const J = JSON.stringify;
function seedProject(db, id = 'p1', offsets = {}) {
  db.prepare(`INSERT INTO projects (id, name, mechanism_offsets) VALUES (?, ?, ?)`).run(id, id, typeof offsets === 'string' ? offsets : J(offsets));
}
function seedObject(db, id, project = 'p1', category = 'led_panel', order = 0, display = null, mesh = id.toUpperCase()) {
  db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order") VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, project, mesh, display, category, order);
}
function seedSong(db, id, project = 'p1') {
  db.prepare(`INSERT INTO songs (id, project_id, name, "order") VALUES (?, ?, ?, 0)`).run(id, project, id);
}
function seedCue(db, id, song, order, status = 'master', videoTime = null, crossfade = 1) {
  db.prepare(`INSERT INTO cues (id, song_id, name, "order", status, video_time_sec, crossfade_seconds) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, song, id, order, status, videoTime, crossfade);
}

/** 資料庫裡的機關 → 跟 legacyOffsetsToMechanisms 一樣的格式 */
function legacyRowsFromDb(db, projectId) {
  const mechs = db.prepare(`SELECT * FROM mechanisms WHERE project_id = ? ORDER BY id`).all(projectId);
  const mo = db.prepare(`SELECT * FROM mechanism_objects`).all();
  return mechs.map(m => ({
    id: m.id, name: m.name, kind: m.kind, axis: JSON.parse(m.axis), pivot: m.pivot, travelMin: m.travel_min, travelMax: m.travel_max,
    defaultValue: m.default_value, maxSpeed: m.max_speed, presets: JSON.parse(m.presets), parentId: m.parent_id, order: m.order,
    legacyObjectId: m.legacy_object_id, legacyAxis: m.legacy_axis,
    objectIds: mo.filter(x => x.mechanism_id === m.id).map(x => x.stage_object_id),
  }));
}

test('0023：舊的機關滑桿 → 機關，跟前端的換算一模一樣；重跑不會多', () => {
  const db = freshDb(22);
  const offsets = {
    so_x_only: { x: 2, y: 0 },
    so_y_only: { x: 0, y: -1.5 },
    so_both: { x: 1, y: 12 },          // 上下 12 m → 行程放寬到 -10 ~ 12
    so_blank_name: { x: 3 },
    so_lift: { x: 1, y: 1 },           // 不是 LED → 不轉
    so_gone: { x: 1, y: 1 },           // 物件已經刪了 → 不轉
    so_zero: { x: 0, y: 0 },
  };
  seedProject(db, 'p1', offsets);
  seedProject(db, 'p2', '{bad json');  // 壞掉的 JSON → 略過
  seedProject(db, 'p3', {});
  seedObject(db, 'so_x_only', 'p1', 'led_panel', 2, '主牆 LED-1');
  seedObject(db, 'so_y_only', 'p1', 'led_panel', 3, 'LED-2');
  seedObject(db, 'so_both', 'p1', 'led_panel', 4, 'LED-3');
  seedObject(db, 'so_blank_name', 'p1', 'led_panel', 5, '   ', 'LED-4');
  seedObject(db, 'so_lift', 'p1', 'mechanism', 6, '升降台');
  seedObject(db, 'so_zero', 'p1', 'led_panel', 7, 'LED-0');
  apply0023(db);

  const objects = db.prepare(`SELECT id, category, "order", display_name, mesh_name FROM stage_objects WHERE project_id = 'p1'`).all()
    .map(o => ({ id: o.id, category: o.category, order: o.order, displayName: o.display_name, meshName: o.mesh_name }));
  const expected = legacyOffsetsToMechanisms(offsets, objects).sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(legacyRowsFromDb(db, 'p1'), expected);
  assert.equal(expected.length, 5);
  assert.equal(expected.find(r => r.id === 'mly_so_both').parentId, 'mlx_so_both');
  assert.deepEqual(expected.find(r => r.id === 'mly_so_both').objectIds, ['so_both']);
  assert.equal(expected.find(r => r.id === 'mlx_so_blank_name').name, 'LED-4 左右');
  assert.equal(expected.find(r => r.id === 'mly_so_both').travelMax, 12);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM mechanisms WHERE project_id IN ('p2','p3')`).get().n, 0);

  // 再跑一次 → 不會多
  apply0023(db);
  assert.deepEqual(legacyRowsFromDb(db, 'p1'), expected);
});

test('0023：刪物件 → 物件從機關拿掉；刪 cue → 那個 cue 的機關位置一起刪；一個物件不能直接放兩個機關', () => {
  const db = freshDb(22);
  seedProject(db, 'p1', { led: { y: 1 } });
  seedObject(db, 'led', 'p1');
  seedSong(db, 's1');
  seedCue(db, 'c1', 's1', 0);
  apply0023(db);
  db.prepare(`INSERT INTO cue_mechanism_positions (cue_id, mechanism_id, value) VALUES ('c1', 'mly_led', 2)`).run();
  db.prepare(`INSERT INTO mechanisms (id, project_id, name, kind) VALUES ('m2', 'p1', '別的', 'linear')`).run();
  assert.throws(() => db.prepare(`INSERT INTO mechanism_objects (mechanism_id, stage_object_id) VALUES ('m2', 'led')`).run(), /UNIQUE/);
  db.prepare(`DELETE FROM cues WHERE id = 'c1'`).run();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM cue_mechanism_positions`).get().n, 0);
  db.prepare(`DELETE FROM stage_objects WHERE id = 'led'`).run();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM mechanism_objects`).get().n, 0);
  // 行程最高要比最低大（資料庫也擋）
  assert.throws(() => db.prepare(`INSERT INTO mechanisms (id, project_id, name, kind, travel_min, travel_max) VALUES ('m3', 'p1', 'x', 'linear', 2, 1)`).run(), /CHECK/);
});

test('小工具：資料庫一列 ↔ API、物件衝突', () => {
  const m = rowToMechanism({
    id: 'm1', name: '轉台', kind: 'rotary', axis: J({ x: 0, y: 1, z: 0 }), pivot: J({ x: 1, y: 0, z: 2 }), travel_min: -180, travel_max: 180,
    default_value: 0, max_speed: 6, presets: J([{ name: '側面', value: 90 }, { name: '正面', value: 0 }]), parent_id: null,
    console_label: 'Revolve', order: 2, metadata: null, updated_at: 'x',
  }, ['o1'], 3);
  assert.deepEqual(m.presets.map(p => p.name), ['正面', '側面']);
  assert.deepEqual(m.pivot, { x: 1, y: 0, z: 2 });
  assert.equal(m.cueCount, 3);
  assert.equal(rowToMechanism({ id: 'x', kind: 'linear', axis: 'bad', pivot: J({ x: 1, y: 1, z: 1 }), presets: 'bad', travel_min: 0, travel_max: 1, default_value: 0 }).pivot, null);
  const cols = inputToColumns({ ...m, pivot: m.pivot, kind: 'linear' });
  assert.equal(cols.pivot, null);
  const c = findObjectConflicts(['o1', 'o2'], [
    { stage_object_id: 'o1', mechanism_id: 'm9', mechanism_name: '升降台' },
    { stage_object_id: 'o2', mechanism_id: 'self', mechanism_name: '自己' },
  ], new Map([['o1', 'LED-1']]), 'self');
  assert.deepEqual(c, [{ objectId: 'o1', objectName: 'LED-1', mechanismId: 'm9', mechanismName: '升降台' }]);
  assert.equal(conflictMessage(c[0]), '「LED-1」已經在「升降台」裡，一個物件只能直接放在一個機關');
});

// ── 後台 API（直接呼叫 handler，資料庫是 node:sqlite） ──
function apiEnv() {
  const db = freshDb(22);
  apply0023(db);
  seedProject(db, 'p1');
  seedObject(db, 'lift', 'p1', 'mechanism', 0, '升降台');
  seedObject(db, 'led', 'p1', 'led_panel', 1, 'LED');
  seedObject(db, 'deck', 'p1', 'mechanism', 2, '轉台面');
  seedSong(db, 's1');
  seedCue(db, 'c1', 's1', 0, 'master', 0, 0);
  seedCue(db, 'c2', 's1', 1, 'master', 30, 5);
  seedCue(db, 'p1c', 's1', 2, 'proposal');
  const env = { DB: d1(db) };
  const ctx = { projectId: 'p1' };
  const logs = [];
  const log = async (...a) => { logs.push(a); };
  const req = (body) => ({ json: async () => body });
  return { db, env, ctx, log, logs, req };
}
const liftBody = { name: '中央升降台', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, travelMin: 0, travelMax: 3.5, maxSpeed: 0.25, objectIds: ['lift', 'led'] };

test('API：新增 / 名稱重複 / 物件已經在別的機關（409，帶 moveObjects 才移）/ 修改 / 行程改窄', async () => {
  const { env, ctx, log, logs, req } = apiEnv();
  const r1 = await createMechanism(req(liftBody), env, ctx, log);
  assert.equal(r1.status, 201);
  const lift = r1.body.mechanism;
  assert.deepEqual(lift.objectIds, ['lift', 'led']);
  assert.equal(lift.maxSpeed, 0.25);
  assert.deepEqual(logs[0].slice(0, 2), ['create', 'mechanism']);

  const dup = await createMechanism(req({ ...liftBody, objectIds: [] }), env, ctx, log);
  assert.equal(dup.status, 400);
  assert.equal(dup.body.error, '這個專案已經有叫「中央升降台」的機關');

  const bad = await createMechanism(req({ ...liftBody, name: 'x', travelMin: 3, travelMax: 1 }), env, ctx, log);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, 'travel');

  const foreign = await createMechanism(req({ ...liftBody, name: 'y', objectIds: ['nope'] }), env, ctx, log);
  assert.equal(foreign.body.error, '有物件不在這個專案裡');

  const rev = { name: '旋轉舞台', kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: 0, y: 0, z: 0 }, travelMin: -180, travelMax: 180, objectIds: ['led', 'deck'] };
  const c409 = await createMechanism(req(rev), env, ctx, log);
  assert.equal(c409.status, 409);
  assert.equal(c409.body.error, '「LED」已經在「中央升降台」裡，一個物件只能直接放在一個機關');
  assert.equal(c409.body.conflicts[0].mechanismId, lift.id);
  const moved = await createMechanism(req({ ...rev, moveObjects: true }), env, ctx, log);
  assert.equal(moved.status, 201);
  const [liftNow] = await loadMechanisms(env, 'p1', lift.id);
  assert.deepEqual(liftNow.objectIds, ['lift']);

  // 升降台裝在轉台上；轉台不能再裝到升降台上（繞圈）
  const up = await updateMechanism(req({ parentId: moved.body.mechanism.id }), env, ctx, lift.id, log);
  assert.equal(up.status, 200);
  assert.equal(up.body.mechanism.parentId, moved.body.mechanism.id);
  const cyc = await updateMechanism(req({ parentId: lift.id }), env, ctx, moved.body.mechanism.id, log);
  assert.equal(cyc.body.error, '不能選自己，或裝在自己上面的機關');

  // 每個 cue 存的位置，行程改窄 → 告訴畫面有幾個超出
  ctx.mechanism = { id: lift.id, kind: 'linear', travel_min: 0, travel_max: 3.5 };
  await putCuePosition(req({ value: 3.5 }), env, ctx, 'c2');
  const narrow = await updateMechanism(req({ travelMax: 2 }), env, ctx, lift.id, log);
  assert.equal(narrow.body.outOfRangeCount, 1);
  assert.equal(narrow.body.mechanism.travelMax, 2);
});

test('API：每個 cue 的位置（夾進行程、回到沿用、算改過）、整首歌、總表、排序、刪除', async () => {
  const { db, env, ctx, log, logs, req } = apiEnv();
  const { body: { mechanism: lift } } = await createMechanism(req(liftBody), env, ctx, log);
  db.prepare(`UPDATE mechanisms SET edited_at = NULL WHERE id = ?`).run(lift.id);
  ctx.mechanism = { id: lift.id, kind: 'linear', travel_min: 0, travel_max: 3.5 };
  const put = await putCuePosition(req({ value: 9 }), env, ctx, 'c2');
  assert.deepEqual(put.body, { ok: true, value: 3.5, clamped: true });
  assert.ok(db.prepare(`SELECT edited_at FROM mechanisms WHERE id = ?`).get(lift.id).edited_at);
  assert.equal((await putCuePosition(req({ value: 'abc' }), env, ctx, 'c2')).body.error, '位置要是數字');
  await putCuePosition(req({ value: 1 }), env, ctx, 'p1c');
  assert.equal((await loadSongPositions(env, 's1')).length, 2);
  // 分享連結只看得到正式 cue
  assert.deepEqual((await loadSongPositions(env, 's1', { masterOnly: true })).map(p => [p.cueId, p.value]), [['c2', 3.5]]);
  const sheet = await mechanismSheet(env, ctx);
  assert.deepEqual(sheet.body.songs[0].cues.map(c => c.id), ['c1', 'c2']);
  assert.equal(sheet.body.positions.length, 1);
  assert.equal(sheet.body.mechanisms.length, 1);
  assert.equal(sheet.body.songs[0].cues[1].videoTimeSec, 30);

  const del = await deleteCuePosition(req({}), env, ctx, 'c2');
  assert.equal(del.body.removed, 1);
  // 不寫活動紀錄（拖滑桿不洗版）
  assert.equal(logs.length, 1);

  const { body: { mechanism: rev } } = await createMechanism(req({ name: '轉台', kind: 'rotary', travelMin: -180, travelMax: 180 }), env, ctx, log);
  await reorderMechanisms(req({ ids: [rev.id, lift.id] }), env, ctx, log);
  assert.deepEqual((await loadMechanisms(env, 'p1')).map(m => m.id), [rev.id, lift.id]);
  assert.equal((await reorderMechanisms(req({ ids: 'x' }), env, ctx, log)).status, 400);

  const d = await deleteMechanism(req({}), env, ctx, lift.id, log);
  assert.deepEqual(d.body, { ok: true, removedPositions: 1 });
  assert.equal((await loadMechanisms(env, 'p1')).length, 1);
  assert.equal((await deleteMechanism(req({}), env, ctx, lift.id, log)).status, 404);
});

test('舊網站改機關滑桿 → 同步到機關（沒在新介面改過的才同步，改過就不再動）', async () => {
  const { db, env, req, ctx, log } = apiEnv();
  // 一開始沒有位移
  await syncLegacyMechanismOffsets(env, 'p1', {}, { led: { x: 2, y: 0 } });
  let rows = legacyRowsFromDb(db, 'p1');
  assert.deepEqual(rows.map(r => [r.id, r.defaultValue, r.objectIds]), [['mlx_led', 2, ['led']]]);
  // 再加上下 → 上下帶 LED、裝在左右上
  await syncLegacyMechanismOffsets(env, 'p1', { led: { x: 2, y: 0 } }, { led: { x: 2, y: 11 } });
  rows = legacyRowsFromDb(db, 'p1');
  assert.deepEqual(rows.map(r => [r.id, r.defaultValue, r.parentId, r.objectIds, r.travelMax]), [
    ['mlx_led', 2, null, [], 10],
    ['mly_led', 11, 'mlx_led', ['led'], 11],
  ]);
  // 結果跟 migration 從頭轉的一樣
  const objects = [{ id: 'led', category: 'led_panel', order: 1, displayName: 'LED', meshName: 'LED' }];
  assert.deepEqual(rows, legacyOffsetsToMechanisms({ led: { x: 2, y: 11 } }, objects).sort((a, b) => a.id.localeCompare(b.id)));
  // 左右歸零 → 左右的機關拿掉，上下不再裝在左右上
  await syncLegacyMechanismOffsets(env, 'p1', { led: { x: 2, y: 11 } }, { led: { x: 0, y: 11 } });
  assert.deepEqual(legacyRowsFromDb(db, 'p1').map(r => [r.id, r.parentId, r.objectIds]), [['mly_led', null, ['led']]]);
  // 沒變的 LED 不動
  assert.deepEqual(await syncLegacyMechanismOffsets(env, 'p1', { led: { y: 11 } }, { led: { y: 11 } }), { synced: 0, skipped: 0 });
  // 不是 LED 的不轉
  await syncLegacyMechanismOffsets(env, 'p1', {}, { lift: { x: 1 } });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM mechanisms WHERE legacy_object_id = 'lift'`).get().n, 0);

  // 在新介面改過（例：設了某個 cue 的位置）→ 舊滑桿不再蓋過去
  ctx.mechanism = { id: 'mly_led', kind: 'linear', travel_min: -10, travel_max: 11 };
  await putCuePosition(req({ value: 3 }), env, ctx, 'c2');
  const r = await syncLegacyMechanismOffsets(env, 'p1', { led: { y: 11 } }, { led: { y: 5 } });
  assert.deepEqual(r, { synced: 0, skipped: 1 });
  assert.equal(db.prepare(`SELECT default_value FROM mechanisms WHERE id = 'mly_led'`).get().default_value, 11);
  void log;
});

test('複製專案 / 匯出：機關、帶的物件、每個 cue 的位置都跟著（新 id、parent 換成新的）', async () => {
  const { db, env, ctx, log, req } = apiEnv();
  const { body: { mechanism: rev } } = await createMechanism(req({ name: '轉台', kind: 'rotary', travelMin: -180, travelMax: 180, objectIds: ['deck'] }), env, ctx, log);
  const { body: { mechanism: lift } } = await createMechanism(req({ ...liftBody, parentId: rev.id }), env, ctx, log);
  ctx.mechanism = { id: lift.id, kind: 'linear', travel_min: 0, travel_max: 3.5 };
  await putCuePosition(req({ value: 2 }), env, ctx, 'c2');
  // 複製出來的專案
  seedProject(db, 'p9');
  seedObject(db, 'lift9', 'p9', 'mechanism', 0, null, 'LIFT9');
  seedObject(db, 'led9', 'p9', 'led_panel', 1, null, 'LED9');
  seedObject(db, 'deck9', 'p9', 'mechanism', 2, null, 'DECK9');
  seedSong(db, 's9', 'p9');
  seedCue(db, 'c9', 's9', 1);
  const r = await copyMechanismsToProject(env, 'p1', 'p9',
    new Map([['lift', 'lift9'], ['led', 'led9'], ['deck', 'deck9']]), new Map([['c2', 'c9']]));
  assert.deepEqual(r, { mechanisms: 2, objects: 3, positions: 1 });
  const copied = await loadMechanisms(env, 'p9');
  const cl = copied.find(m => m.name === '中央升降台');
  const cr = copied.find(m => m.name === '轉台');
  assert.notEqual(cl.id, lift.id);
  assert.equal(cl.parentId, cr.id);
  assert.deepEqual(cl.objectIds.sort(), ['led9', 'lift9']);
  assert.deepEqual((await loadSongPositions(env, 's9')).map(p => [p.cueId, p.mechanismId, p.value]), [['c9', cl.id, 2]]);
  const exp = await exportMechanisms(env, 'p1');
  assert.equal(exp.mechanisms.length, 2);
  assert.equal(exp.cueMechanismPositions.length, 1);
});

test('新 cue（沿用 / 從畫面 / 常用擺位）、重置 cue、清除所有物件前的數量', async () => {
  const { db, env, ctx, log, req } = apiEnv();
  const { body: { mechanism: lift } } = await createMechanism(req(liftBody), env, ctx, log);
  ctx.mechanism = { id: lift.id, kind: 'linear', travel_min: 0, travel_max: 3.5 };
  await putCuePosition(req({ value: 2 }), env, ctx, 'c2');
  seedCue(db, 'c3', 's1', 3);
  assert.equal(await cloneCuePositions(env, 'c2', 'c3'), 1);
  seedCue(db, 'c4', 's1', 4);
  assert.equal(await snapshotCuePositions(env, 'p1', 'c4', { [lift.id]: 99, nope: 1 }), 1);
  assert.equal(db.prepare(`SELECT value FROM cue_mechanism_positions WHERE cue_id = 'c4'`).get().value, 3.5);
  const tpl = await templateMechanismPositions(env, 'c2');
  assert.deepEqual(tpl, [{ name: '中央升降台', value: 2 }]);
  seedCue(db, 'c5', 's1', 5);
  assert.equal(await applyNamedPositions(env, 'p1', 'c5', [...tpl, { name: '不存在', value: 1 }]), 1);
  assert.equal(await clearCuePositions(env, 'c5'), 1);
  assert.equal(await countMechanismObjects(env, 'p1'), 2);
});

test('把現有 cue 的位置轉成機關位置：先看會轉幾個、轉完物件回到原本高度、已經有設位置的機關不能轉', async () => {
  const { db, env, ctx, log, req } = apiEnv();
  db.prepare(`UPDATE stage_objects SET default_position = ? WHERE id = 'led'`).run(J({ x: 0, y: 1, z: -1 }));
  const ins = db.prepare(`INSERT INTO cue_object_states (id, cue_id, stage_object_id, position, rotation) VALUES (?, ?, ?, ?, ?)`);
  ins.run('s1', 'c2', 'lift', J({ x: 0, y: 2, z: 0 }), J({ pitch: 0, yaw: 0, roll: 0 }));
  ins.run('s2', 'c2', 'led', J({ x: 0, y: 3, z: -1 }), null);
  const { body: { mechanism: lift } } = await createMechanism(req(liftBody), env, ctx, log);
  const dry = await convertCuePositions(req({ dryRun: true }), env, ctx, lift.id, log);
  assert.equal(dry.status, 200);
  assert.equal(dry.body.converted, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM cue_mechanism_positions`).get().n, 0);  // 還沒寫
  const done = await convertCuePositions(req({}), env, ctx, lift.id, log);
  assert.equal(done.body.converted, 1);
  assert.deepEqual(done.body.skipped, []);
  assert.equal(db.prepare(`SELECT value FROM cue_mechanism_positions WHERE cue_id = 'c2'`).get().value, 2);
  assert.deepEqual(JSON.parse(db.prepare(`SELECT position FROM cue_object_states WHERE id = 's2'`).get().position), { x: 0, y: 1, z: -1 });
  const again = await convertCuePositions(req({}), env, ctx, lift.id, log);
  assert.equal(again.status, 409);
});
