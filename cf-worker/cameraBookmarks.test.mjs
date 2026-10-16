// 跑法：cd cf-worker && npm test
// 視角書籤（0035，projects.camera_bookmarks）：走真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1）
//   - 讀：製作 / 導演 / 動畫師都讀得到（GET …/camera-bookmarks），分享連結的資料裡也有 cameraBookmarks
//   - 存（PUT …/camera-bookmarks）：只有製作和導演；動畫師、不是成員的人 403，什麼都沒改
//   - 資料不對（名字空的、座標不是數字、重複的代號、超過 40 個、不是清單）→ 400，原本存的不動
//   - 舊版前端照樣能用：專案資料多一個欄位不影響、舊的 PATCH 照樣收、沒存過的專案是空清單
//   - migration 0035 在舊資料上只加欄位
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, freshDb, applyMigrations } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import { canEditCameraBookmarks, describeProjectRoute, roleMeetsNeed, needDeniedMessage } from './access.mjs';

const BASE = 'https://proxy.test';
const FOH = { id: 'cb_foh00001', name: '控台看舞台', position: [12.5, 4.25, 30], target: [0, 2, 0], fov: 45 };
const STANDS = { id: 'cb_stands01', name: '二樓看台', position: [-20, 14, 25.5], target: [0, 3, -2], fov: 50 };

async function setup() {
  const db = freshDb();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_admin', 'a@x.test', '陳製作', 'admin', 'ADMIN-1')`),
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_dir', 'd@x.test', '王導', 'director', 'DIR-1')`),
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_ani', 'n@x.test', '李動畫', 'animator', 'ANI-1')`),
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_out', 'o@x.test', '外人', 'animator', 'OUT-1')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '示範專案')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p2', '另一個專案')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_ani', 'animator')`),
    db.prepare(`INSERT INTO share_links (token, project_id, slug) VALUES ('tk_cam_bookmarks_1', 'p1', 'band-share')`),
  ]);
  const env = { DB: db, AUTH_SECRET: 'test-secret', MODELS: memoryR2() };
  const tokens = {};
  for (const [id, code] of [['u_admin', 'ADMIN-1'], ['u_dir', 'DIR-1'], ['u_ani', 'ANI-1'], ['u_out', 'OUT-1']]) {
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
  const stored = async (id = 'p1') => (await db.prepare(`SELECT camera_bookmarks FROM projects WHERE id = ?`).bind(id).first()).camera_bookmarks;
  return { db, call, stored };
}

test('權限規則：製作、導演可以改，動畫師和沒有角色的不行（路由表跟前端同一條規則）', () => {
  assert.equal(canEditCameraBookmarks('admin'), true);
  assert.equal(canEditCameraBookmarks('director'), true);
  assert.equal(canEditCameraBookmarks('animator'), false);
  assert.equal(canEditCameraBookmarks(null), false);
  assert.equal(canEditCameraBookmarks(undefined), false);
  assert.equal(roleMeetsNeed('cameraBookmarks', { role: 'director', globalRole: 'director' }), true);
  assert.equal(roleMeetsNeed('cameraBookmarks', { role: 'animator', globalRole: 'animator' }), false);
  assert.equal(roleMeetsNeed('cameraBookmarks', { role: null, globalRole: 'animator' }), false);
  assert.equal(needDeniedMessage('cameraBookmarks'), '只有製作或導演可以存視角');
  const segs = (p) => p.split('/').filter(Boolean);
  assert.equal(describeProjectRoute('GET', segs('/api/projects/p1/camera-bookmarks')).need, 'member');
  assert.equal(describeProjectRoute('PUT', segs('/api/projects/p1/camera-bookmarks')).need, 'cameraBookmarks');
  assert.equal(describeProjectRoute('POST', segs('/api/projects/p1/camera-bookmarks')).methodNotAllowed, true);
  assert.equal(describeProjectRoute('PUT', segs('/api/projects/p1/camera-bookmarks/x')), null);
});

test('沒存過的專案是空清單；製作、導演、動畫師都讀得到', async () => {
  const { call } = await setup();
  for (const who of ['u_admin', 'u_dir', 'u_ani']) {
    const r = await call(who, 'GET', '/api/projects/p1/camera-bookmarks');
    assert.equal(r.status, 200, who);
    assert.deepEqual(r.data.bookmarks, [], who);
  }
  // 不是這個專案的成員看不到
  assert.equal((await call('u_out', 'GET', '/api/projects/p1/camera-bookmarks')).status, 403);
  assert.equal((await call(null, 'GET', '/api/projects/p1/camera-bookmarks')).status, 401);
});

test('導演和製作可以存；存下去的所有人都讀得到，順序照存的，也在專案資料和分享連結的資料裡', async () => {
  const { call, stored } = await setup();
  const put = await call('u_dir', 'PUT', '/api/projects/p1/camera-bookmarks', { bookmarks: [STANDS, FOH] });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.deepEqual(put.data.bookmarks, [STANDS, FOH]);
  assert.deepEqual(JSON.parse(await stored()), [STANDS, FOH]);

  // 製作換順序、刪掉一個、改名（整份換掉）
  const renamed = { ...FOH, name: '控台（改過）' };
  const put2 = await call('u_admin', 'PUT', '/api/projects/p1/camera-bookmarks', { bookmarks: [renamed] });
  assert.equal(put2.status, 200);
  for (const who of ['u_admin', 'u_dir', 'u_ani']) {
    assert.deepEqual((await call(who, 'GET', '/api/projects/p1/camera-bookmarks')).data.bookmarks, [renamed], who);
  }
  // 舊路徑：專案資料（SELECT *）多了一個欄位，舊前端不認識也沒關係
  const proj = await call('u_ani', 'GET', '/api/projects/p1');
  assert.equal(proj.status, 200);
  assert.deepEqual(JSON.parse(proj.data.project.camera_bookmarks), [renamed]);
  // 分享連結（訪客只看）
  const share = await call(null, 'GET', '/api/share/tk_cam_bookmarks_1/data');
  assert.equal(share.status, 200, JSON.stringify(share.data));
  assert.deepEqual(share.data.cameraBookmarks, [renamed]);
  // 另一個專案不受影響
  assert.deepEqual((await call('u_admin', 'GET', '/api/projects/p2/camera-bookmarks')).data.bookmarks, []);
});

test('動畫師、不是成員的人、沒登入：不能存（403 / 401），原本的不動', async () => {
  const { call, stored } = await setup();
  await call('u_admin', 'PUT', '/api/projects/p1/camera-bookmarks', { bookmarks: [FOH] });
  const r = await call('u_ani', 'PUT', '/api/projects/p1/camera-bookmarks', { bookmarks: [] });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, '只有製作或導演可以存視角');
  assert.equal((await call('u_out', 'PUT', '/api/projects/p1/camera-bookmarks', { bookmarks: [] })).status, 403);
  assert.equal((await call(null, 'PUT', '/api/projects/p1/camera-bookmarks', { bookmarks: [] })).status, 401);
  assert.deepEqual(JSON.parse(await stored()), [FOH]);
  // 導演不是這個專案的成員 → 也不行
  assert.equal((await call('u_dir', 'PUT', '/api/projects/p2/camera-bookmarks', { bookmarks: [] })).status, 403);
  // 分享連結的訪客不能存
  assert.ok([401, 403, 404, 405].includes((await call(null, 'PUT', '/api/share/tk_cam_bookmarks_1/camera-bookmarks', { bookmarks: [] })).status));
});

test('資料不對整份拒絕（400），原本存的不動', async () => {
  const { call, stored } = await setup();
  await call('u_admin', 'PUT', '/api/projects/p1/camera-bookmarks', { bookmarks: [FOH] });
  const bad = [
    { bookmarks: 'nope' },
    {},
    { bookmarks: [{ ...FOH, name: '' }] },
    { bookmarks: [{ ...FOH, name: '   ' }] },
    { bookmarks: [{ ...FOH, name: 'x'.repeat(41) }] },
    { bookmarks: [{ ...FOH, position: [1, 2] }] },
    { bookmarks: [{ ...FOH, position: [1, 'a', 3] }] },
    { bookmarks: [{ ...FOH, target: [null, 0, 0] }] },
    { bookmarks: [{ ...FOH, position: [1e9, 0, 0] }] },
    { bookmarks: [{ ...FOH, position: [0, 2, 0], target: [0, 2, 0] }] },   // 看向自己
    { bookmarks: [{ ...FOH, fov: 'wide' }] },
    { bookmarks: [{ ...FOH, fov: 0 }] },
    { bookmarks: [{ ...FOH, fov: 400 }] },
    { bookmarks: [{ ...FOH, id: '../x' }] },
    { bookmarks: [FOH, FOH] },
    { bookmarks: Array.from({ length: 41 }, (_, i) => ({ ...FOH, id: 'cb_' + i })) },
    { bookmarks: [null] },
  ];
  for (const body of bad) {
    const r = await call('u_admin', 'PUT', '/api/projects/p1/camera-bookmarks', body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 90));
    assert.ok(typeof r.data.error === 'string' && r.data.error.length > 0);
  }
  assert.deepEqual(JSON.parse(await stored()), [FOH]);
  // 剛好 40 個可以；清空也可以
  const forty = Array.from({ length: 40 }, (_, i) => ({ ...FOH, id: 'cb_' + i, name: '視角 ' + (i + 1) }));
  assert.equal((await call('u_admin', 'PUT', '/api/projects/p1/camera-bookmarks', { bookmarks: forty })).status, 200);
  assert.equal((await call('u_admin', 'PUT', '/api/projects/p1/camera-bookmarks', { bookmarks: [] })).status, 200);
  assert.equal(await stored(), '[]');
});

test('存的時候座標取到千分位、名字去頭尾空白', async () => {
  const { call } = await setup();
  const r = await call('u_admin', 'PUT', '/api/projects/p1/camera-bookmarks', {
    bookmarks: [{ id: 'cb_a', name: '  特區  ', position: [1.23456, 2, 3], target: [0, 0.0004, 0], fov: 44.4444 }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.bookmarks, [{ id: 'cb_a', name: '特區', position: [1.235, 2, 3], target: [0, 0, 0], fov: 44.444 }]);
});

test('舊版前端照樣能用：舊的 PATCH 照存、不會動到視角書籤；壞掉的舊資料當空清單', async () => {
  const { call, db, stored } = await setup();
  await call('u_admin', 'PUT', '/api/projects/p1/camera-bookmarks', { bookmarks: [FOH] });
  // 舊前端送的校準、現場設定
  assert.equal((await call('u_admin', 'PATCH', '/api/projects/p1', { scaleCorrection: 1.6 })).status, 200);
  assert.equal((await call('u_admin', 'PATCH', '/api/projects/p1', { name: '改名', lookSettings: { exposure: 1.2 } })).status, 200);
  assert.deepEqual(JSON.parse(await stored()), [FOH]);
  // 舊前端想用 PATCH 寫 camera_bookmarks → 不在可改欄位裡，不收（沒有別的可改欄位 = 400）
  const sneaky = await call('u_admin', 'PATCH', '/api/projects/p1', { camera_bookmarks: '[]' });
  assert.equal(sneaky.status, 400);
  assert.deepEqual(JSON.parse(await stored()), [FOH]);
  // 資料庫裡的字串壞了 → 讀出來是空清單，不會 500
  await db.prepare(`UPDATE projects SET camera_bookmarks = 'oops' WHERE id = 'p1'`).run();
  const r = await call('u_ani', 'GET', '/api/projects/p1/camera-bookmarks');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.bookmarks, []);
});

test('migration 0035：舊資料只多一個欄位，舊專案是空清單', async () => {
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0035' });   // 只跑到 0035 之前
  await db.prepare(`INSERT INTO projects (id, name) VALUES ('old', '舊專案')`).run();
  await db.prepare(`UPDATE projects SET scale_correction = 2.5 WHERE id = 'old'`).run();
  const before = await db.prepare(`SELECT * FROM projects WHERE id = 'old'`).first();
  assert.equal('camera_bookmarks' in before, false);
  assert.deepEqual(applyMigrations(db, { only: '0035' }), ['0035_camera_bookmarks.sql']);
  const after = await db.prepare(`SELECT * FROM projects WHERE id = 'old'`).first();
  assert.equal(after.camera_bookmarks, '[]');
  const { camera_bookmarks: _ignored, ...rest } = after;
  assert.deepEqual(rest, before);
});
