// 跑法：cd cf-worker && npm test
// 自動貼 UV「不放進畫布」的 LED 在 3D 上一律顯示黑色：後台記下哪些要黑（整個物件 / 物件裡的某一塊 LED），
// 存在 projects.led_off_pieces（migration 0045），套用時寫、換版本時換成那個版本的，網站讀得到。走真的 worker 路由。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';

const BASE = 'https://proxy.test';
const P = '/api/projects/p1';
const C0 = { width: 8800, height: 2024 };
const C1 = { width: 4096, height: 2048 };
const C2 = { width: 2048, height: 2048 };
const K0 = `models/p1/1000-${'a'.repeat(32)}.glb`;
const LEGACY_A = { canvas: C0, screens: [{ key: 'o:oa', dest: { x: 440, y: 202, w: 1760, h: 810 }, rotate: 0, flipH: false, flipV: false }] };

async function setup() {
  const db = freshDb();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_admin', 'a@x.test', '製作', 'admin', 'ADMIN-1'), ('u_dir', 'd@x.test', '王導', 'director', 'DIR-1')`),
    db.prepare(`INSERT INTO projects (id, name, led_canvas, model_r2_key) VALUES ('p1', '巡演', ?, ?)`).bind(JSON.stringify(C0), K0),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", code) VALUES ('s1', 'p1', '開場', 0, 'S01')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order") VALUES
      ('oa', 'p1', 'LED_A', '主牆', 'led_panel', 0), ('ob', 'p1', 'LED_B', '側屏', 'led_panel', 1), ('oc', 'p1', 'LED_C', '提詞LED', 'led_panel', 2), ('ot', 'p1', 'TRUSS', '桁架', 'fixture', 3)`),
    db.prepare(`INSERT INTO song_videos (id, project_id, song_id, source, r2_key, mime, status, version, template_id, template_snapshot) VALUES
      ('v1', 'p1', 's1', 'upload', 'k1', 'video/mp4', 'ready', 1, NULL, NULL)`),
  ]);
  const r2 = memoryR2();
  await r2.put(K0, new Uint8Array([1, 2, 3]), {});
  const env = { DB: db, AUTH_SECRET: 'test-secret', MODELS: r2 };
  const tokens = {};
  for (const [id, code] of [['u_admin', 'ADMIN-1'], ['u_dir', 'DIR-1']]) {
    const r = await worker.fetch(new Request(`${BASE}/api/auth/login`, { method: 'POST', body: JSON.stringify({ accessCode: code }), headers: { 'content-type': 'application/json' } }), env);
    tokens[id] = (await r.json()).token;
  }
  const call = async (method, path, body, raw, who = 'u_admin') => {
    const headers = { authorization: `Bearer ${tokens[who]}`, 'content-type': raw ? 'model/gltf-binary' : 'application/json' };
    const r = await worker.fetch(new Request(BASE + path, { method, headers, body: raw ? raw : body === undefined ? undefined : JSON.stringify(body) }), env);
    let data = null;
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data };
  };
  const cat = async () => Object.fromEntries((await db.prepare(`SELECT id, category FROM stage_objects`).all()).results.map(r => [r.id, r.category]));
  let n = 0;
  const hold = async () => {
    const r = await call('PUT', `${P}/model?hold=1`, undefined, new Uint8Array([9, ++n, 9]));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.key;
  };
  return { db, call, cat, hold };
}

const body = (key, ifActive, extra = {}) => ({ key, ifActive, ledCanvas: C1, note: '自動貼 UV', recipe: { v: 1, surfaces: [] }, legacy: LEGACY_A, ...extra });
const off = async (db) => { const v = (await db.prepare(`SELECT led_off_pieces AS v FROM projects WHERE id = 'p1'`).first()).v; return v === null ? null : JSON.parse(v); };

test('套用時：整個不放進畫布的物件 + 物件裡不放進畫布的那一塊，一起記下；格式不對 / 別人專案的 / 已整個排除的物件的塊不收', async () => {
  const { call, db, hold } = await setup();
  assert.equal(await off(db), null);   // 舊專案：沒有
  const key = await hold();
  const r = await call('POST', `${P}/led-uv/apply`, body(key, K0, {
    excludeObjects: ['oc'],
    recipe: { v: 1, offPieces: ['ob~LED_R', 'oc~LED_X', 'nope~LED_R', 'ob', 5, 'ob~LED_R', 'oa~'], edit: { v: 1 } },
  }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.ledOffPieces, ['oc', 'ob~LED_R']);
  assert.deepEqual(await off(db), ['oc', 'ob~LED_R']);
  const rec = JSON.parse((await db.prepare(`SELECT recipe FROM model_uv_layouts WHERE model_key = ?`).bind(key).first()).recipe);
  assert.deepEqual(rec.offPieces, ['ob~LED_R']);
  // 網站讀專案時拿得到
  const proj = (await call('GET', P)).data.project;
  assert.deepEqual(JSON.parse(proj.led_off_pieces), ['oc', 'ob~LED_R']);
});

test('沒有不放進畫布的塊（舊版前端 / 沒選）：欄位維持沒有，recipe 不多東西', async () => {
  const { call, db, hold } = await setup();
  const key = await hold();
  const r = await call('POST', `${P}/led-uv/apply`, body(key, K0));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await off(db), null);
  const rec = JSON.parse((await db.prepare(`SELECT recipe FROM model_uv_layouts WHERE model_key = ?`).bind(key).first()).recipe);
  assert.equal('offPieces' in rec, false);
});

test('換版本：回到舊版 = 沒有黑的 LED，再換回來 = 又是黑的；回應附上現在的清單', async () => {
  const { call, db, hold } = await setup();
  const key = await hold();
  await call('POST', `${P}/led-uv/apply`, body(key, K0, { recipe: { v: 1, offPieces: ['ob~LED_R'] } }));
  assert.deepEqual(await off(db), ['ob~LED_R']);
  const back = await call('POST', `${P}/model/versions/activate`, { key: K0 });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(await off(db), null);
  assert.deepEqual(back.data.ledOffPieces, []);
  const fwd = await call('POST', `${P}/model/versions/activate`, { key });
  assert.deepEqual(fwd.data.ledOffPieces, ['ob~LED_R']);
  assert.deepEqual(await off(db), ['ob~LED_R']);
});
