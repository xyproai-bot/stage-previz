// 跑法：cd cf-worker && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeComment, commentToRow, rowToComment, commentPatch,
  commentExtrasInput, sanitizeView, sanitizeAnnotation, decodeThumbnail, rowToGuestComment,
  commentThumbKey, thumbUrlFor, thumbKeyFromPath, guestAuthorLabel, MAX_SHAPES, MAX_THUMB_BYTES,
} from './comments.mjs';

const base = {
  id: 'c_abc123', text: '  LED 太亮  ', author: 'Phang', role: 'designer', time: 12.5, x: 0.3, y: 2,
  email: null, createdAt: '2026-10-14T01:02:03.000Z', authorUserId: 'u_phang',
};

test('存進資料庫再讀出來 = 原本整理好的樣子（API 格式不變）', () => {
  const cases = [
    base,
    { ...base, anchor: { type: 'world', world: { x: 1, y: 2, z: 3 } }, mentions: [{ userId: 'u2', name: 'hao' }] },
    { ...base, anchor: { type: 'mesh', meshName: 'LED-1', offset: { x: 0.1, y: 0, z: -1 } } },
    { ...base, anchor: { type: 'mesh', meshName: 'LED-1' } },
    { ...base, anchor: { type: 'screen' } },
    { ...base, status: 'resolved', resolvedBy: 'daoyan', resolvedAt: '2026-10-14T02:00:00.000Z' },
    { ...base, status: 'open', resolvedBy: '', resolvedAt: '' },
  ];
  for (const c of cases) {
    const clean = sanitizeComment(c);
    assert.ok(clean);
    assert.deepEqual(rowToComment({ ...commentToRow(clean), project_id: 'p', song_id: 's' }), clean);
  }
});

test('整理：文字去空白、座標夾在 0~1、壞資料回 null', () => {
  const c = sanitizeComment(base);
  assert.equal(c.text, 'LED 太亮');
  assert.equal(c.y, 1);
  assert.equal(sanitizeComment({ ...base, text: '   ' }), null);
  assert.equal(sanitizeComment({ ...base, id: 'bad id!' }), null);
  assert.equal(sanitizeComment(null), null);
});

test('改留言：文字要檢查權限、已解決由後台記誰', () => {
  const now = new Date('2026-10-14T03:00:00.000Z');
  const r = commentPatch({ status: 'resolved', resolvedBy: '冒名', resolvedAt: '1999' }, { name: 'daoyan' }, now);
  assert.deepEqual(r, { ok: true, touchesText: false, changes: { status: 'resolved', resolved_by: 'daoyan', resolved_at: now.toISOString() } });
  assert.deepEqual(commentPatch({ status: 'open' }, { name: 'x' }, now).changes, { status: 'open', resolved_by: '', resolved_at: '' });
  const t = commentPatch({ text: ' 改過 ' }, { name: 'x' }, now);
  assert.equal(t.touchesText, true);
  assert.equal(t.changes.text, '改過');
  assert.equal(commentPatch({ text: '  ' }, {}, now).ok, false);
  assert.equal(commentPatch({ status: 'weird' }, {}, now).ok, false);
  assert.equal(commentPatch({}, {}, now).ok, false);
});

// ─────────────────────────────────────────────
// 0026：區段、3D 視角、cue、畫記、縮圖
// ─────────────────────────────────────────────

const arrow = { t: 'arrow', c: '#FF3B30', w: 0.006, p: [0.1, 0.2, 0.5, 0.55555] };
const okAnn = { v: 1, aspect: 1.7778, shapes: [arrow, { t: 'ellipse', c: '#34c759', w: 0.004, p: [0.3, 0.3, 0.6, 0.7] }] };

test('區段：結束要在開始之後、最多 1 小時；沒帶 = 一個時間點', () => {
  assert.deepEqual(commentExtrasInput({ time: 12 }).extras.timeEnd, null);
  assert.equal(commentExtrasInput({ time: 12, timeEnd: 18 }).extras.timeEnd, 18);
  assert.match(commentExtrasInput({ time: 12, timeEnd: 12 }).error, /結束要在開始之後/);
  assert.match(commentExtrasInput({ time: 12, timeEnd: 5 }).error, /結束要在開始之後/);
  assert.match(commentExtrasInput({ time: 0, timeEnd: 3601 }).error, /太長/);
  assert.equal(commentExtrasInput({ time: 0, timeEnd: 'x' }).ok, false);
  assert.equal(commentExtrasInput({ time: -1 }).ok, false);
  assert.equal(commentExtrasInput({ time: 12, timeEnd: null }).ok, true);
});

test('視角：位置 / 看哪裡 / 鏡頭角度整理好；壞掉的當沒帶（不擋留言）', () => {
  assert.deepEqual(sanitizeView({ position: [1, 2.123456, 3], target: [0, 1, 0], fov: 50, aspect: 1.77777 }),
    { position: [1, 2.1235, 3], target: [0, 1, 0], fov: 50, aspect: 1.7778 });
  assert.equal(sanitizeView({ position: [1, 1, 1], target: [1, 1, 1], fov: 50 }), null);  // 看向自己
  assert.equal(sanitizeView({ position: [1, 1], target: [0, 0, 0], fov: 50 }), null);
  assert.equal(sanitizeView({ position: [1, 1, 1], target: [0, 0, 0], fov: 1 }), null);
  assert.equal(sanitizeView({ position: [1e9, 1, 1], target: [0, 0, 0], fov: 50 }), null);
  assert.equal(sanitizeView('x'), null);
  // aspect 不合理就不放
  assert.equal(sanitizeView({ position: [1, 1, 1], target: [0, 0, 0], fov: 50, aspect: 99 }).aspect, undefined);
  const ex = commentExtrasInput({ time: 1, view: { position: [1, 1, 1], target: [0, 0, 0], fov: 50 }, cueId: 'cue_1' });
  assert.deepEqual(ex.extras.view, { position: [1, 1, 1], target: [0, 0, 0], fov: 50 });
  assert.equal(ex.extras.cueId, 'cue_1');
  assert.equal(commentExtrasInput({ cueId: 'bad id' }).extras.cueId, null);
});

test('畫記：座標夾在 0~1、四捨五入、顏色只收調色盤；太多筆 / 壞掉的擋下來', () => {
  const r = sanitizeAnnotation(okAnn);
  assert.equal(r.ok, true);
  assert.equal(r.value.shapes[0].c, '#ff3b30');                 // 大寫轉小寫
  assert.deepEqual(r.value.shapes[0].p, [0.1, 0.2, 0.5, 0.5556]);
  assert.deepEqual(sanitizeAnnotation({ ...okAnn, shapes: [{ ...arrow, p: [-1, 2, 0.5, 0.5] }] }).value.shapes[0].p, [0, 1, 0.5, 0.5]);
  assert.deepEqual(sanitizeAnnotation(null), { ok: true, value: null });
  assert.deepEqual(sanitizeAnnotation({ v: 1, aspect: 1.5, shapes: [] }), { ok: true, value: null });
  assert.match(sanitizeAnnotation({ ...okAnn, shapes: [{ ...arrow, c: '#123456' }] }).error, /顏色/);
  assert.equal(sanitizeAnnotation({ ...okAnn, shapes: [{ ...arrow, t: 'star' }] }).ok, false);
  assert.equal(sanitizeAnnotation({ ...okAnn, shapes: [{ ...arrow, p: [0, 0, 1] }] }).ok, false);   // 箭頭要剛好兩點
  assert.equal(sanitizeAnnotation({ ...okAnn, shapes: [{ ...arrow, w: 1 }] }).ok, false);
  assert.equal(sanitizeAnnotation({ ...okAnn, aspect: 0 }).ok, false);
  assert.match(sanitizeAnnotation({ ...okAnn, shapes: Array.from({ length: MAX_SHAPES + 1 }, () => arrow) }).error, /太多筆/);
  const longPen = { t: 'pen', c: '#ffffff', w: 0.004, p: Array.from({ length: 802 }, (_, i) => (i % 100) / 100) };
  assert.match(sanitizeAnnotation({ ...okAnn, shapes: [longPen] }).error, /太長/);
  const pen = { t: 'pen', c: '#ffffff', w: 0.004, p: [0.1, 0.1, 0.2, 0.2, 0.3, 0.25] };
  assert.equal(sanitizeAnnotation({ ...okAnn, shapes: [pen] }).value.shapes[0].p.length, 6);
  // 畫的那一格（區段留言先標 I / O 再畫）
  assert.equal(sanitizeAnnotation({ ...okAnn, t: 9.04 }).value.t, 9.04);
  assert.equal('t' in sanitizeAnnotation({ ...okAnn, t: -1 }).value, false);
  assert.equal('t' in sanitizeAnnotation({ ...okAnn, t: 'x' }).value, false);
  // 送到留言：畫記壞掉 → 整則擋下來
  assert.equal(commentExtrasInput({ time: 1, annotation: { ...okAnn, shapes: [{ ...arrow, c: 'red' }] } }).ok, false);
});

test('縮圖：只收 JPEG、最多 150 KB', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const dataUrl = 'data:image/jpeg;base64,' + Buffer.from(jpeg).toString('base64');
  const r = decodeThumbnail(dataUrl);
  assert.equal(r.ok, true);
  assert.deepEqual([...r.bytes], [...jpeg]);
  assert.deepEqual(decodeThumbnail(undefined), { ok: true, bytes: null });
  assert.equal(decodeThumbnail('data:image/png;base64,iVBORw0KGgo=').status, 400);
  assert.equal(decodeThumbnail('data:image/jpeg;base64,' + Buffer.from('hello').toString('base64')).status, 400);  // 不是 JPEG
  assert.equal(decodeThumbnail('data:image/jpeg;base64,%%%').status, 400);
  const big = new Uint8Array(MAX_THUMB_BYTES + 10); big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
  assert.equal(decodeThumbnail('data:image/jpeg;base64,' + Buffer.from(big).toString('base64')).status, 413);
});

test('縮圖網址：存的位置 ↔ 網址；亂打的對不到', () => {
  const key = commentThumbKey('p_1', 'c_abc', 'a'.repeat(32));
  assert.equal(key, `comment-thumbs/p_1/c_abc-${'a'.repeat(32)}.jpg`);
  const url = thumbUrlFor(key);
  assert.equal(url, `/api/comment-thumbs/p_1/c_abc-${'a'.repeat(32)}.jpg`);
  assert.equal(thumbKeyFromPath(url), key);
  assert.equal(thumbKeyFromPath('/api/comment-thumbs/../models/x.glb'), null);
  assert.equal(thumbKeyFromPath('/api/comment-thumbs/p_1/c_abc.jpg'), null);
  assert.equal(thumbUrlFor('models/p_1/x.glb'), null);
});

test('存進資料庫再讀出來：區段、視角、cue、畫記、縮圖都在；舊留言格式不變', () => {
  const clean = {
    ...sanitizeComment(base),
    ...commentExtrasInput({ time: 12.5, timeEnd: 18, view: { position: [1, 2, 3], target: [0, 1, 0], fov: 45, aspect: 1.5 }, cueId: 'cue_9', annotation: okAnn }).extras,
  };
  const row = { ...commentToRow(clean), project_id: 'p', song_id: 's', thumb_key: commentThumbKey('p', clean.id, 'b'.repeat(32)) };
  const back = rowToComment(row);
  assert.equal(back.timeEnd, 18);
  assert.deepEqual(back.view, { position: [1, 2, 3], target: [0, 1, 0], fov: 45, aspect: 1.5 });
  assert.equal(back.cueId, 'cue_9');
  assert.equal(back.annotation.shapes.length, 2);
  assert.match(back.thumbUrl, /^\/api\/comment-thumbs\/p\//);
  // 沒有新欄位的舊留言：一個多的欄位都沒有
  const old = rowToComment({ ...commentToRow(sanitizeComment(base)), project_id: 'p', song_id: 's' });
  for (const k of ['timeEnd', 'view', 'cueId', 'annotation', 'thumbUrl', 'guest']) assert.equal(k in old, false, k);
});

test('訪客留言：團隊看到「訪客：名字（連結名稱）」；給訪客看的不帶 email / 帳號 / @', () => {
  assert.equal(guestAuthorLabel('小李', '給經紀人'), '訪客：小李（給經紀人）');
  assert.equal(guestAuthorLabel('小李', null), '訪客：小李');
  const row = {
    ...commentToRow(sanitizeComment({ ...base, email: 'x@y.z', mentions: [{ userId: 'u1', name: 'A' }] })),
    author_role: 'guest', author_user_id: null, guest_name: '小李', share_label: '給經紀人', share_token: 'tk',
  };
  const team = rowToComment(row);
  assert.equal(team.author, '訪客：小李（給經紀人）');
  assert.equal(team.role, 'guest');
  assert.deepEqual(team.guest, { name: '小李', linkName: '給經紀人' });
  const forGuest = rowToGuestComment(row);
  assert.equal(forGuest.author, '小李');
  assert.equal(forGuest.role, 'guest');
  for (const k of ['email', 'authorUserId', 'mentions', 'guest', 'resolvedBy']) assert.equal(k in forGuest, false, k);
  // 團隊的回覆：名字 + 身分（導演 / 動畫師），一樣不帶 email
  const reply = rowToGuestComment({ ...commentToRow(sanitizeComment({ ...base, role: 'director', email: 'd@x.y' })), reply_to_comment_id: 'c_root' });
  assert.equal(reply.author, 'Phang');
  assert.equal(reply.role, 'director');
  assert.equal(reply.parentId, 'c_root');
  assert.equal('email' in reply, false);
});
