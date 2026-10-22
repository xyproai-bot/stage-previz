// 跑法：cd cf-worker && npm test
// Cue 庫搬家程式：在 freshDb 用真的後台路由建測資 → 匯出成 .sql → 跑程式 → 套到另一個全新的（全部 migration）SQLite →
// 用路由算出來的「搬之前」每首歌每個 cue 的畫面和機關動法，跟「搬之後」從 Cue 庫讀回來的比，要一模一樣。
// 另外：同一份資料跑兩次 SQL 一樣、--revert 回到原狀、已經搬過的跳過、只有名稱和內容都一樣才合併。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, applyMigrations, freshDb } from '../testing/d1-sqlite.mjs';
import worker from '../worker.js';
import { resolveSongMechanisms, ownValuesByCue, ownTimingsByCue } from '../mechanismTrack.mjs';
import { resolveLibraryObjectStates, resolveSlotMechanisms } from '../cueLibrary.mjs';
import { loadExportDb, runMigration, verifyOnly, buildRevertSql, renderReport } from './migrate-cue-library.mjs';

const BASE = 'https://proxy.test';
const P = '/api/projects/p1';
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/** 像 wrangler d1 export：建表 + 每一列一個 INSERT */
function dumpSql(raw, { schema = true } = {}) {
  const out = [];
  const objs = raw.prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`).all();
  if (schema) for (const o of objs.filter(o => o.type === 'table')) out.push(o.sql + ';');
  for (const o of objs.filter(o => o.type === 'table')) {
    for (const r of raw.prepare(`SELECT * FROM "${o.name}"`).all()) {
      const cols = Object.keys(r);
      out.push(`INSERT OR REPLACE INTO "${o.name}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${cols.map(c => q(r[c])).join(', ')});`);
    }
  }
  if (schema) for (const o of objs.filter(o => o.type === 'index')) out.push(o.sql + ';');
  return out.join('\n');
}

async function setup() {
  const db = freshDb();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_admin', 'a@x.test', '製作', 'admin', 'ADMIN-1')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '巡演'), ('p2', '另一個專案')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", code) VALUES ('s1', 'p1', '開場曲', 0, 'S01'), ('s2', 'p1', '安可曲目的名字很長很長', 1, NULL), ('s3', 'p2', '別的歌', 0, 'Z1')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order", default_hidden) VALUES
      ('o_a', 'p1', 'A', '主牆', 'led_panel', 0, 0), ('o_b', 'p1', 'B', '側牆', 'led_panel', 1, 0),
      ('o_hid', 'p1', 'RIBBON', '緞帶', 'other', 2, 1), ('o_c', 'p1', 'LIFT', '升降台', 'other', 3, 0), ('o_d', 'p1', 'D', '沒人碰', 'other', 4, 0),
      ('o_z', 'p2', 'Z', 'Z', 'other', 0, 0)`),
  ]);
  const env = { DB: db, AUTH_SECRET: 'test-secret' };
  const login = await worker.fetch(new Request(`${BASE}/api/auth/login`, { method: 'POST', body: JSON.stringify({ accessCode: 'ADMIN-1' }), headers: { 'content-type': 'application/json' } }), env);
  const token = (await login.json()).token;
  const call = async (method, path, body) => {
    const r = await worker.fetch(new Request(BASE + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    let data = null;
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data };
  };
  return { db, call };
}

/** 用後台路由建一份有各種特殊情況的資料，回傳 { db, ids } */
async function buildScenario() {
  const { db, call } = await setup();
  const mk = async (song, name, extra = {}) => {
    const r = await call('POST', `${P}/songs/${song}/cues`, { name, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.id;
  };
  const state = async (song, cue, obj, body) => assert.ok([200, 201].includes((await call('PUT', `${P}/songs/${song}/cues/${cue}/states/${obj}`, body)).status));
  const mech = async (body) => { const r = await call('POST', `${P}/mechanisms`, body); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.mechanism.id; };
  const pos = async (song, cue, m, body) => assert.ok([200, 201].includes((await call('PUT', `${P}/songs/${song}/cues/${cue}/mechanisms/${m}`, body)).status));

  const m1 = await mech({ name: '升降台', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, travelMin: 0, travelMax: 3, defaultValue: 0, objectIds: ['o_c'] });
  const m2 = await mech({ name: '轉盤', kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: 0, y: 0, z: 0 }, travelMin: 0, travelMax: 90, defaultValue: 10, objectIds: ['o_d'] });

  const c1 = await mk('s1', '開場');
  const c2 = await mk('s1', '副歌');
  const c3 = await mk('s1', '間奏');            // 完全沒設 → 全部沿用前面的（舊規則）
  const c4 = await mk('s1', '結尾');
  await state('s1', c1, 'o_a', { position: { x: 1, y: 2, z: 3 } });
  await state('s1', c2, 'o_a', { visible: false });                         // 整筆取代：位置不再沿用（舊規則的怪地方）
  await state('s1', c2, 'o_b', { position: { x: 5, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 }, rotation: { pitch: 1, yaw: 2, roll: 3 } });
  await state('s1', c4, 'o_hid', { visible: true });                        // 預設隱藏的物件，這個 cue 才顯示
  await state('s1', c2, 'o_c', { customProps: { color: 'red' } });
  await pos('s1', c1, m1, { value: 1, delaySec: 2, durationSec: 3 });
  await pos('s1', c2, m1, { value: 2.5 });
  await pos('s1', c4, m2, { value: 45, delaySec: 0.5 });
  // 第 2 首歌：複製「開場」（名稱、內容都一樣 → 合併）、名稱不同內容一樣（不合併）、完全空白
  const d1 = await mk('s2', '開場', { cloneFrom: c1 });
  const d2 = await mk('s2', '另一個名字', { cloneFrom: c1 });
  const d3 = await mk('s2', '空白');
  // 直接寫資料庫的特殊情況：順序一樣的 cue、提案、存的值超出行程、cue 的時間
  await db.batch([
    db.prepare(`INSERT INTO cues (id, song_id, name, "order", status, created_at) VALUES ('c_tie', 's1', '同順序', 1, 'master', '2030-01-01 00:00:00')`),
    db.prepare(`INSERT INTO cues (id, song_id, name, "order", status) VALUES ('c_prop', 's1', '提案', 2, 'proposal')`),
    db.prepare(`INSERT INTO cue_object_states (id, cue_id, stage_object_id, position) VALUES ('cos_prop', 'c_prop', 'o_a', '{"x":9,"y":9,"z":9}')`),
    db.prepare(`INSERT INTO cue_mechanism_positions (cue_id, mechanism_id, value) VALUES ('c_prop', ?, 7)`).bind(m1),   // 超出行程 0~3
    db.prepare(`UPDATE cues SET video_time_sec = 12.5, crossfade_seconds = 0 WHERE id = ?`).bind(c2),
    // 別的專案
    db.prepare(`INSERT INTO cues (id, song_id, name, "order", status) VALUES ('z1', 's3', 'Z 開場', 0, 'master')`),
    db.prepare(`INSERT INTO cue_object_states (id, cue_id, stage_object_id, position) VALUES ('cos_z', 'z1', 'o_z', '{"x":4,"y":4,"z":4}')`),
  ]);
  return { db, call, ids: { c1, c2, c3, c4, d1, d2, d3, m1, m2 } };
}

const SONGS = { p1: ['s1', 's2'], p2: ['s3'] };

/** 搬之前：用後台路由算出每個 cue 的物件狀態和機關動法 */
async function legacyViaRoutes(call, project = 'p1') {
  const out = new Map();
  const mechs = (await call('GET', `/api/projects/${project}/mechanisms?mech=3`)).data.mechanisms;
  for (const song of SONGS[project]) {
    const cues = (await call('GET', `/api/projects/${project}/songs/${song}/cues`)).data.cues;
    const positions = (await call('GET', `/api/projects/${project}/songs/${song}/mechanism-positions?mech=3`)).data.positions;
    const resolved = resolveSongMechanisms(mechs, cues, ownValuesByCue(positions));
    const timings = ownTimingsByCue(positions);
    for (const c of cues) {
      const states = (await call('GET', `/api/projects/${project}/songs/${song}/cues/${c.id}/states`)).data.states;
      out.set(c.id, { song, name: c.name, states, mech: resolved.get(c.id), timings: timings.get(c.id) || {}, cue: c });
    }
  }
  return { out, mechs };
}

/** 搬之後：從 Cue 庫的表讀回來 */
function libraryFromDb(db, project, mechs) {
  const objectRows = db.raw.prepare(`SELECT o.id AS object_id, o.mesh_name, o.display_name, o.category, o."order" AS object_order, o.default_position, o.default_rotation, o.default_scale, o.locked AS object_locked, o.default_hidden FROM stage_objects o WHERE o.project_id = ? ORDER BY o."order", o.created_at`).all(project);
  const out = new Map();
  for (const c of db.raw.prepare(`SELECT c.id, c.library_cue_id FROM cues c JOIN songs s ON s.id = c.song_id WHERE s.project_id = ?`).all(project)) {
    assert.ok(c.library_cue_id, `cue ${c.id} 沒有指到 Cue 庫`);
    const objs = db.raw.prepare(`SELECT * FROM library_cue_object_states WHERE library_cue_id = ?`).all(c.library_cue_id);
    const ms = db.raw.prepare(`SELECT * FROM library_cue_mechanism_positions WHERE library_cue_id = ?`).all(c.library_cue_id);
    out.set(c.id, { states: resolveLibraryObjectStates(objectRows, objs), mech: resolveSlotMechanisms(mechs, ms, c.id) });
  }
  return out;
}

function assertSameLook(legacy, library) {
  assert.equal(library.size, legacy.out.size);
  for (const [cueId, before] of legacy.out) {
    const after = library.get(cueId);
    assert.ok(after, `搬完少了 cue ${before.name}`);
    for (const b of before.states) {
      const a = after.states.find(s => s.objectId === b.objectId);
      const where = `cue「${before.name}」物件「${b.displayName}」`;
      assert.deepEqual(a.effective, b.effective, `${where} 看到的畫面`);
      assert.equal(a.tracked, b.tracked, `${where} 沿用`);
      assert.deepEqual(a.override && { ...a.override, updatedAt: null }, b.override && { ...b.override, updatedAt: null }, `${where} 自己設的`);
      assert.equal(a.defaultHidden, b.defaultHidden);
    }
    for (const m of legacy.mechs) {
      if (m.variant === 'hoist_rig') continue;
      const x = before.mech[m.id], y = after.mech.row[m.id];
      const where = `cue「${before.name}」機關「${m.name}」`;
      for (const f of ['value', 'stored', 'source', 'clamped']) assert.equal(y[f], x[f], `${where} ${f}`);
      assert.deepEqual(after.mech.timings[m.id] ?? null, before.timings[m.id] ?? null, `${where} 時間`);
    }
  }
}

const slotColumns = (db) => JSON.stringify(db.raw.prepare(`SELECT id, song_id, name, "order", video_time_sec, crossfade_seconds, status FROM cues ORDER BY id`).all());
const legacyTables = (db) => JSON.stringify(['cue_object_states', 'cue_mechanism_positions', 'stage_objects', 'mechanisms'].map(t => db.raw.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()));

test('整個流程：匯出 → 程式 → 套到全新資料庫 → 每首歌每個 cue 的畫面和機關動法跟搬之前一模一樣', async () => {
  const { db, call, ids } = await buildScenario();
  const legacy = await legacyViaRoutes(call);
  const exportSql = dumpSql(db.raw);

  const { sql, report } = await runMigration(loadExportDb(exportSql));
  assert.equal(report.totalDifferences, 0, renderReport(report));
  assert.ok(sql);
  const rp = report.projects.find(p => p.projectId === 'p1');
  assert.equal(rp.songs, 2);
  assert.equal(rp.cues, 9);
  assert.equal(rp.mergedGroups, 1);              // 兩個「開場」
  assert.equal(rp.libraryCues, 8);
  assert.deepEqual(report.projects.find(p => p.projectId === 'p2').libraryCues, 1);

  // 套到另一個全新的資料庫（全部 migration，只放資料）
  const target = freshDb();
  target.raw.exec('PRAGMA foreign_keys = OFF;');
  target.raw.exec(dumpSql(db.raw, { schema: false }));
  target.raw.exec('PRAGMA foreign_keys = ON;');
  const slotsBefore = slotColumns(target), tablesBefore = legacyTables(target);
  target.raw.exec(sql);
  assert.equal(slotColumns(target), slotsBefore, 'cue 本身（名稱 / 順序 / 時間 / 轉場 / 狀態）沒被動到');
  assert.equal(legacyTables(target), tablesBefore, '舊的表原封不動');
  assertSameLook(legacy, libraryFromDb(target, 'p1', legacy.mechs));
  const legacyP2 = await legacyViaRoutes(call, 'p2');
  assertSameLook(legacyP2, libraryFromDb(target, 'p2', legacyP2.mechs));
  assert.deepEqual(target.raw.prepare(`SELECT id, cue_library FROM projects ORDER BY id`).all().map(p => [p.id, p.cue_library]), [['p1', 1], ['p2', 1]]);

  // 幾個特別的地方
  const libOf = (cueId) => target.raw.prepare(`SELECT l.* FROM library_cues l JOIN cues c ON c.library_cue_id = l.id WHERE c.id = ?`).get(cueId);
  assert.equal(libOf(ids.c1).id, libOf(ids.d1).id, '名稱和內容一樣 → 合併');
  assert.equal(libOf(ids.c1).name, '開場', '合併的用共同的 cue 名稱，不加歌代號');
  assert.notEqual(libOf(ids.c1).id, libOf(ids.d2).id, '內容一樣但名稱不一樣 → 不合併');
  assert.equal(libOf(ids.c2).name, 'S01 副歌', '沒合併的叫「歌代號 cue 名」');
  assert.equal(libOf(ids.d3).name, '安可曲目的名字很長很長 空白', '沒有歌代號就用歌名');
  assert.deepEqual(JSON.parse(libOf(ids.c1).migrated_from).sort(), [ids.c1, ids.d1].sort());
  // 編號照歌單順序 1、2、3…（合併的算第一次出現的位置）
  const labels = target.raw.prepare(`SELECT label FROM library_cues WHERE project_id = 'p1'`).all().map(r => Number(r.label)).sort((a, b) => a - b);
  assert.deepEqual(labels, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(libOf(ids.c1).label, '1');
  assert.equal(libOf(ids.c2).label, '2');
  // 只有 s1 的順序在前面的 cue 編號比 s2 的小
  assert.ok(Number(libOf(ids.c4).label) < Number(libOf(ids.d2).label));
  // 活動紀錄
  assert.match(target.raw.prepare(`SELECT payload FROM activity_log WHERE project_id = 'p1' AND id LIKE 'a_cuelib_%'`).get().payload, /把 9 個 cue 搬進 Cue 庫（8 個 Cue 庫的 cue）/);
  // 匯出時有 / 沒有的資料：存的值超出行程的機關，搬完還是存原本的值、算出來夾在行程內
  const propLib = libOf('c_prop');
  assert.equal(target.raw.prepare(`SELECT value FROM library_cue_mechanism_positions WHERE library_cue_id = ? AND mechanism_id = ?`).get(propLib.id, ids.m1).value, 7);

  // 搬完再匯出 → 重新比對 → 0 個不一樣；已經搬過的專案不會再搬
  const after = loadExportDb(dumpSql(target.raw));
  const v = await verifyOnly(after);
  assert.equal(v.report.totalDifferences, 0);
  assert.equal(v.report.projects.length, 2);
  const again = await runMigration(after);
  assert.equal(again.sql, null);
  assert.equal(again.report.skipped.length, 2);
  // 同一個 SQL 再套一次（可以重複執行）→ 結果一樣
  target.raw.exec(sql);
  assertSameLook(legacy, libraryFromDb(target, 'p1', legacy.mechs));
  assert.equal(target.raw.prepare(`SELECT COUNT(*) AS n FROM library_cues WHERE project_id = 'p1'`).get().n, 8);
  assert.equal(target.raw.prepare(`SELECT COUNT(*) AS n FROM activity_log WHERE id LIKE 'a_cuelib_%'`).get().n, 2);
});

test('同一份資料跑兩次，產生的 SQL 一模一樣', async () => {
  const { db } = await buildScenario();
  const exportSql = dumpSql(db.raw);
  const a = await runMigration(loadExportDb(exportSql));
  const b = await runMigration(loadExportDb(exportSql));
  assert.ok(a.sql);
  assert.equal(a.sql, b.sql);
  assert.deepEqual(a.report, b.report);
  // 單一專案
  const one = await runMigration(loadExportDb(exportSql), { projectId: 'p2' });
  assert.equal(one.report.projects.length, 1);
  assert.ok(!one.sql.includes("'p1'"));
});

test('--revert：專案切回舊模式，舊資料原封不動，畫面跟搬之前一樣', async () => {
  const { db, call } = await buildScenario();
  const legacy = await legacyViaRoutes(call);
  const target = freshDb();
  target.raw.exec('PRAGMA foreign_keys = OFF;');
  target.raw.exec(dumpSql(db.raw, { schema: false }));
  target.raw.exec('PRAGMA foreign_keys = ON;');
  const snapshot = [slotColumns(target), legacyTables(target)];
  const { sql } = await runMigration(loadExportDb(dumpSql(db.raw)));
  assert.equal((await buildRevertSql(loadExportDb(dumpSql(target.raw)))).sql, null, '還沒搬就沒有可以退回的');
  target.raw.exec(sql);
  const rv = await buildRevertSql(loadExportDb(dumpSql(target.raw)));
  assert.deepEqual(rv.projects.map(p => p.id).sort(), ['p1', 'p2']);
  assert.match(rv.sql, /UPDATE projects SET cue_library = 0 WHERE id IN/);
  target.raw.exec(rv.sql);
  assert.deepEqual(target.raw.prepare(`SELECT cue_library FROM projects`).all().map(p => p.cue_library), [0, 0]);
  assert.deepEqual([slotColumns(target), legacyTables(target)], snapshot);
  // 舊模式的畫面（後台路由）算出來跟搬之前一樣
  const env = { DB: target, AUTH_SECRET: 'test-secret' };
  const login = await worker.fetch(new Request(`${BASE}/api/auth/login`, { method: 'POST', body: JSON.stringify({ accessCode: 'ADMIN-1' }), headers: { 'content-type': 'application/json' } }), env);
  const token = (await login.json()).token;
  const get = async (path) => (await (await worker.fetch(new Request(BASE + path, { headers: { authorization: `Bearer ${token}` } }), env)).json());
  for (const [cueId, before] of legacy.out) {
    const now = await get(`/api/projects/${before.song === 's3' ? 'p2' : 'p1'}/songs/${before.song}/cues/${cueId}/states`);
    assert.deepEqual(now.states.map(s => s.effective), before.states.map(s => s.effective));
  }
  // 只切指定的專案
  const rv2 = await buildRevertSql(loadExportDb(dumpSql(target.raw)), { projectId: 'p2' });
  assert.equal(rv2.sql, null);
});

test('有差異就不寫 SQL：Cue 庫讀回來和舊算法不一樣時，報告寫出哪首歌哪個 cue 哪個物件', async () => {
  const { db } = await buildScenario();
  const local = loadExportDb(dumpSql(db.raw));
  // 偷偷讓 verifyOnly 比對時看到不一樣：先正常搬，再把 Cue 庫裡一個物件的位置改掉
  const { sql } = await runMigration(local);
  const target = loadExportDb(dumpSql(db.raw));
  target.raw.exec(sql);
  target.raw.exec(`UPDATE library_cue_object_states SET position = '{"x":99,"y":0,"z":0}' WHERE own = 1 AND position IS NOT NULL AND stage_object_id = 'o_a' AND rowid = (SELECT MIN(rowid) FROM library_cue_object_states WHERE stage_object_id = 'o_a' AND position IS NOT NULL)`);
  target.raw.exec(`UPDATE library_cue_mechanism_positions SET value = 0.25 WHERE rowid = (SELECT MIN(rowid) FROM library_cue_mechanism_positions WHERE carried = 0)`);
  const v = await verifyOnly(target, { projectId: 'p1' });
  assert.ok(v.report.totalDifferences >= 2);
  const text = renderReport(v.report, { verify: true });
  assert.match(text, /不一樣/);
  assert.match(text, /歌「.+」的 cue「.+」 的物件「主牆」/);
  assert.match(text, /的機關「/);
  assert.ok(v.report.projects[0].differences.some(d => d.kind === '物件' && d.name === '主牆'));
});

test('報告：中文白話，寫幾首歌 / 幾個 cue / 搬成幾個 / 合併了幾個 / 比對結果', async () => {
  const { db } = await buildScenario();
  const { report } = await runMigration(loadExportDb(dumpSql(db.raw)));
  const text = renderReport(report);
  assert.match(text, /專案「巡演」：2 首歌、9 個 cue/);
  assert.match(text, /搬成 8 個 Cue 庫的 cue（合併了 1 組，省下 1 個/);
  assert.match(text, /合併「開場」：開場曲「開場」、安可曲目的名字很長很長「開場」/);
  assert.match(text, /比對結果：0 個不一樣/);
  assert.match(text, /全部比對：0 個不一樣。/);
  assert.ok(report.projects[0].warnings.some(w => w.includes('順序一樣')), '順序一樣的 cue 會提醒');
});

test('舊的匯出檔（還沒有 0042 的表）也能搬：程式自己補上', async () => {
  const old = new D1Sqlite();
  applyMigrations(old, { before: '0042' });
  await old.batch([
    old.prepare(`INSERT INTO projects (id, name) VALUES ('p', 'P')`),
    old.prepare(`INSERT INTO songs (id, project_id, name, "order") VALUES ('s', 'p', '歌', 0)`),
    old.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name) VALUES ('o', 'p', 'O')`),
    old.prepare(`INSERT INTO cues (id, song_id, name, "order", status) VALUES ('c1', 's', '一', 0, 'master'), ('c2', 's', '二', 1, 'master')`),
    old.prepare(`INSERT INTO cue_object_states (id, cue_id, stage_object_id, position) VALUES ('x1', 'c1', 'o', '{"x":1,"y":1,"z":1}')`),
  ]);
  const { sql, report } = await runMigration(loadExportDb(dumpSql(old.raw)));
  assert.equal(report.totalDifferences, 0);
  assert.equal(report.projects[0].libraryCues, 2);   // 「二」沿用「一」的位置，但名稱不同，不合併
  assert.ok(sql.includes('UPDATE projects SET cue_library = 1'));
  // 沒有專案 id 的不存在 → 丟錯
  await assert.rejects(runMigration(loadExportDb(dumpSql(old.raw)), { projectId: 'nope' }));
});

test('命令列：匯出檔 → cue-library.sql + 報告；--verify-only；--revert', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrate-cue-library.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuelib-'));
  try {
    const { db } = await buildScenario();
    const exp = path.join(dir, 'export.sql');
    fs.writeFileSync(exp, dumpSql(db.raw), 'utf8');
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    const r = run(exp, '--out', dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /全部比對：0 個不一樣/);
    assert.ok(fs.readFileSync(path.join(dir, 'cue-library.sql'), 'utf8').includes('UPDATE projects SET cue_library = 1'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'cue-library-report.json'), 'utf8')).totalDifferences, 0);
    // 把 SQL 套到資料副本 → 再匯出 → verify-only / revert
    const after = freshDb();
    after.raw.exec('PRAGMA foreign_keys = OFF;');
    after.raw.exec(dumpSql(db.raw, { schema: false }));
    after.raw.exec(fs.readFileSync(path.join(dir, 'cue-library.sql'), 'utf8'));
    const exp2 = path.join(dir, 'after.sql');
    fs.writeFileSync(exp2, dumpSql(after.raw), 'utf8');
    const v = run('--verify-only', exp2);
    assert.equal(v.status, 0, v.stderr);
    assert.match(v.stderr, /全部比對：0 個不一樣/);
    const rv = run('--revert', exp2, '--out', dir);
    assert.equal(rv.status, 0, rv.stderr);
    assert.match(fs.readFileSync(path.join(dir, 'cue-library-revert.sql'), 'utf8'), /UPDATE projects SET cue_library = 0/);
    assert.notEqual(run().status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
