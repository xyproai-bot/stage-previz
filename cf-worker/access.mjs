// 權限規則（純判斷，不碰資料庫）：誰在這個專案能做什麼。
// 資料庫查詢在 worker.js；這裡的每個判斷都有 access.test.mjs 測。
//
// 角色看「這個專案」裡的角色（project_members.role），不是帳號的預設角色：
//   全站 admin                → 每個專案都是 admin
//   專案成員                  → project_members.role（admin / director / animator）
//   不是成員                  → null（什麼都不能做）
//
// 權限總表（admin = 全站 admin 或這個專案的 admin）：
//   看專案內容（歌、cue、位置、物件、模型、活動紀錄、Drive 檔案清單、留言）  所有成員
//   改專案內容（歌名 / 順序、cue、位置、物件、模型、模板、匯出）              admin
//   歌曲狀態                                                                  見 songStatusDecision
//   留言：看                                                                    所有成員
//   留言：發、回覆                                                              admin、導演；動畫師只能在自己的歌或還沒指派的歌（commentPostDecision）
//   留言：標「已改好（V3）」                                                    admin、負責的動畫師（沒指派 = 專案裡的動畫師）、留言的人自己（commentResolveDecision）
//   留言：重新打開                                                              admin、導演、負責的動畫師、留言的人自己（commentReopenDecision）
//   留言：改文字、刪除                                                         留言的人自己，或 admin
//   留言：每首歌幾則 / 最新一則（comments/summary）                            所有成員
//   審片紀錄（songs/:id/reviews）                                              所有成員
//   站內通知（/api/notifications）                                             登入的人看自己的（describeNotificationRoute）；分享連結的訪客沒有
//   分享連結：看清單、建立、改網址、取名、刪除                                 admin、導演
//   分享連結：打開「允許看的人留言」                                          admin（canToggleShareComments；關掉 = admin、導演都可以）
//   分享連結：「浮水印」「禁止下載」開關（0038）                               admin、導演（跟建連結同權限）；新連結預設兩個都開，舊連結都關
//                                                                              （規則和預設值在 web/src/lib/watermark/policy.ts，前後台共用；禁止下載的影片網址要帶短效播放通行證：shareMedia.mjs）
//   專案「成員看片也加浮水印」（0038，projects.watermark_members）             admin（這個專案的 admin，也就是製作；canSetMemberWatermark）；預設關
//   訪客留言（分享連結，0026）                                                 連結有開「允許看的人留言」的人（密碼 / 通行證照舊）；
//                                                                              只看得到同一條連結的留言串 + 團隊在底下的回覆；不能改、刪、標已改好
//   留言縮圖（/api/comment-thumbs/…）                                          網址有 128 bits 隨機碼（跟模型檔一樣），拿得到網址的人才看得到
//   歌曲影片：看版本、播放                                                     所有成員
//   歌曲影片：交新版（上傳 / 貼連結）                                          admin、負責這首歌的動畫師（videos.mjs videoUploadDecision）
//   歌曲影片：貼連結交一版                                                    上面的人 + 這個專案的導演（videos.mjs videoLinkDecision）
//   歌曲影片：改說明、刪除、繼續上傳某一版                                     admin、交這一版的人（videos.mjs videoModifyDecision）
//   比例尺的樂手和器材（0033，stage-props）：看                                所有成員（分享連結：只看）
//   比例尺的樂手和器材：新增 / 移動 / 轉 / 刪除                                admin、導演（canEditStageProps，規則在 web/src/lib/stageProps.ts）
//   視角書籤（0035，camera-bookmarks）：看                                   所有成員（分享連結：只看）
//   視角書籤：新增 / 改名 / 刪除 / 換順序                                      admin、導演（canEditCameraBookmarks，規則在 web/src/lib/cameraBookmarks.ts）
//   自動貼 UV（0036，led-uv）：套用 / 看會動到什麼                            admin（這個專案的 admin，也就是製作）
//   自動貼 UV：看 / 存排到一半的東西（led-uv/layout，沒有新的 migration）      admin（這個專案的 admin，也就是製作）
//   一首歌所有 cue 的物件位置：一次看 / 一次清（回到預設位置）/ 一次寫回（復原）    admin（cue-object-states，cueStatesBatch.mjs）
//   機關：看定義、每首歌每個 cue 的機關位置                                所有成員（分享連結：只看）
//   機關：新增 / 改 / 刪 / 排序、設定每個 cue 的機關位置、機關總表資料        admin（這個專案的 admin）
//   歌曲影片：最近刪除、救回來（30 天內）                                      admin（這個專案的 admin）
//   專案成員（0041，members.mjs）：看成員、加進專案 / 改角色 / 移出專案、找現有用戶、邀請連結（建立 / 清單 / 撤銷，
//                   可以邀製作 / 導演 / 動畫師）                                  admin（全站製作，或「這個專案」的製作；memberManager）
//                   只動 project_members 和這個專案的邀請，不碰 users.role（專案的製作不能讓任何人變成全站製作）、
//                   也碰不到別的專案（路由本來就只看網址上的專案）
//   只有全站 admin：建立 / 匯入 / 複製 / 封存 / 還原專案、專案結束清影片、Drive 帳號和資料夾綁定、
//                   3D 檢視設定（校準 / 現場設定 / 材質 / 重置視角 / LED 畫布大小）、專案狀態、Show 管理、用戶管理、
//                   所有專案的邀請清單（GET /api/invites）、共用模型庫的修改
//   共用模型庫（/api/assets）：看清單 = 全站 admin 或某個專案的 admin（canBrowseSharedAssets）；改 = 全站 admin

// 比例尺的樂手和器材：誰能改的規則跟前端共用同一個檔（純判斷）
import { canEditStageProps, STAGE_PROPS_DENIED_MESSAGE } from '../web/src/lib/stageProps.ts';
export { canEditStageProps };
// 視角書籤：誰能改的規則也跟前端共用同一個檔
import { canEditCameraBookmarks, CAMERA_BOOKMARKS_DENIED_MESSAGE } from '../web/src/lib/cameraBookmarks.ts';
export { canEditCameraBookmarks };

export const ROLES = ['admin', 'animator', 'director'];
export const SONG_STATUSES = ['todo', 'in_review', 'approved', 'needs_changes'];
export const SONG_STATUS_LABEL = {
  todo: '待製作',
  in_review: '審查中',
  approved: '已通過',
  needs_changes: '需修改',
};

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** 使用者在某個專案的角色；不是成員回 null */
export function projectRoleOf(globalRole, memberRole) {
  if (globalRole === 'admin') return 'admin';
  return ROLES.includes(memberRole) ? memberRole : null;
}

export function canEditProjectContent(role) {
  return role === 'admin';
}

export function canManageShareLinks(role) {
  return role === 'admin' || role === 'director';
}

/**
 * 分享連結的「允許看的人留言」：打開只有製作（admin）可以；關掉是比較安全的動作 → 管得到分享連結的人都可以
 * @param {string|null} role  這個人在專案的角色
 * @param {boolean} on        想要打開（true）還是關掉（false）
 */
export function canToggleShareComments(role, on) {
  if (!canManageShareLinks(role)) return false;
  return on ? role === 'admin' : true;
}

/** 訪客能不能在這條分享連結留言（連結有打開、專案沒封存；密碼 / 有效期在路由前面就檢查過了） */
export function guestCommentDecision(link) {
  if (!link) return { ok: false, status: 404, error: 'Share link not found' };
  if (link.project_status === 'archived') return { ok: false, status: 404, error: '這個分享連結的專案已封存' };
  if (!link.allow_comments) return { ok: false, status: 403, error: '這個分享連結沒有開放留言', commentsDisabled: true };
  return { ok: true };
}

// ─────────────────────────────────────────────
// 歌曲狀態
// ─────────────────────────────────────────────

// 歌曲狀態規則（2026-10-15 起：導演 / 製作隨時可以決定）
//   動畫師（自己的歌或還沒指派的歌）：待製作 / 需修改 → 審查中（提交）；審查中 → 待製作（撤回）
//   導演：這首歌有可以播的版本 → 不管現在是什麼狀態都可以「通過」或「需修改」（綁看的那一版；
//         已通過 → 需修改 = 改主意、需修改 → 通過、已通過 V1 → 通過 V2 = 同一個狀態再決定一次）
//         另外照舊可以：審查中 → 通過 / 需修改（沒影片也可以）、已通過 → 審查中（舊版前端的「撤回通過」）
//   admin：什麼都可以
// 舊版前端（正式站）只會送舊的那幾種改法，全部照舊可以 → 放寬後舊版照樣能用。
const ANIMATOR_TRANSITIONS = {
  todo: ['in_review'],           // 提交審查
  needs_changes: ['in_review'],  // 改好重新提交
  in_review: ['todo'],           // 撤回（只有還在審查中才能撤回）
};
// 導演不用看有沒有影片就能做的（舊規則）
const DIRECTOR_LEGACY = {
  in_review: ['approved', 'needs_changes'],
  approved: ['in_review'],
};
export const DECISION_STATUSES = ['approved', 'needs_changes'];
export const NO_VIDEO_MESSAGE = '還沒有影片，等動畫師交了再決定';

const label = (s) => SONG_STATUS_LABEL[s] || s;

/**
 * 能不能把歌的狀態從 song.status 改成 to。
 *
 * @param {object} p
 * @param {string|null} p.role        這個人在專案的角色（projectRoleOf 的結果）
 * @param {string} p.userId           這個人的 user id
 * @param {{status: string, animator_user_id?: string|null}} p.song  目前資料庫裡的歌
 * @param {string} p.to               想改成的狀態
 * @param {string|null|undefined} p.expected  前端以為的目前狀態（有給就要一致，不然回 409）
 * @param {boolean} [p.hasReadyVideo] 這首歌有沒有可以播的版本（worker 查好帶進來；沒給 = 當作沒有）
 * @param {boolean} [p.redecide]      前端有帶看的版本（reviewVideoId）→ 同一個狀態可以再決定一次（例：已通過 V1 → 通過 V2）
 * @returns {{ok: true, noop?: boolean, redecide?: boolean} | {ok: false, status: number, error: string, currentStatus?: string, noVideo?: boolean}}
 *   redecide = 狀態不變，但要記一筆新的審片紀錄（worker 再看是不是跟上一筆一模一樣）
 */
export function songStatusDecision({ role, userId, song, to, expected, hasReadyVideo = false, redecide = false }) {
  if (!SONG_STATUSES.includes(to)) {
    return { ok: false, status: 400, error: '歌曲狀態不正確' };
  }
  if (!role) return { ok: false, status: 403, error: '沒有權限存取此專案' };
  const from = song?.status;
  if (expected !== undefined && expected !== null) {
    if (!SONG_STATUSES.includes(expected)) return { ok: false, status: 400, error: '歌曲狀態不正確' };
    if (expected !== from) {
      return {
        ok: false, status: 409, currentStatus: from,
        error: `這首歌的狀態剛剛被改成「${label(from)}」了，請重新整理後再操作`,
      };
    }
  }
  const isDecision = DECISION_STATUSES.includes(to);
  const sameAgain = () => (isDecision && redecide && hasReadyVideo ? { ok: true, redecide: true } : { ok: true, noop: true });

  if (role === 'admin') return from === to ? sameAgain() : { ok: true };

  if (role === 'animator') {
    if (!Object.values(ANIMATOR_TRANSITIONS).some(list => list.includes(to))) {
      return { ok: false, status: 403, error: '動畫師只能提交審查，或撤回還在審查中的歌；「已通過」「需修改」由導演決定' };
    }
    if (song?.animator_user_id && song.animator_user_id !== userId) {
      return { ok: false, status: 403, error: '這首歌指派給其他動畫師，只有他可以提交或撤回' };
    }
    if (from === to) return { ok: true, noop: true };
    if (ANIMATOR_TRANSITIONS[from]?.includes(to)) return { ok: true };
  } else if (role === 'director') {
    if (to === 'todo') {
      return { ok: false, status: 403, error: '導演可以按「通過」或「需修改」；改回「待製作」請由動畫師撤回或製作變更' };
    }
    if (from === to) return sameAgain();
    if (DIRECTOR_LEGACY[from]?.includes(to)) return { ok: true };
    if (isDecision) {
      if (!hasReadyVideo) return { ok: false, status: 409, currentStatus: from, noVideo: true, error: NO_VIDEO_MESSAGE };
      return { ok: true };
    }
  } else {
    return { ok: false, status: 403, error: '沒有權限改這首歌的狀態' };
  }

  return {
    ok: false, status: 409, currentStatus: from,
    error: `這首歌現在是「${label(from)}」，不能直接改成「${label(to)}」（畫面上顯示的狀態不一樣的話，請重新整理）`,
  };
}

// ─────────────────────────────────────────────
// 專案路由需要的權限（給 worker.js 的 handleProjectsRouter 用）
// ─────────────────────────────────────────────

/**
 * 把 /api/projects/:id/... 的請求對應到「要什麼權限」和「要檢查哪些 id 屬於這個專案」。
 *
 * need：
 *   'member'       專案成員都可以
 *   'editor'       這個專案的 admin（canEditProjectContent）
 *   'globalAdmin'  只有全站 admin
 *   'shareManager' admin 或導演（canManageShareLinks）
 *   'stageProps'   admin 或導演（canEditStageProps）：改比例尺的樂手和器材
 *   'memberManager' 全站 admin 或這個專案的 admin（role === 'admin'）：管這個專案的成員和邀請連結
 *   'cameraBookmarks' admin 或導演（canEditCameraBookmarks）：存 / 改名 / 刪 / 排視角書籤
 *   'songPatch'    改歌：只改狀態看 songStatusDecision，改其他欄位要 editor（handler 裡判斷）
 *   'projectPatch' 改專案：一般欄位 editor，Drive / 狀態 / 3D 檢視設定要全站 admin（handler 裡判斷）
 *   'videoUploader' 交影片：admin 或動畫師先放行，handler 裡再看這首歌指派給誰 / 這一版是誰交的（videos.mjs）
 *   'videoLinker'   貼連結交一版：admin、動畫師、導演先放行，handler 裡再看（videos.mjs videoLinkDecision）
 *   'videoEditor'   取消 / 重試 / 改說明 / 刪掉某一版：admin、動畫師、導演先放行，handler 裡再看是不是交這一版的人
 *                   （導演只能動自己貼連結交的；videos.mjs videoModifyDecision）
 *
 * @param {string} method
 * @param {string[]} segs  url.pathname.split('/').filter(Boolean)
 * @returns {{kind: string, need: string, songId?: string, cueId?: string, objId?: string, videoId?: string, partNumber?: string, mechId?: string, tplId?: string, screenId?: string, memberUserId?: string, allowArchived?: boolean} | null}
 *          null = 沒有這個路徑（404）或方法不對（405，見 methodNotAllowed）
 */
export function describeProjectRoute(method, segs) {
  const m = (method || 'GET').toUpperCase();
  const read = m === 'GET' || m === 'HEAD';
  const [, , , sub = null, a = null, b = null, c = null, d = null, e = null] = segs;
  const r = (kind, need, extra = {}) => ({ kind, need, ...extra });
  const bad = (kind) => ({ kind, need: null, methodNotAllowed: true });

  if (!sub) {
    if (read) return r('project.get', 'member');
    if (m === 'PATCH') return r('project.patch', 'projectPatch');
    if (m === 'DELETE') return r('project.archive', 'globalAdmin');
    return bad('project');
  }

  switch (sub) {
    // 比例尺的樂手和器材（0033）：所有成員看、製作和導演整份存（PUT { props: [...] }）
    case 'stage-props':
      if (a) return null;
      if (read) return r('stageProps.get', 'member');
      return m === 'PUT' ? r('stageProps.put', 'stageProps') : bad('stageProps');

    // 視角書籤（0035）：所有成員看、製作和導演整份存（PUT { bookmarks: [...] }）
    case 'camera-bookmarks':
      if (a) return null;
      if (read) return r('cameraBookmarks.get', 'member');
      return m === 'PUT' ? r('cameraBookmarks.put', 'cameraBookmarks') : bad('cameraBookmarks');

    case 'share-links':
      if (!a) {
        if (read || m === 'POST') return r('shareLinks', 'shareManager');
        return bad('shareLinks');
      }
      if (m === 'DELETE' || m === 'PATCH') return r('shareLinks.item', 'shareManager');
      return bad('shareLinks.item');

    case 'stage-objects':
      if (!a) {
        if (read) return r('stageObjects.list', 'member');
        if (m === 'POST') return r('stageObjects.create', 'editor');
        return bad('stageObjects');
      }
      if (a === 'seed-defaults' || a === 'bulk') {
        return m === 'POST' ? r('stageObjects.' + a, 'editor') : bad('stageObjects.' + a);
      }
      if (m === 'PATCH' || m === 'DELETE') return r('stageObjects.item', 'editor', { objId: a });
      return bad('stageObjects.item');

    case 'model':
      if (!a) {
        if (read) return r('model.get', 'member');
        if (m === 'PUT') return r('model.upload', 'editor');
        return bad('model');
      }
      if (a === 'use-asset') return m === 'POST' ? r('model.useAsset', 'editor') : bad('model.useAsset');
      if (a === 'versions') {
        if (!b) return read ? r('model.versions', 'member') : bad('model.versions');
        if (b === 'activate') return m === 'POST' ? r('model.activate', 'editor') : bad('model.activate');
        return m === 'DELETE' ? r('model.deleteVersion', 'editor') : bad('model.deleteVersion');
      }
      return null;

    case 'invites':
      // 邀請連結（invites.mjs）：等於幫專案加人 → 管這個專案成員的人（全站製作、這個專案的製作）；
      // 別的專案的邀請碰不到（網址上的專案就是範圍），所有專案的清單（GET /api/invites）仍然只有全站製作
      if (!a) {
        if (read) return r('invites.list', 'memberManager');
        if (m === 'POST') return r('invites.create', 'memberManager');
        return bad('invites');
      }
      if (!b && m === 'DELETE') return r('invites.revoke', 'memberManager', { inviteId: a });
      return b ? null : bad('invites.item');

    // 專案成員（members.mjs）：看、加進專案 / 改角色（PUT）、移出專案（DELETE）
    case 'members':
      if (!a) return read ? r('members.list', 'memberManager') : bad('members');
      if (b) return null;
      if (m === 'PUT' || m === 'DELETE') return r('members.item', 'memberManager', { memberUserId: a });
      return bad('members.item');
    // 用名字找現有的用戶（加進專案、邀請已經有帳號的人）
    case 'member-candidates':
      if (a) return null;
      return read ? r('members.candidates', 'memberManager') : bad('members.candidates');

    case 'activity':
      return read ? r('activity', 'member') : bad('activity');
    case 'comments':
      // 每首歌的留言數 / 最新一則（工作站一次拿全部，不用一首一首抓）
      if (a === 'summary' && !b) return read ? r('comments.summary', 'member') : bad('comments.summary');
      return null;
    case 'duplicate':
      return m === 'POST' ? r('duplicate', 'globalAdmin') : bad('duplicate');
    case 'restore':
      return m === 'POST' ? r('restore', 'globalAdmin', { allowArchived: true }) : bad('restore');
    // 專案結束清影片（storage.mjs）：先看會怎樣 / 照選的做；封存以後也可以做
    case 'wrap-up':
      if (a) return null;
      if (read) return r('wrapUp.get', 'globalAdmin');
      return m === 'POST' ? r('wrapUp.apply', 'globalAdmin', { allowArchived: true }) : bad('wrapUp');
    case 'export':
      return read ? r('export', 'editor') : bad('export');
    // 機關（設計：docs/superpowers/specs/2026-10-14-mechanism-system-design.md；API：docs/mechanisms-api.md）
    case 'mechanisms':
      if (!a) {
        if (read) return r('mechanisms.list', 'member');
        if (m === 'POST') return r('mechanisms.create', 'editor');
        return bad('mechanisms');
      }
      if (a === 'reorder' && !b) return m === 'POST' ? r('mechanisms.reorder', 'editor') : bad('mechanisms.reorder');
      // 一次建立 N 個機關（一排）
      if (a === 'batch' && !b) return m === 'POST' ? r('mechanisms.batch', 'editor') : bad('mechanisms.batch');
      if (!b) {
        if (m === 'PATCH' || m === 'DELETE') return r('mechanisms.item', 'editor', { mechId: a });
        return bad('mechanisms.item');
      }
      // 把現有 cue 裡物件的位置轉成這個機關的位置（一次全部）
      if (b === 'convert-cue-positions' && !c) {
        return m === 'POST' ? r('mechanisms.convert', 'editor', { mechId: a }) : bad('mechanisms.convert');
      }
      return null;
    case 'mechanism-sheet':
      if (a) return null;
      return read ? r('mechanisms.sheet', 'editor') : bad('mechanisms.sheet');
    // 一排機關：改名字 / 共用設定、解散或刪掉（讀在 GET …/mechanisms 的 groups 裡）
    case 'mechanism-groups':
      if (!a || b) return null;
      if (m === 'PATCH' || m === 'DELETE') return r('mechGroups.item', 'editor', { groupId: a });
      return bad('mechGroups.item');

    // LED 畫布版型（設計：docs/superpowers/specs/2026-10-15-led-canvas-templates-design.md；API：docs/led-templates-api.md）
    case 'led-templates':
      if (!a) {
        if (read) return r('ledTemplates.list', 'member');
        if (m === 'POST') return r('ledTemplates.create', 'editor');
        return bad('ledTemplates');
      }
      if (b) return null;
      if (m === 'PATCH' || m === 'DELETE') return r('ledTemplates.item', 'editor', { tplId: a });
      return bad('ledTemplates.item');
    // 自動貼 UV（modelUvLayouts.mjs；設計：docs/superpowers/specs/2026-10-16-auto-uv-design.md）
    case 'led-uv':
      if (b) return null;
      if (a === 'apply') return m === 'POST' ? r('ledUv.apply', 'editor') : bad('ledUv.apply');
      if (a === 'impact') return read ? r('ledUv.impact', 'editor') : bad('ledUv.impact');
      // 排到一半的東西（勾的螢幕、點數、自己排的排法）：看 / 存，只有製作
      if (a === 'layout') return read ? r('ledUv.layoutGet', 'editor') : m === 'PUT' ? r('ledUv.layoutPut', 'editor') : bad('ledUv.layout');
      return null;
    // 手動切的螢幕（一個模型物件裡有好幾塊螢幕時，在整張畫布上框出來；讀在 GET …/led-templates 的 screens 裡）
    case 'led-screens':
      if (!a) return m === 'POST' ? r('ledScreens.create', 'editor') : bad('ledScreens');
      if (b) return null;
      if (m === 'PATCH' || m === 'DELETE') return r('ledScreens.item', 'editor', { screenId: a });
      return bad('ledScreens.item');

    // Cue 庫的 cue（專案層級的畫面；設計：docs/superpowers/specs/2026-10-22-cue-library-design.md 4.1）：看 = 成員，改 = 這個專案的製作
    case 'library-cues':
      if (!a) {
        if (read) return r('libraryCues.list', 'member');
        if (m === 'POST') return r('libraryCues.create', 'editor');
        return bad('libraryCues');
      }
      if (!b) {
        if (read) return r('libraryCues.get', 'member', { libId: a });
        if (m === 'PATCH') return r('libraryCues.patch', 'editor', { libId: a });
        if (m === 'DELETE') return r('libraryCues.delete', 'editor', { libId: a });
        return bad('libraryCues.item');
      }
      if (c) return null;
      if (b === 'look') {
        if (read) return r('libraryCues.look', 'member', { libId: a });
        if (m === 'PUT') return r('libraryCues.lookPut', 'editor', { libId: a });
        return bad('libraryCues.look');
      }
      if (b === 'states') return read ? r('libraryCues.states', 'member', { libId: a }) : bad('libraryCues.states');
      if (b === 'usage') return read ? r('libraryCues.usage', 'member', { libId: a }) : bad('libraryCues.usage');
      return null;

    case 'cue-templates':
      if (a) return !b && read ? r('cueTemplates.get', 'member', { tplId: a }) : bad('cueTemplates.get');
      if (read) return r('cueTemplates.list', 'member');
      if (m === 'POST') return r('cueTemplates.create', 'editor');
      return bad('cueTemplates');

    case 'drive':
      if (a === 'files' && !b) return read ? r('drive.files', 'member') : bad('drive.files');
      if (a === 'files' && b && c === 'assign') return m === 'POST' ? r('drive.assign', 'editor') : bad('drive.assign');
      // 動畫師「提交審查」前會先觸發一次同步（看影片上去了沒）→ 成員都可以同步
      if (a === 'sync' && !b) return m === 'POST' ? r('drive.sync', 'member') : bad('drive.sync');
      if (a === 'sync-log' && !b) return read ? r('drive.syncLog', 'member') : bad('drive.syncLog');
      return null;

    case 'songs': {
      if (!a) {
        if (read) return r('songs.list', 'member');
        if (m === 'POST') return r('songs.create', 'editor');
        return bad('songs');
      }
      if (a === 'reorder' && !b) return m === 'POST' ? r('songs.reorder', 'editor') : bad('songs.reorder');
      const songId = a;
      if (!b) {
        if (read) return r('songs.get', 'member', { songId });
        if (m === 'PATCH') return r('songs.patch', 'songPatch', { songId });
        if (m === 'DELETE') return r('songs.delete', 'editor', { songId });
        return bad('songs.item');
      }
      if (b === 'import-cues' && !c) return m === 'POST' ? r('songs.importCues', 'editor', { songId }) : bad('songs.importCues');
      // LED 版型時間線（中途換版型，0039；docs/led-templates-api.md）：整份換掉，只有製作
      if (b === 'template-timeline' && !c) return m === 'PUT' ? r('songs.templateTimeline', 'editor', { songId }) : bad('songs.templateTimeline');
      // 這首歌所有 cue 的物件覆寫：一次看 / 一次清（回到預設位置）/ 一次寫回（復原），只有製作（cueStatesBatch.mjs）
      if (b === 'cue-object-states') {
        if (!c) return read ? r('cueStatesBatch.list', 'editor', { songId }) : bad('cueStatesBatch.list');
        if (c === 'clear' && !d) return m === 'POST' ? r('cueStatesBatch.clear', 'editor', { songId }) : bad('cueStatesBatch.clear');
        if (c === 'restore' && !d) return m === 'POST' ? r('cueStatesBatch.restore', 'editor', { songId }) : bad('cueStatesBatch.restore');
        return null;
      }
      if (b === 'videos') return describeVideoRoute(m, read, songId, c, d, e);
      // 審片紀錄（V2 需修改、V3 已通過…），新的在前
      if (b === 'reviews' && !c) return read ? r('reviews.list', 'member', { songId }) : bad('reviews.list');
      if (b === 'mechanism-positions' && !c) {
        return read ? r('mechPositions.list', 'member', { songId }) : bad('mechPositions.list');
      }
      if (b !== 'cues') return null;
      if (!c) {
        if (read) return r('cues.list', 'member', { songId });
        if (m === 'POST') return r('cues.create', 'editor', { songId });
        return bad('cues');
      }
      if (c === 'reorder' && !d) return m === 'POST' ? r('cues.reorder', 'editor', { songId }) : bad('cues.reorder');
      if (c === 'rearrange' && !d) return m === 'POST' ? r('cues.rearrange', 'editor', { songId }) : bad('cues.rearrange');
      const cueId = c;
      if (!d) {
        if (read) return r('cues.get', 'member', { songId, cueId });
        if (m === 'PATCH') return r('cues.patch', 'editor', { songId, cueId });
        if (m === 'DELETE') return r('cues.delete', 'editor', { songId, cueId });
        return bad('cues.item');
      }
      if (d === 'reset' && !e) return m === 'POST' ? r('cues.reset', 'editor', { songId, cueId }) : bad('cues.reset');
      if (d === 'states') {
        if (!e) return read ? r('states.list', 'member', { songId, cueId }) : bad('states.list');
        if (m === 'PUT' || m === 'DELETE') return r('states.item', 'editor', { songId, cueId, objId: e });
        return bad('states.item');
      }
      if (d === 'mechanisms') {
        if (!e) return null;
        if (m === 'PUT' || m === 'DELETE') return r('mechPositions.item', 'editor', { songId, cueId, mechId: e });
        return bad('mechPositions.item');
      }
      // 一次寫很多個機關在這個 cue 的位置和延遲（套用花樣）
      if (d === 'mechanism-positions' && !e) return m === 'PUT' ? r('mechPositions.bulk', 'editor', { songId, cueId }) : bad('mechPositions.bulk');
      return null;
    }
    default:
      return null;
  }
}

// /api/projects/:id/songs/:songId/videos[...]（歌曲影片版本，API 文件在 docs/videos-api.md）
//   GET    videos                       版本清單                 成員
//   POST   videos/uploads               開始上傳（分段）          交影片的人
//   POST   videos/link                  貼連結（後台複製到 R2）  交影片的人
//   GET    videos/:videoId              單一版本（含上傳 / 複製進度） 成員
//   PATCH  videos/:videoId              改標題 / 說明 / 長寬秒數    admin 或交這一版的人
//   DELETE videos/:videoId              刪掉這一版（號碼不再用）    admin 或交這一版的人
//   PUT    videos/:videoId/parts/:n     傳第 n 段                admin 或交這一版的人
//   POST   videos/:videoId/complete     上傳完成                 admin 或交這一版的人
//   POST   videos/:videoId/abort        取消上傳                 admin 或交這一版的人
//   POST   videos/:videoId/retry        複製失敗重試             admin 或交這一版的人
//   GET    videos/:videoId/stream       播放（也可以用 /api/videos/:videoId/stream?pass=） 成員
//   GET    videos/deleted               最近刪除（30 天內）         製作
//   POST   videos/:videoId/restore      救回來（號碼不變）          製作
//   POST   videos/duplicates            有沒有同一個檔案（指紋）    交影片的人
function describeVideoRoute(m, read, songId, c, d, e) {
  const r = (kind, need, extra = {}) => ({ kind, need, songId, ...extra });
  const bad = (kind) => ({ kind, need: null, methodNotAllowed: true });
  if (!c) return read ? r('videos.list', 'member') : bad('videos.list');
  if (c === 'uploads' && !d) return m === 'POST' ? r('videos.createUpload', 'videoUploader') : bad('videos.createUpload');
  if (c === 'link' && !d) return m === 'POST' ? r('videos.link', 'videoLinker') : bad('videos.link');
  // 最近刪除（30 天內還能救回來）：只有製作
  if (c === 'deleted' && !d) return read ? r('videos.deleted', 'editor') : bad('videos.deleted');
  // 上傳之前問：這個專案有沒有同一個檔案（指紋）；跟上傳同一個權限
  if (c === 'duplicates' && !d) return m === 'POST' ? r('videos.duplicates', 'videoUploader') : bad('videos.duplicates');
  const videoId = c;
  if (!d) {
    if (read) return r('videos.get', 'member', { videoId });
    if (m === 'PATCH') return r('videos.patch', 'videoEditor', { videoId });
    if (m === 'DELETE') return r('videos.delete', 'videoEditor', { videoId });
    return bad('videos.item');
  }
  if (d === 'parts' && e) return m === 'PUT' ? r('videos.part', 'videoUploader', { videoId, partNumber: e }) : bad('videos.part');
  if (d === 'complete' && !e) return m === 'POST' ? r('videos.complete', 'videoUploader', { videoId }) : bad('videos.complete');
  if ((d === 'abort' || d === 'retry') && !e) {
    return m === 'POST' ? r('videos.' + d, 'videoEditor', { videoId }) : bad('videos.' + d);
  }
  if (d === 'stream' && !e) return read ? r('videos.stream', 'member', { videoId }) : bad('videos.stream');
  // 救回刪掉的版本（號碼不變）：只有製作；網址上的是刪掉的版本 → deletedVideoId（不用 videoId 那套「找不到就 404」）
  if (d === 'restore' && !e) {
    return m === 'POST' ? r('videos.restore', 'editor', { deletedVideoId: videoId, allowArchived: true }) : bad('videos.restore');
  }
  return null;
}

/** 角色夠不夠 need（songPatch / projectPatch / videoUploader 先放行，handler 裡再細分） */
export function roleMeetsNeed(need, { role, globalRole }) {
  if (!role) return false;
  switch (need) {
    case 'member':
    case 'songPatch':
      return true;
    case 'editor':
    case 'projectPatch':
      return canEditProjectContent(role);
    case 'shareManager':
      return canManageShareLinks(role);
    case 'memberManager':
      return role === 'admin';
    case 'stageProps':
      return canEditStageProps(role);
    case 'cameraBookmarks':
      return canEditCameraBookmarks(role);
    case 'videoUploader':
      return role === 'admin' || role === 'animator';
    case 'videoLinker':
    case 'videoEditor':
      return role === 'admin' || role === 'animator' || role === 'director';
    case 'globalAdmin':
      return globalRole === 'admin';
    default:
      return false;
  }
}

/**
 * 共用模型庫（/api/assets）的清單能不能看：全站 admin，或至少是一個（沒封存的）專案的 admin
 * （舊版前端裡專案 admin 也能打開專案頁的「從模型庫選」；改模型庫一律只有全站 admin）
 */
export function canBrowseSharedAssets({ globalRole, isProjectAdminSomewhere }) {
  return globalRole === 'admin' || !!isProjectAdminSomewhere;
}

/** 權限不夠時給使用者看的話 */
export function needDeniedMessage(need) {
  switch (need) {
    case 'editor':
    case 'projectPatch':
      return '只有製作可以修改專案內容';
    case 'shareManager':
      return '只有製作或導演可以管理分享連結';
    case 'memberManager':
      return '只有這個專案的製作可以管理成員';
    case 'stageProps':
      return STAGE_PROPS_DENIED_MESSAGE;
    case 'cameraBookmarks':
      return CAMERA_BOOKMARKS_DENIED_MESSAGE;
    case 'videoUploader':
      return '導演可以貼連結交一版；上傳檔案請找負責的動畫師或製作';
    case 'videoLinker':
    case 'videoEditor':
      return '沒有權限交影片';
    case 'globalAdmin':
      return '只有製作可以做這件事';
    default:
      return '沒有權限存取此專案';
  }
}

// 改專案（PATCH /api/projects/:id）時，只有全站 admin 能動的欄位
export const PROJECT_GLOBAL_ADMIN_FIELDS = [
  'status',
  'drive_folder_id', 'drive_filename_pattern', 'drive_oauth_token_id',
  'scale_correction', 'look_settings', 'material_overrides', 'home_view', 'led_canvas',
];

/**
 * 指派動畫師（PATCH songs/:id 的 animator_user_id）：只能指派「這個專案的動畫師」
 * @param {unknown} uid             body 裡的 animator_user_id（null / '' = 取消指派）
 * @param {string|null} memberRole  這個人在這個專案的角色（project_members.role；不是成員 = null）
 * @returns {{ok: true, clear?: boolean} | {ok: false, status: number, error: string}}
 */
export function animatorAssignmentDecision(uid, memberRole) {
  if (uid === null || uid === undefined || uid === '') return { ok: true, clear: true };
  if (typeof uid !== 'string' || !ID_RE.test(uid)) return { ok: false, status: 400, error: '指派的動畫師不合法' };
  if (memberRole === 'animator') return { ok: true };
  if (!memberRole) {
    return { ok: false, status: 400, error: '這個人不是這個專案的成員，不能指派。請先把他加進專案、設成動畫師' };
  }
  return { ok: false, status: 400, error: '這個人在這個專案不是動畫師，不能指派。請先在成員設定把他改成動畫師' };
}

/**
 * 改歌（PATCH songs/:id）的 body 裡，除了狀態以外的欄位 → 需要 editor
 */
export const SONG_CONTENT_FIELDS = ['name', 'order', 'animator_user_id', 'drive_folder_id', 'code', 'template_id'];

// ─────────────────────────────────────────────
// 留言
// ─────────────────────────────────────────────

/** 留言串的 session id（要跟 web/src/lib/api.ts 的 songCommentSession 一模一樣） */
export function commentSessionFor(projectId, songId) {
  const p = String(projectId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28);
  const s = String(songId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28);
  return `${p}-${s}`;
}

/**
 * 從 session id 猜原本的 project id / song id（兩段都沒被截斷、中間只有一個「-」時才猜得出來；
 * 猜不出來回 null，worker 就改用整張歌曲表比對）
 */
export function parseCommentSession(session) {
  if (typeof session !== 'string') return null;
  const parts = session.split('-');
  if (parts.length !== 2) return null;
  const [p, s] = parts;
  if (!p || !s || p.length >= 28 || s.length >= 28) return null;
  if (!ID_RE.test(p) || !ID_RE.test(s)) return null;
  return { projectId: p, songId: s };
}

/**
 * 留言摘要（GET /api/projects/:id/comments/summary）的一列 → API 格式
 * @param {object} row  SQL 的結果（song_id, count, open_count, latest_at, latest_id, others_count, others_latest_at）
 */
export function commentSummaryRow(row) {
  const n = (v) => Number(v) || 0;
  return {
    songId: row.song_id,
    count: n(row.count),
    openCount: n(row.open_count),
    latestAt: row.latest_at || null,
    latestId: row.latest_id || null,
    // 別人留的（自己的留言不算未讀）
    fromOthersCount: n(row.others_count),
    latestFromOthersAt: row.others_latest_at || null,
  };
}

/** 留言上顯示的身分（跟前端一樣：導演 / 動畫師 / 其他人顯示成 designer） */
export function commentAuthorRole(globalRole) {
  if (globalRole === 'director') return 'director';
  if (globalRole === 'animator') return 'animator';
  return 'designer';
}

/** 這則留言是不是這個人留的 */
export function isCommentAuthor(comment, userId) {
  return !!comment?.authorUserId && comment.authorUserId === userId;
}

/** 能不能改文字 / 刪除（自己的留言，或專案 admin） */
export function canModifyComment(comment, userId, role) {
  return role === 'admin' || isCommentAuthor(comment, userId);
}

// ─────────────────────────────────────────────
// 審片 v2：發留言 / 回覆、「已改好（V3）」、重新打開（handler 在 reviews.mjs）
// ─────────────────────────────────────────────

const allow = { ok: true };
const deny = (error, status = 403) => ({ ok: false, status, error });

/** 動畫師能不能動這首歌：指派給自己，或還沒指派（跟交影片、提交審查一樣） */
export function animatorCanWorkOnSong(song, userId) {
  return !song?.animator_user_id || song.animator_user_id === userId;
}

/** 發留言 / 回覆：admin、導演都可以；動畫師只能在自己的歌或還沒指派的歌 */
export function commentPostDecision({ role, userId, song }) {
  if (!role) return deny('沒有權限存取此專案');
  if (role === 'admin' || role === 'director') return allow;
  if (role === 'animator') {
    return animatorCanWorkOnSong(song, userId)
      ? allow
      : deny('這首歌指派給其他動畫師，只有他、導演和製作可以在這首歌留言');
  }
  return deny('沒有權限留言');
}

/** 標「已改好（V3）」：admin、負責這首歌的動畫師、留言的人自己（收回自己的意見） */
export function commentResolveDecision({ role, userId, song, comment }) {
  if (!role) return deny('沒有權限存取此專案');
  if (role === 'admin') return allow;
  if (role === 'animator' && animatorCanWorkOnSong(song, userId)) return allow;
  if (isCommentAuthor(comment, userId)) return allow;
  if (role === 'director') return deny('「已改好」由動畫師改完後標；看過新版覺得還沒改好，可以按「重新打開」');
  return deny('這首歌指派給其他動畫師，只有他或製作可以標「已改好」');
}

/** 重新打開（已改好 → 還沒改好）：admin、導演、負責的動畫師（標錯了收回）、留言的人自己 */
export function commentReopenDecision({ role, userId, song, comment }) {
  if (!role) return deny('沒有權限存取此專案');
  if (role === 'admin' || role === 'director') return allow;
  if (role === 'animator' && animatorCanWorkOnSong(song, userId)) return allow;
  if (isCommentAuthor(comment, userId)) return allow;
  return deny('只有導演、製作或負責這首歌的動畫師可以重新打開');
}

/**
 * /api/notifications[...]（站內通知，只看得到自己的；要登入，分享連結的訪客沒有）
 *   GET  /api/notifications         清單 + 未讀數（一個請求）
 *   POST /api/notifications/read    標為已讀（{ ids: [...] } 或 { all: true }）
 * @returns {{kind: string} | {kind: string, methodNotAllowed: true} | null}
 */
export function describeNotificationRoute(method, segs) {
  const m = (method || 'GET').toUpperCase();
  const [, , sub = null, extra = null] = segs;
  if (extra !== null) return null;
  if (!sub) return (m === 'GET' || m === 'HEAD') ? { kind: 'notifications.list' } : { kind: 'notifications.list', methodNotAllowed: true };
  if (sub === 'read') return m === 'POST' ? { kind: 'notifications.read' } : { kind: 'notifications.read', methodNotAllowed: true };
  return null;
}

// ─────────────────────────────────────────────
// 活動紀錄：寫進去之前把敏感欄位遮掉（號碼、密碼、通行證）
// ─────────────────────────────────────────────

const SENSITIVE_KEY_RE = /^(access_?code|accesscode|password|password_?hash|password_?salt|pwd|secret|refresh_?token|access_?token|share_?access)$/i;

export function scrubActivityPayload(payload, depth = 0) {
  if (payload === null || typeof payload !== 'object') return payload;
  if (depth > 6) return '[略]';
  if (Array.isArray(payload)) return payload.map(v => scrubActivityPayload(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? '[已隱藏]' : scrubActivityPayload(v, depth + 1);
  }
  return out;
}
