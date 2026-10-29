// 跑法：cd cf-worker && npm test
// 歌曲的音樂（migration 0049）：格式 / 大小 / 權限 / 換掉舊檔排隊刪 / 播放 / 分享連結碰不到。
//   純判斷 + 走真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1 + 記憶體假 R2），寫法跟 directorStage.test.mjs 一樣。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, applyMigrations, freshDb, migrationFiles } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import { describeProjectRoute, roleMeetsNeed, needDeniedMessage, canEditStage } from './access.mjs';
import { signVideoPass, verifyVideoPass, MIB } from './videos.mjs';
import { runPendingR2Deletes } from './storage.mjs';
import {
  DEFAULT_MUSIC_MAX_BYTES, MUSIC_MAX_CEILING, cleanMusicDuration, cleanMusicFilename, extForMusicMime, musicMaxBytes, musicMimeFor,
  musicR2Key, musicWriteDecision, signMusicPass, unsupportedMusicMessage, verifyMusicPass,
} from './songMusic.mjs';

const BASE = 'https://proxy.test';
const P = '/api/projects/p1';

// ─── 純判斷 ───

test('格式：mp3 / wav / m4a / aac / flac 收；看類型，類型是「一般檔案」時看副檔名；影片和別的不收', () => {
  assert.equal(musicMimeFor({ mime: 'audio/mpeg', filename: 'a.mp3' }), 'audio/mpeg');
  assert.equal(musicMimeFor({ mime: 'audio/mp3', filename: 'a.mp3' }), 'audio/mpeg');
  assert.equal(musicMimeFor({ mime: 'audio/x-wav', filename: 'a.wav' }), 'audio/wav');
  assert.equal(musicMimeFor({ mime: 'audio/wave', filename: 'a.wav' }), 'audio/wav');
  assert.equal(musicMimeFor({ mime: 'audio/x-m4a', filename: 'a.m4a' }), 'audio/mp4');
  assert.equal(musicMimeFor({ mime: 'audio/mp4', filename: 'a.m4a' }), 'audio/mp4');
  assert.equal(musicMimeFor({ mime: 'audio/aac', filename: 'a.aac' }), 'audio/aac');
  assert.equal(musicMimeFor({ mime: 'audio/flac', filename: 'a.flac' }), 'audio/flac');
  assert.equal(musicMimeFor({ mime: 'audio/mpeg; charset=binary', filename: 'a' }), 'audio/mpeg');
  // 類型看不出來 → 副檔名
  for (const mime of ['', 'application/octet-stream', null, undefined]) {
    assert.equal(musicMimeFor({ mime, filename: 'S01_開場.WAV' }), 'audio/wav', String(mime));
    assert.equal(musicMimeFor({ mime, filename: 'x.m4a' }), 'audio/mp4');
    assert.equal(musicMimeFor({ mime, filename: 'x.mp3' }), 'audio/mpeg');
  }
  assert.equal(musicMimeFor({ mime: 'application/octet-stream', filename: 'x.txt' }), null);
  assert.equal(musicMimeFor({ mime: 'application/octet-stream', filename: 'noext' }), null);
  // 有些瀏覽器把 m4a 標成 video/mp4：副檔名是 m4a 才收；真的影片不收
  assert.equal(musicMimeFor({ mime: 'video/mp4', filename: 'x.m4a' }), 'audio/mp4');
  assert.equal(musicMimeFor({ mime: 'video/mp4', filename: 'x.mp4' }), null);
  assert.equal(musicMimeFor({ mime: 'video/webm', filename: 'x.webm' }), null);
  assert.equal(musicMimeFor({ mime: 'audio/ogg', filename: 'x.ogg' }), null);
  assert.equal(musicMimeFor({ mime: 'text/html', filename: 'x.mp3' }), null);
  assert.deepEqual(['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/aac', 'audio/flac'].map(extForMusicMime), ['mp3', 'wav', 'm4a', 'aac', 'flac']);
  assert.match(unsupportedMusicMessage('x.ogg', 'audio/ogg'), /\.ogg.*MP3 \/ WAV \/ M4A \/ AAC \/ FLAC/);
  assert.doesNotMatch(unsupportedMusicMessage('x', ''), /\b(users?|admins?|directors?|animators?)\b/i);
});

test('大小上限：預設 90 MiB（4 分鐘 WAV 放得下），wrangler.toml 的 MUSIC_MAX_BYTES 可以改但不超過 95 MiB', () => {
  assert.equal(DEFAULT_MUSIC_MAX_BYTES, 90 * MIB);
  assert.ok(DEFAULT_MUSIC_MAX_BYTES > 4 * 60 * 48000 * 3 * 2);   // 48k / 24bit / 立體聲 4 分鐘
  assert.equal(musicMaxBytes({}), 90 * MIB);
  assert.equal(musicMaxBytes(undefined), 90 * MIB);
  assert.equal(musicMaxBytes({ MUSIC_MAX_BYTES: String(10 * MIB) }), 10 * MIB);
  assert.equal(musicMaxBytes({ MUSIC_MAX_BYTES: '1' }), 90 * MIB);         // 太小 = 亂填
  assert.equal(musicMaxBytes({ MUSIC_MAX_BYTES: 'abc' }), 90 * MIB);
  assert.equal(musicMaxBytes({ MUSIC_MAX_BYTES: String(500 * MIB) }), MUSIC_MAX_CEILING);
  assert.ok(MUSIC_MAX_CEILING < 100 * 1000 * 1000);                       // Cloudflare 一個請求最多 100 MB
});

test('檔名 / 長度 / R2 位置', () => {
  assert.equal(cleanMusicFilename('S01%20%E9%96%8B%E5%A0%B4.mp3'), 'S01 開場.mp3');
  assert.equal(cleanMusicFilename('C:\\fakepath\\歌.wav'), '歌.wav');
  assert.equal(cleanMusicFilename('../../etc/x.mp3'), 'x.mp3');
  assert.equal(cleanMusicFilename('a\u0000b\nc.mp3'), 'abc.mp3');
  assert.equal(cleanMusicFilename(null), '');
  assert.equal(cleanMusicFilename('%E0%A4%A'), '%E0%A4%A');            // 解不開就照原樣
  assert.equal(cleanMusicFilename('x'.repeat(400)).length, 255);
  assert.equal(cleanMusicDuration('215.1234'), 215.123);
  for (const bad of [0, -1, 'abc', NaN, Infinity, 86401, '', null, undefined]) assert.equal(cleanMusicDuration(bad), null, String(bad));
  assert.equal(musicR2Key('p1', 's1', 'sm_ab', 'audio/mp4'), 'music/p1/s1/sm_ab.m4a');
});

test('誰能寫：製作（含全站製作）和導演；動畫師、不是成員都不行', () => {
  assert.equal(musicWriteDecision('admin').ok, true);
  assert.equal(musicWriteDecision('director').ok, true);
  for (const r of ['animator', null, undefined, '', 'owner']) {
    const d = musicWriteDecision(r);
    assert.equal(d.ok, false, String(r));
    assert.equal(d.status, 403);
  }
  assert.match(musicWriteDecision('animator').error, /動畫師可以聽/);
  assert.equal(canEditStage('director'), true);
  assert.equal(roleMeetsNeed('musicEditor', { role: 'director', globalRole: 'director' }), true);
  assert.equal(roleMeetsNeed('musicEditor', { role: 'admin', globalRole: 'animator' }), true);
  assert.equal(roleMeetsNeed('musicEditor', { role: 'animator', globalRole: 'animator' }), false);
  assert.equal(roleMeetsNeed('musicEditor', { role: null, globalRole: 'admin' }), false);
  assert.equal(roleMeetsNeed('member', { role: 'animator', globalRole: 'animator' }), true);
  assert.match(needDeniedMessage('musicEditor'), /製作或導演/);
  assert.doesNotMatch(needDeniedMessage('musicEditor') + musicWriteDecision('animator').error, /\b(users?|admins?|directors?|animators?)\b/i);
});

test('路由表：看 / 聽 = 成員；上傳 / 換 / 移除 = musicEditor；方法不對 405；多餘的層 404', () => {
  const seg = (p) => ['api', 'projects', 'p1', ...p.split('/')];
  const d = (m, p) => describeProjectRoute(m, seg(p));
  assert.deepEqual([d('GET', 'songs/s1/music').kind, d('GET', 'songs/s1/music').need, d('GET', 'songs/s1/music').songId], ['music.get', 'member', 's1']);
  assert.deepEqual([d('HEAD', 'songs/s1/music').kind, d('HEAD', 'songs/s1/music').need], ['music.get', 'member']);
  assert.deepEqual([d('PUT', 'songs/s1/music').kind, d('PUT', 'songs/s1/music').need], ['music.put', 'musicEditor']);
  assert.deepEqual([d('DELETE', 'songs/s1/music').kind, d('DELETE', 'songs/s1/music').need], ['music.delete', 'musicEditor']);
  assert.deepEqual([d('GET', 'songs/s1/music/stream').kind, d('GET', 'songs/s1/music/stream').need], ['music.stream', 'member']);
  assert.equal(d('HEAD', 'songs/s1/music/stream').need, 'member');
  for (const [m, p] of [['POST', 'songs/s1/music'], ['PATCH', 'songs/s1/music'], ['PUT', 'songs/s1/music/stream'], ['DELETE', 'songs/s1/music/stream'], ['POST', 'songs/s1/music/stream']]) {
    assert.equal(d(m, p).methodNotAllowed, true, `${m} ${p}`);
  }
  assert.equal(d('GET', 'songs/s1/music/other'), null);
  assert.equal(d('GET', 'songs/s1/music/stream/x'), null);
  // 影片和 cue 的權限沒被動到
  assert.equal(d('POST', 'songs/s1/videos/uploads').need, 'videoUploader');
  assert.equal(d('PATCH', 'songs/s1/cues/c1').need, 'editor');
});

test('播放通行證：跟影片的分開（影片的通行證拿來開音樂、音樂的拿來開影片都不行），換人 / 換首 / 過期都不行', async () => {
  const secret = 'test-secret';
  const t = 1_700_000_000_000;
  const pass = await signMusicPass(secret, { musicId: 'sm_1', userId: 'u1', now: t });
  assert.equal(await verifyMusicPass(secret, pass, { musicId: 'sm_1', now: t }), 'u1');
  assert.equal(await verifyMusicPass(secret, pass, { musicId: 'sm_2', now: t }), null);
  assert.equal(await verifyMusicPass('other-secret', pass, { musicId: 'sm_1', now: t }), null);
  assert.equal(await verifyMusicPass(secret, pass, { musicId: 'sm_1', now: t + 13 * 3600 * 1000 }), null);
  assert.equal(await verifyMusicPass(secret, 'abc', { musicId: 'sm_1', now: t }), null);
  const videoPass = await signVideoPass(secret, { videoId: 'sm_1', userId: 'u1', now: t });
  assert.equal(await verifyMusicPass(secret, videoPass, { musicId: 'sm_1', now: t }), null);
  assert.equal(await verifyVideoPass(secret, pass, { videoId: 'sm_1', now: t }), null);
});

// ─── 路由 ───

async function setup({ before0049 = false, archivedProject = false } = {}) {
  const db = before0049 ? (() => { const d = new D1Sqlite(); applyMigrations(d, { before: '0049' }); return d; })() : freshDb();
  const users = [
    ['u_admin', '陳製作', 'admin', 'ADMIN-1'],      // 全站製作
    ['u_pm', '阿宏', 'animator', 'PM-1'],           // p1 的製作（帳號是動畫師）
    ['u_dir', '王導', 'director', 'DIR-1'],         // p1 的導演
    ['u_ani', '甲動畫', 'animator', 'ANI-1'],       // p1 的動畫師（S01 負責人）
    ['u_other', '別組導演', 'director', 'OTHER-1'], // 只在 p2
    ['u_free', '路人', 'animator', 'FREE-1'],       // 不是任何專案的成員
  ];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`).bind(id, `${id}@x.test`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name, status) VALUES ('p1', '巡演', ?), ('p2', '另一個', 'active')`).bind(archivedProject ? 'archived' : 'active'),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES
      ('p1', 'u_pm', 'admin'), ('p1', 'u_dir', 'director'), ('p1', 'u_ani', 'animator'), ('p2', 'u_other', 'director')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", code, animator_user_id) VALUES
      ('s1', 'p1', '開場曲', 0, 'S01', 'u_ani'), ('s2', 'p1', '副歌', 1, 'S02', NULL), ('z1', 'p2', '別的歌', 0, 'Z1', NULL)`),
  ]);
  const r2 = memoryR2();
  const env = { DB: db, AUTH_SECRET: 'test-secret', MODELS: r2 };
  const tokens = {};
  for (const [id, , , code] of users) {
    const r = await worker.fetch(new Request(`${BASE}/api/auth/login`, { method: 'POST', body: JSON.stringify({ accessCode: code }), headers: { 'content-type': 'application/json' } }), env);
    tokens[id] = (await r.json()).token;
  }
  const raw = async (who, method, path, init = {}) => {
    const headers = { ...(init.headers || {}) };
    if (who) headers.authorization = `Bearer ${tokens[who]}`;
    return worker.fetch(new Request(BASE + path, { method, headers, body: init.body }), env);
  };
  const as = (who) => async (method, path, body) => {
    const r = await raw(who, method, path, { headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data, res: r };
  };
  /** 上傳：body 是 Uint8Array；length: false = 不帶 Content-Length */
  const put = async (who, path, bytes, { type = 'audio/mpeg', name = '開場.mp3', dur = 215.5, length = true, query } = {}) => {
    const q = query ?? `?filename=${encodeURIComponent(name)}${dur === null ? '' : `&durationSec=${dur}`}`;
    const headers = { 'content-type': type };
    if (length) headers['content-length'] = String(bytes.byteLength);
    const r = await raw(who, 'PUT', `${path}${q}`, { headers, body: bytes });
    let data = null;
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data, res: r };
  };
  return { db, env, r2, raw, as, put, admin: as('u_admin'), pm: as('u_pm'), dir: as('u_dir'), ani: as('u_ani'), other: as('u_other'), free: as('u_free'), anon: as(null) };
}

const bytes = (n, fill = 7) => new Uint8Array(n).fill(fill);
const musicKeys = (r2) => r2.keys().filter(k => k.startsWith('music/'));
const pending = (db) => db.raw.prepare(`SELECT r2_key FROM r2_pending_deletes ORDER BY r2_key`).all().map(r => r.r2_key);
const rowOf = (db, songId) => db.raw.prepare(`SELECT * FROM song_music WHERE song_id = ?`).get(songId);

test('migration 0049：只加一張表，舊資料都在；沒套 migration 的時候歌單、刪歌照常', async () => {
  assert.ok(migrationFiles().includes('0049_song_music.sql'));
  const { db, as, env, r2, put } = await setup({ before0049: true });
  assert.equal(db.raw.prepare(`SELECT name FROM sqlite_master WHERE name = 'song_music'`).get(), undefined);
  const admin = as('u_admin');
  const list = await admin('GET', `${P}/songs`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.songs.map(s => [s.id, s.hasMusic, s.music]), [['s1', false, null], ['s2', false, null]]);
  assert.equal((await admin('GET', `${P}/songs/s1`)).data.music, null);
  assert.equal((await admin('DELETE', `${P}/songs/s2`)).status, 200);          // 還沒有這張表也能刪歌
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM songs WHERE id = 's2'`).get().n, 0);
  // 套上 0049 之後可以用
  applyMigrations(db, { only: '0049' });
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM songs`).get().n, 2);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM song_music`).get().n, 0);
  const up = await put('u_admin', `${P}/songs/s1/music`, bytes(100));
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal(musicKeys(r2).length, 1);
  void env;
});

test('上傳：製作、專案的製作、導演都可以；回傳檔名 / 長度 / 大小 / 誰傳的 / 播放網址；R2 位置照規則；歌單和單首歌都帶得到', async () => {
  const { db, r2, put, as, admin } = await setup();
  const up = await put('u_dir', `${P}/songs/s1/music`, bytes(1000), { name: 'S01 開場.mp3', dur: 215.5 });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const m = up.data.music;
  assert.match(m.id, /^sm_[0-9a-f]{16}$/);
  assert.deepEqual([m.filename, m.mime, m.sizeBytes, m.durationSec, m.songId], ['S01 開場.mp3', 'audio/mpeg', 1000, 215.5, 's1']);
  assert.deepEqual(m.uploadedBy, { id: 'u_dir', name: '王導' });
  assert.match(m.streamUrl, new RegExp(`^/api/music/${m.id}/stream\\?pass=`));
  assert.deepEqual(musicKeys(r2), [`music/p1/s1/${m.id}.mp3`]);
  const obj = await r2.head(`music/p1/s1/${m.id}.mp3`);
  assert.equal(obj.httpMetadata.contentType, 'audio/mpeg');
  assert.equal(obj.size, 1000);
  // 歌單：有沒有音樂 + 檔名 / 長度（沒有播放網址、沒有 R2 位置）
  const songs = (await admin('GET', `${P}/songs`)).data.songs;
  const s1 = songs.find(s => s.id === 's1'), s2 = songs.find(s => s.id === 's2');
  assert.equal(s1.hasMusic, true);
  assert.deepEqual([s1.music.filename, s1.music.durationSec, s1.music.sizeBytes, s1.music.id], ['S01 開場.mp3', 215.5, 1000, m.id]);
  assert.equal('r2_key' in s1.music || 'streamUrl' in s1.music, false);
  assert.deepEqual([s2.hasMusic, s2.music], [false, null]);
  assert.equal((await admin('GET', `${P}/songs/s1`)).data.music.filename, 'S01 開場.mp3');
  // 單首：成員拿得到播放網址
  const got = await as('u_ani')('GET', `${P}/songs/s1/music`);
  assert.equal(got.status, 200);
  assert.equal(got.data.music.id, m.id);
  assert.match(got.data.music.streamUrl, /\?pass=/);
  assert.equal((await as('u_ani')('GET', `${P}/songs/s2/music`)).data.music, null);
  // 專案的製作（帳號是動畫師）和全站製作也可以
  assert.equal((await put('u_pm', `${P}/songs/s2/music`, bytes(50), { type: 'audio/wav', name: 'x.wav' })).status, 201);
  assert.equal((await put('u_admin', `${P}/songs/s2/music`, bytes(60), { type: 'audio/aac', name: 'x.aac' })).status, 200);
  assert.equal(rowOf(db, 's2').mime, 'audio/aac');
  // 記在最近活動裡
  const act = db.raw.prepare(`SELECT action, target_type, payload FROM activity_log WHERE target_type = 'song_music' ORDER BY rowid`).all();
  assert.deepEqual(act.map(a => a.action), ['upload', 'upload', 'update']);
  assert.equal(JSON.parse(act[0].payload).filename, 'S01 開場.mp3');
});

test('動畫師、別的專案、路人、沒登入：寫入一律被擋，資料和檔案都不動；動畫師可以看和聽', async () => {
  const { db, r2, put, raw, ani, other, free, anon } = await setup();
  const first = await put('u_dir', `${P}/songs/s1/music`, bytes(100));
  assert.equal(first.status, 201);
  const snap = JSON.stringify([rowOf(db, 's1'), musicKeys(r2), pending(db)]);
  for (const who of ['u_ani', 'u_other', 'u_free']) {
    const p = await put(who, `${P}/songs/s1/music`, bytes(200), { name: 'hack.mp3' });
    assert.equal(p.status, 403, `PUT ${who}`);
    assert.ok(typeof p.data.error === 'string' && p.data.error.length > 0);
    assert.equal((await as2(raw, who)('DELETE', `${P}/songs/s1/music`)).status, 403, `DELETE ${who}`);
  }
  assert.equal((await put(null, `${P}/songs/s1/music`, bytes(200))).status, 401);
  assert.equal((await anon('DELETE', `${P}/songs/s1/music`)).status, 401);
  assert.equal(JSON.stringify([rowOf(db, 's1'), musicKeys(r2), pending(db)]), snap);
  // 動畫師訊息：寫的是「動畫師可以聽」，不是英文
  const denied = await put('u_ani', `${P}/songs/s1/music`, bytes(10));
  assert.match(denied.data.error, /製作或導演/);
  // 看 / 聽：動畫師可以；別的專案的導演和路人不行
  assert.equal((await ani('GET', `${P}/songs/s1/music`)).status, 200);
  assert.equal((await other('GET', `${P}/songs/s1/music`)).status, 403);
  assert.equal((await free('GET', `${P}/songs/s1/music`)).status, 403);
  assert.equal((await anon('GET', `${P}/songs/s1/music`)).status, 401);
  // 別的專案的歌用自己專案的網址：找不到這首歌（網址上的歌要屬於這個專案）
  assert.equal((await put('u_dir', `${P}/songs/z1/music`, bytes(10))).status, 404);
  assert.equal((await put('u_other', `/api/projects/p2/songs/s1/music`, bytes(10))).status, 404);
  assert.equal(rowOf(db, 'z1'), undefined);
});

// 小工具：用 raw 組一個沒有 JSON body 的呼叫
function as2(raw, who) {
  return async (method, path) => {
    const r = await raw(who, method, path, {});
    let data = null;
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data };
  };
}

test('封存的專案：不能上傳 / 換 / 移除（409），還是可以看和聽', async () => {
  const { db, put, raw, admin, env, r2 } = await setup({ archivedProject: false });
  const up = await put('u_dir', `${P}/songs/s1/music`, bytes(100));
  assert.equal(up.status, 201);
  const url = up.data.music.streamUrl;
  db.raw.exec(`UPDATE projects SET status = 'archived' WHERE id = 'p1'`);
  const snap = JSON.stringify([rowOf(db, 's1'), musicKeys(r2), pending(db)]);
  assert.equal((await put('u_admin', `${P}/songs/s1/music`, bytes(100))).status, 409);
  assert.equal((await as2(raw, 'u_admin')('DELETE', `${P}/songs/s1/music`)).status, 409);
  assert.equal(JSON.stringify([rowOf(db, 's1'), musicKeys(r2), pending(db)]), snap);
  const seen = await admin('GET', `${P}/songs/s1/music`);                        // 全站製作看得到封存的專案
  assert.equal(seen.status, 200);
  assert.equal((await worker.fetch(new Request(BASE + seen.data.music.streamUrl), env)).status, 200);   // 也聽得到
  // 導演看不到封存的專案：連看、連播放（導演上傳時拿到的通行證還沒過期也一樣）都是 404
  assert.equal((await as2(raw, 'u_dir')('GET', `${P}/songs/s1/music`)).status, 404);
  assert.equal((await worker.fetch(new Request(BASE + url), env)).status, 404);
});

test('格式和大小：不收的格式 415、太大 413、空的 400、沒帶大小 411；失敗不留檔案也不留資料', async () => {
  const { db, r2, put, env } = await setup();
  const base = `${P}/songs/s1/music`;
  assert.equal((await put('u_dir', base, bytes(100), { type: 'video/mp4', name: 'mv.mp4' })).status, 415);
  assert.equal((await put('u_dir', base, bytes(100), { type: 'application/octet-stream', name: 'x.exe' })).status, 415);
  assert.equal((await put('u_dir', base, bytes(100), { type: 'audio/ogg', name: 'x.ogg' })).status, 415);
  const bad = await put('u_dir', base, bytes(100), { type: 'text/html', name: 'x.mp3' });
  assert.equal(bad.status, 415);
  assert.match(bad.data.error, /MP3 \/ WAV \/ M4A \/ AAC \/ FLAC/);
  // 一般檔案類型 + 副檔名對 → 收
  assert.equal((await put('u_dir', base, bytes(100), { type: 'application/octet-stream', name: 'S01.wav' })).status, 201);
  assert.equal(rowOf(db, 's1').mime, 'audio/wav');
  assert.ok(musicKeys(r2)[0].endsWith('.wav'));
  // 沒帶檔名也可以（用格式取名）
  env.MUSIC_MAX_BYTES = String(2 * MIB);
  const big = await put('u_dir', base, bytes(2 * MIB + 1), {});
  assert.equal(big.status, 413);
  assert.equal(big.data.maxBytes, 2 * MIB);
  assert.match(big.data.error, /上限是 2 MB/);
  assert.equal((await put('u_dir', base, bytes(2 * MIB), {})).status, 200);     // 剛好上限可以
  env.MUSIC_MAX_BYTES = undefined;
  assert.equal((await put('u_dir', base, new Uint8Array(0), {})).status, 400);
  const noLen = await put('u_dir', base, bytes(100), { length: false });
  assert.equal(noLen.status, 411);
  assert.equal((await put('u_dir', base, bytes(100), { query: '?filename=x.mp3&durationSec=abc' })).status, 200);   // 長度亂填 → 存成沒有長度
  assert.equal(rowOf(db, 's1').duration_sec, null);
  // 失敗的都沒留下東西：只剩最後一首的檔案
  assert.equal(musicKeys(r2).length, 1);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM song_music`).get().n, 1);
  assert.deepEqual(pending(db), []);
});

test('換音樂：舊的 R2 檔排進 r2_pending_deletes 再刪掉；刪失敗就留在佇列，排程補刪；新的播放網址跟著換', async () => {
  const { db, r2, put, admin } = await setup();
  const base = `${P}/songs/s1/music`;
  const a = (await put('u_dir', base, bytes(100, 1), { name: 'a.mp3' })).data.music;
  const keyA = `music/p1/s1/${a.id}.mp3`;
  assert.deepEqual(musicKeys(r2), [keyA]);
  // 換成 b：舊檔刪掉、佇列清空
  const b = (await put('u_admin', base, bytes(200, 2), { type: 'audio/wav', name: 'b.wav', dur: 99 })).data.music;
  const keyB = `music/p1/s1/${b.id}.wav`;
  assert.notEqual(a.id, b.id);
  assert.deepEqual(musicKeys(r2), [keyB]);
  assert.deepEqual(pending(db), []);
  const row = rowOf(db, 's1');
  assert.deepEqual([row.id, row.r2_key, row.filename, row.size_bytes, row.duration_sec, row.uploaded_by], [b.id, keyB, 'b.wav', 200, 99, 'u_admin']);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM song_music`).get().n, 1);                    // 還是一首
  // R2 刪不掉（壞掉）→ 舊檔留在佇列，使用者那邊照樣成功
  const realDelete = r2.delete.bind(r2);
  r2.delete = async () => { throw new Error('R2 down'); };
  const c = await put('u_dir', base, bytes(300, 3), { name: 'c.mp3' });
  assert.equal(c.status, 200);
  assert.deepEqual(pending(db), [keyB]);
  assert.ok(musicKeys(r2).includes(keyB));                                                         // 檔案還在，等補刪
  assert.equal(db.raw.prepare(`SELECT attempts FROM r2_pending_deletes`).get().attempts, 1);
  // 排程補刪
  r2.delete = realDelete;
  const swept = await runPendingR2Deletes({ DB: db, MODELS: r2 });
  assert.equal(swept.deleted, 1);
  assert.deepEqual(pending(db), []);
  assert.deepEqual(musicKeys(r2), [`music/p1/s1/${c.data.music.id}.mp3`]);
  // 舊的播放網址（舊的音樂 id）聽不到了
  const url = a.streamUrl;
  assert.equal((await fetchUrl(url)).status, 404);
  void admin;

  async function fetchUrl(u) { return (await import('./worker.js')).default.fetch(new Request(BASE + u), { DB: db, AUTH_SECRET: 'test-secret', MODELS: r2 }); }
});

test('移除：這一列和 R2 檔都拿掉；沒有音樂 404；R2 刪失敗留在佇列；移除後可以再上傳', async () => {
  const { db, r2, put, raw, admin, dir } = await setup();
  const base = `${P}/songs/s1/music`;
  assert.equal((await dir('DELETE', base)).status, 404);
  const m = (await put('u_dir', base, bytes(100))).data.music;
  const del = await dir('DELETE', base);
  assert.equal(del.status, 200);
  assert.deepEqual(del.data, { ok: true });
  assert.equal(rowOf(db, 's1'), undefined);
  assert.deepEqual(musicKeys(r2), []);
  assert.deepEqual(pending(db), []);
  assert.equal((await dir('GET', base)).data.music, null);
  assert.equal((await admin('GET', `${P}/songs`)).data.songs[0].hasMusic, false);
  assert.equal((await dir('DELETE', base)).status, 404);
  assert.equal(db.raw.prepare(`SELECT action FROM activity_log WHERE target_type = 'song_music' ORDER BY rowid DESC`).get().action, 'delete');
  // R2 壞掉：資料照樣拿掉，檔案位置留在佇列
  const m2 = (await put('u_admin', base, bytes(100), { name: 'again.mp3' })).data.music;
  const keep = r2.delete.bind(r2);
  r2.delete = async () => { throw new Error('R2 down'); };
  assert.equal((await as2(raw, 'u_dir')('DELETE', base)).status, 200);
  assert.deepEqual(pending(db), [`music/p1/s1/${m2.id}.mp3`]);
  r2.delete = keep;
  await runPendingR2Deletes({ DB: db, MODELS: r2 });
  assert.deepEqual(musicKeys(r2), []);
  assert.deepEqual(pending(db), []);
  void m;
});

test('刪歌：音樂的資料跟著刪，R2 檔也清掉（失敗就留在佇列）', async () => {
  const { db, r2, put, admin } = await setup();
  const m = (await put('u_dir', `${P}/songs/s1/music`, bytes(100))).data.music;
  const keep = r2.delete.bind(r2);
  r2.delete = async () => { throw new Error('R2 down'); };
  assert.equal((await admin('DELETE', `${P}/songs/s1`)).status, 200);
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM song_music`).get().n, 0);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(pending(db), [`music/p1/s1/${m.id}.mp3`]);
  r2.delete = keep;
  await runPendingR2Deletes({ DB: db, MODELS: r2 });
  assert.deepEqual(musicKeys(r2), []);
  // 沒有音樂的歌照樣能刪；刪的歌不存在 404
  assert.equal((await admin('DELETE', `${P}/songs/s2`)).status, 200);
  assert.equal((await admin('DELETE', `${P}/songs/s2`)).status, 404);
});

test('播放：通行證網址（Range、HEAD、快取標頭）；沒有通行證用登入；別人的通行證、過期、換成別首都不行；動畫師可以聽', async () => {
  const { db, env, r2, put, raw, ani, other } = await setup();
  const content = new Uint8Array(500).map((_, i) => i % 251);
  const m = (await put('u_dir', `${P}/songs/s1/music`, content, { type: 'audio/wav', name: 'x.wav' })).data.music;
  const get = (u, init = {}) => worker.fetch(new Request(BASE + u, init), env);
  // 通行證網址：整個檔案
  const full = await get(m.streamUrl);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/wav');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-length'), '500');
  assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
  assert.match(full.headers.get('cache-control'), /private/);
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), content);
  // Range（<audio> 拖時間用）
  const part = await get(m.streamUrl, { headers: { range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 10-19/500');
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), content.slice(10, 20));
  assert.equal((await get(m.streamUrl, { headers: { range: 'bytes=900-' } })).status, 416);
  const head = await get(m.streamUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '500');
  // 專案網址（要登入 header）：成員聽得到
  const viaProject = await raw('u_ani', 'GET', `${P}/songs/s1/music/stream`, { headers: { range: 'bytes=0-3' } });
  assert.equal(viaProject.status, 206);
  assert.deepEqual(new Uint8Array(await viaProject.arrayBuffer()), content.slice(0, 4));
  assert.equal((await raw('u_free', 'GET', `${P}/songs/s1/music/stream`)).status, 403);
  assert.equal((await raw(null, 'GET', `${P}/songs/s1/music/stream`)).status, 401);
  assert.equal((await raw('u_dir', 'GET', `${P}/songs/s2/music/stream`)).status, 404);           // 這首歌沒有音樂
  // 沒有通行證、沒登入 → 401；用登入 header 不帶通行證 → 可以
  assert.equal((await get(`/api/music/${m.id}/stream`)).status, 401);
  assert.equal((await raw('u_ani', 'GET', `/api/music/${m.id}/stream`)).status, 200);
  assert.equal((await raw('u_free', 'GET', `/api/music/${m.id}/stream`)).status, 403);           // 不是成員
  assert.equal((await raw('u_other', 'GET', `/api/music/${m.id}/stream`)).status, 403);          // 別的專案的導演
  // 通行證壞掉 / 不是這首的 / 過期 → 401（passExpired）
  const bad = await get(`/api/music/${m.id}/stream?pass=abc.def.ghi`);
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).passExpired, true);
  const otherPass = await signMusicPass('test-secret', { musicId: 'sm_other', userId: 'u_ani' });
  assert.equal((await get(`/api/music/${m.id}/stream?pass=${encodeURIComponent(otherPass)}`)).status, 401);
  const oldPass = await signMusicPass('test-secret', { musicId: m.id, userId: 'u_ani', now: Date.now() - 20 * 3600 * 1000 });
  assert.equal((await get(`/api/music/${m.id}/stream?pass=${encodeURIComponent(oldPass)}`)).status, 401);
  // 路人的通行證（簽對了，但不是成員）→ 403；帳號停用 → 401
  const freePass = await signMusicPass('test-secret', { musicId: m.id, userId: 'u_free' });
  assert.equal((await get(`/api/music/${m.id}/stream?pass=${encodeURIComponent(freePass)}`)).status, 403);
  const aniPass = await signMusicPass('test-secret', { musicId: m.id, userId: 'u_ani' });
  assert.equal((await get(`/api/music/${m.id}/stream?pass=${encodeURIComponent(aniPass)}`)).status, 200);
  db.raw.exec(`UPDATE users SET deactivated = 1 WHERE id = 'u_ani'`);
  assert.equal((await get(`/api/music/${m.id}/stream?pass=${encodeURIComponent(aniPass)}`)).status, 401);
  // 影片的通行證不能拿來聽音樂
  const vPass = await signVideoPass('test-secret', { videoId: m.id, userId: 'u_dir' });
  assert.equal((await get(`/api/music/${m.id}/stream?pass=${encodeURIComponent(vPass)}`)).status, 401);
  // 亂的 id / 不存在的 / 方法不對
  assert.equal((await get('/api/music/../x/stream')).status, 404);
  assert.equal((await get('/api/music/sm_nope/stream?pass=x')).status, 401);
  assert.equal((await raw('u_dir', 'GET', '/api/music/sm_nope/stream')).status, 404);
  assert.equal((await raw('u_dir', 'GET', `/api/music/${m.id}`)).status, 404);
  void ani; void other; void r2;
});

test('分享連結的訪客碰不到：分享網址底下沒有音樂的路（404 / 405 / 401），分享頁資料裡也沒有音樂，檔案和資料不動', async () => {
  const { db, env, r2, put, dir } = await setup();
  const m = (await put('u_dir', `${P}/songs/s1/music`, bytes(100))).data.music;
  const link = await dir('POST', `${P}/share-links`, {});
  assert.equal(link.status, 201, JSON.stringify(link.data));
  const token = link.data.token;
  const snap = JSON.stringify([rowOf(db, 's1'), musicKeys(r2), pending(db)]);
  const visit = async (method, path, body, headers = {}) => {
    const r = await worker.fetch(new Request(BASE + path, { method, headers: { 'content-type': 'audio/mpeg', ...headers }, body }), env);
    return r.status;
  };
  for (const root of [`/api/share/${token}`, `/api/s/${token}`]) {
    for (const [method, path] of [
      ['GET', 'songs/s1/music'], ['GET', 'songs/s1/music/stream'], ['GET', `music/${m.id}/stream`], ['GET', `music/${m.id}`],
      ['PUT', 'songs/s1/music'], ['DELETE', 'songs/s1/music'], ['POST', 'songs/s1/music'],
    ]) {
      const body = method === 'PUT' || method === 'POST' ? bytes(10) : undefined;
      const status = await visit(method, `${root}/${path}`, body, body ? { 'content-length': '10' } : {});
      assert.ok([401, 403, 404, 405].includes(status), `${method} ${root}/${path} → ${status}`);
    }
    // 分享頁的資料裡沒有音樂
    const data = await worker.fetch(new Request(`${BASE}${root}/data`), env);
    if (data.status === 200) {
      const text = JSON.stringify(await data.json());
      assert.doesNotMatch(text, /music|streamUrl.*sm_|sm_[0-9a-f]{16}/i);
    }
  }
  // 分享連結的 token 不是登入身分：帶著專案網址也進不去
  assert.equal(await visit('PUT', `${P}/songs/s1/music`, bytes(10), { 'content-length': '10' }), 401);
  assert.equal(await visit('DELETE', `${P}/songs/s1/music`), 401);
  // 音樂的播放網址只有成員聽得到：分享連結拿到的網址（沒登入、沒通行證）→ 401
  assert.equal(await visit('GET', `/api/music/${m.id}/stream`), 401);
  assert.equal(JSON.stringify([rowOf(db, 's1'), musicKeys(r2), pending(db)]), snap);
});

test('複製專案 / 匯出不帶音樂（音樂是這一場的）；複製專案不會讓複製出來的歌指到同一個檔案', async () => {
  const { db, r2, put, admin } = await setup();
  await put('u_dir', `${P}/songs/s1/music`, bytes(100));
  const dup = await admin('POST', `${P}/duplicate`, {});
  assert.ok(dup.status === 200 || dup.status === 201, JSON.stringify(dup.data));
  assert.equal(db.raw.prepare(`SELECT COUNT(*) n FROM song_music`).get().n, 1);
  assert.equal(musicKeys(r2).length, 1);
  const exp = await admin('GET', `${P}/export`);
  assert.equal(exp.status, 200);
  assert.doesNotMatch(JSON.stringify(exp.data), /sm_[0-9a-f]{16}/);
});
