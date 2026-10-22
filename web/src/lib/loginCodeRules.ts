// 自己設定登入碼的規則（純判斷）。
//
// 這個檔案前端（新增用戶、重設登入碼、修改我的登入碼的輸入框）和後端（cf-worker/loginCodes.mjs 直接 import 這個 .ts）共用，
// 所以只能放「純判斷」：不 import 別的檔案、不碰 DOM / React、不用 enum / namespace 這類要編譯的寫法。
//
// 硬規則（不過就不能存）：
//   - 6～32 個字，只能用英文字母、數字、連字號（-）；不分大小寫（登入時一律轉大寫，跟系統產生的登入碼一樣）
//   - 不能全部都是同一個字（aaaaaa、111111）
//   - 不能是單純往上或往下數的連續字（123456、abcdef、654321、fedcba）
//   - 不能跟別人的登入碼一樣 —— 這一條要查資料庫，在後端（worker.js）檢查，不在這裡
// 軟提醒（會提醒，但照樣可以存）：
//   - 用名字當登入碼（minamina）、太短（6～7 個字）、只有數字、重複的樣子（abcabc）、常見的字（password、qwerty…）
//   名字不擋：擋名字的話，像 mina 想用 minamina 就用不了；只提醒「比較容易被猜到」，決定權在製作。

export const CUSTOM_CODE_MIN = 6;
export const CUSTOM_CODE_MAX = 32;
/** 建議的長度（比這短只提醒，不擋） */
export const CUSTOM_CODE_COMFORTABLE = 8;

/** 登入時的比對用樣子：去掉頭尾和中間的空白、轉大寫（跟 cf-worker/loginCodes.mjs 的 normalizeLoginCode 一模一樣） */
export function normalizeCode(raw: unknown): string {
  return (raw ?? '').toString().trim().toUpperCase().replace(/\s+/g, '');
}

export type CustomCodeCheck =
  | { ok: true; code: string; warnings: string[] }
  | { ok: false; code: string; error: string };

const ALLOWED = /^[A-Z0-9-]+$/;

/** 全部都是同一個字：aaaaaa、111111、------ */
export function isAllSameChar(code: string): boolean {
  return code.length > 1 && [...code].every(ch => ch === code[0]);
}

/** 單純往上或往下數：123456、abcdef、654321、fedcba（每個字跟前一個差剛好 1；中間有連字號就不算） */
export function isPlainSequence(code: string): boolean {
  if (code.length < 2) return false;
  let up = true;
  let down = true;
  for (let i = 1; i < code.length; i++) {
    const d = code.charCodeAt(i) - code.charCodeAt(i - 1);
    if (d !== 1) up = false;
    if (d !== -1) down = false;
  }
  if (!up && !down) return false;
  return /^[A-Z0-9]+$/.test(code);
}

/** 一小段重複好幾次：abcabc、123123、ababab 算（至少重複 2 次，整串剛好湊滿；全部同一個字的在硬規則就擋掉了） */
export function isRepeatedChunk(code: string): boolean {
  const n = code.length;
  for (let size = 1; size <= n / 2; size++) {
    if (n % size !== 0) continue;
    const unit = code.slice(0, size);
    if (unit.repeat(n / size) === code) return true;
  }
  return false;
}

/** 常見、太好猜的（不分大小寫；只提醒，不擋） */
const COMMON_WEAK = new Set([
  '123123', '112233', '121212', '111222', '123321', '123123123', '000111', '654123', '987654321', '1234567', '12345678',
  '123456789', '1234567890', '0123456789', '1q2w3e', '1q2w3e4r', 'QWERTY', 'QWERTY123', 'QWERTYUIOP', 'ASDFGH', 'ASDFGHJKL', 'ZXCVBN',
  'PASSWORD', 'PASSW0RD', 'PASSWORD1', 'ADMIN', 'ADMIN123', 'ABC123', 'ABCD1234', '1234ABCD', 'A1B2C3', 'LETMEIN', 'WELCOME',
  'ILOVEYOU', 'STAGE', 'STAGE123', 'STAGEPREVIZ', 'PREVIZ', 'PREVIZ123',
].map(s => s.toUpperCase()));

/** 名字 → 拿來比對的字（只留英文字母和數字、轉大寫；中文名字不會出現在登入碼裡，不用比） */
function nameKeys(name: string | null | undefined): string[] {
  if (!name) return [];
  const keys = new Set<string>();
  const whole = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (whole.length >= 2) keys.add(whole);
  for (const word of name.toUpperCase().split(/[^A-Z0-9]+/)) {
    if (word.length >= 3) keys.add(word);
  }
  return [...keys];
}

/** 登入碼裡有名字（minamina 含 mina）→ true */
export function containsName(code: string, name: string | null | undefined): boolean {
  const plain = code.replace(/-/g, '');
  return nameKeys(name).some(k => plain.includes(k));
}

/**
 * 檢查自己設定的登入碼
 * @param raw   使用者輸入（可以有空白、小寫，會先整理成比對用的樣子）
 * @param opts.name  這組登入碼是誰的（有給才會提醒「用名字」）
 */
export function checkCustomCode(raw: unknown, opts: { name?: string | null } = {}): CustomCodeCheck {
  const code = normalizeCode(raw);
  const bad = (error: string): CustomCodeCheck => ({ ok: false, code, error });
  if (!code) return bad('請輸入登入碼');
  if (code.length < CUSTOM_CODE_MIN) return bad(`登入碼至少 ${CUSTOM_CODE_MIN} 個字`);
  if (code.length > CUSTOM_CODE_MAX) return bad(`登入碼最多 ${CUSTOM_CODE_MAX} 個字`);
  if (!ALLOWED.test(code)) return bad('登入碼只能用英文字母、數字和連字號（-）');
  if (isAllSameChar(code)) return bad('登入碼不能全部都是同一個字（像 aaaaaa、111111），太容易被猜到');
  if (isPlainSequence(code)) return bad('登入碼不能是連續的字（像 123456、abcdef、654321），太容易被猜到');

  const warnings: string[] = [];
  if (containsName(code, opts.name)) warnings.push('用名字當登入碼比較容易被猜到');
  if (code.length < CUSTOM_CODE_COMFORTABLE) warnings.push(`只有 ${code.length} 個字，別人比較容易猜到，建議 ${CUSTOM_CODE_COMFORTABLE} 個字以上`);
  if (/^[0-9]+$/.test(code)) warnings.push('只有數字比較容易被猜到，混一些英文字母會更安全');
  if (COMMON_WEAK.has(code)) warnings.push('這是很常見的登入碼，別人容易猜到');
  // 已經提醒過「用名字」就不再多唸一句重複（minamina 這種）
  else if (isRepeatedChunk(code) && !warnings.some(w => w.includes('名字'))) warnings.push('一小段重複幾次比較容易被猜到');
  return { ok: true, code, warnings };
}

/** 有提醒時，輸入框下面的總結（每一條提醒另外列） */
export const WEAK_CODE_SUMMARY = '太短或太好猜（像 123456、名字）別人容易猜到';
