// 登入碼（純計算，不碰資料庫；資料庫讀寫在 worker.js 的 authLogin / createUser / setAccessCode / listUsers）。
//
// 兩種存法（app_settings 表的 login_code_storage 決定，見 docs/release-checklist.md）：
//   'plain'  （現在）    users.access_code 存明文。舊版前端（0d6df54）的用戶頁要顯示號碼，所以還不能換。
//                         跟以前一模一樣，只差在系統產生的登入碼變成 10 個字。
//   'hashed' （上線時切） users.access_code_hash 存 PBKDF2 雜湊、明文清掉：
//                         - 登入碼一律系統產生（不能自訂），只在建立 / 重設時回傳一次
//                         - 用戶清單不再回登入碼
//                         - 還沒換成雜湊的舊明文，第一次登入成功時換成雜湊、明文清掉
//
// 雜湊：跟分享連結密碼同一個 PBKDF2-SHA256（sharePassword.mjs 的 hashSharePassword），
//   但登入時只拿到登入碼、不知道是誰 → 不能每個人一個鹽（要一個一個試，每次 5ms 會超過 Workers 的 CPU 上限），
//   所以用「固定的鹽 + 固定次數」算出一樣的雜湊，直接用雜湊查（users.access_code_hash 有唯一索引）。
//   系統產生的登入碼是 10 個字、32 選 1（約 50 bits），就算資料庫外流，一個一個猜也要很久。
//   注意：LOGIN_CODE_SALT / LOGIN_CODE_PBKDF2_ITERATIONS / normalizeLoginCode 一改，所有人的登入碼都會對不上。
//
// 自己設定的登入碼（2026-10 起，兩種存法都收）：規則在 web/src/lib/loginCodeRules.ts（前後台共用同一個檔）。
//   存法跟系統產生的完全一樣（'hashed' 存雜湊、不存明文）。
//   不能跟別人重複：登入是「只憑登入碼」找人，重複了就分不清是誰 → 設定時用「登入查人的同一招」查：
//   算一次雜湊（固定的鹽，約 5ms）→ 拿雜湊去查有唯一索引的 access_code_hash（還沒換成雜湊的舊明文也一起查 access_code），
//   不用一個一個驗證別人的雜湊，所以不會慢，也不會因為「第幾個人」而有時間差。
//   「這個登入碼有人用了」這句話本身等於告訴對方「猜中了」→ 重複會記進 login_attempts（key 是 codeset:<誰>:<IP>），
//   同一個人同一個來源 15 分鐘內撞 10 次就鎖 15 分鐘（跟登入同一套規則，但不會鎖到登入）。

import { hashSharePassword } from './sharePassword.mjs';
import {
  checkCustomCode, CUSTOM_CODE_MIN, CUSTOM_CODE_MAX,
} from '../web/src/lib/loginCodeRules.ts';
export { checkCustomCode, CUSTOM_CODE_MIN, CUSTOM_CODE_MAX };

/** 登入碼用的字（沒有 0 / O / 1 / I；只有大寫，所以也不會有 l）：32 個字，256 % 32 = 0，隨機時不會偏 */
export const LOGIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** 系統產生的登入碼長度 */
export const LOGIN_CODE_LENGTH = 10;
/** 「夠強」的最短長度（舊的自訂號碼可能比較短，上線前的檢查會列出來建議重設） */
export const LOGIN_CODE_MIN_LENGTH = 8;
/** 舊版自訂號碼的長度範圍（只有 'plain' 存法還收自訂號碼，給舊版前端的「自訂」按鈕用） */
export const LEGACY_CUSTOM_CODE_MIN = 4;
export const LEGACY_CUSTOM_CODE_MAX = 32;

/** 固定，不能改（改了所有雜湊都對不上） */
export const LOGIN_CODE_PBKDF2_ITERATIONS = 50000;
const LOGIN_CODE_SALT = 'iVet+ITRpgBs9RgRbRiG5Q==';

/** app_settings 的 key / 值 */
export const LOGIN_CODE_STORAGE_KEY = 'login_code_storage';
export const LOGIN_CODE_STORAGE_HASHED = 'hashed';

/** 資料庫裡的設定值 → 'plain' | 'hashed'（沒設、看不懂的一律當 'plain'） */
export function loginCodeStorageMode(value) {
  return value === LOGIN_CODE_STORAGE_HASHED ? 'hashed' : 'plain';
}

/** 使用者輸入 / 資料庫裡的登入碼 → 比對用的樣子：去掉頭尾和中間的空白、轉大寫（跟以前的登入一樣） */
export function normalizeLoginCode(raw) {
  return (raw ?? '').toString().trim().toUpperCase().replace(/\s+/g, '');
}

/** 產生一組新的登入碼（crypto 隨機） */
export function generateLoginCode(length = LOGIN_CODE_LENGTH, rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))) {
  const bytes = rand(length);
  let s = '';
  for (let i = 0; i < length; i++) s += LOGIN_CODE_ALPHABET[bytes[i] % LOGIN_CODE_ALPHABET.length];
  return s;
}

/** 登入碼的雜湊（同一組登入碼永遠算出同一個字串；查資料庫用） */
export async function hashLoginCode(code) {
  const normalized = normalizeLoginCode(code);
  const { hash } = await hashSharePassword(normalized, { iterations: LOGIN_CODE_PBKDF2_ITERATIONS, salt: LOGIN_CODE_SALT });
  return hash;
}

/** 夠不夠強：至少 8 個字，而且只用上面那些字（系統產生的一定是） */
export function isStrongLoginCode(code) {
  const c = normalizeLoginCode(code);
  if (c.length < LOGIN_CODE_MIN_LENGTH) return false;
  for (const ch of c) if (!LOGIN_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * 舊版前端「自訂號碼」的檢查（只有 'plain' 存法用；'hashed' 一律不收自訂）
 * @returns {{ok: true, code: string} | {ok: false, error: string}}
 */
export function legacyCustomCodeDecision(raw) {
  const code = normalizeLoginCode(raw);
  if (code.length < LEGACY_CUSTOM_CODE_MIN) return { ok: false, error: `自訂登入碼至少 ${LEGACY_CUSTOM_CODE_MIN} 個字` };
  if (code.length > LEGACY_CUSTOM_CODE_MAX) return { ok: false, error: `登入碼太長（最多 ${LEGACY_CUSTOM_CODE_MAX} 個字）` };
  return { ok: true, code };
}

/** 'hashed' 存法時有人送自訂登入碼 → 擋掉的說法 */
export const CUSTOM_CODE_NOT_ALLOWED = '登入碼改成由系統產生，不能自訂。請按「重設」產生新的登入碼';

/**
 * 用戶清單上登入碼要怎麼回給前端
 *   accessCode     — 'plain' 存法才回明文（舊版前端要顯示）；'hashed' 一律 null
 *   hasAccessCode  — 有沒有登入碼（用邀請連結進來的人可能還沒有）
 */
export function userLoginCodeView(row, mode) {
  const plain = typeof row?.access_code === 'string' && row.access_code ? row.access_code : null;
  return {
    accessCode: mode === 'plain' ? plain : null,
    hasAccessCode: !!(plain || row?.access_code_hash),
  };
}

// ─────────────────────────────────────────────
// 自己設定的登入碼
// ─────────────────────────────────────────────

/** 重複了（有人在用）的說法 */
export const CODE_IN_USE_MESSAGE = '這個登入碼已經有人在用了，請換一個';
/** 修改自己的登入碼時，現在的登入碼打錯 */
export const CURRENT_CODE_WRONG_MESSAGE = '現在的登入碼不對，請再確認一次';
export const SAME_AS_CURRENT_MESSAGE = '新的登入碼跟現在的一樣，請換一個';

/**
 * body 裡的登入碼要求（新增用戶、重設、修改自己的）：
 *   沒填 → 系統產生；有填 → 自己設定，要過 loginCodeRules.ts 的硬規則
 * @returns {{ok: true, custom: string|null} | {ok: false, status: number, error: string}}
 */
export function loginCodeRequest(raw) {
  const text = (raw ?? '').toString().trim();
  if (!text) return { ok: true, custom: null };
  const d = checkCustomCode(text);
  return d.ok ? { ok: true, custom: d.code } : { ok: false, status: 400, error: d.error };
}

/** 不看長度、不洩漏哪一個字開始不一樣的字串比較（比對登入碼 / 雜湊用） */
export function safeEqual(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * 這個人現在的登入碼對不對（修改自己的登入碼前要先證明你知道現在的）
 * @param {{access_code?: string|null, access_code_hash?: string|null}} row  users 的一列
 * @param {string} current  使用者輸入
 */
export async function currentCodeMatches(row, current) {
  const code = normalizeLoginCode(current);
  if (!code) return false;
  // 明文存法（或還沒換成雜湊的舊明文）：直接比
  if (typeof row?.access_code === 'string' && row.access_code) return safeEqual(normalizeLoginCode(row.access_code), code);
  if (row?.access_code_hash) return safeEqual(row.access_code_hash, await hashLoginCode(code));
  return false;
}

/** 這個人有登入碼嗎（用邀請連結進來的人可能還沒有；沒有的話改自己的登入碼不用輸入「現在的」） */
export function hasLoginCode(row) {
  return !!(row?.access_code || row?.access_code_hash);
}

/** 防猜紀錄的 key（login_attempts.ip 欄）：誰、從哪裡，在試別人的登入碼 */
export function codeProbeKey(userId, ipKey) {
  return `codeset:${String(userId).slice(0, 64)}:${String(ipKey).slice(0, 64)}`;
}
