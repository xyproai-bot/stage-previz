// 跑法：cd cf-worker && npm test
// LED 版型時間線（0039，同一首歌中途換版型）。走真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1）：
//   migration 0039 只加表 / 欄位，舊資料不動，舊的 INSERT 照樣寫得進去；
//   製作整份換掉時間線（導演 403）；檢查：版型都存在 / 自己排的 / 畫布一樣大、Cue 要有影片時間、時間大於 0、同一個時間只能換一次；
//   Cue 改時間 → 換版型的點跟著動；Cue 刪掉 → 點一起拿掉；版型被時間線用著不能刪、不能只改它的畫布大小；舊的版型選單換開頭也守同一套規則；
//   影片版本上傳時存整條時間線（Cue 的時間那一刻定下來），之後 Cue 動了舊版不變；分享連結的影片帶時間線；沒有時間線的歌跟以前一模一樣；
//   複製專案 / 匯出匯入帶著換版型的點（歌、Cue、版型換成新的 id）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, applyMigrations, freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';

const BASE = 'https://proxy.test';
const P = '/api/projects/p1';

async function setup() {
  const db = freshDb();
  const users = [['u_admin', '製作', 'admin', 'ADMIN-1'], ['u_dir', '王導', 'director', 'DIR-1']];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, `${id}@x.test`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name, led_canvas) VALUES ('p1', '巡演', '{"width":8800,"height":2024}')`),
    db.prepare(`INSERT INTO projects (id, name, led_canvas) VALUES ('p2', '別的專案', '{"width":1920,"height":1080}')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", code) VALUES ('s1', 'p1', '開場', 0, 'S01'), ('s2', 'p1', '安可', 1, 'S02'), ('sx', 'p2', '別專案的歌', 0, 'S01')`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order") VALUES
      ('oa', 'p1', 'LED_A', '中間底幕', 'led_panel', 0), ('ob', 'p1', 'LED_B', '左側幕', 'led_panel', 1), ('ox', 'p2', 'X', '別專案的 LED', 'led_panel', 0)`),
    db.prepare(`INSERT INTO cues (id, song_id, name, "order", video_time_sec, status) VALUES
      ('c1', 's1', 'Cue 1', 0, 5, 'master'), ('c4', 's1', 'Cue 4', 3, 83, 'master'), ('c6', 's1', 'Cue 6', 5, 130.5, 'master'),
      ('cn', 's1', 'Cue 沒時間', 6, NULL, 'master'), ('cp', 's1', '提案的 Cue', 7, 99, 'proposal'), ('cs2', 's2', '別首歌的 Cue', 0, 10, 'master')`),
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
    return { status: r.status, data, env };
  };
  // 三個版型：A、B 一樣大（4400×200），C 不一樣（2200×100）
  const mk = async (name, canvas, dest) => (await call('u_admin', 'POST', `${P}/led-templates`, {
    name, canvas, scalePct: 50, screens: [{ key: 'o:oa', dest, rotate: 0, flipH: false, flipV: false }],
  })).data.template;
  const A = await mk('版型 A', { width: 4400, height: 200 }, { x: 0, y: 0, w: 4400, h: 200 });
  const B = await mk('版型 B', { width: 4400, height: 200 }, { x: 0, y: 100, w: 2200, h: 100 });
  const C = await mk('版型 C', { width: 2200, height: 100 }, { x: 0, y: 0, w: 2200, h: 100 });
  const full = (await call('u_admin', 'GET', `${P}/led-templates`)).data.templates.find(t => t.kind === 'full');
  const put = (who, songId, body) => call(who, 'PUT', `${P}/songs/${songId}/template-timeline`, body);
  return { db, env, call, put, A, B, C, full };
}

const songRow = async (call, id) => (await call('u_admin', 'GET', `${P}/songs`)).data.songs.find(s => s.id === id);
const upload = (call, body = {}) => call('u_admin', 'POST', `${P}/songs/s1/videos/uploads`, { filename: 'a.mp4', sizeBytes: 1000, mime: 'video/mp4', ...body });

test('migration 0039：只加表和欄位，舊資料不動；舊的 INSERT 照樣能寫；CHECK 擋壞值；Cue 刪掉點跟著刪', async () => {
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0039' });
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p', 'P')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order") VALUES ('s', 'p', '歌', 0)`),
    db.prepare(`INSERT INTO song_videos (id, project_id, song_id, source, r2_key, mime, status) VALUES ('v', 'p', 's', 'upload', 'k', 'video/mp4', 'ready')`),
    db.prepare(`INSERT INTO cues (id, song_id, name, "order", video_time_sec) VALUES ('c', 's', 'Cue', 0, 10)`),
    db.prepare(`INSERT INTO led_templates (id, project_id, name, canvas_w, canvas_h) VALUES ('t1', 'p', 'A', 100, 100)`),
  ]);
  applyMigrations(db, { only: '0039' });
  assert.equal((await db.prepare(`SELECT template_timeline FROM song_videos`).first()).template_timeline, null);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM song_template_switches`).first()).n, 0);
  // 舊版後台的 INSERT（沒有新欄位）
  await db.prepare(`INSERT INTO song_videos (id, project_id, song_id, title, note, source, r2_key, mime, size_bytes, status, created_at, updated_at) VALUES ('v2', 'p', 's', '', '', 'upload', 'k2', 'video/mp4', 1, 'uploading', 'x', 'x')`).run();
  // CHECK：Cue 和時間至少要有一個、時間不能是負的
  await assert.rejects(db.prepare(`INSERT INTO song_template_switches (id, song_id, template_id) VALUES ('w0', 's', 't1')`).run(), /CHECK/);
  await assert.rejects(db.prepare(`INSERT INTO song_template_switches (id, song_id, at_sec, template_id) VALUES ('w0', 's', -1, 't1')`).run(), /CHECK/);
  await db.prepare(`INSERT INTO song_template_switches (id, song_id, cue_id, at_sec, template_id) VALUES ('w1', 's', 'c', 10, 't1')`).run();
  await db.prepare(`INSERT INTO song_template_switches (id, song_id, at_sec, template_id) VALUES ('w2', 's', 20, 't1')`).run();
  // Cue 刪掉 → 用它的那個點跟著刪；純時間的不動
  await db.prepare(`DELETE FROM cues WHERE id = 'c'`).run();
  assert.deepEqual((await db.prepare(`SELECT id FROM song_template_switches`).all()).results.map(r => r.id), ['w2']);
  // 歌刪掉 → 點跟著刪
  await db.prepare(`DELETE FROM songs WHERE id = 's'`).run();
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM song_template_switches`).first()).n, 0);
});

test('設定時間線：只有製作；開頭存在 songs.template_id、換版型的點照時間排；GET songs 帶 Cue 的名字和目前的影片時間', async () => {
  const { call, put, A, B } = await setup();
  const body = { start: A.id, switches: [{ cueId: 'c6', templateId: A.id }, { cueId: 'c4', templateId: B.id }, { atSec: 20, templateId: B.id }] };
  assert.equal((await put(null, 's1', body)).status, 401);
  assert.equal((await put('u_dir', 's1', body)).status, 403);
  const r = await put('u_admin', 's1', body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.templateId, A.id);
  assert.equal(r.data.templateSwitches.length, 3);
  const s1 = await songRow(call, 's1');
  assert.equal(s1.templateId, A.id);
  assert.deepEqual(s1.templateSwitches.map(w => [w.cueId, w.cueName, w.cueTimeSec, w.atSec, w.templateId]), [
    ['c6', 'Cue 6', 130.5, 130.5, A.id], ['c4', 'Cue 4', 83, 83, B.id], [null, null, null, 20, B.id],
  ]);
  assert.deepEqual((await songRow(call, 's2')).templateSwitches, []);
  // 導演也讀得到
  const dir = (await call('u_dir', 'GET', `${P}/songs`)).data.songs.find(s => s.id === 's1');
  assert.equal(dir.templateSwitches.length, 3);
  // 整份換掉：再送一次只剩一個
  assert.equal((await put('u_admin', 's1', { start: B.id, switches: [{ atSec: 30, templateId: A.id }] })).status, 200);
  const again = await songRow(call, 's1');
  assert.equal(again.templateId, B.id);
  assert.equal(again.templateSwitches.length, 1);
  // 清掉：沒有換版型的點，開頭照樣留著
  assert.equal((await put('u_admin', 's1', { start: B.id, switches: [] })).status, 200);
  const cleared = await songRow(call, 's1');
  assert.deepEqual(cleared.templateSwitches, []);
  assert.equal(cleared.templateId, B.id);
  // 沒有時間線的歌：開頭 null = 整張畫布，跟以前一樣
  assert.equal((await put('u_admin', 's1', { start: null, switches: [] })).status, 200);
  assert.equal((await songRow(call, 's1')).templateId, null);
});

test('檢查：畫布大小不一樣 / 整張畫布沒有排法 / Cue 沒時間或不是正式的 / 0 秒 / 同一個時間 / 別的專案 / 太多 / 格式', async () => {
  const { put, A, B, C, full } = await setup();
  const err = async (body, status = 409) => {
    const r = await put('u_admin', 's1', body);
    assert.equal(r.status, status, JSON.stringify(r.data));
    assert.ok(typeof r.data.error === 'string' && r.data.error.length > 0);
    return r.data.error;
  };
  // 畫布大小不一樣：訊息說兩個版型各是多大
  const mismatch = await err({ start: A.id, switches: [{ cueId: 'c4', templateId: C.id }] });
  assert.match(mismatch, /4400×200/);
  assert.match(mismatch, /2200×100/);
  assert.match(mismatch, /版型 A/);
  assert.match(mismatch, /版型 C/);
  await err({ start: C.id, switches: [{ cueId: 'c4', templateId: A.id }] });
  // 整張畫布當開頭或當目標都不行（沒有排法）
  assert.match(await err({ start: null, switches: [{ cueId: 'c4', templateId: A.id }] }), /自己排的版型/);
  assert.match(await err({ start: full.id, switches: [{ cueId: 'c4', templateId: A.id }] }), /自己排的版型/);
  assert.match(await err({ start: A.id, switches: [{ cueId: 'c4', templateId: full.id }] }), /整張畫布/);
  // Cue
  assert.match(await err({ start: A.id, switches: [{ cueId: 'cn', templateId: B.id }] }), /Cue 沒時間.*影片時間/);
  await err({ start: A.id, switches: [{ cueId: 'cp', templateId: B.id }] });   // 提案
  await err({ start: A.id, switches: [{ cueId: 'cs2', templateId: B.id }] });  // 別首歌的 Cue
  await err({ start: A.id, switches: [{ cueId: 'nope', templateId: B.id }] });
  // 時間
  assert.match(await err({ start: A.id, switches: [{ atSec: 0, templateId: B.id }] }), /0 秒/);
  assert.match(await err({ start: A.id, switches: [{ cueId: 'c4', templateId: B.id }, { atSec: 83, templateId: A.id }] }), /同一個時間/);
  // 版型不存在 / 別的專案
  await err({ start: 'lt_nope', switches: [] }, 400);
  await err({ start: A.id, switches: [{ atSec: 5, templateId: 'lt_nope' }] });
  // 格式
  await err({ start: A.id, switches: [{ templateId: B.id }] }, 400);                                      // 沒有 Cue 也沒有時間
  await err({ start: A.id, switches: [{ cueId: 'c4', atSec: 5, templateId: B.id }] }, 400);              // 兩個都有
  await err({ start: A.id, switches: [{ atSec: -3, templateId: B.id }] }, 400);
  await err({ start: A.id, switches: [{ atSec: 'abc', templateId: B.id }] }, 400);
  await err({ start: A.id, switches: [{ atSec: 5 }] }, 400);
  await err({ start: A.id, switches: Array.from({ length: 13 }, (_, i) => ({ atSec: 5 + i, templateId: i % 2 ? A.id : B.id })) }, 400);
  await err({ start: A.id, switches: 'x' }, 400);
  // 失敗不會動到原本的設定
  assert.equal((await put('u_admin', 's1', { start: A.id, switches: [{ atSec: '1:23.5', templateId: B.id }] })).status, 200);
  await err({ start: A.id, switches: [{ atSec: 5, templateId: C.id }] });
});

test('Cue 改了影片時間 → 換版型的點跟著動；Cue 刪掉 → 點一起拿掉；時間被清掉 → 點還在、沒有時間（畫面上標紅）', async () => {
  const { call, put, A, B } = await setup();
  await put('u_admin', 's1', { start: A.id, switches: [{ cueId: 'c4', templateId: B.id }, { atSec: 100, templateId: A.id }] });
  await call('u_admin', 'PATCH', `${P}/songs/s1/cues/c4`, { videoTimeSec: 90 });
  let sw = (await songRow(call, 's1')).templateSwitches;
  assert.equal(sw[0].cueTimeSec, 90);
  await call('u_admin', 'PATCH', `${P}/songs/s1/cues/c4`, { videoTimeSec: null });
  sw = (await songRow(call, 's1')).templateSwitches;
  assert.equal(sw.length, 2);
  assert.equal(sw[0].cueId, 'c4');
  assert.equal(sw[0].cueTimeSec, null);
  const del = await call('u_admin', 'DELETE', `${P}/songs/s1/cues/c4`);
  assert.equal(del.status, 200, JSON.stringify(del.data));
  sw = (await songRow(call, 's1')).templateSwitches;
  assert.deepEqual(sw.map(w => w.atSec), [100]);
});

test('版型被時間線用著：不能刪（算進幾首歌）、不能只改它的畫布大小；改名字 / 放法可以；舊的版型選單換開頭守同一套規則', async () => {
  const { call, put, A, B, C, full } = await setup();
  await put('u_admin', 's1', { start: A.id, switches: [{ cueId: 'c4', templateId: B.id }] });
  // B 只在換版型的點裡：不能刪
  const del = await call('u_admin', 'DELETE', `${P}/led-templates/${B.id}`);
  assert.equal(del.status, 409);
  assert.equal(del.data.inUse, true);
  assert.equal(del.data.songCount, 1);
  assert.match(del.data.error, /開場/);
  const list = (await call('u_admin', 'GET', `${P}/led-templates`)).data.templates;
  assert.equal(list.find(t => t.id === A.id).songCount, 1);
  assert.equal(list.find(t => t.id === B.id).songCount, 1);
  assert.equal(list.find(t => t.id === C.id).songCount, 0);
  // 同一首歌開頭和換版型都用 A 只算一首
  await put('u_admin', 's1', { start: A.id, switches: [{ cueId: 'c4', templateId: B.id }, { atSec: 120, templateId: A.id }] });
  assert.equal((await call('u_admin', 'GET', `${P}/led-templates`)).data.templates.find(t => t.id === A.id).songCount, 1);
  // 只改 B 的畫布大小 → 409，訊息提到歌和兩個大小；沒變的畫布 / 改名 / 換放法可以
  const canvas = await call('u_admin', 'PATCH', `${P}/led-templates/${B.id}`, { canvas: { width: 4000, height: 200 } });
  assert.equal(canvas.status, 409);
  assert.equal(canvas.data.inTimeline, true);
  assert.match(canvas.data.error, /開場/);
  assert.match(canvas.data.error, /4000×200/);
  assert.equal((await call('u_admin', 'PATCH', `${P}/led-templates/${B.id}`, { canvas: { width: 4400, height: 200 }, name: '版型 B2', screens: [] })).status, 200);
  // 沒在時間線裡的版型，畫布隨便改
  assert.equal((await call('u_admin', 'PATCH', `${P}/led-templates/${C.id}`, { canvas: { width: 1000, height: 100 } })).status, 200);
  // 舊的版型選單：開頭換成不一樣大的 → 409；換成一樣大的可以；改成「全部」→ 409
  const bad = await call('u_admin', 'PATCH', `${P}/songs/s1`, { template_id: C.id });
  assert.equal(bad.status, 409);
  assert.match(bad.data.error, /畫布大小/);
  assert.equal((await call('u_admin', 'PATCH', `${P}/songs/s1`, { template_id: null })).status, 409);
  assert.equal((await call('u_admin', 'PATCH', `${P}/songs/s1`, { template_id: full.id })).status, 409);
  assert.equal((await call('u_admin', 'PATCH', `${P}/songs/s1`, { template_id: B.id })).status, 200);
  assert.equal((await songRow(call, 's1')).templateId, B.id);
  // 沒有換版型的歌，選單照舊隨便換
  assert.equal((await call('u_admin', 'PATCH', `${P}/songs/s2`, { template_id: C.id })).status, 200);
  // 拿掉換版型的點之後 B 可以刪
  await put('u_admin', 's1', { start: A.id, switches: [] });
  assert.equal((await call('u_admin', 'DELETE', `${P}/led-templates/${B.id}`)).status, 200);
});

test('影片版本：上傳那一刻存整條時間線（Cue 的時間定下來），之後 Cue 動了舊版不變；template 仍是開頭的版型；沒有時間線的歌跟以前一樣', async () => {
  const { db, call, put, A, B } = await setup();
  // 沒有時間線：templateTimeline = null
  await call('u_admin', 'PATCH', `${P}/songs/s1`, { template_id: A.id });
  const plain = (await upload(call)).data.video;
  assert.equal(plain.templateId, A.id);
  assert.equal(plain.template.name, '版型 A');
  assert.equal(plain.templateTimeline, null);
  // 有時間線
  await put('u_admin', 's1', { start: A.id, switches: [{ cueId: 'c4', templateId: B.id }, { atSec: 120, templateId: A.id }] });
  const v1 = (await upload(call)).data.video;
  assert.equal(v1.templateId, A.id);
  assert.equal(v1.template.name, '版型 A');                       // 舊版前端只看這個：開頭的版型
  const tl = v1.templateTimeline;
  assert.equal(tl.v, 1);
  assert.deepEqual(tl.segments.map(s => [s.fromSec, s.templateId, s.label]), [[0, A.id, null], [83, B.id, 'Cue 4'], [120, A.id, null]]);
  assert.deepEqual(Object.keys(tl.plans).sort(), [A.id, B.id].sort());
  assert.equal(tl.plans[B.id].name, '版型 B');
  assert.deepEqual(tl.plans[B.id].canvas, { width: 4400, height: 200 });
  // Cue 動了、版型改了：舊版不變
  await call('u_admin', 'PATCH', `${P}/songs/s1/cues/c4`, { videoTimeSec: 95 });
  await call('u_admin', 'PATCH', `${P}/led-templates/${B.id}`, { name: '改過的 B', screens: [] });
  const list = (await call('u_dir', 'GET', `${P}/songs/s1/videos`)).data.videos;
  const old = list.find(v => v.id === v1.id).templateTimeline;
  assert.equal(old.segments[1].fromSec, 83);
  assert.equal(old.plans[B.id].name, '版型 B');
  assert.equal(old.plans[B.id].screens.length, 1);
  // 新上傳的是新時間
  const v2 = (await upload(call)).data.video;
  assert.equal(v2.templateTimeline.segments[1].fromSec, 95);
  assert.equal(v2.templateTimeline.plans[B.id].name, '改過的 B');
  // 明確指定別的版型 / 整張畫布 → 不帶時間線（那是使用者特別指定的）
  assert.equal((await upload(call, { templateId: null })).data.video.templateTimeline, null);
  const other = await upload(call, { templateId: B.id });
  assert.equal(other.data.video.templateId, B.id);
  assert.equal(other.data.video.templateTimeline, null);
  // 明確指定的就是歌的開頭 → 照樣帶時間線
  assert.ok((await upload(call, { templateId: A.id })).data.video.templateTimeline);
  // Cue 時間被清掉：算不出時間的點不進快照；全部都算不出 = 沒有時間線
  await put('u_admin', 's1', { start: A.id, switches: [{ cueId: 'c4', templateId: B.id }] });
  await call('u_admin', 'PATCH', `${P}/songs/s1/cues/c4`, { videoTimeSec: null });
  const v3 = (await upload(call)).data.video;
  assert.equal(v3.template.name, '版型 A');
  assert.equal(v3.templateTimeline, null);
  // 資料庫的欄位：舊版本是 NULL
  const row = await db.prepare(`SELECT template_timeline FROM song_videos WHERE id = ?`).bind(plain.id).first();
  assert.equal(row.template_timeline, null);
});

test('分享連結的影片帶時間線；壞資料（手改過的 JSON）當沒有時間線', async () => {
  const { db, call, put, A, B } = await setup();
  await put('u_admin', 's1', { start: A.id, switches: [{ cueId: 'c4', templateId: B.id }] });
  await db.batch([
    db.prepare(`INSERT INTO song_videos (id, project_id, song_id, version, source, r2_key, mime, status, ready_at) VALUES ('vn', 'p1', 's1', 1, 'upload', 'k2', 'video/mp4', 'ready', '2026-10-15T00:00:00Z')`),
    db.prepare(`INSERT INTO share_links (token, project_id, slug) VALUES ('tk1', 'p1', 'demo')`),
  ]);
  const { stampVideoTemplates } = await import('./ledTemplates.mjs');
  await stampVideoTemplates({ DB: db }, 'p1', [{ id: 'vn', songId: 's1' }]);
  const data = await call(null, 'GET', `/api/share/tk1/data`);
  assert.equal(data.status, 200);
  const lv = data.data.songs.find(s => s.id === 's1').latestVideo;
  assert.equal(lv.template.name, '版型 A');
  assert.equal(lv.templateTimeline.segments.length, 2);
  assert.equal(lv.templateTimeline.segments[1].fromSec, 83);
  // 壞資料
  await db.prepare(`UPDATE song_videos SET template_timeline = '{"v":1,"plans":{},"segments":[{"fromSec":0,"templateId":"x"}]}' WHERE id = 'vn'`).run();
  const bad = await call(null, 'GET', `/api/share/tk1/data`);
  assert.equal(bad.data.songs.find(s => s.id === 's1').latestVideo.templateTimeline, null);
  assert.equal(bad.data.songs.find(s => s.id === 's1').latestVideo.template.name, '版型 A');
  await db.prepare(`UPDATE song_videos SET template_timeline = 'not json' WHERE id = 'vn'`).run();
  assert.equal((await call(null, 'GET', `/api/share/tk1/data`)).data.songs.find(s => s.id === 's1').latestVideo.templateTimeline, null);
});

test('複製專案 / 匯出匯入帶著換版型的點（歌、Cue、版型都換成新的 id）；舊的匯出檔（沒有換版型）照樣能匯入', async () => {
  const { db, env, call, put, A, B } = await setup();
  await put('u_admin', 's1', { start: A.id, switches: [{ cueId: 'c4', templateId: B.id }, { atSec: 120, templateId: A.id }] });

  const dup = await call('u_admin', 'POST', `${P}/duplicate`, { newName: '複本' });
  assert.equal(dup.status, 201);
  const np = dup.data.id;
  const newSongs = (await call('u_admin', 'GET', `/api/projects/${np}/songs`)).data.songs;
  const s1 = newSongs.find(s => s.name === '開場');
  assert.equal(s1.templateSwitches.length, 2);
  const tpls = (await call('u_admin', 'GET', `/api/projects/${np}/led-templates`)).data.templates;
  const nameOf = (id) => tpls.find(t => t.id === id)?.name;
  assert.equal(nameOf(s1.templateId), '版型 A');
  assert.deepEqual(s1.templateSwitches.map(w => [w.cueName, w.cueTimeSec, w.atSec, nameOf(w.templateId)]), [['Cue 4', 83, 83, '版型 B'], [null, null, 120, '版型 A']]);
  assert.notEqual(s1.templateSwitches[0].cueId, 'c4');
  assert.equal(newSongs.find(s => s.name === '安可').templateSwitches.length, 0);

  // 匯出 → 匯入
  const login = await worker.fetch(new Request(`${BASE}/api/auth/login`, { method: 'POST', body: JSON.stringify({ accessCode: 'ADMIN-1' }), headers: { 'content-type': 'application/json' } }), env);
  const token = (await login.json()).token;
  const exported = await worker.fetch(new Request(`${BASE}${P}/export`, { headers: { authorization: `Bearer ${token}` } }), env);
  const payload = await exported.json();
  assert.equal(payload.songTemplateSwitches.length, 2);
  const imp = await call('u_admin', 'POST', `/api/projects/import`, { ...payload, newName: '匯入的' });
  assert.equal(imp.status, 201);
  const isongs = (await call('u_admin', 'GET', `/api/projects/${imp.data.id}/songs`)).data.songs;
  assert.equal(isongs.find(s => s.name === '開場').templateSwitches.length, 2);
  // 舊的匯出檔
  const { songTemplateSwitches, ...legacy } = payload;
  void songTemplateSwitches;
  const imp2 = await call('u_admin', 'POST', `/api/projects/import`, { ...legacy, newName: '舊檔' });
  assert.equal(imp2.status, 201);
  assert.equal((await call('u_admin', 'GET', `/api/projects/${imp2.data.id}/songs`)).data.songs.find(s => s.name === '開場').templateSwitches.length, 0);
  // 資料庫裡沒有孤兒
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM song_template_switches WHERE template_id NOT IN (SELECT id FROM led_templates)`).first()).n, 0);
});
