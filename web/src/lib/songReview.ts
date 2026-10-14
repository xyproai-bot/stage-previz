// 歌曲審查：畫面上要出現哪些狀態按鈕、狀態被別人搶先改掉時要怎麼說、留言誰能改 / 刪。
//
// 規則跟後台 cf-worker/access.mjs 的 songStatusDecision 一樣（後台才是最後把關；這裡只決定按鈕出不出現）：
//   動畫師（指派給自己、或還沒指派的歌）：待製作 / 需修改 → 審查中（提交）；審查中 → 待製作（撤回，只有還在審查中才能撤回）
//   導演、製作（導演頁）：這首歌有可以播的版本 → 不管現在是什麼狀態都可以「通過 V2」「需修改 V2」（綁看的那一版）；
//         已通過 → 需修改（改主意）、需修改 → 通過都可以；還沒有影片 → 按鈕按不下去（decisionBarState）
//   admin：什麼都可以（動畫師頁給動畫師那組按鈕、導演頁給導演那組；其他改法在管理頁的狀態選單）
//   （後台還收舊版前端的「撤回通過」：已通過 → 審查中；新版畫面改成直接按「需修改」）
// 角色一律看「這個專案」裡的角色（Project.myRole），不是帳號的預設角色。

import type { Song, SongComment } from './api';
import type { ProjectRole } from './mockData';

export type SongStatus = Song['status'];

export const SONG_STATUS_LABEL: Record<SongStatus, string> = {
  todo: '待製作',
  in_review: '審查中',
  approved: '已通過',
  needs_changes: '需修改',
};

export type SongActionKind = 'submit' | 'resubmit' | 'withdraw' | 'approve' | 'needs_changes';

export interface SongAction {
  kind: SongActionKind;
  to: SongStatus;
  label: string;
  /** 主要按鈕（實心）還是次要（外框） */
  primary: boolean;
}

const ACTIONS: Record<SongActionKind, Omit<SongAction, 'kind'>> = {
  submit:        { to: 'in_review',     label: '提交審查',             primary: true },
  resubmit:      { to: 'in_review',     label: '修改完成，重新提交',   primary: true },
  withdraw:      { to: 'todo',          label: '撤回（改回待製作）',   primary: false },
  approve:       { to: 'approved',      label: '通過',                 primary: true },
  needs_changes: { to: 'needs_changes', label: '需修改',               primary: false },
};

/** 哪個頁面：動畫師工作站（提交 / 撤回）或導演頁（通過 / 需修改） */
export type ReviewFlow = 'animator' | 'director';

const FLOW: Record<ReviewFlow, Partial<Record<SongStatus, SongActionKind[]>>> = {
  animator: {
    todo: ['submit'],
    needs_changes: ['resubmit'],
    in_review: ['withdraw'],
  },
  // 導演隨時可以決定（有沒有影片看 decisionBarState）
  director: {
    todo: ['approve', 'needs_changes'],
    in_review: ['approve', 'needs_changes'],
    needs_changes: ['approve', 'needs_changes'],
    approved: ['approve', 'needs_changes'],
  },
};

interface ActionInput {
  /** 我在這個專案的角色 */
  role: ProjectRole | null | undefined;
  userId: string | null | undefined;
  song: Pick<Song, 'status' | 'animatorUserId'>;
  flow: ReviewFlow;
}

/** 歌指派給別的動畫師（動畫師只能動自己的歌、或還沒指派的歌） */
export function assignedToSomeoneElse(song: Pick<Song, 'animatorUserId'>, userId: string | null | undefined): boolean {
  return !!song.animatorUserId && song.animatorUserId !== userId;
}

/** 這個人在這個頁面、這首歌現在的狀態下，可以按哪些狀態按鈕 */
export function songStatusActions({ role, userId, song, flow }: ActionInput): SongAction[] {
  if (!role) return [];
  // 不是 admin 的話，只有角色跟頁面對得上才有按鈕（導演開動畫師頁不會出現「提交」）
  if (role !== 'admin' && role !== flow) return [];
  if (role === 'animator' && assignedToSomeoneElse(song, userId)) return [];
  const kinds = FLOW[flow][song.status] || [];
  return kinds.map(kind => ({ kind, ...ACTIONS[kind] }));
}

/** 沒有按鈕時的一句說明（null = 不用特別說） */
export function songActionsHint({ role, userId, song, flow }: ActionInput): string | null {
  if (!role) return '你不是這個專案的成員，只能看';
  if (role === 'animator' && flow === 'animator' && assignedToSomeoneElse(song, userId)) {
    return '這首歌指派給其他動畫師，只有他可以提交或撤回';
  }
  if (role !== 'admin' && role !== flow) return null;
  if (flow === 'animator') {
    if (song.status === 'approved') return '這首歌已通過';
    return null;
  }
  // 導演頁的說明在決定列（decisionBarState）
  return null;
}

export const NO_VIDEO_HINT = '還沒有影片，等動畫師交了再決定';

/** 決定列上的一顆按鈕：「通過 V2」「需修改 V2」 */
export interface DecisionButton extends SongAction {
  /** 按鈕上的字（有版本就帶版本：「通過 V2」） */
  text: string;
  /** 按不下去的原因（null = 可以按） */
  disabledReason: string | null;
}

export interface DecisionBarState {
  buttons: DecisionButton[];
  /** 一行說明（null = 不用說） */
  hint: string | null;
}

interface DecisionInput {
  role: ProjectRole | null | undefined;
  userId: string | null | undefined;
  song: Pick<Song, 'status' | 'animatorUserId'> & { lastReview?: { status: SongStatus; videoId: string | null } | null };
  /** 要決定的那一版（正在看的那一版；這首歌沒有可以播的版本 = null） */
  judged: { videoId: string; label: string } | null;
}

/**
 * 導演頁的決定列：導演、製作看得到（動畫師 = null）。
 *   還沒有影片 → 兩顆都按不下去，寫「還沒有影片，等動畫師交了再決定」
 *   已經是「已通過 V2」又在看 V2 → 「通過 V2」按不下去（已經是了）；看 V3 就可以再通過一次
 *   還沒送審（待製作 / 需修改）→ 一行說明：你也可以直接決定
 */
export function decisionBarState({ role, userId, song, judged }: DecisionInput): DecisionBarState | null {
  if (!role) return { buttons: [], hint: '你不是這個專案的成員，只能看' };
  if (role !== 'director' && role !== 'admin') return null;
  const actions = songStatusActions({ role, userId, song, flow: 'director' });
  const last = song.lastReview ?? null;
  const buttons = actions.map((a): DecisionButton => {
    const text = judged ? `${a.label} ${judged.label}` : a.label;
    let disabledReason: string | null = null;
    if (!judged) disabledReason = NO_VIDEO_HINT;
    else if (song.status === a.to && last && last.status === a.to && last.videoId === judged.videoId) {
      disabledReason = `已經是「${SONG_STATUS_LABEL[a.to]} ${judged.label}」了`;
    }
    return { ...a, text, disabledReason };
  });
  let hint: string | null = null;
  if (!judged) hint = NO_VIDEO_HINT;
  else if (song.status === 'todo') hint = '動畫師還沒送審，你也可以直接決定';
  else if (song.status === 'needs_changes') hint = '動畫師還在改（還沒重新送審），你也可以直接決定';
  else if (song.status === 'approved') hint = '已通過；改變主意也可以再決定一次';
  return { buttons, hint };
}

/** 總覽卡片上的一行：待製作但已經有影片 →「有影片 V1 · 還沒送審」（導演知道可以點進去直接決定） */
export function unsubmittedVideoLabel(song: Pick<Song, 'status' | 'latestVideoVersion'>): string | null {
  if (song.status !== 'todo' || song.latestVideoVersion == null) return null;
  return `有影片 V${song.latestVideoVersion} · 還沒送審`;
}

/**
 * 改狀態時後台回 409（畫面上看到的狀態已經不是最新的）→ 給使用者看的話。
 * currentStatus = 後台說現在的狀態；expected = 我們送出去時以為的狀態。
 * 兩個一樣 = 不是被別人搶先改，是這個改法本來就不行 → 回 null，呼叫的人改顯示後台的說明。
 */
export function staleStatusMessage(currentStatus: unknown, expected?: SongStatus): string | null {
  if (typeof currentStatus !== 'string' || !(currentStatus in SONG_STATUS_LABEL)) {
    return '這首歌的狀態剛剛被別人改了，畫面已更新';
  }
  const cur = currentStatus as SongStatus;
  if (expected && cur === expected) return null;
  const label = SONG_STATUS_LABEL[cur];
  if (cur === 'approved' || cur === 'needs_changes') return `導演剛剛已經改成「${label}」了，畫面已更新`;
  if (cur === 'todo') return `這首歌剛剛被撤回，改成「${label}」了，畫面已更新`;
  return `這首歌剛剛已經變成「${label}」了，畫面已更新`;
}

const CJK_RE = /[㐀-鿿豈-﫿　-〿＀-￯]/;

/**
 * 錯誤 → 給人看的中文。後台大部分訊息已經是中文就照用；
 * 英文的（舊的 "Not found"、"HTTP 500"、瀏覽器的 "Failed to fetch"）換成白話。
 */
export function friendlyError(e: unknown): string {
  const raw = (e instanceof Error ? e.message : typeof e === 'string' ? e : '').trim();
  if (raw && CJK_RE.test(raw)) return raw;
  const status = (e as { status?: unknown } | null)?.status;
  if (status === 401) return '登入過期了，請重新登入';
  if (status === 403) return '你沒有權限做這件事';
  if (status === 404) return '找不到這筆資料，可能剛被刪除，或專案已封存';
  if (status === 409) return '資料剛剛被別人改了，請重新整理後再試';
  if (status === 429) return '操作太頻繁了，請稍等一下再試';
  if (typeof status === 'number' && status >= 500) return '伺服器暫時出了問題，請稍後再試';
  if (/failed to fetch|networkerror|load failed|network request failed/i.test(raw)) {
    return '連不上伺服器，請檢查網路後再試';
  }
  return raw ? `發生錯誤（${raw}）` : '發生錯誤，請再試一次';
}

/** 專案整個讀不到（被封存 / 刪除 / 被移出專案）時要顯示的話；不是這種錯誤回 null */
export function projectGoneMessage(e: unknown): string | null {
  const status = (e as { status?: unknown } | null)?.status;
  if (status === 404) return '這個專案已經封存或刪除了，看不到內容。有問題請聯絡製作。';
  if (status === 403) return '你已經不是這個專案的成員（可能被移出專案了）。有問題請聯絡製作。';
  return null;
}

// ─── 自動更新用：新舊資料一樣就不換（畫面不重畫、不閃） ───

const SONG_KEYS = ['id', 'name', 'order', 'status', 'animatorUserId', 'cueCount', 'proposalCount', 'code', 'latestVideoId', 'latestVideoVersion', 'reviewedVersion'] as const;

export function sameSongs(a: readonly Song[], b: readonly Song[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  // 最近一次通過 / 需修改：看時間和版本就知道有沒有換
  const review = (s: Song) => s.lastReview ? `${s.lastReview.at}|${s.lastReview.status}|${s.lastReview.version ?? ''}` : '';
  return a.every((s, i) => SONG_KEYS.every(k => s[k] === b[i][k]) && review(s) === review(b[i]));
}

const COMMENT_KEYS = ['id', 'text', 'status', 'resolvedBy', 'resolvedAt', 'time', 'author', 'resolvedVersion', 'parentId', 'videoVersion'] as const;

export function sameComments(a: readonly SongComment[] | undefined, b: readonly SongComment[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((c, i) => COMMENT_KEYS.every(k => c[k] === b[i][k]));
}

/** 這次比上次多出來、而且不是我留的留言（上次沒資料 → 不算新的，不然一打開就跳一堆） */
export function newCommentsFromOthers(
  before: readonly SongComment[] | undefined,
  after: readonly SongComment[],
  me: { id: string; name: string } | null | undefined,
): SongComment[] {
  if (!before) return [];
  const known = new Set(before.map(c => c.id));
  return after.filter(c => !known.has(c.id) && !isOwnComment(c, me));
}

/** 這則留言是不是我留的（舊留言沒有 authorUserId → 用名字比） */
export function isOwnComment(c: Pick<SongComment, 'authorUserId' | 'author'>, me: { id: string; name: string } | null | undefined): boolean {
  if (!me) return false;
  if (c.authorUserId) return c.authorUserId === me.id;
  return c.author === me.name;
}

/** 能不能改文字 / 刪除：自己留的，或 admin（專案 admin 或全站 admin）。跟後台 canModifyComment 一樣 */
export function canModifyComment(
  c: Pick<SongComment, 'authorUserId'>,
  me: { id: string; role?: string } | null | undefined,
  projectRole: ProjectRole | null | undefined,
): boolean {
  if (!me) return false;
  if (projectRole === 'admin' || me.role === 'admin') return true;
  return !!c.authorUserId && c.authorUserId === me.id;
}
