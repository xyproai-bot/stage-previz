// 跑法：cd cf-worker && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedOrigin } from './origins.mjs';

test('自己的網址 → 可以帶登入狀態', () => {
  for (const o of [
    'https://previz.haimiaan.com',
    'https://test.previz.haimiaan.com',
    'https://stage-previz.vercel.app',
    'https://stage-previz.haimiaan.com',
    'https://stage-previz-git-feat-live-stage-look-haimiaan-s-projects.vercel.app',
    'https://stage-previz-abc123xyz-haimiaan-s-projects.vercel.app',
    'https://stage-previz-haimiaan-s-projects.vercel.app',
  ]) assert.equal(isTrustedOrigin(o), true, o);
});

test('本機開發（任何 port、http 也行）', () => {
  for (const o of [
    'http://localhost:5173',
    'http://localhost',
    'https://localhost:8443',
    'http://127.0.0.1:8787',
    'http://[::1]:5173',
    'http://app.localhost:3000',
  ]) assert.equal(isTrustedOrigin(o), true, o);
});

test('別人的網站 / 怪寫法 → 不行', () => {
  for (const o of [
    undefined, null, '', 'null', 42,
    'https://evil.com',
    'https://previz.haimiaan.com.evil.com',
    'https://evilprevi.haimiaan.com',
    'https://x.previz.haimiaan.com',
    'https://haimiaan.com',
    'http://previz.haimiaan.com',              // 正式網址一定要 https
    'https://previz.haimiaan.com:8443',        // 不接受怪 port
    'https://previz.haimiaan.com/',            // Origin 不會有斜線
    'https://previz.haimiaan.com/path',
    'https://user@previz.haimiaan.com',
    'https://PREVIZ.haimiaan.com',             // 瀏覽器送的一定是小寫
    'https://stage-previz.vercel.app.evil.com',
    'https://evil.vercel.app',
    'https://stage-previz-evil.vercel.app',    // 別人的 Vercel 專案
    'https://stage-previz-x-other-team.vercel.app',
    'https://a.stage-previz-git-x-haimiaan-s-projects.vercel.app',
    'https://localhost.evil.com',
    'file://',
    'ftp://localhost',
    'x'.repeat(300),
  ]) assert.equal(isTrustedOrigin(o), false, String(o));
});
