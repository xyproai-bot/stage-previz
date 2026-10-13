// 分享連結的「好讀網址」（/s/jinma2026-k7p2）規則：檢查、產生、組合。
//
// 這個檔案前端（ShareLinksDialog）和後端（cf-worker/worker.js 直接 import 這個 .ts）共用，
// 所以只能放「純判斷」：不 import 別的檔案、不碰 DOM / React、不用 enum / namespace 這類要編譯的寫法。
//
// 規則：
//   - 只能用英文小寫 a–z、數字 0–9 和「-」，3～40 個字，開頭要是英文或數字、結尾不能是「-」
//   - 系統保留字（admin、api、share、s、login、new…）不能用
//   - 不能長得像舊式連結碼（32 個 0-9a-f）→ 兩種網址永遠分得開
//   - 預設 = 名稱 + 「-」+ 4 個隨機字（字母表拿掉 0/o、1/l/i 這些容易看錯的）

export const SLUG_MIN_LEN = 3;
export const SLUG_MAX_LEN = 40;
export const SLUG_SUFFIX_LEN = 4;
/** 隨機碼用的字（沒有 0 o 1 l i，念給別人聽 / 抄寫不會搞混） */
export const SLUG_SUFFIX_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
/** 名稱整個轉不出英文數字時（例如全中文）用這個當開頭 */
export const SLUG_FALLBACK_BASE = 'stage';

/** 不能當網址名稱的字（路由、系統用字、容易誤會的字） */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'admin', 'api', 'app', 'assets', 'auth', 'create', 'delete', 'edit', 'help',
  'login', 'logout', 'new', 'null', 'preview', 'public', 'r2', 'root', 's',
  'settings', 'share', 'shares', 'signin', 'signup', 'static', 'studio',
  'system', 'undefined', 'www',
]);

export type SlugProblem =
  | 'empty'
  | 'too_short'
  | 'too_long'
  | 'bad_chars'
  | 'bad_start'
  | 'bad_end'
  | 'reserved'
  | 'looks_like_token';

const SHARE_TOKEN_RE = /^[0-9a-f]{32}$/;

/** 舊式連結碼的樣子（建立連結時產生的 32 個 0-9a-f） */
export function looksLikeShareToken(s: string): boolean {
  return SHARE_TOKEN_RE.test(s);
}

/**
 * 使用者打的字 → 先整理成網址名稱的樣子（不會把不合法的字偷偷刪掉，留給 slugProblem 說哪裡不對）：
 * 全形轉半形、大寫轉小寫、前後空白去掉、中間的空白 / 底線變成「-」
 */
export function normalizeSlugInput(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFKC').trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/** 已經整理過的網址名稱哪裡不對；沒問題回 null */
export function slugProblem(slug: string): SlugProblem | null {
  if (!slug) return 'empty';
  if (slug.length < SLUG_MIN_LEN) return 'too_short';
  if (slug.length > SLUG_MAX_LEN) return 'too_long';
  if (!/^[a-z0-9-]+$/.test(slug)) return 'bad_chars';
  if (!/^[a-z0-9]/.test(slug)) return 'bad_start';
  if (slug.endsWith('-')) return 'bad_end';
  if (RESERVED_SLUGS.has(slug)) return 'reserved';
  if (looksLikeShareToken(slug)) return 'looks_like_token';
  return null;
}

export function isValidSlug(slug: string): boolean {
  return slugProblem(slug) === null;
}

/** 給使用者看的話 */
export function slugProblemMessage(problem: SlugProblem, slug = ''): string {
  switch (problem) {
    case 'empty': return '請輸入網址名稱';
    case 'too_short': return `太短了，至少要 ${SLUG_MIN_LEN} 個字`;
    case 'too_long': return `太長了，最多 ${SLUG_MAX_LEN} 個字`;
    case 'bad_chars': return '只能用英文小寫、數字和「-」，不能有中文或其他符號';
    case 'bad_start': return '開頭要是英文或數字';
    case 'bad_end': return '結尾不能是「-」';
    case 'reserved': return `「${slug}」是系統用字，請換一個`;
    case 'looks_like_token': return '這個長得像舊式的連結碼，請換一個';
  }
}

/**
 * 從名稱（專案名、歌名）做出網址名稱的開頭：
 * 「Golden Horse 2026」→ golden-horse-2026；「金馬 2026」→ 2026；全中文 → stage
 * 會切到 maxLen 以內（預設留位置給「-」+ 4 個隨機字）
 */
export function slugBaseFromName(name: string, maxLen = SLUG_MAX_LEN - SLUG_SUFFIX_LEN - 1): string {
  const base = (typeof name === 'string' ? name : '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // é → e
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = base.slice(0, Math.max(1, maxLen)).replace(/-+$/, '');
  return cut || SLUG_FALLBACK_BASE;
}

type RandomBytes = (n: number) => Uint8Array;

const defaultRandomBytes: RandomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

/** 4 個隨機字（每個字機率一樣：超出整除範圍的亂數丟掉重抽） */
export function randomSlugSuffix(randomBytes: RandomBytes = defaultRandomBytes, len = SLUG_SUFFIX_LEN): string {
  const alphabet = SLUG_SUFFIX_ALPHABET;
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b >= limit) continue;
      out += alphabet[b % alphabet.length];
      if (out.length >= len) break;
    }
  }
  return out;
}

/** 名稱 +（可選）隨機碼 → 完整網址名稱；名稱太長會先切短，確保加上隨機碼後不超過上限 */
export function composeSlug(base: string, suffix: string | null | undefined): string {
  const b = normalizeSlugInput(base);
  if (!suffix) return b;
  const room = SLUG_MAX_LEN - suffix.length - 1;
  const trimmed = b.slice(0, Math.max(0, room)).replace(/-+$/, '');
  return trimmed ? `${trimmed}-${suffix}` : suffix;
}

/**
 * 已存在的網址名稱拆回「名稱 + 隨機碼」（編輯時用：jinma2026-k7p2 → jinma2026 + k7p2）。
 * 最後一段剛好是 4 個隨機碼用字才拆；拆不出來 → suffix = null（整串都當名稱）
 */
export function splitSlug(slug: string): { base: string; suffix: string | null } {
  const m = new RegExp(`^(.+)-([${SLUG_SUFFIX_ALPHABET}]{${SLUG_SUFFIX_LEN}})$`).exec(slug);
  if (m) return { base: m[1], suffix: m[2] };
  return { base: slug, suffix: null };
}
