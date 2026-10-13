// 分享連結的密碼 + 通行證（純計算，用 Web Crypto；Cloudflare Workers 和 Node 都有）。
//
// 密碼：不存明文，存「加鹽的 PBKDF2-SHA256」
//   password_hash = 'pbkdf2-sha256$<次數>$<base64 雜湊>'
//   password_salt = base64（每條連結自己的 16 bytes 隨機鹽）
//   舊的連結如果還是明文（share_links.password），第一次密碼對了就換成雜湊、明文清掉。
//
// 通行證：密碼對了以後發一張短期通行證（HMAC 簽章，跟這條連結 + 目前的密碼雜湊綁在一起），
//   之後的請求帶 X-Share-Access header 就好，不用每次都送密碼（也不用每次算 PBKDF2）；
//   影片 <video src> 帶不了 header → 影片網址後面接 ?access=<通行證>（只有影片串流收這個）。
//   密碼換掉 / 拿掉 → 雜湊變了 → 舊通行證全部失效。

// Workers 的 PBKDF2 最多 100000 次；50000 次在 Workers 上約 5ms，每位觀看者只算一次（之後用通行證）
export const SHARE_PBKDF2_ITERATIONS = 50000;
export const SHARE_ACCESS_TTL_MS = 8 * 3600 * 1000;  // 通行證 8 小時（一個工作天；過期了前端用記住的密碼再換一張）
export const SHARE_PASSWORD_MAX = 60;

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

function bytesToB64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 字串比對，花的時間跟內容無關（不讓人用回應時間一個字一個字猜） */
export function timingSafeEqualStr(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function pbkdf2(password, saltBytes, iterations) {
  const key = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** 建立 / 換密碼：回 { hash, salt } 存進 share_links.password_hash / password_salt */
export async function hashSharePassword(password, { iterations = SHARE_PBKDF2_ITERATIONS, salt } = {}) {
  const saltBytes = salt ? b64ToBytes(salt) : globalThis.crypto.getRandomValues(new Uint8Array(16));
  const derived = await pbkdf2(String(password), saltBytes, iterations);
  return { hash: `pbkdf2-sha256$${iterations}$${bytesToB64(derived)}`, salt: bytesToB64(saltBytes) };
}

/** 這條連結有沒有設密碼（新的雜湊或舊的明文都算） */
export function shareLinkHasPassword(link) {
  return !!(link && (link.password_hash || link.password));
}

/**
 * 密碼對不對。
 * @param {string} provided 使用者輸入的
 * @param {{password_hash?: string|null, password_salt?: string|null, password?: string|null}} link
 * @returns {Promise<{ok: boolean, legacy?: boolean}>} legacy = 舊的明文密碼（對了的話要換成雜湊）
 */
export async function verifySharePassword(provided, link) {
  if (typeof provided !== 'string' || !provided) return { ok: false };
  if (link?.password_hash) {
    const m = /^pbkdf2-sha256\$(\d{1,7})\$([A-Za-z0-9+/=]+)$/.exec(link.password_hash);
    if (!m || !link.password_salt) return { ok: false };
    const iterations = Number(m[1]);
    if (!(iterations >= 1000 && iterations <= 100000)) return { ok: false };
    const derived = await pbkdf2(provided, b64ToBytes(link.password_salt), iterations);
    return { ok: timingSafeEqualStr(bytesToB64(derived), m[2]) };
  }
  if (link?.password) return { ok: timingSafeEqualStr(provided, link.password), legacy: true };
  return { ok: false };
}

async function hmac(secret, data) {
  const key = await subtle().importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await subtle().sign('HMAC', key, enc.encode(data))));
}

/**
 * 通行證要綁的「目前的密碼」：有雜湊就用雜湊；還是舊明文的連結用明文的 SHA-256（不把明文放進簽章）
 */
export async function shareCredential(link) {
  if (link?.password_hash) return link.password_hash;
  if (link?.password) {
    const d = new Uint8Array(await subtle().digest('SHA-256', enc.encode('legacy|' + link.password)));
    return 'legacy$' + bytesToB64(d);
  }
  return '';
}

// 通行證綁的內容：哪條連結 + 目前的密碼雜湊 + 到期時間
function accessPayload(linkToken, credential, exp) {
  return `share-access|${linkToken}|${credential}|${exp}`;
}

/** 發通行證：'<到期毫秒>.<簽章>' */
export async function signShareAccess(secret, { linkToken, credential, now = Date.now(), ttlMs = SHARE_ACCESS_TTL_MS }) {
  const exp = Math.floor(now + ttlMs);
  return { token: `${exp}.${await hmac(secret, accessPayload(linkToken, credential, exp))}`, expiresAt: exp };
}

/** 通行證有效嗎（簽章對、沒過期、密碼沒換過） */
export async function verifyShareAccess(secret, { linkToken, credential, token, now = Date.now() }) {
  if (typeof token !== 'string' || token.length > 200) return false;
  const m = /^(\d{10,16})\.([A-Za-z0-9_-]{20,100})$/.exec(token);
  if (!m) return false;
  const exp = Number(m[1]);
  if (!Number.isFinite(exp) || exp <= now) return false;
  const expected = await hmac(secret, accessPayload(linkToken, credential, exp));
  return timingSafeEqualStr(expected, m[2]);
}
