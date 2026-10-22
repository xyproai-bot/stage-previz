// 跑法：cd cf-worker && npm test
// 自動貼 UV 的「不放進畫布」：套用時，選了「不放進畫布」的 LED 物件的類型從「LED 面板」改成「其他」，跟模型、畫布、舊版面在同一個交易裡；
// 換版本（回到舊版 / 再換回來）時，類型跟著版本走。沒有新的 migration（記在 recipe.excludedObjects）。走真的 worker 路由（node:sqlite 假 D1 + 假 R2）。
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

test('套用時：不放進畫布的物件類型改成「其他」，別的不動；模型、畫布、舊版面照常；回應列出改了誰', async () => {
  const { call, db, cat, hold } = await setup();
  const key = await hold();
  const r = await call('POST', `${P}/led-uv/apply`, body(key, K0, { excludeObjects: ['oc'] }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.excludedObjects, ['oc']);
  assert.deepEqual(await cat(), { oa: 'led_panel', ob: 'led_panel', oc: 'other', ot: 'fixture' });
  // 模型、畫布、舊版面、舊影片的保護都還在
  const proj = await db.prepare(`SELECT model_r2_key, led_canvas FROM projects WHERE id = 'p1'`).first();
  assert.equal(proj.model_r2_key, key);
  assert.deepEqual(JSON.parse(proj.led_canvas), C1);
  assert.equal(r.data.legacyTemplateName, '舊版面');
  assert.equal(r.data.stampedVideos, 1);
  // 記在版本紀錄的 recipe 裡（後台寫的）；前端自己塞的 excludedObjects 不算
  const rec = JSON.parse((await db.prepare(`SELECT recipe FROM model_uv_layouts WHERE model_key = ?`).bind(key).first()).recipe);
  assert.deepEqual(rec.excludedObjects, ['oc']);
  assert.equal(rec.v, 1);
  // 活動紀錄看得到類型被改了
  const logs = (await db.prepare(`SELECT action, target_type, payload FROM activity_log WHERE target_id = 'oc'`).all()).results;
  assert.ok(logs.some(l => l.action === 'update' && l.target_type === 'stage_object' && l.payload.includes('提詞LED') && l.payload.includes('other')));
  // 物件清單 API 讀得到新類型
  const objs = (await call('GET', `${P}/stage-objects`)).data.stageObjects;
  assert.equal(objs.find(o => o.id === 'oc').category, 'other');
});

test('沒帶 excludeObjects（舊版前端 / 沒選）：跟以前完全一樣，沒有類型被改；recipe 不多東西', async () => {
  const { call, db, cat, hold } = await setup();
  const key = await hold();
  const r = await call('POST', `${P}/led-uv/apply`, body(key, K0, { recipe: { v: 1, excludedObjects: ['ob'] } }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.excludedObjects, []);
  assert.deepEqual(await cat(), { oa: 'led_panel', ob: 'led_panel', oc: 'led_panel', ot: 'fixture' });
  const rec = JSON.parse((await db.prepare(`SELECT recipe FROM model_uv_layouts WHERE model_key = ?`).bind(key).first()).recipe);
  assert.equal('excludedObjects' in rec, false);   // 前端塞的不收
});

test('欄位檢查：格式不對 / 不是 LED 面板 / 找不到 / 又被拿去切螢幕或放進舊版面 → 擋下，什麼都沒變', async () => {
  const { call, db, cat, hold } = await setup();
  const key = await hold();
  const post = (extra) => call('POST', `${P}/led-uv/apply`, body(key, K0, extra));
  assert.equal((await post({ excludeObjects: 'oc' })).status, 400);
  assert.equal((await post({ excludeObjects: [5] })).status, 400);
  assert.equal((await post({ excludeObjects: Array.from({ length: 201 }, (_, i) => `x${i}`) })).status, 400);
  assert.equal((await post({ excludeObjects: ['ot'] })).status, 404);      // 桁架不是 LED 面板
  assert.equal((await post({ excludeObjects: ['nope'] })).status, 404);
  assert.equal((await post({ excludeObjects: ['oa'] })).status, 400);      // 舊版面還用到 oa
  assert.equal((await post({ excludeObjects: ['oa'], legacy: { canvas: C0, screens: [], originalUv: ['oa'] } })).status, 400);
  assert.equal((await post({ excludeObjects: ['oc'], pieceScreens: [{ ref: 'r', objectId: 'oc', name: 'x', uv: [0, 0, 0.5, 0.5] }] })).status, 400);
  assert.deepEqual(await cat(), { oa: 'led_panel', ob: 'led_panel', oc: 'led_panel', ot: 'fixture' });
  assert.equal((await db.prepare(`SELECT model_r2_key FROM projects WHERE id = 'p1'`).first()).model_r2_key, K0);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM model_uv_layouts`).first()).n, 0);
});

test('權限：導演不能套用（也就不能把物件類型改掉）', async () => {
  const { call, cat, hold } = await setup();
  const key = await hold();
  const r = await call('POST', `${P}/led-uv/apply`, body(key, K0, { excludeObjects: ['oc'] }), undefined, 'u_dir');
  assert.equal(r.status, 403);
  assert.equal((await cat()).oc, 'led_panel');
});

test('交易：套用失敗（資料庫拒絕）→ 類型也沒改', async () => {
  const { call, db, cat, hold } = await setup();
  const key = await hold();
  // 讓 model_uv_layouts 的寫入失敗：先塞一筆同 key 但 project 不存在的外鍵衝突不好做，改用已存在版本紀錄 + 觸發器擋掉
  await db.prepare(`CREATE TRIGGER block_apply BEFORE INSERT ON model_uv_layouts WHEN NEW.note = '擋掉' BEGIN SELECT RAISE(ABORT, 'blocked'); END`).run();
  const r = await call('POST', `${P}/led-uv/apply`, body(key, K0, { excludeObjects: ['oc'], note: '擋掉' }));
  assert.equal(r.status, 400);
  assert.deepEqual(await cat(), { oa: 'led_panel', ob: 'led_panel', oc: 'led_panel', ot: 'fixture' });
  assert.equal((await db.prepare(`SELECT model_r2_key FROM projects WHERE id = 'p1'`).first()).model_r2_key, K0);
});

test('換版本：回到舊版 → 類型改回 LED 面板；再換回新版 → 再改成其他；回應說類型有變', async () => {
  const { call, cat, hold } = await setup();
  const key = await hold();
  assert.equal((await call('POST', `${P}/led-uv/apply`, body(key, K0, { excludeObjects: ['oc'] }))).status, 200);
  assert.equal((await cat()).oc, 'other');

  const back = await call('POST', `${P}/model/versions/activate`, { key: K0 });
  assert.equal(back.status, 200);
  assert.equal(back.data.objectTypesChanged, true);
  assert.deepEqual(await cat(), { oa: 'led_panel', ob: 'led_panel', oc: 'led_panel', ot: 'fixture' });

  const fwd = await call('POST', `${P}/model/versions/activate`, { key });
  assert.equal(fwd.data.objectTypesChanged, true);
  assert.deepEqual(await cat(), { oa: 'led_panel', ob: 'led_panel', oc: 'other', ot: 'fixture' });

  // 同一版再按一次「換成這一版」不動
  const same = await call('POST', `${P}/model/versions/activate`, { key });
  assert.equal(same.data.objectTypesChanged, false);
});

test('換版本：製作之後手動改過類型的不碰（回舊版時它已經是 LED 面板；再換回新版時它本來就不是 LED 面板的不亂改）', async () => {
  const { call, db, cat, hold } = await setup();
  const key = await hold();
  await call('POST', `${P}/led-uv/apply`, body(key, K0, { excludeObjects: ['oc'] }));
  // 製作自己把它改回 LED 面板，又把 ob 手動改成別的類型
  await db.prepare(`UPDATE stage_objects SET category = 'led_panel' WHERE id = 'oc'`).run();
  await db.prepare(`UPDATE stage_objects SET category = 'fixture' WHERE id = 'ob'`).run();
  await call('POST', `${P}/model/versions/activate`, { key: K0 });
  assert.deepEqual(await cat(), { oa: 'led_panel', ob: 'fixture', oc: 'led_panel', ot: 'fixture' });
  // 製作在舊版上把 oc 改成「走位點」；換回新版時 oc 不是 LED 面板，不動它
  await db.prepare(`UPDATE stage_objects SET category = 'walk_point' WHERE id = 'oc'`).run();
  await call('POST', `${P}/model/versions/activate`, { key });
  assert.equal((await cat()).oc, 'walk_point');
});

test('連續套用兩次：第二次沒有再選它 → 它還是「其他」，回到最早的版本它才變回 LED 面板；中間的版本還是「其他」', async () => {
  const { call, cat, hold } = await setup();
  const k1 = await hold();
  assert.equal((await call('POST', `${P}/led-uv/apply`, body(k1, K0, { excludeObjects: ['oc'] }))).status, 200);
  const k2 = await hold();
  const second = await call('POST', `${P}/led-uv/apply`, body(k2, k1, { ledCanvas: C2, legacy: { canvas: C1, screens: [{ key: 'o:oa', dest: { x: 0, y: 0, w: 100, h: 100 }, rotate: 0, flipH: false, flipV: false }] }, excludeObjects: ['ob'] }));
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.deepEqual(await cat(), { oa: 'led_panel', ob: 'other', oc: 'other', ot: 'fixture' });
  // v2 → v1：只有 ob 變回 LED 面板
  await call('POST', `${P}/model/versions/activate`, { key: k1 });
  assert.deepEqual(await cat(), { oa: 'led_panel', ob: 'led_panel', oc: 'other', ot: 'fixture' });
  // v1 → v0：oc 變回 LED 面板
  await call('POST', `${P}/model/versions/activate`, { key: K0 });
  assert.deepEqual(await cat(), { oa: 'led_panel', ob: 'led_panel', oc: 'led_panel', ot: 'fixture' });
  // v0 → v2：兩個都再改成其他
  await call('POST', `${P}/model/versions/activate`, { key: k2 });
  assert.deepEqual(await cat(), { oa: 'led_panel', ob: 'other', oc: 'other', ot: 'fixture' });
});

test('第二次套用前製作已經把它改回 LED 面板：新版本不再算它「不放進畫布」，回舊版也不會亂動', async () => {
  const { call, db, cat, hold } = await setup();
  const k1 = await hold();
  await call('POST', `${P}/led-uv/apply`, body(k1, K0, { excludeObjects: ['oc'] }));
  await db.prepare(`UPDATE stage_objects SET category = 'led_panel' WHERE id = 'oc'`).run();   // 恢復成 LED，重新自動貼 UV
  const k2 = await hold();
  const second = await call('POST', `${P}/led-uv/apply`, body(k2, k1, { ledCanvas: C2, legacy: { canvas: C1, screens: [] } }));
  assert.equal(second.status, 200, JSON.stringify(second.data));
  const rec = JSON.parse((await db.prepare(`SELECT recipe FROM model_uv_layouts WHERE model_key = ?`).bind(k2).first()).recipe);
  assert.equal('excludedObjects' in rec, false);
  // v2 → v1：v1 把 oc 排除，v2 沒有 → 只在「進去的版本有」才改成其他
  await call('POST', `${P}/model/versions/activate`, { key: k1 });
  assert.equal((await cat()).oc, 'other');
  // v1 → v2：離開的有、進去的沒有 → 改回 LED 面板
  await call('POST', `${P}/model/versions/activate`, { key: k2 });
  assert.equal((await cat()).oc, 'led_panel');
});

test('一般上傳（壓縮）沿用上一版的紀錄：「不放進畫布」跟著走，新舊版本來回換不會改類型', async () => {
  const { call, db, cat, hold } = await setup();
  const key = await hold();
  await call('POST', `${P}/led-uv/apply`, body(key, K0, { excludeObjects: ['oc'] }));
  const up = await call('PUT', `${P}/model`, undefined, new Uint8Array([6, 6, 6]));
  assert.equal(up.status, 200);
  const rec = JSON.parse((await db.prepare(`SELECT recipe FROM model_uv_layouts WHERE model_key = ?`).bind(up.data.key).first()).recipe);
  assert.deepEqual(rec.excludedObjects, ['oc']);
  const swap = await call('POST', `${P}/model/versions/activate`, { key });
  assert.equal(swap.data.objectTypesChanged, false);
  assert.equal((await cat()).oc, 'other');
});

test('排到一半存的內容（led-uv/layout）不會蓋掉後台記的「不放進畫布」', async () => {
  const { call, db, hold } = await setup();
  const key = await hold();
  await call('POST', `${P}/led-uv/apply`, body(key, K0, { excludeObjects: ['oc'] }));
  const put = await call('PUT', `${P}/led-uv/layout`, { ifActive: key, edit: { v: 1, selected: {}, excluded: { ob: true } } });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  const rec = JSON.parse((await db.prepare(`SELECT recipe FROM model_uv_layouts WHERE model_key = ?`).bind(key).first()).recipe);
  assert.deepEqual(rec.excludedObjects, ['oc']);
  assert.deepEqual(rec.edit.excluded, { ob: true });
  const get = await call('GET', `${P}/led-uv/layout`);
  assert.deepEqual(get.data.edit.excluded, { ob: true });
});
