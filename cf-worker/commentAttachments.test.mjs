// 跑法：cd cf-worker && npm test
// 留言的參考圖片（0028）走一遍真的 worker 路由（worker.js 的 fetch + node:sqlite 假 D1 + 記憶體假 R2）：
//   上傳（誰可以、類型 / 大小 / 尺寸）、看圖（不用登入、快取、nosniff）、掛到留言上（只有圖片也可以、張數、別人的不行）、
//   改留言拿掉 / 加圖片（檔案一起刪）、刪留言 / 刪歌 / 沒送出的排程清掉、訪客（2 張、每天額度）、舊版前端照樣能用、migration。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Sqlite, applyMigrations, freshDb, migrationFiles } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import { sniffImage, IMAGE_ONLY_TEXT } from '../web/src/lib/review/attachmentRules.ts';
import { cleanupPendingAttachments, planAttachmentEdit, attachmentKeyFromPath, attachmentUrlFor } from './commentAttachments.mjs';
import { guestUploadQuotaDecision, GUEST_UPLOAD_IP_DAILY } from './guestComments.mjs';

const BASE = 'https://proxy.test';

// ─── 假圖片（後台只看檔案開頭，不用真的能解開） ───
function png(w, h) {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
function jpeg(w, h) {
  // SOI、APP0（JFIF）、APP1（假的 EXIF，前面有一大段）、SOF0、EOI
  const app1 = new Uint8Array(4 + 300); app1.set([0xff, 0xe1, 0x01, 0x2e]);
  const head = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9];
  return new Uint8Array([...head, ...app1, ...sof]);
}
function gif(w, h) {
  const b = new Uint8Array(32);
  b.set([...'GIF89a'].map(c => c.charCodeAt(0)));
  b[6] = w & 255; b[7] = w >> 8; b[8] = h & 255; b[9] = h >> 8;
  return b;
}
function webp(w, h) {
  const b = new Uint8Array(40);
  const s = (i, str) => b.set([...str].map(c => c.charCodeAt(0)), i);
  s(0, 'RIFF'); s(8, 'WEBP'); s(12, 'VP8X'); b[16] = 10;
  const W = w - 1, H = h - 1;
  b[24] = W & 255; b[25] = (W >> 8) & 255; b[26] = (W >> 16) & 255;
  b[27] = H & 255; b[28] = (H >> 8) & 255; b[29] = (H >> 16) & 255;
  return b;
}

async function setup() {
  const db = freshDb();
  const users = [
    ['u_admin', '製作', 'admin', 'ADMIN-1'], ['u_dir', '王導', 'director', 'DIR-1'],
    ['u_a1', '阿凱', 'animator', 'ANI-1'], ['u_a2', '小美', 'animator', 'ANI-2'],
  ];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, `${id}@x.test`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '金馬')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director'), ('p1', 'u_a1', 'animator'), ('p1', 'u_a2', 'animator')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, animator_user_id, code) VALUES ('s1', 'p1', '開場', 0, 'in_review', 'u_a1', 'S01')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, code) VALUES ('s2', 'p1', '安可', 1, 'todo', 'S02')`),
  ]);
  const r2 = memoryR2();
  const env = { DB: db, AUTH_SECRET: 'test-secret', MODELS: r2 };
  const tokens = {};
  for (const [id, , , code] of users) {
    const r = await worker.fetch(new Request(`${BASE}/api/auth/login`, {
      method: 'POST', body: JSON.stringify({ accessCode: code }), headers: { 'content-type': 'application/json' },
    }), env);
    tokens[id] = (await r.json()).token;
  }
  const send = async (who, method, path, init = {}) => {
    const headers = { ...(init.headers || {}) };
    if (who) headers.authorization = `Bearer ${tokens[who]}`;
    const r = await worker.fetch(new Request(BASE + path, { method, headers, body: init.body }), env);
    let data = null;
    try { data = await r.clone().json(); } catch { /* 不是 JSON */ }
    return { status: r.status, data, res: r };
  };
  const call = (who, method, path, body, headers = {}) => send(who, method, path, {
    headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  /** 上傳一張（multipart：file + thumb） */
  const upload = (who, path, file, { thumb = null, headers = {} } = {}) => {
    const form = new FormData();
    form.append('file', new Blob([file]), 'x');
    if (thumb) form.append('thumb', new Blob([thumb]), 't');
    return send(who, 'POST', path, { body: form, headers });
  };
  return { db, env, r2, call, upload, send };
}

const UP = '/api/comment-attachments?session=p1-s1';
const COMMENTS = '/api/comments?session=p1-s1';
let n = 0;
const cid = () => `c_att${++n}`;
const imageKeys = (r2) => r2.keys().filter(k => k.startsWith('comment-attachments/'));

test('看檔案開頭判斷圖片類型和尺寸（PNG / JPEG / GIF / WebP）；SVG、HEIC、亂碼不收', () => {
  assert.deepEqual(sniffImage(png(1920, 1080)), { type: 'image/png', width: 1920, height: 1080 });
  assert.deepEqual(sniffImage(jpeg(2560, 1440)), { type: 'image/jpeg', width: 2560, height: 1440 });
  assert.deepEqual(sniffImage(gif(480, 270)), { type: 'image/gif', width: 480, height: 270 });
  assert.deepEqual(sniffImage(webp(3000, 2000)), { type: 'image/webp', width: 3000, height: 2000 });
  assert.equal(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(sniffImage(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0])), null);  // HEIC
  assert.equal(sniffImage(png(0, 10)), null);
  assert.equal(sniffImage(new Uint8Array(4)), null);
  // 網址 ↔ R2 位置
  const key = 'comment-attachments/p1/0123456789abcdef0123456789abcdef.png';
  assert.equal(attachmentKeyFromPath(attachmentUrlFor(key)), key);
  assert.equal(attachmentKeyFromPath('/api/comment-attachments/p1/../../models/x.glb'), null);
  assert.equal(attachmentUrlFor('comment-thumbs/p1/c-0123.jpg'), null);
  assert.deepEqual(planAttachmentEdit([{ id: 'a' }, { id: 'b' }], ['b', 'c']).remove, [{ id: 'a' }]);
});

test('migration 0028：舊留言都還在、加了圖片的表；舊版 worker 寫留言照樣能寫', async () => {
  assert.ok(migrationFiles().includes('0028_comment_attachments.sql'));
  const db = new D1Sqlite();
  applyMigrations(db, { before: '0028' });
  await db.batch([
    db.prepare(`INSERT INTO users (id, email, name, role) VALUES ('u_x', 'x@x.test', 'X', 'director')`),
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p', 'P')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order") VALUES ('s', 'p', 'S', 0)`),
    db.prepare(`INSERT INTO comments (id, project_id, song_id, time_in_video, text, author_name, author_role, created_at, thumb_key)
                VALUES ('c_old', 'p', 's', 3, '舊留言', 'X', 'director', '2026-10-01T00:00:00.000Z', 'comment-thumbs/p/c_old-x.jpg')`),
  ]);
  applyMigrations(db, { only: '0028' });
  const c = await db.prepare(`SELECT * FROM comments WHERE id = 'c_old'`).first();
  assert.equal(c.text, '舊留言');
  assert.equal(c.thumb_key, 'comment-thumbs/p/c_old-x.jpg');
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM comment_attachments`).first()).n, 0);
  // 舊版 worker 的 INSERT（0026 的欄位）照樣能寫
  await db.prepare(`INSERT INTO comments (id, project_id, song_id, time_in_video, text, author_name, author_role, created_at)
                    VALUES ('c_new', 'p', 's', 0, '新', 'X', 'director', '2026-10-02T00:00:00.000Z')`).run();
  // 刪歌 → 圖片那一列跟著刪（ON DELETE CASCADE）
  await db.prepare(`INSERT INTO comment_attachments (id, project_id, song_id, comment_id, r2_key, mime, size, created_at)
                    VALUES ('ca_test0001', 'p', 's', 'c_new', 'comment-attachments/p/x.png', 'image/png', 10, '2026-10-02T00:00:00.000Z')`).run();
  await db.prepare(`DELETE FROM comments WHERE id = 'c_new'`).run();
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM comment_attachments`).first()).n, 0);
});

test('團隊上傳：跟發留言一樣的人可以傳；類型、大小、尺寸不對說清楚；看圖不用登入、可以快取、不讓瀏覽器猜類型', async () => {
  const { upload, send, r2 } = await setup();
  let r = await upload(null, UP, png(800, 600));
  assert.equal(r.status, 401);
  // 小美（動畫師）不是這首歌的負責人 → 跟留言一樣不行
  r = await upload('u_a2', UP, png(800, 600));
  assert.equal(r.status, 403);
  assert.match(r.data.error, /指派給其他動畫師/);
  // SVG / 假圖片 → 415
  r = await upload('u_dir', UP, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
  assert.equal(r.status, 415);
  assert.match(r.data.error, /PNG、JPEG、WebP、GIF/);
  // 沒縮過的大圖（長邊 > 4096）
  r = await upload('u_dir', UP, png(6000, 4000));
  assert.equal(r.status, 400);
  assert.match(r.data.error, /尺寸太大/);
  // 超過 15 MB
  const big = new Uint8Array(15 * 1024 * 1024 + 10); big.set(png(100, 100));
  r = await upload('u_dir', UP, big);
  assert.equal(r.status, 413);
  assert.equal(imageKeys(r2).length, 0);

  // 可以：導演、負責的動畫師、製作；GIF 原樣（大一點的尺寸也收）
  for (const [who, file, type] of [['u_dir', png(1920, 1080), 'image/png'], ['u_a1', jpeg(2560, 1440), 'image/jpeg'], ['u_admin', gif(6000, 300), 'image/gif'], ['u_dir', webp(1200, 800), 'image/webp']]) {
    r = await upload(who, UP, file, { thumb: jpeg(480, 270) });
    assert.equal(r.status, 200, `${who}: ${r.data?.error}`);
    assert.equal(r.data.attachment.type, type);
    assert.match(r.data.attachment.id, /^ca_[a-z0-9]+$/);
    assert.match(r.data.attachment.url, /^\/api\/comment-attachments\/p1\/[0-9a-f]{32}\.(png|jpg|gif|webp)$/);
    assert.match(r.data.attachment.thumbUrl, /^\/api\/comment-attachments\/p1\/[0-9a-f]{32}-t\.jpg$/);
  }
  assert.equal(imageKeys(r2).length, 8);   // 4 張 + 4 張小縮圖

  // 看圖：不用登入；類型照副檔名；快取一年；nosniff
  r = await upload('u_dir', UP, png(640, 360));
  const img = await send(null, 'GET', r.data.attachment.url);
  assert.equal(img.status, 200);
  assert.equal(img.res.headers.get('content-type'), 'image/png');
  assert.match(img.res.headers.get('cache-control'), /immutable/);
  assert.equal(img.res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal('thumbUrl' in r.data.attachment, false);   // 沒送小縮圖 → 清單用原圖
  assert.deepEqual([...new Uint8Array(await img.res.arrayBuffer())], [...png(640, 360)]);
  assert.equal((await send(null, 'GET', '/api/comment-attachments/p1/0123456789abcdef0123456789abcdef.png')).status, 404);
  assert.equal((await send(null, 'GET', '/api/comment-attachments/p1/x.svg')).status, 404);
});

test('掛到留言上：只有圖片也可以（舊版畫面看到「（圖片）」）、最多 4 張、別人傳的 / 別首歌的 / 已經用過的不行；通知寫「（圖片）」', async () => {
  const { upload, call } = await setup();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await upload('u_dir', UP, png(800 + i, 600))).data.attachment.id);
  let r = await call('u_dir', 'POST', COMMENTS, { comment: { id: cid(), text: '五張', attachmentIds: ids } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /最多 4 張/);
  // 阿凱傳的，導演不能拿來用
  const other = (await upload('u_a1', UP, png(100, 100))).data.attachment.id;
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: cid(), text: 'x', attachmentIds: [other] } });
  assert.equal(r.status, 400);
  // 別首歌傳的
  const s2img = (await upload('u_dir', '/api/comment-attachments?session=p1-s2', png(100, 100))).data.attachment.id;
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: cid(), text: 'x', attachmentIds: [s2img] } });
  assert.equal(r.status, 400);
  // 沒字也沒圖 → 不行
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: cid(), text: '  ', attachmentIds: [] } });
  assert.equal(r.status, 400);

  // 只有圖片：照順序；text =「（圖片）」+ noText
  const root = cid();
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: root, text: '', attachmentIds: [ids[2], ids[0]] } });
  assert.equal(r.status, 200, r.data?.error);
  const c = r.data.comments.find(x => x.id === root);
  assert.equal(c.text, IMAGE_ONLY_TEXT);
  assert.equal(c.noText, true);
  assert.deepEqual(c.attachments.map(a => a.id), [ids[2], ids[0]]);
  assert.equal(c.attachments[0].width, 802);
  // 網路重送（同一個 id、同樣的圖片）→ 不重複、不擋
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: root, text: '', attachmentIds: [ids[2], ids[0]] } });
  assert.equal(r.status, 200);
  assert.equal(r.data.duplicate, true);
  // 已經在別則留言上的不能再用
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: cid(), text: '再用一次', attachmentIds: [ids[0]] } });
  assert.equal(r.status, 400);

  // 阿凱用圖片回覆 → 導演收到「（圖片）」
  const a1img = (await upload('u_a1', UP, jpeg(1280, 720))).data.attachment.id;
  const reply = cid();
  r = await call('u_a1', 'POST', COMMENTS, { comment: { id: reply, text: '', parentId: root, attachmentIds: [a1img, other] } });
  assert.equal(r.status, 200, r.data?.error);
  const nr = await call('u_dir', 'GET', '/api/notifications');
  const note = nr.data.items.find(x => x.commentId === reply);
  assert.equal(note.kind, 'reply');
  assert.equal(note.excerpt, IMAGE_ONLY_TEXT);

  // 動畫師讀到一樣的；有字的留言 text 照舊（舊版畫面照樣看得到字）
  const withText = cid();
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: withText, text: '參考這張 https://youtu.be/dQw4w9WgXcQ', attachmentIds: [ids[1]] } });
  assert.equal(r.status, 200);
  r = await call('u_a1', 'GET', COMMENTS);
  const t = r.data.comments.find(x => x.id === withText);
  assert.equal(t.text, '參考這張 https://youtu.be/dQw4w9WgXcQ');
  assert.equal('noText' in t, false);
  assert.equal(t.attachments.length, 1);
  // 沒圖片的留言格式跟以前一樣（沒有 attachments 欄位）
  const plain = cid();
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: plain, text: '舊版前端', time: 3, x: 0.5, y: 0.5, email: null, createdAt: new Date().toISOString() } });
  assert.equal(r.status, 200);
  const p = r.data.comments.find(x => x.id === plain);
  assert.equal('attachments' in p, false);
  assert.equal('noText' in p, false);
});

test('改留言：拿掉的圖片連檔案一起刪、加新的、換順序；只有留言的人 / 製作；沒字的留言不能把圖片全拿掉；舊版只改字圖片不動', async () => {
  const { upload, call, send, r2 } = await setup();
  const a = (await upload('u_dir', UP, png(800, 600), { thumb: jpeg(480, 360) })).data.attachment;
  const b = (await upload('u_dir', UP, png(801, 600))).data.attachment;
  const id = cid();
  let r = await call('u_dir', 'POST', COMMENTS, { comment: { id, text: '', attachmentIds: [a.id, b.id] } });
  assert.equal(r.status, 200, r.data?.error);
  assert.equal(imageKeys(r2).length, 3);

  // 別人不能改
  r = await call('u_a1', 'PATCH', COMMENTS, { id, attachmentIds: [b.id] });
  assert.equal(r.status, 403);
  // 全部拿掉、又沒字 → 不行
  r = await call('u_dir', 'PATCH', COMMENTS, { id, attachmentIds: [] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /至少要留一張圖片/);
  // 拿掉 a（含小縮圖）、加 c、b 放後面
  const c = (await upload('u_dir', UP, jpeg(1024, 768))).data.attachment;
  r = await call('u_dir', 'PATCH', COMMENTS, { id, text: '補上說明', attachmentIds: [c.id, b.id] });
  assert.equal(r.status, 200, r.data?.error);
  const after = r.data.comments.find(x => x.id === id);
  assert.equal(after.text, '補上說明');
  assert.deepEqual(after.attachments.map(x => x.id), [c.id, b.id]);
  assert.equal((await send(null, 'GET', a.url)).status, 404);
  assert.equal((await send(null, 'GET', a.thumbUrl)).status, 404);
  assert.equal(imageKeys(r2).length, 2);
  // 舊版前端只改字 → 圖片不動；字清空但還有圖片 → 可以
  r = await call('u_dir', 'PATCH', COMMENTS, { id, text: '只改字' });
  assert.equal(r.data.comments.find(x => x.id === id).attachments.length, 2);
  r = await call('u_dir', 'PATCH', COMMENTS, { id, text: '' });
  assert.equal(r.status, 200, r.data?.error);
  assert.equal(r.data.comments.find(x => x.id === id).noText, true);
  // 製作可以改別人的
  r = await call('u_admin', 'PATCH', COMMENTS, { id, attachmentIds: [b.id] });
  assert.equal(r.status, 200, r.data?.error);
  assert.equal(imageKeys(r2).length, 1);
  // 標已改好不影響圖片
  r = await call('u_a1', 'PATCH', COMMENTS, { id, status: 'resolved' });
  assert.equal(r.status, 200, r.data?.error);
  assert.equal(r.data.comments.find(x => x.id === id).attachments.length, 1);
});

test('刪留言（含底下回覆的圖片）、刪歌（含還沒送出的）、拿掉還沒送出的、排程清掉一天都沒送出的：R2 的檔案都不在了', async () => {
  const { upload, call, db, r2 } = await setup();
  const a = (await upload('u_dir', UP, png(800, 600), { thumb: jpeg(480, 360) })).data.attachment;
  const root = cid();
  await call('u_dir', 'POST', COMMENTS, { comment: { id: root, text: '看這張', attachmentIds: [a.id] } });
  const b = (await upload('u_a1', UP, png(800, 600))).data.attachment;
  let r = await call('u_a1', 'POST', COMMENTS, { comment: { id: cid(), text: '收到', parentId: root, attachmentIds: [b.id] } });
  assert.equal(r.status, 200, r.data?.error);
  assert.equal(imageKeys(r2).length, 3);
  r = await call('u_dir', 'DELETE', `${COMMENTS}&id=${root}`);
  assert.equal(r.status, 200);
  assert.equal(imageKeys(r2).length, 0);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM comment_attachments`).first()).n, 0);

  // 拿掉還沒送出的：自己的可以、別人的不行、已經送出的要改留言
  const p1 = (await upload('u_dir', UP, png(100, 100))).data.attachment;
  r = await call('u_a1', 'DELETE', `${UP}&id=${p1.id}`);
  assert.equal(r.status, 403);
  r = await call('u_dir', 'DELETE', `${UP}&id=${p1.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.removed, true);
  assert.equal(imageKeys(r2).length, 0);

  // 刪歌：留言上的 + 還沒送出的都清
  const s2 = '/api/comment-attachments?session=p1-s2';
  const x = (await upload('u_admin', s2, png(100, 100))).data.attachment;
  await call('u_admin', 'POST', '/api/comments?session=p1-s2', { comment: { id: cid(), text: '安可', attachmentIds: [x.id] } });
  await upload('u_admin', s2, png(100, 100), { thumb: jpeg(100, 100) });
  assert.equal(imageKeys(r2).length, 3);
  r = await call('u_admin', 'DELETE', '/api/projects/p1/songs/s2');
  assert.equal(r.status, 200, r.data?.error);
  await new Promise(res => setTimeout(res, 20));
  assert.equal(imageKeys(r2).length, 0);

  // 排程：一天以前傳、還沒送出的清掉；剛傳的、已經送出的留著
  const old = (await upload('u_dir', UP, png(100, 100))).data.attachment;
  const fresh = (await upload('u_dir', UP, png(101, 100))).data.attachment;
  const sent = (await upload('u_dir', UP, png(102, 100))).data.attachment;
  await call('u_dir', 'POST', COMMENTS, { comment: { id: cid(), text: '', attachmentIds: [sent.id] } });
  await db.prepare(`UPDATE comment_attachments SET created_at = '2026-01-01T00:00:00.000Z' WHERE id IN (?, ?)`).bind(old.id, sent.id).run();
  assert.equal(await cleanupPendingAttachments(db, r2, new Date()), 1);
  const left = (await db.prepare(`SELECT id FROM comment_attachments ORDER BY id`).all()).results.map(r => r.id).sort();
  assert.deepEqual(left, [fresh.id, sent.id].sort());
  assert.equal(imageKeys(r2).length, 2);
});

test('訪客：連結要開留言；一則最多 2 張；看得到自己串的圖片；不能用團隊傳的；每天額度', async () => {
  const { upload, call, r2 } = await setup();
  const ip = { 'cf-connecting-ip': '198.51.100.9' };
  const off = (await call('u_admin', 'POST', '/api/projects/p1/share-links', {})).data.token;
  let r = await upload(null, `/api/share/${off}/songs/s1/comment-attachments`, png(100, 100), { headers: ip });
  assert.equal(r.status, 403);
  assert.equal(r.data.commentsDisabled, true);

  const tk = (await call('u_admin', 'POST', '/api/projects/p1/share-links', { allowComments: true, label: '給客戶' })).data.token;
  const G = `/api/share/${tk}/songs/s1`;
  const ids = [];
  for (let i = 0; i < 3; i++) {
    r = await upload(null, `${G}/comment-attachments`, png(500 + i, 300), { thumb: jpeg(480, 288), headers: ip });
    assert.equal(r.status, 200, r.data?.error);
    ids.push(r.data.attachment.id);
  }
  r = await call(null, 'POST', `${G}/comments`, { guestName: '小李', comment: { id: cid(), text: '三張', attachmentIds: ids } }, ip);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /最多 2 張/);
  // 團隊傳的不能用
  const team = (await upload('u_dir', UP, png(100, 100))).data.attachment.id;
  r = await call(null, 'POST', `${G}/comments`, { guestName: '小李', comment: { id: cid(), text: 'x', attachmentIds: [team] } }, ip);
  assert.equal(r.status, 400);
  // 只有圖片
  const gid = cid();
  r = await call(null, 'POST', `${G}/comments`, { guestName: '小李', comment: { id: gid, text: '', attachmentIds: [ids[0], ids[1]] } }, ip);
  assert.equal(r.status, 200, r.data?.error);
  const mine = r.data.comments.find(x => x.id === gid);
  assert.equal(mine.text, IMAGE_ONLY_TEXT);
  assert.equal(mine.noText, true);
  assert.equal(mine.attachments.length, 2);
  assert.equal(JSON.stringify(mine.attachments).includes('u_'), false);
  // 團隊看到；通知寫「（圖片）」
  r = await call('u_dir', 'GET', COMMENTS);
  assert.equal(r.data.comments.find(x => x.id === gid).attachments.length, 2);
  const note = (await call('u_dir', 'GET', '/api/notifications')).data.items.find(x => x.commentId === gid);
  assert.equal(note.excerpt, IMAGE_ONLY_TEXT);
  // 拿掉還沒送出的那張
  r = await call(null, 'DELETE', `${G}/comment-attachments/${ids[2]}`, undefined, ip);
  assert.equal(r.status, 200);
  assert.equal(r.data.removed, true);
  // 額度：同一個 IP 一天 20 張（上面已經傳了 3 張）
  for (let i = 3; i < GUEST_UPLOAD_IP_DAILY; i++) {
    r = await upload(null, `${G}/comment-attachments`, png(100, 100), { headers: ip });
    assert.equal(r.status, 200, `${i}: ${r.data?.error}`);
  }
  r = await upload(null, `${G}/comment-attachments`, png(100, 100), { headers: ip });
  assert.equal(r.status, 429);
  assert.match(r.data.error, /上限/);
  // 換一個 IP 可以
  r = await upload(null, `${G}/comment-attachments`, png(100, 100), { headers: { 'cf-connecting-ip': '203.0.113.5' } });
  assert.equal(r.status, 200);
  assert.ok(imageKeys(r2).length > 0);

  // 額度的判斷（純函式）：通行證、一條連結
  assert.equal(guestUploadQuotaDecision({ ipCount: 0, passCount: 20, hasPass: true }).ok, false);
  assert.equal(guestUploadQuotaDecision({ ipCount: 0, passCount: 20, hasPass: false }).ok, true);
  assert.equal(guestUploadQuotaDecision({ linkCount: 100 }).ok, false);
});
