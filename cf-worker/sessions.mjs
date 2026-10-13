// 登入狀態（session）什麼時候失效（純計算，不碰資料庫；讀寫在 worker.js 的 loadRequestUser / setAccessCode / updateUser）。
//
// 登入狀態是簽名過的字串「<userId>.<到期時間（秒）>.<簽名>」，後台不存一份清單。
// 所以「讓某個人之前的登入全部失效」用一個時間點：users.sessions_revoked_at（秒）
//   - 這個時間點以前發的登入 → 不認
//   - 發的時間 = 到期時間 − 90 天（SESSION_TTL_SEC 一直沒變過；要改的話舊的登入會算錯發的時間）
//   - 製作重設「自己」的登入碼 → 自己現在用的這一個登入留著（users.session_keep_hash 存它的雜湊），其他裝置的登了出去
// 什麼時候寫：製作重設某人的登入碼、停用某人的帳號（重新啟用時不會讓舊的登入活回來）
//
// 時間用「下一秒」當切點、新的登入發的時間不早於切點：
//   同一秒內「重設前發的」一定失效、「重設後發的」一定有效（不會因為同一秒而算錯）

/** 登入狀態有效多久（90 天）；不要改（發的時間是用到期時間倒推的） */
export const SESSION_TTL_SEC = 90 * 24 * 3600;

/** 登入狀態是什麼時候發的（秒）：到期時間 − 90 天 */
export function sessionIssuedAtSec(expSec) {
  const exp = Number(expSec);
  return Number.isFinite(exp) ? exp - SESSION_TTL_SEC : NaN;
}

/** 從登入字串拿到期時間（秒）；格式不對 → null（簽名另外驗） */
export function sessionTokenExp(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const exp = parseInt(parts[1], 10);
  return Number.isFinite(exp) && exp > 0 ? exp : null;
}

/** 登入字串的雜湊（SHA-256 hex）：資料庫只存這個，不存登入字串本身 */
export async function sessionTokenHash(token) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 這個登入還算不算數（簽名、到期另外驗過）
 * @param {{issuedAtSec: number}} session
 * @param {{revokedAt?: number|null, keepHash?: string|null}} user  users.sessions_revoked_at / session_keep_hash
 * @param {() => Promise<string>} [tokenHashFn]  只有「在切點以前發的」才需要算雜湊比對留下來的那一個
 */
export async function sessionAllowed(session, user, tokenHashFn) {
  const revokedAt = Number(user?.revokedAt);
  if (!user?.revokedAt || !Number.isFinite(revokedAt)) return true;
  if (Number.isFinite(session?.issuedAtSec) && session.issuedAtSec >= revokedAt) return true;
  if (user.keepHash && typeof tokenHashFn === 'function') {
    try { return (await tokenHashFn()) === user.keepHash; } catch { return false; }
  }
  return false;
}

/**
 * 讓某個人之前的登入全部失效：要寫進 users 的兩個值
 *   targetUserId === actorUserId（製作改自己）→ 留下自己現在這一個登入
 * @returns {{revokedAt: number, keepHash: string|null}}
 */
export function revokeSessionsUpdate({ nowMs = Date.now(), targetUserId, actorUserId, actorTokenHash = null }) {
  const revokedAt = Math.floor(nowMs / 1000) + 1;
  const keepHash = targetUserId && targetUserId === actorUserId && actorTokenHash ? actorTokenHash : null;
  return { revokedAt, keepHash };
}

/**
 * 新的登入要算哪一秒發的：現在，但不早於這個人的切點（剛重設完、同一秒內登入也有效）
 * @returns {number} 秒
 */
export function sessionIssueSec(nowMs = Date.now(), revokedAt = null) {
  const now = Math.floor(nowMs / 1000);
  const cut = Number(revokedAt);
  return Number.isFinite(cut) && cut > now ? cut : now;
}

/** 停用 / 重新啟用：只有「停用」要讓舊的登入失效；製作不能停用自己（會把自己鎖在外面） */
export function deactivateDecision({ targetUserId, actorUserId, deactivated }) {
  if (!deactivated) return { ok: true, revoke: false };
  if (targetUserId === actorUserId) return { ok: false, status: 400, error: '不能停用自己的帳號' };
  return { ok: true, revoke: true };
}
