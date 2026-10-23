// 製作「用其他身分看」：用導演 / 動畫師的眼睛看自己的專案（純邏輯，畫面在 viewAsContext.tsx、ViewAsBanner.tsx、ViewAsMenu.tsx）。
//
//   /preview/<專案>?as=director              導演頁，看到的跟導演一樣
//   /studio/<專案>?as=animator               動畫師工作站，看到的跟動畫師一樣（還沒指派歌的動畫師）
//   /studio/<專案>?as=animator&user=<id>     看某個動畫師：「我的」只有指派給他的歌
//
// 規則：
//   - 只有帳號是製作（admin），或「這個專案的製作」（專案裡的角色是製作）才算數；別人在網址加 ?as= 一律當沒加（不會因此多看到什麼，也不會少）
//   - 預覽一律「只能看」：按鈕照樣出現（看得到真的版面），但按不下去，滑上去寫「預覽模式只能看」；
//     萬一有漏掉的按鈕，送出去的寫入請求也會在瀏覽器這邊被擋下來（installWriteGuard），不會改到資料
//   - 只在這台電腦的動作照常：播影片、換版本、A/B 比較、本地檔案、轉攝影機、下載 LED 對位圖、AE 即時

import type { ProjectRole } from './mockData';

export type ViewAsRole = 'director' | 'animator';

export interface ViewAs {
  /** 用哪個角色看 */
  previewRole: ViewAsRole;
  /** 看哪個動畫師（只有 animator 才有；null = 還沒指派歌的動畫師） */
  previewUserId: string | null;
  /** 預覽一律只能看 */
  readOnly: true;
}

/** 按不下去的按鈕滑上去的字 */
export const VIEW_AS_READ_ONLY_TIP = '預覽模式只能看';
/** 按了之後（或被擋下來的請求）的說明 */
export const VIEW_AS_BLOCKED_MESSAGE = '預覽模式只能看，不會改到資料';

const USER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * 網址參數 → 預覽設定；不是製作、沒有 / 看不懂 ?as= → null（照平常）。
 * projectRole = 這個人在網址上這個專案裡的角色（專案的製作：帳號不是全站製作，但在這個專案是製作）
 */
export function parseViewAs(
  search: string | URLSearchParams,
  accountRole: string | null | undefined,
  projectRole?: string | null,
): ViewAs | null {
  if (accountRole !== 'admin' && projectRole !== 'admin') return null;
  const p = typeof search === 'string' ? new URLSearchParams(search) : search;
  const as = p.get('as');
  if (as !== 'director' && as !== 'animator') return null;
  const rawUser = as === 'animator' ? (p.get('user') || '').trim() : '';
  return { previewRole: as, previewUserId: USER_ID_RE.test(rawUser) ? rawUser : null, readOnly: true };
}

/** 預覽頁的網址（導演 → 導演頁；動畫師 → 工作站） */
export function viewAsPath(projectId: string, role: ViewAsRole, userId?: string | null): string {
  const q = new URLSearchParams({ as: role });
  if (role === 'animator' && userId && USER_ID_RE.test(userId)) q.set('user', userId);
  return `${role === 'director' ? '/preview' : '/studio'}/${encodeURIComponent(projectId)}?${q.toString()}`;
}

/** 「回到編輯」 */
export function editorPath(projectId: string): string {
  return `/admin/projects/${encodeURIComponent(projectId)}`;
}

export interface ViewAsPerson { id: string; name: string; avatarColor?: string }

/**
 * 預覽時畫面上的「我」：角色換成預覽的角色；看某個動畫師 → 換成那個人（名字、id）。
 * 按鈕、權限（songReview.ts、songVersions.ts、commentThreads.ts）都拿這個算，就跟那個人看到的一樣。
 */
export function viewAsIdentity<U extends { id: string; name: string; role: string; avatarColor: string }>(
  user: U, viewAs: ViewAs, person?: ViewAsPerson | null,
): U {
  return {
    ...user,
    role: viewAs.previewRole,
    id: person?.id ?? user.id,
    name: person?.name ?? user.name,
    avatarColor: person?.avatarColor ?? user.avatarColor,
  };
}

/** 預覽時「我在這個專案的角色」（按鈕看這個） */
export function viewAsProjectRole(viewAs: ViewAs | null, real: ProjectRole | null): ProjectRole | null {
  return viewAs ? viewAs.previewRole : real;
}

/** 上面那條橫幅的字 */
export function viewAsBannerText(role: ViewAsRole, personName?: string | null): string {
  if (role === 'director') return '預覽：導演看到的畫面（只能看，不會改到資料）';
  if (personName) return `預覽：動畫師「${personName}」看到的畫面（只能看，不會改到資料）`;
  return '預覽：動畫師看到的畫面（還沒指派歌的動畫師；只能看，不會改到資料）';
}

/** 手機上比較短的寫法 */
export function viewAsBannerShortText(role: ViewAsRole, personName?: string | null): string {
  if (role === 'director') return '預覽：導演的畫面（只能看）';
  if (personName) return `預覽：動畫師「${personName}」（只能看）`;
  return '預覽：動畫師的畫面（只能看）';
}

/**
 * 換成動畫師時預設看誰：網址上原本那個人（還在專案裡的話）→ 有指派歌的第一個動畫師 → 第一個動畫師 → 沒有人
 * animators 照專案成員的順序；songs 只要 animatorUserId
 */
export function defaultAnimatorId(
  animators: readonly { id: string }[],
  songs: readonly { animatorUserId: string | null }[] = [],
  preferred?: string | null,
): string | null {
  if (preferred && animators.some(a => a.id === preferred)) return preferred;
  const assigned = new Set(songs.map(s => s.animatorUserId).filter(Boolean));
  return animators.find(a => assigned.has(a.id))?.id ?? animators[0]?.id ?? null;
}

// ─── 客戶畫面（分享連結） ───

export interface ShareLinkLike {
  token: string;
  slug?: string | null;
  songId: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * 「客戶畫面」要開哪一個分享連結：還沒過期的裡面最新的；整個專案的連結優先（客戶多半拿到的是整個專案的），
 * 沒有才用單首歌的。都沒有 → null。parseTime = 伺服器時間 → 毫秒（serverTime.ts 的 parseServerTime）
 */
export function pickClientShareLink<L extends ShareLinkLike>(
  links: readonly L[], now: number, parseTime: (s: string) => number,
): L | null {
  const active = links.filter(l => !l.expiresAt || !(parseTime(l.expiresAt) < now));
  const newest = (list: L[]) => list.reduce<L | null>((best, l) => {
    if (!best) return l;
    const a = parseTime(l.createdAt), b = parseTime(best.createdAt);
    return (Number.isFinite(a) ? a : -Infinity) > (Number.isFinite(b) ? b : -Infinity) ? l : best;
  }, null);
  return newest(active.filter(l => !l.songId)) ?? newest(active);
}

// ─── 只能看：瀏覽器這邊擋下寫入的請求（萬一有漏掉的按鈕也改不到資料） ───

/**
 * 這個請求要不要擋：GET / HEAD / OPTIONS（讀資料）放行；其他（POST / PUT / PATCH / DELETE）一律擋，除了
 *   - 登出（不算改資料）
 *   - 畫面出錯的回報（/api/client-errors：只是錯誤紀錄，預覽本身出問題時製作才查得到）
 */
export function isBlockedWrite(method: string | null | undefined, url: string): boolean {
  const m = (method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false;
  let path = url;
  try { path = new URL(url, 'http://x').pathname; } catch { /* 用原本的字串 */ }
  if (/\/api\/(auth\/logout|client-errors)\/?$/.test(path)) return false;
  return true;
}

/** 被擋下來的請求丟的錯誤（status 0：不是後台回的） */
export function blockedWriteError(): Error & { status: number; viewAsBlocked: true } {
  const e = new Error(VIEW_AS_BLOCKED_MESSAGE) as Error & { status: number; viewAsBlocked: true };
  e.status = 0;
  e.viewAsBlocked = true;
  return e;
}

interface GuardTarget {
  fetch?: typeof fetch;
  XMLHttpRequest?: { prototype: XMLHttpRequest };
}

/**
 * 預覽開著時把 fetch / XMLHttpRequest 的寫入請求擋下來（不會送到網路上）；回傳「拿掉」的函式（離開預覽時叫）。
 * onBlocked：每擋一個叫一次（記一筆 console，方便查是哪個按鈕漏掉了）
 */
export function installWriteGuard(target: GuardTarget = globalThis as GuardTarget, onBlocked?: (method: string, url: string) => void): () => void {
  const undo: (() => void)[] = [];

  const origFetch = target.fetch;
  if (typeof origFetch === 'function') {
    const guarded = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET');
      if (isBlockedWrite(method, url)) {
        onBlocked?.(String(method).toUpperCase(), url);
        return Promise.reject(blockedWriteError());
      }
      return origFetch.call(this ?? target, input, init);
    } as typeof fetch;
    target.fetch = guarded;
    undo.push(() => { if (target.fetch === guarded) target.fetch = origFetch; });
  }

  const proto = target.XMLHttpRequest?.prototype as (XMLHttpRequest & { __viewAsReq?: { method: string; url: string } }) | undefined;
  if (proto && typeof proto.open === 'function' && typeof proto.send === 'function') {
    const origOpen = proto.open;
    const origSend = proto.send;
    const open = function (this: XMLHttpRequest & { __viewAsReq?: { method: string; url: string } }, method: string, url: string | URL, ...rest: unknown[]) {
      this.__viewAsReq = { method: String(method), url: String(url) };
      return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
    };
    const send = function (this: XMLHttpRequest & { __viewAsReq?: { method: string; url: string } }, body?: Document | XMLHttpRequestBodyInit | null) {
      const req = this.__viewAsReq;
      if (req && isBlockedWrite(req.method, req.url)) {
        onBlocked?.(req.method.toUpperCase(), req.url);
        throw blockedWriteError();
      }
      return origSend.call(this, body);
    };
    proto.open = open as typeof proto.open;
    proto.send = send as typeof proto.send;
    undo.push(() => {
      if (proto.open === open) proto.open = origOpen;
      if (proto.send === send) proto.send = origSend;
    });
  }

  return () => { for (const u of undo.reverse()) u(); };
}
