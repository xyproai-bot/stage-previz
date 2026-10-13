// 伺服器時間 → 畫面上的時間
//
// 後台（D1 / SQLite）存的時間大多是 datetime('now') 寫的：'2026-10-13 10:21:30'
// —— 這是 UTC，但字串裡沒寫時區。瀏覽器的 new Date('2026-10-13 10:21:30') 會當成「本地時間」，
// 台灣就整整差 8 小時（剛改的東西顯示「8 小時前」）。
// 有些欄位是 JS 的 toISOString()（結尾有 Z）或 Google Drive 給的（Z / +08:00），那些照原本時區讀。
//
// 用法：
//   parseServerTime(s)      → 毫秒（讀不懂回 NaN）
//   formatRelativeTime(s)   → 剛剛 / 5 分鐘前 / 3 小時前 / 2 天前 / 10/3
//   formatDateTime(s)       → 2026/10/13 18:21（本地時間）
//   formatDate(s)           → 2026/10/13

/** 結尾有時區：Z、+08:00、+0800、+08 */
const HAS_ZONE_RE = /(?:[zZ]|[+-]\d\d(?::?\d\d)?)$/;
/** 只有日期：2026-10-13 */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 伺服器時間字串 → 毫秒（epoch ms）。
 * 沒寫時區的一律當 UTC；有寫的照寫的讀。數字當成已經是毫秒。空的 / 讀不懂 → NaN。
 */
export function parseServerTime(s: string | number | null | undefined): number {
  if (typeof s === 'number') return Number.isFinite(s) ? s : NaN;
  if (typeof s !== 'string') return NaN;
  const t = s.trim();
  if (!t) return NaN;
  if (DATE_ONLY_RE.test(t)) return Date.parse(t + 'T00:00:00Z');
  const iso = t.replace(' ', 'T');
  return Date.parse(HAS_ZONE_RE.test(iso) ? iso : iso + 'Z');
}

/** 伺服器時間 → Date；讀不懂回 null */
export function serverDate(s: string | number | null | undefined): Date | null {
  const ms = parseServerTime(s);
  return Number.isNaN(ms) ? null : new Date(ms);
}

export interface FormatOptions {
  /** 現在時間（測試用） */
  now?: number;
  /** 指定時區（測試用；不給 = 這台電腦的時區） */
  timeZone?: string;
}

/**
 * 多久以前：剛剛 / N 分鐘前 / N 小時前 / N 天前（7 天內）/ 再久就寫日期（10/3；不是今年加年份）。
 * 讀不懂的字串原樣回傳（空的回空字串）。未來的時間（電腦時鐘不準）當「剛剛」。
 */
export function formatRelativeTime(s: string | number | null | undefined, opts: FormatOptions = {}): string {
  const ms = parseServerTime(s);
  if (Number.isNaN(ms)) return typeof s === 'string' ? s : '';
  const now = opts.now ?? Date.now();
  const sec = (now - ms) / 1000;
  if (sec < 60) return '剛剛';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  const d = new Date(ms);
  const sameYear = yearIn(d, opts.timeZone) === yearIn(new Date(now), opts.timeZone);
  return d.toLocaleDateString('zh-TW', {
    ...(sameYear ? {} : { year: 'numeric' as const }),
    month: 'numeric',
    day: 'numeric',
    timeZone: opts.timeZone,
  });
}

/** 日期 + 時間（本地時間，24 小時制）：2026/10/13 18:21。讀不懂原樣回傳 */
export function formatDateTime(s: string | number | null | undefined, opts: FormatOptions = {}): string {
  const ms = parseServerTime(s);
  if (Number.isNaN(ms)) return typeof s === 'string' ? s : '';
  return new Date(ms).toLocaleString('zh-TW', {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZone: opts.timeZone,
  }).replace(/\s+/g, ' '); // 有的瀏覽器日期和時間中間是特殊空白，統一成一般空白
}

/** 只有日期（本地時間）：2026/10/13。讀不懂原樣回傳 */
export function formatDate(s: string | number | null | undefined, opts: FormatOptions = {}): string {
  const ms = parseServerTime(s);
  if (Number.isNaN(ms)) return typeof s === 'string' ? s : '';
  return new Date(ms).toLocaleDateString('zh-TW', {
    year: 'numeric', month: 'numeric', day: 'numeric',
    timeZone: opts.timeZone,
  });
}

function yearIn(d: Date, timeZone?: string): string {
  return d.toLocaleDateString('en-US', { year: 'numeric', timeZone });
}
