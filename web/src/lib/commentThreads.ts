// 留言串（審片 v2）：一則留言 + 底下的回覆（一層）、綁哪一版、「這一版 / 全部」篩選、誰能標「已改好」。
// 規則跟後台 cf-worker/access.mjs（commentPostDecision / commentResolveDecision / commentReopenDecision）一樣，
// 後台才是最後把關；這裡只決定畫面上出現什麼。純函式（commentThreads.test.ts 有測）。

import type { SongComment } from './api';
import type { ProjectRole } from './mockData';

export interface CommentThread {
  root: SongComment;
  /** 回覆（舊的在前） */
  replies: SongComment[];
}

/** 「這一版」只看正在看的那一版相關的；「全部」所有留言（含沒綁版本的舊留言） */
export type CommentScope = 'version' | 'all';

/** 正在看的那一版（舊的 Drive 影片沒有版本號 → null） */
export interface ViewedVersion {
  id: string;
  version: number;
}

/** 把留言整理成串：最上面一則 + 回覆。回覆的那則不見了（被刪）→ 當成一般留言 */
export function buildThreads(comments: readonly SongComment[]): CommentThread[] {
  const ids = new Set(comments.map(c => c.id));
  const roots: CommentThread[] = [];
  const byRoot = new Map<string, CommentThread>();
  for (const c of comments) {
    if (c.parentId && ids.has(c.parentId)) continue;
    const t = { root: c, replies: [] as SongComment[] };
    roots.push(t);
    byRoot.set(c.id, t);
  }
  for (const c of comments) {
    if (!c.parentId || !ids.has(c.parentId)) continue;
    const t = byRoot.get(c.parentId);
    if (t) t.replies.push(c);
    else {
      // 回覆的回覆（後台會攤平，這裡保險）：找最上面那則
      const parent = comments.find(x => x.id === c.parentId);
      const top = parent?.parentId ? byRoot.get(parent.parentId) : undefined;
      if (top) top.replies.push(c);
      else roots.push({ root: c, replies: [] });
    }
  }
  for (const t of roots) t.replies.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return roots;
}

/** 這首歌有版本 → 預設「這一版」；沒有 → 「全部」 */
export function defaultScope(hasVersions: boolean): CommentScope {
  return hasVersions ? 'version' : 'all';
}

export interface ScopedThread extends CommentThread {
  /** 灰掉（這一版或之前已經改好了） */
  greyed: boolean;
  /** 之前版本的留言，還沒改好 → 帶到這一版（或在這一版改好的） */
  carried: boolean;
}

/**
 * 「這一版」（正在看 Vn）要出現哪些留言：
 *   - 在 Vn 留的 → 出現；已經改好了就灰掉
 *   - 之前版本留的、還沒改好（或是之後的版本才改好）→ 帶過來
 *   - 之前版本留的、在 Vn 改好的 → 灰掉出現（看一下是不是真的改好了）
 *   - 更早就改好的、之後版本留的、沒綁版本的舊留言 → 只在「全部」看得到
 * 「全部」：全部出現，已解決的灰掉。
 */
export function scopeThreads(threads: readonly CommentThread[], scope: CommentScope, viewed: ViewedVersion | null): ScopedThread[] {
  const out: ScopedThread[] = [];
  for (const t of threads) {
    const c = t.root;
    const resolved = c.status === 'resolved';
    if (scope === 'all' || !viewed) {
      out.push({ ...t, greyed: resolved, carried: false });
      continue;
    }
    const v = c.videoVersion;
    const n = viewed.version;
    if (v == null || v > n) continue;
    if (v === n) {
      const fixedByNow = resolved && (c.resolvedVersion == null || c.resolvedVersion <= n);
      out.push({ ...t, greyed: fixedByNow, carried: false });
      continue;
    }
    if (!resolved || (c.resolvedVersion != null && c.resolvedVersion > n)) {
      out.push({ ...t, greyed: false, carried: true });
    } else if (c.resolvedVersion === n) {
      out.push({ ...t, greyed: true, carried: true });
    }
  }
  return out;
}

/** 留言上的小標籤：'V2'；沒綁版本的舊留言 = null */
export function versionChip(c: Pick<SongComment, 'videoVersion'>): string | null {
  return typeof c.videoVersion === 'number' && c.videoVersion > 0 ? `V${c.videoVersion}` : null;
}

/** 已解決的字：「已改好（V3）」；舊資料沒有版本 → 「已改好」 */
export function resolvedLabel(c: Pick<SongComment, 'status' | 'resolvedVersion'>): string | null {
  if (c.status !== 'resolved') return null;
  return typeof c.resolvedVersion === 'number' && c.resolvedVersion > 0 ? `已改好（V${c.resolvedVersion}）` : '已改好';
}

// ─── 篩選 / 排序（導演頁的「未解決 / 已解決」「角色」「排序」） ───

export type StatusFilter = 'all' | 'open' | 'resolved';
export type RoleFilter = 'all' | 'animator' | 'director' | 'designer' | 'guest';
export type SortBy = 'newest' | 'oldest' | 'time-asc';

export function filterAndSortThreads<T extends CommentThread>(
  list: readonly T[], opts: { status?: StatusFilter; role?: RoleFilter; sort?: SortBy } = {},
): T[] {
  const { status = 'all', role = 'all', sort = 'newest' } = opts;
  let out = list.slice();
  if (status !== 'all') out = out.filter(t => (t.root.status ?? 'open') === status);
  if (role !== 'all') out = out.filter(t => t.root.role === role || t.replies.some(r => r.role === role));
  // 有新回覆的串算新的（導演回了一句，動畫師要看得到）
  const latest = (t: T) => [t.root, ...t.replies].reduce((a, c) => (c.createdAt > a ? c.createdAt : a), t.root.createdAt);
  out.sort((a, b) => {
    if (sort === 'newest') return latest(b).localeCompare(latest(a));
    if (sort === 'oldest') return a.root.createdAt.localeCompare(b.root.createdAt);
    return (a.root.time || 0) - (b.root.time || 0);
  });
  return out;
}

/** 某則留言（可能是回覆）在哪一串 → 那串最上面那則的 id（通知點進來要捲到那裡） */
export function threadRootId(comments: readonly SongComment[], commentId: string): string | null {
  const c = comments.find(x => x.id === commentId);
  if (!c) return null;
  if (c.parentId && comments.some(x => x.id === c.parentId)) {
    const p = comments.find(x => x.id === c.parentId)!;
    return p.parentId && comments.some(x => x.id === p.parentId) ? p.parentId : p.id;
  }
  return c.id;
}

/** 這則留言在「這一版」看不看得到（看不到 → 通知點進來時要切到「全部」） */
export function visibleInScope(comments: readonly SongComment[], commentId: string, scope: CommentScope, viewed: ViewedVersion | null): boolean {
  const rootId = threadRootId(comments, commentId);
  if (!rootId) return false;
  return scopeThreads(buildThreads(comments), scope, viewed).some(t => t.root.id === rootId);
}

// ─── 誰能做什麼（跟後台一樣） ───

interface Who {
  /** 我在這個專案的角色 */
  role: ProjectRole | null | undefined;
  userId: string | null | undefined;
  song: { animatorUserId: string | null } | null | undefined;
}

const ownsSong = (w: Who) => !w.song?.animatorUserId || w.song.animatorUserId === w.userId;
const isAuthor = (c: Pick<SongComment, 'authorUserId'>, w: Who) => !!c.authorUserId && c.authorUserId === w.userId;

/** 能不能留言 / 回覆：導演、製作都可以；動畫師只能自己的歌或還沒指派的歌 */
export function canPostComment(w: Who): boolean {
  if (!w.role || !w.userId) return false;
  if (w.role === 'admin' || w.role === 'director') return true;
  return w.role === 'animator' && ownsSong(w);
}

/**
 * 畫面上要不要出現「已改好」：製作、負責的動畫師、自己留言的動畫師。
 * 導演不出現（改好了沒有由動畫師說；導演覺得沒改好按「重新打開」）——
 * 後台還是讓留言的人收回自己的留言（舊版畫面的導演按了不會出錯），只是新畫面不放這個按鈕。
 */
export function canResolveComment(c: Pick<SongComment, 'authorUserId'>, w: Who): boolean {
  if (!w.role || !w.userId) return false;
  if (w.role === 'admin') return true;
  if (w.role === 'animator' && ownsSong(w)) return true;
  return w.role !== 'director' && isAuthor(c, w);
}

/** 能不能重新打開：製作、導演、負責的動畫師、留言的人自己 */
export function canReopenComment(c: Pick<SongComment, 'authorUserId'>, w: Who): boolean {
  if (!w.role || !w.userId) return false;
  if (w.role === 'admin' || w.role === 'director') return true;
  if (w.role === 'animator' && ownsSong(w)) return true;
  return isAuthor(c, w);
}
