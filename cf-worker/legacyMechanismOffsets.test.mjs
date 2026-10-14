// 跑法：cd cf-worker && npm test
// 機關改版清理（機關系統設計 Task 21）：舊的「全專案機關滑桿」projects.mechanism_offsets 不再收修改、不再同步到機關；
// 欄位留著、資料不動。走真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1）：
//   - 帶 mechanismOffsets / mechanism_offsets 的 PATCH → 400「機關改版了，請重新整理頁面」，什麼都沒改（同一次帶的其他欄位也不改）
//   - 正式站還在跑的前端（750e401）會送的其他 PATCH（名稱、校準、現場設定、材質、重置視角、LED 畫布大小）照樣能存
//   - 不會再動到機關（以前會把滑桿同步成 mlx_ / mly_ 機關）
//   - 分享連結的資料照樣讀得到舊欄位（舊前端載入時會先用）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';

const BASE = 'https://proxy.test';
const OLD = { led1: { x: 2, y: 0 } };

async function setup() {
  const db = freshDb();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_admin', 'a@x.test', '陳製作', 'admin', 'ADMIN-1')`),
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_dir', 'd@x.test', '王導', 'director', 'DIR-1')`),
    db.prepare(`INSERT INTO projects (id, name, mechanism_offsets) VALUES ('p1', '示範專案', ?)`).bind(JSON.stringify(OLD)),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order") VALUES ('led1', 'p1', 'LED_01', '主牆', 'led_panel', 0)`),
  ]);
  const env = { DB: db, AUTH_SECRET: 'test-secret', MODELS: memoryR2() };
  const tokens = {};
  for (const [id, code] of [['u_admin', 'ADMIN-1'], ['u_dir', 'DIR-1']]) {
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
  const project = () => db.prepare(`SELECT * FROM projects WHERE id = 'p1'`).first();
  const mechanismCount = async () => (await db.prepare(`SELECT COUNT(*) AS n FROM mechanisms WHERE project_id = 'p1'`).first()).n;
  return { db, call, project, mechanismCount };
}

test('帶舊的機關滑桿 → 400「機關改版了，請重新整理頁面」，欄位和機關都不動', async () => {
  const { call, project, mechanismCount } = await setup();
  for (const body of [
    { mechanismOffsets: { led1: { x: 5, y: 1 } } },
    { mechanism_offsets: { led1: { x: 5, y: 1 } } },
    { mechanismOffsets: {} },
    { mechanism_offsets: '{"led1":{"x":3}}' },
  ]) {
    const r = await call('u_admin', 'PATCH', '/api/projects/p1', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.data.error, '機關改版了，請重新整理頁面');
  }
  assert.deepEqual(JSON.parse((await project()).mechanism_offsets), OLD);
  assert.equal(await mechanismCount(), 0);

  // 同一次帶了別的欄位（舊前端第一次打開時「搬舊瀏覽器的校準 + 滑桿」就是這樣送）→ 整個不收，校準也不改；
  // 舊前端不會跳錯誤，下次打開再試，畫面照常
  const r = await call('u_admin', 'PATCH', '/api/projects/p1', { scaleCorrection: 1.6, mechanismOffsets: { led1: { x: 1, y: 0 } } });
  assert.equal(r.status, 400);
  const p = await project();
  assert.equal(p.scale_correction, 1);
  assert.deepEqual(JSON.parse(p.mechanism_offsets), OLD);

  // 導演：跟以前一樣先被權限擋下（403），也什麼都沒改
  const d = await call('u_dir', 'PATCH', '/api/projects/p1', { mechanismOffsets: {} });
  assert.equal(d.status, 403);
  assert.deepEqual(JSON.parse((await project()).mechanism_offsets), OLD);
});

test('正式站現在的前端會送的其他修改照樣能存', async () => {
  const { call, project } = await setup();
  const ok = async (body) => {
    const r = await call('u_admin', 'PATCH', '/api/projects/p1', body);
    assert.equal(r.status, 200, `${JSON.stringify(body)} → ${JSON.stringify(r.data)}`);
  };
  await ok({ name: '示範專案 2', description: '說明' });
  await ok({ scaleCorrection: 1.6 });
  await ok({ lookSettings: { exposure: 1.2 } });
  await ok({ materialOverrides: { LED_Screen: { roughness: 0.4 } } });
  await ok({ homeView: null });
  await ok({ ledCanvas: { width: 3840, height: 2160 } });
  await ok({ tags: ['演唱會'] });
  const p = await project();
  assert.equal(p.name, '示範專案 2');
  assert.equal(p.scale_correction, 1.6);
  assert.deepEqual(JSON.parse(p.led_canvas), { width: 3840, height: 2160 });
  assert.deepEqual(JSON.parse(p.mechanism_offsets), OLD);   // 欄位留著、沒被動到
  // 導演改 3D 檢視設定 → 403（跟以前一樣），訊息不再提機關滑桿
  const d = await call('u_dir', 'PATCH', '/api/projects/p1', { scaleCorrection: 2 });
  assert.equal(d.status, 403);
  assert.ok(!/機關/.test(d.data.error));
});

test('分享連結的資料照樣有舊欄位（只讀，給還在跑的舊前端）', async () => {
  const { call } = await setup();
  const created = await call('u_admin', 'POST', '/api/projects/p1/share-links', {});
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const r = await call(null, 'GET', `/api/share/${created.data.token}/data`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.mechanismOffsets, OLD);
  assert.ok(Array.isArray(r.data.mechanisms));
});
