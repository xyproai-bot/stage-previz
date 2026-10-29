// 跑法：cd cf-worker && npm test
// 導演頁「調整舞台」第 3 段：存起來（存回 Cue 庫 / 另存成新 cue / 複製 / 改名 / 轉場秒數 / 復原 / 衝突檢查 / 通知 / 放寬導演權限）
//   純判斷 + 走真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1），寫法跟 members.test.mjs 一樣
//   - 導演每一條能做的會過；不能做的（偷改物件、用製作那條整個畫面一次換掉的舊路…）被擋，而且資料不動
//   - 動畫師 / 沒登入 / 不是成員 / 別的專案：403 / 401 / 404
//   - 衝突：兩個人同時存，後存的拿到 409「剛剛被 ○○ 改過」
//   - 通知：收的人 = 製作 + 用到這個 cue 的歌的動畫師，不含自己
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, D1Sqlite, applyMigrations } from './testing/d1-sqlite.mjs';
import worker from './worker.js';
import { canEditStage, describeProjectRoute, roleMeetsNeed, needDeniedMessage } from './access.mjs';
import { nextVariantLabel } from './cueLibrary.mjs';
import { songListText, stageNotifyText, STAGE_FIELD_MESSAGE } from './cueLibraryStage.mjs';

const BASE = 'https://proxy.test';
const P = '/api/projects/p1';

// ─── 純判斷 ───

test('誰能存舞台：導演、專案的製作、全站製作（都是 role admin / director）；動畫師、不是成員不行', () => {
  assert.equal(canEditStage('director'), true);
  assert.equal(canEditStage('admin'), true);
  for (const r of ['animator', null, undefined, '', 'owner']) assert.equal(canEditStage(r), false, String(r));
  assert.equal(roleMeetsNeed('directorStage', { role: 'director', globalRole: 'director' }), true);
  assert.equal(roleMeetsNeed('directorStage', { role: 'admin', globalRole: 'animator' }), true);
  assert.equal(roleMeetsNeed('directorStage', { role: 'animator', globalRole: 'animator' }), false);
  assert.equal(roleMeetsNeed('directorStage', { role: null, globalRole: 'admin' }), false);
  assert.equal(needDeniedMessage('directorStage'), '只有導演或製作可以調整舞台');
});

test('路由表：新的幾條要 directorStage，方法不對 405；製作的舊路還是 editor', () => {
  const seg = (p) => ['api', 'projects', 'p1', ...p.split('/')];
  const d = (m, p) => describeProjectRoute(m, seg(p));
  assert.deepEqual([d('PUT', 'library-cues/lc1/mechanism-positions').kind, d('PUT', 'library-cues/lc1/mechanism-positions').need], ['libraryCues.stagePositions', 'directorStage']);
  assert.equal(d('PUT', 'library-cues/lc1/mechanism-positions').libId, 'lc1');
  assert.equal(d('POST', 'library-cues/lc1/stage-save-as').need, 'directorStage');
  assert.equal(d('POST', 'library-cues/lc1/stage-copy').need, 'directorStage');
  assert.equal(d('PATCH', 'library-cues/lc1/stage').need, 'directorStage');
  const slot = d('PUT', 'songs/s1/cues/c1/stage-crossfade');
  assert.deepEqual([slot.kind, slot.need, slot.songId, slot.cueId], ['cues.stageCrossfade', 'directorStage', 's1', 'c1']);
  for (const [m, p] of [['GET', 'library-cues/lc1/mechanism-positions'], ['POST', 'library-cues/lc1/mechanism-positions'], ['PUT', 'library-cues/lc1/stage-save-as'],
    ['GET', 'library-cues/lc1/stage-copy'], ['PUT', 'library-cues/lc1/stage'], ['POST', 'songs/s1/cues/c1/stage-crossfade'], ['PATCH', 'songs/s1/cues/c1/stage-crossfade']]) {
    assert.equal(d(m, p).methodNotAllowed, true, `${m} ${p}`);
  }
  // 製作的舊路沒被放寬
  assert.equal(d('PUT', 'library-cues/lc1/look').need, 'editor');
  assert.equal(d('PATCH', 'library-cues/lc1').need, 'editor');
  assert.equal(d('POST', 'library-cues').need, 'editor');
  assert.equal(d('DELETE', 'library-cues/lc1').need, 'editor');
  assert.equal(d('PATCH', 'songs/s1/cues/c1').need, 'editor');
  assert.equal(d('POST', 'songs/s1/cues').need, 'editor');
  assert.equal(d('PUT', 'songs/s1/cues/c1/mechanisms/m1').need, 'editor');
  assert.equal(d('PUT', 'songs/s1/cues/c1/states/o1').need, 'editor');
});

test('自動編號：30 → 30-1，已有 → 30-2；從 30-1 另存也是 30-2；不分大小寫；太長退回建議編號', () => {
  assert.equal(nextVariantLabel('30', ['30']), '30-1');
  assert.equal(nextVariantLabel('30', ['30', '30-1']), '30-2');
  assert.equal(nextVariantLabel('30', ['30', '30-1', '30-3']), '30-2');
  assert.equal(nextVariantLabel('30-1', ['30', '30-1']), '30-2');
  assert.equal(nextVariantLabel('A', ['A', 'a-1']), 'A-2');
  assert.equal(nextVariantLabel('3-1-2', ['3-1-2']), '3-1-1');
  assert.equal(nextVariantLabel('AAAAAAAAAAAAAAAA', ['AAAAAAAAAAAAAAAA', '7']), '8');
});

test('通知的字：導演 ○○ 後面接「改了 cue 30 的舞台（S05、S12、S17 會一起變）」', () => {
  const songs = [{ code: 'S05', name: '開場' }, { code: 'S12', name: '副歌' }, { code: null, name: '安可' }];
  assert.equal(stageNotifyText('save', { label: '30', songs }), '改了 cue 30 的舞台（S05、S12、安可 會一起變）');
  assert.equal(stageNotifyText('save', { label: '30', songs: [] }), '改了 cue 30 的舞台');
  assert.equal(stageNotifyText('undo', { label: '30', songs: [songs[0]] }), '復原了 cue 30 的舞台調整（S05 會一起變）');
  assert.equal(stageNotifyText('save_as', { label: '30', newLabel: '30-1', song: songs[0] }), '另存了 cue 30-1（從 cue 30），S05 改用新的');
  assert.equal(stageNotifyText('crossfade', { label: '30', songs: [songs[0]], seconds: 2.5 }), '把 cue 30 的轉場改成 2.5 秒（S05 會一起變）');
  assert.equal(stageNotifyText('slot_crossfade', { label: '30', song: songs[1], seconds: 0 }), '把 cue 30 在 S12 的轉場改成 0 秒');
  const many = Array.from({ length: 8 }, (_, i) => ({ code: `S${i + 1}` }));
  assert.equal(songListText(many), 'S1、S2、S3、S4、S5 等 8 首');
  assert.ok(stageNotifyText('save', { label: '30', songs: many }).length <= 140);
  // 沒有英文叫人的字、沒有 emoji
  const all = ['save', 'undo', 'save_as', 'crossfade', 'slot_crossfade'].map(k => stageNotifyText(k, { label: '1', newLabel: '1-1', songs, song: songs[0], seconds: 1 })).join('\n') + STAGE_FIELD_MESSAGE;
  assert.doesNotMatch(all, /\b(users?|admins?|directors?|animators?)\b/i);
  assert.doesNotMatch(all, /\p{Extended_Pictographic}/u);
});

// ─── 路由 ───

async function setup({ before0048 = false } = {}) {
  const db = before0048 ? (() => { const d = new D1Sqlite(); applyMigrations(d, { before: '0048' }); return d; })() : freshDb();
  const users = [
    ['u_admin', '陳製作', 'admin', 'ADMIN-1'],       // 全站製作
    ['u_pm', '阿宏', 'animator', 'PM-1'],            // p1 的製作（帳號是動畫師）
    ['u_dir', '王導', 'director', 'DIR-1'],          // p1 的導演
    ['u_dir2', '林導', 'director', 'DIR-2'],         // p1 的另一位導演
    ['u_ani1', '甲動畫', 'animator', 'ANI-1'],       // S01 的動畫師
    ['u_ani2', '乙動畫', 'animator', 'ANI-2'],       // S02 的動畫師
    ['u_ani3', '丙動畫', 'animator', 'ANI-3'],       // p1 的動畫師，沒有被指派
    ['u_other', '別組導演', 'director', 'OTHER-1'],  // 只在 p2
    ['u_free', '路人', 'animator', 'FREE-1'],        // 不是任何專案的成員
  ];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`).bind(id, `${id}@x.test`, name, role, code)));
  // migration 附的預設全站製作（u_phang）停用，免得通知的名單裡多一個人
  db.raw.exec(`UPDATE users SET deactivated = 1 WHERE id = 'u_phang'`);
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name, cue_library) VALUES ('p1', '巡演', 1), ('p2', '另一個', 1), ('p3', '舊模式', 0)`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES
      ('p1', 'u_pm', 'admin'), ('p1', 'u_dir', 'director'), ('p1', 'u_dir2', 'director'),
      ('p1', 'u_ani1', 'animator'), ('p1', 'u_ani2', 'animator'), ('p1', 'u_ani3', 'animator'),
      ('p2', 'u_other', 'director'), ('p3', 'u_dir', 'director')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", code, animator_user_id) VALUES
      ('s1', 'p1', '開場曲', 0, 'S01', 'u_ani1'), ('s2', 'p1', '副歌', 1, 'S02', 'u_ani2'), ('s3', 'p1', '安可', 2, 'S03', NULL),
      ('z1', 'p2', '別的歌', 0, 'Z1', NULL), ('o1', 'p3', '舊歌', 0, 'O1', NULL)`),
    db.prepare(`INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order") VALUES
      ('o_a', 'p1', 'A', '主牆', 'led_panel', 0), ('o_b', 'p1', 'B', '側牆', 'led_panel', 1), ('z_a', 'p2', 'A', '主牆', 'other', 0)`),
  ]);
  const env = { DB: db, AUTH_SECRET: 'test-secret' };
  const tokens = {};
  for (const [id, , , code] of users) {
    const r = await worker.fetch(new Request(`${BASE}/api/auth/login`, { method: 'POST', body: JSON.stringify({ accessCode: code }), headers: { 'content-type': 'application/json' } }), env);
    tokens[id] = (await r.json()).token;
  }
  const as = (who) => async (method, path, body) => {
    const headers = { 'content-type': 'application/json' };
    if (who) headers.authorization = `Bearer ${tokens[who]}`;
    const r = await worker.fetch(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    let data = null;
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data };
  };
  const admin = as('u_admin');
  const mk = async (project, body) => {
    const r = await admin('POST', `/api/projects/${project}/mechanisms`, body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.mechanism.id;
  };
  const m1 = await mk('p1', { name: '升降台', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, travelMin: 0, travelMax: 3, defaultValue: 0, objectIds: [] });
  const m2 = await mk('p1', { name: '轉盤', kind: 'rotary', axis: { x: 0, y: 1, z: 0 }, pivot: { x: 0, y: 0, z: 0 }, travelMin: -180, travelMax: 180, defaultValue: 0, objectIds: [] });
  const mz = await mk('p2', { name: '別專案的升降台', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, travelMin: 0, travelMax: 3, defaultValue: 0, objectIds: [] });
  // Cue 30：S01 和 S02 都在用；Cue 31：只有 S03 在用
  const look30 = {
    objects: [
      { objectId: 'o_a', position: { x: 1, y: 2, z: 3 }, rotation: null, scale: null, visible: true, customProps: null, own: true, ownFields: ['position', 'visible'] },
      { objectId: 'o_b', position: { x: 5, y: 0, z: 0 }, rotation: null, scale: null, visible: false, customProps: null, own: true, ownFields: ['position', 'visible'] },
    ],
    mechanisms: [
      { mechanismId: m1, value: 1, delaySec: 0.5, durationSec: 2, carried: false },
      { mechanismId: m2, value: 90, delaySec: null, durationSec: null, carried: true },
    ],
  };
  const lc30 = (await admin('POST', `${P}/library-cues`, { label: '30', name: '副歌全開', look: look30, crossfadeSeconds: 1.5 })).data.libraryCue.id;
  const lc31 = (await admin('POST', `${P}/library-cues`, { label: '31', name: '安可', look: { objects: [], mechanisms: [] } })).data.libraryCue.id;
  const slot = async (song, lc, t, crossfadeSeconds) => (await admin('POST', `${P}/songs/${song}/cues`, { libraryCueId: lc, videoTimeSec: t, ...(crossfadeSeconds === undefined ? {} : { crossfadeSeconds }) })).data.slot.id;
  const c1 = await slot('s1', lc30, 10);
  const c2 = await slot('s2', lc30, 10, 3);      // S02 自己另外設了 3 秒
  const c3 = await slot('s3', lc31, 10);
  return {
    db, env, admin, pm: as('u_pm'), dir: as('u_dir'), dir2: as('u_dir2'), ani: as('u_ani1'), ani3: as('u_ani3'), other: as('u_other'), free: as('u_free'), anon: as(null),
    as, m1, m2, mz, lc30, lc31, c1, c2, c3, look30,
  };
}

const mechRows = (db, lc) => db.raw.prepare(`SELECT mechanism_id m, value v, delay_sec d, duration_sec u, carried c FROM library_cue_mechanism_positions WHERE library_cue_id = ? ORDER BY mechanism_id`).all(lc).map(r => ({ ...r }));
const objRows = (db, lc) => JSON.stringify(db.raw.prepare(`SELECT * FROM library_cue_object_states WHERE library_cue_id = ? ORDER BY stage_object_id`).all(lc));
const revOf = (db, lc) => Number(db.raw.prepare(`SELECT rev FROM library_cues WHERE id = ?`).get(lc).rev);
const everything = (db) => JSON.stringify([
  db.raw.prepare(`SELECT * FROM library_cues ORDER BY id`).all(), db.raw.prepare(`SELECT * FROM library_cue_object_states ORDER BY 1, 2`).all(),
  db.raw.prepare(`SELECT * FROM library_cue_mechanism_positions ORDER BY 1, 2`).all(), db.raw.prepare(`SELECT id, library_cue_id, crossfade_seconds, crossfade_own FROM cues ORDER BY id`).all(),
]);
const notesOf = (db) => db.raw.prepare(`SELECT user_id u, kind, song_id s, song_name sn, actor_name a, excerpt e FROM notifications ORDER BY user_id`).all().map(r => ({ ...r }));

const pos = (t) => ({ mechanismId: t.m, value: t.v, delaySec: t.d ?? null, durationSec: t.u ?? null, carried: !!t.c });
/** 現在存的機關位置（API 格式），改其中幾個值 */
const withValues = (db, lc, changes) => {
  const rows = mechRows(db, lc).map(pos);
  for (const [id, v] of Object.entries(changes)) {
    const r = rows.find(x => x.mechanismId === id);
    if (r) r.value = v; else rows.push({ mechanismId: id, value: v, delaySec: null, durationSec: null, carried: false });
  }
  return rows;
};

test('存回 Cue 庫：導演可以；只換機關位置（物件一個都沒動）、rev + 1、回上一版、寫活動紀錄', async () => {
  const { db, dir, m1, m2, lc30 } = await setup();
  const objBefore = objRows(db, lc30);
  const mechBefore = mechRows(db, lc30);
  const r = await dir('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: revOf(db, lc30), mechanisms: withValues(db, lc30, { [m1]: 2.5 }), songId: 's1' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.rev, 1);
  assert.equal(r.data.changed, 1);
  assert.deepEqual(r.data.songs.map(s => s.code), ['S01', 'S02']);
  assert.equal(r.data.previous.rev, 0);
  assert.deepEqual(r.data.previous.mechanisms.map(m => [m.mechanismId, m.value, m.delaySec, m.durationSec, m.carried]),
    [[m1, 1, 0.5, 2, false], [m2, 90, null, null, true]].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  // 值、延遲、走幾秒、carried 都照送的（沒改的原樣）
  const after = mechRows(db, lc30);
  assert.equal(after.find(x => x.m === m1).v, 2.5);
  assert.equal(after.find(x => x.m === m1).d, 0.5);
  assert.equal(after.find(x => x.m === m2).c, 1);
  assert.equal(after.length, mechBefore.length);
  // 物件位置 / 顯示隱藏一個都沒動
  assert.equal(objRows(db, lc30), objBefore);
  assert.equal(revOf(db, lc30), 1);
  // 活動紀錄
  const log = db.raw.prepare(`SELECT user_id, action, target_type t, target_id, payload FROM activity_log WHERE target_type = 'library_cue' AND target_id = ?`).all(lc30).map(x => ({ ...x, payload: JSON.parse(x.payload) }));
  const mine = log.find(x => x.payload.kind === 'stage_save');
  assert.equal(mine.user_id, 'u_dir');
  assert.deepEqual([mine.payload.label, mine.payload.name, mine.payload.changed, mine.payload.songCount, mine.payload.songs], ['30', '副歌全開', 1, 2, ['S01', 'S02']]);
  // 沒有改（跟現在存的一樣）→ 不寫、不加 rev、不通知
  const same = await dir('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 1, mechanisms: withValues(db, lc30, {}) });
  assert.equal(same.status, 200);
  assert.equal(same.data.unchanged, true);
  assert.equal(revOf(db, lc30), 1);
});

test('存回：沒有列的機關第一次被導演調（新增一列）；機關位置整份換掉（少送的列會被拿掉，復原用得到）', async () => {
  const { db, dir, m1, m2, lc31 } = await setup();
  const r = await dir('PUT', `${P}/library-cues/${lc31}/mechanism-positions`, { ifRev: 0, mechanisms: [{ mechanismId: m1, value: 3, delaySec: null, durationSec: null, carried: false }] });
  assert.equal(r.status, 200);
  assert.deepEqual(mechRows(db, lc31).map(x => [x.m, x.v, x.c]), [[m1, 3, 0]]);
  assert.deepEqual(r.data.previous.mechanisms, []);
  // 少送 m1、多送 m2 → 整份換成這樣
  const r2 = await dir('PUT', `${P}/library-cues/${lc31}/mechanism-positions`, { ifRev: 1, mechanisms: [{ mechanismId: m2, value: -90, delaySec: 1, durationSec: 4, carried: false }] });
  assert.equal(r2.status, 200);
  assert.deepEqual(mechRows(db, lc31).map(x => [x.m, x.v, x.d, x.u]), [[m2, -90, 1, 4]]);
  assert.equal(r2.data.changed, 2);
});

test('復原：把 previous 用新的 rev 再存一次，回到原本；rev 過期一樣 409', async () => {
  const { db, dir, dir2, m1, lc30 } = await setup();
  const before = mechRows(db, lc30);
  const saved = await dir('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: withValues(db, lc30, { [m1]: 2 }) });
  assert.equal(saved.status, 200);
  // 別人先改了 → 復原被擋
  assert.equal((await dir2('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 1, mechanisms: withValues(db, lc30, { [m1]: 0.2 }) })).status, 200);
  const stale = await dir('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: saved.data.rev, mechanisms: saved.data.previous.mechanisms, undo: true });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, '這個 cue 剛剛被 林導 改過');
  // 沒人搶的時候復原成功
  const mine = await dir2('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 2, mechanisms: withValues(db, lc30, { [m1]: 1.7 }) });
  const undo = await dir2('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: mine.data.rev, mechanisms: mine.data.previous.mechanisms, undo: true });
  assert.equal(undo.status, 200);
  assert.equal(undo.data.rev, 4);
  assert.equal(mechRows(db, lc30).find(x => x.m === m1).v, 0.2);   // 復原到「存之前」= 林導先前存的 0.2
  // 完全回到最初的那份也行（逐個欄位一樣）
  const orig = await dir('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 4, mechanisms: before.map(pos), undo: true });
  assert.equal(orig.status, 200);
  assert.deepEqual(mechRows(db, lc30), before);
  // 復原的活動紀錄
  assert.ok(db.raw.prepare(`SELECT payload FROM activity_log WHERE target_type = 'library_cue'`).all().some(x => JSON.parse(x.payload).kind === 'stage_undo'));
});

test('衝突：兩個人同時存，後存的拿到 409「剛剛被 ○○ 改過」，什麼都沒寫進去', async () => {
  const { db, dir, dir2, m1, lc30 } = await setup();
  const a = await dir('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: withValues(db, lc30, { [m1]: 2 }) });
  assert.equal(a.status, 200);
  const snap = everything(db);
  const b = await dir2('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: withValues(db, lc30, { [m1]: 0.4 }) });
  assert.equal(b.status, 409);
  assert.equal(b.data.error, '這個 cue 剛剛被 王導 改過');
  assert.deepEqual([b.data.conflict, b.data.rev, b.data.changedBy.name], [true, 1, '王導']);
  assert.equal(everything(db), snap);
  // 同一個人在另一個畫面改過：不指名
  const self = await dir('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: withValues(db, lc30, { [m1]: 0.4 }) });
  assert.equal(self.status, 409);
  assert.equal(self.data.error, '這個 cue 剛剛在你的另一個畫面被改過');
  // 重新載入（拿新的 rev）再存就過了
  assert.equal((await dir2('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 1, mechanisms: withValues(db, lc30, { [m1]: 0.4 }) })).status, 200);
});

test('衝突：製作用整個畫面 PUT look 改過 → 導演被擋並指名；舊網址（沒記人的寫入）改過 → 說「被別人改過」不亂指名', async () => {
  const { db, dir, admin, m1, lc30, c1, look30 } = await setup();
  const put = await admin('PUT', `${P}/library-cues/${lc30}/look`, { ifRev: 0, ...look30, mechanisms: [{ mechanismId: m1, value: 0.2, delaySec: null, durationSec: null, carried: false }] });
  assert.equal(put.status, 200);
  const r1 = await dir('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: [{ mechanismId: m1, value: 2, delaySec: null, durationSec: null, carried: false }] });
  assert.equal(r1.status, 409);
  assert.equal(r1.data.error, '這個 cue 剛剛被 陳製作 改過');
  // 舊版前端的舊網址（改物件位置）也會加 rev，但沒有記人
  const legacy = await admin('PUT', `${P}/songs/s1/cues/${c1}/states/o_a`, { position: { x: 9, y: 9, z: 9 } });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.data));
  const r2 = await dir('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 1, mechanisms: [{ mechanismId: m1, value: 2, delaySec: null, durationSec: null, carried: false }] });
  assert.equal(r2.status, 409);
  assert.equal(r2.data.error, '這個 cue 剛剛被別人改過');
  assert.equal(r2.data.changedBy, null);
});

test('存回：壞資料整個不寫（缺 ifRev、機關不是這個專案的、超出行程、沿用的有時間、格式不對、別專案的 cue）', async () => {
  const { db, dir, m1, mz, lc30 } = await setup();
  const snap = everything(db);
  const good = withValues(db, lc30, { [m1]: 2 });
  const url = `${P}/library-cues/${lc30}/mechanism-positions`;
  const cases = [
    [{ mechanisms: good }, '缺 ifRev'],
    [{ ifRev: -1, mechanisms: good }, 'ifRev 負的'],
    [{ ifRev: '0', mechanisms: good }, 'ifRev 是字串'],
    [{ ifRev: 0 }, '沒有機關'],
    [{ ifRev: 0, mechanisms: 'x' }, '機關不是陣列'],
    [{ ifRev: 0, mechanisms: [{ mechanismId: mz, value: 1, delaySec: null, durationSec: null, carried: false }] }, '別的專案的機關'],
    [{ ifRev: 0, mechanisms: [{ mechanismId: 'mech_nope', value: 1 }] }, '不存在的機關'],
    [{ ifRev: 0, mechanisms: [{ mechanismId: m1, value: 3.5 }] }, '超出行程'],
    [{ ifRev: 0, mechanisms: [{ mechanismId: m1, value: -0.5 }] }, '超出行程（負的）'],
    [{ ifRev: 0, mechanisms: [{ mechanismId: m1, value: 'a' }] }, '不是數字'],
    [{ ifRev: 0, mechanisms: [{ mechanismId: m1, value: NaN }] }, 'NaN'],
    [{ ifRev: 0, mechanisms: [{ mechanismId: m1, value: 1, carried: true, delaySec: 1 }] }, '沿用的有時間'],
    [{ ifRev: 0, mechanisms: [{ mechanismId: m1, value: 1, delaySec: 4000 }] }, '延遲太大'],
    [{ ifRev: 0, mechanisms: [{ mechanismId: m1, value: 1 }, { mechanismId: m1, value: 2 }] }, '同一個機關兩次'],
    [{ ifRev: 0, mechanisms: [{ mechanismId: m1, value: 1, carried: 'yes' }] }, 'carried 不是布林'],
    [{ ifRev: 0, mechanisms: good, undo: 'yes' }, 'undo 不是布林'],
    [{ ifRev: 0, mechanisms: good, songId: 5 }, 'songId 不是字串'],
  ];
  for (const [body, why] of cases) {
    const r = await dir('PUT', url, body);
    assert.equal(r.status, 400, `${why}：${JSON.stringify(r.data)}`);
  }
  assert.equal(everything(db), snap);
  // 別專案的 cue、不存在的 cue → 404
  assert.equal((await dir('PUT', `${P}/library-cues/lc_nope/mechanism-positions`, { ifRev: 0, mechanisms: good })).status, 404);
  db.raw.exec(`INSERT INTO library_cues (id, project_id, label, name) VALUES ('lc_other', 'p2', '1', 'X')`);
  assert.equal((await dir('PUT', `${P}/library-cues/lc_other/mechanism-positions`, { ifRev: 0, mechanisms: [] })).status, 404);
  assert.equal(everything(db).includes('"id":"lc_other"'), true);
  // 沒改過的列就算本來就超出行程（舊資料）也不擋
  db.raw.prepare(`UPDATE library_cue_mechanism_positions SET value = 9 WHERE library_cue_id = ? AND mechanism_id = ?`).run(lc30, m1);
  const rows = mechRows(db, lc30).map(pos);
  const rr = await dir('PUT', url, { ifRev: 0, mechanisms: rows.map(x => (x.mechanismId === m1 ? x : { ...x, value: 45 })) });
  assert.equal(rr.status, 200, JSON.stringify(rr.data));
});

test('偷改欄位被擋：想一起改物件 / 顯示隱藏 / 編號 / 備註 / 刪除 → 400，資料一個字都沒動', async () => {
  const { db, dir, m1, lc30, c1, c2 } = await setup();
  const snap = everything(db);
  const good = withValues(db, lc30, { [m1]: 2 });
  const sneaky = [
    ['PUT', `library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: good, objects: [{ objectId: 'o_a', position: { x: 0, y: 0, z: 0 } }] }],
    ['PUT', `library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: good, visible: false }],
    ['PUT', `library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: [{ mechanismId: m1, value: 1, objectId: 'o_a' }] }],
    ['PUT', `library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: good, label: '99' }],
    ['PUT', `library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: good, name: '被改的名字' }],
    ['POST', `library-cues/${lc30}/stage-save-as`, { mechanisms: good, songId: 's1', cueId: c1, objects: [] }],
    ['POST', `library-cues/${lc30}/stage-save-as`, { mechanisms: good, songId: 's1', cueId: c1, label: '77' }],
    ['POST', `library-cues/${lc30}/stage-save-as`, { mechanisms: good, songId: 's1', cueId: c1, look: { objects: [], mechanisms: [] } }],
    ['POST', `library-cues/${lc30}/stage-copy`, { name: '複製', label: '88' }],
    ['POST', `library-cues/${lc30}/stage-copy`, { name: '複製', place: { songId: 's1', replaceCueId: c1 } }],
    ['PATCH', `library-cues/${lc30}/stage`, { name: '新名字', label: '66' }],
    ['PATCH', `library-cues/${lc30}/stage`, { name: '新名字', note: '備註' }],
    ['PATCH', `library-cues/${lc30}/stage`, { crossfadeSeconds: 2, based_on_id: null }],
    ['PATCH', `library-cues/${lc30}/stage`, {}],
    ['PUT', `songs/s2/cues/${c2}/stage-crossfade`, { crossfadeSeconds: 2, videoTimeSec: 99 }],
    ['PUT', `songs/s2/cues/${c2}/stage-crossfade`, { crossfadeSeconds: 2, libraryCueId: 'lc_x' }],
    ['PUT', `songs/s2/cues/${c2}/stage-crossfade`, { crossfadeSeconds: null }],
    ['PUT', `songs/s2/cues/${c2}/stage-crossfade`, { crossfadeSeconds: -1 }],
    ['PUT', `songs/s2/cues/${c2}/stage-crossfade`, { crossfadeSeconds: 99999 }],
  ];
  for (const [m, path, body] of sneaky) {
    const r = await dir(m, `${P}/${path}`, body);
    assert.equal(r.status, 400, `${m} ${path} ${JSON.stringify(body)} → ${JSON.stringify(r.data)}`);
  }
  assert.equal(everything(db), snap);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM notifications`).get().n, 0);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM library_cues`).get().n, 2);
  // 擋下來的說明是白話（不是丟出內部欄位）
  const r = await dir('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: good, objects: [] });
  assert.equal(r.data.error, STAGE_FIELD_MESSAGE);
  assert.equal(r.data.field, 'objects');
});

test('權限：導演、專案的製作、全站製作每一條都過；動畫師、不是成員、別專案的導演被擋（403），沒登入 401', async () => {
  const s = await setup();
  const { db, m1, lc30, lc31, c1, c2 } = s;
  const good = () => withValues(db, lc31, { [m1]: 1 });
  const calls = (rev) => [
    ['PUT', `library-cues/${lc31}/mechanism-positions`, { ifRev: rev, mechanisms: good() }],
    ['POST', `library-cues/${lc30}/stage-save-as`, { mechanisms: withValues(db, lc30, { [m1]: 2 }), songId: 's1', cueId: c1 }],
    ['POST', `library-cues/${lc30}/stage-copy`, {}],
    ['PATCH', `library-cues/${lc31}/stage`, { name: '安可（新）' }],
    ['PUT', `songs/s2/cues/${c2}/stage-crossfade`, { crossfadeSeconds: 2 }],
  ];
  // 會過的人（每一個人把 5 條都跑一次；save-as 每次都會換掉 s1 的 cue，所以先把它指回去）
  let rev = 0;
  for (const who of ['u_dir', 'u_pm', 'u_admin']) {
    for (const [m, path, body] of calls(rev)) {
      db.raw.prepare(`UPDATE cues SET library_cue_id = ? WHERE id = ?`).run(lc30, c1);
      const r = await s.as(who)(m, `${P}/${path}`, body);
      assert.ok(r.status === 200 || r.status === 201, `${who} ${m} ${path} → ${r.status} ${JSON.stringify(r.data)}`);
    }
    rev = revOf(db, lc31);
  }
  // 被擋的人：資料不動
  const snap = everything(db);
  const blocked = [['u_ani1', 403], ['u_ani3', 403], ['u_free', 403], ['u_other', 403], [null, 401]];
  for (const [who, status] of blocked) {
    for (const [m, path, body] of calls(revOf(db, lc31))) {
      const r = await s.as(who)(m, `${P}/${path}`, body);
      assert.equal(r.status, status, `${who} ${m} ${path} → ${r.status}`);
    }
  }
  assert.equal(everything(db), snap);
  assert.equal((await s.ani('PUT', `${P}/library-cues/${lc31}/mechanism-positions`, { ifRev: 0, mechanisms: [] })).data.error, '只有導演或製作可以調整舞台');
});

test('別的專案：用自己專案的網址碰不到別的專案的 cue / 歌（404）；碰別的專案的網址（403）', async () => {
  const { db, dir, other, m1, lc30, c1, c3 } = await setup();
  db.raw.exec(`INSERT INTO library_cues (id, project_id, label, name) VALUES ('lc_z', 'p2', '1', 'Z')`);
  db.raw.exec(`INSERT INTO cues (id, song_id, name, "order", status, library_cue_id) VALUES ('c_z', 'z1', 'z', 0, 'master', 'lc_z')`);
  const snap = everything(db);
  const good = [{ mechanismId: m1, value: 1, delaySec: null, durationSec: null, carried: false }];
  // p1 的導演用 p1 的網址，指著 p2 的 cue / 歌
  assert.equal((await dir('PUT', `${P}/library-cues/lc_z/mechanism-positions`, { ifRev: 0, mechanisms: good })).status, 404);
  assert.equal((await dir('POST', `${P}/library-cues/lc_z/stage-copy`, {})).status, 404);
  assert.equal((await dir('PATCH', `${P}/library-cues/lc_z/stage`, { name: 'x' })).status, 404);
  assert.equal((await dir('POST', `${P}/library-cues/${lc30}/stage-save-as`, { mechanisms: good, songId: 'z1', cueId: 'c_z' })).status, 404);
  assert.equal((await dir('POST', `${P}/library-cues/${lc30}/stage-save-as`, { mechanisms: good, songId: 's1', cueId: 'c_z' })).status, 404);
  assert.equal((await dir('PUT', `${P}/songs/z1/cues/c_z/stage-crossfade`, { crossfadeSeconds: 1 })).status, 404);
  assert.equal((await dir('PUT', `${P}/songs/s1/cues/c_z/stage-crossfade`, { crossfadeSeconds: 1 })).status, 404);
  // 同一個專案裡，cue 跟歌對不起來（c3 是 s3 的）
  assert.equal((await dir('POST', `${P}/library-cues/${lc30}/stage-save-as`, { mechanisms: good, songId: 's1', cueId: c3 })).status, 404);
  // 別專案的導演碰 p1 → 403；碰自己專案的網址但 cue 是 p1 的 → 404
  assert.equal((await other('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: good })).status, 403);
  assert.equal((await other('PUT', `/api/projects/p2/library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: good })).status, 404);   // p2 的導演用自己專案的網址指著 p1 的 cue
  assert.equal(everything(db), snap);
  assert.ok(c1);
});

test('導演不能用製作的舊路：整個畫面 PUT look、改物件、建 / 改 / 刪 cue、改編號 / 備註、改歌的 cue、設定機關…全部 403，資料不動', async () => {
  const { db, dir, m1, lc30, c1, look30 } = await setup();
  const snap = everything(db);
  const legacy = [
    ['PUT', `library-cues/${lc30}/look`, { ifRev: 0, objects: [], mechanisms: [] }],
    ['PUT', `library-cues/${lc30}/look`, { ...look30 }],
    ['POST', 'library-cues', { name: '新的' }],
    ['PATCH', `library-cues/${lc30}`, { name: '改名' }],
    ['PATCH', `library-cues/${lc30}`, { label: '99' }],
    ['PATCH', `library-cues/${lc30}`, { crossfadeSeconds: 9 }],
    ['DELETE', `library-cues/${lc30}`],
    ['POST', 'songs/s1/cues', { libraryCueId: lc30, videoTimeSec: 99 }],
    ['PATCH', `songs/s1/cues/${c1}`, { libraryCueId: lc30 }],
    ['PATCH', `songs/s1/cues/${c1}`, { crossfadeSeconds: 4 }],
    ['PATCH', `songs/s1/cues/${c1}`, { videoTimeSec: 99 }],
    ['DELETE', `songs/s1/cues/${c1}`],
    ['PUT', `songs/s1/cues/${c1}/states/o_a`, { position: { x: 0, y: 0, z: 0 } }],
    ['DELETE', `songs/s1/cues/${c1}/states/o_a`],
    ['POST', `songs/s1/cues/${c1}/reset`, {}],
    ['PUT', `songs/s1/cues/${c1}/mechanisms/${m1}`, { value: 2 }],
    ['PUT', `songs/s1/cues/${c1}/mechanism-positions`, { items: [] }],
    ['POST', 'mechanisms', { name: 'x', kind: 'linear', axis: { x: 0, y: 1, z: 0 }, travelMin: 0, travelMax: 1, objectIds: [] }],
    ['PATCH', `mechanisms/${m1}`, { travelMax: 100 }],
    ['DELETE', `mechanisms/${m1}`],
    ['PATCH', 'stage-objects/o_a', { defaultHidden: true }],
    ['DELETE', 'stage-objects/o_a'],
    ['POST', 'cue-templates', { name: 'x', payload: {} }],
  ];
  for (const [m, path, body] of legacy) {
    const r = await dir(m, `${P}/${path}`, body);
    assert.equal(r.status, 403, `${m} ${path} → ${r.status} ${JSON.stringify(r.data)}`);
  }
  assert.equal(everything(db), snap);
});

test('另存成新 cue：編號自動給下一個、物件設定照抄、機關位置用導演調的；只換這首歌的這個 cue，別首歌照舊；原本的不動', async () => {
  const { db, dir, m1, m2, lc30, c1, c2 } = await setup();
  const baseSnap = JSON.stringify([objRows(db, lc30), mechRows(db, lc30), revOf(db, lc30)]);
  const tweaked = withValues(db, lc30, { [m1]: 2.25, [m2]: -45 });
  const r = await dir('POST', `${P}/library-cues/${lc30}/stage-save-as`, { mechanisms: tweaked, songId: 's1', cueId: c1 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.libraryCue.label, '30-1');
  assert.equal(r.data.libraryCue.name, '副歌全開（導演改）');
  assert.equal(r.data.libraryCue.basedOnId, lc30);
  const nid = r.data.libraryCue.id;
  // 機關位置 = 導演調的；物件設定 = 原本的（含隱藏的那個）
  assert.deepEqual(mechRows(db, nid).map(x => [x.m, x.v, x.d, x.u, x.c]), tweaked.map(x => [x.mechanismId, x.value, x.delaySec, x.durationSec, x.carried ? 1 : 0]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const strip = (s) => JSON.parse(s).map(({ library_cue_id, ...rest }) => rest);
  assert.deepEqual(strip(objRows(db, nid)), strip(objRows(db, lc30)));
  assert.equal(strip(objRows(db, nid)).length, 2);
  // 只換 s1 的這個 cue；s2 還是用 30
  const slotLc = (id) => db.raw.prepare(`SELECT library_cue_id lc FROM cues WHERE id = ?`).get(id).lc;
  assert.equal(slotLc(c1), nid);
  assert.equal(slotLc(c2), lc30);
  // 原本的 cue 一個字都沒動
  assert.equal(JSON.stringify([objRows(db, lc30), mechRows(db, lc30), revOf(db, lc30)]), baseSnap);
  // 轉場秒數：s1 的 cue 用 Cue 庫的 → 跟新 cue 的（照抄原本的 1.5）；s2 自己設的 3 不動
  assert.equal(db.raw.prepare(`SELECT crossfade_seconds s FROM cues WHERE id = ?`).get(c1).s, 1.5);
  assert.equal(db.raw.prepare(`SELECT crossfade_seconds s FROM cues WHERE id = ?`).get(c2).s, 3);
  // 再另存一次（這次從 30-1 或 30 都是 30-2）；自己取名；已有的編號跳過
  const r2 = await dir('POST', `${P}/library-cues/${lc30}/stage-save-as`, { name: '我的副歌', mechanisms: tweaked, songId: 's2', cueId: c2 });
  assert.equal(r2.status, 201);
  assert.deepEqual([r2.data.libraryCue.label, r2.data.libraryCue.name], ['30-2', '我的副歌']);
  const r3 = await dir('POST', `${P}/library-cues/${nid}/stage-save-as`, { mechanisms: tweaked, songId: 's1', cueId: c1 });
  assert.equal(r3.status, 201);
  assert.equal(r3.data.libraryCue.label, '30-3');
  // 活動紀錄有「從哪個 cue 另存」和「這首歌換成新的」
  const log = db.raw.prepare(`SELECT target_type t, payload FROM activity_log WHERE user_id = 'u_dir' ORDER BY rowid`).all().map(x => ({ ...x, payload: JSON.parse(x.payload) }));
  const made = log.find(x => x.t === 'library_cue' && x.payload.label === '30-1');
  assert.deepEqual([made.payload.kind, made.payload.basedOnLabel, made.payload.songName], ['stage_save_as', '30', '開場曲']);
  assert.ok(log.some(x => x.t === 'cue' && x.payload.kind === 'repoint' && x.payload.libraryLabel === '30-1'));
});

test('另存的壞情況：名稱空白 / 太長會截、機關不對、這首歌的這個 cue 已經不是用這個 cue 了（409）— 都不留半個新 cue', async () => {
  const { db, dir, m1, lc30, lc31, c1, c3 } = await setup();
  const snap = everything(db);
  const good = withValues(db, lc30, { [m1]: 2 });
  assert.equal((await dir('POST', `${P}/library-cues/${lc30}/stage-save-as`, { name: '   ', mechanisms: good, songId: 's1', cueId: c1 })).status, 400);
  assert.equal((await dir('POST', `${P}/library-cues/${lc30}/stage-save-as`, { mechanisms: good, songId: 's1' })).status, 400);
  assert.equal((await dir('POST', `${P}/library-cues/${lc30}/stage-save-as`, { mechanisms: good, cueId: c1 })).status, 400);
  assert.equal((await dir('POST', `${P}/library-cues/${lc30}/stage-save-as`, { mechanisms: [{ mechanismId: m1, value: 9 }], songId: 's1', cueId: c1 })).status, 400);
  assert.equal((await dir('POST', `${P}/library-cues/${lc30}/stage-save-as`, { mechanisms: 'x', songId: 's1', cueId: c1 })).status, 400);
  // s3 的 cue 是用 31 的，不是 30
  const wrong = await dir('POST', `${P}/library-cues/${lc30}/stage-save-as`, { mechanisms: good, songId: 's3', cueId: c3 });
  assert.equal(wrong.status, 409);
  assert.equal(everything(db), snap);
  // 名稱太長 → 截到 100 字
  const long = await dir('POST', `${P}/library-cues/${lc31}/stage-save-as`, { name: '長'.repeat(150), mechanisms: [], songId: 's3', cueId: c3 });
  assert.equal(long.status, 201);
  assert.equal([...long.data.libraryCue.name].length, 100);
});

test('複製：從現有 cue 複製一個新的放進 Cue 庫（不放進任何歌）；物件和機關位置都照抄；原本的不動', async () => {
  const { db, dir, lc30 } = await setup();
  const snap = JSON.stringify([objRows(db, lc30), mechRows(db, lc30), revOf(db, lc30)]);
  const r = await dir('POST', `${P}/library-cues/${lc30}/stage-copy`, {});
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual([r.data.libraryCue.label, r.data.libraryCue.name, r.data.libraryCue.basedOnId], ['30-1', '副歌全開（複製）', lc30]);
  const nid = r.data.libraryCue.id;
  assert.deepEqual(mechRows(db, nid), mechRows(db, lc30));
  assert.equal(objRows(db, nid).replaceAll(nid, 'X'), objRows(db, lc30).replaceAll(lc30, 'X'));
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM cues WHERE library_cue_id = ?`).get(nid).n, 0);       // 不放進任何歌
  assert.equal(db.raw.prepare(`SELECT crossfade_seconds s FROM library_cues WHERE id = ?`).get(nid).s, 1.5);
  assert.equal(JSON.stringify([objRows(db, lc30), mechRows(db, lc30), revOf(db, lc30)]), snap);
  // 自己取名、再複製編號往下排
  const r2 = await dir('POST', `${P}/library-cues/${lc30}/stage-copy`, { name: '副歌 B' });
  assert.deepEqual([r2.data.libraryCue.label, r2.data.libraryCue.name], ['30-2', '副歌 B']);
  assert.equal((await dir('POST', `${P}/library-cues/${nid}/stage-copy`, {})).data.libraryCue.label, '30-3');
  assert.equal((await dir('POST', `${P}/library-cues/${lc30}/stage-copy`, { name: '  ' })).status, 400);
  // 沒有通知（沒有歌受影響）
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM notifications`).get().n, 0);
});

test('改名只改名字不改編號；改 Cue 庫的轉場秒數（用 Cue 庫秒數的 cue 跟著變、自己另外設的不動）', async () => {
  const { db, dir, lc30, c1, c2 } = await setup();
  const r = await dir('PATCH', `${P}/library-cues/${lc30}/stage`, { name: '副歌全開 V2' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.libraryCue.label, r.data.libraryCue.name], ['30', '副歌全開 V2']);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM notifications`).get().n, 0);          // 改名不通知
  const cf = await dir('PATCH', `${P}/library-cues/${lc30}/stage`, { crossfadeSeconds: 4, songId: 's1' });
  assert.equal(cf.status, 200);
  assert.equal(cf.data.libraryCue.crossfadeSeconds, 4);
  const sec = (id) => db.raw.prepare(`SELECT crossfade_seconds s, crossfade_own o FROM cues WHERE id = ?`).get(id);
  assert.deepEqual({ ...sec(c1) }, { s: 4, o: 0 });     // 用 Cue 庫的 → 跟著變
  assert.deepEqual({ ...sec(c2) }, { s: 3, o: 1 });     // 這首歌自己設的 → 不動
  // 沒變不通知；0 秒（直接切換）也可以；超出範圍 400
  const before = db.raw.prepare(`SELECT COUNT(*) n FROM notifications`).get().n;
  assert.equal((await dir('PATCH', `${P}/library-cues/${lc30}/stage`, { crossfadeSeconds: 4 })).status, 200);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM notifications`).get().n, before);
  assert.equal((await dir('PATCH', `${P}/library-cues/${lc30}/stage`, { crossfadeSeconds: 0 })).status, 200);
  assert.equal((await dir('PATCH', `${P}/library-cues/${lc30}/stage`, { crossfadeSeconds: -1 })).status, 400);
  assert.equal((await dir('PATCH', `${P}/library-cues/${lc30}/stage`, { crossfadeSeconds: 4000 })).status, 400);
  assert.equal((await dir('PATCH', `${P}/library-cues/${lc30}/stage`, { crossfadeSeconds: '2' })).status, 400);
  assert.equal((await dir('PATCH', `${P}/library-cues/${lc30}/stage`, { name: ' ' })).status, 400);
  assert.equal((await dir('PATCH', `${P}/library-cues/${lc30}/stage`, { name: 5 })).status, 400);
  // 活動紀錄（沿用原本的改名 / 改秒數紀錄）
  const kinds = db.raw.prepare(`SELECT payload FROM activity_log WHERE target_type = 'library_cue' AND user_id = 'u_dir'`).all().map(x => JSON.parse(x.payload).kind);
  assert.ok(kinds.includes('rename') && kinds.includes('crossfade'));
});

test('這首歌自己設的轉場秒數：只能改自己另外設的；沒另外設的要改 Cue 庫的（409）', async () => {
  const { db, dir, lc30, c1, c2 } = await setup();
  const r = await dir('PUT', `${P}/songs/s2/cues/${c2}/stage-crossfade`, { crossfadeSeconds: 2.5 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual({ ...db.raw.prepare(`SELECT crossfade_seconds s, crossfade_own o FROM cues WHERE id = ?`).get(c2) }, { s: 2.5, o: 1 });
  assert.equal(db.raw.prepare(`SELECT crossfade_seconds s FROM library_cues WHERE id = ?`).get(lc30).s, 1.5);      // Cue 庫的沒動
  const no = await dir('PUT', `${P}/songs/s1/cues/${c1}/stage-crossfade`, { crossfadeSeconds: 2 });
  assert.equal(no.status, 409);
  assert.deepEqual({ ...db.raw.prepare(`SELECT crossfade_seconds s, crossfade_own o FROM cues WHERE id = ?`).get(c1) }, { s: 1.5, o: 0 });
  // 通知：製作 + 這首歌（S02）的動畫師，不通知自己
  const notes = notesOf(db);
  assert.deepEqual(notes.map(n => n.u).sort(), ['u_admin', 'u_ani2', 'u_pm']);
  assert.equal(notes[0].e, '把 cue 30 在 S02 的轉場改成 2.5 秒');
});

test('通知：存回後，收的人 = 專案的製作 + 全站製作 + 用到這個 cue 的歌的動畫師；不含自己、別的導演、沒指派的動畫師、別的專案；每人一則；點了開那首歌', async () => {
  const { db, dir, ani, m1, lc30, lc31 } = await setup();
  const r = await dir('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: withValues(db, lc30, { [m1]: 2 }), songId: 's2' });
  assert.equal(r.status, 200);
  assert.equal(r.data.notified, 4);
  const notes = notesOf(db);
  assert.deepEqual(notes.map(n => n.u), ['u_admin', 'u_ani1', 'u_ani2', 'u_pm']);
  for (const n of notes) {
    assert.equal(n.kind, 'director_stage');
    assert.equal(n.a, '王導');
    assert.equal(n.e, '改了 cue 30 的舞台（S01、S02 會一起變）');
  }
  // 動畫師點了開自己的歌；製作開導演現在這首（s2）
  const by = Object.fromEntries(notes.map(n => [n.u, n.s]));
  assert.deepEqual(by, { u_admin: 's2', u_ani1: 's1', u_ani2: 's2', u_pm: 's2' });
  // 小鈴鐺清單看得到
  const bell = await ani('GET', '/api/notifications');
  assert.equal(bell.status, 200);
  assert.deepEqual(bell.data.items.map(i => [i.kind, i.actorName, i.excerpt, i.songId, i.songCode]), [['director_stage', '王導', '改了 cue 30 的舞台（S01、S02 會一起變）', 's1', 'S01']]);
  // 沒有 song 在用的 cue：只通知製作
  db.raw.exec(`DELETE FROM notifications`);
  const lonely = (await dir('POST', `${P}/library-cues/${lc30}/stage-copy`, {})).data.libraryCue.id;
  const r2 = await dir('PUT', `${P}/library-cues/${lonely}/mechanism-positions`, { ifRev: 0, mechanisms: withValues(db, lonely, { [m1]: 2.1 }) });
  assert.equal(r2.status, 200);
  assert.deepEqual(notesOf(db).map(n => [n.u, n.e]), [['u_admin', '改了 cue 30-1 的舞台'], ['u_pm', '改了 cue 30-1 的舞台']]);
  // 另外一個 cue（只有 S03 在用，沒指派動畫師）
  db.raw.exec(`DELETE FROM notifications`);
  await dir('PUT', `${P}/library-cues/${lc31}/mechanism-positions`, { ifRev: 0, mechanisms: [{ mechanismId: m1, value: 1, delaySec: null, durationSec: null, carried: false }] });
  assert.deepEqual(notesOf(db).map(n => n.u), ['u_admin', 'u_pm']);
});

test('通知：自己是製作就不通知自己；同一個動畫師負責好幾首用到的歌，只收一則；動畫師同時是製作也只一則；沒有退出專案的人不通知', async () => {
  const { db, pm, admin, dir2, m1, lc30 } = await setup();
  // 製作自己存
  const r = await pm('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: withValues(db, lc30, { [m1]: 2 }) });
  assert.equal(r.status, 200);
  assert.deepEqual(notesOf(db).map(n => n.u), ['u_admin', 'u_ani1', 'u_ani2']);
  assert.equal(notesOf(db)[0].a, '阿宏');
  // 全站製作自己存 → 不通知自己，通知專案的製作
  db.raw.exec(`DELETE FROM notifications`);
  await admin('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 1, mechanisms: withValues(db, lc30, { [m1]: 1.2 }) });
  assert.deepEqual(notesOf(db).map(n => n.u), ['u_ani1', 'u_ani2', 'u_pm']);
  // 甲動畫同時負責 s3（也用 30）→ 還是只收一則
  db.raw.exec(`DELETE FROM notifications`);
  db.raw.exec(`UPDATE songs SET animator_user_id = 'u_ani1' WHERE id = 's2'`);
  await dir2('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 2, mechanisms: withValues(db, lc30, { [m1]: 0.9 }) });
  assert.equal(notesOf(db).filter(n => n.u === 'u_ani1').length, 1);
  assert.deepEqual(notesOf(db).map(n => n.u), ['u_admin', 'u_ani1', 'u_pm']);
  // 動畫師被移出專案 → 不通知
  db.raw.exec(`DELETE FROM notifications`);
  db.raw.exec(`DELETE FROM project_members WHERE user_id = 'u_ani1'`);
  await dir2('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 3, mechanisms: withValues(db, lc30, { [m1]: 1.1 }) });
  assert.deepEqual(notesOf(db).map(n => n.u), ['u_admin', 'u_pm']);
});

test('通知：另存只通知製作和這首歌的動畫師；改 Cue 庫的轉場秒數通知用到的歌的動畫師；復原也通知', async () => {
  const { db, dir, m1, lc30, c1 } = await setup();
  const saveAs = await dir('POST', `${P}/library-cues/${lc30}/stage-save-as`, { mechanisms: withValues(db, lc30, { [m1]: 2 }), songId: 's1', cueId: c1 });
  assert.equal(saveAs.status, 201);
  assert.deepEqual(notesOf(db).map(n => [n.u, n.s]), [['u_admin', 's1'], ['u_ani1', 's1'], ['u_pm', 's1']]);
  assert.equal(notesOf(db)[0].e, '另存了 cue 30-1（從 cue 30），S01 改用新的');
  db.raw.exec(`DELETE FROM notifications`);
  // 現在只有 s2 還在用 30
  await dir('PATCH', `${P}/library-cues/${lc30}/stage`, { crossfadeSeconds: 2 });
  assert.deepEqual(notesOf(db).map(n => n.u), ['u_admin', 'u_ani2', 'u_pm']);
  assert.equal(notesOf(db)[0].e, '把 cue 30 的轉場改成 2 秒（S02 會一起變）');
  db.raw.exec(`DELETE FROM notifications`);
  const saved = await dir('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: withValues(db, lc30, { [m1]: 2.2 }) });
  db.raw.exec(`DELETE FROM notifications`);
  await dir('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: saved.data.rev, mechanisms: saved.data.previous.mechanisms, undo: true });
  assert.equal(notesOf(db)[0].e, '復原了 cue 30 的舞台調整（S02 會一起變）');
});

test('讀機關位置時多給每個 Cue 庫的 cue 的 rev（libraryRevs）：導演頁存回時帶；沒帶 cuelib 的舊版畫面不變', async () => {
  const { db, dir, ani, m1, lc30, lc31 } = await setup();
  const url = (extra = '') => `${P}/songs/s1/mechanism-positions?mech=3${extra}`;
  const withLib = await dir('GET', url('&cuelib=1'));
  assert.equal(withLib.status, 200);
  assert.equal(withLib.data.mode, 'library');
  assert.deepEqual(withLib.data.libraryRevs, { [lc30]: 0 });
  assert.equal('libraryRevs' in (await dir('GET', url())).data, false);
  await dir('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: withValues(db, lc30, { [m1]: 2 }) });
  assert.deepEqual((await ani('GET', url('&cuelib=1'))).data.libraryRevs, { [lc30]: 1 });     // 動畫師也看得到（只是看）
  assert.deepEqual((await dir('GET', `${P}/songs/s3/mechanism-positions?mech=3&cuelib=1`)).data.libraryRevs, { [lc31]: 0 });
});

test('複製專案 / 匯出：Cue 庫跟著走，記「誰改的」的欄位不帶過去', async () => {
  const { db, dir, admin, m1, lc30 } = await setup();
  await dir('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: withValues(db, lc30, { [m1]: 2 }) });
  assert.equal(db.raw.prepare(`SELECT updated_by_user_id u FROM library_cues WHERE id = ?`).get(lc30).u, 'u_dir');
  const dup = await admin('POST', `${P}/duplicate`, {});
  assert.ok(dup.status === 200 || dup.status === 201, JSON.stringify(dup.data));
  const newId = dup.data.id || dup.data.project?.id;
  const copied = db.raw.prepare(`SELECT id, label, rev, updated_by_user_id u, updated_by_rev r FROM library_cues WHERE project_id = ? ORDER BY label`).all(newId);
  assert.deepEqual(copied.map(c => [c.label, c.u, c.r]), [['30', null, null], ['31', null, null]]);
  const exp = await admin('GET', `${P}/export`);
  assert.equal(exp.status, 200);
  assert.equal(exp.data.libraryCues.length, 2);
});

test('還沒跑 0048 的資料庫（沒有記人的欄位）：照樣能存、能復原，衝突時說「被別人改過」', async () => {
  const { db, dir, dir2, admin, m1, lc30, look30 } = await setup({ before0048: true });
  const a = await dir('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: withValues(db, lc30, { [m1]: 2 }) });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.rev, 1);
  const b = await dir2('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 0, mechanisms: withValues(db, lc30, { [m1]: 0.4 }) });
  assert.equal(b.status, 409);
  assert.equal(b.data.error, '這個 cue 剛剛被別人改過');
  assert.equal(b.data.rev, 1);
  // 製作原本的整個畫面 PUT 也照舊
  assert.equal((await admin('PUT', `${P}/library-cues/${lc30}/look`, { ifRev: 1, ...look30 })).status, 200);
  const undo = await dir('PUT', `${P}/library-cues/${lc30}/mechanism-positions`, { ifRev: 2, mechanisms: a.data.previous.mechanisms, undo: true });
  assert.equal(undo.status, 200);
});

test('舊模式的專案（沒有 Cue 庫）：新的幾條都回 400「這個專案還沒有 Cue 庫」，什麼都不動', async () => {
  const { db, dir } = await setup();
  db.raw.exec(`INSERT INTO cues (id, song_id, name, "order", status) VALUES ('c_old', 'o1', '舊 cue', 0, 'master')`);
  const snap = JSON.stringify(db.raw.prepare(`SELECT * FROM cues ORDER BY id`).all());
  const P3 = '/api/projects/p3';
  for (const [m, path, body] of [
    ['PUT', 'library-cues/lc_x/mechanism-positions', { ifRev: 0, mechanisms: [] }],
    ['POST', 'library-cues/lc_x/stage-save-as', { mechanisms: [], songId: 'o1', cueId: 'c_old' }],
    ['POST', 'library-cues/lc_x/stage-copy', {}],
    ['PATCH', 'library-cues/lc_x/stage', { name: 'x' }],
    ['PUT', 'songs/o1/cues/c_old/stage-crossfade', { crossfadeSeconds: 1 }],
  ]) {
    const r = await dir(m, `${P3}/${path}`, body);
    assert.equal(r.status, 400, `${m} ${path}`);
    assert.equal(r.data.error, '這個專案還沒有 Cue 庫');
  }
  assert.equal(JSON.stringify(db.raw.prepare(`SELECT * FROM cues ORDER BY id`).all()), snap);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM notifications`).get().n, 0);
});
