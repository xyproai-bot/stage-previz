// 跑法：cd cf-worker && npm test
// 貼圖（貼在 3D 畫面上的參考圖片）：存在畫記（annotation）裡，跟筆畫同一層。不用 migration。
//   純判斷：格式 / 夾進範圍 / 同一張只能貼一次 / 上限 / 只能用這則留言自己的圖片 / 拿掉圖片連貼圖一起拿掉
//   走真的 worker 路由：團隊和訪客發留言帶貼圖、別人的圖片不行、改留言拿掉圖片、舊版前端（只有筆畫）照樣能用
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './testing/d1-sqlite.mjs';
import { memoryR2 } from './testing/r2-memory.mjs';
import worker from './worker.js';
import {
  sanitizeAnnotation, commentExtrasInput, checkAnnotationImages, pruneAnnotationImages, annotationHasContent, rowToComment,
  sanitizeComment, commentToRow,
} from './comments.mjs';
import { ATTACHMENT_ID_RE } from '../web/src/lib/review/attachmentRules.ts';
import { MAX_ANN_IMAGES, STICKER_ID_RE } from '../web/src/lib/review/stickerRules.ts';

const A = 'ca_aaaaaaaa11112222';
const B = 'ca_bbbbbbbb33334444';
const sticker = (id, extra = {}) => ({ type: 'image', attachmentId: id, x: 0.5, y: 0.5, w: 0.3, h: 0.4, rot: 0, opacity: 0.7, ...extra });
const arrow = { t: 'arrow', c: '#ff3b30', w: 0.006, p: [0.1, 0.2, 0.5, 0.5] };

test('貼圖的 id 規則跟附件的一樣（兩個檔案各有一份，這裡對一下）', () => {
  assert.equal(STICKER_ID_RE.source, ATTACHMENT_ID_RE.source);
  assert.equal(MAX_ANN_IMAGES, 4);
});

test('畫記裡的貼圖：只有貼圖也算有畫記；數字夾在範圍裡；格式不對 / 同一張貼兩次 / 太多張 → 擋下來', () => {
  // 只有貼圖、沒有筆畫（shapes 空陣列或沒帶都可以）
  let r = sanitizeAnnotation({ v: 1, aspect: 1.7778, shapes: [], images: [sticker(A)] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.shapes, []);
  assert.deepEqual(r.value.images, [sticker(A)]);
  assert.equal(sanitizeAnnotation({ v: 1, aspect: 1.5, images: [sticker(A)] }).ok, true);
  // 筆畫和貼圖一起；沒有貼圖的畫記不多 images 這個欄位（格式跟以前一樣）
  r = sanitizeAnnotation({ v: 1, aspect: 1.5, shapes: [arrow], images: [sticker(A), sticker(B, { x: 0.2 })] });
  assert.equal(r.value.shapes.length, 1);
  assert.equal(r.value.images.length, 2);
  assert.equal('images' in sanitizeAnnotation({ v: 1, aspect: 1.5, shapes: [arrow] }).value, false);
  assert.equal('images' in sanitizeAnnotation({ v: 1, aspect: 1.5, shapes: [arrow], images: [] }).value, false);
  // 什麼都沒有 = 沒有畫記
  assert.deepEqual(sanitizeAnnotation({ v: 1, aspect: 1.5, shapes: [], images: [] }), { ok: true, value: null });
  assert.deepEqual(sanitizeAnnotation({ v: 1, aspect: 1.5, shapes: [] }), { ok: true, value: null });
  // 什麼欄位都沒有 → 格式不對（跟以前一樣）
  assert.equal(sanitizeAnnotation({ v: 1, aspect: 1.5 }).ok, false);
  assert.equal(sanitizeAnnotation({ v: 1, aspect: 1.5, shapes: [], images: 'x' }).ok, false);

  // 數字：位置夾在 0~1、大小夾在 0.02~2、不透明度 0.05~1、角度整理成 -180~180、四捨五入
  r = sanitizeAnnotation({ v: 1, aspect: 1.5, images: [sticker(A, { x: -3, y: 9, w: 0.00001, h: 50, rot: 190, opacity: 0 })] });
  assert.deepEqual(r.value.images[0], sticker(A, { x: 0, y: 1, w: 0.02, h: 2, rot: -170, opacity: 0.05 }));
  r = sanitizeAnnotation({ v: 1, aspect: 1.5, images: [sticker(A, { x: 0.123456, rot: 725.5, opacity: 0.66666 })] });
  assert.equal(r.value.images[0].x, 0.1235);
  assert.equal(r.value.images[0].rot, 5.5);
  assert.equal(r.value.images[0].opacity, 0.667);

  // 壞掉的：不是圖片貼圖、id 不對、少了數字、數字是字串、同一張貼兩次
  for (const bad of [
    { ...sticker(A), type: 'text' }, { ...sticker(A), attachmentId: 'x' }, { ...sticker(A), attachmentId: 'ca_SHORT' },
    { ...sticker(A), x: undefined }, { ...sticker(A), rot: '30' }, { ...sticker(A), opacity: NaN }, null, 'str', [],
  ]) {
    assert.equal(sanitizeAnnotation({ v: 1, aspect: 1.5, images: [bad] }).ok, false, JSON.stringify(bad));
  }
  assert.match(sanitizeAnnotation({ v: 1, aspect: 1.5, images: [sticker(A), sticker(A, { x: 0.1 })] }).error, /貼圖/);
  const five = Array.from({ length: MAX_ANN_IMAGES + 1 }, (_, i) => sticker(`ca_${String(i).repeat(10)}`));
  assert.match(sanitizeAnnotation({ v: 1, aspect: 1.5, images: five }).error, /最多 4 張/);
  assert.equal(sanitizeAnnotation({ v: 1, aspect: 99, images: [sticker(A)] }).ok, false);   // 畫面比例還是要合理
  // 帶到留言：貼圖壞掉 → 整則擋下來
  assert.equal(commentExtrasInput({ time: 1, annotation: { v: 1, aspect: 1.5, images: [{ ...sticker(A), type: 'x' }] } }).ok, false);
  assert.equal(commentExtrasInput({ time: 1, annotation: { v: 1, aspect: 1.5, images: [sticker(A)] } }).extras.annotation.images.length, 1);
});

test('貼圖只能用這則留言自己的圖片；改留言拿掉圖片，貼圖一起拿掉（筆畫不動）', () => {
  const ann = sanitizeAnnotation({ v: 1, aspect: 1.5, shapes: [arrow], images: [sticker(A), sticker(B)] }).value;
  assert.deepEqual(checkAnnotationImages(ann, [A, B]), { ok: true });
  assert.deepEqual(checkAnnotationImages(ann, [A, B, 'ca_cccccccc55556666']), { ok: true });
  assert.equal(checkAnnotationImages(ann, [A]).ok, false);
  assert.equal(checkAnnotationImages(ann, []).ok, false);
  assert.equal(checkAnnotationImages(ann, undefined).ok, false);
  assert.deepEqual(checkAnnotationImages(null, []), { ok: true });                    // 沒有畫記
  assert.deepEqual(checkAnnotationImages({ shapes: [arrow] }, []), { ok: true });     // 只有筆畫

  assert.equal(pruneAnnotationImages(ann, [A, B]), ann);                              // 沒有要拿的 = 同一個物件
  const one = pruneAnnotationImages(ann, [B]);
  assert.deepEqual(one.images.map(i => i.attachmentId), [B]);
  assert.equal(one.shapes.length, 1);
  const noImg = pruneAnnotationImages(ann, []);
  assert.equal('images' in noImg, false);
  assert.equal(noImg.shapes.length, 1);
  // 只有貼圖、拿光了 → 沒有畫記
  const only = sanitizeAnnotation({ v: 1, aspect: 1.5, images: [sticker(A)] }).value;
  assert.equal(pruneAnnotationImages(only, []), null);
  assert.equal(pruneAnnotationImages(null, []), null);
  assert.equal(annotationHasContent(only), true);
  assert.equal(annotationHasContent({ shapes: [] }), false);
});

test('存進資料庫再讀出來：只有貼圖的畫記也在；只有筆畫的畫記格式不變', () => {
  const base = { id: 'c_st1', text: '對照這張', author: 'Phang', role: 'director', time: 3, createdAt: '2026-10-14T01:02:03.000Z' };
  const onlyImg = { ...sanitizeComment(base), ...commentExtrasInput({ time: 3, annotation: { v: 1, aspect: 1.5, images: [sticker(A)] } }).extras };
  const back = rowToComment({ ...commentToRow(onlyImg), project_id: 'p', song_id: 's' });
  assert.deepEqual(back.annotation.shapes, []);
  assert.deepEqual(back.annotation.images, [sticker(A)]);
  const onlyPen = { ...sanitizeComment(base), ...commentExtrasInput({ time: 3, annotation: { v: 1, aspect: 1.5, shapes: [arrow] } }).extras };
  const pen = rowToComment({ ...commentToRow(onlyPen), project_id: 'p', song_id: 's' });
  assert.equal('images' in pen.annotation, false);
  // 資料庫裡是空的畫記 → 不放
  const empty = rowToComment({ ...commentToRow(sanitizeComment(base)), project_id: 'p', song_id: 's', annotation_json: JSON.stringify({ v: 1, aspect: 1.5, shapes: [], images: [] }) });
  assert.equal('annotation' in empty, false);
});

// ─── 走真的路由 ───

const BASE = 'https://proxy.test';
function png(w, h) {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
async function setup() {
  const db = freshDb();
  const users = [['u_admin', '製作', 'admin', 'ADMIN-1'], ['u_dir', '王導', 'director', 'DIR-1'], ['u_a1', '阿凱', 'animator', 'ANI-1']];
  await db.batch(users.map(([id, name, role, code]) => db.prepare(
    `INSERT INTO users (id, email, name, role, access_code) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, `${id}@x.test`, name, role, code)));
  await db.batch([
    db.prepare(`INSERT INTO projects (id, name) VALUES ('p1', '金馬')`),
    db.prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES ('p1', 'u_dir', 'director'), ('p1', 'u_a1', 'animator')`),
    db.prepare(`INSERT INTO songs (id, project_id, name, "order", status, animator_user_id, code) VALUES ('s1', 'p1', '開場', 0, 'in_review', 'u_a1', 'S01')`),
  ]);
  const env = { DB: db, AUTH_SECRET: 'test-secret', MODELS: memoryR2() };
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
    return { status: r.status, data };
  };
  const call = (who, method, path, body, headers = {}) => send(who, method, path, {
    headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const upload = (who, path, file, headers = {}) => {
    const form = new FormData();
    form.append('file', new Blob([file]), 'x');
    return send(who, 'POST', path, { body: form, headers });
  };
  return { call, upload };
}

const UP = '/api/comment-attachments?session=p1-s1';
const COMMENTS = '/api/comments?session=p1-s1';
let n = 0;
const cid = () => `c_stk${++n}`;
const ann = (images, shapes = []) => ({ v: 1, aspect: 1.7778, shapes, images });

test('團隊發留言帶貼圖：只能用這則留言自己的圖片；舊版前端（只有筆畫、沒有圖片）照樣能用', async () => {
  const { call, upload } = await setup();
  const a = (await upload('u_dir', UP, png(800, 600))).data.attachment;
  const b = (await upload('u_dir', UP, png(801, 600))).data.attachment;
  const other = (await upload('u_a1', UP, png(802, 600))).data.attachment;

  // 貼圖用的圖片沒有一起送出 / 是別人的 / 根本不存在 → 400
  let r = await call('u_dir', 'POST', COMMENTS, { comment: { id: cid(), text: '看這裡', attachmentIds: [a.id], annotation: ann([sticker(b.id)]) } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /貼圖用的圖片/);
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: cid(), text: 'x', attachmentIds: [a.id], annotation: ann([sticker(other.id)]) } });
  assert.equal(r.status, 400);
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: cid(), text: 'x', annotation: ann([sticker(a.id)]) } });   // 沒帶 attachmentIds
  assert.equal(r.status, 400);
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: cid(), text: 'x', attachmentIds: [a.id], annotation: ann([sticker('ca_nonexistent12345')]) } });
  assert.equal(r.status, 400);
  // 沒有失敗的留言留下來，圖片也還沒被掛走
  r = await call('u_dir', 'GET', COMMENTS);
  assert.equal(r.data.comments.length, 0);

  // 成功：只有貼圖（還有圖片）→ 讀回來貼圖都在，位置照存
  const id = cid();
  r = await call('u_dir', 'POST', COMMENTS, {
    comment: {
      id, text: '', time: 12, attachmentIds: [a.id, b.id],
      view: { position: [1, 2, 3], target: [0, 1, 0], fov: 45, aspect: 1.7778 },
      annotation: ann([sticker(a.id, { x: 0.3, y: 0.4, w: 0.25, h: 0.3, rot: 15, opacity: 0.55 }), sticker(b.id, { x: 0.8 })]),
    },
  });
  assert.equal(r.status, 200, r.data?.error);
  const c = r.data.comments.find(x => x.id === id);
  assert.equal(c.attachments.length, 2);
  assert.equal(c.annotation.shapes.length, 0);
  assert.deepEqual(c.annotation.images[0], sticker(a.id, { x: 0.3, y: 0.4, w: 0.25, h: 0.3, rot: 15, opacity: 0.55 }));
  assert.equal(c.annotation.aspect, 1.7778);
  assert.equal(c.view.fov, 45);
  // 重新讀（reload）也一樣
  r = await call('u_dir', 'GET', COMMENTS);
  assert.equal(r.data.comments.find(x => x.id === id).annotation.images.length, 2);

  // 舊版前端：筆畫 + 沒有 images → 跟以前一樣，沒有多餘欄位
  const old = cid();
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: old, text: '舊版畫記', time: 3, annotation: { v: 1, aspect: 1.7778, shapes: [arrow] } } });
  assert.equal(r.status, 200, r.data?.error);
  const oc = r.data.comments.find(x => x.id === old);
  assert.equal(oc.annotation.shapes.length, 1);
  assert.equal('images' in oc.annotation, false);
});

test('改留言拿掉圖片：貼圖一起拿掉（筆畫留著）；只有貼圖的畫記拿光就沒有畫記；舊版只改字不動', async () => {
  const { call, upload } = await setup();
  const a = (await upload('u_dir', UP, png(800, 600))).data.attachment;
  const b = (await upload('u_dir', UP, png(801, 600))).data.attachment;
  const id = cid();
  let r = await call('u_dir', 'POST', COMMENTS, {
    comment: { id, text: '兩張', attachmentIds: [a.id, b.id], annotation: ann([sticker(a.id), sticker(b.id)], [arrow]) },
  });
  assert.equal(r.status, 200, r.data?.error);
  // 舊版前端只改字 → 貼圖不動
  r = await call('u_dir', 'PATCH', COMMENTS, { id, text: '只改字' });
  assert.equal(r.data.comments.find(x => x.id === id).annotation.images.length, 2);
  // 拿掉 a → 只剩 b 的貼圖，筆畫還在
  r = await call('u_dir', 'PATCH', COMMENTS, { id, attachmentIds: [b.id] });
  assert.equal(r.status, 200, r.data?.error);
  let c = r.data.comments.find(x => x.id === id);
  assert.deepEqual(c.annotation.images.map(i => i.attachmentId), [b.id]);
  assert.equal(c.annotation.shapes.length, 1);

  // 只有貼圖的留言，圖片換成別張 → 沒有畫記了
  const id2 = cid();
  const x = (await upload('u_dir', UP, png(900, 600))).data.attachment;
  const y = (await upload('u_dir', UP, png(901, 600))).data.attachment;
  r = await call('u_dir', 'POST', COMMENTS, { comment: { id: id2, text: '', attachmentIds: [x.id], annotation: ann([sticker(x.id)]) } });
  assert.equal(r.status, 200, r.data?.error);
  r = await call('u_dir', 'PATCH', COMMENTS, { id: id2, attachmentIds: [y.id] });
  assert.equal(r.status, 200, r.data?.error);
  c = r.data.comments.find(q => q.id === id2);
  assert.equal('annotation' in c, false);
  assert.equal(c.attachments.length, 1);
});

test('訪客發留言帶貼圖：最多 2 張、只能用自己傳的；團隊和訪客都看得到', async () => {
  const { call, upload } = await setup();
  const ip = { 'cf-connecting-ip': '198.51.100.7' };
  const tk = (await call('u_admin', 'POST', '/api/projects/p1/share-links', { allowComments: true, label: '給客戶' })).data.token;
  const G = `/api/share/${tk}/songs/s1`;
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await upload(null, `${G}/comment-attachments`, png(500 + i, 300), ip);
    assert.equal(r.status, 200, r.data?.error);
    ids.push(r.data.attachment.id);
  }
  // 3 張圖片 → 圖片數量就先擋了
  let r = await call(null, 'POST', `${G}/comments`, { guestName: '小李', comment: { id: cid(), text: 'x', attachmentIds: ids, annotation: ann(ids.map(i => sticker(i))) } }, ip);
  assert.equal(r.status, 400);
  // 貼圖用沒送出的那張 → 400
  r = await call(null, 'POST', `${G}/comments`, { guestName: '小李', comment: { id: cid(), text: 'x', attachmentIds: [ids[0]], annotation: ann([sticker(ids[1])]) } }, ip);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /貼圖用的圖片/);
  // 團隊傳的圖片，訪客不能貼
  const team = (await upload('u_dir', UP, png(100, 100))).data.attachment.id;
  r = await call(null, 'POST', `${G}/comments`, { guestName: '小李', comment: { id: cid(), text: 'x', attachmentIds: [ids[0]], annotation: ann([sticker(team)]) } }, ip);
  assert.equal(r.status, 400);

  const gid = cid();
  r = await call(null, 'POST', `${G}/comments`, {
    guestName: '小李',
    comment: { id: gid, text: '照這張調', time: 8, attachmentIds: [ids[0], ids[1]], annotation: ann([sticker(ids[0], { opacity: 0.5 }), sticker(ids[1], { x: 0.2, rot: -30 })]) },
  }, ip);
  assert.equal(r.status, 200, r.data?.error);
  const mine = r.data.comments.find(x => x.id === gid);
  assert.equal(mine.annotation.images.length, 2);
  assert.equal(mine.annotation.images[1].rot, -30);
  assert.equal(mine.attachments.length, 2);
  // 團隊那邊也看得到
  r = await call('u_dir', 'GET', COMMENTS);
  const seen = r.data.comments.find(x => x.id === gid);
  assert.deepEqual(seen.annotation.images.map(i => i.attachmentId), [ids[0], ids[1]]);
});
