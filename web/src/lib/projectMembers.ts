// 專案成員（「成員」面板）要用的純計算：角色順序 / 名稱、依角色分組、「專案的製作能做什麼」那一句說明。
//
// 這個檔案前端（成員面板）和後端測試（cf-worker/members.test.mjs 拿裡面的說明去對路由和權限）共用，
// 所以只能放「純判斷」：不 import 別的檔案、不碰 DOM / React、不用 enum / namespace 這類要編譯的寫法。
//
// 角色一律是「這個專案裡的角色」：製作（admin）= 這個專案的製作，只在這個專案有效，不是全站製作。

export type MemberRole = 'admin' | 'director' | 'animator';

/** 面板上分組的順序：製作、導演、動畫師 */
export const MEMBER_ROLE_ORDER: readonly MemberRole[] = ['admin', 'director', 'animator'];

export const MEMBER_ROLE_NAME: Record<MemberRole, string> = {
  admin: '製作',
  director: '導演',
  animator: '動畫師',
};

/** 每個角色在這個專案能做什麼（選角色時的小字） */
export const MEMBER_ROLE_HINT: Record<MemberRole, string> = {
  admin: '可以編輯這個專案、管理成員',
  director: '進審片頁：看影片、留言、通過或要求修改',
  animator: '進工作站：交影片、看導演的留言',
};

/**
 * 專案的「製作」能做的事（每一項都有測試去對後端的權限：cf-worker/members.test.mjs）。
 * label 是說明裡寫的字；改這裡也要改測試裡對應的請求。
 */
export const PROJECT_ADMIN_CAN: readonly string[] = ['模型', '歌單', 'cue', '機關', '版型', '分享', '專案狀態', '成員'];

/** 專案的「製作」還能直接打開導演頁和動畫師工作站，用自己的名字操作（上傳 / 刪影片、審片、留言、畫記）（測試：cf-worker/members.test.mjs） */
export const PROJECT_ADMIN_VIEW_TEXT = '還能直接打開導演頁和動畫師工作站（替任何一首歌交影片、刪版本、決定通過 / 需修改、留言、畫記）';

/** 專案的「製作」不能做的事（後端會擋；說明裡一起寫出來，免得以為什麼都能改） */
export const PROJECT_ADMIN_CANNOT: readonly { label: string; phrase: string }[] = [
  { label: '別的專案', phrase: '看不到別的專案' },
  { label: '全站用戶', phrase: '管全站用戶' },
  { label: '3D 檢視設定', phrase: '改 3D 檢視設定' },
  { label: 'Drive 來源', phrase: '改 Drive 來源' },
  { label: '封存或複製專案', phrase: '封存或複製專案' },
];

/** 面板上那一行說明（由上面兩個清單組出來，所以說明跟測試過的權限一定一樣） */
export const PROJECT_ADMIN_SCOPE_TEXT =
  `專案的「製作」可以編輯這個專案（${PROJECT_ADMIN_CAN.slice(0, -1).join('、')}），也可以管理它的成員，${PROJECT_ADMIN_VIEW_TEXT}；` +
  `看不到別的專案，也不能${PROJECT_ADMIN_CANNOT.slice(1).map(c => c.phrase).join('、')}`;

export interface MemberLike {
  id: string;
  name: string;
  role: MemberRole;
}

export interface MemberGroup<M extends MemberLike> {
  role: MemberRole;
  label: string;
  members: M[];
}

/** 依角色分組（製作 → 導演 → 動畫師），組內照名字排；沒有人的角色不出現 */
export function groupMembersByRole<M extends MemberLike>(members: readonly M[]): MemberGroup<M>[] {
  const out: MemberGroup<M>[] = [];
  for (const role of MEMBER_ROLE_ORDER) {
    const list = members
      .filter(m => m.role === role)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    if (list.length > 0) out.push({ role, label: MEMBER_ROLE_NAME[role], members: list });
  }
  return out;
}

/** 組內人數的標題：「導演（2）」 */
export function groupTitle(label: string, count: number): string {
  return `${label}（${count}）`;
}

/** 這個人的角色選單能不能改：全站製作鎖住、自己鎖住（後端也會擋） */
export function memberRowLock(m: { globalAdmin?: boolean; isMe?: boolean }): null | 'globalAdmin' | 'me' {
  if (m.globalAdmin) return 'globalAdmin';
  if (m.isMe) return 'me';
  return null;
}

export const MEMBER_LOCK_TEXT: Record<'globalAdmin' | 'me', string> = {
  globalAdmin: '全站製作：本來就看得到所有專案',
  me: '這是你自己：要改請別的製作幫你',
};

/** 找人時要輸入幾個字才去查（後端沒有名字不會列人） */
export const CANDIDATE_MIN_CHARS = 1;
