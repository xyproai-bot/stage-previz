// 跑法：cd cf-worker && npm test
// 分享連結的訪客聽歌曲的音樂（migration 0049 的 song_music；API 文件 docs/music-api.md 的「分享連結」）。
//   走真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1 + 記憶體假 R2），寫法跟 shareProtection.test.mjs 一樣。
//   保護要跟分享頁的影片完全一樣：連結不存在 / 撤銷 / 過期 / 專案封存 / 沒密碼 / 密碼錯，都拿不到；
//   禁止下載的連結要有綁這條連結 + 這首音樂的播放通行證；只分享一首歌的連結只拿得到那首歌的；別的專案的拿不到；
//   成員的通行證和分享的通行證完全分開。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, applyMigrations, freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import { signSharePlay, verifySharePlay, decideShareStream, playTokenMissingMessage, PLAY_TOKEN_MISSING_MESSAGE, SHARE_PLAY_BUCKET_MS } from './shareMedia.mjs';
import { shareMusicMediaId, shareMusicSummary, shareMusicScope } from './songMusic.mjs';
import worker from './worker.js';

const BASE = 'https://proxy.test';
const SECRET = 'test-secret';
const MUSIC_A = new Uint8Array(Array.from({ length: 64 }, (_, i) => i));          // s1 的音樂
const MUSIC_B = new Uint8Array(Array.from({ length: 48 }, (_, i) => 200 - i));    // s2 的音樂
const MUSIC_Z = new Uint8Array(Array.from({ length: 32 }, (_, i) => 100 + i));    // 另一個專案 p2 的音樂
const VIDEO_BYTES = new Uint8Array(Array.from({ length: 64 }, (_, i) => 255 - i));

async function setup({ before0049 = false } = {}) {
  const db = before0049 ? (() => { const d = new D1Sqlite(); applyMigrations(d, { before: '0049' }); return d; })() : freshDb();
  const users = [
    ['u_admin', '製作', 'admin', 'ADMIN-1'], ['u_dir', '王導', 'director', 'DIR-1'], ['u_a1', '阿凱', 'animator', 'ANI-1'],
    ['u_dir2', '別組導演', 'director', 'DIR-2'],
  ];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, `${id}@studio.example.com`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '金馬'), ('p2', '另一個專案')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director'), ('p1', 'u_a1', 'animator'), ('p2', 'u_dir2', 'director')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, code) VALUES ('s1', 'p1', '開場', 0, 'in_review', 'S01')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, code) VALUES ('s2', 'p1', '安可', 1, 'todo', 'S02')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, code) VALUES ('s3', 'p1', '沒有音樂的歌', 2, 'todo', 'S03')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, code) VALUES ('z1', 'p2', '別專案的歌', 0, 'todo', 'Z01')`),
    db.prepare(`INSERT INTO song_videos (id, project_id, song_id, version, title, source, r2_key, mime, size_bytes, status, created_by, ready_at)
                VALUES ('sv_1', 'p1', 's1', 1, 'V1', 'upload', 'videos/p1/s1/sv_1.mp4', 'video/mp4', 64, 'ready', 'u_a1', '2026-10-14T00:00:00.000Z')`),
  ]);
  const r2 = memoryR2();
  await r2.put('videos/p1/s1/sv_1.mp4', VIDEO_BYTES, { httpMetadata: { contentType: 'video/mp4' } });
  const env = { DB: db, AUTH_SECRET: SECRET, MODELS: r2 };
  if (!before0049) {
    const add = async (songId, projectId, id, bytes, { filename, dur = 215.5, mime = 'audio/mpeg' } = {}) => {
      const key = `music/${projectId}/${songId}/${id}.mp3`;
      await r2.put(key, bytes, { httpMetadata: { contentType: mime } });
      await db.prepare(
        `INSERT INTO song_music (song_id, project_id, id, r2_key, filename, mime, size_bytes, duration_sec, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'u_dir', '2026-10-30T00:00:00.000Z')`
      ).bind(songId, projectId, id, key, filename ?? `${id}.mp3`, mime, bytes.byteLength, dur).run();
      return key;
    };
    await add('s1', 'p1', 'sm_aaaaaaaaaaaaaaa1', MUSIC_A, { filename: 'S01 開場.mp3', dur: 215.5 });
    await add('s2', 'p1', 'sm_bbbbbbbbbbbbbbb2', MUSIC_B, { filename: 'S02 安可.mp3', dur: 98.25 });
    await add('z1', 'p2', 'sm_zzzzzzzzzzzzzzz9', MUSIC_Z, { filename: 'Z01.mp3', dur: 60 });
  }
  const tokens = {};
  for (const [id, , , code] of users) {
    const r = await worker.fetch(new Request(`${BASE}/api/auth/login`, {
      method: 'POST', body: JSON.stringify({ accessCode: code }), headers: { 'content-type': 'application/json' },
    }), env);
    tokens[id] = (await r.json()).token;
  }
  const call = async (who, method, path, body, extraHeaders = {}) => {
    const headers = { 'content-type': 'application/json', ...extraHeaders };
    if (who) headers.authorization = `Bearer ${tokens[who]}`;
    const r = await worker.fetch(new Request(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
    let data = null;
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data, res: r };
  };
  const bytesOf = async (res) => [...new Uint8Array(await res.arrayBuffer())];
  /** 建分享連結（導演建） */
  const makeLink = async (body = {}, who = 'u_dir', project = 'p1') => {
    const r = await call(who, 'POST', `/api/projects/${project}/share-links`, body);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data;
  };
  /** 成員身分直接打（上傳音樂用）：body 是 Uint8Array */
  const memberPut = (who, path, bytes, type = 'audio/mpeg') => worker.fetch(new Request(BASE + path, {
    method: 'PUT', headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': type, 'content-length': String(bytes.byteLength) }, body: bytes,
  }), env);
  return { db, env, r2, call, bytesOf, makeLink, memberPut };
}

const A = 'sm_aaaaaaaaaaaaaaa1';
const B = 'sm_bbbbbbbbbbbbbbb2';
const Z = 'sm_zzzzzzzzzzzzzzz9';
const streamPath = (token, id = A) => `/api/share/${token}/song-music/${id}/stream`;
const queryOf = (url) => new URL(url, BASE).searchParams;
const touched = (r2) => r2.calls.get + r2.calls.head;
/** 這條連結上這首歌的音樂（含播放網址） */
const musicOf = async (call, token, songId = 's1', headers = {}) => (await call(null, 'GET', `/api/share/${token}/songs/${songId}/music`, undefined, headers));

// ─── 純判斷 ───

test('播放通行證：音樂的 id 前面加 music:，跟影片分開；訊息可以寫「影片」或「音樂」', async () => {
  const now = Date.UTC(2026, 9, 30, 6, 0, 0);
  assert.equal(shareMusicMediaId('sm_1'), 'music:sm_1');
  const t = await signSharePlay(SECRET, { linkToken: 'tk_a', mediaId: shareMusicMediaId('sm_1'), now });
  assert.equal(await verifySharePlay(SECRET, t, { linkToken: 'tk_a', mediaId: shareMusicMediaId('sm_1'), now }), true);
  // 同一個 id 的影片拿不到音樂的通行證，反過來也是
  assert.equal(await verifySharePlay(SECRET, t, { linkToken: 'tk_a', mediaId: 'sm_1', now }), false);
  const v = await signSharePlay(SECRET, { linkToken: 'tk_a', mediaId: 'sm_1', now });
  assert.equal(await verifySharePlay(SECRET, v, { linkToken: 'tk_a', mediaId: shareMusicMediaId('sm_1'), now }), false);
  // 換連結 / 換首 / 過期都不行
  assert.equal(await verifySharePlay(SECRET, t, { linkToken: 'tk_b', mediaId: shareMusicMediaId('sm_1'), now }), false);
  assert.equal(await verifySharePlay(SECRET, t, { linkToken: 'tk_a', mediaId: shareMusicMediaId('sm_2'), now }), false);
  assert.equal(await verifySharePlay(SECRET, t, { linkToken: 'tk_a', mediaId: shareMusicMediaId('sm_1'), now: now + 3 * SHARE_PLAY_BUCKET_MS }), false);
  // 沒開禁止下載不用通行證；開了沒帶 → 401，訊息跟著「音樂」
  assert.deepEqual(await decideShareStream(SECRET, { noDownload: false, playToken: '', linkToken: 'tk_a', mediaId: 'music:sm_1', now, noun: '音樂' }), { ok: true });
  const none = await decideShareStream(SECRET, { noDownload: true, playToken: '', linkToken: 'tk_a', mediaId: 'music:sm_1', now, noun: '音樂' });
  assert.equal(none.status, 401);
  assert.match(none.error, /下載音樂/);
  assert.doesNotMatch(none.error, /影片/);
  // 沒給 noun = 影片（原本的行為不變）
  assert.equal(playTokenMissingMessage(), PLAY_TOKEN_MISSING_MESSAGE);
  assert.match((await decideShareStream(SECRET, { noDownload: true, playToken: '', linkToken: 'tk_a', mediaId: 'sv_1', now })).error, /下載影片/);
});

test('給訪客看的簡述只有 id / 檔名 / 類型 / 大小 / 長度；範圍判斷：別的專案 404、只分享一首的連結拿別首 403', () => {
  const row = { id: 'sm_1', song_id: 's1', project_id: 'p1', r2_key: 'music/p1/s1/sm_1.mp3', filename: '歌.mp3', mime: 'audio/mpeg', size_bytes: 10, duration_sec: 3, uploaded_by: 'u_x', uploaded_at: 't' };
  assert.deepEqual(shareMusicSummary(row), { id: 'sm_1', filename: '歌.mp3', mime: 'audio/mpeg', sizeBytes: 10, durationSec: 3 });
  assert.equal(shareMusicSummary(null), null);
  assert.deepEqual(shareMusicSummary({ ...row, size_bytes: undefined, duration_sec: undefined }), { id: 'sm_1', filename: '歌.mp3', mime: 'audio/mpeg', sizeBytes: null, durationSec: null });
  assert.deepEqual(shareMusicScope({ project_id: 'p1', song_id: null }, row), { ok: true });
  assert.deepEqual(shareMusicScope({ project_id: 'p1', song_id: 's1' }, row), { ok: true });
  assert.equal(shareMusicScope({ project_id: 'p1', song_id: 's2' }, row).status, 403);
  assert.equal(shareMusicScope({ project_id: 'p2', song_id: null }, row).status, 404);
  assert.equal(shareMusicScope({ project_id: 'p1', song_id: null }, null).status, 404);
  assert.equal(shareMusicScope({ project_id: 'p1', song_id: null }, undefined).status, 404);
});

// ─── 分享頁的資料 ───

test('分享頁的資料：每首歌帶 hasMusic 和音樂簡述（檔名 / 長度 / 大小），沒有音樂的歌是 false / null；沒有 R2 位置、播放網址、誰傳的；舊的欄位都還在', async () => {
  const { call, makeLink } = await setup();
  const link = await makeLink({});
  const r = await call(null, 'GET', `/api/share/${link.token}/data`);
  assert.equal(r.status, 200);
  const byId = Object.fromEntries(r.data.songs.map(s => [s.id, s]));
  assert.deepEqual(byId.s1.music, { id: A, filename: 'S01 開場.mp3', mime: 'audio/mpeg', sizeBytes: 64, durationSec: 215.5 });
  assert.equal(byId.s1.hasMusic, true);
  assert.deepEqual(byId.s2.music, { id: B, filename: 'S02 安可.mp3', mime: 'audio/mpeg', sizeBytes: 48, durationSec: 98.25 });
  assert.deepEqual([byId.s3.hasMusic, byId.s3.music], [false, null]);
  // 另一個專案的音樂不會出現
  assert.ok(!JSON.stringify(r.data).includes(Z));
  assert.ok(!r.data.songs.some(s => s.id === 'z1'));
  // 沒有 R2 位置、播放網址、誰傳的、上傳時間
  const text = JSON.stringify(r.data.songs.map(s => s.music));
  assert.doesNotMatch(text, /r2_key|music\/p1|streamUrl|uploadedBy|uploadedAt|u_dir|pass=|play=/);
  // 舊版前端讀的欄位都還在（多的兩個欄位它忽略）
  assert.equal(byId.s1.code, 'S01');
  assert.equal(byId.s1.name, '開場');
  assert.ok(byId.s1.latestVideo?.streamUrl.startsWith(`/api/share/${link.token}/song-videos/sv_1/stream`));
  assert.equal(byId.s3.latestVideo, null);
  for (const k of ['project', 'songs', 'stageObjects', 'restrictedToSongId', 'protection', 'allowComments', 'mechanisms', 'modelUrl']) assert.ok(k in r.data, k);
});

test('migration 0049 還沒套（後台先上線）：分享頁照常，每首歌沒有音樂，要音樂的路回 { music: null }', async () => {
  const { call, makeLink, db } = await setup({ before0049: true });
  assert.equal(db.raw.prepare(`SELECT name FROM sqlite_master WHERE name = 'song_music'`).get(), undefined);
  const link = await makeLink({ noDownload: false });
  const r = await call(null, 'GET', `/api/share/${link.token}/data`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.songs.map(s => [s.id, s.hasMusic, s.music]), [['s1', false, null], ['s2', false, null], ['s3', false, null]]);
  assert.deepEqual((await musicOf(call, link.token, 's1')).data, { music: null });
  assert.equal((await call(null, 'GET', streamPath(link.token))).status, 404);
});

test('只分享一首歌的連結：資料裡只有那一首歌的音樂；問別首歌的音樂 403；整個專案的連結什麼都看得到', async () => {
  const { call, makeLink } = await setup();
  const one = await makeLink({ songId: 's1' });
  const data = (await call(null, 'GET', `/api/share/${one.token}/data`)).data;
  assert.equal(data.restrictedToSongId, 's1');
  assert.deepEqual(data.songs.map(s => [s.id, s.music?.id ?? null]), [['s1', A]]);
  assert.ok(!JSON.stringify(data).includes(B), '別首歌的音樂 id 不會出現');
  assert.equal((await musicOf(call, one.token, 's1')).status, 200);
  const other = await musicOf(call, one.token, 's2');
  assert.equal(other.status, 403);
  assert.ok(!JSON.stringify(other.data).includes(B));
  assert.equal((await musicOf(call, one.token, 's3')).status, 403);
  // 別的專案的歌：404
  assert.equal((await musicOf(call, one.token, 'z1')).status, 403);
  const all = await makeLink({});
  assert.equal((await musicOf(call, all.token, 's2')).data.music.id, B);
  assert.equal((await musicOf(call, all.token, 'z1')).status, 404);
});

// ─── 播放（禁止下載的連結：預設）───

test('禁止下載的連結：music 給的播放網址帶播放通行證；播得到（Range、HEAD）；沒有音樂的歌 { music: null }；回應裡沒有 R2 位置', async () => {
  const { call, r2, bytesOf, makeLink } = await setup();
  const link = await makeLink({ noDownload: true, watermark: true });
  const m = await musicOf(call, link.token, 's1');
  assert.equal(m.status, 200);
  const { streamUrl, ...rest } = m.data.music;
  assert.deepEqual(rest, { id: A, filename: 'S01 開場.mp3', mime: 'audio/mpeg', sizeBytes: 64, durationSec: 215.5 });
  assert.ok(streamUrl.startsWith(streamPath(link.token)), streamUrl);
  assert.ok(queryOf(streamUrl).get('play'), '有播放通行證');
  assert.equal(queryOf(streamUrl).get('access'), null, '沒密碼的連結沒有密碼通行證');
  assert.ok(!JSON.stringify(m.data).includes('music/p1/'));
  assert.deepEqual((await musicOf(call, link.token, 's3')).data, { music: null });

  let r = await call(null, 'GET', streamUrl);
  assert.equal(r.status, 200);
  assert.deepEqual(await bytesOf(r.res), [...MUSIC_A]);
  assert.equal(r.res.headers.get('content-type'), 'audio/mpeg');
  assert.equal(r.res.headers.get('cache-control'), 'private, no-store');
  assert.equal(r.res.headers.get('content-disposition'), 'inline');
  assert.equal(r.res.headers.get('accept-ranges'), 'bytes');
  r = await call(null, 'GET', streamUrl, undefined, { range: 'bytes=10-19' });
  assert.equal(r.status, 206);
  assert.deepEqual(await bytesOf(r.res), [...MUSIC_A.slice(10, 20)]);
  assert.equal(r.res.headers.get('content-range'), 'bytes 10-19/64');
  r = await call(null, 'HEAD', streamUrl);
  assert.equal(r.status, 200);
  assert.equal(r.res.headers.get('content-length'), '64');
  r = await call(null, 'GET', streamUrl, undefined, { range: 'bytes=500-600' });
  assert.equal(r.status, 416);
});

test('禁止下載的連結：沒通行證 / 亂寫 / 改過 / 別首音樂的 / 別條連結的 / 影片的 / 過期的 / 成員的通行證，一律 401，而且不碰 R2', async () => {
  const { call, r2, env, makeLink } = await setup();
  const link = await makeLink({ noDownload: true });
  const link2 = await makeLink({ noDownload: true });
  const url = (await musicOf(call, link.token, 's1')).data.music.streamUrl;
  const play = queryOf(url).get('play');
  const before = touched(r2);

  const bad = [
    streamPath(link.token),
    `${streamPath(link.token)}?play=`,
    `${streamPath(link.token)}?play=abc`,
    `${streamPath(link.token)}?play=${play}x`,
    // 別首音樂：拿 A 的通行證聽 B
    `${streamPath(link.token, B)}?play=${encodeURIComponent(play)}`,
    // 別條連結：拿這條的通行證開另一條
    `${streamPath(link2.token)}?play=${encodeURIComponent(play)}`,
  ];
  for (const p of bad) {
    const x = await call(null, 'GET', p);
    assert.equal(x.status, 401, p);
    assert.ok(x.data.error, p);
  }
  assert.match((await call(null, 'GET', streamPath(link.token))).data.error, /下載音樂/);
  assert.equal((await call(null, 'HEAD', streamPath(link.token))).status, 401);
  // 影片的通行證（綁影片 id）聽不了音樂；音樂的通行證看不了影片
  const videoPlay = await signSharePlay(SECRET, { linkToken: link.token, mediaId: 'sv_1' });
  assert.equal((await call(null, 'GET', `${streamPath(link.token)}?play=${encodeURIComponent(videoPlay)}`)).status, 401);
  const asVideoId = await signSharePlay(SECRET, { linkToken: link.token, mediaId: A });   // 沒加 music: 的
  assert.equal((await call(null, 'GET', `${streamPath(link.token)}?play=${encodeURIComponent(asVideoId)}`)).status, 401);
  assert.equal((await call(null, 'GET', `/api/share/${link.token}/song-videos/sv_1/stream?play=${encodeURIComponent(play)}`)).status, 401);
  // 過期的（簽在很久以前）
  const old = await signSharePlay(env.AUTH_SECRET, { linkToken: link.token, mediaId: shareMusicMediaId(A), now: Date.now() - 3 * SHARE_PLAY_BUCKET_MS });
  const expired = await call(null, 'GET', `${streamPath(link.token)}?play=${encodeURIComponent(old)}`);
  assert.equal(expired.status, 401);
  assert.equal(expired.data.passExpired, true);
  // 別的密鑰簽的
  const forged = await signSharePlay('other-secret', { linkToken: link.token, mediaId: shareMusicMediaId(A) });
  assert.equal((await call(null, 'GET', `${streamPath(link.token)}?play=${encodeURIComponent(forged)}`)).status, 401);
  assert.equal(touched(r2), before, '被拒絕的請求完全沒碰 R2');
  // 直接猜 R2 的路徑也拿不到（/r2/ 只放模型和模型庫）
  assert.equal((await call(null, 'GET', `/r2/music/p1/s1/${A}.mp3`)).status, 404);
});

test('成員的通行證和分享的通行證完全分開：成員的播放網址聽不了分享、分享的播放網址聽不了成員的、也不能拿去聽別的專案', async () => {
  const { call, makeLink, r2 } = await setup();
  const link = await makeLink({ noDownload: true });
  const shareUrl = (await musicOf(call, link.token, 's1')).data.music.streamUrl;
  const sharePlay = queryOf(shareUrl).get('play');
  const member = await call('u_dir', 'GET', '/api/projects/p1/songs/s1/music');
  assert.equal(member.status, 200);
  const memberUrl = member.data.music.streamUrl;           // /api/music/<id>/stream?pass=…
  const memberPass = queryOf(memberUrl).get('pass');
  assert.ok(memberUrl.startsWith(`/api/music/${A}/stream`));
  const before = touched(r2);

  // 成員的通行證拿到分享網址上 → 沒有播放通行證
  assert.equal((await call(null, 'GET', `${streamPath(link.token)}?pass=${encodeURIComponent(memberPass)}`)).status, 401);
  assert.equal((await call(null, 'GET', `${streamPath(link.token)}?play=${encodeURIComponent(memberPass)}`)).status, 401);
  // 分享的播放通行證 / 密碼通行證拿到成員的網址上 → 沒登入身分
  for (const q of [`pass=${encodeURIComponent(sharePlay)}`, `play=${encodeURIComponent(sharePlay)}`, `access=${encodeURIComponent(sharePlay)}`, '']) {
    const x = await call(null, 'GET', `/api/music/${A}/stream?${q}`);
    assert.equal(x.status, 401, q);
  }
  // 分享網址在成員的路徑上也不通（成員的路徑要登入）
  assert.equal((await call(null, 'GET', `/api/projects/p1/songs/s1/music/stream?play=${encodeURIComponent(sharePlay)}`)).status, 401);
  assert.equal((await call(null, 'GET', `/api/projects/p1/songs/s1/music`)).status, 401);
  assert.equal(touched(r2), before);
  // 別組的導演（只在 p2）的成員網址也聽不了 p1 的音樂（原本就是這樣，這裡確認分享沒有開洞）
  const otherMember = await call('u_dir2', 'GET', '/api/projects/p2/songs/z1/music');
  assert.equal((await call(null, 'GET', `/api/music/${A}/stream?pass=${encodeURIComponent(queryOf(otherMember.data.music.streamUrl).get('pass'))}`)).status, 401);
});

// ─── 播放（沒開禁止下載）───

test('沒開禁止下載的連結：播放網址沒有 play、不用通行證就能播、可以快取（跟影片一樣）；舊連結（兩個都是 0）一樣', async () => {
  const { call, bytesOf, makeLink, db } = await setup();
  const link = await makeLink({ noDownload: false, watermark: false });
  const m = await musicOf(call, link.token, 's1');
  assert.equal(m.data.music.streamUrl, streamPath(link.token));
  const r = await call(null, 'GET', m.data.music.streamUrl);
  assert.equal(r.status, 200);
  assert.deepEqual(await bytesOf(r.res), [...MUSIC_A]);
  assert.match(r.res.headers.get('cache-control'), /immutable/);
  assert.match(r.res.headers.get('cache-control'), /private/);
  // 0038 以前建的連結（浮水印、禁止下載都是 0）
  await db.prepare(`INSERT INTO share_links (token, project_id, label) VALUES ('tk_legacy_0000000000000000000000', 'p1', '舊連結')`).run();
  const tk = 'tk_legacy_0000000000000000000000';
  assert.equal((await musicOf(call, tk, 's2')).data.music.streamUrl, streamPath(tk, B));
  assert.deepEqual(await bytesOf((await call(null, 'GET', streamPath(tk, B))).res), [...MUSIC_B]);
  // 改成禁止下載，馬上生效
  await call('u_dir', 'PATCH', `/api/projects/p1/share-links/${link.token}`, { noDownload: true });
  assert.equal((await call(null, 'GET', streamPath(link.token))).status, 401);
  assert.ok(queryOf((await musicOf(call, link.token, 's1')).data.music.streamUrl).get('play'));
});

// ─── 密碼 ───

test('有密碼的連結：沒帶密碼 / 密碼錯 / 沒通行證 / 別條連結的通行證都拿不到；密碼對了才聽得到；好讀網址同時帶 access 和 play', async () => {
  const { call, bytesOf, makeLink, r2 } = await setup();
  const link = await makeLink({ password: 'sesame', slug: 'jinma-wm', noDownload: true });
  const other = await makeLink({ password: 'other-pass', slug: 'other-wm', noDownload: true });
  const before = touched(r2);

  // 沒帶密碼：資料、音樂、播放網址都 401
  for (const p of [`/api/s/jinma-wm/data`, `/api/s/jinma-wm/songs/s1/music`, `/api/s/jinma-wm/song-music/${A}/stream`, `/api/share/${link.token}/songs/s1/music`]) {
    const x = await call(null, 'GET', p);
    assert.equal(x.status, 401, p);
    assert.equal(x.data.requiresPassword, true, p);
  }
  // 密碼錯
  for (const p of [`/api/s/jinma-wm/data`, `/api/s/jinma-wm/songs/s1/music`, `/api/s/jinma-wm/song-music/${A}/stream`]) {
    const x = await call(null, 'GET', p, undefined, { 'x-share-password': 'wrong' });
    assert.equal(x.status, 401, p);
  }

  // 密碼對 → 拿通行證
  let r = await call(null, 'GET', '/api/s/jinma-wm/data', undefined, { 'x-share-password': 'sesame' });
  assert.equal(r.status, 200, r.data?.error);
  const access = r.data.access.token;
  assert.ok(access);
  assert.equal(r.data.songs.find(s => s.id === 's1').music.id, A);
  // 用通行證要播放網址（不再送密碼）
  r = await call(null, 'GET', '/api/s/jinma-wm/songs/s1/music', undefined, { 'x-share-access': access });
  assert.equal(r.status, 200);
  const url = r.data.music.streamUrl;
  assert.ok(url.startsWith(`/api/s/jinma-wm/song-music/${A}/stream?`), '用好讀網址開的人，網址裡沒有連結碼');
  assert.ok(!url.includes(link.token));
  const q = queryOf(url);
  assert.equal(q.get('access'), access);
  assert.ok(q.get('play'));
  r = await call(null, 'GET', url);
  assert.equal(r.status, 200);
  assert.deepEqual(await bytesOf(r.res), [...MUSIC_A]);
  // 只有 access、沒有 play
  assert.equal((await call(null, 'GET', `/api/s/jinma-wm/song-music/${A}/stream?access=${encodeURIComponent(access)}`)).status, 401);
  // 只有 play、沒有 access
  assert.equal((await call(null, 'GET', `/api/s/jinma-wm/song-music/${A}/stream?play=${encodeURIComponent(q.get('play'))}`)).status, 401);
  // 亂寫的 / 改過的 access
  assert.equal((await call(null, 'GET', `${url}x`)).status, 401);
  assert.equal((await call(null, 'GET', url.replace('access=', 'access=zz'))).status, 401);
  // 別條連結（別的密碼）的通行證：拿去開這條 → 401；
  const otherAccess = (await call(null, 'GET', '/api/s/other-wm/data', undefined, { 'x-share-password': 'other-pass' })).data.access.token;
  assert.ok(otherAccess && otherAccess !== access);
  assert.equal((await call(null, 'GET', `/api/s/jinma-wm/song-music/${A}/stream?access=${encodeURIComponent(otherAccess)}&play=${encodeURIComponent(q.get('play'))}`)).status, 401);
  assert.equal((await call(null, 'GET', '/api/s/jinma-wm/songs/s1/music', undefined, { 'x-share-access': otherAccess })).status, 401);
  assert.equal((await call(null, 'GET', `/api/share/${link.token}/songs/s1/music`, undefined, { 'x-share-access': otherAccess })).status, 401);
  // 舊版前端每個請求都帶密碼：播放請求帶密碼 header 一樣可以（還是要有 play）
  assert.equal((await call(null, 'GET', `/api/s/jinma-wm/song-music/${A}/stream?play=${encodeURIComponent(q.get('play'))}`, undefined, { 'x-share-password': 'sesame' })).status, 200);
  assert.ok(touched(r2) > before);
});

test('有密碼、沒開禁止下載：網址只帶 access；拿不到 access 就聽不了', async () => {
  const { call, bytesOf, makeLink } = await setup();
  const link = await makeLink({ password: 'sesame', noDownload: false });
  const access = (await call(null, 'GET', `/api/share/${link.token}/data`, undefined, { 'x-share-password': 'sesame' })).data.access.token;
  const url = (await musicOf(call, link.token, 's1', { 'x-share-access': access })).data.music.streamUrl;
  assert.equal(url, `${streamPath(link.token)}?access=${encodeURIComponent(access)}`);
  assert.deepEqual(await bytesOf((await call(null, 'GET', url)).res), [...MUSIC_A]);
  assert.equal((await call(null, 'GET', streamPath(link.token))).status, 401);
  // 密碼換掉之後，舊的通行證馬上失效
  await call('u_dir', 'PATCH', `/api/projects/p1/share-links/${link.token}`, { password: 'new-pass' });
  assert.equal((await call(null, 'GET', url)).status, 401);
  assert.equal((await call(null, 'GET', `/api/share/${link.token}/songs/s1/music`, undefined, { 'x-share-access': access })).status, 401);
});

// ─── 撤銷 / 過期 / 封存 ───

test('撤銷的連結：資料、音樂、播放全部 404', async () => {
  const { call, makeLink, r2 } = await setup();
  const link = await makeLink({ noDownload: false });
  const url = (await musicOf(call, link.token, 's1')).data.music.streamUrl;
  assert.equal((await call(null, 'GET', url)).status, 200);
  const del = await call('u_dir', 'DELETE', `/api/projects/p1/share-links/${link.token}`);
  assert.equal(del.status, 200);
  const before = touched(r2);
  for (const p of [url, `/api/share/${link.token}/data`, `/api/share/${link.token}/songs/s1/music`]) {
    assert.equal((await call(null, 'GET', p)).status, 404, p);
  }
  assert.equal((await call(null, 'HEAD', url)).status, 404);
  assert.equal(touched(r2), before);
});

test('過期的連結：資料、音樂、播放全部 410', async () => {
  const { call, makeLink, db, r2 } = await setup();
  const link = await makeLink({ noDownload: false, expiresInDays: 7 });
  const url = (await musicOf(call, link.token, 's1')).data.music.streamUrl;
  assert.equal((await call(null, 'GET', url)).status, 200);
  await db.prepare(`UPDATE share_links SET expires_at = ? WHERE token = ?`).bind(new Date(Date.now() - 3600_000).toISOString(), link.token).run();
  const before = touched(r2);
  for (const p of [url, `/api/share/${link.token}/data`, `/api/share/${link.token}/songs/s1/music`]) {
    assert.equal((await call(null, 'GET', p)).status, 410, p);
  }
  assert.equal(touched(r2), before);
  // 禁止下載的連結過期，連有效的播放通行證也不行
  const link2 = await makeLink({ noDownload: true, expiresInDays: 7 });
  const url2 = (await musicOf(call, link2.token, 's1')).data.music.streamUrl;
  await db.prepare(`UPDATE share_links SET expires_at = ? WHERE token = ?`).bind(new Date(Date.now() - 1000).toISOString(), link2.token).run();
  assert.equal((await call(null, 'GET', url2)).status, 410);
});

test('專案封存：資料、音樂、播放全部 404（還原後恢復）', async () => {
  const { call, makeLink, db, r2 } = await setup();
  const link = await makeLink({ noDownload: false });
  const url = (await musicOf(call, link.token, 's1')).data.music.streamUrl;
  await db.prepare(`UPDATE projects SET status = 'archived' WHERE id = 'p1'`).run();
  const before = touched(r2);
  for (const p of [url, `/api/share/${link.token}/data`, `/api/share/${link.token}/songs/s1/music`]) {
    assert.equal((await call(null, 'GET', p)).status, 404, p);
  }
  assert.equal(touched(r2), before);
  await db.prepare(`UPDATE projects SET status = 'active' WHERE id = 'p1'`).run();
  assert.equal((await call(null, 'GET', url)).status, 200);
});

// ─── 分享範圍 / 別的專案 ───

test('只分享一首歌的連結：別首歌的音樂播不到（連有效的播放通行證都不行）；別的專案的音樂 404', async () => {
  const { call, makeLink, r2 } = await setup();
  const one = await makeLink({ songId: 's1', noDownload: true });
  const url = (await musicOf(call, one.token, 's1')).data.music.streamUrl;
  assert.equal((await call(null, 'GET', url)).status, 200);
  // 這條連結自己簽出來的 B（s2）的播放通行證也不行：範圍擋在通行證後面
  const playB = await signSharePlay(SECRET, { linkToken: one.token, mediaId: shareMusicMediaId(B) });
  const denied = await call(null, 'GET', `${streamPath(one.token, B)}?play=${encodeURIComponent(playB)}`);
  assert.equal(denied.status, 403);
  assert.match(denied.data.error, /不在分享範圍/);
  // 沒開禁止下載的一首歌連結也一樣
  const open = await makeLink({ songId: 's1', noDownload: false });
  assert.equal((await call(null, 'GET', streamPath(open.token, A))).status, 200);
  assert.equal((await call(null, 'GET', streamPath(open.token, B))).status, 403);
  // 別的專案（p2）的音樂：404，不管連結是整個專案還是一首歌
  const whole = await makeLink({ noDownload: false });
  const before = touched(r2);
  assert.equal((await call(null, 'GET', streamPath(whole.token, Z))).status, 404);
  assert.equal((await call(null, 'GET', streamPath(open.token, Z))).status, 404);
  const playZ = await signSharePlay(SECRET, { linkToken: one.token, mediaId: shareMusicMediaId(Z) });
  assert.equal((await call(null, 'GET', `${streamPath(one.token, Z)}?play=${encodeURIComponent(playZ)}`)).status, 404);
  assert.equal(touched(r2), before, '範圍不對的請求沒碰 R2');
  // 不存在的音樂 / 格式不對的 id
  assert.equal((await call(null, 'GET', streamPath(whole.token, 'sm_nope'))).status, 404);
  assert.equal((await call(null, 'GET', `/api/share/${whole.token}/song-music/${'x'.repeat(80)}/stream`)).status, 404);
});

test('別的專案的連結拿不到這個專案的音樂，這個專案的連結也拿不到別的專案的（通行證 / 連結碼都不能混著用）', async () => {
  const { call, makeLink } = await setup();
  const p1 = await makeLink({ noDownload: true });
  const p2 = await makeLink({ noDownload: true, password: 'p2-pass' }, 'u_dir2', 'p2');
  // p2 的連結：自己的音樂 Z 聽得到（資料裡也只有 p2 的歌）
  const access = (await call(null, 'GET', `/api/share/${p2.token}/data`, undefined, { 'x-share-password': 'p2-pass' })).data;
  assert.deepEqual(access.songs.map(s => [s.id, s.music?.id]), [['z1', Z]]);
  const zUrl = (await musicOf(call, p2.token, 'z1', { 'x-share-access': access.access.token })).data.music.streamUrl;
  assert.equal((await call(null, 'GET', zUrl)).status, 200);
  // p2 的連結 + p2 的通行證 + p2 簽的播放通行證 → 開 p1 的音樂 A：404
  const playAWithP2 = await signSharePlay(SECRET, { linkToken: p2.token, mediaId: shareMusicMediaId(A) });
  assert.equal((await call(null, 'GET', `${streamPath(p2.token, A)}?access=${encodeURIComponent(access.access.token)}&play=${encodeURIComponent(playAWithP2)}`)).status, 404);
  // p2 的通行證 / 播放通行證拿去開 p1 的連結 → 401
  const p1Url = (await musicOf(call, p1.token, 's1')).data.music.streamUrl;
  const playOfP1 = queryOf(p1Url).get('play');
  assert.equal((await call(null, 'GET', `${streamPath(p1.token, A)}?play=${encodeURIComponent(queryOf(zUrl).get('play'))}`)).status, 401);
  assert.equal((await call(null, 'GET', `${streamPath(p2.token, Z)}?access=${encodeURIComponent(access.access.token)}&play=${encodeURIComponent(playOfP1)}`)).status, 401);
  // p1 的連結問 p2 的歌：404
  assert.equal((await musicOf(call, p1.token, 'z1')).status, 404);
  // 連結碼和好讀網址名稱不混：用 /api/s/<連結碼> 查不到
  assert.equal((await call(null, 'GET', `/api/s/${p1.token}/songs/s1/music`)).status, 404);
});

// ─── 其他 ───

test('音樂換掉之後：資料和 music 是新的，舊的播放網址失效；音樂拿掉之後 { music: null }、播放 404；R2 檔案不見 → 404', async () => {
  const { call, makeLink, db, r2, memberPut } = await setup();
  const link = await makeLink({ noDownload: false });
  const oldUrl = (await musicOf(call, link.token, 's1')).data.music.streamUrl;
  assert.equal((await call(null, 'GET', oldUrl)).status, 200);
  // 導演換成新的音樂
  const up = await memberPut('u_dir', '/api/projects/p1/songs/s1/music?filename=new.mp3&durationSec=10', new Uint8Array(20).fill(9));
  assert.equal(up.status, 200, await up.clone().text());
  const fresh = (await musicOf(call, link.token, 's1')).data.music;
  assert.notEqual(fresh.id, A);
  assert.equal(fresh.filename, 'new.mp3');
  assert.equal((await call(null, 'GET', fresh.streamUrl)).status, 200);
  assert.equal((await call(null, 'GET', oldUrl)).status, 404, '舊的音樂已經換掉');
  assert.equal((await call(null, 'GET', `/api/share/${link.token}/data`)).data.songs.find(s => s.id === 's1').music.id, fresh.id);
  // 拿掉音樂
  db.raw.prepare(`DELETE FROM song_music WHERE song_id = 's1'`).run();
  assert.deepEqual((await musicOf(call, link.token, 's1')).data, { music: null });
  assert.deepEqual((await call(null, 'GET', `/api/share/${link.token}/data`)).data.songs.find(s => s.id === 's1').hasMusic, false);
  assert.equal((await call(null, 'GET', fresh.streamUrl)).status, 404);
  // 資料還在、R2 檔案不見了 → 說找不到音樂檔（不是影片）
  assert.equal((await call(null, 'GET', streamPath(link.token, B))).status, 200);
  await r2.delete(`music/p1/s2/${B}.mp3`);
  const gone = await call(null, 'GET', streamPath(link.token, B));
  assert.equal(gone.status, 404);
  assert.match(gone.data.error, /音樂檔/);
});

test('聽音樂不算瀏覽次數（只有 data 算）；不改任何資料；訪客不能用成員的路改音樂', async () => {
  const { call, makeLink, db, r2, env } = await setup();
  const link = await makeLink({ noDownload: false });
  const viewCount = () => db.raw.prepare(`SELECT view_count n FROM share_links WHERE token = ?`).get(link.token).n;
  assert.equal(viewCount(), 0);
  const url = (await musicOf(call, link.token, 's1')).data.music.streamUrl;
  await call(null, 'GET', url);
  await call(null, 'HEAD', url);
  assert.equal(viewCount(), 0);
  await call(null, 'GET', `/api/share/${link.token}/data`);
  assert.equal(viewCount(), 1);
  const snap = JSON.stringify([db.raw.prepare(`SELECT * FROM song_music ORDER BY song_id`).all(), r2.keys(), db.raw.prepare(`SELECT r2_key FROM r2_pending_deletes`).all()]);
  // 沒登入的成員路徑：上傳 / 移除 401
  const put = await worker.fetch(new Request(`${BASE}/api/projects/p1/songs/s1/music?filename=x.mp3`, { method: 'PUT', headers: { 'content-type': 'audio/mpeg', 'content-length': '5' }, body: new Uint8Array(5) }), env);
  assert.equal(put.status, 401);
  assert.equal((await call(null, 'DELETE', '/api/projects/p1/songs/s1/music')).status, 401);
  assert.equal(JSON.stringify([db.raw.prepare(`SELECT * FROM song_music ORDER BY song_id`).all(), r2.keys(), db.raw.prepare(`SELECT r2_key FROM r2_pending_deletes`).all()]), snap);
});

test('舊連結（沒有音樂功能時建的）和有影片的歌：資料照舊、影片網址不變，音樂只是多出來的欄位', async () => {
  const { call, makeLink } = await setup();
  const link = await makeLink({ noDownload: false });
  const data = (await call(null, 'GET', `/api/share/${link.token}/data`)).data;
  const s1 = data.songs.find(s => s.id === 's1');
  assert.equal(s1.latestVideo.streamUrl, `/api/share/${link.token}/song-videos/sv_1/stream`);
  assert.equal(s1.music.id, A, '有影片的歌也帶音樂簡述（放哪個是前端的規則：有影片放影片）');
  const versions = (await call(null, 'GET', `/api/share/${link.token}/songs/s1/versions`)).data;
  assert.equal(versions.latestVideoId, 'sv_1');
  assert.equal((await call(null, 'GET', `/api/share/${link.token}/song-videos/sv_1/stream`)).status, 200);
});
