// 跑法：cd cf-worker && npm test
// 自動貼 UV 的後台（0036）。走真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1 + 假 R2）：
//   migration 0036 在舊資料上；只有製作能套用 / 看影響；PUT /model 沒帶新參數時跟以前完全一樣（舊版前端）；?hold=1 只放檔案不換版本；
//   套用 = 模型 + 畫布 + 舊版面 + 舊影片快照 + 新切出來的螢幕在同一個交易裡（要嘛全換、要嘛全不換）；
//   模型版本記住畫布；換回舊版 → 畫布和舊影片還原、再換回新版 → 重新套上；刪版本清紀錄；一般上傳（壓縮）沿用紀錄。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, applyMigrations, freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import { parsePlan } from '../web/src/lib/ledTemplate.ts';

const BASE = 'https://proxy.test';
const P = '/api/projects/p1';
const OLD_CANVAS = { width: 8800, height: 2024 };
const NEW_CANVAS = { width: 9216, height: 3072 };

test('migration 0036：加一張表，舊資料不動；刪專案時紀錄跟著刪', async () => {
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0036' });
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name, led_canvas, model_r2_key) VALUES ('p', 'P', '{"width":100,"height":100}', 'models/p/1.glb')`),
  ]);
  applyMigrations(db, { only: '0036' });
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM model_uv_layouts`).first()).n, 0);
  assert.equal((await db.prepare(`SELECT led_canvas FROM projects`).first()).led_canvas, '{"width":100,"height":100}');
  await db.prepare(`INSERT INTO model_uv_layouts (project_id, model_key, led_canvas) VALUES ('p', 'models/p/1.glb', NULL)`).run();
  await assert.rejects(db.prepare(`INSERT INTO model_uv_layouts (project_id, model_key) VALUES ('p', 'models/p/1.glb')`).run(), /UNIQUE|PRIMARY/);
  await db.prepare(`DELETE FROM projects WHERE id = 'p'`).run();
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM model_uv_layouts`).first()).n, 0);
});

const OLD_KEY = `models/p1/1000-${'a'.repeat(32)}.glb`;

async function setup({ ledCanvas = OLD_CANVAS } = {}) {
  const db = freshDb();
  const users = [['u_admin', '製作', 'admin', 'ADMIN-1'], ['u_dir', '王導', 'director', 'DIR-1'], ['u_ani', '小動', 'animator', 'ANI-1']];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, `${id}@x.test`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name, led_canvas, model_r2_key) VALUES ('p1', '巡演', ?, ?)`).bind(ledCanvas ? JSON.stringify(ledCanvas) : null, OLD_KEY),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", code) VALUES ('s1', 'p1', '開場', 0, 'S01'), ('s2', 'p1', '安可', 1, 'S02')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order") VALUES
      ('oa', 'p1', 'LED_A', '主牆', 'led_panel', 0), ('ob', 'p1', 'LED_B', '側屏', 'led_panel', 1), ('ot', 'p1', 'TRUSS', '桁架', 'fixture', 2)`),
    // 三個影片版本：兩個舊的（整張畫布）、一個已經有版型快照
    db.prepare(`INSERT INTO led_templates (id, project_id, name, kind, canvas_w, canvas_h) VALUES ('lt_mine', 'p1', '我的版型', 'custom', 1920, 1080)`),
    db.prepare(`INSERT INTO song_videos (id, project_id, song_id, source, r2_key, mime, status, version, template_id, template_snapshot) VALUES
      ('v1', 'p1', 's1', 'upload', 'k1', 'video/mp4', 'ready', 1, NULL, NULL),
      ('v2', 'p1', 's1', 'upload', 'k2', 'video/mp4', 'ready', 2, NULL, NULL),
      ('v3', 'p1', 's2', 'upload', 'k3', 'video/mp4', 'ready', 1, 'lt_mine', '{"v":1,"id":"lt_mine","name":"我的版型","canvas":{"width":1920,"height":1080},"scalePct":100,"screens":[]}')`),
  ]);
  const r2 = memoryR2();
  await r2.put(OLD_KEY, new Uint8Array([1, 2, 3]), {});
  const env = { DB: db, AUTH_SECRET: 'test-secret', MODELS: r2 };
  const tokens = {};
  for (const [id, , , code] of users) {
    const r = await worker.fetch(new Request(`${BASE}/api/auth/login`, {
      method: 'POST', body: JSON.stringify({ accessCode: code }), headers: { 'content-type': 'application/json' },
    }), env);
    tokens[id] = (await r.json()).token;
  }
  const call = async (who, method, path, body, raw) => {
    const headers = raw ? { 'content-type': 'model/gltf-binary' } : { 'content-type': 'application/json' };
    if (who) headers.authorization = `Bearer ${tokens[who]}`;
    const r = await worker.fetch(new Request(BASE + path, { method, headers, body: raw ? raw : body === undefined ? undefined : JSON.stringify(body) }), env);
    let data = null;
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data };
  };
  return { db, env, r2, call };
}

/** 模擬前端：先 hold 上傳新模型，回傳新的 key */
async function holdUpload(call, bytes = new Uint8Array([9, 9, 9, 9])) {
  const r = await call('u_admin', 'PUT', `${P}/model?hold=1`, undefined, bytes);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.key;
}

const LEGACY = {
  canvas: OLD_CANVAS,
  screens: [
    { key: 'o:oa', dest: { x: 440, y: 202, w: 1760, h: 810 }, rotate: 0, flipH: false, flipV: false },
    { key: 'o:ob', dest: { x: 4840, y: 1012, w: 880, h: 607 }, rotate: 90, flipH: false, flipV: false },
  ],
};

function applyBody(key, extra = {}) {
  return { key, ifActive: OLD_KEY, ledCanvas: NEW_CANVAS, note: '自動貼 UV · 2 塊螢幕 · 9216×3072', recipe: { v: 1, surfaces: [] }, legacy: LEGACY, ...extra };
}

test('權限：只有製作能套用和看影響；導演、動畫師 403；沒登入 401', async () => {
  const { call } = await setup();
  const key = await holdUpload(call);
  for (const who of ['u_dir', 'u_ani']) {
    assert.equal((await call(who, 'POST', `${P}/led-uv/apply`, applyBody(key))).status, 403);
    assert.equal((await call(who, 'GET', `${P}/led-uv/impact`)).status, 403);
  }
  assert.equal((await call(null, 'POST', `${P}/led-uv/apply`, applyBody(key))).status, 401);
  assert.equal((await call(null, 'GET', `${P}/led-uv/impact`)).status, 401);
  assert.equal((await call('u_admin', 'GET', `${P}/led-uv/impact`)).status, 200);
});

test('舊版前端：PUT /model 沒帶新參數 → 跟以前一樣換成新版；?hold=1 只放檔案、不換版本、不動資料庫', async () => {
  const { call, db, r2 } = await setup();
  const held = await call('u_admin', 'PUT', `${P}/model?hold=1`, undefined, new Uint8Array([7, 7]));
  assert.equal(held.status, 200);
  assert.equal(held.data.held, true);
  assert.ok(r2.keys().includes(held.data.key));
  assert.equal((await db.prepare(`SELECT model_r2_key FROM projects WHERE id = 'p1'`).first()).model_r2_key, OLD_KEY);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM model_uv_layouts`).first()).n, 0);
  // 一般上傳
  const plain = await call('u_admin', 'PUT', `${P}/model`, undefined, new Uint8Array([8, 8]));
  assert.equal(plain.status, 200);
  assert.deepEqual(Object.keys(plain.data).sort(), ['key', 'ok', 'url']);
  assert.equal((await db.prepare(`SELECT model_r2_key FROM projects WHERE id = 'p1'`).first()).model_r2_key, plain.data.key);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM model_uv_layouts`).first()).n, 0);
  // 版本列表：舊欄位都在
  const versions = (await call('u_admin', 'GET', `${P}/model/versions`)).data.versions;
  for (const v of versions) for (const k of ['key', 'url', 'size', 'uploaded', 'timestamp', 'isActive']) assert.ok(k in v);
  assert.ok(versions.every(v => v.note === null && v.hasLayout === false && v.ledCanvas === null));
  // 舊版前端的切換：回應還是有 key / url / ok
  const act = await call('u_admin', 'POST', `${P}/model/versions/activate`, { key: OLD_KEY });
  assert.equal(act.status, 200);
  assert.equal(act.data.ok, true);
  assert.equal(act.data.key, OLD_KEY);
});

test('套用：欄位檢查', async () => {
  const { call, db } = await setup();
  const key = await holdUpload(call);
  const post = (body) => call('u_admin', 'POST', `${P}/led-uv/apply`, body);
  assert.equal((await post(applyBody('models/p1/../x.glb'))).status, 400);
  assert.equal((await post(applyBody('models/other/1.glb'))).status, 400);
  assert.equal((await post({ ...applyBody(key), ifActive: undefined })).status, 400);
  const stale = await post(applyBody(key, { ifActive: `models/p1/9999-${'b'.repeat(32)}.glb` }));
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, '模型已經被別人換過了，請重新分析');
  assert.equal((await post(applyBody(key, { ledCanvas: { width: 5, height: 5 } }))).status, 400);
  assert.equal((await post(applyBody(`models/p1/2000-${'c'.repeat(32)}.glb`))).status, 404);
  assert.equal((await post(applyBody(OLD_KEY))).status, 400);
  assert.equal((await post(applyBody(key, { recipe: { big: 'x'.repeat(300 * 1024) } }))).status, 413);
  assert.equal((await post(applyBody(key, { legacy: { canvas: OLD_CANVAS, screens: [{ key: 'o:nope', dest: { x: 0, y: 0, w: 5, h: 5 }, rotate: 0, flipH: false, flipV: false }] } }))).status, 404);
  assert.equal((await post(applyBody(key, { legacy: { canvas: OLD_CANVAS, screens: [{ key: 'o:oa', dest: { x: 0, y: 0, w: 5, h: 5 }, rotate: 45, flipH: false, flipV: false }] } }))).status, 400);
  assert.equal((await post(applyBody(key, { pieceScreens: [{ ref: 'r', objectId: 'ot', name: 'x', uv: [0, 0, 0.5, 0.5] }] }))).status, 404);
  assert.equal((await post(applyBody(key, { pieceScreens: [{ ref: 'r', objectId: 'oa', name: 'x', uv: [0.6, 0, 0.5, 0.5] }] }))).status, 400);
  assert.equal((await post(applyBody(key, { screenUpdates: [{ id: 'nope', uv: [0, 0, 0.5, 0.5] }] }))).status, 404);
  // 全部被擋下：什麼都沒變
  assert.equal((await db.prepare(`SELECT model_r2_key FROM projects WHERE id = 'p1'`).first()).model_r2_key, OLD_KEY);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM led_templates WHERE name LIKE '舊版面%'`).first()).n, 0);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM model_uv_layouts`).first()).n, 0);
});

test('套用：新模型 + 新畫布 + 舊版面 + 舊影片的快照，一次換好；有版型的影片、歌選的版型不動', async () => {
  const { call, db } = await setup();
  await db.prepare(`UPDATE songs SET template_id = 'lt_mine' WHERE id = 's2'`).run();
  const key = await holdUpload(call);
  const impact = await call('u_admin', 'GET', `${P}/led-uv/impact`);
  assert.deepEqual(impact.data, { videoVersions: 2, songsWithVideos: 1, customTemplates: 1, templateScreens: 0, manualSplits: 0 });

  const r = await call('u_admin', 'POST', `${P}/led-uv/apply`, applyBody(key));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.legacyTemplateName, '舊版面');
  assert.equal(r.data.stampedVideos, 2);
  assert.deepEqual(r.data.ledCanvas, NEW_CANVAS);

  const proj = await db.prepare(`SELECT model_r2_key, led_canvas FROM projects WHERE id = 'p1'`).first();
  assert.equal(proj.model_r2_key, key);
  assert.deepEqual(JSON.parse(proj.led_canvas), NEW_CANVAS);

  // 舊版面版型
  const tpl = await db.prepare(`SELECT * FROM led_templates WHERE name = '舊版面'`).first();
  assert.equal(tpl.kind, 'custom');
  assert.equal(tpl.canvas_w, 8800);
  assert.equal(tpl.canvas_h, 2024);
  assert.equal(tpl.scale_pct, 100);
  const placements = (await db.prepare(`SELECT * FROM led_template_screens WHERE template_id = ? ORDER BY screen_key`).bind(tpl.id).all()).results;
  assert.deepEqual(placements.map(p => [p.screen_key, p.dest_x, p.dest_y, p.dest_w, p.dest_h, p.rotate]), [['o:oa', 440, 202, 1760, 810, 0], ['o:ob', 4840, 1012, 880, 607, 90]]);
  // 版型 API 看得到它，格式正確
  const list = await call('u_admin', 'GET', `${P}/led-templates`);
  const fromApi = list.data.templates.find(t => t.name === '舊版面');
  assert.deepEqual(fromApi.canvas, OLD_CANVAS);
  assert.equal(fromApi.screens.length, 2);

  // 影片：兩個舊的有快照，格式讀得回來；有版型的不動
  const vids = Object.fromEntries((await db.prepare(`SELECT id, template_id, template_snapshot FROM song_videos`).all()).results.map(v => [v.id, v]));
  for (const id of ['v1', 'v2']) {
    assert.equal(vids[id].template_id, tpl.id);
    const plan = parsePlan(vids[id].template_snapshot);
    assert.equal(plan.name, '舊版面');
    assert.deepEqual(plan.canvas, OLD_CANVAS);
    assert.equal(plan.screens.length, 2);
    assert.equal(plan.screens[1].rotate, 90);
  }
  assert.equal(vids.v3.template_id, 'lt_mine');
  assert.ok(vids.v3.template_snapshot.includes('我的版型'));
  // 歌選的版型沒被動
  assert.equal((await db.prepare(`SELECT template_id FROM songs WHERE id = 's2'`).first()).template_id, 'lt_mine');
  assert.equal((await db.prepare(`SELECT template_id FROM songs WHERE id = 's1'`).first()).template_id, null);

  // 影片 API 帶著快照（導演看得到）
  const videos = await call('u_dir', 'GET', `${P}/songs/s1/videos`);
  assert.equal(videos.status, 200);
  const v1Api = videos.data.videos.find(v => v.id === 'v1');
  assert.equal(v1Api.template.name, '舊版面');
  assert.deepEqual(v1Api.template.canvas, OLD_CANVAS);
  assert.equal(v1Api.templateId, tpl.id);

  // 版本紀錄：套用前那一版有一列（舊畫布）、新的一版有一列（新畫布 + recipe + 說明）
  const rows = Object.fromEntries((await db.prepare(`SELECT * FROM model_uv_layouts`).all()).results.map(x => [x.model_key, x]));
  assert.deepEqual(JSON.parse(rows[OLD_KEY].led_canvas), OLD_CANVAS);
  assert.equal(rows[OLD_KEY].legacy_template_id, null);
  assert.deepEqual(JSON.parse(rows[key].led_canvas), NEW_CANVAS);
  assert.equal(rows[key].note, '自動貼 UV · 2 塊螢幕 · 9216×3072');
  assert.equal(rows[key].legacy_template_id, tpl.id);
  assert.deepEqual(JSON.parse(rows[key].stamped_videos).sort(), ['v1', 'v2']);
  assert.ok(JSON.parse(rows[key].recipe));

  // 版本列表
  const versions = (await call('u_admin', 'GET', `${P}/model/versions`)).data.versions;
  const nv = versions.find(v => v.key === key);
  assert.equal(nv.isActive, true);
  assert.equal(nv.note, '自動貼 UV · 2 塊螢幕 · 9216×3072');
  assert.deepEqual(nv.ledCanvas, NEW_CANVAS);
  assert.equal(nv.hasLayout, true);
  assert.deepEqual(versions.find(v => v.key === OLD_KEY).ledCanvas, OLD_CANVAS);
  // 活動紀錄
  const act = (await db.prepare(`SELECT action, target_type, payload FROM activity_log WHERE target_id = ?`).bind(key).all()).results;
  assert.ok(act.some(a => a.action === 'upload' && a.target_type === 'model' && a.payload.includes('autoUv')));
});

test('換回舊版：模型、畫布一起回來，舊影片還原；再換回新版：重新套上；套用之後新傳的影片不受影響', async () => {
  const { call, db } = await setup();
  const key = await holdUpload(call);
  assert.equal((await call('u_admin', 'POST', `${P}/led-uv/apply`, applyBody(key))).status, 200);
  const tplId = (await db.prepare(`SELECT id FROM led_templates WHERE name = '舊版面'`).first()).id;
  // 套用之後新傳一個影片（NULL = 新畫布）
  await db.prepare(`INSERT INTO song_videos (id, project_id, song_id, source, r2_key, mime, status, version) VALUES ('v4', 'p1', 's1', 'upload', 'k4', 'video/mp4', 'ready', 3)`).run();

  const back = await call('u_admin', 'POST', `${P}/model/versions/activate`, { key: OLD_KEY });
  assert.equal(back.status, 200);
  assert.equal(back.data.restoredCanvas, true);
  assert.deepEqual(back.data.ledCanvas, OLD_CANVAS);
  let proj = await db.prepare(`SELECT model_r2_key, led_canvas FROM projects WHERE id = 'p1'`).first();
  assert.equal(proj.model_r2_key, OLD_KEY);
  assert.deepEqual(JSON.parse(proj.led_canvas), OLD_CANVAS);
  let vids = Object.fromEntries((await db.prepare(`SELECT id, template_id FROM song_videos`).all()).results.map(v => [v.id, v.template_id]));
  assert.equal(vids.v1, null);
  assert.equal(vids.v2, null);
  assert.equal(vids.v3, 'lt_mine');
  assert.equal(vids.v4, null);

  const fwd = await call('u_admin', 'POST', `${P}/model/versions/activate`, { key });
  assert.equal(fwd.status, 200);
  assert.deepEqual(fwd.data.ledCanvas, NEW_CANVAS);
  proj = await db.prepare(`SELECT model_r2_key, led_canvas FROM projects WHERE id = 'p1'`).first();
  assert.equal(proj.model_r2_key, key);
  vids = Object.fromEntries((await db.prepare(`SELECT id, template_id FROM song_videos`).all()).results.map(v => [v.id, v.template_id]));
  assert.equal(vids.v1, tplId);
  assert.equal(vids.v2, tplId);
  assert.equal(vids.v4, null);   // 新畫布的影片不被當成舊畫布

  // 製作在新版上手動改了畫布 → 離開再回來，畫布是改過的
  await db.prepare(`UPDATE projects SET led_canvas = '{"width":9000,"height":3000}' WHERE id = 'p1'`).run();
  await call('u_admin', 'POST', `${P}/model/versions/activate`, { key: OLD_KEY });
  const again = await call('u_admin', 'POST', `${P}/model/versions/activate`, { key });
  assert.deepEqual(again.data.ledCanvas, { width: 9000, height: 3000 });
});

test('舊專案換版本（沒有任何紀錄）：畫布不動，跟以前一樣', async () => {
  const { call, db, r2 } = await setup();
  const k2 = `models/p1/1500-${'d'.repeat(32)}.glb`;
  await r2.put(k2, new Uint8Array([5]), {});
  const r = await call('u_admin', 'POST', `${P}/model/versions/activate`, { key: k2 });
  assert.equal(r.status, 200);
  assert.equal(r.data.restoredCanvas, false);
  assert.deepEqual(JSON.parse((await db.prepare(`SELECT led_canvas FROM projects`).first()).led_canvas), OLD_CANVAS);
});

test('同時套用兩次：第二次的舊版面叫「舊版面 2」，版型名稱不衝突；影片已經有快照就不重蓋', async () => {
  const { call, db } = await setup();
  const k1 = await holdUpload(call);
  assert.equal((await call('u_admin', 'POST', `${P}/led-uv/apply`, applyBody(k1))).status, 200);
  const k2 = await holdUpload(call, new Uint8Array([4, 4]));
  const second = await call('u_admin', 'POST', `${P}/led-uv/apply`, { ...applyBody(k2, { legacy: { ...LEGACY, canvas: NEW_CANVAS } }), ifActive: k1 });
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal(second.data.legacyTemplateName, '舊版面 2');
  assert.equal(second.data.stampedVideos, 0);
  const snap = parsePlan((await db.prepare(`SELECT template_snapshot FROM song_videos WHERE id = 'v1'`).first()).template_snapshot);
  assert.equal(snap.name, '舊版面');
});

test('新切出來的螢幕（一個物件好幾片）和原本螢幕的新範圍；舊版面用新螢幕的代號', async () => {
  const { call, db } = await setup();
  await db.prepare(`INSERT INTO led_screens (id, project_id, object_id, name, u0, v0, u1, v1) VALUES ('ls_old', 'p1', 'ob', '舊切的', 0.1, 0.1, 0.2, 0.3)`).run();
  const key = await holdUpload(call);
  const body = applyBody(key, {
    pieceScreens: [
      { ref: 'oa#0', objectId: 'oa', name: '主牆 1', uv: [0.1, 0.1, 0.2, 0.2] },
      { ref: 'oa#1', objectId: 'oa', name: '主牆 2', uv: [0.3, 0.1, 0.4, 0.2] },
    ],
    screenUpdates: [{ id: 'ls_old', uv: [0.15, 0.2, 0.25, 0.4] }],
    legacy: {
      canvas: OLD_CANVAS,
      screens: [
        { key: 's:@oa#0', dest: { x: 10, y: 10, w: 100, h: 50 }, rotate: 0, flipH: false, flipV: false },
        { key: 's:@oa#1', dest: { x: 200, y: 10, w: 100, h: 50 }, rotate: 180, flipH: false, flipV: false },
        { key: 's:ls_old', dest: { x: 880, y: 202, w: 880, h: 405 }, rotate: 0, flipH: false, flipV: false },
      ],
    },
  });
  const r = await call('u_admin', 'POST', `${P}/led-uv/apply`, body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.pieceScreens.length, 2);
  const screens = (await db.prepare(`SELECT * FROM led_screens WHERE object_id = 'oa' ORDER BY u0`).all()).results;
  assert.deepEqual(screens.map(s => [s.name, s.u0, s.u1]), [['主牆 1', 0.1, 0.2], ['主牆 2', 0.3, 0.4]]);
  const old = await db.prepare(`SELECT u0, v0, u1, v1 FROM led_screens WHERE id = 'ls_old'`).first();
  assert.deepEqual([old.u0, old.v0, old.u1, old.v1], [0.15, 0.2, 0.25, 0.4]);
  // 舊版面的螢幕代號換成真的 id，快照裡有各自的來源範圍
  const plan = parsePlan((await db.prepare(`SELECT template_snapshot FROM song_videos WHERE id = 'v1'`).first()).template_snapshot);
  assert.deepEqual(plan.screens.map(s => s.key).sort(), [`s:${screens[0].id}`, `s:${screens[1].id}`, 's:ls_old'].sort());
  const snapOld = plan.screens.find(s => s.key === 's:ls_old');
  assert.deepEqual(snapOld.uv, [0.15, 0.2, 0.25, 0.4]);
  assert.equal(snapOld.objectId, 'ob');
  // 版型 API 讀得到整組
  const list = await call('u_admin', 'GET', `${P}/led-templates`);
  assert.equal(list.data.screens.length, 3);
  assert.equal(list.data.templates.find(t => t.name === '舊版面').screens.length, 3);
  // 一個物件最多 8 塊
  const k2 = await holdUpload(call, new Uint8Array([6, 6]));
  const many = Array.from({ length: 7 }, (_, i) => ({ ref: 'm' + i, objectId: 'oa', name: 'm' + i, uv: [0.5, 0.5, 0.6, 0.6] }));
  const tooMany = await call('u_admin', 'POST', `${P}/led-uv/apply`, { ...applyBody(k2, { pieceScreens: many, legacy: null }), ifActive: r.data.key });
  assert.equal(tooMany.status, 409);
});

test('交易：中途失敗全部不換（模型、畫布、版型、影片、版本紀錄都維持原樣）', async () => {
  const { call, db, env } = await setup();
  const key = await holdUpload(call);
  // 套用的當下，有別人剛好建了「舊版面」（名稱衝突 → 資料庫拒絕）：用包住 batch 的方式模擬
  const realBatch = env.DB.batch.bind(env.DB);
  env.DB.batch = async (stmts) => {
    await db.prepare(`INSERT INTO led_templates (id, project_id, name, kind, canvas_w, canvas_h) VALUES ('lt_race', 'p1', '舊版面', 'custom', 10, 10)`).run();
    return realBatch(stmts);
  };
  const r = await call('u_admin', 'POST', `${P}/led-uv/apply`, applyBody(key));
  env.DB.batch = realBatch;
  assert.equal(r.status, 400);
  assert.match(r.data.error, /沒有成功/);
  const proj = await db.prepare(`SELECT model_r2_key, led_canvas FROM projects WHERE id = 'p1'`).first();
  assert.equal(proj.model_r2_key, OLD_KEY);
  assert.deepEqual(JSON.parse(proj.led_canvas), OLD_CANVAS);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM song_videos WHERE template_id IS NOT NULL`).first()).n, 1);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM model_uv_layouts`).first()).n, 0);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM led_template_screens WHERE template_id != 'lt_mine'`).first()).n, 0);
});

test('刪版本：紀錄跟著刪；一般上傳（壓縮）沿用上一版的紀錄，換來換去舊影片跟著對的模型走', async () => {
  const { call, db } = await setup();
  const key = await holdUpload(call);
  assert.equal((await call('u_admin', 'POST', `${P}/led-uv/apply`, applyBody(key))).status, 200);
  // 壓縮 = 一般上傳
  const comp = await call('u_admin', 'PUT', `${P}/model`, undefined, new Uint8Array([3, 3, 3]));
  assert.equal(comp.status, 200);
  const rows = Object.fromEntries((await db.prepare(`SELECT * FROM model_uv_layouts`).all()).results.map(x => [x.model_key, x]));
  assert.ok(rows[comp.data.key]);
  assert.equal(rows[comp.data.key].legacy_template_id, rows[key].legacy_template_id);
  assert.deepEqual(JSON.parse(rows[comp.data.key].led_canvas), NEW_CANVAS);
  // 新版 → 壓縮版：舊影片維持套用狀態
  await call('u_admin', 'POST', `${P}/model/versions/activate`, { key });
  const v1 = await db.prepare(`SELECT template_id FROM song_videos WHERE id = 'v1'`).first();
  assert.ok(v1.template_id && v1.template_id.startsWith('lt_'));
  // 刪掉非使用中的版本
  const file = comp.data.key.split('/').pop();
  assert.equal((await call('u_admin', 'DELETE', `${P}/model/versions/${file}`)).status, 200);
  assert.equal(await db.prepare(`SELECT 1 FROM model_uv_layouts WHERE model_key = ?`).bind(comp.data.key).first(), null);
});

// ─────────────────────────────────────────────
// 第 3 階段：排到一半的東西（勾的螢幕、點數、自己排的排法）存在目前模型版本的 recipe.edit
// ─────────────────────────────────────────────

const EDIT = {
  v: 1,
  selected: { oa: true, ob: false },
  forms: { 'o:oa': { mode: 'pitch', pitch: '3.9', pw: '', ph: '', cmmW: '', cmmH: '', cpxW: '', cpxH: '', cols: '', rows: '' } },
  overrides: {},
  gutter: '0',
  arrangement: { v: 1, canvasMode: 'custom', canvas: { width: 8800, height: 2024 }, items: [{ key: 'o:oa', x: 5, y: 6, rotate: 90, flipH: true, flipV: false }], groups: [] },
};

test('排到一半的東西：只有製作能看 / 存；導演、動畫師 403；沒登入 401', async () => {
  const { call } = await setup();
  for (const who of ['u_dir', 'u_ani']) {
    assert.equal((await call(who, 'GET', `${P}/led-uv/layout`)).status, 403);
    assert.equal((await call(who, 'PUT', `${P}/led-uv/layout`, { ifActive: OLD_KEY, edit: EDIT })).status, 403);
  }
  assert.equal((await call(null, 'GET', `${P}/led-uv/layout`)).status, 401);
  assert.equal((await call(null, 'PUT', `${P}/led-uv/layout`, { ifActive: OLD_KEY, edit: EDIT })).status, 401);
  const none = await call('u_admin', 'GET', `${P}/led-uv/layout`);
  assert.equal(none.status, 200);
  assert.deepEqual(none.data, { key: OLD_KEY, edit: null });
  assert.ok((await call('u_admin', 'DELETE', `${P}/led-uv/layout`)).status >= 400);
});

test('存了就讀得回來；這個版本原本沒有紀錄就建一筆（畫布 = 現在的畫布）；再存是換掉 edit；不動別的東西', async () => {
  const { call, db } = await setup();
  const put = await call('u_admin', 'PUT', `${P}/led-uv/layout`, { ifActive: OLD_KEY, edit: EDIT });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.deepEqual(put.data, { ok: true, key: OLD_KEY });
  const got = await call('u_admin', 'GET', `${P}/led-uv/layout`);
  assert.deepEqual(got.data, { key: OLD_KEY, edit: EDIT });
  const row = await db.prepare(`SELECT * FROM model_uv_layouts WHERE model_key = ?`).bind(OLD_KEY).first();
  assert.deepEqual(JSON.parse(row.led_canvas), OLD_CANVAS);
  assert.equal(row.legacy_template_id, null);
  assert.equal(row.note, null);
  // 專案的畫布、模型、舊影片都沒被動
  const proj = await db.prepare(`SELECT model_r2_key, led_canvas FROM projects WHERE id = 'p1'`).first();
  assert.equal(proj.model_r2_key, OLD_KEY);
  assert.deepEqual(JSON.parse(proj.led_canvas), OLD_CANVAS);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM song_videos WHERE template_id IS NOT NULL`).first()).n, 1);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM led_templates WHERE name LIKE '舊版面%'`).first()).n, 0);
  // 再存一次：換掉 edit
  const edit2 = { ...EDIT, gutter: '8' };
  assert.equal((await call('u_admin', 'PUT', `${P}/led-uv/layout`, { ifActive: OLD_KEY, edit: edit2 })).status, 200);
  assert.deepEqual((await call('u_admin', 'GET', `${P}/led-uv/layout`)).data.edit, edit2);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM model_uv_layouts`).first()).n, 1);
});

test('存的內容檢查：ifActive 對不上 409；格式不對 400；太大 413；沒有模型 400', async () => {
  const { call, db } = await setup();
  const put = (body) => call('u_admin', 'PUT', `${P}/led-uv/layout`, body);
  const stale = await put({ ifActive: `models/p1/9999-${'b'.repeat(32)}.glb`, edit: EDIT });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.conflict, true);
  assert.equal((await put({ edit: EDIT })).status, 400);
  assert.equal((await put({ ifActive: OLD_KEY })).status, 400);
  assert.equal((await put({ ifActive: OLD_KEY, edit: { v: 2 } })).status, 400);
  assert.equal((await put({ ifActive: OLD_KEY, edit: [1, 2] })).status, 400);
  assert.equal((await put({ ifActive: OLD_KEY, edit: { v: 1, big: 'x'.repeat(210 * 1024) } })).status, 413);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM model_uv_layouts`).first()).n, 0);
  await db.prepare(`UPDATE projects SET model_r2_key = NULL WHERE id = 'p1'`).run();
  assert.equal((await put({ ifActive: null, edit: EDIT })).status, 400);
});

test('套用時 recipe 裡的 edit 跟著新版本存；打開讀到的是新版本的；換回舊版讀到舊版的草稿；畫布和舊影片的來回照舊', async () => {
  const { call, db } = await setup();
  // 先在舊版上存一份草稿
  assert.equal((await call('u_admin', 'PUT', `${P}/led-uv/layout`, { ifActive: OLD_KEY, edit: EDIT })).status, 200);
  const key = await holdUpload(call);
  const applied = { ...EDIT, gutter: '16' };
  const r = await call('u_admin', 'POST', `${P}/led-uv/apply`, applyBody(key, { recipe: { v: 1, surfaces: [], edit: applied } }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual((await call('u_admin', 'GET', `${P}/led-uv/layout`)).data, { key, edit: applied });
  // 在新版上再存一次（停手自動存）：edit 換掉、surfaces 留著
  const later = { ...EDIT, gutter: '24' };
  assert.equal((await call('u_admin', 'PUT', `${P}/led-uv/layout`, { ifActive: key, edit: later })).status, 200);
  const newRow = await db.prepare(`SELECT recipe FROM model_uv_layouts WHERE model_key = ?`).bind(key).first();
  assert.deepEqual(JSON.parse(newRow.recipe), { v: 1, surfaces: [], edit: later });
  // 換回舊版：畫布和舊影片照舊還原；讀到舊版自己的草稿
  const back = await call('u_admin', 'POST', `${P}/model/versions/activate`, { key: OLD_KEY });
  assert.equal(back.status, 200);
  assert.equal(back.data.restoredCanvas, true);
  assert.deepEqual(back.data.ledCanvas, OLD_CANVAS);
  assert.deepEqual((await call('u_admin', 'GET', `${P}/led-uv/layout`)).data, { key: OLD_KEY, edit: EDIT });
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM song_videos WHERE template_id IS NOT NULL AND template_id != 'lt_mine'`).first()).n, 0);
  // 再換回新版：舊影片重新套上，草稿還在
  await call('u_admin', 'POST', `${P}/model/versions/activate`, { key });
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM song_videos WHERE template_id IS NOT NULL AND template_id != 'lt_mine'`).first()).n, 2);
  assert.deepEqual((await call('u_admin', 'GET', `${P}/led-uv/layout`)).data.edit, later);
});

test('一般上傳（壓縮）沿用草稿；沒帶 edit 的舊版前端套用照舊（recipe 沒有 edit → 讀到 null）', async () => {
  const { call } = await setup();
  assert.equal((await call('u_admin', 'PUT', `${P}/led-uv/layout`, { ifActive: OLD_KEY, edit: EDIT })).status, 200);
  const comp = await call('u_admin', 'PUT', `${P}/model`, undefined, new Uint8Array([3, 3, 3]));
  assert.equal(comp.status, 200);
  assert.deepEqual((await call('u_admin', 'GET', `${P}/led-uv/layout`)).data, { key: comp.data.key, edit: EDIT });
  const key = await holdUpload(call);
  const r = await call('u_admin', 'POST', `${P}/led-uv/apply`, { ...applyBody(key), ifActive: comp.data.key });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual((await call('u_admin', 'GET', `${P}/led-uv/layout`)).data, { key, edit: null });
});
