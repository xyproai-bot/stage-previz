// 跑法：cd cf-worker && npm test
// LED 畫布版型（0034）。走真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1）：
//   migration 0034 在舊資料上（每個舊專案補一個「全部」、舊的歌 / 影片新欄位是空的 = 整張畫布、舊版後台的 INSERT 照樣寫得進去、CHECK 擋壞值）；
//   製作可以新增 / 修改 / 刪除版型和手動切的螢幕，導演只能讀；「全部」不能改不能刪；沒填 LED 畫布不能建版型；
//   歌選版型（只有製作）；影片版本記住當時的版型 + 排法，之後版型改了舊影片照舊；分享連結的影片帶版型；
//   版型被歌用著不能刪；複製專案 / 匯出匯入帶著版型。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, applyMigrations, freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import { stampVideoTemplates, ensureFullTemplate, exportTemplates, importTemplates, templatePlanForSnapshot } from './ledTemplates.mjs';

const BASE = 'https://proxy.test';
const P = '/api/projects/p1';

test('migration 0034：每個舊專案補一個「全部」；舊的歌 / 影片新欄位是空的；舊版後台的 INSERT 照樣能寫；壞值資料庫也擋', async () => {
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0034' });
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p', 'P')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('q', 'Q')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order") VALUES ('s', 'p', '歌', 0)`),
    db.prepare(`INSERT INTO song_videos (id, project_id, song_id, source, r2_key, mime, status) VALUES ('v', 'p', 's', 'upload', 'k', 'video/mp4', 'ready')`),
  ]);
  applyMigrations(db, { only: '0034' });
  const full = await db.prepare(`SELECT project_id, name, kind, canvas_w, scale_pct FROM led_templates ORDER BY project_id`).all();
  assert.deepEqual(full.results.map(r => [r.project_id, r.name, r.kind, r.canvas_w, r.scale_pct]), [['p', '全部', 'full', null, 100], ['q', '全部', 'full', null, 100]]);
  assert.equal((await db.prepare(`SELECT template_id FROM songs`).first()).template_id, null);
  const v = await db.prepare(`SELECT template_id, template_snapshot FROM song_videos`).first();
  assert.equal(v.template_id, null);
  assert.equal(v.template_snapshot, null);
  // 舊版後台的 INSERT（沒有新欄位）
  await db.prepare(`INSERT INTO songs (id, project_id, name, "order", animator_user_id, drive_folder_id, status, code) VALUES ('s2', 'p', '歌 2', 1, NULL, NULL, 'todo', 'S02')`).run();
  await db.prepare(`INSERT INTO song_videos (id, project_id, song_id, title, note, source, r2_key, mime, size_bytes, status, created_at, updated_at) VALUES ('v2', 'p', 's2', '', '', 'upload', 'k2', 'video/mp4', 1, 'uploading', 'x', 'x')`).run();
  // CHECK / 唯一索引
  await assert.rejects(db.prepare(`INSERT INTO led_templates (id, project_id, name, kind, canvas_w, canvas_h) VALUES ('x', 'p', 'A', 'wobble', 100, 100)`).run(), /CHECK/);
  await assert.rejects(db.prepare(`INSERT INTO led_templates (id, project_id, name, kind) VALUES ('x2', 'p', '另一個全部', 'full')`).run(), /UNIQUE/);
  await db.prepare(`INSERT INTO led_templates (id, project_id, name, canvas_w, canvas_h) VALUES ('t1', 'p', 'A', 100, 100)`).run();
  await assert.rejects(db.prepare(`INSERT INTO led_templates (id, project_id, name, canvas_w, canvas_h) VALUES ('t2', 'p', 'a', 100, 100)`).run(), /UNIQUE/);
  await assert.rejects(db.prepare(`INSERT INTO led_template_screens (template_id, screen_key, dest_x, dest_y, dest_w, dest_h, rotate) VALUES ('t1', 'o:a', 0, 0, 10, 10, 45)`).run(), /CHECK/);
  await assert.rejects(db.prepare(`INSERT INTO led_screens (id, project_id, object_id, name, u0, v0, u1, v1) VALUES ('ls', 'p', 'o', 'n', 0.5, 0, 0.2, 1)`).run(), /CHECK/);
  // 刪版型 → 歌回到 NULL；刪專案 → 版型跟著刪
  await db.prepare(`UPDATE songs SET template_id = 't1' WHERE id = 's'`).run();
  await db.prepare(`DELETE FROM led_templates WHERE id = 't1'`).run();
  assert.equal((await db.prepare(`SELECT template_id FROM songs WHERE id = 's'`).first()).template_id, null);
  await db.prepare(`DELETE FROM projects WHERE id = 'q'`).run();
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM led_templates WHERE project_id = 'q'`).first()).n, 0);
});

async function setup({ ledCanvas = { width: 8800, height: 2024 } } = {}) {
  const db = freshDb();
  const users = [['u_admin', '製作', 'admin', 'ADMIN-1'], ['u_dir', '王導', 'director', 'DIR-1']];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, `${id}@x.test`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name, led_canvas) VALUES ('p1', '巡演', ?)`).bind(ledCanvas ? JSON.stringify(ledCanvas) : null),
    db.prepare(`INSERT INTO projects (id, name, led_canvas) VALUES ('p2', '別的專案', '{"width":1920,"height":1080}')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", code) VALUES ('s1', 'p1', '開場', 0, 'S01'), ('s2', 'p1', '安可', 1, 'S02'), ('sx', 'p2', '別專案的歌', 0, 'S01')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order") VALUES
      ('oa', 'p1', 'LED_A', '中間底幕', 'led_panel', 0), ('ob', 'p1', 'LED_B', '左側幕', 'led_panel', 1),
      ('ot', 'p1', 'TRUSS', '桁架', 'fixture', 2), ('ox', 'p2', 'X', '別專案的 LED', 'led_panel', 0)`),
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

const MID = {
  name: '中間底幕', canvas: { width: 4400, height: 200 }, scalePct: 50,
  screens: [{ key: 'o:oa', dest: { x: 0, y: 0, w: 4400, h: 200 }, rotate: 0, flipH: false, flipV: false }],
};

test('列版型：成員都讀得到，第一個是「全部」（大小跟著專案的 LED 畫布，沒有放法）；沒登入 401', async () => {
  const { call } = await setup();
  assert.equal((await call(null, 'GET', `${P}/led-templates`)).status, 401);
  for (const who of ['u_admin', 'u_dir']) {
    const r = await call(who, 'GET', `${P}/led-templates`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.fullCanvas, { width: 8800, height: 2024 });
    assert.equal(r.data.templates.length, 1);
    const full = r.data.templates[0];
    assert.equal(full.kind, 'full');
    assert.equal(full.name, '全部');
    assert.deepEqual(full.canvas, { width: 8800, height: 2024 });
    assert.equal(full.scalePct, 100);
    assert.deepEqual(full.screens, []);
    assert.deepEqual(r.data.screens, []);
  }
});

test('新增版型：只有製作；沒填 LED 畫布不能建；名字不能重複或叫「全部」；螢幕要真的存在；壞值 400', async () => {
  const { call } = await setup();
  const denied = await call('u_dir', 'POST', `${P}/led-templates`, MID);
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error, '只有製作可以修改專案內容');

  const r = await call('u_admin', 'POST', `${P}/led-templates`, MID);
  assert.equal(r.status, 201);
  const t = r.data.template;
  assert.equal(t.kind, 'custom');
  assert.equal(t.name, '中間底幕');
  assert.deepEqual(t.canvas, { width: 4400, height: 200 });
  assert.equal(t.scalePct, 50);
  assert.deepEqual(t.screens, [{ key: 'o:oa', objectId: 'oa', uv: null, dest: { x: 0, y: 0, w: 4400, h: 200 }, rotate: 0, flipH: false, flipV: false }]);

  // 同名（不分大小寫）/ 全部
  const dup = await call('u_admin', 'POST', `${P}/led-templates`, { ...MID, name: '中間底幕 ' });
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, /已經有一個叫「中間底幕」的版型/);
  const full = await call('u_admin', 'POST', `${P}/led-templates`, { ...MID, name: '全部' });
  assert.equal(full.status, 400);
  assert.match(full.data.error, /預設版型/);
  // 螢幕不存在 / 不是 LED / 別的專案的
  for (const key of ['o:nope', 'o:ot', 'o:ox', 's:nope']) {
    const bad = await call('u_admin', 'POST', `${P}/led-templates`, { ...MID, name: 'X' + key, screens: [{ key, dest: { x: 0, y: 0, w: 10, h: 10 } }] });
    assert.equal(bad.status, 400, key);
    assert.match(bad.data.error, /找不到這塊螢幕/);
  }
  // 壞值
  const cases = [
    [{ ...MID, name: 'a', canvas: { width: 8, height: 100 } }, /畫布大小/],
    [{ ...MID, name: 'b', scalePct: 0 }, /比例/],
    [{ ...MID, name: 'c', scalePct: 500 }, /比例/],
    [{ ...MID, name: '', }, /名稱/],
    [{ ...MID, name: 'd', screens: [{ key: 'o:oa', dest: { x: 0, y: 0, w: 0, h: 10 } }] }, /整數/],
    [{ ...MID, name: 'e', screens: [{ key: 'o:oa', dest: { x: 0.5, y: 0, w: 10, h: 10 } }] }, /整數/],
    [{ ...MID, name: 'f', screens: [{ key: 'o:oa', dest: { x: 0, y: 0, w: 10, h: 10 }, rotate: 45 }] }, /0、90、180、270/],
    [{ ...MID, name: 'g', screens: [{ key: 'o:oa', dest: { x: 0, y: 0, w: 10, h: 10 } }, { key: 'o:oa', dest: { x: 20, y: 0, w: 10, h: 10 } }] }, /只能在版型裡放一次/],
    [{ ...MID, name: 'h', screens: [{ key: 'bad key', dest: { x: 0, y: 0, w: 10, h: 10 } }] }, /螢幕代號/],
  ];
  for (const [body, re] of cases) {
    const x = await call('u_admin', 'POST', `${P}/led-templates`, body);
    assert.equal(x.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match(x.data.error, re);
  }
});

test('沒填 LED 畫布大小 → 不能建版型（409，帶 needsLedCanvas）；列版型時「全部」的畫布是 null', async () => {
  const { call } = await setup({ ledCanvas: null });
  const list = await call('u_dir', 'GET', `${P}/led-templates`);
  assert.equal(list.data.fullCanvas, null);
  assert.equal(list.data.templates[0].canvas, null);
  const r = await call('u_admin', 'POST', `${P}/led-templates`, MID);
  assert.equal(r.status, 409);
  assert.equal(r.data.needsLedCanvas, true);
});

test('修改版型：改名 / 畫布 / 比例 / 整個換放法（轉動、翻轉、重疊和超出畫布都允許，畫面上再提醒）；「全部」不能改不能刪', async () => {
  const { call } = await setup();
  const t = (await call('u_admin', 'POST', `${P}/led-templates`, MID)).data.template;
  const url = `${P}/led-templates/${t.id}`;
  assert.equal((await call('u_dir', 'PATCH', url, { name: '駭客' })).status, 403);
  const r = await call('u_admin', 'PATCH', url, {
    name: '兩塊', scalePct: 25, canvas: { width: 2200, height: 400 },
    screens: [
      { key: 'o:oa', dest: { x: 0, y: 0, w: 2200, h: 100 }, rotate: 0, flipH: true, flipV: false },
      { key: 'o:ob', dest: { x: 2000, y: 50, w: 400, h: 100 }, rotate: 90, flipH: false, flipV: true },   // 重疊、超出畫布
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.template.name, '兩塊');
  assert.equal(r.data.template.scalePct, 25);
  assert.deepEqual(r.data.template.canvas, { width: 2200, height: 400 });
  assert.equal(r.data.template.screens.length, 2);
  assert.deepEqual(r.data.template.screens[1], { key: 'o:ob', objectId: 'ob', uv: null, dest: { x: 2000, y: 50, w: 400, h: 100 }, rotate: 90, flipH: false, flipV: true });
  assert.equal(r.data.template.screens[0].flipH, true);
  // 只改名字，放法不動
  const n = await call('u_admin', 'PATCH', url, { name: '改名' });
  assert.equal(n.data.template.screens.length, 2);
  assert.equal((await call('u_admin', 'PATCH', url, {})).status, 400);
  // 全部
  const list = await call('u_admin', 'GET', `${P}/led-templates`);
  const fullId = list.data.templates[0].id;
  const f1 = await call('u_admin', 'PATCH', `${P}/led-templates/${fullId}`, { name: '別的' });
  assert.equal(f1.status, 409);
  assert.match(f1.data.error, /預設版型/);
  assert.equal((await call('u_admin', 'DELETE', `${P}/led-templates/${fullId}`)).status, 409);
  // 別的專案的版型 → 404
  assert.equal((await call('u_admin', 'PATCH', `/api/projects/p2/led-templates/${t.id}`, { name: 'x' })).status, 404);
});

test('手動切的螢幕：建立 / 修改 / 刪除（製作）；放進版型；刪掉螢幕也從版型拿掉；一個物件最多 8 塊', async () => {
  const { call } = await setup();
  const denied = await call('u_dir', 'POST', `${P}/led-screens`, { objectId: 'oa', name: '左半', uv: [0, 0, 0.5, 1] });
  assert.equal(denied.status, 403);
  const a = await call('u_admin', 'POST', `${P}/led-screens`, { objectId: 'oa', name: '左半', uv: [0, 0, 0.5, 1] });
  assert.equal(a.status, 201);
  const sid = a.data.screen.id;
  assert.deepEqual(a.data.screen.uv, [0, 0, 0.5, 1]);
  // 用像素給也可以（整張畫布 8800×2024）
  const b = await call('u_admin', 'POST', `${P}/led-screens`, { objectId: 'oa', name: '右半', rect: { x: 4400, y: 0, w: 4400, h: 2024 } });
  assert.equal(b.status, 201);
  assert.deepEqual(b.data.screen.uv, [0.5, 0, 1, 1]);
  // 壞的
  for (const body of [
    { objectId: 'oa', name: 'x', uv: [0.6, 0, 0.5, 1] },
    { objectId: 'oa', name: 'x', uv: [0, 0, 1.2, 1] },
    { objectId: 'oa', name: '', uv: [0, 0, 1, 1] },
    { objectId: 'ot', name: 'x', uv: [0, 0, 1, 1] },
    { name: 'x', uv: [0, 0, 1, 1] },
  ]) {
    const x = await call('u_admin', 'POST', `${P}/led-screens`, body);
    assert.ok(x.status === 400 || x.status === 404, JSON.stringify(body));
  }
  // 放進版型
  const t = (await call('u_admin', 'POST', `${P}/led-templates`, {
    name: '切開', canvas: { width: 4400, height: 1012 },
    screens: [{ key: `s:${sid}`, dest: { x: 0, y: 0, w: 2200, h: 1012 } }, { key: 'o:ob', dest: { x: 2200, y: 0, w: 100, h: 100 } }],
  })).data.template;
  assert.deepEqual(t.screens[0], { key: `s:${sid}`, objectId: 'oa', uv: [0, 0, 0.5, 1], dest: { x: 0, y: 0, w: 2200, h: 1012 }, rotate: 0, flipH: false, flipV: false });
  const list = await call('u_dir', 'GET', `${P}/led-templates`);
  assert.equal(list.data.screens.length, 2);
  // 修改
  const m = await call('u_admin', 'PATCH', `${P}/led-screens/${sid}`, { name: '左 1/4', uv: [0, 0, 0.25, 1] });
  assert.equal(m.status, 200);
  assert.deepEqual(m.data.screen.uv, [0, 0, 0.25, 1]);
  assert.equal((await call('u_admin', 'PATCH', `${P}/led-screens/${sid}`, { objectId: 'ob' })).status, 400);
  // 刪掉 → 版型裡也沒了
  assert.equal((await call('u_admin', 'DELETE', `${P}/led-screens/${sid}`)).status, 200);
  const after = (await call('u_admin', 'GET', `${P}/led-templates`)).data.templates.find(x => x.id === t.id);
  assert.deepEqual(after.screens.map(s => s.key), ['o:ob']);
  // 上限
  for (let i = 0; i < 7; i++) assert.equal((await call('u_admin', 'POST', `${P}/led-screens`, { objectId: 'ob', name: 'n' + i, uv: [0, i / 10, 1, (i + 1) / 10] })).status, 201);
  const over = await call('u_admin', 'POST', `${P}/led-screens`, { objectId: 'ob', name: '第 8 塊', uv: [0, 0.8, 1, 0.9] });
  assert.equal(over.status, 201);
  const over9 = await call('u_admin', 'POST', `${P}/led-screens`, { objectId: 'ob', name: '第 9 塊', uv: [0, 0.9, 1, 1] });
  assert.equal(over9.status, 409);
});

test('每首歌選版型：只有製作；null / 「全部」= 整張畫布；別的專案的版型 400；GET /songs 帶 templateId；舊版前端不送這個欄位也照樣能改歌', async () => {
  const { call } = await setup();
  const t = (await call('u_admin', 'POST', `${P}/led-templates`, MID)).data.template;
  const other = (await call('u_admin', 'POST', `/api/projects/p2/led-templates`, { ...MID, name: '別專案的', screens: [] })).data.template;
  assert.equal((await call('u_dir', 'PATCH', `${P}/songs/s1`, { template_id: t.id })).status, 403);
  assert.equal((await call('u_admin', 'PATCH', `${P}/songs/s1`, { template_id: t.id })).status, 200);
  let songs = (await call('u_dir', 'GET', `${P}/songs`)).data.songs;
  assert.equal(songs.find(s => s.id === 's1').templateId, t.id);
  assert.equal(songs.find(s => s.id === 's2').templateId, null);
  assert.equal((await call('u_admin', 'PATCH', `${P}/songs/s2`, { template_id: other.id })).status, 400);
  assert.equal((await call('u_admin', 'PATCH', `${P}/songs/s2`, { templateId: 'lt_nope' })).status, 400);
  // 舊版前端改歌名：不碰 template_id
  assert.equal((await call('u_admin', 'PATCH', `${P}/songs/s1`, { name: '開場（改）' })).status, 200);
  songs = (await call('u_dir', 'GET', `${P}/songs`)).data.songs;
  assert.equal(songs.find(s => s.id === 's1').templateId, t.id);
  // 選「全部」的 id = 回到整張畫布
  const fullId = (await call('u_admin', 'GET', `${P}/led-templates`)).data.templates[0].id;
  assert.equal((await call('u_admin', 'PATCH', `${P}/songs/s1`, { templateId: fullId })).status, 200);
  assert.equal((await call('u_dir', 'GET', `${P}/songs`)).data.songs.find(s => s.id === 's1').templateId, null);
  // 被歌用著不能刪
  await call('u_admin', 'PATCH', `${P}/songs/s1`, { template_id: t.id });
  await call('u_admin', 'PATCH', `${P}/songs/s2`, { template_id: t.id });
  const del = await call('u_admin', 'DELETE', `${P}/led-templates/${t.id}`);
  assert.equal(del.status, 409);
  assert.equal(del.data.songCount, 2);
  assert.match(del.data.error, /還有 2 首歌在用/);
  assert.equal((await call('u_admin', 'GET', `${P}/led-templates`)).data.templates.find(x => x.id === t.id).songCount, 2);
  await call('u_admin', 'PATCH', `${P}/songs/s1`, { template_id: null });
  await call('u_admin', 'PATCH', `${P}/songs/s2`, { template_id: null });
  assert.equal((await call('u_admin', 'DELETE', `${P}/led-templates/${t.id}`)).status, 200);
});

test('影片版本記住當時的版型和排法：上傳時帶 templateId 或用歌現在選的；版型之後改了、刪了，舊影片的快照不變；整張畫布的版本欄位是空的', async () => {
  const { db, call } = await setup();
  const t = (await call('u_admin', 'POST', `${P}/led-templates`, MID)).data.template;
  await call('u_admin', 'PATCH', `${P}/songs/s1`, { template_id: t.id });
  const up = (body) => call('u_admin', 'POST', `${P}/songs/s1/videos/uploads`, { filename: 'a.mp4', sizeBytes: 1000, mime: 'video/mp4', ...body });
  // 沒帶 templateId → 歌現在選的版型
  const v1 = (await up({})).data.video;
  assert.equal(v1.templateId, t.id);
  assert.equal(v1.template.name, '中間底幕');
  assert.deepEqual(v1.template.canvas, { width: 4400, height: 200 });
  assert.equal(v1.template.screens[0].key, 'o:oa');
  // 明確帶 null = 整張畫布
  const v2 = (await up({ templateId: null })).data.video;
  assert.equal(v2.templateId, null);
  assert.equal(v2.template, null);
  // 帶了不屬於這個專案的 id → 當沒指定，用歌的
  const v3 = (await up({ templateId: 'lt_nope' })).data.video;
  assert.equal(v3.templateId, t.id);
  // 版型之後改了（換放法、改畫布、改名）→ 舊影片的快照不變
  await call('u_admin', 'PATCH', `${P}/led-templates/${t.id}`, { name: '改過', canvas: { width: 1000, height: 100 }, screens: [] });
  const list = (await call('u_dir', 'GET', `${P}/songs/s1/videos`)).data.videos;
  const old = list.find(v => v.id === v1.id);
  assert.equal(old.template.name, '中間底幕');
  assert.deepEqual(old.template.canvas, { width: 4400, height: 200 });
  assert.equal(old.template.screens.length, 1);
  // 新交的是新的排法
  const v4 = (await up({})).data.video;
  assert.equal(v4.template.name, '改過');
  assert.deepEqual(v4.template.screens, []);
  // 歌回到整張畫布後，版型刪掉，舊影片還在
  await call('u_admin', 'PATCH', `${P}/songs/s1`, { template_id: null });
  assert.equal((await call('u_admin', 'DELETE', `${P}/led-templates/${t.id}`)).status, 200);
  const after = (await call('u_dir', 'GET', `${P}/songs/s1/videos`)).data.videos.find(v => v.id === v1.id);
  assert.equal(after.template.name, '中間底幕');
  const row = await db.prepare(`SELECT template_id, template_snapshot FROM song_videos WHERE id = ?`).bind(v2.id).first();
  assert.equal(row.template_id, null);
  assert.equal(row.template_snapshot, null);
});

test('分享連結看到的影片帶版型快照；沒有版型的版本 template = null', async () => {
  const { db, call } = await setup();
  const t = (await call('u_admin', 'POST', `${P}/led-templates`, MID)).data.template;
  await db.batch([
    db.prepare(`INSERT INTO song_videos (id, project_id, song_id, version, source, r2_key, mime, status, ready_at) VALUES ('vo', 'p1', 's2', 1, 'upload', 'k', 'video/mp4', 'ready', '2026-10-15T00:00:00Z')`),
    db.prepare(`INSERT INTO song_videos (id, project_id, song_id, version, source, r2_key, mime, status, ready_at) VALUES ('vn', 'p1', 's1', 1, 'upload', 'k2', 'video/mp4', 'ready', '2026-10-15T00:00:00Z')`),
    db.prepare(`INSERT INTO share_links (token, project_id, slug) VALUES ('tk1', 'p1', 'demo')`),
  ]);
  await stampVideoTemplates({ DB: db }, 'p1', [{ id: 'vn', songId: 's1' }], t.id);
  const data = await call(null, 'GET', `/api/share/tk1/data`);
  assert.equal(data.status, 200);
  const byId = Object.fromEntries(data.data.songs.map(s => [s.id, s.latestVideo]));
  assert.equal(byId.s2.template, null);
  assert.equal(byId.s1.template.name, '中間底幕');
  assert.equal(byId.s1.template.screens[0].objectId, 'oa');
});

test('舊版後台建的專案沒有「全部」→ 第一次讀版型時補上，補兩次不會重複', async () => {
  const { db, call } = await setup();
  await db.prepare(`DELETE FROM led_templates WHERE project_id = 'p1'`).run();
  const r = await call('u_dir', 'GET', `${P}/led-templates`);
  assert.equal(r.data.templates.length, 1);
  assert.equal(r.data.templates[0].kind, 'full');
  await ensureFullTemplate({ DB: db }, 'p1');
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM led_templates WHERE project_id = 'p1'`).first()).n, 1);
});

test('複製專案帶著版型、手動切的螢幕、每首歌選的版型（物件 id 換成新的）；匯出匯入一樣；舊的匯出檔（沒有版型）照樣能匯入', async () => {
  const { db, env, call } = await setup();
  const sid = (await call('u_admin', 'POST', `${P}/led-screens`, { objectId: 'oa', name: '左半', uv: [0, 0, 0.5, 1] })).data.screen.id;
  const t = (await call('u_admin', 'POST', `${P}/led-templates`, {
    name: '切開', canvas: { width: 2200, height: 506 }, scalePct: 25,
    screens: [{ key: `s:${sid}`, dest: { x: 0, y: 0, w: 1100, h: 506 }, rotate: 90, flipH: true }, { key: 'o:ob', dest: { x: 1100, y: 0, w: 100, h: 100 } }],
  })).data.template;
  await call('u_admin', 'PATCH', `${P}/songs/s1`, { template_id: t.id });
  await db.prepare(`UPDATE projects SET led_canvas = '{"width":2200,"height":506}' WHERE id = 'p1'`).run();

  const dup = await call('u_admin', 'POST', `${P}/duplicate`, { newName: '複本' });
  assert.equal(dup.status, 201);
  const np = dup.data.id;
  // LED 畫布大小也帶過去（以前漏掉，副本的版型會顯示「還沒填畫布大小」）
  assert.equal((await db.prepare(`SELECT led_canvas FROM projects WHERE id = ?`).bind(np).first()).led_canvas, '{"width":2200,"height":506}');
  const list = (await call('u_admin', 'GET', `/api/projects/${np}/led-templates`)).data;
  assert.equal(list.templates.length, 2);
  const copy = list.templates.find(x => x.kind === 'custom');
  assert.equal(copy.name, '切開');
  assert.equal(copy.scalePct, 25);
  assert.equal(copy.screens.length, 2);
  const newObjs = Object.fromEntries((await db.prepare(`SELECT id, mesh_name FROM stage_objects WHERE project_id = ?`).bind(np).all()).results.map(o => [o.mesh_name, o.id]));
  const manual = list.screens[0];
  assert.equal(manual.objectId, newObjs.LED_A);
  assert.equal(copy.screens[0].objectId, newObjs.LED_A);
  assert.equal(copy.screens[0].key, `s:${manual.id}`);
  assert.equal(copy.screens[0].rotate, 90);
  assert.equal(copy.screens[0].flipH, true);
  assert.equal(copy.screens[1].key, `o:${newObjs.LED_B}`);
  const newSongs = (await call('u_admin', 'GET', `/api/projects/${np}/songs`)).data.songs;
  assert.equal(newSongs.find(s => s.name === '開場').templateId, copy.id);
  assert.equal(newSongs.find(s => s.name === '安可').templateId, null);

  // 匯出 → 匯入
  const exp = await exportTemplates(env, 'p1');
  assert.equal(exp.ledTemplates.length, 1);
  assert.equal(exp.ledScreens.length, 1);
  const exported = await worker.fetch(new Request(`${BASE}${P}/export`, { headers: { authorization: `Bearer ${(await (await worker.fetch(new Request(`${BASE}/api/auth/login`, { method: 'POST', body: JSON.stringify({ accessCode: 'ADMIN-1' }), headers: { 'content-type': 'application/json' } }), env)).json()).token}` } }), env);
  const payload = await exported.json();
  assert.equal(payload.ledTemplates.length, 1);
  const imp = await call('u_admin', 'POST', `/api/projects/import`, { ...payload, newName: '匯入的' });
  assert.equal(imp.status, 201);
  const ilist = (await call('u_admin', 'GET', `/api/projects/${imp.data.id}/led-templates`)).data;
  assert.equal(ilist.templates.filter(x => x.kind === 'custom').length, 1);
  assert.equal(ilist.screens.length, 1);
  // 舊的匯出檔
  const { ledTemplates, ledTemplateScreens, ledScreens, ...legacy } = payload;
  void ledTemplates; void ledTemplateScreens; void ledScreens;
  const imp2 = await call('u_admin', 'POST', `/api/projects/import`, { ...legacy, newName: '舊檔' });
  assert.equal(imp2.status, 201);
  assert.equal((await call('u_admin', 'GET', `/api/projects/${imp2.data.id}/led-templates`)).data.templates.length, 1);
  // 空資料什麼都不做
  assert.deepEqual(await importTemplates(env, 'p1', {}, new Map(), []), { templates: 0, screens: 0 });
});

test('物件裡有好幾塊 LED mesh：每塊一個螢幕（o:<物件 id>~<mesh 名稱>）可以存進版型、改、讀回來、複製專案；舊的 o:<物件 id> 照舊；物件不存在 / 壞名稱 400', async () => {
  const { db, call } = await setup();
  const screens = [
    { key: 'o:oa~升降_正面', dest: { x: 0, y: 0, w: 2000, h: 500 } },
    { key: 'o:oa~升降_左側', dest: { x: 0, y: 500, w: 500, h: 500 }, rotate: 90 },
    { key: 'o:ob', dest: { x: 2000, y: 0, w: 100, h: 100 } },   // 舊資料：整個物件一塊
  ];
  const made = await call('u_admin', 'POST', `${P}/led-templates`, { name: '升降', canvas: { width: 3000, height: 1000 }, scalePct: 100, screens });
  assert.equal(made.status, 201);
  const t = made.data.template;
  assert.deepEqual(t.screens.map(x => [x.key, x.objectId, x.uv]), [['o:oa~升降_正面', 'oa', null], ['o:oa~升降_左側', 'oa', null], ['o:ob', 'ob', null]]);
  assert.equal(t.screens[1].rotate, 90);

  // 讀回來
  const list = (await call('u_admin', 'GET', `${P}/led-templates`)).data;
  assert.deepEqual(list.templates.find(x => x.id === t.id).screens.map(x => x.key), ['o:oa~升降_正面', 'o:oa~升降_左側', 'o:ob']);
  // 整個換放法
  const patched = await call('u_admin', 'PATCH', `${P}/led-templates/${t.id}`, { screens: [screens[1]] });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.data.template.screens.map(x => x.key), ['o:oa~升降_左側']);
  // 物件不存在 / 不是 LED / 壞名稱
  for (const key of ['o:nope~面', 'o:ot~面', 'o:oa~', `o:oa~${'字'.repeat(81)}`, `o:oa~a${String.fromCharCode(10)}b`, 's:x~面']) {
    const bad = await call('u_admin', 'POST', `${P}/led-templates`, { name: 'X' + key.length, canvas: { width: 100, height: 100 }, scalePct: 100, screens: [{ key, dest: { x: 0, y: 0, w: 10, h: 10 } }] });
    assert.equal(bad.status, 400, key);
  }
  // 複製專案：物件 id 換成新的，mesh 名稱留著
  const dup = await call('u_admin', 'POST', `${P}/duplicate`, { newName: '複本' });
  assert.equal(dup.status, 201);
  const np = dup.data.id;
  const newObjs = Object.fromEntries((await db.prepare(`SELECT id, mesh_name FROM stage_objects WHERE project_id = ?`).bind(np).all()).results.map(o => [o.mesh_name, o.id]));
  const copy = (await call('u_admin', 'GET', `/api/projects/${np}/led-templates`)).data.templates.find(x => x.kind === 'custom');
  assert.deepEqual(copy.screens.map(x => [x.key, x.objectId]), [[`o:${newObjs.LED_A}~升降_左側`, newObjs.LED_A]]);
});

test('LED 箱體大小（0043）：舊資料沒有 = 預設；版型和每塊螢幕可以設、改、清掉；亂填 400；快照和複製專案帶著；舊版 INSERT 照樣寫得進去', async () => {
  // migration：舊的版型 / 放法沒有這兩欄，加完以後是 NULL；欄位的 CHECK 擋壞值
  const old = new D1Sqlite();
  applyMigrations(old, { before: '0043' });
  await old.batch([
    old.prepare(`INSERT INTO projects (id, name) VALUES ('p', 'P')`),
    old.prepare(`INSERT INTO led_templates (id, project_id, name, canvas_w, canvas_h) VALUES ('t1', 'p', 'A', 100, 100)`),
    old.prepare(`INSERT INTO led_template_screens (template_id, screen_key, dest_x, dest_y, dest_w, dest_h) VALUES ('t1', 'o:a', 0, 0, 10, 10)`),
  ]);
  applyMigrations(old, { only: '0043' });
  const row = await old.prepare(`SELECT cabinet_w, cabinet_h FROM led_templates WHERE id = 't1'`).first();
  assert.deepEqual([row.cabinet_w, row.cabinet_h], [null, null]);
  const prow = await old.prepare(`SELECT cabinet_w, cabinet_h FROM led_template_screens`).first();
  assert.deepEqual([prow.cabinet_w, prow.cabinet_h], [null, null]);
  await assert.rejects(old.prepare(`UPDATE led_templates SET cabinet_w = 8 WHERE id = 't1'`).run(), /CHECK/);
  await old.prepare(`INSERT INTO led_templates (id, project_id, name, canvas_w, canvas_h) VALUES ('t2', 'p', 'B', 100, 100)`).run();   // 舊版後台的 INSERT

  const { env, call } = await setup();
  // 不設 = 沒有 cabinet 欄位（跟以前的回應一樣）
  const plain = (await call('u_admin', 'POST', `${P}/led-templates`, MID)).data.template;
  assert.equal('cabinet' in plain, false);
  assert.equal('cabinet' in plain.screens[0], false);
  // 建立時就設：版型預設 + 這塊自己
  const made = await call('u_admin', 'POST', `${P}/led-templates`, {
    ...MID, name: '有箱體', cabinet: { w: 256, h: 128 },
    screens: [{ ...MID.screens[0], cabinet: { w: 128, h: 256 } }, { key: 'o:ob', dest: { x: 0, y: 0, w: 100, h: 100 } }],
  });
  assert.equal(made.status, 201);
  const t = made.data.template;
  assert.deepEqual(t.cabinet, { w: 256, h: 128 });
  assert.deepEqual(t.screens[0].cabinet, { w: 128, h: 256 });
  assert.equal('cabinet' in t.screens[1], false);
  // 改：只改版型預設，放法不動；null = 清掉
  const url = `${P}/led-templates/${t.id}`;
  const p1 = await call('u_admin', 'PATCH', url, { cabinet: { w: 512, h: 128 } });
  assert.deepEqual(p1.data.template.cabinet, { w: 512, h: 128 });
  assert.deepEqual(p1.data.template.screens[0].cabinet, { w: 128, h: 256 });
  const p2 = await call('u_admin', 'PATCH', url, { cabinet: null });
  assert.equal(p2.status, 200);
  assert.equal('cabinet' in p2.data.template, false);
  // 整個換放法：每塊的箱體跟著新的放法
  const p3 = await call('u_admin', 'PATCH', url, { screens: [{ key: 'o:oa', dest: { x: 0, y: 0, w: 10, h: 10 }, cabinet: { w: 64, h: 64 } }] });
  assert.deepEqual(p3.data.template.screens[0].cabinet, { w: 64, h: 64 });
  // 亂填 400
  for (const bad of [{ w: 3, h: 128 }, { w: 256 }, { w: 1.5, h: 128 }, { w: 99999, h: 128 }, 'big']) {
    assert.equal((await call('u_admin', 'PATCH', url, { cabinet: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call('u_admin', 'PATCH', url, { screens: [{ key: 'o:oa', dest: { x: 0, y: 0, w: 10, h: 10 }, cabinet: { w: 0, h: 0 } }] })).status, 400);
  // 導演不能改
  assert.equal((await call('u_dir', 'PATCH', url, { cabinet: { w: 128, h: 128 } })).status, 403);
  // 影片版本的快照帶著
  const plan = await templatePlanForSnapshot(env, 'p1', t.id);
  assert.deepEqual(plan.screens[0].cabinet, { w: 64, h: 64 });
  // 複製專案帶著
  await call('u_admin', 'PATCH', url, { cabinet: { w: 256, h: 128 } });
  const dup = await call('u_admin', 'POST', `${P}/duplicate`, { newName: '複本' });
  const list = (await call('u_admin', 'GET', `/api/projects/${dup.data.id}/led-templates`)).data;
  const copy = list.templates.find(x => x.name === '有箱體');
  assert.deepEqual(copy.cabinet, { w: 256, h: 128 });
  assert.deepEqual(copy.screens[0].cabinet, { w: 64, h: 64 });
  const plainCopy = list.templates.find(x => x.name === '中間底幕');
  assert.equal('cabinet' in plainCopy, false);
});
