// 前端錯誤回報：畫面上沒接到的錯誤（window error / unhandledrejection）送到後台，製作在「設定 → 系統狀態」看得到。
//
// - 一頁最多送 10 則；同一個錯誤（訊息 + stack 第一行一樣）只送一次
// - 只送：訊息、stack、網址的路徑（不含 ? 和 # 後面；分享連結碼 / 邀請碼遮掉，後台也會再遮一次）、前端版本
//   有登入就帶登入狀態，後台自己認是誰（只記 user id）
// - 只在正式版送（npm run dev 不送）；送失敗就算了，不會再報錯
// 後台：cf-worker/clientErrors.mjs（POST /api/client-errors）
import { apiBase, getSessionToken } from './api';
import { version as APP_VERSION } from '../../package.json';

export const MAX_REPORTS_PER_PAGE = 10;

export interface ClientErrorReport {
  message: string;
  stack?: string;
  path: string;
  appVersion: string;
}

const SECRET_AFTER = new Set(['share', 's', 'invite']);

/** 網址 → 路徑（拿掉 ? # 後面；/share/<碼>、/s/<名稱>、/invite/<碼> 的碼遮掉） */
export function reportPath(href: string): string {
  let path = '/';
  try {
    path = new URL(href, 'https://x.invalid').pathname || '/';
  } catch {
    path = String(href || '/').split(/[?#]/)[0] || '/';
  }
  const segs = path.split('/');
  for (let i = 1; i < segs.length; i++) {
    if (segs[i] && SECRET_AFTER.has(segs[i - 1])) segs[i] = ':token';
  }
  return segs.join('/').slice(0, 300);
}

/** 錯誤（Error / 字串 / 其他）→ 訊息 + stack；拿不到東西 → null */
export function describeError(value: unknown, fallbackMessage = ''): { message: string; stack?: string; name?: string } | null {
  if (value instanceof Error) {
    const name = value.name || 'Error';
    const msg = value.message || fallbackMessage;
    return { message: msg ? `${name}: ${msg}` : name, stack: value.stack || undefined, name };
  }
  if (typeof value === 'string' && value.trim()) return { message: value.trim() };
  if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
    const v = value as { message: string; name?: unknown; stack?: unknown };
    return {
      message: v.message,
      stack: typeof v.stack === 'string' ? v.stack : undefined,
      name: typeof v.name === 'string' ? v.name : undefined,
    };
  }
  if (fallbackMessage.trim()) return { message: fallbackMessage.trim() };
  return null;
}

/** 不用送的：跨網站腳本看不到內容的「Script error.」、瀏覽器擴充功能、使用者自己取消的請求、ResizeObserver 的提醒 */
export function shouldIgnore(info: { message: string; stack?: string; name?: string }, source = ''): boolean {
  const msg = info.message || '';
  if (/^script error\.?$/i.test(msg.trim())) return true;
  if (info.name === 'AbortError' || /^AbortError\b/.test(msg)) return true;
  if (/ResizeObserver loop/i.test(msg)) return true;
  const where = `${source}\n${info.stack || ''}`;
  if (/(chrome|moz|safari(-web)?)-extension:\/\//i.test(where)) return true;
  return false;
}

/** 同一個錯誤：訊息 + stack 第一個有位置的那一行 */
export function errorKey(info: { message: string; stack?: string }): string {
  const frame = (info.stack || '').split('\n').map(s => s.trim()).find(s => /:\d+:\d+\)?$/.test(s)) || '';
  return `${info.message}|${frame}`;
}

export interface ReporterOptions {
  send: (report: ClientErrorReport) => void;
  getHref: () => string;
  appVersion?: string;
  max?: number;
}

/** 去重 + 一頁最多 10 則（純邏輯，測試用；installErrorReporting 接上 window） */
export function createErrorReporter({ send, getHref, appVersion = APP_VERSION, max = MAX_REPORTS_PER_PAGE }: ReporterOptions) {
  const seen = new Set<string>();
  let sent = 0;
  function report(value: unknown, { fallbackMessage = '', source = '' } = {}): boolean {
    if (sent >= max) return false;
    const info = describeError(value, fallbackMessage);
    if (!info || shouldIgnore(info, source)) return false;
    const key = errorKey(info);
    if (seen.has(key)) return false;
    seen.add(key);
    sent++;
    try {
      send({
        message: info.message.slice(0, 500),
        stack: info.stack ? info.stack.slice(0, 4000) : undefined,
        path: reportPath(getHref()),
        appVersion,
      });
    } catch { /* 送不出去就算了 */ }
    return true;
  }
  return {
    report,
    onError(e: Pick<ErrorEvent, 'error' | 'message' | 'filename'>) {
      report(e.error, { fallbackMessage: e.message || '', source: e.filename || '' });
    },
    onRejection(e: Pick<PromiseRejectionEvent, 'reason'>) {
      report(e.reason, { fallbackMessage: 'Unhandled rejection' });
    },
    get sentCount() { return sent; },
  };
}

/** 送到後台（有登入就帶登入狀態；不等回應、失敗不管） */
export function sendClientError(report: ClientErrorReport): void {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getSessionToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  fetch(`${apiBase()}/api/client-errors`, {
    method: 'POST',
    headers,
    body: JSON.stringify(report),
    credentials: 'omit',
  }).catch(() => { /* 網路斷了就算了 */ });
}

type EventTargetLike = Pick<Window, 'addEventListener' | 'removeEventListener'> & { location: { href: string } };
type Reporter = ReturnType<typeof createErrorReporter>;

// 這一頁共用的一個（window 的錯誤和 ErrorBoundary 接到的錯誤一起算「一頁最多 10 則」、一起去重）
let pageReporter: Reporter | null = null;
function getPageReporter(): Reporter {
  if (!pageReporter) pageReporter = createErrorReporter({ send: sendClientError, getHref: () => window.location.href });
  return pageReporter;
}

/** 畫面元件崩潰（ErrorBoundary 接到的）→ 要送的內容：元件的位置接在 stack 後面，看得出是哪個畫面 */
export function renderErrorValue(error: unknown, componentStack?: string | null): unknown {
  const comp = (componentStack || '').trim();
  if (!comp || !(error instanceof Error)) return error;
  const e = new Error(error.message);
  e.name = error.name;
  e.stack = `${error.stack || `${error.name}: ${error.message}`}\nComponent stack:\n${comp}`;
  return e;
}

/**
 * ErrorBoundary 接到的錯誤（畫面崩潰時 window 收不到）也回報；只在正式版送。
 * @returns 有沒有送出去（測試用）
 */
export function reportRenderError(
  error: unknown,
  componentStack?: string | null,
  opts: { enabled?: boolean; report?: (value: unknown) => boolean } = {},
): boolean {
  const enabled = opts.enabled ?? import.meta.env.PROD;
  if (!enabled) return false;
  const report = opts.report ?? ((v: unknown) => getPageReporter().report(v));
  try { return report(renderErrorValue(error, componentStack)); } catch { return false; }
}

/** 接上 window；回傳拆掉的函式 */
export function installErrorReporting(target: EventTargetLike = window, send: (r: ClientErrorReport) => void = sendClientError) {
  const reporter = (typeof window !== 'undefined' && target === window && send === sendClientError)
    ? getPageReporter()
    : createErrorReporter({ send, getHref: () => target.location.href });
  const onError = (e: Event) => reporter.onError(e as ErrorEvent);
  const onRejection = (e: Event) => reporter.onRejection(e as PromiseRejectionEvent);
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

// main.tsx 只要 import 這個檔就會接上（正式版才接）
if (typeof window !== 'undefined' && import.meta.env.PROD) installErrorReporting();
