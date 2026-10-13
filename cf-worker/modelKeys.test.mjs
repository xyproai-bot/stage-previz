// 跑法：cd cf-worker && npm test
// 模型檔名猜不到（128 bits 隨機）、舊檔名照樣能用、版本清單不從檔名解析、新檔可以一直快取
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import {
  randomKeyPart, newProjectModelKey, newSharedAssetKey, isModelVersionFile, isImmutableModelKey,
  modelCacheControl, modelVersionTimestamp,
} from './modelKeys.mjs';

test('隨機碼：32 個 hex（128 bits），每次不一樣', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const r = randomKeyPart();
    assert.match(r, /^[0-9a-f]{32}$/);
    seen.add(r);
  }
  assert.equal(seen.size, 200);
});

test('新的檔名格式', () => {
  const k = newProjectModelKey('p_1', 1760000000000, 'a'.repeat(32));
  assert.equal(k, `models/p_1/1760000000000-${'a'.repeat(32)}.glb`);
  assert.match(newProjectModelKey('p_1'), /^models\/p_1\/\d+-[0-9a-f]{32}\.glb$/);
  assert.match(newSharedAssetKey('as_x'), /^assets\/models\/as_x-[0-9a-f]{32}\.glb$/);
  assert.throws(() => newProjectModelKey('p_1', 1, 'short'));
});

test('版本檔名：舊的和新的都認，其他的不認', () => {
  assert.equal(isModelVersionFile('1760000000000.glb'), true);
  assert.equal(isModelVersionFile(`1760000000000-${'0'.repeat(32)}.glb`), true);
  assert.equal(isModelVersionFile('../x.glb'), false);
  assert.equal(isModelVersionFile('1760000000000-abc.glb'), false);
  assert.equal(isModelVersionFile('a.glb'), false);
});

test('快取：新格式一年 + immutable；舊格式和模型庫 1 小時', () => {
  const k = `models/p_1/1760000000000-${'f'.repeat(32)}.glb`;
  assert.equal(isImmutableModelKey(k), true);
  assert.equal(modelCacheControl(k), 'public, max-age=31536000, immutable');
  assert.equal(modelCacheControl('models/p_1/1760000000000.glb'), 'public, max-age=3600');
  assert.equal(modelCacheControl(`assets/models/as_1-${'f'.repeat(32)}.glb`), 'public, max-age=3600');
});

test('上傳時間用 R2 記的時間', () => {
  assert.equal(modelVersionTimestamp({ uploaded: new Date(5000) }), 5000);
  assert.equal(modelVersionTimestamp({ uploaded: '1970-01-01T00:00:06.000Z' }), 6000);
  assert.equal(modelVersionTimestamp({ customMetadata: { uploadedAt: '1970-01-01T00:00:07.000Z' } }), 7000);
  assert.equal(modelVersionTimestamp({}), 0);
});

const BASE = 'https://proxy.test';

test('走真的路由：上傳用新檔名、版本清單照時間排（新舊檔名混在一起）、新檔名可以刪、/r2 下載快取和 304', async () => {
  const db = freshDb();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_admin', 'a@x.test', '製作', 'admin', 'ADMIN-1')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '金馬')`),
  ]);
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const r2 = memoryR2({ clock: () => clock });
  // 舊檔名的版本（上傳時間比較早）
  const oldKey = 'models/p1/1759000000000.glb';
  await r2.put(oldKey, new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: 'model/gltf-binary' } });
  const env = { DB: db, MODELS: r2, AUTH_SECRET: 's' };
  const token = (await (await worker.fetch(new Request(BASE + '/api/auth/login', { method: 'POST', body: JSON.stringify({ accessCode: 'ADMIN-1' }) }), env)).json()).token;
  const auth = { authorization: `Bearer ${token}` };

  clock += 3600_000;
  const up1 = await worker.fetch(new Request(BASE + '/api/projects/p1/model', {
    method: 'PUT', headers: { ...auth, 'content-type': 'model/gltf-binary', 'content-length': '4' }, body: new Uint8Array([9, 9, 9, 9]),
  }), env);
  assert.equal(up1.status, 200);
  const k1 = (await up1.json()).key;
  assert.match(k1, /^models\/p1\/\d+-[0-9a-f]{32}\.glb$/);
  clock += 3600_000;
  const up2 = await worker.fetch(new Request(BASE + '/api/projects/p1/model', {
    method: 'PUT', headers: { ...auth, 'content-type': 'model/gltf-binary', 'content-length': '2' }, body: new Uint8Array([7, 7]),
  }), env);
  const k2 = (await up2.json()).key;
  assert.notEqual(k1, k2);

  const list = await (await worker.fetch(new Request(BASE + '/api/projects/p1/model/versions', { headers: auth }), env)).json();
  assert.deepEqual(list.versions.map(v => v.key), [k2, k1, oldKey]);
  assert.equal(list.activeKey, k2);
  assert.ok(list.versions[0].timestamp > list.versions[1].timestamp);
  assert.ok(list.versions.every(v => v.timestamp > 0));

  // 刪掉新檔名的舊版本（前端傳檔名最後一段）
  const del = await worker.fetch(new Request(BASE + `/api/projects/p1/model/versions/${encodeURIComponent(k1.split('/').pop())}`, { method: 'DELETE', headers: auth }), env);
  assert.equal(del.status, 200);
  assert.ok(!r2.keys().includes(k1));
  // 舊檔名一樣能切回去、能刪
  const act = await worker.fetch(new Request(BASE + '/api/projects/p1/model/versions/activate', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ key: oldKey }) }), env);
  assert.equal(act.status, 200);
  const act2 = await worker.fetch(new Request(BASE + '/api/projects/p1/model/versions/activate', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ key: k2 }) }), env);
  assert.equal(act2.status, 200);
  assert.equal((await worker.fetch(new Request(BASE + '/api/projects/p1/model/versions/1759000000000.glb', { method: 'DELETE', headers: auth }), env)).status, 200);
  assert.equal((await worker.fetch(new Request(BASE + '/api/projects/p1/model/versions/evil.glb', { method: 'DELETE', headers: auth }), env)).status, 400);

  // 下載：新檔名一年快取；If-None-Match 對上 → 304
  const dl = await worker.fetch(new Request(BASE + '/r2/' + k2), env);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(new Uint8Array(await dl.arrayBuffer()), new Uint8Array([7, 7]));
  const etag = dl.headers.get('etag');
  assert.ok(etag);
  const again = await worker.fetch(new Request(BASE + '/r2/' + k2, { headers: { 'if-none-match': etag } }), env);
  assert.equal(again.status, 304);

  // 模型庫：新建的資產檔名也有隨機碼
  const asset = await worker.fetch(new Request(BASE + '/api/assets', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ name: '舞台' }) }), env);
  assert.equal(asset.status, 201);
  assert.match((await asset.json()).key, /^assets\/models\/as_[a-z0-9]+-[0-9a-f]{32}\.glb$/);
});
