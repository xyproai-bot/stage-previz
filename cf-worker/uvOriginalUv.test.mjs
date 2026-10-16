// 跑法：cd cf-worker && npm test
// 自動貼 UV 第 4 階段的後台（0037）：舊版面快照多一個 originalUv（原本的 UV 存在模型的 TEXCOORD_1）、模型版本記住 parent_key，
// 連續套用兩次、來回換版本、再套用一次，舊影片的保護都還在。走真的 worker 路由（node:sqlite 假 D1 + 假 R2）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, applyMigrations, freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import { parsePlan } from '../web/src/lib/ledTemplate.ts';

const BASE = 'https://proxy.test';
const P = '/api/projects/p1';
const C0 = { width: 8800, height: 2024 };
const C1 = { width: 9216, height: 3072 };
const C2 = { width: 8192, height: 4096 };
const K0 = `models/p1/1000-${'a'.repeat(32)}.glb`;

test('migration 0037：加一個欄位（parent_key），舊資料不動；舊的紀錄 parent_key = NULL', async () => {
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0037' });
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name, led_canvas, model_r2_key) VALUES ('p', 'P', '{"width":100,"height":100}', 'models/p/1.glb')`),
    db.prepare(`INSERT INTO model_uv_layouts (project_id, model_key, led_canvas, note, legacy_template_id, legacy_plan, stamped_videos) VALUES ('p', 'models/p/1.glb', '{"width":100,"height":100}', '舊的', 'lt_x', '{}', '["v1"]')`),
  ]);
  applyMigrations(db, { only: '0037' });
  const row = await db.prepare(`SELECT * FROM model_uv_layouts`).first();
  assert.equal(row.parent_key, null);
  assert.equal(row.note, '舊的');
  assert.equal(row.legacy_template_id, 'lt_x');
  assert.equal(row.stamped_videos, '["v1"]');
  await db.prepare(`UPDATE model_uv_layouts SET parent_key = 'models/p/0.glb' WHERE project_id = 'p'`).run();
  assert.equal((await db.prepare(`SELECT parent_key FROM model_uv_layouts`).first()).parent_key, 'models/p/0.glb');
});

async function setup() {
  const db = freshDb();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_admin', 'a@x.test', '製作', 'admin', 'ADMIN-1')`),
    db.prepare(`INSERT INTO projects (id, name, led_canvas, model_r2_key) VALUES ('p1', '巡演', ?, ?)`).bind(JSON.stringify(C0), K0),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", code) VALUES ('s1', 'p1', '開場', 0, 'S01')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order") VALUES
      ('oa', 'p1', 'LED_A', '主牆', 'led_panel', 0), ('ob', 'p1', 'LED_B', '側屏', 'led_panel', 1), ('ot', 'p1', 'TRUSS', '桁架', 'fixture', 2)`),
    // A 組：做給原本的 UV（NULL = 套用前的整張畫布）
    db.prepare(`INSERT INTO song_videos (id, project_id, song_id, source, r2_key, mime, status, version, template_id, template_snapshot) VALUES
      ('a1', 'p1', 's1', 'upload', 'k1', 'video/mp4', 'ready', 1, NULL, NULL),
      ('a2', 'p1', 's1', 'upload', 'k2', 'video/mp4', 'ready', 2, NULL, NULL)`),
  ]);
  const r2 = memoryR2();
  await r2.put(K0, new Uint8Array([1, 2, 3]), {});
  const env = { DB: db, AUTH_SECRET: 'test-secret', MODELS: r2 };
  const login = await worker.fetch(new Request(`${BASE}/api/auth/login`, { method: 'POST', body: JSON.stringify({ accessCode: 'ADMIN-1' }), headers: { 'content-type': 'application/json' } }), env);
  const token = (await login.json()).token;
  const call = async (method, path, body, raw) => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': raw ? 'model/gltf-binary' : 'application/json' };
    const r = await worker.fetch(new Request(BASE + path, { method, headers, body: raw ? raw : body === undefined ? undefined : JSON.stringify(body) }), env);
    let data = null;
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data };
  };
  return { db, call };
}

const hold = async (call, n) => {
  const r = await call('PUT', `${P}/model?hold=1`, undefined, new Uint8Array([n, n, n]));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.key;
};
const SCREEN = (key, x = 0) => ({ key, dest: { x, y: 0, w: 100, h: 50 }, rotate: 0, flipH: false, flipV: false });
const applyOn = (call, key, ifActive, canvas, legacy) => call('POST', `${P}/led-uv/apply`, { key, ifActive, ledCanvas: canvas, note: 'x', recipe: { v: 1 }, legacy });
const activate = (call, key) => call('POST', `${P}/model/versions/activate`, { key });
const stateOf = async (db) => Object.fromEntries((await db.prepare(`SELECT id, template_id FROM song_videos ORDER BY id`).all()).results.map(v => [v.id, v.template_id]));
const addVideo = (db, id, version) => db.prepare(`INSERT INTO song_videos (id, project_id, song_id, source, r2_key, mime, status, version) VALUES (?, 'p1', 's1', 'upload', ?, 'video/mp4', 'ready', ?)`).bind(id, 'k' + id, version).run();
const tplIdOf = async (db, name) => (await db.prepare(`SELECT id FROM led_templates WHERE name = ?`).bind(name).first()).id;

test('originalUv：舊版面的快照多一個清單（只有套用時列出來的物件）；舊版前端看 screens 照舊；格式檢查', async () => {
  const { call, db } = await setup();
  const key = await hold(call, 1);
  const post = (legacy) => applyOn(call, key, K0, C1, legacy);
  // 物件找不到 / 太多 / 不是字串 → 400，什麼都沒變
  assert.equal((await post({ canvas: C0, screens: [SCREEN('o:oa')], originalUv: ['nope'] })).status, 400);
  assert.equal((await post({ canvas: C0, screens: [SCREEN('o:oa')], originalUv: [5] })).status, 400);
  assert.equal((await post({ canvas: C0, screens: [SCREEN('o:oa')], originalUv: Array.from({ length: 201 }, () => 'oa') })).status, 400);
  assert.equal((await db.prepare(`SELECT model_r2_key FROM projects`).first()).model_r2_key, K0);
  // 沒帶 originalUv（舊版前端）：快照跟以前一模一樣，沒有這個欄位
  const old = await post({ canvas: C0, screens: [SCREEN('o:oa')] });
  assert.equal(old.status, 200, JSON.stringify(old.data));
  const snapOld = JSON.parse((await db.prepare(`SELECT template_snapshot FROM song_videos WHERE id = 'a1'`).first()).template_snapshot);
  assert.equal('originalUv' in snapOld, false);
  assert.equal(parsePlan(snapOld).originalUv, undefined);
  // 帶著：存進快照，重複的合併；影片 API 帶得出來
  const { call: call2, db: db2 } = await setup();
  const k2 = await hold(call2, 2);
  const ok = await applyOn(call2, k2, K0, C1, { canvas: C0, screens: [SCREEN('o:oa')], originalUv: ['oa', 'ob', 'oa'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const snap = parsePlan((await db2.prepare(`SELECT template_snapshot FROM song_videos WHERE id = 'a1'`).first()).template_snapshot);
  assert.deepEqual(snap.originalUv, ['oa', 'ob']);
  assert.equal(snap.screens.length, 1);
  const vids = await call2('GET', `${P}/songs/s1/videos`);
  assert.equal(vids.status, 200, JSON.stringify(vids.data));
  assert.deepEqual(parsePlan(vids.data.videos.find(v => v.id === 'a1').template).originalUv, ['oa', 'ob']);
  assert.equal((await db2.prepare(`SELECT parent_key FROM model_uv_layouts WHERE model_key = ?`).bind(k2).first()).parent_key, K0);
});

test('沒有長方形可放（原本的畫面橫跨畫布邊緣）但有 originalUv：照樣建舊版面、蓋上舊影片（保護靠第二組 UV）', async () => {
  const { call, db } = await setup();
  const key = await hold(call, 1);
  const r = await applyOn(call, key, K0, C1, { canvas: C0, screens: [], originalUv: ['oa'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.stampedVideos, 2);
  const snap = parsePlan((await db.prepare(`SELECT template_snapshot FROM song_videos WHERE id = 'a1'`).first()).template_snapshot);
  assert.deepEqual(snap.originalUv, ['oa']);
  assert.equal(snap.screens.length, 0);
  // 都沒有（沒螢幕、沒清單）= 沒有舊版面，跟以前一樣
  const { call: c2, db: d2 } = await setup();
  const k2 = await hold(c2, 2);
  const none = await applyOn(c2, k2, K0, C1, { canvas: C0, screens: [], originalUv: [] });
  assert.equal(none.status, 200);
  assert.equal(none.data.legacyTemplateId, null);
  assert.equal((await d2.prepare(`SELECT template_id FROM song_videos WHERE id = 'a1'`).first()).template_id, null);
});

test('連續套用兩次 + 來回換版本：v0 → v1 → v2 → v1 → v0 → v2 → v1 → v2，每一步舊影片的保護都對', async () => {
  const { call, db } = await setup();
  const K1 = await hold(call, 1);
  assert.equal((await applyOn(call, K1, K0, C1, { canvas: C0, screens: [SCREEN('o:oa')], originalUv: ['oa'] })).status, 200);
  const L1 = await tplIdOf(db, '舊版面');
  // v1 使用中：新傳一個影片（做給 v1 的 UV）
  await addVideo(db, 'b1', 3);
  const K2 = await hold(call, 2);
  const second = await applyOn(call, K2, K1, C2, { canvas: C1, screens: [SCREEN('o:oa', 5)] });
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal(second.data.stampedVideos, 1);
  const L2 = await tplIdOf(db, '舊版面 2');
  const rows = Object.fromEntries((await db.prepare(`SELECT * FROM model_uv_layouts`).all()).results.map(r => [r.model_key, r]));
  assert.equal(rows[K1].parent_key, K0);
  assert.equal(rows[K2].parent_key, K1);
  assert.equal(rows[K0].parent_key, null);

  // v2：A 組 = 舊版面（做給 v0），B = 舊版面 2（做給 v1）
  assert.deepEqual(await stateOf(db), { a1: L1, a2: L1, b1: L2 });
  // v1：B 還原成新畫布（做給 v1），A 照舊
  assert.equal((await activate(call, K1)).status, 200);
  assert.deepEqual(await stateOf(db), { a1: L1, a2: L1, b1: null });
  // v0：A 還原（做給 v0）
  const back0 = await activate(call, K0);
  assert.equal(back0.status, 200);
  assert.deepEqual(back0.data.ledCanvas, C0);
  assert.deepEqual(await stateOf(db), { a1: null, a2: null, b1: null });
  // 直接從 v0 跳到 v2：A、B 都要重新套上（以前只套 B，A 就沒保護了）
  const jump = await activate(call, K2);
  assert.equal(jump.status, 200);
  assert.deepEqual(jump.data.ledCanvas, C2);
  assert.deepEqual(await stateOf(db), { a1: L1, a2: L1, b1: L2 });
  // v2 → v1 → v2 再來一輪：從 v1 往前到 v2 不能把 A 還原掉（以前的另一個洞）
  assert.equal((await activate(call, K1)).status, 200);
  assert.deepEqual(await stateOf(db), { a1: L1, a2: L1, b1: null });
  assert.equal((await activate(call, K2)).status, 200);
  assert.deepEqual(await stateOf(db), { a1: L1, a2: L1, b1: L2 });
  // 快照內容：A 的帶著 originalUv，B 的沒有
  const snaps = Object.fromEntries((await db.prepare(`SELECT id, template_snapshot FROM song_videos`).all()).results.map(v => [v.id, parsePlan(v.template_snapshot)]));
  assert.deepEqual(snaps.a1.originalUv, ['oa']);
  assert.equal(snaps.b1.originalUv, undefined);
  assert.deepEqual(snaps.b1.canvas, C1);
});

test('使用者自己換過版型的影片、有版型的影片：來回換版本都不動', async () => {
  const { call, db } = await setup();
  await db.prepare(`INSERT INTO led_templates (id, project_id, name, kind, canvas_w, canvas_h) VALUES ('lt_mine', 'p1', '我的版型', 'custom', 1920, 1080)`).run();
  const K1 = await hold(call, 1);
  await applyOn(call, K1, K0, C1, { canvas: C0, screens: [SCREEN('o:oa')] });
  const L1 = await tplIdOf(db, '舊版面');
  // 套用以後，製作把 a2 改成自己的版型
  await db.prepare(`UPDATE song_videos SET template_id = 'lt_mine', template_snapshot = '{"v":1,"id":"lt_mine","name":"我的版型","canvas":{"width":1920,"height":1080},"scalePct":100,"screens":[]}' WHERE id = 'a2'`).run();
  await activate(call, K0);
  assert.deepEqual(await stateOf(db), { a1: null, a2: 'lt_mine' });
  await activate(call, K1);
  assert.deepEqual(await stateOf(db), { a1: L1, a2: 'lt_mine' });
});

test('回到舊版再套用一次（分支）：新的一版從舊版接出去，兩邊各自的保護互不干擾', async () => {
  const { call, db } = await setup();
  const K1 = await hold(call, 1);
  await applyOn(call, K1, K0, C1, { canvas: C0, screens: [SCREEN('o:oa')], originalUv: ['oa'] });
  const L1 = await tplIdOf(db, '舊版面');
  assert.equal((await activate(call, K0)).status, 200);
  assert.deepEqual(await stateOf(db), { a1: null, a2: null });
  // 在 v0 上重新套用一次（不同的排法）：A 組又是 NULL，被新的舊版面蓋上
  const K1b = await hold(call, 3);
  const again = await applyOn(call, K1b, K0, C2, { canvas: C0, screens: [SCREEN('o:oa', 9)], originalUv: ['oa'] });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.legacyTemplateName, '舊版面 2');
  const L1b = await tplIdOf(db, '舊版面 2');
  assert.deepEqual(await stateOf(db), { a1: L1b, a2: L1b });
  assert.equal((await db.prepare(`SELECT parent_key FROM model_uv_layouts WHERE model_key = ?`).bind(K1b).first()).parent_key, K0);
  // 在兩個分支之間換：離開的分支還原、進去的分支套上
  assert.equal((await activate(call, K1)).status, 200);
  assert.deepEqual(await stateOf(db), { a1: L1, a2: L1 });
  assert.equal((await activate(call, K1b)).status, 200);
  assert.deepEqual(await stateOf(db), { a1: L1b, a2: L1b });
});

test('沒有 parent_key 的舊紀錄（第 4 階段以前套用的）：行為跟以前一樣，只看自己這一筆', async () => {
  const { call, db } = await setup();
  const K1 = await hold(call, 1);
  await applyOn(call, K1, K0, C1, { canvas: C0, screens: [SCREEN('o:oa')] });
  const L1 = await tplIdOf(db, '舊版面');
  await db.prepare(`UPDATE model_uv_layouts SET parent_key = NULL`).run();
  assert.equal((await activate(call, K0)).status, 200);
  assert.deepEqual(await stateOf(db), { a1: null, a2: null });
  assert.equal((await activate(call, K1)).status, 200);
  assert.deepEqual(await stateOf(db), { a1: L1, a2: L1 });
});

test('刪掉中間的版本：從它套用出來的版本改接到它的上一版；壓縮（一般上傳）沿用 parent_key', async () => {
  const { call, db } = await setup();
  const K1 = await hold(call, 1);
  await applyOn(call, K1, K0, C1, { canvas: C0, screens: [SCREEN('o:oa')] });
  const K2 = await hold(call, 2);
  await applyOn(call, K2, K1, C2, { canvas: C1, screens: [SCREEN('o:oa')] });
  const parentOf = async (k) => (await db.prepare(`SELECT parent_key FROM model_uv_layouts WHERE model_key = ?`).bind(k).first())?.parent_key;
  // 目前使用 v2，刪掉 v1（不是使用中的）
  const file = K1.split('/').pop();
  const del = await call('DELETE', `${P}/model/versions/${file}`);
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal(await parentOf(K2), K0);
  assert.equal(await parentOf(K1), undefined);
  // 壓縮（一般上傳）：新的一版沿用 v2 的紀錄，parent 也一樣
  const up = await call('PUT', `${P}/model`, undefined, new Uint8Array([7, 7, 7]));
  assert.equal(up.status, 200);
  assert.equal(await parentOf(up.data.key), K0);
});
