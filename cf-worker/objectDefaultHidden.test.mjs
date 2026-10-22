// 跑法：cd cf-worker && npm test
// 物件「預設隱藏」（0040）：每個物件一個旗標，沒有任何 cue 設過顯示 / 隱藏的歌，這個物件是隱藏的；cue 裡明確設成顯示的照樣顯示。
// 走真的 worker 路由（node:sqlite 假 D1）。重點：舊資料（0 = 照以前）不變、只有製作能改、cue 狀態算對、
// 「所有 cue 回到預設」之後預設隱藏的物件是隱藏的、複製專案 / 匯出匯入 / 分享連結都帶著。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, applyMigrations, freshDb } from './testing/d1-sqlite.mjs';
import worker from './worker.js';

const BASE = 'https://proxy.test';
const P = '/api/projects/p1';
const SHARE = 'tk_legacy_0000000000000000000000';

test('migration 0040：加一個欄位，舊物件都是 0（跟以前一樣）；舊的寫法（沒帶這個欄位）照樣能新增', async () => {
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0040' });
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p', 'P')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category) VALUES ('so_old', 'p', 'RIBBON', '瞬掉緞帶', 'other')`),
  ]);
  applyMigrations(db, { only: '0040' });
  assert.equal((await db.prepare(`SELECT default_hidden FROM stage_objects WHERE id = 'so_old'`).first()).default_hidden, 0);
  await db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name) VALUES ('so_new', 'p', 'X')`).run();
  assert.equal((await db.prepare(`SELECT default_hidden FROM stage_objects WHERE id = 'so_new'`).first()).default_hidden, 0);
});

async function setup() {
  const db = freshDb();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_admin', 'a@x.test', '製作', 'admin', 'ADMIN-1'), ('u_dir', 'd@x.test', '王導', 'director', 'DIR-1')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '巡演')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", code) VALUES ('s1', 'p1', '開場', 0, 'S01'), ('s2', 'p1', '安可', 1, 'S02')`),
    db.prepare(`INSERT INTO cues (id, song_id, name, "order", status) VALUES ('c1', 's1', '亮燈', 0, 'master'), ('c2', 's1', '緞帶掉', 1, 'master'), ('c3', 's1', '收尾', 2, 'master'), ('d1', 's2', '安可 1', 0, 'master'), ('d2', 's2', '安可 2', 1, 'master')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order") VALUES
      ('o_rib', 'p1', 'RIBBON', '瞬掉緞帶', 'other', 0), ('o_led', 'p1', 'LED_A', '主牆', 'led_panel', 1)`),
    db.prepare(`INSERT INTO share_links (token, project_id, label) VALUES (?, 'p1', '分享')`).bind(SHARE),
  ]);
  const env = { DB: db, AUTH_SECRET: 'test-secret' };
  const tokens = {};
  for (const [id, code] of [['u_admin', 'ADMIN-1'], ['u_dir', 'DIR-1']]) {
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
  const visible = async (song, cue, obj = 'o_rib', who = 'u_admin') => (await call(who, 'GET', `${P}/songs/${song}/cues/${cue}/states`)).data.states.find(s => s.objectId === obj).effective.visible;
  return { db, env, call, visible };
}

test('物件清單：每個物件有 defaultHidden（舊的 = false）；只有製作能改；改了寫進活動紀錄', async () => {
  const { call, db } = await setup();
  const list = (await call('u_admin', 'GET', `${P}/stage-objects`)).data.stageObjects;
  assert.deepEqual(list.map(o => [o.id, o.defaultHidden]), [['o_rib', false], ['o_led', false]]);
  assert.equal((await call('u_dir', 'PATCH', `${P}/stage-objects/o_rib`, { defaultHidden: true })).status, 403);
  assert.equal((await call('u_admin', 'PATCH', `${P}/stage-objects/o_rib`, { defaultHidden: true })).status, 200);
  const after = (await call('u_dir', 'GET', `${P}/stage-objects`)).data.stageObjects;      // 導演看得到
  assert.equal(after.find(o => o.id === 'o_rib').defaultHidden, true);
  assert.equal(after.find(o => o.id === 'o_led').defaultHidden, false);
  const log = (await db.prepare(`SELECT action, payload FROM activity_log WHERE target_id = 'o_rib'`).all()).results;
  assert.ok(log.some(l => l.action === 'update' && l.payload.includes('defaultHidden')));
  // 其他欄位照舊能改，不會把旗標洗掉
  await call('u_admin', 'PATCH', `${P}/stage-objects/o_rib`, { displayName: '緞帶' });
  assert.equal((await call('u_admin', 'GET', `${P}/stage-objects`)).data.stageObjects.find(o => o.id === 'o_rib').defaultHidden, true);
  // 關掉
  await call('u_admin', 'PATCH', `${P}/stage-objects/o_rib`, { defaultHidden: false });
  assert.equal((await call('u_admin', 'GET', `${P}/stage-objects`)).data.stageObjects.find(o => o.id === 'o_rib').defaultHidden, false);
  // 新增物件時可以直接帶
  const created = await call('u_admin', 'POST', `${P}/stage-objects`, { meshName: 'NEW', category: 'other', defaultHidden: true });
  assert.equal(created.status, 201);
  assert.equal((await call('u_admin', 'GET', `${P}/stage-objects`)).data.stageObjects.find(o => o.id === created.data.id).defaultHidden, true);
});

test('cue 狀態：沒有預設隱藏 = 以前一樣全部顯示；打開預設隱藏 → 沒設過顯示的歌全部隱藏', async () => {
  const { call, visible } = await setup();
  for (const [s, c] of [['s1', 'c1'], ['s1', 'c3'], ['s2', 'd1']]) assert.equal(await visible(s, c), true);
  await call('u_admin', 'PATCH', `${P}/stage-objects/o_rib`, { defaultHidden: true });
  for (const [s, c] of [['s1', 'c1'], ['s1', 'c3'], ['s2', 'd1'], ['s2', 'd2']]) assert.equal(await visible(s, c), false);
  // 回應也告訴畫面這個物件是預設隱藏
  const st = (await call('u_admin', 'GET', `${P}/songs/s2/cues/d1/states`)).data.states;
  assert.equal(st.find(s => s.objectId === 'o_rib').defaultHidden, true);
  assert.equal(st.find(s => s.objectId === 'o_led').defaultHidden, false);
  assert.equal(st.find(s => s.objectId === 'o_led').effective.visible, true);
});

test('第 1 首歌的 cue 裡明確設成顯示 → 後面的 cue 沿用顯示；第 2 首歌沒設 → 隱藏；明確設定永遠優先', async () => {
  const { call, visible } = await setup();
  await call('u_admin', 'PATCH', `${P}/stage-objects/o_rib`, { defaultHidden: true });
  // 第 1 首歌第 1 個 cue 把緞帶設成顯示；第 2 個 cue 只調位置（顯示沒碰）；第 3 個 cue 沒設
  assert.equal((await call('u_admin', 'PUT', `${P}/songs/s1/cues/c1/states/o_rib`, { visible: true })).status, 201);
  assert.equal((await call('u_admin', 'PUT', `${P}/songs/s1/cues/c2/states/o_rib`, { position: { x: 0, y: 3, z: 0 } })).status, 201);
  assert.equal(await visible('s1', 'c1'), true);
  assert.equal(await visible('s1', 'c2'), true);
  assert.equal(await visible('s1', 'c3'), true);
  assert.equal(await visible('s2', 'd1'), false);
  assert.equal(await visible('s2', 'd2'), false);
  // 第 3 個 cue 明確隱藏（瞬掉）→ 隱藏；第 2 首歌不受影響
  await call('u_admin', 'PUT', `${P}/songs/s1/cues/c3/states/o_rib`, { visible: false });
  assert.equal(await visible('s1', 'c3'), false);
  assert.equal(await visible('s1', 'c1'), true);
  // 第 2 首歌第 2 個 cue 明確顯示 → 那個 cue 才顯示
  await call('u_admin', 'PUT', `${P}/songs/s2/cues/d2/states/o_rib`, { visible: true });
  assert.equal(await visible('s2', 'd1'), false);
  assert.equal(await visible('s2', 'd2'), true);
  // 單一物件重置（刪掉這個 cue 的設定）→ 回到預設隱藏
  await call('u_admin', 'DELETE', `${P}/songs/s2/cues/d2/states/o_rib`);
  assert.equal(await visible('s2', 'd2'), false);
});

test('「所有 cue 回到預設」之後：預設隱藏的物件是隱藏的，沒有預設隱藏的是顯示；復原寫回去以後明確設定又回來', async () => {
  const { call, visible } = await setup();
  await call('u_admin', 'PATCH', `${P}/stage-objects/o_rib`, { defaultHidden: true });
  await call('u_admin', 'PUT', `${P}/songs/s1/cues/c1/states/o_rib`, { visible: true });
  await call('u_admin', 'PUT', `${P}/songs/s1/cues/c1/states/o_led`, { visible: false });
  assert.equal(await visible('s1', 'c3'), true);
  assert.equal(await visible('s1', 'c3', 'o_led'), false);
  const cleared = await call('u_admin', 'POST', `${P}/songs/s1/cue-object-states/clear`, {});
  assert.equal(cleared.data.removed, 2);
  // 全部回到預設：緞帶（預設隱藏）隱藏；主牆（沒有預設隱藏）顯示
  for (const c of ['c1', 'c2', 'c3']) {
    assert.equal(await visible('s1', c), false);
    assert.equal(await visible('s1', c, 'o_led'), true);
  }
  // 復原
  assert.equal((await call('u_admin', 'POST', `${P}/songs/s1/cue-object-states/restore`, { states: cleared.data.states })).status, 200);
  assert.equal(await visible('s1', 'c3'), true);
  assert.equal(await visible('s1', 'c3', 'o_led'), false);
});

test('複製專案、匯出再匯入：預設隱藏跟著走；舊的匯出檔（沒有這個欄位）照樣能匯入，都是 0', async () => {
  const { call, db } = await setup();
  await call('u_admin', 'PATCH', `${P}/stage-objects/o_rib`, { defaultHidden: true });
  const dup = await call('u_admin', 'POST', `${P}/duplicate`, { newName: '複本' });
  assert.equal(dup.status, 201);
  const dupObjs = (await call('u_admin', 'GET', `/api/projects/${dup.data.id}/stage-objects`)).data.stageObjects;
  assert.deepEqual(dupObjs.map(o => [o.meshName, o.defaultHidden]), [['RIBBON', true], ['LED_A', false]]);
  // 複製出來的專案：沒設過顯示的歌，緞帶也是隱藏的
  const dupSong = (await call('u_admin', 'GET', `/api/projects/${dup.data.id}/songs`)).data.songs[0];
  const dupCue = (await call('u_admin', 'GET', `/api/projects/${dup.data.id}/songs/${dupSong.id}/cues`)).data.cues[0];
  const dupStates = (await call('u_admin', 'GET', `/api/projects/${dup.data.id}/songs/${dupSong.id}/cues/${dupCue.id}/states`)).data.states;
  assert.equal(dupStates.find(s => s.meshName === 'RIBBON').effective.visible, false);

  const exported = (await call('u_admin', 'GET', `${P}/export`)).data;
  assert.equal(exported.stageObjects.find(o => o.mesh_name === 'RIBBON').default_hidden, 1);
  const imported = await call('u_admin', 'POST', '/api/projects/import', { ...exported, newName: '匯入的' });
  assert.equal(imported.status, 201, JSON.stringify(imported.data));
  const impObjs = (await call('u_admin', 'GET', `/api/projects/${imported.data.id}/stage-objects`)).data.stageObjects;
  assert.deepEqual(impObjs.map(o => [o.meshName, o.defaultHidden]), [['RIBBON', true], ['LED_A', false]]);
  // 舊的匯出檔：沒有 default_hidden
  const old = { ...exported, stageObjects: exported.stageObjects.map(({ default_hidden, ...rest }) => rest) };
  const importedOld = await call('u_admin', 'POST', '/api/projects/import', { ...old, newName: '舊檔' });
  assert.equal(importedOld.status, 201);
  const oldObjs = (await call('u_admin', 'GET', `/api/projects/${importedOld.data.id}/stage-objects`)).data.stageObjects;
  assert.ok(oldObjs.every(o => o.defaultHidden === false));
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM stage_objects WHERE default_hidden = 1`).first()).n, 3);
});

test('分享連結：看到的物件清單有 defaultHidden，cue 的位置（含顯示）跟製作看到的一樣', async () => {
  const { call } = await setup();
  await call('u_admin', 'PATCH', `${P}/stage-objects/o_rib`, { defaultHidden: true });
  await call('u_admin', 'PUT', `${P}/songs/s1/cues/c1/states/o_rib`, { visible: true });
  const data = (await call(null, 'GET', `/api/share/${SHARE}/data`)).data;
  assert.equal(data.stageObjects.find(o => o.id === 'o_rib').defaultHidden, true);
  assert.equal(data.stageObjects.find(o => o.id === 'o_led').defaultHidden, false);
  const st = async (song, cue) => (await call(null, 'GET', `/api/share/${SHARE}/songs/${song}/cues/${cue}/states`)).data.states.find(s => s.objectId === 'o_rib').effective.visible;
  assert.equal(await st('s1', 'c3'), true);
  assert.equal(await st('s2', 'd1'), false);
});
