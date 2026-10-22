// 跑法：cd cf-worker && npm test
// Cue 庫第 3a 階段（後台讀取路徑）：同一份資料，舊模式和搬成 Cue 庫模式後，每個 cue 的輸出都一樣
// （物件狀態、機關位置、分享連結）；舊模式專案的輸出不受影響；Cue 庫專案的新欄位（cueLibrary、libraryCue、mode、cueCount）。
// 測資跟 scripts/migrate-cue-library.test.mjs 一樣用後台路由建；搬家用搬家程式（它會在本機副本套 SQL、把專案切成 Cue 庫模式）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './testing/d1-sqlite.mjs';
import worker from './worker.js';
import { resolveSongMechanisms, ownValuesByCue, ownTimingsByCue } from './mechanismTrack.mjs';
import { resolveSlotMechanisms } from './cueLibrary.mjs';
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
  const raw = async (method, path, body, auth = true) => {
    if (auth && !token) {
      const login = await worker.fetch(new Request(`${BASE}/api/auth/login`, { method: 'POST', body: JSON.stringify({ accessCode: 'ADMIN-1' }), headers: { 'content-type': 'application/json' } }), env);
      token = (await login.json()).token;
    }
    const r = await worker.fetch(new Request(BASE + path, {
      method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    let data = null;
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data };
  };
  return { call: (m, p, b) => raw(m, p, b), share: (p) => raw('GET', p, undefined, false) };
}

async function buildScenario() {
  const db = freshDb();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_admin', 'a@x.test', '製作', 'admin', 'ADMIN-1')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '巡演'), ('p2', '另一個專案')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", code) VALUES ('s1', 'p1', '開場曲', 0, 'S01'), ('s2', 'p1', '安可', 1, NULL), ('s3', 'p2', '別的歌', 0, 'Z1')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order", default_hidden) VALUES
      ('o_a', 'p1', 'A', '主牆', 'led_panel', 0, 0), ('o_b', 'p1', 'B', '側牆', 'led_panel', 1, 0),
      ('o_hid', 'p1', 'RIBBON', '緞帶', 'other', 2, 1), ('o_c', 'p1', 'LIFT', '升降台', 'other', 3, 0), ('o_d', 'p1', 'D', '沒人碰', 'other', 4, 0),
      ('o_z', 'p2', 'Z', 'Z', 'other', 0, 0)`),
    db.prepare(`INSERT INTO share_links (token, project_id) VALUES ('tk_p1', 'p1'), ('tk_p2', 'p2')`),
  ]);
  const { call } = client(db);
  const P = '/api/projects/p1';
  const mk = async (song, name, extra = {}) => { const r = await call('POST', `${P}/songs/${song}/cues`, { name, ...extra }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; };
  const state = async (song, cue, obj, body) => assert.ok([200, 201].includes((await call('PUT', `${P}/songs/${song}/cues/${cue}/states/${obj}`, body)).status));
  const mech = async (body) => { const r = await call('POST', `${P}/mechanisms`, body); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.mechanism.id; };
  const pos = async (song, cue, m, body) => assert.ok([200, 201].includes((await call('PUT', `${P}/songs/${song}/cues/${cue}/mechanisms/${m}`, body)).status));

  const m1 = await mech({ name: '升降台', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, travelMin: 0, travelMax: 3, defaultValue: 0, objectIds: ['o_c'] });
  const m2 = await mech({ name: '轉盤', kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: 0, y: 0, z: 0 }, travelMin: 0, travelMax: 90, defaultValue: 10, objectIds: ['o_d'] });
  const c1 = await mk('s1', '開場');
  const c2 = await mk('s1', '副歌');
  const c3 = await mk('s1', '間奏');
  const c4 = await mk('s1', '結尾');
  await state('s1', c1, 'o_a', { position: { x: 1, y: 2, z: 3 } });
  await state('s1', c2, 'o_a', { visible: false });
  await state('s1', c2, 'o_b', { position: { x: 5, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 }, rotation: { pitch: 1, yaw: 2, roll: 3 } });
  await state('s1', c4, 'o_hid', { visible: true });
  await state('s1', c2, 'o_c', { customProps: { color: 'red' } });
  await pos('s1', c1, m1, { value: 1, delaySec: 2, durationSec: 3 });
  await pos('s1', c2, m1, { value: 2.5 });
  await pos('s1', c4, m2, { value: 45, delaySec: 0.5 });
  const d1 = await mk('s2', '開場', { cloneFrom: c1 });
  await mk('s2', '另一個名字', { cloneFrom: c1 });
  await mk('s2', '空白');
  await db.batch([
    db.prepare(`INSERT INTO cues (id, song_id, name, "order", status, created_at) VALUES ('c_tie', 's1', '同順序', 1, 'master', '2030-01-01 00:00:00')`),
    db.prepare(`INSERT INTO cues (id, song_id, name, "order", status) VALUES ('c_prop', 's1', '提案', 2, 'proposal')`),
    db.prepare(`INSERT INTO cue_object_states (id, cue_id, stage_object_id, position) VALUES ('cos_prop', 'c_prop', 'o_a', '{"x":9,"y":9,"z":9}')`),
    db.prepare(`INSERT INTO cue_mechanism_positions (cue_id, mechanism_id, value) VALUES ('c_prop', ?, 7)`).bind(m1),
    db.prepare(`UPDATE cues SET video_time_sec = 12.5, crossfade_seconds = 0 WHERE id = ?`).bind(c2),
    db.prepare(`INSERT INTO cues (id, song_id, name, "order", status) VALUES ('z1', 's3', 'Z 開場', 0, 'master')`),
    db.prepare(`INSERT INTO cue_object_states (id, cue_id, stage_object_id, position) VALUES ('cos_z', 'z1', 'o_z', '{"x":4,"y":4,"z":4}')`),
  ]);
  return { db, ids: { c1, c2, c3, c4, d1, m1, m2 } };
}

const SONGS = { p1: ['s1', 's2'], p2: ['s3'] };
const TOKEN = { p1: 'tk_p1', p2: 'tk_p2' };

/** 一個專案所有 cue 的輸出（後台路由 + 分享連結），模式不同網址都一樣 */
async function snapshot(db, project) {
  const { call, share } = client(db);
  const P = `/api/projects/${project}`;
  const out = { cues: new Map(), mechs: (await call('GET', `${P}/mechanisms?mech=3`)).data.mechanisms };
  for (const song of SONGS[project]) {
    const cues = (await call('GET', `${P}/songs/${song}/cues`)).data.cues;
    const stale = (await call('GET', `${P}/songs/${song}/mechanism-positions?mech=3`)).data;
    const cl = await call('GET', `${P}/songs/${song}/mechanism-positions?mech=3&cuelib=1`);
    const shareCues = (await share(`/api/share/${TOKEN[project]}/songs/${song}/cues`)).data.cues;
    const sharePos = (await share(`/api/share/${TOKEN[project]}/songs/${song}/mechanism-positions?mech=3`)).data;
    const sharePosCl = (await share(`/api/share/${TOKEN[project]}/songs/${song}/mechanism-positions?mech=3&cuelib=1`)).data;
    const entry = { cues, stale, cl: cl.data, shareCues, sharePos, sharePosCl, perCue: new Map() };
    out.cues.set(song, entry);
    for (const c of cues) {
      const states = (await call('GET', `${P}/songs/${song}/cues/${c.id}/states`)).data.states;
      const shareStates = c.status === 'master' ? (await share(`/api/share/${TOKEN[project]}/songs/${song}/cues/${c.id}/states`)).data.states : null;
      entry.perCue.set(c.id, { states, shareStates });
    }
  }
  out.sheet = (await call('GET', `${P}/mechanism-sheet?mech=3`)).data;
  out.sheetCl = (await call('GET', `${P}/mechanism-sheet?mech=3&cuelib=1`)).data;
  return out;
}

// 狀態比對：不比自己設的更新時間（合併的 cue 沿用第一個的時間）和來源標記 sources（舊的 tracked / 新的 carried）
const norm = (states) => states && states.map(s => ({ ...s, sources: undefined, override: s.override && { ...s.override, updatedAt: null } }));

// JSON.stringify 的 replacer：Map 轉成可比的陣列
function replacer(_k, v) { return v instanceof Map ? [...v.entries()] : v; }

/** 舊模式：用位置解出每個 cue 每個機關的值 / 來源 / 時間 */
function legacyResolved(snap, song) {
  const d = snap.cues.get(song);
  const positions = d.cl.positions;
  const r = resolveSongMechanisms(snap.mechs, d.cues, ownValuesByCue(positions));
  const t = ownTimingsByCue(positions);
  return (cueId) => ({ row: r.get(cueId), timings: t.get(cueId) || {} });
}
/** Cue 庫模式（?cuelib=1 的每個 slot 一列）：用 Cue 庫的規則解 */
function libraryResolved(snap, song) {
  const d = snap.cues.get(song);
  return (cueId) => {
    const rows = d.cl.positions.filter(p => p.cueId === cueId)
      .map(p => ({ mechanism_id: p.mechanismId, value: p.value, delay_sec: p.delaySec, duration_sec: p.durationSec, carried: p.carried ? 1 : 0 }));
    return resolveSlotMechanisms(snap.mechs.filter(m => m.variant !== 'hoist_rig'), rows, cueId);
  };
}

test('搬成 Cue 庫模式前後：每個 cue 的物件狀態、機關位置、分享連結輸出都一樣；舊模式專案不受影響', async () => {
  const { db, ids } = await buildScenario();
  const before = { p1: await snapshot(db, 'p1'), p2: await snapshot(db, 'p2') };

  // 舊模式：沒有 Cue 庫的欄位；?cuelib=1 只多一個 mode: 'legacy'，其他不變
  for (const p of ['p1', 'p2']) {
    for (const song of SONGS[p]) {
      const d = before[p].cues.get(song);
      for (const c of d.cues) assert.ok(!('libraryCueId' in c) && !('libraryCue' in c), '舊模式的 cue 清單沒有新欄位');
      assert.equal(d.cl.mode, 'legacy');
      assert.deepEqual({ ...d.cl, mode: undefined }, { ...d.stale, mode: undefined });
      assert.ok(!('mode' in d.stale));
      assert.ok(!('mode' in d.sharePos) && d.sharePosCl.mode === 'legacy');
      for (const c of d.shareCues) assert.ok(!('libraryCue' in c));
    }
    assert.ok(!('mode' in before[p].sheet));
    assert.equal(before[p].sheetCl.mode, 'legacy');
    assert.deepEqual({ ...before[p].sheetCl, mode: undefined }, { ...before[p].sheet, mode: undefined });
  }
  const { call } = client(db);
  assert.equal((await call('GET', '/api/projects/p1')).data.project.cueLibrary, false);
  assert.ok((await call('GET', '/api/projects')).data.projects.every(p => p.cueLibrary === false));
  assert.equal(before.p1.mechs.find(m => m.id === ids.m1).cueCount, db.raw.prepare(`SELECT COUNT(*) AS n FROM cue_mechanism_positions WHERE mechanism_id = ?`).get(ids.m1).n);

  // 搬家（搬家程式在本機副本套 SQL、把專案切成 Cue 庫模式）
  const mig = loadExportDb(dumpSql(db.raw));
  const { report } = await runMigration(mig, { projectId: 'p1' });
  assert.equal(report.totalDifferences, 0);
  // 只切 p1：p2 還是舊模式，輸出完全不變
  const afterP2 = await snapshot(mig, 'p2');
  assert.equal(JSON.stringify(afterP2, replacer), JSON.stringify(before.p2, replacer));
  const mc = client(mig).call;
  assert.equal((await mc('GET', '/api/projects/p1')).data.project.cueLibrary, true);
  assert.equal((await mc('GET', '/api/projects/p2')).data.project.cueLibrary, false);
  const listed = (await mc('GET', '/api/projects')).data.projects;
  assert.deepEqual(listed.map(p => [p.id, p.cueLibrary]).sort(), [['p1', true], ['p2', false]]);

  const after = await snapshot(mig, 'p1');
  const libOf = (cueId) => mig.raw.prepare(`SELECT l.id, l.label, l.name FROM library_cues l JOIN cues c ON c.library_cue_id = l.id WHERE c.id = ?`).get(cueId);

  for (const song of SONGS.p1) {
    const b = before.p1.cues.get(song), a = after.cues.get(song);
    // cue 清單：原本的欄位一樣，多 libraryCueId / libraryCue
    assert.ok(a.cues.every(c => c.crossfadeOwn === true), '搬家後現有的轉場都是「這首歌另外設」，值不變');
    assert.deepEqual(a.cues.map(({ libraryCueId, libraryCue, slotName, name, crossfadeOwn, libraryCrossfadeSeconds, ...rest }) => rest), b.cues.map(({ name, ...rest }) => rest));
    // 第 8 階段：name = Cue 庫名稱，cue 自己原本的名字放 slotName
    a.cues.forEach((c, i) => { assert.equal(c.name, c.libraryCue.name); assert.equal(c.slotName, b.cues[i].name); });
    for (const c of a.cues) {
      const lc = libOf(c.id);
      assert.equal(c.libraryCueId, lc.id);
      assert.deepEqual(c.libraryCue, { id: lc.id, label: lc.label, name: lc.name });
    }
    // 分享連結的 cue 清單：libraryCue 只有 {label, name}
    assert.deepEqual(a.shareCues.map(({ libraryCue, slotName, name, ...rest }) => rest), b.shareCues.map(({ name, ...rest }) => rest));
    for (const c of a.shareCues) assert.equal(c.name, c.libraryCue.name);
    for (const c of a.shareCues) assert.deepEqual(c.libraryCue, { label: libOf(c.id).label, name: libOf(c.id).name });

    // 物件狀態：專案和分享連結，每個 cue 都一樣
    assert.deepEqual([...a.perCue.keys()], [...b.perCue.keys()]);
    for (const [cueId, x] of b.perCue) {
      const y = a.perCue.get(cueId);
      assert.deepEqual(norm(y.states), norm(x.states), `cue ${cueId} 物件狀態`);
      assert.deepEqual(norm(y.shareStates), norm(x.shareStates), `cue ${cueId} 分享連結的物件狀態`);
    }

    // 機關位置：?cuelib=1 → mode: 'library'，每個 slot 解出來的值 / 來源 / 時間跟舊模式一樣
    assert.equal(a.cl.mode, 'library');
    assert.ok(a.cl.positions.every(p => 'libraryCueId' in p && typeof p.carried === 'boolean'));
    const lr = libraryResolved(after, song), gr = legacyResolved(before.p1, song);
    for (const c of b.cues) {
      const x = gr(c.id), y = lr(c.id);
      for (const m of before.p1.mechs) {
        if (m.variant === 'hoist_rig') continue;
        for (const f of ['value', 'stored', 'source', 'clamped']) assert.equal(y.row[m.id][f], x.row[m.id][f], `cue ${c.id} 機關 ${m.name} ${f}`);
        assert.deepEqual(y.timings[m.id] ?? null, x.timings[m.id] ?? null);
      }
    }
    // 沒帶 ?cuelib=1（還沒更新的前端）：只給自己設的位置 → 前端自己沿用，答案一樣
    assert.ok(!('mode' in a.stale));
    assert.ok(a.stale.positions.every(p => !('carried' in p)));
    const staleResolved = resolveSongMechanisms(after.mechs, a.cues, ownValuesByCue(a.stale.positions));
    for (const c of b.cues) for (const m of before.p1.mechs) {
      if (m.variant === 'hoist_rig') continue;
      for (const f of ['value', 'stored', 'source']) assert.equal(staleResolved.get(c.id)[m.id][f], gr(c.id).row[m.id][f], `舊前端 cue ${c.id} 機關 ${m.name} ${f}`);
    }
    // 分享連結的機關位置：只有正式 cue，同一套規則
    assert.ok(!('mode' in a.sharePos));
    assert.equal(a.sharePosCl.mode, 'library');
    const masters = new Set(a.shareCues.map(c => c.id));
    assert.ok(a.sharePosCl.positions.every(p => masters.has(p.cueId)));
    assert.ok(a.sharePos.positions.every(p => masters.has(p.cueId) && !('carried' in p)));
    assert.deepEqual(
      a.sharePosCl.positions.filter(p => !p.carried).map(p => [p.cueId, p.mechanismId, p.value]),
      before.p1.cues.get(song).sharePos.positions.map(p => [p.cueId, p.mechanismId, p.value]),
    );
  }

  // 機關總表：mode、libraryCue、每個 slot 的位置
  assert.ok(!('mode' in after.sheet));
  assert.equal(after.sheetCl.mode, 'library');
  assert.deepEqual(after.sheetCl.songs.flatMap(s => s.cues.map(({ libraryCueId, libraryCue, ...rest }) => rest)),
    before.p1.sheet.songs.flatMap(s => s.cues));
  for (const c of after.sheetCl.songs.flatMap(s => s.cues)) assert.equal(c.libraryCue.id, libOf(c.id).id);
  assert.ok(after.sheetCl.positions.every(p => 'carried' in p && 'libraryCueId' in p));
  assert.ok(after.sheet.positions.every(p => !('carried' in p)));
  assert.deepEqual(after.sheetCl.mechanisms.map(m => m.id), before.p1.sheet.mechanisms.map(m => m.id));

  // 機關清單的 cueCount：Cue 庫專案數 Cue 庫的列
  const expected = mig.raw.prepare(`SELECT COUNT(*) AS n FROM library_cue_mechanism_positions WHERE mechanism_id = ?`).get(ids.m1).n;
  assert.equal(after.mechs.find(m => m.id === ids.m1).cueCount, expected);
  assert.ok(expected > 0);
});

test('Cue 庫專案：沒指到 Cue 庫的 cue 當作全部預設', async () => {
  const { db } = await buildScenario();
  const mig = loadExportDb(dumpSql(db.raw));
  await runMigration(mig, { projectId: 'p1' });
  mig.raw.exec(`INSERT INTO cues (id, song_id, name, "order", status) VALUES ('c_new', 's1', '新的', 99, 'master')`);
  const { call } = client(mig);
  const st = (await call('GET', '/api/projects/p1/songs/s1/cues/c_new/states')).data.states;
  assert.equal(st.length, 5);
  assert.ok(st.every(s => !s.tracked && s.override === null));
  assert.equal(st.find(s => s.objectId === 'o_hid').effective.visible, false);              // 預設隱藏
  const n = (await call('GET', '/api/projects/p1/songs/s1/cues')).data.cues.find(c => c.id === 'c_new');
  assert.equal(n.libraryCueId, null);
  assert.equal(n.libraryCue, null);
  const pr = await call('GET', '/api/projects/p1/songs/s1/mechanism-positions?mech=3&cuelib=1'); const pos = pr.data.positions;
  assert.ok(!pos.some(p => p.cueId === 'c_new'));
});
