// 跑法：cd cf-worker && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeComment, commentToRow, rowToComment, commentPatch } from './comments.mjs';

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
