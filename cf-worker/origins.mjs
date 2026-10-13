// 哪些網站可以「帶著登入狀態」呼叫這個 worker（CORS 帶 credentials + 認 cookie）。
// 這裡只放「純判斷」，方便測試；用的地方在 worker.js 的 applyCorsToResponse / getRequestUserId。
//
// 為什麼要分：以前所有網站都會被回「可以帶 cookie」，等於任何網頁都能用已登入 admin 的身分
// 讀資料（例如所有人的登入號碼）。現在只有下面這些自己的網址可以；其他網站照樣能讀公開的東西
// （分享連結、Drive 代理），只是不帶登入狀態。

/** 自己的網址（要加新網域就加在這裡） */
const TRUSTED_HOSTS = new Set([
  'previz.haimiaan.com',        // 正式站（自己的網域）
  'test.previz.haimiaan.com',   // 測試站（feat/live-stage-look 分支）
  'stage-previz.vercel.app',    // 正式站舊網址（留著當備用）
  'stage-previz.haimiaan.com',  // 舊版單頁（v1）
]);

// Vercel 自動產生的預覽 / 部署網址（這個 team = haimiaan-s-projects）：
//   stage-previz-git-<分支>-haimiaan-s-projects.vercel.app
//   stage-previz-<部署代碼>-haimiaan-s-projects.vercel.app
//   stage-previz-haimiaan-s-projects.vercel.app
const VERCEL_TEAM_HOST_RE = /^stage-previz(?:-[a-z0-9-]+)?-haimiaan-s-projects\.vercel\.app$/;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * 這個 Origin（瀏覽器送來的「從哪個網站發出的」）是不是自己的網站。
 * 只接受標準寫法（https://host，本機可以 http 和任何 port）；有路徑、帳密、怪 port 一律不算。
 * @param {unknown} origin
 * @returns {boolean}
 */
export function isTrustedOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > 255) return false;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.origin !== origin) return false;  // 'null'、帶路徑、大寫、結尾斜線…都不算
  const host = u.hostname;
  if (LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost')) {
    return u.protocol === 'http:' || u.protocol === 'https:';
  }
  if (u.protocol !== 'https:' || u.port !== '') return false;
  return TRUSTED_HOSTS.has(host) || VERCEL_TEAM_HOST_RE.test(host);
}
