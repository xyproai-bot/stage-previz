// 跑法：cd cf-worker && npm test
// 分享連結的訪客留言（guestComments.mjs）的純判斷 + 權限（access.mjs）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripHtml, sanitizeGuestName, sanitizeGuestText, sanitizeShareLabel, shareLinkDisplayName,
  rateDecision, guestRateMessage, guestIpKey, guestPassKey, shareLinkCommentFields, guestCommentWants,
  GUEST_NAME_MAX, GUEST_TEXT_MAX, GUEST_IP_RATE,
} from './guestComments.mjs';
import { pickRecipients } from './reviews.mjs';
import { canToggleShareComments, guestCommentDecision } from './access.mjs';
import { loginClientKey, shareAttemptKey, slugMissKey } from './loginThrottle.mjs';

test('不收 HTML：標籤、角括號、控制字元拿掉', () => {
  assert.equal(stripHtml('<b>粗</b>體<script>alert(1)</script>'), '粗體alert(1)');
  assert.equal(stripHtml('a < b > c'), 'a  b  c');
  assert.equal(stripHtml('x\u0000y‮z'), 'xyz');
  assert.equal(stripHtml('第一行\n第二行'), '第一行\n第二行');
});

test('訪客名字：一行、拿掉引號、最多 30 字；空的 = 不行', () => {
  assert.equal(sanitizeGuestName('  小李  經紀人 '), '小李 經紀人');
  assert.equal(sanitizeGuestName('<img src=x onerror=alert(1)>王"小"明'), '王小明');
  assert.equal(sanitizeGuestName('   '), '');
  assert.equal(sanitizeGuestName(42), '');
  assert.equal(sanitizeGuestName('長'.repeat(50)).length, GUEST_NAME_MAX);
});

test('訪客留言內容：拿掉 HTML、最多 1000 字、太多空行縮掉', () => {
  assert.equal(sanitizeGuestText('<a href="x">這裡</a> 太亮'), '這裡 太亮');
  assert.equal(sanitizeGuestText('a\r\n\n\n\n\n\nb'), 'a\n\n\nb');
  assert.equal(sanitizeGuestText('字'.repeat(1200)).length, GUEST_TEXT_MAX);
  assert.equal(sanitizeGuestText('<p></p>'), '');
  assert.equal(sanitizeGuestText(null), '');
});

test('連結名稱：一行、最多 40 字、空的 = null；團隊看到的名稱有退路', () => {
  assert.equal(sanitizeShareLabel(' 給 <b>經紀人</b> '), '給 經紀人');
  assert.equal(sanitizeShareLabel('   '), null);
  assert.equal(sanitizeShareLabel(null), null);
  assert.equal(shareLinkDisplayName({ label: '給經紀人', slug: 'jinma-k7p2' }), '給經紀人');
  assert.equal(shareLinkDisplayName({ label: null, slug: 'jinma-k7p2' }), '/s/jinma-k7p2');
  assert.equal(shareLinkDisplayName({}), '分享連結');
});

test('防亂發：一段時間內最多幾則，最舊的那則過了時間就能再發', () => {
  const now = 1_000_000_000;
  const rule = { windowMs: 600_000, max: 3 };
  assert.deepEqual(rateDecision([], now, rule), { allowed: true, retryAfterMs: 0 });
  assert.equal(rateDecision([now - 1000, now - 2000], now, rule).allowed, true);
  const r = rateDecision([now - 500_000, now - 100_000, now - 1000], now, rule);
  assert.equal(r.allowed, false);
  assert.equal(r.retryAfterMs, 100_000);                           // 最舊的那則再 100 秒就過期
  assert.equal(rateDecision([now - 700_000, now - 100_000, now - 1000], now, rule).allowed, true);  // 超過時間的不算
  assert.match(guestRateMessage(100_000), /2 分鐘/);
  assert.equal(GUEST_IP_RATE.max, 10);
});

test('記錄用的 key 跟登入 / 分享密碼 / 好讀網址的分得開', async () => {
  const ip = loginClientKey('203.0.113.9');
  const k = guestIpKey('tk_abc', ip);
  assert.equal(k, 'gc:tk_abc|203.0.113.9');
  for (const other of [ip, shareAttemptKey('tk_abc', ip), slugMissKey(ip)]) assert.notEqual(k, other);
  const p1 = await guestPassKey('123.sig');
  assert.match(p1, /^gcp:[0-9a-f]{24}$/);
  assert.equal(await guestPassKey('123.sig'), p1);
  assert.notEqual(await guestPassKey('124.sig'), p1);
});

test('「允許看的人留言」：只有製作能打開，關掉製作和導演都可以；動畫師不能管分享連結', () => {
  assert.equal(canToggleShareComments('admin', true), true);
  assert.equal(canToggleShareComments('director', true), false);
  assert.equal(canToggleShareComments('director', false), true);
  assert.equal(canToggleShareComments('animator', false), false);
  assert.equal(canToggleShareComments(null, false), false);

  assert.deepEqual(shareLinkCommentFields({ allowComments: true, label: ' 給經紀人 ' }, 'admin'),
    { ok: true, fields: { allow_comments: 1, label: '給經紀人' } });
  assert.deepEqual(shareLinkCommentFields({ allowComments: true }, 'director'),
    { ok: false, status: 403, error: '只有製作可以打開「允許看的人留言」' });
  assert.deepEqual(shareLinkCommentFields({ allowComments: false }, 'director'), { ok: true, fields: { allow_comments: 0 } });
  assert.equal(shareLinkCommentFields({ allowComments: 'yes' }, 'admin').status, 400);
  assert.equal(shareLinkCommentFields({ label: 5 }, 'admin').status, 400);
  assert.deepEqual(shareLinkCommentFields({ label: '' }, 'director'), { ok: true, fields: { label: null } });
  // 舊版前端只送 slug → 沒有要改的
  assert.deepEqual(shareLinkCommentFields({ slug: 'x' }, 'director'), { ok: true, fields: {} });
  assert.deepEqual(shareLinkCommentFields(null, 'admin'), { ok: true, fields: {} });
});

test('訪客能不能留言：連結要打開、專案沒封存', () => {
  assert.equal(guestCommentDecision({ allow_comments: 1, project_status: 'active' }).ok, true);
  const off = guestCommentDecision({ allow_comments: 0, project_status: 'active' });
  assert.equal(off.status, 403);
  assert.equal(off.commentsDisabled, true);
  assert.equal(guestCommentDecision({ allow_comments: 1, project_status: 'archived' }).status, 404);
  assert.equal(guestCommentDecision(null).status, 404);
});

test('訪客留言通知誰：建連結的人、導演、這首歌的動畫師；回覆再加這串裡團隊留過言的人；同一個人只收一則', () => {
  const members = [
    { user_id: 'u_dir', role: 'director' }, { user_id: 'u_dir2', role: 'director' },
    { user_id: 'u_a1', role: 'animator' }, { user_id: 'u_a2', role: 'animator' },
    { user_id: 'u_pa', role: 'admin' },                 // 專案裡的製作（不是建連結的人）
    { user_id: 'u_site', role: 'admin' },               // 全站製作（不是專案成員）
  ];
  const memberIds = new Set(members.map(m => m.user_id));
  const pick = (p) => pickRecipients(guestCommentWants({ members, ...p }), memberIds, null).map(r => `${r.userId}:${r.kind}`);

  // 新的一則：建連結的人 + 兩個導演 + 這首歌的動畫師；其他動畫師、製作都不收
  assert.deepEqual(pick({ linkCreatorId: 'u_site', animatorUserId: 'u_a1' }),
    ['u_site:guest_comment', 'u_dir:guest_comment', 'u_dir2:guest_comment', 'u_a1:guest_comment']);
  // 建連結的是導演、歌還沒指派 → 導演只收一則
  assert.deepEqual(pick({ linkCreatorId: 'u_dir' }), ['u_dir:guest_comment', 'u_dir2:guest_comment']);
  // 回覆：這串裡團隊留過言的人先收「回覆」（重複的、訪客那幾則沒有帳號的拿掉），其他照舊、不重複
  assert.deepEqual(pick({ threadUserIds: [null, 'u_a2', 'u_dir', 'u_a2', null], linkCreatorId: 'u_dir', animatorUserId: 'u_a1' }),
    ['u_a2:reply', 'u_dir:reply', 'u_dir2:guest_comment', 'u_a1:guest_comment']);
  // 建連結的人 / 動畫師已經不在專案裡（或停用）→ 不收
  assert.deepEqual(pick({ linkCreatorId: 'u_gone', animatorUserId: 'u_gone2' }), ['u_dir:guest_comment', 'u_dir2:guest_comment']);
  // 什麼都沒有也不會壞
  assert.deepEqual(guestCommentWants(), []);
  assert.deepEqual(guestCommentWants({ members: null, threadUserIds: null }), []);
});
