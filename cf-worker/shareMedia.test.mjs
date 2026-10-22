// 跑法：cd cf-worker && npm test
// 分享連結「禁止下載」的播放通行證（shareMedia.mjs）+ 浮水印 / 禁止下載的預設與權限規則（web/src/lib/watermark/policy.ts，前後台共用）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  signSharePlay, verifySharePlay, decideShareStream, withShareQuery, sharePlaybackCacheControl, shortLinkId,
  SHARE_PLAY_BUCKET_MS, PLAY_TOKEN_MISSING_MESSAGE, PLAY_TOKEN_EXPIRED_MESSAGE,
} from './shareMedia.mjs';
import {
  NEW_LINK_PROTECTION, LEGACY_LINK_PROTECTION, MEMBER_WATERMARK_DEFAULT, readFlag,
  resolveNewLinkProtection, resolveLinkProtectionPatch, protectionOfRow,
  canSetMemberWatermark, memberWatermarkOn, shouldWatermarkMember, shouldWatermarkGuest,
} from '../web/src/lib/watermark/policy.ts';

const SECRET = 'test-secret';
const NOW = Date.UTC(2026, 9, 18, 6, 0, 0);

// ── 播放通行證 ──

test('播放通行證：簽出去的驗得過（同一條連結、同一支影片）', async () => {
  const t = await signSharePlay(SECRET, { linkToken: 'tk_a', mediaId: 'sv_1', now: NOW });
  assert.match(t, /^\d+\.[A-Za-z0-9_-]+$/);
  assert.equal(await verifySharePlay(SECRET, t, { linkToken: 'tk_a', mediaId: 'sv_1', now: NOW }), true);
  assert.equal(await verifySharePlay(SECRET, t, { linkToken: 'tk_a', mediaId: 'sv_1', now: NOW + 1000 }), true);
});

test('播放通行證：綁連結——別條連結的不能用', async () => {
  const t = await signSharePlay(SECRET, { linkToken: 'tk_a', mediaId: 'sv_1', now: NOW });
  assert.equal(await verifySharePlay(SECRET, t, { linkToken: 'tk_b', mediaId: 'sv_1', now: NOW }), false);
});

test('播放通行證：綁影片——換一支影片不能用', async () => {
  const t = await signSharePlay(SECRET, { linkToken: 'tk_a', mediaId: 'sv_1', now: NOW });
  assert.equal(await verifySharePlay(SECRET, t, { linkToken: 'tk_a', mediaId: 'sv_2', now: NOW }), false);
});

test('播放通行證：幾個小時就失效（不是永久）', async () => {
  const t = await signSharePlay(SECRET, { linkToken: 'tk_a', mediaId: 'sv_1', now: NOW });
  const exp = Number(t.split('.')[0]);
  assert.ok(exp - NOW >= SHARE_PLAY_BUCKET_MS && exp - NOW <= 2 * SHARE_PLAY_BUCKET_MS, '有效 1 到 2 個時段');
  assert.ok(2 * SHARE_PLAY_BUCKET_MS <= 6 * 3600 * 1000, '最久不超過 6 小時');
  assert.equal(await verifySharePlay(SECRET, t, { linkToken: 'tk_a', mediaId: 'sv_1', now: exp - 1 }), true);
  assert.equal(await verifySharePlay(SECRET, t, { linkToken: 'tk_a', mediaId: 'sv_1', now: exp }), false);
  assert.equal(await verifySharePlay(SECRET, t, { linkToken: 'tk_a', mediaId: 'sv_1', now: exp + 24 * 3600 * 1000 }), false);
});

test('播放通行證：同一個時段簽出來的一樣（瀏覽器快取有用），下一個時段換新的', async () => {
  const a = await signSharePlay(SECRET, { linkToken: 'tk_a', mediaId: 'sv_1', now: NOW });
  const b = await signSharePlay(SECRET, { linkToken: 'tk_a', mediaId: 'sv_1', now: NOW + 1000 });
  assert.equal(a, b);
  const c = await signSharePlay(SECRET, { linkToken: 'tk_a', mediaId: 'sv_1', now: NOW + SHARE_PLAY_BUCKET_MS });
  assert.notEqual(a, c);
});

test('播放通行證：亂寫的、改過的、別的密鑰簽的、空的都不能用', async () => {
  const ctx = { linkToken: 'tk_a', mediaId: 'sv_1', now: NOW };
  const t = await signSharePlay(SECRET, ctx);
  const [exp, sig] = t.split('.');
  assert.equal(await verifySharePlay(SECRET, '', ctx), false);
  assert.equal(await verifySharePlay(SECRET, null, ctx), false);
  assert.equal(await verifySharePlay(SECRET, undefined, ctx), false);
  assert.equal(await verifySharePlay(SECRET, 'abc', ctx), false);
  assert.equal(await verifySharePlay(SECRET, `${exp}.${sig}x`, ctx), false);
  assert.equal(await verifySharePlay(SECRET, `${Number(exp) + SHARE_PLAY_BUCKET_MS}.${sig}`, ctx), false, '偷改到期時間');
  assert.equal(await verifySharePlay(SECRET, `${exp}.${sig}.extra`, ctx), false);
  assert.equal(await verifySharePlay('other-secret', t, ctx), false);
  // 到期時間太遠（超過簽得出來的最長有效期）也不收
  const far = Number(exp) + 10 * SHARE_PLAY_BUCKET_MS;
  assert.equal(await verifySharePlay(SECRET, `${far}.${sig}`, ctx), false);
});

// ── 串流請求要不要放行 ──

test('串流放行：沒開禁止下載 → 照舊放行（不用通行證）', async () => {
  const r = await decideShareStream(SECRET, { noDownload: false, playToken: '', linkToken: 'tk_a', mediaId: 'sv_1', now: NOW });
  assert.deepEqual(r, { ok: true });
});

test('串流放行：開了禁止下載 → 沒通行證 401、過期 401（要重新整理）、對的才放行', async () => {
  const base = { noDownload: true, linkToken: 'tk_a', mediaId: 'sv_1', now: NOW };
  const none = await decideShareStream(SECRET, { ...base, playToken: '' });
  assert.equal(none.ok, false);
  assert.equal(none.status, 401);
  assert.equal(none.error, PLAY_TOKEN_MISSING_MESSAGE);
  assert.equal(none.passExpired, false);

  const t = await signSharePlay(SECRET, { linkToken: 'tk_a', mediaId: 'sv_1', now: NOW });
  assert.deepEqual(await decideShareStream(SECRET, { ...base, playToken: t }), { ok: true });

  const later = await decideShareStream(SECRET, { ...base, playToken: t, now: NOW + 3 * SHARE_PLAY_BUCKET_MS });
  assert.equal(later.ok, false);
  assert.equal(later.status, 401);
  assert.equal(later.error, PLAY_TOKEN_EXPIRED_MESSAGE);
  assert.equal(later.passExpired, true);

  const wrongLink = await decideShareStream(SECRET, { ...base, linkToken: 'tk_b', playToken: t });
  assert.equal(wrongLink.ok, false);
  const wrongVideo = await decideShareStream(SECRET, { ...base, mediaId: 'sv_2', playToken: t });
  assert.equal(wrongVideo.ok, false);
});

test('影片網址的組法：沒有通行證 = 原本的網址；密碼通行證接 access；禁止下載再接 play', () => {
  assert.equal(withShareQuery('/api/share/tk/song-videos/v/stream'), '/api/share/tk/song-videos/v/stream');
  assert.equal(withShareQuery('/p', { access: 'a.b' }), '/p?access=a.b');
  assert.equal(withShareQuery('/p', { play: 'x.y' }), '/p?play=x.y');
  assert.equal(withShareQuery('/p', { access: 'a b', play: 'x+y' }), '/p?access=a%20b&play=x%2By');
});

test('快取規則：禁止下載不存；沒開跟以前一樣', () => {
  assert.equal(sharePlaybackCacheControl(true), 'private, no-store');
  assert.equal(sharePlaybackCacheControl(false), 'private, max-age=31536000, immutable');
});

test('連結編號：6 個大寫英數字，同一個連結碼永遠同一組，不同連結不同組，看不出連結碼', async () => {
  const a = await shortLinkId('0123456789abcdef0123456789abcdef');
  assert.match(a, /^[0-9A-HJ-NP-Z]{6}$/);
  assert.equal(await shortLinkId('0123456789abcdef0123456789abcdef'), a);
  assert.notEqual(await shortLinkId('fedcba9876543210fedcba9876543210'), a);
  assert.ok(!'0123456789abcdef0123456789abcdef'.toUpperCase().includes(a));
});

// ── 預設值和權限 ──

test('預設值：新連結浮水印關、禁止下載開；舊連結兩個都關；成員看片浮水印預設關', () => {
  assert.deepEqual({ ...NEW_LINK_PROTECTION }, { watermark: false, noDownload: true });
  assert.deepEqual({ ...LEGACY_LINK_PROTECTION }, { watermark: false, noDownload: false });
  assert.equal(MEMBER_WATERMARK_DEFAULT, false);
  assert.deepEqual(protectionOfRow({}), { watermark: false, noDownload: false });
  assert.deepEqual(protectionOfRow(null), { watermark: false, noDownload: false });
  assert.deepEqual(protectionOfRow({ watermark: null, no_download: null }), { watermark: false, noDownload: false });
  assert.deepEqual(protectionOfRow({ watermark: 1, no_download: 0 }), { watermark: true, noDownload: false });
});

test('建立連結：沒給（舊版前端）= 浮水印關、禁止下載開；有給就照給的；不合法 400', () => {
  assert.deepEqual(resolveNewLinkProtection({}), { ok: true, fields: { watermark: 0, no_download: 1 } });
  assert.deepEqual(resolveNewLinkProtection(undefined), { ok: true, fields: { watermark: 0, no_download: 1 } });
  assert.deepEqual(resolveNewLinkProtection({ watermark: false }), { ok: true, fields: { watermark: 0, no_download: 1 } });
  assert.deepEqual(resolveNewLinkProtection({ noDownload: false, watermark: true }), { ok: true, fields: { watermark: 1, no_download: 0 } });
  assert.deepEqual(resolveNewLinkProtection({ watermark: 0, noDownload: 0 }), { ok: true, fields: { watermark: 0, no_download: 0 } });
  for (const bad of [{ watermark: 'yes' }, { noDownload: null }, { watermark: 2 }, { noDownload: [] }]) {
    assert.equal(resolveNewLinkProtection(bad).ok, false, JSON.stringify(bad));
  }
});

test('修改連結：只改有給的，沒給的不動', () => {
  assert.deepEqual(resolveLinkProtectionPatch({}), { ok: true, fields: {} });
  assert.deepEqual(resolveLinkProtectionPatch({ slug: 'x' }), { ok: true, fields: {} });
  assert.deepEqual(resolveLinkProtectionPatch({ watermark: false }), { ok: true, fields: { watermark: 0 } });
  assert.deepEqual(resolveLinkProtectionPatch({ noDownload: true }), { ok: true, fields: { no_download: 1 } });
  assert.equal(resolveLinkProtectionPatch({ watermark: 'off' }).ok, false);
});

test('readFlag：true / false / 0 / 1 才收', () => {
  assert.deepEqual(readFlag(true), { ok: true, value: true });
  assert.deepEqual(readFlag(0), { ok: true, value: false });
  assert.deepEqual(readFlag(undefined), { ok: true, value: undefined });
  assert.deepEqual(readFlag('1'), { ok: false });
  assert.deepEqual(readFlag(null), { ok: false });
});

test('成員看片浮水印：只有製作能改；預設關；專案開了不分角色都加', () => {
  assert.equal(canSetMemberWatermark('admin'), true);
  for (const r of ['director', 'animator', null, undefined, '']) assert.equal(canSetMemberWatermark(r), false, String(r));
  assert.equal(memberWatermarkOn(undefined), false);
  assert.equal(memberWatermarkOn(null), false);
  assert.equal(memberWatermarkOn(0), false);
  assert.equal(memberWatermarkOn(1), true);
  assert.equal(memberWatermarkOn(true), true);
  assert.equal(shouldWatermarkMember(1), true);
  assert.equal(shouldWatermarkMember(0), false);
  assert.equal(shouldWatermarkGuest({ watermark: true }), true);
  assert.equal(shouldWatermarkGuest({ watermark: false }), false);
  assert.equal(shouldWatermarkGuest(undefined), false);
});
