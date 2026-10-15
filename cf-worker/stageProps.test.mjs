// 跑法：cd cf-worker && npm test
// 比例尺的樂手和器材（0033，projects.stage_props）：走真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1）
//   - 讀：製作 / 導演 / 動畫師都讀得到（GET …/stage-props），分享連結的資料裡也有 stageProps
//   - 存（PUT …/stage-props）：只有製作和導演；動畫師、不是成員的人 403，什麼都沒改
//   - 資料不對（種類不認識、座標不是數字、重複的代號、超過 60 個、不是清單）→ 400，原本存的不動
//   - 舊版前端照樣能用：專案資料多一個欄位不影響、舊的 PATCH 照樣收、沒擺過的專案是空清單
//   - migration 0033 在舊資料上只加欄位
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, freshDb, applyMigrations } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import { canEditStageProps, describeProjectRoute, roleMeetsNeed, needDeniedMessage } from './access.mjs';

const BASE = 'https://proxy.test';
const DRUMS = { id: 'sp_drum0001', type: 'drummer', x: 1.5, y: 0.4, z: -2.25, rotY: 15 };
const RISER = { id: 'sp_riser001', type: 'riser', x: 1.5, y: 0, z: -2.25, rotY: 0 };

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
    db.prepare(`INSERT INTO share_links (token, project_id, slug) VALUES ('tk_stage_props_1', 'p1', 'band-share')`),
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
  const stored = async (id = 'p1') => (await db.prepare(`SELECT stage_props FROM projects WHERE id = ?`).bind(id).first()).stage_props;
  return { db, call, stored };
}

test('權限規則：製作、導演可以改，動畫師和沒有角色的不行（路由表跟前端同一條規則）', () => {
  assert.equal(canEditStageProps('admin'), true);
  assert.equal(canEditStageProps('director'), true);
  assert.equal(canEditStageProps('animator'), false);
  assert.equal(canEditStageProps(null), false);
  assert.equal(canEditStageProps(undefined), false);
  assert.equal(roleMeetsNeed('stageProps', { role: 'director', globalRole: 'director' }), true);
  assert.equal(roleMeetsNeed('stageProps', { role: 'animator', globalRole: 'animator' }), false);
  assert.equal(roleMeetsNeed('stageProps', { role: null, globalRole: 'animator' }), false);
  assert.equal(needDeniedMessage('stageProps'), '只有製作或導演可以擺樂手和器材');
  const segs = (p) => p.split('/').filter(Boolean);
  assert.equal(describeProjectRoute('GET', segs('/api/projects/p1/stage-props')).need, 'member');
  assert.equal(describeProjectRoute('PUT', segs('/api/projects/p1/stage-props')).need, 'stageProps');
  assert.equal(describeProjectRoute('POST', segs('/api/projects/p1/stage-props')).methodNotAllowed, true);
  assert.equal(describeProjectRoute('PUT', segs('/api/projects/p1/stage-props/x')), null);
});

test('沒擺過的專案是空清單；製作、導演、動畫師都讀得到', async () => {
  const { call } = await setup();
  for (const who of ['u_admin', 'u_dir', 'u_ani']) {
    const r = await call(who, 'GET', '/api/projects/p1/stage-props');
    assert.equal(r.status, 200, who);
    assert.deepEqual(r.data.props, [], who);
  }
  // 不是這個專案的成員看不到
  assert.equal((await call('u_out', 'GET', '/api/projects/p1/stage-props')).status, 403);
  assert.equal((await call(null, 'GET', '/api/projects/p1/stage-props')).status, 401);
});

test('製作和導演可以存；存下去的所有人都讀得到，也在專案資料和分享連結的資料裡', async () => {
  const { call, stored } = await setup();
  const put = await call('u_dir', 'PUT', '/api/projects/p1/stage-props', { props: [RISER, DRUMS] });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.deepEqual(put.data.props, [RISER, DRUMS]);
  assert.deepEqual(JSON.parse(await stored()), [RISER, DRUMS]);

  // 製作換成另一份（整份換掉）
  const put2 = await call('u_admin', 'PUT', '/api/projects/p1/stage-props', { props: [DRUMS] });
  assert.equal(put2.status, 200);
  for (const who of ['u_admin', 'u_dir', 'u_ani']) {
    assert.deepEqual((await call(who, 'GET', '/api/projects/p1/stage-props')).data.props, [DRUMS], who);
  }
  // 舊路徑：專案資料（SELECT *）多了一個欄位，舊前端不認識也沒關係
  const proj = await call('u_ani', 'GET', '/api/projects/p1');
  assert.equal(proj.status, 200);
  assert.deepEqual(JSON.parse(proj.data.project.stage_props), [DRUMS]);
  // 分享連結（訪客只看）
  const share = await call(null, 'GET', '/api/share/tk_stage_props_1/data');
  assert.equal(share.status, 200, JSON.stringify(share.data));
  assert.deepEqual(share.data.stageProps, [DRUMS]);
  // 另一個專案不受影響
  assert.deepEqual((await call('u_admin', 'GET', '/api/projects/p2/stage-props')).data.props, []);
});

test('動畫師、不是成員的人、沒登入：不能存（403 / 401），原本的不動', async () => {
  const { call, stored } = await setup();
  await call('u_admin', 'PUT', '/api/projects/p1/stage-props', { props: [DRUMS] });
  const r = await call('u_ani', 'PUT', '/api/projects/p1/stage-props', { props: [] });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, '只有製作或導演可以擺樂手和器材');
  assert.equal((await call('u_out', 'PUT', '/api/projects/p1/stage-props', { props: [] })).status, 403);
  assert.equal((await call(null, 'PUT', '/api/projects/p1/stage-props', { props: [] })).status, 401);
  assert.deepEqual(JSON.parse(await stored()), [DRUMS]);
  // 導演不是這個專案的成員 → 也不行
  assert.equal((await call('u_dir', 'PUT', '/api/projects/p2/stage-props', { props: [] })).status, 403);
});

test('資料不對整份拒絕（400），原本存的不動', async () => {
  const { call, stored } = await setup();
  await call('u_admin', 'PUT', '/api/projects/p1/stage-props', { props: [DRUMS] });
  const bad = [
    { props: 'nope' },
    {},
    { props: [{ ...DRUMS, type: 'tuba' }] },
    { props: [{ ...DRUMS, x: 'abc' }] },
    { props: [{ ...DRUMS, z: null }] },
    { props: [{ ...DRUMS, x: 1e9 }] },
    { props: [{ ...DRUMS, id: '../x' }] },
    { props: [DRUMS, DRUMS] },
    { props: Array.from({ length: 61 }, (_, i) => ({ ...DRUMS, id: 'sp_' + i })) },
    { props: [null] },
  ];
  for (const body of bad) {
    const r = await call('u_admin', 'PUT', '/api/projects/p1/stage-props', body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.ok(typeof r.data.error === 'string' && r.data.error.length > 0);
  }
  assert.deepEqual(JSON.parse(await stored()), [DRUMS]);
  // 剛好 60 個可以；清空也可以
  const sixty = Array.from({ length: 60 }, (_, i) => ({ ...DRUMS, id: 'sp_' + i }));
  assert.equal((await call('u_admin', 'PUT', '/api/projects/p1/stage-props', { props: sixty })).status, 200);
  assert.equal((await call('u_admin', 'PUT', '/api/projects/p1/stage-props', { props: [] })).status, 200);
  assert.equal(await stored(), '[]');
});

test('存的時候座標取到公釐、角度換成 -180 ~ 180', async () => {
  const { call } = await setup();
  const r = await call('u_admin', 'PUT', '/api/projects/p1/stage-props', {
    props: [{ id: 'sp_a', type: 'piano', x: 1.23456, y: 0, z: -0.0004, rotY: 270 }],
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.props, [{ id: 'sp_a', type: 'piano', x: 1.235, y: 0, z: -0, rotY: -90 }].map(p => ({ ...p, z: 0 })));
});

test('舊版前端照樣能用：舊的 PATCH 照存、不會動到樂手和器材；壞掉的舊資料當空清單', async () => {
  const { call, db, stored } = await setup();
  await call('u_admin', 'PUT', '/api/projects/p1/stage-props', { props: [DRUMS] });
  // 舊前端送的校準、現場設定
  assert.equal((await call('u_admin', 'PATCH', '/api/projects/p1', { scaleCorrection: 1.6 })).status, 200);
  assert.equal((await call('u_admin', 'PATCH', '/api/projects/p1', { name: '改名', lookSettings: { exposure: 1.2 } })).status, 200);
  assert.deepEqual(JSON.parse(await stored()), [DRUMS]);
  // 舊前端想用 PATCH 寫 stage_props → 不在可改欄位裡，不收（沒有別的可改欄位 = 400）
  const sneaky = await call('u_admin', 'PATCH', '/api/projects/p1', { stage_props: '[]' });
  assert.equal(sneaky.status, 400);
  assert.deepEqual(JSON.parse(await stored()), [DRUMS]);
  // 資料庫裡的字串壞了 → 讀出來是空清單，不會 500
  await db.prepare(`UPDATE projects SET stage_props = 'oops' WHERE id = 'p1'`).run();
  const r = await call('u_ani', 'GET', '/api/projects/p1/stage-props');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.props, []);
});

test('migration 0033：舊資料只多一個欄位，舊專案是空清單', async () => {
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0033' });   // 只跑到 0033 之前
  await db.prepare(`INSERT INTO projects (id, name) VALUES ('old', '舊專案')`).run();
  await db.prepare(`UPDATE projects SET scale_correction = 2.5 WHERE id = 'old'`).run();
  const before = await db.prepare(`SELECT * FROM projects WHERE id = 'old'`).first();
  assert.equal('stage_props' in before, false);
  assert.deepEqual(applyMigrations(db, { only: '0033' }), ['0033_stage_props.sql']);
  const after = await db.prepare(`SELECT * FROM projects WHERE id = 'old'`).first();
  assert.equal(after.stage_props, '[]');
  const { stage_props: _ignored, ...rest } = after;
  assert.deepEqual(rest, before);
});
