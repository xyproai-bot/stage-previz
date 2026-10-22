// 跑法：cd cf-worker && npm test
// Cue 庫第 5 階段：給 Cue 庫用的新後台功能（規格 4.1、4.2、4.5；第 10 節：編號是自己打的文字、每個 cue 是獨立快照）
// 列表 / 建立 / 另存各種放法 / 換指向 / 改時間重排 / 409（編號重複、舊 rev、刪除在用的）/ 整個畫面一次換掉 / 權限
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './testing/d1-sqlite.mjs';
import worker from './worker.js';

const BASE = 'https://proxy.test';
const P = '/api/projects/p1';

async function build() {
  const db = freshDb();
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_admin', 'a@x.test', '製作', 'admin', 'ADMIN-1')`),
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_dir', 'd@x.test', '導演', 'director', 'DIR-1')`),
    db.prepare(`INSERT INTO users (id, email, name, role, access_code) VALUES ('u_pm', 'p@x.test', '專案製作', 'animator', 'PM-1')`),
    db.prepare(`INSERT INTO projects (id, name, cue_library) VALUES ('p1', '巡演', 1), ('p2', '舊模式', 0)`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director'), ('p1', 'u_pm', 'admin'), ('p2', 'u_dir', 'director')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", code) VALUES ('s1', 'p1', '開場曲', 0, 'S01'), ('s2', 'p1', '安可', 1, 'S02'), ('z1', 'p2', '別的歌', 0, 'Z1')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order") VALUES
      ('o_a', 'p1', 'A', '主牆', 'led_panel', 0), ('o_b', 'p1', 'B', '側牆', 'led_panel', 1), ('z_a', 'p2', 'A', '主牆', 'other', 0)`),
  ]);
  const env = { DB: db, AUTH_SECRET: 'test-secret' };
  const tokens = {};
  for (const [id, code] of [['u_admin', 'ADMIN-1'], ['u_dir', 'DIR-1'], ['u_pm', 'PM-1']]) {
    const r = await worker.fetch(new Request(`${BASE}/api/auth/login`, { method: 'POST', body: JSON.stringify({ accessCode: code }), headers: { 'content-type': 'application/json' } }), env);
    tokens[id] = (await r.json()).token;
  }
  const as = (who) => async (method, path, body) => {
    const r = await worker.fetch(new Request(BASE + path, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    let data = null;
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data };
  };
  const call = as('u_admin');
  const mr = await call('POST', `${P}/mechanisms`, { name: '升降台', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, travelMin: 0, travelMax: 3, defaultValue: 0, objectIds: [] });
  assert.equal(mr.status, 201, JSON.stringify(mr.data));
  return { db, call, dir: as('u_dir'), pm: as('u_pm'), m1: mr.data.mechanism.id };
}

const look = (m1) => ({
  objects: [
    { objectId: 'o_a', position: { x: 1, y: 2, z: 3 }, rotation: null, scale: null, visible: true, customProps: null, own: true, ownFields: ['position', 'visible'] },
    { objectId: 'o_b', position: { x: 5, y: 0, z: 0 }, rotation: null, scale: null, visible: null, customProps: null, own: true, ownFields: ['position'] },
  ],
  mechanisms: [{ mechanismId: m1, value: 2, delaySec: 1, durationSec: 3, carried: false }],
});
const mk = async (call, body) => {
  const r = await call('POST', `${P}/library-cues`, body);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
};
const slots = (db, song) => db.raw.prepare(`SELECT id, "order", video_time_sec t, library_cue_id lc FROM cues WHERE song_id = ? ORDER BY "order"`).all(song);
const acts = (db) => db.raw.prepare(`SELECT action, target_type t, payload FROM activity_log ORDER BY rowid`).all().map(r => ({ ...r, payload: JSON.parse(r.payload) }));

test('建立：沒給編號 → 預填建議編號；列表照自然排序（1, 2, 2.5, 3-1, 12）；編號 / 名稱檢查', async () => {
  const { call, m1 } = await build();
  const a = await mk(call, { name: '副歌', look: look(m1) });
  assert.equal(a.libraryCue.label, '1');
  assert.deepEqual(a.libraryCue.counts, { objects: 2, mechanisms: 1 });
  for (const label of ['12', '2.5', '3-1', '2']) await mk(call, { label, name: '之' + label });
  const l = await call('GET', `${P}/library-cues`);
  assert.deepEqual(l.data.libraryCues.map(x => x.label), ['1', '2', '2.5', '3-1', '12']);
  assert.equal(l.data.libraryCues[0].usage.slotCount, 0);
  // 編號重複（不分大小寫、前後空白）→ 409；空白 / 太長 → 400
  assert.equal((await call('POST', `${P}/library-cues`, { label: ' 3-1 ', name: 'x' })).data.error, '這個編號已經有了');
  assert.equal((await call('POST', `${P}/library-cues`, { label: 'a', name: 'x' })).status, 201);
  const dupCase = await call('POST', `${P}/library-cues`, { label: 'A', name: 'x' });
  assert.equal(dupCase.status, 409);
  const empty = await call('POST', `${P}/library-cues`, { label: '  ', name: 'x' });
  assert.deepEqual([empty.status, empty.data.error], [400, '編號不能空白']);
  const long = await call('POST', `${P}/library-cues`, { label: '12345678901234567', name: 'x' });
  assert.deepEqual([long.status, long.data.error], [400, '編號最多 16 個字']);
  assert.equal((await call('POST', `${P}/library-cues`, { name: '  ' })).status, 400);
  // 建議編號：最大的開頭整數 + 1
  assert.equal((await mk(call, { name: '接著' })).libraryCue.label, '13');
});

test('另存：放到哪裡 — 只存進 Cue 庫 / 換掉這首歌的某個 cue / 這首歌加一個 cue（照時間排）', async () => {
  const { db, call, m1 } = await build();
  const base = (await mk(call, { label: '12', name: '副歌全開', look: look(m1) })).libraryCue;
  const s1 = (await call('POST', `${P}/songs/s1/cues`, { libraryCueId: base.id, videoTimeSec: 30 })).data.slot;
  const s2 = (await call('POST', `${P}/songs/s1/cues`, { libraryCueId: base.id, videoTimeSec: 60 })).data.slot;
  assert.equal(s1.libraryCue.label, '12');
  // 1) 不放（只進 Cue 庫）：畫面原樣複製，來源不動
  const x = await mk(call, { label: '12-1', basedOnId: base.id });
  assert.equal(x.libraryCue.name, '副歌全開');       // 名稱沒給 → 用原名稱
  assert.equal(x.libraryCue.basedOnId, base.id);
  assert.equal(x.slot, undefined);
  assert.deepEqual((await call('GET', `${P}/library-cues/${x.libraryCue.id}/look`)).data.mechanisms,
    (await call('GET', `${P}/library-cues/${base.id}/look`)).data.mechanisms);
  assert.deepEqual(x.libraryCue.counts, { objects: 2, mechanisms: 1 });
  // 2) 換掉：把 1:00 那個 slot 指到新的 cue
  const y = await mk(call, { basedOnId: base.id, name: '副歌B', place: { songId: 's1', replaceCueId: s2.id } });
  assert.equal(y.libraryCue.label, '13');            // 沒給編號 → 建議編號
  assert.equal(y.slot.id, s2.id);
  assert.equal(y.slot.libraryCueId, y.libraryCue.id);
  assert.deepEqual(y.libraryCue.usage.slots.map(s => s.videoTimeSec), [60]);
  // 3) 加一個：0:45 插在中間，順序照時間
  const z = await mk(call, { label: '14', name: '橋段', look: look(m1), place: { songId: 's1', videoTimeSec: 45 } });
  assert.equal(z.slot.videoTimeSec, 45);
  assert.deepEqual(slots(db, 's1').map(s => s.t), [30, 45, 60]);
  assert.deepEqual(z.order.map(o => o.order), [0, 1, 2]);
  // 放的位置有問題 → 整個不建（Cue 庫也不會多一個）
  const before = db.raw.prepare(`SELECT COUNT(*) n FROM library_cues`).get().n;
  const tie = await call('POST', `${P}/library-cues`, { label: '15', name: 'x', place: { songId: 's1', videoTimeSec: 45 } });
  assert.deepEqual([tie.status, tie.data.error], [409, '這首歌 0:45 已經有 cue 了']);
  assert.equal((await call('POST', `${P}/library-cues`, { label: '15', name: 'x', place: { songId: 's2', replaceCueId: s1.id } })).status, 404);
  assert.equal((await call('POST', `${P}/library-cues`, { label: '15', name: 'x', place: { songId: 'nope', videoTimeSec: 1 } })).status, 404);
  assert.equal((await call('POST', `${P}/library-cues`, { label: '15', name: 'x', place: { songId: 's1', videoTimeSec: -1 } })).status, 400);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM library_cues`).get().n, before);
  // 另存編號重複 → 409，也不會動到 slot
  const dup = await call('POST', `${P}/library-cues`, { label: '12', name: 'x', place: { songId: 's1', replaceCueId: s1.id } });
  assert.equal(dup.status, 409);
  assert.equal(slots(db, 's1').find(s => s.id === s1.id).lc, base.id);
  // 活動文字用的紀錄
  const saveAs = acts(db).find(a => a.t === 'library_cue' && a.payload.label === '12-1');
  assert.deepEqual([saveAs.payload.basedOnLabel, saveAs.payload.basedOnName], ['12', '副歌全開']);
});

test('slot：加 cue（沒時間排在最後）、換指向、改時間重排、時間重複 409、移除', async () => {
  const { db, call, m1 } = await build();
  const a = (await mk(call, { label: '1', name: 'A', look: look(m1) })).libraryCue;
  const b = (await mk(call, { label: '17', name: 'B' })).libraryCue;
  const add = async (lc, t) => (await call('POST', `${P}/songs/s1/cues`, { libraryCueId: lc, ...(t === undefined ? {} : { videoTimeSec: t }) }));
  const c17 = (await add(b.id, 0)).data.slot;       // 先用 Cue 17 開場，再 Cue 1（順序看時間、不看編號）
  const c1 = (await add(a.id, 20)).data.slot;
  const free = (await add(a.id)).data.slot;          // 沒有時間 → 跟在最後一個後面
  assert.equal(free.videoTimeSec, null);
  assert.deepEqual(slots(db, 's1').map(s => s.id), [c17.id, c1.id, free.id]);
  assert.equal(c17.crossfadeSeconds, 1);
  assert.equal(c17.name, 'B');
  // 重複時間
  const dup = await add(a.id, 20);
  assert.deepEqual([dup.status, dup.data.error], [409, '這首歌 0:20 已經有 cue 了']);
  assert.equal((await add(a.id, 20.0002)).status, 409);
  assert.equal((await add(a.id, 99999)).status, 400);
  assert.equal((await add('lc_nope', 5)).status, 404);
  // 改時間 → 重排：c17 改到 50 秒 → 排到 c1 後面；沒時間的 free 跟著 c1
  const mv = await call('PATCH', `${P}/songs/s1/cues/${c17.id}`, { videoTimeSec: 50 });
  assert.equal(mv.status, 200);
  assert.deepEqual(slots(db, 's1').map(s => s.id), [c1.id, free.id, c17.id]);
  assert.deepEqual(mv.data.order.map(o => o.id), [c1.id, free.id, c17.id]);
  // 同一個時間（不改）不算重複；改成別人的時間 409
  assert.equal((await call('PATCH', `${P}/songs/s1/cues/${c17.id}`, { videoTimeSec: 50 })).status, 200);
  assert.equal((await call('PATCH', `${P}/songs/s1/cues/${c17.id}`, { videoTimeSec: 20 })).status, 409);
  assert.equal((await call('PATCH', `${P}/songs/s1/cues/${c17.id}`, { videoTimeSec: 36001 })).status, 400);
  // 清掉時間（null）也行
  assert.equal((await call('PATCH', `${P}/songs/s1/cues/${c17.id}`, { videoTimeSec: null })).data.slot.videoTimeSec, null);
  // 換指向 + 同時改名稱（其他欄位走原本的）
  const re = await call('PATCH', `${P}/songs/s1/cues/${c1.id}`, { libraryCueId: b.id, name: '副歌' });
  assert.equal(re.status, 200);
  const row = db.raw.prepare(`SELECT library_cue_id lc, name FROM cues WHERE id = ?`).get(c1.id);
  assert.deepEqual([row.lc, row.name], [b.id, '副歌']);
  assert.equal((await call('PATCH', `${P}/songs/s1/cues/${c1.id}`, { libraryCueId: 'lc_nope' })).status, 404);
  // 別的專案的 Cue 庫的 cue 不能指
  db.raw.exec(`INSERT INTO library_cues (id, project_id, label, name) VALUES ('lc_other', 'p2', '1', 'X')`);
  assert.equal((await call('PATCH', `${P}/songs/s1/cues/${c1.id}`, { libraryCueId: 'lc_other' })).status, 404);
  // 移除 slot：Cue 庫的 cue 還在
  assert.equal((await call('DELETE', `${P}/songs/s1/cues/${free.id}`)).status, 200);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM library_cues WHERE project_id = 'p1'`).get().n, 2);
  // 活動紀錄
  const a1 = acts(db);
  assert.ok(a1.some(x => x.t === 'cue' && x.payload.kind === 'retime' && x.payload.toTimeSec === 50 && x.payload.fromTimeSec === 0));
  assert.ok(a1.some(x => x.t === 'cue' && x.payload.kind === 'repoint' && x.payload.libraryLabel === '17' && x.payload.fromLabel === '1'));
  assert.ok(a1.some(x => x.action === 'delete' && x.t === 'cue' && x.payload.libraryLabel === '1'));
  assert.ok(a1.some(x => x.action === 'create' && x.t === 'cue' && x.payload.libraryLabel === '17' && x.payload.songName === '開場曲'));
});

test('舊資料裡沒有時間的 slot 在中間時，加新的照規則重排（跟在前一個後面）', async () => {
  const { db, call } = await build();
  const a = (await mk(call, { label: '1', name: 'A' })).libraryCue;
  db.raw.exec(`INSERT INTO cues (id, song_id, name, "order", status, video_time_sec, library_cue_id) VALUES
    ('k0', 's2', 'x0', 0, 'master', 10, '${a.id}'), ('k1', 's2', 'x1', 1, 'master', NULL, '${a.id}'), ('k2', 's2', 'x2', 2, 'master', 30, '${a.id}')`);
  const r = await call('POST', `${P}/songs/s2/cues`, { libraryCueId: a.id, videoTimeSec: 20 });
  assert.equal(r.status, 201);
  assert.deepEqual(slots(db, 's2').map(s => s.id), ['k0', 'k1', r.data.slot.id, 'k2']);
});

test('改名 / 改編號（驗證）/ 備註', async () => {
  const { db, call } = await build();
  const a = (await mk(call, { label: '1', name: 'A' })).libraryCue;
  await mk(call, { label: '2', name: 'B' });
  const p1 = await call('PATCH', `${P}/library-cues/${a.id}`, { name: '開場' });
  assert.equal(p1.data.libraryCue.name, '開場');
  const p2 = await call('PATCH', `${P}/library-cues/${a.id}`, { label: '3-1' });
  assert.equal(p2.data.libraryCue.label, '3-1');
  assert.equal((await call('PATCH', `${P}/library-cues/${a.id}`, { label: '2' })).status, 409);
  assert.equal((await call('PATCH', `${P}/library-cues/${a.id}`, { label: ' ' })).data.error, '編號不能空白');
  assert.equal((await call('PATCH', `${P}/library-cues/${a.id}`, { label: 'x'.repeat(17) })).data.error, '編號最多 16 個字');
  // 改成自己現在的編號 OK
  assert.equal((await call('PATCH', `${P}/library-cues/${a.id}`, { label: '3-1' })).status, 200);
  assert.equal((await call('PATCH', `${P}/library-cues/${a.id}`, { name: '' })).status, 400);
  assert.equal((await call('PATCH', `${P}/library-cues/${a.id}`, { note: '這是備註' })).data.libraryCue.note, '這是備註');
  assert.equal((await call('PATCH', `${P}/library-cues/${a.id}`, {})).status, 400);
  assert.equal((await call('PATCH', `${P}/library-cues/lc_nope`, { name: 'x' })).status, 404);
  const log = acts(db).filter(x => x.t === 'library_cue' && x.action === 'update').map(x => x.payload);
  assert.ok(log.some(p => p.kind === 'rename' && p.fromName === 'A' && p.toName === '開場'));
  assert.ok(log.some(p => p.kind === 'relabel' && p.fromLabel === '1' && p.toLabel === '3-1'));
});

test('誰在用 + 刪除：還有歌在用就擋（409 列出哪幾首歌），拿掉之後才能刪', async () => {
  const { db, call } = await build();
  const a = (await mk(call, { label: '1', name: 'A' })).libraryCue;
  await call('POST', `${P}/songs/s1/cues`, { libraryCueId: a.id, videoTimeSec: 5 });
  await call('POST', `${P}/songs/s1/cues`, { libraryCueId: a.id, videoTimeSec: 15 });
  await call('POST', `${P}/songs/s2/cues`, { libraryCueId: a.id, videoTimeSec: 5 });
  const u = (await call('GET', `${P}/library-cues/${a.id}/usage`)).data.usage;
  assert.deepEqual([u.songCount, u.slotCount], [2, 3]);
  assert.deepEqual(u.slots.map(s => [s.songName, s.videoTimeSec]), [['開場曲', 5], ['開場曲', 15], ['安可', 5]]);
  const g = await call('GET', `${P}/library-cues/${a.id}`);
  assert.equal(g.data.libraryCue.usage.slotCount, 3);
  const del = await call('DELETE', `${P}/library-cues/${a.id}`);
  assert.equal(del.status, 409);
  assert.equal(del.data.error, '還有 2 首歌在用這個 cue，先從這些歌拿掉才能刪');
  assert.equal(del.data.usage.slotCount, 3);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM library_cues WHERE id = ?`).get(a.id).n, 1);
  for (const c of db.raw.prepare(`SELECT id, song_id FROM cues WHERE library_cue_id = ?`).all(a.id)) {
    assert.equal((await call('DELETE', `${P}/songs/${c.song_id}/cues/${c.id}`)).status, 200);
  }
  assert.equal((await call('DELETE', `${P}/library-cues/${a.id}`)).status, 200);
  assert.equal((await call('GET', `${P}/library-cues/${a.id}`)).status, 404);
  assert.equal((await call('DELETE', `${P}/library-cues/${a.id}`)).status, 404);
});

test('整個畫面 PUT：舊 rev 409 且一個字都沒寫進去；帶對 rev 全部換掉；壞資料整個不寫（原子性）；回傳 previous', async () => {
  const { db, call, m1 } = await build();
  const a = (await mk(call, { label: '1', name: 'A', look: look(m1) })).libraryCue;
  const l0 = (await call('GET', `${P}/library-cues/${a.id}/look`)).data;
  assert.equal(l0.rev, 0);
  assert.deepEqual(l0.objects.map(o => [o.objectId, o.ownFields]), [['o_a', ['position', 'visible']], ['o_b', ['position']]]);
  assert.equal(l0.mechanisms[0].delaySec, 1);
  const next = {
    objects: [{ objectId: 'o_b', position: null, rotation: { pitch: 1, yaw: 2, roll: 3 }, scale: null, visible: false, customProps: null, own: true, ownFields: ['rotation', 'visible'] }],
    mechanisms: [{ mechanismId: m1, value: 1.5, delaySec: null, durationSec: null, carried: true }],
  };
  const ok1 = await call('PUT', `${P}/library-cues/${a.id}/look`, { ifRev: 0, ...next });
  assert.equal(ok1.status, 200);
  assert.equal(ok1.data.rev, 1);
  assert.equal(ok1.data.previous.objects.length, 2);           // 復原用
  const l1 = (await call('GET', `${P}/library-cues/${a.id}/look`)).data;
  assert.equal(l1.rev, 1);
  assert.deepEqual(l1.objects, next.objects);
  assert.deepEqual(l1.mechanisms, next.mechanisms);
  // 舊 rev（0）→ 409，什麼都沒動（包含「只差一版」的舊 rev）
  const snap = () => JSON.stringify([db.raw.prepare(`SELECT * FROM library_cue_object_states ORDER BY 1,2`).all(), db.raw.prepare(`SELECT * FROM library_cue_mechanism_positions ORDER BY 1,2`).all()]);
  const before = snap();
  const stale = await call('PUT', `${P}/library-cues/${a.id}/look`, { ifRev: 0, objects: [], mechanisms: [] });
  assert.deepEqual([stale.status, stale.data.error, stale.data.rev], [409, '這個 cue 剛剛被別人改過', 1]);
  assert.equal(snap(), before);
  assert.equal(db.raw.prepare(`SELECT rev FROM library_cues WHERE id = ?`).get(a.id).rev, 1);
  // 沒帶 ifRev → 照目前的 rev 寫；undo：把 previous 寫回去
  const undo = await call('PUT', `${P}/library-cues/${a.id}/look`, { objects: ok1.data.previous.objects, mechanisms: ok1.data.previous.mechanisms });
  assert.equal(undo.status, 200);
  assert.deepEqual((await call('GET', `${P}/library-cues/${a.id}/look`)).data.objects, l0.objects);
  // 壞資料：物件不在這個專案 / 同一個物件兩次 / 沿用的機關有時間 / 機關不存在 → 400，原本的畫面不動
  const keep = snap();
  const badLooks = [
    { objects: [{ objectId: 'z_a', own: true, ownFields: [] }], mechanisms: [] },
    { objects: [{ objectId: 'o_a', own: true, ownFields: [] }, { objectId: 'o_a', own: true, ownFields: [] }], mechanisms: [] },
    { objects: [], mechanisms: [{ mechanismId: m1, value: 1, delaySec: 2, durationSec: null, carried: true }] },
    { objects: [], mechanisms: [{ mechanismId: 'mech_nope', value: 1, delaySec: null, durationSec: null, carried: false }] },
    { objects: [{ objectId: 'o_a', visible: 'yes', own: true, ownFields: [] }], mechanisms: [] },
    { objects: 'x', mechanisms: [] },
  ];
  for (const b of badLooks) assert.equal((await call('PUT', `${P}/library-cues/${a.id}/look`, b)).status, 400, JSON.stringify(b));
  assert.equal(snap(), keep);
  // 空畫面可以整個清空
  assert.equal((await call('PUT', `${P}/library-cues/${a.id}/look`, { objects: [], mechanisms: [] })).status, 200);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM library_cue_object_states`).get().n, 0);
  assert.equal((await call('PUT', `${P}/library-cues/lc_nope/look`, { objects: [], mechanisms: [] })).status, 404);
  // 更新畫面的活動紀錄有「幾首歌在用」
  assert.ok(acts(db).some(x => x.t === 'library_cue' && x.payload.kind === 'look' && x.payload.songCount === 0));
});

test('GET states：跟 slot 的物件狀態同一個格式（沒提到的物件是預設）', async () => {
  const { call, m1 } = await build();
  const a = (await mk(call, { label: '1', name: 'A', look: look(m1) })).libraryCue;
  const st = (await call('GET', `${P}/library-cues/${a.id}/states`)).data.states;
  assert.deepEqual(st.find(s => s.objectId === 'o_a').effective.position, { x: 1, y: 2, z: 3 });
  assert.equal(st.length, 2);
});

test('權限：導演 / 沒登入不能寫（403 / 401）；導演可以看；專案製作（專案角色 admin）可以寫；舊模式專案回 400', async () => {
  const { db, call, dir, pm, m1 } = await build();
  const a = (await mk(call, { label: '1', name: 'A', look: look(m1) })).libraryCue;
  const slot = (await call('POST', `${P}/songs/s1/cues`, { libraryCueId: a.id, videoTimeSec: 5 })).data.slot;
  for (const path of ['library-cues', `library-cues/${a.id}`, `library-cues/${a.id}/look`, `library-cues/${a.id}/usage`, `library-cues/${a.id}/states`]) {
    assert.equal((await dir('GET', `${P}/${path}`)).status, 200, path);
  }
  const writes = [
    ['POST', 'library-cues', { name: 'x' }], ['PATCH', `library-cues/${a.id}`, { name: 'x' }], ['DELETE', `library-cues/${a.id}`],
    ['PUT', `library-cues/${a.id}/look`, { objects: [], mechanisms: [] }],
    ['POST', 'songs/s1/cues', { libraryCueId: a.id, videoTimeSec: 9 }],
    ['PATCH', `songs/s1/cues/${slot.id}`, { videoTimeSec: 9 }], ['PATCH', `songs/s1/cues/${slot.id}`, { libraryCueId: a.id }],
  ];
  for (const [m, path, body] of writes) assert.equal((await dir(m, `${P}/${path}`, body)).status, 403, `${m} ${path}`);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM library_cues`).get().n, 1);
  assert.equal(db.raw.prepare(`SELECT video_time_sec t FROM cues WHERE id = ?`).get(slot.id).t, 5);
  const r = await worker.fetch(new Request(`${BASE}${P}/library-cues`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }), { DB: db, AUTH_SECRET: 'test-secret' });
  assert.equal(r.status, 401);
  // 專案製作可以寫
  const w = await pm('POST', `${P}/library-cues`, { label: '2', name: '專案製作建的' });
  assert.equal(w.status, 201);
  assert.equal((await pm('PUT', `${P}/library-cues/${w.data.libraryCue.id}/look`, { objects: [], mechanisms: [] })).status, 200);
  // 舊模式專案：每個新網址都回 400
  const P2 = '/api/projects/p2';
  for (const [m, path, body] of [['GET', 'library-cues'], ['POST', 'library-cues', { name: 'x' }], ['GET', 'library-cues/lc_x'], ['GET', 'library-cues/lc_x/look'],
    ['PUT', 'library-cues/lc_x/look', { objects: [], mechanisms: [] }], ['POST', 'songs/z1/cues', { libraryCueId: 'lc_x' }]]) {
    const x = await call(m, `${P2}/${path}`, body);
    assert.equal(x.status, 400, `${m} ${path}`);
    assert.equal(x.data.error, '這個專案還沒有 Cue 庫');
  }
  // 舊模式專案舊的寫法完全不變
  const old = await call('POST', `${P2}/songs/z1/cues`, { name: '舊的 cue' });
  assert.equal(old.status, 201);
  assert.equal((await call('PATCH', `${P2}/songs/z1/cues/${old.data.id}`, { videoTimeSec: 12.5 })).status, 200);
  assert.equal(db.raw.prepare(`SELECT video_time_sec t FROM cues WHERE id = ?`).get(old.data.id).t, 12.5);
});

test('別的專案的 Cue 庫的 cue 看不到、改不到；刪歌不會刪 Cue 庫的 cue', async () => {
  const { db, call } = await build();
  db.raw.exec(`INSERT INTO library_cues (id, project_id, label, name) VALUES ('lc_other', 'p2', '1', 'X')`);
  assert.equal((await call('GET', `${P}/library-cues/lc_other`)).status, 404);
  assert.equal((await call('PATCH', `${P}/library-cues/lc_other`, { name: 'y' })).status, 404);
  assert.equal((await call('DELETE', `${P}/library-cues/lc_other`)).status, 404);
  assert.equal((await call('POST', `${P}/library-cues`, { name: 'z', basedOnId: 'lc_other' })).status, 404);
  const a = (await mk(call, { label: '1', name: 'A' })).libraryCue;      // 不同專案同編號沒關係
  await call('POST', `${P}/songs/s1/cues`, { libraryCueId: a.id, videoTimeSec: 1 });
  assert.equal((await call('DELETE', `${P}/songs/s1`)).status, 200);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM library_cues WHERE id = ?`).get(a.id).n, 1);
});
