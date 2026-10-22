/**
 * Stage Previz Worker
 *
 * 兩個功能：
 *
 * 1. Google Drive CORS Proxy（根路徑 + ?id=FILE_ID）
 *    - 解決 Drive 大檔（>100MB）的二段確認
 *    - 串流 + Range header 支援
 *
 * 2. 留言 API（/api/comments）
 *    - GET    /api/comments?session=xxx        → { comments: [...] }
 *    - POST   /api/comments?session=xxx        body: { comment: {...} }
 *    - DELETE /api/comments?session=xxx&id=yyy → { ok: true }
 *    - 後端：CF KV (binding = COMMENTS)
 *    - session id 由前端用 hash(src URL) 計算
 *
 * 部署：
 *   1. 第一次：npx wrangler kv:namespace create COMMENTS
 *      把回傳 id 填到 wrangler.toml
 *   2. npx wrangler deploy
 */

import {
  loginThrottleDecision, loginLockedMessage, loginClientKey, shareAttemptKey,
  slugMissKey, slugLockedMessage, SLUG_MISS_MAX,
  LOGIN_ATTEMPT_KEEP_MS, LOGIN_LOOKBACK_MS,
} from './loginThrottle.mjs';
import { isTrustedOrigin } from './origins.mjs';
// 好讀分享網址的規則跟前端共用同一個檔（純判斷，wrangler 打包時會一起編進來）
import { normalizeSlugInput, slugProblem, slugProblemMessage } from '../web/src/lib/shareSlug.ts';
// 比例尺的樂手和器材（0033）：存檔格式和檢查規則也跟前端共用同一個檔
import { checkStagePropsForSave, parseStoredStageProps, serializeStageProps } from '../web/src/lib/stageProps.ts';
import { checkCameraBookmarksForSave, parseStoredCameraBookmarks, serializeCameraBookmarks } from '../web/src/lib/cameraBookmarks.ts';
// 權限規則（誰在這個專案能做什麼）— 純判斷，access.test.mjs 有測
import {
  projectRoleOf, canEditProjectContent, songStatusDecision,
  describeProjectRoute, roleMeetsNeed, needDeniedMessage, PROJECT_GLOBAL_ADMIN_FIELDS, SONG_CONTENT_FIELDS,
  parseCommentSession, commentSessionFor, commentAuthorRole, canModifyComment,
  scrubActivityPayload, animatorAssignmentDecision, commentSummaryRow, canBrowseSharedAssets, describeNotificationRoute,
} from './access.mjs';
// 每個 cue 時物件在哪裡（管理頁和分享連結共用同一份計算）
import { buildCueStates } from './cueStates.mjs';
// 分享連結密碼（加鹽雜湊）+ 通行證
import {
  hashSharePassword, verifySharePassword, shareLinkHasPassword, shareCredential,
  signShareAccess, verifyShareAccess, SHARE_PASSWORD_MAX, timingSafeEqualStr,
} from './sharePassword.mjs';
// 浮水印 / 禁止下載（0038）：規則和預設值前後端共用同一份（web/src/lib/watermark/policy.ts）；
// 訪客的影片要帶短效播放通行證（shareMedia.mjs）
import {
  resolveNewLinkProtection, resolveLinkProtectionPatch, protectionOfRow, readFlag,
  canSetMemberWatermark, MEMBER_WATERMARK_DENIED_MESSAGE, PROTECTION_FLAG_ERROR, memberWatermarkOn,
} from '../web/src/lib/watermark/policy.ts';
import { signSharePlay, decideShareStream, withShareQuery, sharePlaybackCacheControl, shortLinkId } from './shareMedia.mjs';
// 留言（D1 一則一列）
// （發 / 改 / 刪在 reviews.mjs；這裡只剩讀清單和舊版 KV 留言串）
import { sanitizeComment, rowToComment, COMMENT_ID_RE, thumbKeyFromPath } from './comments.mjs';
// 分享連結的訪客留言（0026，預設關）：名字、內容整理、防亂發、看得到哪些
import * as guest from './guestComments.mjs';
// 審片 v2：留言綁版本 / 回覆 / 已改好、通過・需修改的審片紀錄、站內通知（直接用 D1，回傳 { status, body }）
import * as reviews from './reviews.mjs';
// 留言的參考圖片（0028）：上傳、掛到留言上、刪留言 / 刪歌時清 R2、排程清掉沒送出的
import * as attachments from './commentAttachments.mjs';
// 歌曲影片版本（純判斷：代號對歌、版本號、連結、權限、播放通行證）
import {
  normalizeSongCodeInput, nextSongCode, fillMissingSongCodes, songCodeTakenBy, matchSongByFilename,
  videoMimeFor, extForMime, isDriveVideoFile, driveSourceRev, unsupportedFormatMessage, planDriveVersions, driveVersionKey,
  planParts, expectedPartSize, missingParts, nextCopyPart, UPLOAD_PART_SIZE, copyPartSize, MIB,
  versionLabel, videoMaxBytes, formatBytes, VIDEO_TITLE_MAX, VIDEO_NOTE_MAX,
  videoUploadDecision, videoLinkDecision, videoModifyDecision,
  classifyVideoLink, interpretProbe,
  signVideoPass, verifyVideoPass, parseRangeHeader,
} from './videos.mjs';
// 登入碼（產生、雜湊、明文 / 雜湊兩種存法）
import {
  generateLoginCode, normalizeLoginCode, hashLoginCode, legacyCustomCodeDecision, loginCodeStorageMode,
  userLoginCodeView, LOGIN_CODE_STORAGE_KEY, CUSTOM_CODE_NOT_ALLOWED,
} from './loginCodes.mjs';
// 邀請連結（邀請碼、狀態、檢查）
import {
  generateInviteToken, isInviteTokenShape, hashInviteToken, newInviteId, parseInviteCreate,
  inviteUserDecision, inviteState, inviteProblem, inviteLandingPath, inviteToApi,
} from './invites.mjs';
// 機關（升降台、轉台…）：定義、每個 cue 的位置、總表、複製 / 匯出 / 舊滑桿同步（docs/mechanisms-api.md）
import * as mech from './mechanisms.mjs';
import * as ledTpl from './ledTemplates.mjs';
// 自動貼 UV：新模型版本 + 畫布 + 舊版面一次換好、模型版本搭配的畫布
import * as uvLayouts from './modelUvLayouts.mjs';
import * as cueStatesBatch from './cueStatesBatch.mjs';
// 登入狀態什麼時候失效（重設登入碼 / 停用帳號 → 那個人其他裝置的登入失效）
import {
  SESSION_TTL_SEC, sessionIssuedAtSec, sessionTokenExp, sessionTokenHash, sessionAllowed,
  revokeSessionsUpdate, sessionIssueSec, deactivateDecision,
} from './sessions.mjs';
// 3D 模型檔在 R2 的檔名（新上傳的加 128 bits 隨機，猜不到）
import { newProjectModelKey, newSharedAssetKey, isModelVersionFile, modelCacheControl, modelVersionTimestamp } from './modelKeys.mjs';
// 前端錯誤回報、製作的系統狀態（備份 / 錯誤）、排程裡的備份和下載檔更新、NDI 小程序下載
import { handleClientErrorPost } from './clientErrors.mjs';
import { handleOpsRoute, runOpsCron } from './ops.mjs';
import { handleNdiDownload, downloadNameFromPath } from './downloads.mjs';
// 省空間：刪掉的版本留 30 天、救回來、專案結束清影片、長期存放、空間用量、重複的檔案（指紋）
import * as storage from './storage.mjs';

const MAX_COMMENTS_PER_SESSION = 500;
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export default {
  async fetch(request, env, ctx) {
    if (ctx) execCtxByRequest.set(request, ctx);
    const response = await routeRequest(request, env);
    return applyCorsToResponse(response, request);
  },

  // Cron Trigger（每 5 分鐘）：
  //   1. 掃所有有 drive_folder_id 的 project 同步檔案（新的 / 改過的影片會排進複製）
  //   2. 接著複製等著的影片（貼連結 / Drive）到 R2
  //   3. 清掉上傳到一半就放著不管的
  async scheduled(_event, env, ctx) {
    if (!env.DB) return;
    const syncs = [];
    try {
      const r = await env.DB.prepare(
        `SELECT id FROM projects
          WHERE status != 'archived'
            AND drive_folder_id IS NOT NULL
            AND drive_folder_id != ''
            AND drive_oauth_token_id IS NOT NULL`
      ).all();
      for (const row of (r.results || [])) {
        // 多個 sync 並行
        syncs.push(driveSyncProjectInternal(env, row.id, 'cron').catch(e => {
          console.error('[cron sync]', row.id, e?.message || e);
        }));
      }
    } catch (e) {
      console.error('[cron]', e?.message || e);
    }
    ctx.waitUntil((async () => {
      await Promise.allSettled(syncs);
      // Drive 同步也用掉幾次對外請求 → 複製能用的次數扣掉一些
      const step = { ...VIDEO_CRON_STEP, maxFetches: Math.max(5, VIDEO_CRON_STEP.maxFetches - syncs.length * 4) };
      await runVideoCopyJobs(env, step).catch(e => console.error('[cron video copy]', e?.message || e));
      await cleanupStaleVideoUploads(env).catch(e => console.error('[cron video cleanup]', e?.message || e));
      await reviews.pruneNotifications(env.DB).catch(e => console.error('[cron notifications prune]', e?.message || e));
      // 留言的參考圖片：上傳了一天都沒送出的清掉（0028）
      await attachments.cleanupPendingAttachments(env.DB, env.MODELS).catch(e => console.error('[cron attachments cleanup]', e?.message || e));
    })());
    // 資料庫每天備份到 R2、NDI 小程序檢查新版、清掉 30 天以前的前端錯誤（ops.mjs）
    ctx.waitUntil(runOpsCron(env).catch(e => console.error('[cron ops]', e?.message || e)));
    // 刪掉超過 30 天的版本清檔案、空間用量、搬到長期存放、補算指紋（storage.mjs）
    ctx.waitUntil(storage.runStorageCron(env).catch(e => console.error('[cron storage]', e?.message || e)));
  }
};

// 這個請求的 ExecutionContext（回應送出後還要做的事用 waitUntil，例如影片複製）
const execCtxByRequest = new WeakMap();

/** 回應送出後繼續做（最多 30 秒）；本機測試沒有 ctx 時就直接在背景跑 */
function runInBackground(request, promise) {
  const p = Promise.resolve(promise).catch(e => console.error('[background]', e?.message || e));
  const c = request && execCtxByRequest.get(request);
  if (c?.waitUntil) c.waitUntil(p);
}

// 把 response 的 CORS header 依「從哪個網站來」調整：
// - 自己的網站（origins.mjs 的清單：previz.haimiaan.com、test.previz…、stage-previz.vercel.app、Vercel 預覽、本機）
//   → 回具體 origin + Allow-Credentials: true（前端 fetch 用 credentials: 'include'，瀏覽器要求這樣才肯帶 cookie）
// - 其他網站 → 回 '*'、不帶 credentials：公開的東西（分享連結、Drive 代理、留言）照樣能讀，
//   但不能用已登入使用者的 cookie 讀資料
function applyCorsToResponse(response, request) {
  const origin = request.headers.get('origin');
  if (!origin) return response;
  const headers = new Headers(response.headers);
  if (isTrustedOrigin(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
  } else {
    headers.set('Access-Control-Allow-Origin', '*');
    headers.delete('Access-Control-Allow-Credentials');
  }
  headers.set('Vary', 'Origin');
  // 確保 OPTIONS preflight 也帶 methods / headers
  if (!headers.has('Access-Control-Allow-Methods')) {
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
  }
  // 一律覆蓋 Allow-Headers，確保包含 Authorization（讓前端可送 Bearer token）和分享連結的密碼 / 通行證
  headers.set('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function routeRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  if (url.pathname === '/api/comments') {
    return handleComments(request, env, url);
  }
  if (url.pathname.startsWith('/api/comment-thumbs/')) {
    return handleCommentThumb(request, env, url);
  }
  // 留言的參考圖片（0028）：上傳 / 拿掉還沒送出的（要登入）、看圖（不用登入，網址猜不到）
  if (url.pathname === '/api/comment-attachments') {
    return handleCommentAttachments(request, env, url);
  }
  if (url.pathname.startsWith('/api/comment-attachments/')) {
    return attachments.serveCommentAttachment(request, env.MODELS, url.pathname, corsHeaders());
  }
  // 站內通知（只看自己的；要登入）
  if (url.pathname === '/api/notifications' || url.pathname.startsWith('/api/notifications/')) {
    return handleNotifications(request, env, url);
  }

  // 前端錯誤回報（不用登入；有登入就記是誰；每個 IP / 每天有上限）
  if (url.pathname === '/api/client-errors') {
    if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405);
    const me = await getCurrentUser(request, env).catch(() => null);
    return handleClientErrorPost(request, env, { userId: me?.id || null });
  }
  // 製作的系統狀態：備份清單 / 下載、最近的前端錯誤（ops.mjs，只有全站製作）
  if (url.pathname.startsWith('/api/admin/')) {
    return handleOpsRoute(request, env, url, { me: await getCurrentUser(request, env) });
  }
  // NDI 小程序下載（R2 快取 GitHub 最新版；downloads.mjs）
  if (url.pathname.startsWith('/downloads/')) {
    const name = downloadNameFromPath(url.pathname);
    if (!name) return jsonResp({ error: 'Not found' }, 404);
    const c = execCtxByRequest.get(request);
    return handleNdiDownload(request, env, name, { waitUntil: c?.waitUntil ? (p) => c.waitUntil(p) : null });
  }

  if (url.pathname === '/api/auth/login'  && request.method === 'POST')  return authLogin(request, env);
  if (url.pathname === '/api/auth/logout' && request.method === 'POST')  return authLogout();
  if (url.pathname === '/api/auth/me'     && request.method === 'GET')   return authMe(request, env);

  // 公開分享連結（read-only，無需登入）
  //   /api/share/<連結碼>/...   舊式網址（/share/<連結碼>）只拿來查連結碼
  //   /api/s/<網址名稱>/...      好讀網址（/s/<網址名稱>）只拿來查網址名稱 → 兩邊永遠不會互相查到
  if (url.pathname.startsWith('/api/share/')) {
    const token = url.pathname.replace('/api/share/', '').split('/')[0];
    return handleShareRouter(request, env, url, { kind: 'token', key: token });
  }
  if (url.pathname.startsWith('/api/s/')) {
    const slug = url.pathname.slice('/api/s/'.length).split('/')[0];
    return handleShareRouter(request, env, url, { kind: 'slug', key: slug });
  }
  // Drive OAuth & accounts
  if (url.pathname === '/api/drive/oauth/start'    && (request.method === 'GET' || request.method === 'POST')) return driveOAuthStart(request, env, url);
  if (url.pathname === '/api/drive/oauth/callback' && request.method === 'GET')    return driveOAuthCallback(request, env, url);
  if (url.pathname === '/api/drive/accounts'       && request.method === 'GET')    return driveListAccounts(request, env);
  if (url.pathname.startsWith('/api/drive/accounts/') && request.method === 'DELETE') {
    const accId = url.pathname.replace('/api/drive/accounts/', '');
    return driveDeleteAccount(request, env, accId);
  }
  // Drive folder browse (admin pick folder UI)
  if (url.pathname === '/api/drive/folders' && request.method === 'GET') return driveListFolders(request, env, url);
  // Drive file stream proxy（給導演端 video player 用）
  if (url.pathname.startsWith('/api/drive/stream/') && (request.method === 'GET' || request.method === 'HEAD')) {
    const fid = url.pathname.replace('/api/drive/stream/', '');
    return driveStreamFile(request, env, fid);
  }

  if (url.pathname === '/api/users' || url.pathname.startsWith('/api/users/')) {
    return handleUsersRouter(request, env, url);
  }

  // 邀請連結：清單（全站 admin）、打開前先看（peek）、用掉（redeem，不用登入）
  if (url.pathname === '/api/invites' || url.pathname.startsWith('/api/invites/')) {
    return handleInvitesRouter(request, env, url);
  }

  if (url.pathname === '/api/assets' || url.pathname.startsWith('/api/assets/')) {
    return handleAssetsRouter(request, env, url);
  }

  if (url.pathname === '/api/projects/import' && request.method === 'POST') {
    const me = await getCurrentUser(request, env);
    if (!me) return jsonResp({ error: '未登入' }, 401);
    if (me.role !== 'admin') return jsonResp({ error: '只有製作可以匯入專案' }, 403);
    return importProject(request, env);
  }
  if (url.pathname === '/api/projects-archived' && request.method === 'GET') {
    const me = await getCurrentUser(request, env);
    if (!me) return jsonResp({ error: '未登入' }, 401);
    if (me.role !== 'admin') return jsonResp({ error: '只有製作可以看封存的專案' }, 403);
    return listProjects(env, me, { archived: true });
  }
  if (url.pathname === '/api/search' && request.method === 'GET') {
    return handleSearch(request, env, url);
  }
  if (url.pathname.startsWith('/api/cue-templates/') && request.method === 'DELETE') {
    const tid = url.pathname.replace('/api/cue-templates/', '');
    return deleteCueTemplate(request, env, tid);
  }
  // 歌曲影片播放（成員）：/api/videos/:videoId/stream?pass=<通行證>
  if (url.pathname.startsWith('/api/videos/') && (request.method === 'GET' || request.method === 'HEAD')) {
    const parts = url.pathname.split('/').filter(Boolean);  // [api, videos, id, stream]
    if (parts.length === 4 && parts[3] === 'stream') return handleMemberVideoStream(request, env, url, parts[2]);
    return jsonResp({ error: 'Not found' }, 404);
  }
  if (url.pathname === '/api/projects' || url.pathname.startsWith('/api/projects/')) {
    return handleProjectsRouter(request, env, url);
  }

  if (url.pathname === '/api/shows' || url.pathname.startsWith('/api/shows/')) {
    return handleShowsRouter(request, env, url);
  }

  if (url.pathname.startsWith('/r2/models/') || url.pathname.startsWith('/r2/assets/')) {
    return handleModelDownload(request, env, url);
  }

  if (url.pathname === '/' || url.pathname === '') {
    return handleDriveProxy(request, env, url);
  }

  return jsonResp({ error: 'Not found' }, 404);
}

// 統一 router：把 /api/projects/* 分派到對應 handler
//   1. 一定要登入
//   2. describeProjectRoute（access.mjs）：這個路徑要什麼權限、網址上有哪些 id 要檢查
//   3. 一次查完：專案在不在、我在這個專案是什麼角色、網址上的歌 / cue / 物件是不是真的屬於這個專案
//      （不然可以用自己專案的網址去改別人專案的歌）
//   4. 封存的專案：非 admin 看不到；admin 只能看和還原，不能改
//
// 路徑形態：
//   /api/projects                                             → 列表 / 建立
//   /api/projects/:id                                         → 單筆（GET / PATCH / DELETE=封存）
//   /api/projects/:id/stage-objects[/:objId|seed-defaults|bulk]
//   /api/projects/:id/model[/use-asset|/versions[/activate|/:ts.glb]]
//   /api/projects/:id/songs[/reorder|/:songId[/import-cues|/cues[/reorder|/:cueId[/reset|/states[/:objId]]]]]
//   /api/projects/:id/songs/:songId/videos[/uploads|/link|/:videoId[/parts/:n|/complete|/abort|/retry|/stream]]
//   /api/projects/:id/activity | duplicate | restore | export | cue-templates | drive/... | share-links[/:token]
async function handleProjectsRouter(request, env, url) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);

  const segs = url.pathname.split('/').filter(Boolean);
  const projectId = segs[2] || null;

  try {
    if (!projectId) {
      if (request.method === 'GET') return await listProjects(env, me);
      if (request.method === 'POST') {
        if (me.role !== 'admin') return jsonResp({ error: '只有製作可以建立專案' }, 403);
        return await createProject(request, env, me);
      }
      return jsonResp({ error: 'Method not allowed' }, 405);
    }
    if (!ID_RE.test(projectId)) return jsonResp({ error: 'Invalid project id' }, 400);

    const route = describeProjectRoute(request.method, segs);
    if (!route) return jsonResp({ error: 'Not found' }, 404);
    if (route.methodNotAllowed) return jsonResp({ error: 'Method not allowed' }, 405);
    for (const id of [route.songId, route.cueId, route.objId, route.videoId, route.inviteId, route.mechId, route.groupId, route.deletedVideoId, route.tplId, route.screenId]) {
      if (id !== undefined && !ID_RE.test(id)) return jsonResp({ error: 'Invalid id' }, 400);
    }

    const ctx = await loadProjectContext(env, me, projectId, route);
    if (!ctx.project) return jsonResp({ error: '找不到這個專案' }, 404);
    if (ctx.archived && me.role !== 'admin') return jsonResp({ error: '找不到這個專案（可能已封存）' }, 404);
    if (!ctx.role) return jsonResp({ error: '沒有權限存取此專案' }, 403);
    if (!roleMeetsNeed(route.need, { role: ctx.role, globalRole: me.role })) {
      return jsonResp({ error: needDeniedMessage(route.need) }, 403);
    }
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    if (ctx.archived && !isRead && !route.allowArchived) {
      return jsonResp({ error: '這個專案已封存，請先還原再修改' }, 409);
    }
    if (route.songId && !ctx.song) return jsonResp({ error: '這個專案裡找不到這首歌' }, 404);
    if (route.cueId && !ctx.cueFound) return jsonResp({ error: '這首歌裡找不到這個 cue' }, 404);
    if (route.objId && !ctx.objFound) return jsonResp({ error: '這個專案裡找不到這個物件' }, 404);
    if (route.videoId && !ctx.video) return jsonResp({ error: '這首歌裡找不到這一版影片' }, 404);
    if (route.mechId && !ctx.mechanism) return jsonResp({ error: '這個專案裡找不到這個機關' }, 404);
    if (route.groupId && !ctx.mechGroup) return jsonResp({ error: '這個專案裡找不到這一排機關' }, 404);

    return await dispatchProjectRoute(request, env, url, ctx, route, segs);
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

// 專案 + 我的角色 + 網址上的歌 / cue / 物件屬不屬於這個專案（一次往返）
async function loadProjectContext(env, me, projectId, route) {
  const stmts = [
    env.DB.prepare(
      `SELECT p.id, p.name, p.status, pm.role AS member_role
         FROM projects p
         LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
        WHERE p.id = ? LIMIT 1`
    ).bind(me.id, projectId),
  ];
  const at = {};
  if (route.songId) {
    at.song = stmts.length;
    stmts.push(env.DB.prepare(
      `SELECT id, name, status, animator_user_id, code FROM songs WHERE id = ? AND project_id = ? LIMIT 1`
    ).bind(route.songId, projectId));
  }
  if (route.videoId) {
    at.video = stmts.length;
    stmts.push(env.DB.prepare(
      `SELECT v.*, u.name AS created_by_name
         FROM song_videos v LEFT JOIN users u ON u.id = v.created_by
        WHERE v.id = ? AND v.song_id = ? AND v.project_id = ? AND v.deleted_at IS NULL LIMIT 1`
    ).bind(route.videoId, route.songId, projectId));
  }
  if (route.cueId) {
    at.cue = stmts.length;
    stmts.push(env.DB.prepare(
      `SELECT c.id FROM cues c JOIN songs s ON s.id = c.song_id
        WHERE c.id = ? AND c.song_id = ? AND s.project_id = ? LIMIT 1`
    ).bind(route.cueId, route.songId, projectId));
  }
  if (route.objId) {
    at.obj = stmts.length;
    stmts.push(env.DB.prepare(
      `SELECT id FROM stage_objects WHERE id = ? AND project_id = ? LIMIT 1`
    ).bind(route.objId, projectId));
  }
  if (route.mechId) {
    at.mechanism = stmts.length;
    stmts.push(env.DB.prepare(
      `SELECT id, kind, travel_min, travel_max, variant FROM mechanisms WHERE id = ? AND project_id = ? LIMIT 1`
    ).bind(route.mechId, projectId));
  }
  if (route.groupId) {
    at.mechGroup = stmts.length;
    stmts.push(env.DB.prepare(
      `SELECT id FROM mechanism_groups WHERE id = ? AND project_id = ? LIMIT 1`
    ).bind(route.groupId, projectId));
  }
  const results = stmts.length === 1 ? [await stmts[0].all()] : await env.DB.batch(stmts);
  const first = (i) => (i === undefined ? null : ((results[i]?.results || [])[0] || null));
  const project = first(0);
  return {
    me,
    projectId,
    project,
    role: project ? projectRoleOf(me.role, project.member_role) : null,
    archived: project?.status === 'archived',
    song: first(at.song),
    cueFound: !!first(at.cue),
    objFound: !!first(at.obj),
    video: first(at.video),
    mechanism: first(at.mechanism),
    mechGroup: first(at.mechGroup),
  };
}

async function dispatchProjectRoute(request, env, url, ctx, route, segs) {
  const { projectId } = ctx;
  const { songId, cueId, objId } = route;
  switch (route.kind) {
    case 'project.get':           return getProject(env, ctx);
    case 'project.patch':         return updateProject(request, env, ctx);
    case 'project.archive':       return archiveProject(request, env, projectId);
    case 'stageProps.get':
    case 'stageProps.put':        return handleStageProps(request, env, ctx);
    case 'cameraBookmarks.get':
    case 'cameraBookmarks.put':   return handleCameraBookmarks(request, env, ctx);
    case 'shareLinks':
    case 'shareLinks.item':       return handleProjectShareLinks(request, env, ctx, segs[4] || null);

    case 'stageObjects.list':     return listStageObjects(env, projectId);
    case 'stageObjects.create':   return createStageObject(request, env, projectId);
    case 'stageObjects.seed-defaults': return seedDefaultStageObjects(request, env, projectId);
    case 'stageObjects.bulk':     return bulkCreateStageObjects(request, env, projectId);
    case 'stageObjects.item':
      return request.method === 'PATCH'
        ? updateStageObject(request, env, projectId, objId)
        : deleteStageObject(request, env, projectId, objId);

    case 'model.get':
    case 'model.upload':          return handleModel(request, env, projectId);
    case 'model.useAsset':        return useSharedAssetForProject(request, env, projectId);
    case 'model.versions':        return listModelVersions(env, projectId);
    case 'model.activate':        return activateModelVersion(request, env, projectId);
    case 'model.deleteVersion':   return deleteModelVersion(request, env, projectId, segs[5]);

    case 'invites.list':          return listOpenInvites(env, { projectId });
    case 'invites.create':        return createInvite(request, env, ctx);
    case 'invites.revoke':        return revokeInvite(env, ctx, route.inviteId);

    case 'activity':              return listActivity(env, projectId, url.searchParams.get('limit') || '50');
    case 'comments.summary':      return commentsSummary(env, ctx);
    case 'duplicate':             return duplicateProject(request, env, projectId);
    case 'restore':               return restoreProject(request, env, projectId);
    case 'wrapUp.get':            return mechResp(storage.wrapUpPreview(env, { projectId }));
    case 'wrapUp.apply':          return applyProjectWrapUp(request, env, ctx);
    case 'export':                return exportProject(request, env, projectId);
    case 'cueTemplates.list':     return listCueTemplates(env, projectId);
    case 'cueTemplates.create':   return createCueTemplate(request, env, ctx);

    case 'drive.files':           return driveListProjectFiles(env, projectId);
    case 'drive.assign':          return driveAssignFile(request, env, projectId, segs[5]);
    case 'drive.sync':            return driveSyncProject(request, env, projectId, 'manual');
    case 'drive.syncLog':         return driveSyncLog(env, projectId);

    case 'songs.list':            return listSongs(env, projectId);
    case 'songs.create':          return createSong(request, env, projectId);
    case 'songs.reorder':         return reorderSongs(request, env, projectId);
    case 'songs.get':             return getSong(env, projectId, songId);
    case 'songs.patch':           return updateSong(request, env, ctx, songId);
    case 'songs.delete':          return deleteSong(request, env, projectId, songId);
    case 'songs.importCues':      return importCuesFromSong(request, env, projectId, songId);
    case 'songs.templateTimeline': return mechResp(ledTpl.putSongTimeline(request, env, ctx, songId, mechLog(request, env, projectId)));
    case 'reviews.list':          return reviewsResp(reviews.listSongReviews(env.DB, songId));

    case 'videos.list':           return listSongVideos(request, env, ctx);
    case 'videos.get':            return getSongVideo(request, env, ctx);
    case 'videos.createUpload':   return createVideoUpload(request, env, ctx);
    case 'videos.link':           return createVideoFromLink(request, env, ctx);
    case 'videos.part':           return uploadVideoPart(request, env, ctx, route.partNumber);
    case 'videos.complete':       return completeVideoUpload(request, env, ctx);
    case 'videos.abort':          return abortSongVideo(request, env, ctx);
    case 'videos.retry':          return retrySongVideo(request, env, ctx);
    case 'videos.patch':          return patchSongVideo(request, env, ctx);
    case 'videos.delete':         return deleteSongVideo(request, env, ctx);
    case 'videos.deleted':        return mechResp(storage.listDeletedVideos(env, { projectId, songId }));
    case 'videos.restore':        return restoreDeletedVideo(request, env, ctx, route.deletedVideoId);
    case 'videos.duplicates': {
      let body = null;
      try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
      return mechResp(storage.handleDuplicateCheck(env, ctx, body));
    }
    case 'videos.stream':
      return ctx.video.status === 'ready'
        ? serveR2Video(request, env, ctx.video)
        : jsonResp({ error: '這一版還不能播（還在上傳 / 複製，或失敗了）' }, 404);

    case 'cues.list':             return listCues(env, songId);
    case 'cues.create':           return createCue(request, env, projectId, songId);
    case 'cues.reorder':          return reorderCues(request, env, projectId, songId);
    case 'cues.get':              return getCue(env, songId, cueId);
    case 'cues.patch':            return updateCue(request, env, projectId, songId, cueId);
    case 'cues.delete':           return deleteCue(request, env, projectId, songId, cueId);
    case 'cues.reset':            return resetCue(request, env, projectId, cueId);

    case 'cueStatesBatch.list':   return mechResp(cueStatesBatch.listSongStates(env, ctx, songId));
    case 'cueStatesBatch.clear':  return mechResp(cueStatesBatch.clearSongStates(env, ctx, songId, mechLog(request, env, projectId)));
    case 'cueStatesBatch.restore': return mechResp(cueStatesBatch.restoreSongStates(request, env, ctx, songId, mechLog(request, env, projectId)));

    case 'states.list':           return listCueStates(env, projectId, cueId);
    case 'states.item':
      return request.method === 'PUT'
        ? upsertCueState(request, env, cueId, objId)
        : deleteCueState(request, env, projectId, cueId, objId);

    // 機關（mechanisms.mjs）
    // LED 畫布版型（ledTemplates.mjs）
    case 'ledTemplates.list':     return mechResp(ledTpl.listTemplates(env, ctx));
    case 'ledTemplates.create':   return mechResp(ledTpl.createTemplate(request, env, ctx, mechLog(request, env, projectId)));
    case 'ledTemplates.item':
      return mechResp(request.method === 'PATCH'
        ? ledTpl.updateTemplate(request, env, ctx, route.tplId, mechLog(request, env, projectId))
        : ledTpl.deleteTemplate(request, env, ctx, route.tplId, mechLog(request, env, projectId)));
    case 'ledUv.apply':           return mechResp(uvLayouts.applyAutoUv(request, env, ctx, mechLog(request, env, projectId)));
    case 'ledUv.impact':          return mechResp(uvLayouts.uvImpact(env, ctx));
    case 'ledUv.layoutGet':       return mechResp(uvLayouts.getLayoutEdit(env, ctx));
    case 'ledUv.layoutPut':       return mechResp(uvLayouts.putLayoutEdit(request, env, ctx));
    case 'ledScreens.create':     return mechResp(ledTpl.createScreen(request, env, ctx, mechLog(request, env, projectId)));
    case 'ledScreens.item':
      return mechResp(request.method === 'PATCH'
        ? ledTpl.updateScreen(request, env, ctx, route.screenId, mechLog(request, env, projectId))
        : ledTpl.deleteScreen(request, env, ctx, route.screenId, mechLog(request, env, projectId)));

    case 'mechanisms.list':       return mechResp(mech.listMechanisms(env, ctx, { mech2: mech.wantsMech2(request), mech3: mech.wantsMech3(request) }));
    case 'mechanisms.create':     return mechResp(mech.createMechanism(request, env, ctx, mechLog(request, env, projectId)));
    case 'mechanisms.reorder':    return mechResp(mech.reorderMechanisms(request, env, ctx, mechLog(request, env, projectId)));
    case 'mechanisms.item':
      return mechResp(request.method === 'PATCH'
        ? mech.updateMechanism(request, env, ctx, route.mechId, mechLog(request, env, projectId))
        : mech.deleteMechanism(request, env, ctx, route.mechId, mechLog(request, env, projectId)));
    case 'mechanisms.convert':    return mechResp(mech.convertCuePositions(request, env, ctx, route.mechId, mechLog(request, env, projectId)));
    case 'mechanisms.batch':      return mechResp(mech.createMechanismBatch(request, env, ctx, mechLog(request, env, projectId)));
    case 'mechGroups.item':
      return mechResp(request.method === 'PATCH'
        ? mech.updateMechanismGroup(request, env, ctx, route.groupId, mechLog(request, env, projectId))
        : mech.deleteMechanismGroup(request, env, ctx, route.groupId, mechLog(request, env, projectId), { dissolve: url.searchParams.get('dissolve') === '1' }));
    case 'mechPositions.bulk':    return mechResp(mech.putCuePositionsBulk(request, env, ctx, cueId));
    case 'mechanisms.sheet':      return mechResp(mech.mechanismSheet(env, ctx, { mech2: mech.wantsMech2(request), mech3: mech.wantsMech3(request) }));
    case 'mechPositions.list':    return mechResp(mech.listSongPositions(env, ctx, songId, { mech2: mech.wantsMech2(request), mech3: mech.wantsMech3(request) }));
    case 'mechPositions.item':
      return mechResp(request.method === 'PUT'
        ? mech.putCuePosition(request, env, ctx, cueId)
        : mech.deleteCuePosition(request, env, ctx, cueId));
    default:
      return jsonResp({ error: 'Not found' }, 404);
  }
}

// mechanisms.mjs 的 handler 回 { status, body } → JSON 回應
async function mechResp(p) {
  const r = await p;
  return jsonResp(r.body, r.status);
}
const mechLog = (request, env, projectId) => (action, targetType, targetId, payload) =>
  logActivity(request, env, projectId, action, targetType, targetId, payload);

// 還原封存的專案（只有全站 admin；router 已檢查）
async function restoreProject(request, env, projectId) {
  const r = await env.DB.prepare(
    `UPDATE projects SET status = 'active', updated_at = datetime('now') WHERE id = ? AND status = 'archived'`
  ).bind(projectId).run();
  if (r.meta.changes) {
    await logActivity(request, env, projectId, 'update', 'project', projectId, { restored: true });
  }
  return jsonResp({ ok: true, restored: !!r.meta.changes });
}

// ─────────────────────────────────────────────
// Projects API（Phase 1 backend — D1）
//   GET    /api/projects          → list（含 stats: songCount/cueCount/proposalCount/members、myRole）
//   POST   /api/projects          body: { name, description } → 建專案（只有 admin）
//   GET    /api/projects/:id      → 單筆（含 myRole：我在這個專案的角色）
//   PATCH  /api/projects/:id      body: 專案欄位 → 更新（一般欄位要專案 admin；Drive / 狀態 / 3D 檢視設定要全站 admin）
//   DELETE /api/projects/:id      → 封存（status=archived，只有 admin）
// ─────────────────────────────────────────────

const PROJECT_NAME_MAX = 80;
const PROJECT_DESC_MAX = 300;

async function listProjects(env, me, opts = {}) {
  // admin 看全部，其他 role 只看自己被加進 project_members 的 project
  const memberFilter = me?.role === 'admin'
    ? ''
    : ` AND p.id IN (SELECT pm.project_id FROM project_members pm WHERE pm.user_id = ?)`;
  const binds = me?.role === 'admin' ? [me.id] : [me.id, me.id];
  const archivedFilter = opts.archived ? `p.status = 'archived'` : `p.status != 'archived'`;

  const projects = await env.DB.prepare(`
    SELECT
      p.id, p.name, p.description, p.thumbnail_r2_key, p.status, p.show_id, p.tags,
      p.created_at, p.updated_at, p.watermark_members,
      (SELECT pm.role FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?) AS my_member_role,
      (SELECT COUNT(*) FROM songs s WHERE s.project_id = p.id) AS song_count,
      (SELECT COUNT(*) FROM songs s WHERE s.project_id = p.id AND s.status = 'todo') AS songs_todo,
      (SELECT COUNT(*) FROM songs s WHERE s.project_id = p.id AND s.status = 'in_review') AS songs_in_review,
      (SELECT COUNT(*) FROM songs s WHERE s.project_id = p.id AND s.status = 'approved') AS songs_approved,
      (SELECT COUNT(*) FROM songs s WHERE s.project_id = p.id AND s.status = 'needs_changes') AS songs_needs_changes,
      (SELECT COUNT(*) FROM cues c
        JOIN songs s ON c.song_id = s.id
        WHERE s.project_id = p.id AND c.status = 'master') AS cue_count,
      (SELECT COUNT(*) FROM cues c
        JOIN songs s ON c.song_id = s.id
        WHERE s.project_id = p.id AND c.status = 'proposal') AS proposal_count
    FROM projects p
    WHERE ${archivedFilter}${memberFilter}
    ORDER BY p.updated_at DESC
  `).bind(...binds).all();

  // 撈所有成員一次（避免 N+1）
  const members = await env.DB.prepare(`
    SELECT pm.project_id, pm.role, u.id, u.name, u.avatar_color
    FROM project_members pm
    JOIN users u ON pm.user_id = u.id
  `).all();

  const membersByProject = {};
  for (const m of members.results || []) {
    (membersByProject[m.project_id] = membersByProject[m.project_id] || []).push({
      id: m.id, name: m.name, avatarColor: m.avatar_color, role: m.role,
    });
  }

  const safeJsonArr = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
  const list = (projects.results || []).map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    thumbnailUrl: p.thumbnail_r2_key ? `/r2/${p.thumbnail_r2_key}` : null,
    status: p.status,
    showId: p.show_id || null,
    tags: safeJsonArr(p.tags),
    songCount: p.song_count,
    songStatusCounts: {
      todo: p.songs_todo,
      in_review: p.songs_in_review,
      approved: p.songs_approved,
      needs_changes: p.songs_needs_changes,
    },
    cueCount: p.cue_count,
    proposalCount: p.proposal_count,
    updatedAt: p.updated_at,
    createdAt: p.created_at,
    members: membersByProject[p.id] || [],
    // 我在這個專案的角色（審查按鈕要看這個，不是帳號的預設角色）
    myRole: projectRoleOf(me?.role, p.my_member_role),
    // 0038：成員看片也加浮水印（製作設定；預設關）
    watermarkMembers: memberWatermarkOn(p.watermark_members),
  }));

  return jsonResp({ projects: list });
}

async function createProject(request, env, me) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }

  const name = (body?.name || '').toString().trim().slice(0, PROJECT_NAME_MAX);
  const description = (body?.description || '').toString().trim().slice(0, PROJECT_DESC_MAX);
  if (!name) return jsonResp({ error: 'name is required' }, 400);

  let showId = body?.showId && ID_RE.test(body.showId) ? body.showId : null;
  if (showId) {
    const sh = await env.DB.prepare(`SELECT id FROM shows WHERE id = ? LIMIT 1`).bind(showId).first();
    if (!sh) return jsonResp({ error: '找不到這個 Show' }, 400);
  }

  const id = 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  await env.DB.prepare(`
    INSERT INTO projects (id, name, description, created_by_user_id, show_id)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, name, description, me.id, showId).run();

  // 把建立者加進 project_members（admin 角色）
  await env.DB.prepare(`
    INSERT INTO project_members (project_id, user_id, role)
    VALUES (?, ?, 'admin')
  `).bind(id, me.id).run();

  await logActivity(request, env, id, 'create', 'project', id, { name });
  return jsonResp({ ok: true, id }, 201);
}

// 單筆（封存的只有 admin 拿得到，router 已擋）
async function getProject(env, ctx) {
  const row = await env.DB.prepare(`SELECT * FROM projects WHERE id = ? LIMIT 1`).bind(ctx.projectId).first();
  if (!row) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ project: row, myRole: ctx.role });
}

async function updateProject(request, env, ctx) {
  const { me, projectId } = ctx;
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResp({ error: 'Invalid JSON' }, 400);

  // 舊的「全專案機關滑桿」（projects.mechanism_offsets）已經換成機關分頁：欄位留著（舊資料、0023 轉過的來源），但不再收修改。
  // 還開著舊頁面的人一存就會看到這句，重新整理就是新版
  if ('mechanism_offsets' in body || 'mechanismOffsets' in body) {
    return jsonResp({ error: '機關改版了，請重新整理頁面' }, 400);
  }

  const allowed = ['name', 'description', 'status', 'drive_folder_id', 'drive_filename_pattern', 'drive_oauth_token_id', 'show_id', 'tags', 'scale_correction', 'look_settings', 'material_overrides', 'home_view', 'led_canvas', 'watermark_members'];
  // 前端 camelCase showId 轉 snake_case show_id
  if ('showId' in body && !('show_id' in body)) body.show_id = body.showId;
  // 0038「成員看片也加浮水印」：只有這個專案的製作（路由表本來就只放製作進來，這裡再擋一次、說清楚）
  if ('watermarkMembers' in body && !('watermark_members' in body)) body.watermark_members = body.watermarkMembers;
  if ('watermark_members' in body) {
    if (!canSetMemberWatermark(ctx.role)) return jsonResp({ error: MEMBER_WATERMARK_DENIED_MESSAGE }, 403);
    const flag = readFlag(body.watermark_members);
    if (!flag.ok || flag.value === undefined) return jsonResp({ error: PROTECTION_FLAG_ERROR }, 400);
    body.watermark_members = flag.value ? 1 : 0;
  }
  // tags 是 array → 存成 JSON string
  if ('tags' in body && Array.isArray(body.tags)) {
    body.tags = JSON.stringify(body.tags.filter(t => typeof t === 'string').slice(0, 20));
  }

  // 3D 檢視設定（校準倍率 / 現場設定 / 材質 / 重置視角 / LED 畫布大小）— 全專案共用，只有 admin 能改
  if ('scaleCorrection' in body && !('scale_correction' in body)) body.scale_correction = body.scaleCorrection;
  if ('lookSettings' in body && !('look_settings' in body)) body.look_settings = body.lookSettings;
  if ('materialOverrides' in body && !('material_overrides' in body)) body.material_overrides = body.materialOverrides;
  if ('homeView' in body && !('home_view' in body)) body.home_view = body.homeView;
  if ('ledCanvas' in body && !('led_canvas' in body)) body.led_canvas = body.ledCanvas;
  const touchesViewSettings = 'scale_correction' in body || 'look_settings' in body || 'material_overrides' in body || 'home_view' in body || 'led_canvas' in body;
  if (touchesViewSettings && me?.role !== 'admin') {
    return jsonResp({ error: '只有製作能改 3D 檢視設定（校準 / 現場設定 / 材質 / 重置視角 / LED 畫布大小）' }, 403);
  }
  // Drive 綁定（用哪個 Google 帳號、哪個資料夾）和專案狀態 — 只有全站 admin
  // （不然專案成員可以把專案指到 admin 的 Google 帳號，讀到別的資料夾）
  if (['drive_folder_id', 'drive_filename_pattern', 'drive_oauth_token_id'].some(k => k in body) && me?.role !== 'admin') {
    return jsonResp({ error: '只有製作可以設定 Drive 來源' }, 403);
  }
  if ('status' in body && me?.role !== 'admin') {
    return jsonResp({ error: '只有製作可以改專案狀態' }, 403);
  }
  if (PROJECT_GLOBAL_ADMIN_FIELDS.some(k => k in body) && me?.role !== 'admin') {
    return jsonResp({ error: '只有製作可以改這個設定' }, 403);
  }
  if ('name' in body) {
    body.name = (body.name ?? '').toString().trim().slice(0, PROJECT_NAME_MAX);
    if (!body.name) return jsonResp({ error: '專案名稱不能是空的' }, 400);
  }
  if ('description' in body) body.description = (body.description ?? '').toString().trim().slice(0, PROJECT_DESC_MAX);
  if ('status' in body && !['active', 'in_review', 'archived'].includes(body.status)) {
    return jsonResp({ error: '專案狀態不正確' }, 400);
  }
  if ('tags' in body && typeof body.tags !== 'string') return jsonResp({ error: 'tags 不合法' }, 400);
  if ('show_id' in body) {
    if (body.show_id === null || body.show_id === '') body.show_id = null;
    else {
      if (typeof body.show_id !== 'string' || !ID_RE.test(body.show_id)) return jsonResp({ error: 'show_id 不合法' }, 400);
      const sh = await env.DB.prepare(`SELECT id FROM shows WHERE id = ? LIMIT 1`).bind(body.show_id).first();
      if (!sh) return jsonResp({ error: '找不到這個 Show' }, 400);
    }
  }
  if ('drive_oauth_token_id' in body) {
    if (body.drive_oauth_token_id === null || body.drive_oauth_token_id === '') body.drive_oauth_token_id = null;
    else {
      if (typeof body.drive_oauth_token_id !== 'string' || !ID_RE.test(body.drive_oauth_token_id)) return jsonResp({ error: 'Google 帳號不合法' }, 400);
      const tk = await env.DB.prepare(`SELECT id FROM oauth_tokens WHERE id = ? LIMIT 1`).bind(body.drive_oauth_token_id).first();
      if (!tk) return jsonResp({ error: '找不到這個 Google 帳號' }, 400);
    }
  }
  if ('drive_folder_id' in body) {
    if (body.drive_folder_id === null || body.drive_folder_id === '') body.drive_folder_id = null;
    else if (typeof body.drive_folder_id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(body.drive_folder_id)) {
      return jsonResp({ error: 'Drive 資料夾 id 不合法' }, 400);
    }
  }
  if ('drive_filename_pattern' in body) {
    const pat = body.drive_filename_pattern;
    if (typeof pat !== 'string' || !pat || pat.length > 200) return jsonResp({ error: '檔名規則不合法' }, 400);
    try { new RegExp(pat); } catch { return jsonResp({ error: '檔名規則不是有效的正規表示式' }, 400); }
  }
  if ('scale_correction' in body) {
    const n = Number(body.scale_correction);
    if (!isFinite(n) || n <= 0.0001 || n >= 10000) return jsonResp({ error: 'scale_correction 不合法' }, 400);
    body.scale_correction = n;
  }
  if ('look_settings' in body) {
    const clean = sanitizeLookSettings(body.look_settings);
    if (!clean) return jsonResp({ error: 'look_settings 不合法' }, 400);
    body.look_settings = JSON.stringify(clean);
  }
  if ('material_overrides' in body) {
    const clean = sanitizeMaterialOverrides(body.material_overrides);
    if (!clean) return jsonResp({ error: 'material_overrides 不合法' }, 400);
    body.material_overrides = JSON.stringify(clean);
  }
  if ('home_view' in body) {
    // null = 回到自動正面全景
    if (body.home_view === null) {
      body.home_view = null;
    } else {
      const clean = sanitizeHomeView(body.home_view);
      if (!clean) return jsonResp({ error: 'home_view 不合法' }, 400);
      body.home_view = JSON.stringify(clean);
    }
  }
  if ('led_canvas' in body) {
    // null = 清掉（還沒填）
    if (body.led_canvas === null) {
      body.led_canvas = null;
    } else {
      const clean = sanitizeLedCanvas(body.led_canvas);
      if (!clean) return jsonResp({ error: 'led_canvas 不合法（寬高要是 16~32768 的整數）' }, 400);
      body.led_canvas = JSON.stringify(clean);
    }
  }
  const sets = [], values = [];
  for (const k of allowed) {
    if (k in body) { sets.push(`${k} = ?`); values.push(body[k]); }
  }
  if (!sets.length) return jsonResp({ error: 'no updatable fields' }, 400);

  const before = await env.DB.prepare(`SELECT name FROM projects WHERE id = ? LIMIT 1`).bind(projectId).first();

  values.push(projectId);
  const result = await env.DB.prepare(
    `UPDATE projects SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...values).run();

  if (!result.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  // 現場設定 / 材質拖滑桿會一直存，不寫 activity（不然 audit log 會被洗版）
  const onlyLiveTweaks = sets.length > 0 && Object.keys(body).every(k =>
    ['look_settings', 'lookSettings', 'material_overrides', 'materialOverrides', 'home_view', 'homeView', 'led_canvas', 'ledCanvas'].includes(k));
  if (!onlyLiveTweaks) {
    await logActivity(request, env, projectId, 'update', 'project', projectId, { name: before?.name, changes: body });
  }
  return jsonResp({ ok: true });
}

// 比例尺的樂手和器材（0033，projects.stage_props）：GET 所有成員都看得到；PUT 整份換掉，只有製作和導演
// （權限在路由表 access.mjs 就擋了；格式和檢查在 web/src/lib/stageProps.ts，有一筆不對就整份拒絕）。
// 拖一下就存一次，不寫活動紀錄（不然 audit log 會被洗版），也不動專案的更新時間
async function handleStageProps(request, env, ctx) {
  if (request.method === 'GET') {
    const row = await env.DB.prepare(`SELECT stage_props FROM projects WHERE id = ? LIMIT 1`).bind(ctx.projectId).first();
    if (!row) return jsonResp({ error: 'Not found' }, 404);
    return jsonResp({ props: parseStoredStageProps(row.stage_props) });
  }
  const body = await readJsonLimited(request, 64 * 1024);
  if (body.error) return jsonResp({ error: body.error }, body.status);
  const check = checkStagePropsForSave(body.value && typeof body.value === 'object' ? body.value.props : undefined);
  if (!check.ok) return jsonResp({ error: check.error }, 400);
  const result = await env.DB.prepare(`UPDATE projects SET stage_props = ? WHERE id = ?`)
    .bind(serializeStageProps(check.props), ctx.projectId).run();
  if (!result.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ ok: true, props: check.props });
}

// 視角書籤（0035，projects.camera_bookmarks）：GET 所有成員都看得到；PUT 整份換掉，只有製作和導演
// （權限在路由表 access.mjs 就擋了；格式和檢查在 web/src/lib/cameraBookmarks.ts，有一筆不對就整份拒絕）。
// 存視角不寫活動紀錄、也不動專案的更新時間
async function handleCameraBookmarks(request, env, ctx) {
  if (request.method === 'GET') {
    const row = await env.DB.prepare(`SELECT camera_bookmarks FROM projects WHERE id = ? LIMIT 1`).bind(ctx.projectId).first();
    if (!row) return jsonResp({ error: 'Not found' }, 404);
    return jsonResp({ bookmarks: parseStoredCameraBookmarks(row.camera_bookmarks) });
  }
  const body = await readJsonLimited(request, 64 * 1024);
  if (body.error) return jsonResp({ error: body.error }, body.status);
  const check = checkCameraBookmarksForSave(body.value && typeof body.value === 'object' ? body.value.bookmarks : undefined);
  if (!check.ok) return jsonResp({ error: check.error }, 400);
  const result = await env.DB.prepare(`UPDATE projects SET camera_bookmarks = ? WHERE id = ?`)
    .bind(serializeCameraBookmarks(check.bookmarks), ctx.projectId).run();
  if (!result.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ ok: true, bookmarks: check.bookmarks });
}

// 現場模式設定：範圍要跟 web/src/lib/stageLook/lookSettings.ts 的 LOOK_SETTING_RANGES 一致
const LOOK_SETTING_RANGES = {
  houseLight: [0, 1],
  exposure: [0.2, 3],
  ledLightStrength: [0, 5],
  bloomStrength: [0, 3],
  floorReflection: [0, 1],
  reflectionSharpness: [0, 1],
  ledViewFalloff: [0, 1],
};

// 材質覆寫（依 C4D 材質名稱）：範圍要跟 web/src/lib/stageLook/materialOverrides.ts 的 MATERIAL_RANGES 一致
const MATERIAL_RANGES = {
  roughness: [0, 1],
  metalness: [0, 1],
  envIntensity: [0, 5],
  opacity: [0, 1],
};

// 重置攝影機畫面：{ position: [x,y,z], target: [x,y,z], fov }，要跟 web/src/lib/homeView.ts 的 normalizeHomeView 一致
function sanitizeHomeView(raw) {
  let obj = raw;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return null; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const vec3 = (v) => {
    if (!Array.isArray(v) || v.length !== 3) return null;
    const n = v.map(Number);
    return n.every(x => isFinite(x) && Math.abs(x) <= 100000) ? n : null;
  };
  const position = vec3(obj.position), target = vec3(obj.target), fov = Number(obj.fov);
  if (!position || !target || !isFinite(fov)) return null;
  if (position.every((x, i) => Math.abs(x - target[i]) < 1e-6)) return null;
  return { position, target, fov: Math.max(10, Math.min(120, fov)) };
}

// AE 畫布尺寸：{ width, height }，各是 16~32768 的整數；要跟 web/src/lib/ledCanvas.ts 的 normalizeLedCanvas 一致
const LED_CANVAS_RANGE = [16, 32768];
function sanitizeLedCanvas(raw) {
  let obj = raw;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return null; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const [min, max] = LED_CANVAS_RANGE;
  const dim = (v) => {
    if (typeof v !== 'number' && typeof v !== 'string') return null;
    if (typeof v === 'string' && !/^\s*\d+\s*$/.test(v)) return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const width = dim(obj.width), height = dim(obj.height);
  if (width === null || height === null) return null;
  return { width, height };
}

function sanitizeMaterialOverrides(raw) {
  let obj = raw;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return null; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const entries = Object.entries(obj);
  if (entries.length > 300) return null;
  const out = {};
  for (const [name, v] of entries) {
    if (name.length > 100 || !v || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = {};
    for (const [key, [min, max]] of Object.entries(MATERIAL_RANGES)) {
      if (!(key in v)) continue;
      const n = Number(v[key]);
      if (!isFinite(n)) return null;
      o[key] = Math.max(min, Math.min(max, n));
    }
    if (typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color)) o.color = v.color.toLowerCase();
    if (v.mirrorFloor === true) o.mirrorFloor = true;
    if (Object.keys(o).length) out[name] = o;
  }
  return out;
}

function sanitizeLookSettings(raw) {
  let obj = raw;
  if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { return null; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const [key, [min, max]] of Object.entries(LOOK_SETTING_RANGES)) {
    if (!(key in obj)) continue;
    const n = Number(obj[key]);
    if (!isFinite(n)) return null;
    out[key] = Math.max(min, Math.min(max, n));
  }
  return out;
}

// 複製整棵 project（含 stage_objects / songs / cues / cue_states）
// 不複製：activity_log（新 project 從零開始）、model 檔案（共用同一個 R2 key — 多 project 指同一個 model OK）
async function duplicateProject(request, env, projectId) {
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);

  let body = {};
  try { body = await request.json(); } catch {}

  // 抓原 project
  const src = await env.DB.prepare(
    `SELECT id, name, description, model_r2_key, show_id, scale_correction FROM projects WHERE id = ? AND status != 'archived' LIMIT 1`
  ).bind(projectId).first();
  if (!src) return jsonResp({ error: 'Source project not found' }, 404);

  const newName = (body?.newName || `${src.name} (副本)`).toString().trim().slice(0, PROJECT_NAME_MAX);
  const showId = ('showId' in body ? body.showId : src.show_id) || null;
  const newId = 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  // 1. 建新 project
  await env.DB.prepare(
    `INSERT INTO projects (id, name, description, model_r2_key, show_id, created_by_user_id, scale_correction)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(newId, newName, src.description || '', src.model_r2_key, showId, me.id, src.scale_correction ?? 1).run();

  // 2. 加 admin 進 project_members
  await env.DB.prepare(
    `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'admin')`
  ).bind(newId, me.id).run();

  // 3. 複製 stage_objects（記下舊→新 id mapping）
  const oldObjs = await env.DB.prepare(
    `SELECT * FROM stage_objects WHERE project_id = ?`
  ).bind(projectId).all();
  const objIdMap = new Map();
  const objStmts = [];
  for (const o of (oldObjs.results || [])) {
    const newObjId = 'so_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + objStmts.length;
    objIdMap.set(o.id, newObjId);
    objStmts.push(env.DB.prepare(`
      INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order",
        default_position, default_rotation, default_scale, metadata, locked, material_props, led_props)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(newObjId, newId, o.mesh_name, o.display_name, o.category, o.order,
            o.default_position, o.default_rotation, o.default_scale, o.metadata,
            o.locked, o.material_props, o.led_props));
  }
  if (objStmts.length > 0) await env.DB.batch(objStmts);

  // 4. 複製 songs（記下舊→新 song id mapping）
  const oldSongs = await env.DB.prepare(
    `SELECT * FROM songs WHERE project_id = ?`
  ).bind(projectId).all();
  const songIdMap = new Map();
  const songStmts = [];
  for (const s of (oldSongs.results || [])) {
    const newSongId = 's_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + songStmts.length;
    songIdMap.set(s.id, newSongId);
    songStmts.push(env.DB.prepare(`
      INSERT INTO songs (id, project_id, name, "order", animator_user_id, drive_folder_id, status, code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(newSongId, newId, s.name, s.order, s.animator_user_id, s.drive_folder_id, s.status, s.code ?? null));
  }
  if (songStmts.length > 0) await env.DB.batch(songStmts);

  // 5. 複製 cues（依新 song id；記 cue id mapping）
  const oldCues = await env.DB.prepare(`
    SELECT c.* FROM cues c
    JOIN songs s ON c.song_id = s.id
    WHERE s.project_id = ?
  `).bind(projectId).all();
  const cueIdMap = new Map();
  const cueStmts = [];
  for (const c of (oldCues.results || [])) {
    const newCueId = 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + cueStmts.length;
    cueIdMap.set(c.id, newCueId);
    const newSongId = songIdMap.get(c.song_id);
    if (!newSongId) continue;
    // base_cue_id 也要 remap（如有）
    const newBaseCueId = c.base_cue_id ? cueIdMap.get(c.base_cue_id) || null : null;
    cueStmts.push(env.DB.prepare(`
      INSERT INTO cues (id, song_id, name, "order", position_xyz, rotation_xyz, fov, crossfade_seconds,
                        video_time_sec, status, base_cue_id, thumbnail_r2_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(newCueId, newSongId, c.name, c.order, c.position_xyz, c.rotation_xyz, c.fov, c.crossfade_seconds,
            c.video_time_sec ?? null, c.status, newBaseCueId, c.thumbnail_r2_key));
  }
  if (cueStmts.length > 0) await env.DB.batch(cueStmts);

  // 6. 複製 cue_object_states（cue_id + stage_object_id 都 remap 到新 id）
  const oldStates = await env.DB.prepare(`
    SELECT cos.* FROM cue_object_states cos
    JOIN cues c ON cos.cue_id = c.id
    JOIN songs s ON c.song_id = s.id
    WHERE s.project_id = ?
  `).bind(projectId).all();
  const stateStmts = [];
  for (const cs of (oldStates.results || [])) {
    const newCueId = cueIdMap.get(cs.cue_id);
    const newObjId = objIdMap.get(cs.stage_object_id);
    if (!newCueId || !newObjId) continue;
    const newStateId = 'cos_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + stateStmts.length;
    stateStmts.push(env.DB.prepare(`
      INSERT INTO cue_object_states (id, cue_id, stage_object_id, position, rotation, scale, visible, custom_props)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(newStateId, newCueId, newObjId, cs.position, cs.rotation, cs.scale, cs.visible, cs.custom_props));
  }
  if (stateStmts.length > 0) await env.DB.batch(stateStmts);

  // 7. 機關（定義、帶的物件、每個 cue 的位置）。舊的機關滑桿欄位（mechanism_offsets）不再寫：0023 已經轉成機關、跟著上面一起複製
  const mechCopy = await mech.copyMechanismsToProject(env, projectId, newId, objIdMap, cueIdMap);

  // 8. LED 畫布版型（0034）：版型、手動切的螢幕、每首歌選的版型
  await ledTpl.copyTemplatesToProject(
    env, projectId, newId, objIdMap,
    (oldSongs.results || []).filter(x => x.template_id && songIdMap.get(x.id)).map(x => ({ songId: songIdMap.get(x.id), templateId: x.template_id })),
    { songIdMap, cueIdMap },
  );

  await logActivity(request, env, newId, 'create', 'project', newId, {
    name: newName,
    duplicatedFrom: projectId,
    duplicatedFromName: src.name,
    objCount: oldObjs.results?.length || 0,
    songCount: oldSongs.results?.length || 0,
    cueCount: oldCues.results?.length || 0,
  });

  return jsonResp({
    ok: true,
    id: newId,
    name: newName,
    counts: {
      stageObjects: oldObjs.results?.length || 0,
      songs: oldSongs.results?.length || 0,
      cues: oldCues.results?.length || 0,
      cueStates: oldStates.results?.length || 0,
      mechanisms: mechCopy.mechanisms,
    },
  }, 201);
}

// Cue templates / palette（admin Tier 1 #5）
async function listCueTemplates(env, projectId) {
  const r = await env.DB.prepare(`
    SELECT t.id, t.project_id, t.name, t.description, t.payload, t.created_at,
           u.name AS author_name
      FROM cue_templates t
      LEFT JOIN users u ON t.created_by_user_id = u.id
     WHERE t.project_id = ? OR t.project_id IS NULL
     ORDER BY t.created_at DESC
  `).bind(projectId).all();
  return jsonResp({
    templates: (r.results || []).map(t => {
      let payload = {};
      try { payload = JSON.parse(t.payload); } catch {}
      return {
        id: t.id, projectId: t.project_id, name: t.name, description: t.description,
        global: t.project_id == null, authorName: t.author_name,
        createdAt: t.created_at, payload,
      };
    }),
  });
}

async function createCueTemplate(request, env, ctx) {
  const { me, projectId } = ctx;
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const name = (body?.name || '').toString().trim().slice(0, 80);
  const description = (body?.description || '').toString().trim().slice(0, 300);
  const fromCueId = (body?.fromCueId || '').toString();
  const isGlobal = !!body?.global;
  if (!name) return jsonResp({ error: 'name 必填' }, 400);
  if (!fromCueId) return jsonResp({ error: '需要來源 cue id' }, 400);
  // 全域模板（每個專案都看得到）只有全站 admin 能建
  if (isGlobal && me.role !== 'admin') return jsonResp({ error: '只有製作可以建立全域模板' }, 403);

  // 來源 cue 一定要是這個專案的（不然可以把別人專案的 cue 抄出來）
  const cue = await env.DB.prepare(
    `SELECT c.* FROM cues c JOIN songs s ON s.id = c.song_id WHERE c.id = ? AND s.project_id = ? LIMIT 1`
  ).bind(fromCueId, projectId).first();
  if (!cue) return jsonResp({ error: 'Source cue not found' }, 404);
  const states = await env.DB.prepare(`
    SELECT cos.position, cos.rotation, cos.scale, o.mesh_name
      FROM cue_object_states cos
      JOIN stage_objects o ON cos.stage_object_id = o.id
     WHERE cos.cue_id = ?
  `).bind(fromCueId).all();

  const safe = (s) => s == null ? null : (() => { try { return JSON.parse(s); } catch { return null; } })();
  const payload = {
    position: safe(cue.position_xyz) || { x: 0, y: 0, z: 0 },
    rotation: safe(cue.rotation_xyz) || { pitch: 0, yaw: 0, roll: 0 },
    fov: cue.fov,
    crossfadeSeconds: cue.crossfade_seconds,
    snapshotStates: (states.results || []).map(r => ({
      meshName: r.mesh_name,
      position: safe(r.position),
      rotation: safe(r.rotation),
      scale: safe(r.scale),
    })),
    // 這個 cue 自己設的機關位置（用機關名稱存 → 別的專案有同名的機關也套得上）
    mechanismPositions: await mech.templateMechanismPositions(env, fromCueId),
  };

  const id = 'tpl_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  await env.DB.prepare(
    `INSERT INTO cue_templates (id, project_id, name, description, payload, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, isGlobal ? null : projectId, name, description, JSON.stringify(payload), me.id).run();
  return jsonResp({ ok: true, id }, 201);
}

async function deleteCueTemplate(request, env, templateId) {
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);
  if (me.role !== 'admin') return jsonResp({ error: '只有製作可以刪除模板' }, 403);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(templateId)) return jsonResp({ error: 'Invalid id' }, 400);
  const r = await env.DB.prepare(`DELETE FROM cue_templates WHERE id = ?`).bind(templateId).run();
  if (!r.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ ok: true });
}

// 全域搜尋（admin Tier 1 #4）— 跨 projects/songs/cues/stage_objects 找名稱
async function handleSearch(request, env, url) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);

  const q = (url.searchParams.get('q') || '').trim().slice(0, 100);
  if (!q) return jsonResp({ projects: [], songs: [], cues: [], stageObjects: [] });

  const like = `%${q.replace(/[%_\\]/g, m => '\\' + m)}%`;
  const isAdmin = me.role === 'admin';

  // admin 看全部；非 admin 只能看 project_members 內的 project
  const memberFilter = isAdmin ? '' : ` AND p.id IN (SELECT pm.project_id FROM project_members pm WHERE pm.user_id = ?)`;
  const memberArgs = isAdmin ? [] : [me.id];

  const projects = await env.DB.prepare(
    `SELECT p.id, p.name FROM projects p
     WHERE p.status != 'archived' AND p.name LIKE ? ESCAPE '\\'${memberFilter}
     ORDER BY p.updated_at DESC LIMIT 10`
  ).bind(like, ...memberArgs).all();

  const songs = await env.DB.prepare(
    `SELECT s.id, s.name, s.project_id, p.name AS project_name FROM songs s
     JOIN projects p ON s.project_id = p.id
     WHERE p.status != 'archived' AND s.name LIKE ? ESCAPE '\\'${memberFilter}
     ORDER BY s.created_at DESC LIMIT 10`
  ).bind(like, ...memberArgs).all();

  const cues = await env.DB.prepare(
    `SELECT c.id, c.name, c.song_id, s.name AS song_name, s.project_id, p.name AS project_name
     FROM cues c
     JOIN songs s ON c.song_id = s.id
     JOIN projects p ON s.project_id = p.id
     WHERE p.status != 'archived' AND c.name LIKE ? ESCAPE '\\'${memberFilter}
     ORDER BY c.updated_at DESC LIMIT 10`
  ).bind(like, ...memberArgs).all();

  const stageObjects = await env.DB.prepare(
    `SELECT o.id, o.display_name, o.mesh_name, o.project_id, p.name AS project_name FROM stage_objects o
     JOIN projects p ON o.project_id = p.id
     WHERE p.status != 'archived' AND (o.display_name LIKE ? ESCAPE '\\' OR o.mesh_name LIKE ? ESCAPE '\\')${memberFilter}
     ORDER BY o.created_at DESC LIMIT 10`
  ).bind(like, like, ...memberArgs).all();

  return jsonResp({
    projects: (projects.results || []).map(p => ({ id: p.id, name: p.name })),
    songs: (songs.results || []).map(s => ({ id: s.id, name: s.name, projectId: s.project_id, projectName: s.project_name })),
    cues: (cues.results || []).map(c => ({ id: c.id, name: c.name, songId: c.song_id, songName: c.song_name, projectId: c.project_id, projectName: c.project_name })),
    stageObjects: (stageObjects.results || []).map(o => ({ id: o.id, name: o.display_name || o.mesh_name, projectId: o.project_id, projectName: o.project_name })),
  });
}

// 匯出整個 project 為 JSON（user 下載備份）
async function exportProject(request, env, projectId) {
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);

  const project = await env.DB.prepare(
    `SELECT id, name, description, model_r2_key, show_id FROM projects WHERE id = ? LIMIT 1`
  ).bind(projectId).first();
  if (!project) return jsonResp({ error: 'Not found' }, 404);

  const stageObjects = (await env.DB.prepare(
    `SELECT * FROM stage_objects WHERE project_id = ? ORDER BY "order"`
  ).bind(projectId).all()).results || [];

  const songs = (await env.DB.prepare(
    `SELECT * FROM songs WHERE project_id = ? ORDER BY "order"`
  ).bind(projectId).all()).results || [];

  const cues = (await env.DB.prepare(`
    SELECT c.* FROM cues c
    JOIN songs s ON c.song_id = s.id
    WHERE s.project_id = ?
    ORDER BY c."order"
  `).bind(projectId).all()).results || [];

  const states = (await env.DB.prepare(`
    SELECT cos.* FROM cue_object_states cos
    JOIN cues c ON cos.cue_id = c.id
    JOIN songs s ON c.song_id = s.id
    WHERE s.project_id = ?
  `).bind(projectId).all()).results || [];

  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    project: {
      id: project.id, name: project.name, description: project.description,
      modelR2Key: project.model_r2_key, showId: project.show_id,
    },
    stageObjects, songs, cues, cueObjectStates: states,
    // 機關：mechanisms / mechanismObjects / cueMechanismPositions（資料庫原樣；舊的匯出檔沒有）
    ...(await mech.exportMechanisms(env, projectId)),
    // LED 畫布版型（0034）：ledTemplates / ledTemplateScreens / ledScreens（songs 列上的 template_id 指到這裡；舊的匯出檔沒有）
    ...(await ledTpl.exportTemplates(env, projectId)),
  };
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${project.name.replace(/[^\w-]/g, '_')}.stage-previz.json"`,
    },
  });
}

// 匯入整個 project（從 user 上傳的 JSON）
async function importProject(request, env) {
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  if (!body?.project || !Array.isArray(body?.stageObjects)) {
    return jsonResp({ error: '不像有效的匯出檔（缺 project 或 stageObjects）' }, 400);
  }

  const newName = (body?.newName || `${body.project.name} (匯入)`).toString().trim().slice(0, PROJECT_NAME_MAX);
  const newId = 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  // model_r2_key 預設保留（指向同一個 R2，跨 D1 匯入時可能 broken link，user 自己重 upload）
  const rawKey = typeof body.project.modelR2Key === 'string' ? body.project.modelR2Key : '';
  const modelKey = /^(models|assets)\/[a-zA-Z0-9_\/.-]{1,200}$/.test(rawKey) && !rawKey.includes('..') ? rawKey : null;

  await env.DB.prepare(
    `INSERT INTO projects (id, name, description, model_r2_key, created_by_user_id)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(newId, newName, body.project.description || '', modelKey, me.id).run();

  await env.DB.prepare(
    `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'admin')`
  ).bind(newId, me.id).run();

  // stage_objects
  const objIdMap = new Map();
  const objStmts = [];
  for (const o of body.stageObjects) {
    const newObjId = 'so_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + objStmts.length;
    objIdMap.set(o.id, newObjId);
    objStmts.push(env.DB.prepare(`
      INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order",
        default_position, default_rotation, default_scale, metadata, locked, material_props, led_props)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(newObjId, newId, o.mesh_name, o.display_name, o.category, o.order,
            o.default_position, o.default_rotation, o.default_scale, o.metadata,
            o.locked ?? 0, o.material_props, o.led_props));
  }
  if (objStmts.length > 0) await env.DB.batch(objStmts);

  // songs
  const songIdMap = new Map();
  const songStmts = [];
  const importedCodes = [];
  for (const s of (body.songs || [])) {
    const newSongId = 's_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + songStmts.length;
    songIdMap.set(s.id, newSongId);
    // 代號：匯出檔有、格式對、這次匯入裡沒重複才用；其他的匯入完再補
    let code = null;
    if (s.code) {
      const c = normalizeSongCodeInput(s.code);
      if (!c.error && !songCodeTakenBy(c.code, importedCodes)) { code = c.code; importedCodes.push({ id: newSongId, code }); }
    }
    songStmts.push(env.DB.prepare(`
      INSERT INTO songs (id, project_id, name, "order", animator_user_id, drive_folder_id, status, code)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    `).bind(newSongId, newId, s.name, s.order, s.drive_folder_id, s.status || 'todo', code));
  }
  if (songStmts.length > 0) await env.DB.batch(songStmts);
  if (songStmts.length > 0) await ensureSongCodes(env, newId);

  // cues
  const cueIdMap = new Map();
  const cueStmts = [];
  for (const c of (body.cues || [])) {
    const newCueId = 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + cueStmts.length;
    cueIdMap.set(c.id, newCueId);
    const newSongId = songIdMap.get(c.song_id);
    if (!newSongId) continue;
    cueStmts.push(env.DB.prepare(`
      INSERT INTO cues (id, song_id, name, "order", position_xyz, rotation_xyz, fov, crossfade_seconds, video_time_sec, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(newCueId, newSongId, c.name, c.order, c.position_xyz, c.rotation_xyz,
            c.fov, typeof c.crossfade_seconds === 'number' ? c.crossfade_seconds : DEFAULT_CUE_CROSSFADE_SECONDS,
            typeof c.video_time_sec === 'number' && isFinite(c.video_time_sec) && c.video_time_sec >= 0 ? c.video_time_sec : null,
            ['master', 'proposal', 'alternate'].includes(c.status) ? c.status : 'master'));
  }
  if (cueStmts.length > 0) await env.DB.batch(cueStmts);

  // cue_object_states
  const stateStmts = [];
  for (const cs of (body.cueObjectStates || [])) {
    const newCueId = cueIdMap.get(cs.cue_id);
    const newObjId = objIdMap.get(cs.stage_object_id);
    if (!newCueId || !newObjId) continue;
    const newStateId = 'cos_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + stateStmts.length;
    stateStmts.push(env.DB.prepare(`
      INSERT INTO cue_object_states (id, cue_id, stage_object_id, position, rotation, scale, visible, custom_props)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(newStateId, newCueId, newObjId, cs.position, cs.rotation, cs.scale, cs.visible, cs.custom_props));
  }
  if (stateStmts.length > 0) await env.DB.batch(stateStmts);

  // 機關（舊的匯出檔沒有 → 什麼都不做）
  await mech.importMechanisms(env, newId, body, objIdMap, cueIdMap);
  await ledTpl.importTemplates(
    env, newId, body, objIdMap,
    (body.songs || []).filter(x => x.template_id && songIdMap.get(x.id)).map(x => ({ songId: songIdMap.get(x.id), templateId: x.template_id })),
    { songIdMap, cueIdMap },
  );

  await logActivity(request, env, newId, 'create', 'project', newId, {
    name: newName,
    importedFrom: body.project.name || 'unknown',
    objCount: body.stageObjects.length,
    songCount: (body.songs || []).length,
    cueCount: (body.cues || []).length,
  });

  return jsonResp({
    ok: true, id: newId, name: newName,
    counts: {
      stageObjects: body.stageObjects.length,
      songs: (body.songs || []).length,
      cues: (body.cues || []).length,
      cueStates: (body.cueObjectStates || []).length,
    },
  }, 201);
}

async function archiveProject(request, env, projectId) {
  const before = await env.DB.prepare(`SELECT name FROM projects WHERE id = ? LIMIT 1`).bind(projectId).first();
  const result = await env.DB.prepare(
    `UPDATE projects SET status = 'archived', updated_at = datetime('now') WHERE id = ?`
  ).bind(projectId).run();
  if (!result.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  await logActivity(request, env, projectId, 'archive', 'project', projectId, { name: before?.name });
  return jsonResp({ ok: true });
}

// ─────────────────────────────────────────────
// Shows API（admin Tier 1 #8）
//   GET    /api/shows         → list（含 project_count）
//   POST   /api/shows         body: {name, description}
//   GET    /api/shows/:id     → 單筆 + projects
//   PATCH  /api/shows/:id     body: {name?, description?}
//   DELETE /api/shows/:id     → 只能刪空 show
// ─────────────────────────────────────────────

const SHOW_NAME_MAX = 80;
const SHOW_DESC_MAX = 300;

async function handleShowsRouter(request, env, url) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);
  const segs = url.pathname.split('/').filter(Boolean);
  const showId = segs[2] || null;
  const isRead = request.method === 'GET' || request.method === 'HEAD';
  // 建立 / 改 / 刪 Show 只有 admin；其他人只看得到「有自己專案在裡面」的 Show
  if (!isRead && me.role !== 'admin') return jsonResp({ error: '只有製作可以管理 Show' }, 403);

  try {
    if (!showId) {
      if (request.method === 'GET') return await listShows(env, me);
      if (request.method === 'POST') return await createShow(request, env);
      return jsonResp({ error: 'Method not allowed' }, 405);
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(showId)) return jsonResp({ error: 'Invalid show id' }, 400);
    if (request.method === 'GET') return await getShow(env, showId, me);
    if (request.method === 'PATCH') return await updateShow(request, env, showId);
    if (request.method === 'DELETE') return await deleteShow(env, showId);
    return jsonResp({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

// 非 admin：只算自己是成員的專案
function showMemberFilter(me, alias = 'p') {
  return me?.role === 'admin'
    ? { sql: '', binds: [] }
    : { sql: ` AND ${alias}.id IN (SELECT pm.project_id FROM project_members pm WHERE pm.user_id = ?)`, binds: [me.id] };
}

async function listShows(env, me) {
  const f = showMemberFilter(me);
  const rows = await env.DB.prepare(`
    SELECT s.id, s.name, s.description, s.created_at, s.updated_at,
           (SELECT COUNT(*) FROM projects p WHERE p.show_id = s.id AND p.status != 'archived'${f.sql}) AS project_count
    FROM shows s
    ORDER BY s.updated_at DESC
  `).bind(...f.binds).all();
  const list = (rows.results || [])
    .filter(s => me?.role === 'admin' || s.project_count > 0)
    .map(s => ({
      id: s.id, name: s.name, description: s.description,
      projectCount: s.project_count,
      createdAt: s.created_at, updatedAt: s.updated_at,
    }));
  return jsonResp({ shows: list });
}

async function createShow(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const name = (body?.name || '').toString().trim().slice(0, SHOW_NAME_MAX);
  const description = (body?.description || '').toString().trim().slice(0, SHOW_DESC_MAX);
  if (!name) return jsonResp({ error: 'name is required' }, 400);

  const id = 'sh_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  await env.DB.prepare(
    `INSERT INTO shows (id, name, description) VALUES (?, ?, ?)`
  ).bind(id, name, description).run();
  return jsonResp({ ok: true, id }, 201);
}

async function getShow(env, showId, me) {
  const show = await env.DB.prepare(
    `SELECT id, name, description, created_at, updated_at FROM shows WHERE id = ? LIMIT 1`
  ).bind(showId).first();
  if (!show) return jsonResp({ error: 'Not found' }, 404);

  const f = showMemberFilter(me, 'projects');
  const projects = await env.DB.prepare(`
    SELECT id, name FROM projects
    WHERE show_id = ? AND status != 'archived'${f.sql}
    ORDER BY updated_at DESC
  `).bind(showId, ...f.binds).all();
  // 非 admin 看不到「裡面沒有自己專案」的 Show
  if (me?.role !== 'admin' && !(projects.results || []).length) return jsonResp({ error: 'Not found' }, 404);

  return jsonResp({
    show: {
      id: show.id, name: show.name, description: show.description,
      createdAt: show.created_at, updatedAt: show.updated_at,
      projects: (projects.results || []).map(p => ({ id: p.id, name: p.name })),
    },
  });
}

async function updateShow(request, env, showId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const allowed = ['name', 'description'];
  const sets = [], values = [];
  for (const k of allowed) {
    if (k in body) {
      let v = body[k];
      if (k === 'name') v = (v || '').toString().trim().slice(0, SHOW_NAME_MAX);
      if (k === 'description') v = (v || '').toString().trim().slice(0, SHOW_DESC_MAX);
      sets.push(`${k} = ?`); values.push(v);
    }
  }
  if (!sets.length) return jsonResp({ error: 'no updatable fields' }, 400);
  values.push(showId);
  const r = await env.DB.prepare(
    `UPDATE shows SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...values).run();
  if (!r.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ ok: true });
}

async function deleteShow(env, showId) {
  // 安全：不能刪非空 show（避免誤刪一票 project）
  const inUse = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM projects WHERE show_id = ? AND status != 'archived'`
  ).bind(showId).first();
  if ((inUse?.n || 0) > 0) {
    return jsonResp({ error: `這個 Show 底下還有 ${inUse.n} 個專案，請先把專案移走或封存後再刪。` }, 400);
  }
  const r = await env.DB.prepare(`DELETE FROM shows WHERE id = ?`).bind(showId).run();
  if (!r.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ ok: true });
}

// ─────────────────────────────────────────────
// Songs API
//   GET    /api/projects/:id/songs              → list（依 order）
//   POST   /api/projects/:id/songs              body: {name} → 建（自動排在最後）
//   PATCH  /api/projects/:id/songs/:songId      body: {name?, order?, status?, animator_user_id?}
//   DELETE /api/projects/:id/songs/:songId      → 真刪除（cascade cues）
//   POST   /api/projects/:id/songs/reorder      body: {orderedIds: [songId,...]} → 批次更新 order
// ─────────────────────────────────────────────

const SONG_NAME_MAX = 80;

async function listSongs(env, projectId) {
  const query = () => env.DB.prepare(`
    SELECT s.id, s.name, s."order", s.animator_user_id, s.status, s.created_at, s.code, s.template_id,
      (SELECT COUNT(*) FROM cues c WHERE c.song_id = s.id AND c.status = 'master') AS cue_count,
      (SELECT COUNT(*) FROM cues c WHERE c.song_id = s.id AND c.status = 'proposal') AS proposal_count
    FROM songs s
    WHERE s.project_id = ?
    ORDER BY s."order" ASC, s.created_at ASC
  `).bind(projectId).all();
  let r = await query();
  // 舊版建的 / 匯入的歌沒有代號 → 補上
  if ((r.results || []).some(s => !s.code)) {
    await ensureSongCodes(env, projectId);
    r = await query();
  }
  const latest = await latestReadyVideos(env, projectId);
  // 最近一次通過 / 需修改、看過的最新版本號（有更新的版本 → 「有新版 V3」）
  const reviewed = await reviews.reviewSummaryBySong(env.DB, projectId);
  // 每首歌中途換版型的點（0039；沒有 = 空陣列）
  const switchesBy = await ledTpl.loadSwitchesByProject(env, projectId).catch(() => new Map());

  return jsonResp({ songs: (r.results || []).map(s => ({
    id: s.id, name: s.name, order: s.order,
    code: s.code || null,
    animatorUserId: s.animator_user_id, status: s.status,
    createdAt: s.created_at,
    cueCount: s.cue_count, proposalCount: s.proposal_count,
    // 這首歌選的 LED 版型（0034；沒選 = 整張畫布 = null）
    templateId: s.template_id || null,
    // 中途換版型的點（0039）：{ id, cueId, cueName, cueTimeSec, atSec, templateId }；開頭的版型是上面的 templateId
    templateSwitches: switchesBy.get(s.id) || [],
    // 最新可以播的影片版本（沒有 = null）；版本清單：GET /songs/:id/videos
    latestVideoId: latest.get(s.id)?.id || null,
    latestVideoVersion: latest.get(s.id)?.version ?? null,
    lastReview: reviewed.get(s.id)?.lastReview ?? null,
    reviewedVersion: reviewed.get(s.id)?.reviewedVersion ?? null,
  })) });
}

async function createSong(request, env, projectId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const name = (body?.name || '').toString().trim().slice(0, SONG_NAME_MAX);
  if (!name) return jsonResp({ error: 'name is required' }, 400);

  // 歌曲代號（Drive 檔名開頭用它對歌）：有給就檢查，沒給就接在最大的 S 號碼後面
  let wantCode = null;
  if (body?.code !== undefined && body?.code !== null && body?.code !== '') {
    const c = normalizeSongCodeInput(body.code);
    if (c.error) return jsonResp({ error: c.error }, 400);
    wantCode = c.code;
  }

  // 找最大 order + 1
  const maxRow = await env.DB.prepare(
    `SELECT COALESCE(MAX("order"), -1) AS max_order FROM songs WHERE project_id = ?`
  ).bind(projectId).first();
  const order = (maxRow?.max_order ?? -1) + 1;

  const id = 's_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  let code = null;
  for (let attempt = 0; attempt < 3 && !code; attempt++) {
    const existing = (await env.DB.prepare(`SELECT id, name, code FROM songs WHERE project_id = ?`).bind(projectId).all()).results || [];
    if (wantCode) {
      const taken = songCodeTakenBy(wantCode, existing);
      if (taken) return jsonResp({ error: `代號 ${wantCode} 已經是「${taken.name}」在用了`, codeTaken: true }, 409);
    }
    const tryCode = wantCode || nextSongCode(existing.map(s => s.code));
    try {
      await env.DB.prepare(
        `INSERT INTO songs (id, project_id, name, "order", code) VALUES (?, ?, ?, ?, ?)`
      ).bind(id, projectId, name, order, tryCode).run();
      code = tryCode;
    } catch (e) {
      // 同時有人建歌搶到同一個代號 → 再挑一次
      if (!isUniqueError(e)) throw e;
      if (wantCode) return jsonResp({ error: `代號 ${wantCode} 已經被用了`, codeTaken: true }, 409);
    }
  }
  if (!code) return jsonResp({ error: '建立歌曲失敗（代號一直撞到），請再試一次' }, 409);

  // touch project updated_at
  await env.DB.prepare(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`).bind(projectId).run();
  await logActivity(request, env, projectId, 'create', 'song', id, { name, code });
  return jsonResp({ ok: true, id, order, code }, 201);
}

async function getSong(env, projectId, songId) {
  const row = await env.DB.prepare(`SELECT * FROM songs WHERE id = ? AND project_id = ? LIMIT 1`).bind(songId, projectId).first();
  if (!row) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ song: row });
}

// 改歌：
//   只改狀態 → 照 songStatusDecision 的規則（動畫師提交 / 撤回、導演隨時通過 / 需修改（要有影片）、admin 都可以）
//     前端可以帶 expectedStatus（它以為的目前狀態）；跟資料庫不一樣就回 409，不會蓋掉別人剛做的決定
//   改歌名 / 順序 / 指派 / Drive 資料夾 → 專案 admin
async function updateSong(request, env, ctx, songId) {
  const { me, projectId, role } = ctx;
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResp({ error: 'Invalid JSON' }, 400);

  const before = ctx.song;  // router 已經確認這首歌屬於這個專案
  if ('templateId' in body && !('template_id' in body)) body.template_id = body.templateId;

  const touchesContent = SONG_CONTENT_FIELDS.some(k => k in body);
  if (touchesContent && !canEditProjectContent(role)) {
    return jsonResp({ error: '只有製作可以改歌名、代號、順序、指派或 Drive 資料夾' }, 403);
  }

  const sets = [], values = [];
  if ('name' in body) {
    const name = (body.name ?? '').toString().trim().slice(0, SONG_NAME_MAX);
    if (!name) return jsonResp({ error: '歌名不能是空的' }, 400);
    sets.push('name = ?'); values.push(name);
  }
  if ('order' in body) {
    const n = Number(body.order);
    if (!Number.isInteger(n) || n < 0 || n > 100000) return jsonResp({ error: '順序不合法' }, 400);
    sets.push('"order" = ?'); values.push(n);
  }
  if ('animator_user_id' in body) {
    // 只能指派「這個專案的動畫師」（不然可以把別的專案、甚至不相干的人指派進來）
    const uid = body.animator_user_id;
    let memberRole = null;
    if (typeof uid === 'string' && uid && ID_RE.test(uid)) {
      const m = await env.DB.prepare(
        `SELECT role FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1`
      ).bind(projectId, uid).first();
      memberRole = m?.role ?? null;
    }
    const d = animatorAssignmentDecision(uid, memberRole);
    if (!d.ok) return jsonResp({ error: d.error }, d.status);
    sets.push('animator_user_id = ?'); values.push(d.clear ? null : uid);
  }
  if ('code' in body) {
    // 歌曲代號：Drive 資料夾裡檔名開頭是這個代號的影片會對到這首歌（S1 和 S01 算同一個）
    const c = normalizeSongCodeInput(body.code);
    if (c.error) return jsonResp({ error: c.error }, 400);
    const others = (await env.DB.prepare(
      `SELECT id, name, code FROM songs WHERE project_id = ? AND id != ?`
    ).bind(projectId, songId).all()).results || [];
    const taken = songCodeTakenBy(c.code, others);
    if (taken) return jsonResp({ error: `代號 ${c.code} 已經是「${taken.name}」在用了`, codeTaken: true }, 409);
    sets.push('code = ?'); values.push(c.code);
  }
  if ('template_id' in body) {
    // LED 版型（0034）：null / 「全部」= 整張畫布；其他要是這個專案的版型
    const t = await ledTpl.resolveTemplateChoice(env, projectId, body.template_id);
    if (!t.ok) return jsonResp({ error: t.error }, 400);
    // 這首歌有中途換版型：開頭要是自己排的版型、畫布要跟換版型的版型一樣大（0039）
    const startProblem = await ledTpl.checkStartAgainstSwitches(env, projectId, songId, t.id);
    if (startProblem) return jsonResp({ error: startProblem, timeline: true }, 409);
    sets.push('template_id = ?'); values.push(t.id);
  }
  if ('drive_folder_id' in body) {
    const f = body.drive_folder_id;
    if (f !== null && f !== '' && (typeof f !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(f))) {
      return jsonResp({ error: 'Drive 資料夾 id 不合法' }, 400);
    }
    sets.push('drive_folder_id = ?'); values.push(f || null);
  }

  let statusChange = null;
  let prepared = null;
  if ('status' in body) {
    // 通過 / 需修改：導演 / 製作隨時可以決定，但這首歌要有可以播的版本（舊規則「審查中 → 通過 / 需修改」不用）
    const isDecision = reviews.REVIEW_STATUSES.includes(body.status);
    const d = songStatusDecision({
      role, userId: me.id, song: before, to: body.status,
      expected: 'expectedStatus' in body ? body.expectedStatus : undefined,
      hasReadyVideo: isDecision ? await reviews.songHasReadyVideo(env.DB, before.id) : false,
      // 有帶看的版本 = 新版前端的決定列：同一個狀態可以再決定一次（已通過 V1 → 通過 V2）
      redecide: isDecision && 'reviewVideoId' in body,
    });
    if (!d.ok) {
      return jsonResp({
        error: d.error,
        ...(d.currentStatus ? { currentStatus: d.currentStatus } : {}),
        ...(d.noVideo ? { noVideo: true } : {}),
      }, d.status);
    }
    if (!d.noop) {
      // 通過 / 需修改：需修改要寫原因（reason）、看的是哪一版（reviewVideoId，沒帶 = 最新一版）→ reviews.mjs
      prepared = await reviews.prepareStatusChange(env.DB, { song: before, body, to: body.status });
      if (!prepared.ok) return jsonResp({ error: prepared.error }, prepared.status);
      const repeat = d.redecide && (!prepared.decision?.video || await reviews.isRepeatDecision(env.DB, {
        songId: before.id, to: body.status, videoId: prepared.decision.video.id,
      }));
      if (!repeat) {
        sets.push('status = ?'); values.push(body.status);
        statusChange = { from: before.status, to: body.status };
      }
    }
  }

  if (!sets.length) {
    if ('status' in body) return jsonResp({ ok: true, status: before.status, unchanged: true });
    return jsonResp({ error: 'no updatable fields' }, 400);
  }

  // 改狀態時加上「狀態還是剛剛讀到的那個」→ 兩個人同時按，只有先到的算數
  const where = statusChange ? 'id = ? AND project_id = ? AND status = ?' : 'id = ? AND project_id = ?';
  values.push(songId, projectId);
  if (statusChange) values.push(statusChange.from);
  let result;
  try {
    result = await env.DB.prepare(`UPDATE songs SET ${sets.join(', ')} WHERE ${where}`).bind(...values).run();
  } catch (e) {
    if (isUniqueError(e)) return jsonResp({ error: '這個代號剛剛被別首歌用了，請換一個', codeTaken: true }, 409);
    throw e;
  }
  if (!result.meta.changes) {
    if (statusChange) {
      const now = await env.DB.prepare(`SELECT status FROM songs WHERE id = ? LIMIT 1`).bind(songId).first();
      return jsonResp({ error: '這首歌的狀態剛剛被別人改了，請重新整理後再操作', currentStatus: now?.status ?? null }, 409);
    }
    return jsonResp({ error: 'Not found' }, 404);
  }

  // 審片紀錄、需修改的原因留言、通知（導演 / 動畫師 / 被指派的人）→ reviews.mjs
  const songRow = { ...before, project_id: projectId };
  let review = null;
  if (statusChange) {
    review = await reviews.afterSongStatusChange(env.DB, { me, role, song: songRow, ...statusChange, prepared });
  }
  if ('animator_user_id' in body && body.animator_user_id) {
    await reviews.afterAnimatorAssigned(env.DB, { me, song: songRow, toUserId: body.animator_user_id });
  }

  const changes = {};
  for (const k of [...SONG_CONTENT_FIELDS, 'status']) if (k in body) changes[k] = body[k];
  if (review?.reviewId && prepared?.decision?.reason) changes.reason = prepared.decision.reason;
  await logActivity(request, env, projectId, 'update', 'song', songId, {
    name: before?.name,
    changes,
    statusFrom: statusChange ? statusChange.from : undefined,
    statusTo: statusChange ? statusChange.to : undefined,
  });
  return jsonResp({
    ok: true,
    ...(statusChange ? { status: statusChange.to } : {}),
    ...(review?.reviewId ? { reviewId: review.reviewId, reviewCommentId: review.commentId } : {}),
  });
}

async function deleteSong(request, env, projectId, songId) {
  const before = await env.DB.prepare(`SELECT name FROM songs WHERE id = ? AND project_id = ? LIMIT 1`).bind(songId, projectId).first();
  const videoFiles = (await env.DB.prepare(
    `SELECT r2_key, upload_id FROM song_videos WHERE song_id = ? AND project_id = ?`
  ).bind(songId, projectId).all()).results || [];
  // 留言的縮圖（0026）：留言跟著歌一起刪，R2 的縮圖也清掉
  const thumbKeys = ((await env.DB.prepare(
    `SELECT thumb_key FROM comments WHERE song_id = ? AND thumb_key IS NOT NULL`
  ).bind(songId).all().catch(() => ({ results: [] }))).results || []).map(r => r.thumb_key);
  // 留言的參考圖片（0028，含還沒送出的）
  const imageKeys = await attachments.songAttachmentKeys(env.DB, songId);
  const result = await env.DB.prepare(`DELETE FROM songs WHERE id = ? AND project_id = ?`).bind(songId, projectId).run();
  if (!result.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  // 歌的影片版本跟著歌一起刪（資料庫那邊 ON DELETE CASCADE），R2 的檔案也清掉
  if (videoFiles.length) runInBackground(request, cleanupSongVideoFiles(env, videoFiles));
  if (thumbKeys.length) runInBackground(request, reviews.deleteCommentThumbs(env.MODELS, thumbKeys));
  if (imageKeys.length) runInBackground(request, attachments.deleteAttachmentObjects(env.MODELS, imageKeys));
  await logActivity(request, env, projectId, 'delete', 'song', songId, { name: before?.name });
  return jsonResp({ ok: true });
}

async function reorderSongs(request, env, projectId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const ids = Array.isArray(body?.orderedIds) ? body.orderedIds : null;
  if (!ids || !ids.length) return jsonResp({ error: 'orderedIds required' }, 400);

  // batch UPDATE — D1 supports prepared statement batching
  const stmts = ids.map((id, i) =>
    env.DB.prepare(`UPDATE songs SET "order" = ? WHERE id = ? AND project_id = ?`).bind(i, id, projectId)
  );
  await env.DB.batch(stmts);
  await logActivity(request, env, projectId, 'reorder', 'song', null, { count: ids.length });
  return jsonResp({ ok: true, updated: ids.length });
}

// ─────────────────────────────────────────────
// Cues API
//   GET    /api/projects/:projectId/songs/:songId/cues          → list
//   POST   /api/projects/:projectId/songs/:songId/cues          body: {name, position_xyz?, ...}
//   PATCH  /api/projects/:projectId/songs/:songId/cues/:cueId
//   DELETE /api/projects/:projectId/songs/:songId/cues/:cueId
// ─────────────────────────────────────────────

const CUE_NAME_MAX = 100;
// 新 cue 沒指定淡入淡出時用 1 秒（0 = 硬切）。要跟前端 NEW_CUE_CROSSFADE_SECONDS 一致
const DEFAULT_CUE_CROSSFADE_SECONDS = 1;

// 從另一首歌（同 project 或跨 project）把所有 master cue + cue_object_states 複製進此 song
// 物件 id 用 mesh_name 對應（兩邊 mesh_name 相同就 map）— 避免硬綁 stage_object id
async function importCuesFromSong(request, env, targetProjectId, targetSongId) {
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);

  let body = {};
  try { body = await request.json(); } catch {}
  const fromSongId = body?.fromSongId;
  const replace = !!body?.replace;
  if (!fromSongId || typeof fromSongId !== 'string') return jsonResp({ error: 'Missing fromSongId' }, 400);

  // 驗 source song 存在 + 用戶有權限存取它的 project
  const srcSong = await env.DB.prepare(
    `SELECT s.id, s.project_id, p.status AS project_status FROM songs s JOIN projects p ON p.id = s.project_id WHERE s.id = ? LIMIT 1`
  ).bind(fromSongId).first();
  if (!srcSong) return jsonResp({ error: 'Source song not found' }, 404);
  if (me.role !== 'admin') {
    if (srcSong.project_status === 'archived') return jsonResp({ error: 'Source song not found' }, 404);
    const m = await env.DB.prepare(
      `SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1`
    ).bind(srcSong.project_id, me.id).first();
    if (!m) return jsonResp({ error: '沒有權限存取來源專案' }, 403);
  }

  // 抓 source cues + cue_object_states + stage_objects（取 mesh_name）
  const srcCues = (await env.DB.prepare(
    `SELECT * FROM cues WHERE song_id = ? AND status = 'master' ORDER BY "order"`
  ).bind(fromSongId).all()).results || [];
  if (srcCues.length === 0) return jsonResp({ error: '來源歌曲沒有 cue' }, 400);

  // 抓 source project 的 stage_objects → mesh_name → src_obj_id 對照
  const srcObjs = (await env.DB.prepare(
    `SELECT id, mesh_name FROM stage_objects WHERE project_id = ?`
  ).bind(srcSong.project_id).all()).results || [];
  const srcObjMap = new Map(srcObjs.map(o => [o.id, o.mesh_name]));

  // 抓 target project 的 stage_objects → mesh_name → tgt_obj_id
  const tgtObjs = (await env.DB.prepare(
    `SELECT id, mesh_name FROM stage_objects WHERE project_id = ?`
  ).bind(targetProjectId).all()).results || [];
  const meshNameToTgt = new Map(tgtObjs.map(o => [o.mesh_name, o.id]));

  // 如果 replace = true，先清掉 target song 既有 master cue
  if (replace) {
    await env.DB.prepare(
      `DELETE FROM cues WHERE song_id = ? AND status = 'master'`
    ).bind(targetSongId).run();
  }

  // 找 target song 既有 cue 的最大 order，新 cue append 在後
  const maxOrderRow = await env.DB.prepare(
    `SELECT COALESCE(MAX("order"), -1) AS max_order FROM cues WHERE song_id = ?`
  ).bind(targetSongId).first();
  let nextOrder = (maxOrderRow?.max_order ?? -1) + 1;

  let cuesInserted = 0;
  let statesInserted = 0;
  let statesSkipped = 0;

  for (const c of srcCues) {
    const newCueId = 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + cuesInserted;
    await env.DB.prepare(`
      INSERT INTO cues (id, song_id, name, "order", position_xyz, rotation_xyz, fov, crossfade_seconds, video_time_sec, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'master')
    `).bind(newCueId, targetSongId, c.name, nextOrder++, c.position_xyz, c.rotation_xyz, c.fov, c.crossfade_seconds, c.video_time_sec).run();
    cuesInserted++;
    // 機關位置：同一個專案照機關 id，別的專案照機關名稱
    await mech.copyCuePositionsAcross(env, { srcProjectId: srcSong.project_id, dstProjectId: targetProjectId, srcCueId: c.id, dstCueId: newCueId });

    // 複製 cue_object_states，依 mesh_name 重新對應到 target obj id
    const states = (await env.DB.prepare(
      `SELECT * FROM cue_object_states WHERE cue_id = ?`
    ).bind(c.id).all()).results || [];

    for (const s of states) {
      const meshName = srcObjMap.get(s.stage_object_id);
      const tgtObjId = meshName ? meshNameToTgt.get(meshName) : null;
      if (!tgtObjId) { statesSkipped++; continue; }
      const newStateId = 'cos_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + statesInserted;
      await env.DB.prepare(`
        INSERT INTO cue_object_states (id, cue_id, stage_object_id, position, rotation, scale, visible, custom_props)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(newStateId, newCueId, tgtObjId, s.position, s.rotation, s.scale, s.visible, s.custom_props).run();
      statesInserted++;
    }
  }

  await logActivity(request, env, targetProjectId, 'bulk_create', 'cue', targetSongId, {
    importedFrom: fromSongId, cuesInserted, statesInserted, statesSkipped,
  });

  return jsonResp({
    ok: true,
    cuesInserted,
    statesInserted,
    statesSkipped,
    message: statesSkipped > 0
      ? `匯入 ${cuesInserted} 個 cue；${statesSkipped} 個物件位置因 mesh 名稱對不到被略過`
      : `匯入 ${cuesInserted} 個 cue + ${statesInserted} 個物件位置`,
  }, 201);
}

async function listCues(env, songId) {
  const r = await env.DB.prepare(`
    SELECT id, name, "order", position_xyz, rotation_xyz, fov, crossfade_seconds, video_time_sec,
           status, proposed_by_user_id, base_cue_id, thumbnail_r2_key,
           created_at, updated_at
    FROM cues WHERE song_id = ?
    ORDER BY "order" ASC, created_at ASC
  `).bind(songId).all();

  return jsonResp({ cues: (r.results || []).map(parseCueRow) });
}

function parseCueRow(c) {
  const safeJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
  return {
    id: c.id,
    name: c.name,
    order: c.order,
    position: safeJson(c.position_xyz, { x: 0, y: 0, z: 0 }),
    rotation: safeJson(c.rotation_xyz, { pitch: 0, yaw: 0, roll: 0 }),
    fov: c.fov,
    crossfadeSeconds: c.crossfade_seconds,
    videoTimeSec: typeof c.video_time_sec === 'number' ? c.video_time_sec : null,
    status: c.status,
    proposedByUserId: c.proposed_by_user_id,
    baseCueId: c.base_cue_id,
    thumbnailUrl: c.thumbnail_r2_key ? `/r2/${c.thumbnail_r2_key}` : null,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

async function createCue(request, env, projectId, songId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const name = (body?.name || '').toString().trim().slice(0, CUE_NAME_MAX);
  if (!name) return jsonResp({ error: 'name is required' }, 400);

  // 複製來源 / 模板 / 物件都一定要是這個專案的（不然可以把別人專案的資料抄進來）
  let cloneSrc = null;
  if (body?.cloneFrom) {
    if (typeof body.cloneFrom !== 'string' || !ID_RE.test(body.cloneFrom)) return jsonResp({ error: '來源 cue 不合法' }, 400);
    cloneSrc = await env.DB.prepare(
      `SELECT c.id, c.crossfade_seconds FROM cues c JOIN songs s ON s.id = c.song_id WHERE c.id = ? AND s.project_id = ? LIMIT 1`
    ).bind(body.cloneFrom, projectId).first();
    if (!cloneSrc) return jsonResp({ error: '這個專案裡找不到來源 cue' }, 404);
  } else if (body?.fromTemplateId) {
    if (typeof body.fromTemplateId !== 'string' || !ID_RE.test(body.fromTemplateId)) return jsonResp({ error: '模板不合法' }, 400);
    const tplOk = await env.DB.prepare(
      `SELECT id FROM cue_templates WHERE id = ? AND (project_id IS NULL OR project_id = ?) LIMIT 1`
    ).bind(body.fromTemplateId, projectId).first();
    if (!tplOk) return jsonResp({ error: '找不到這個模板' }, 404);
  }
  let projectObjIds = null;
  if (!body?.cloneFrom && Array.isArray(body?.snapshotStates) && body.snapshotStates.length > 0) {
    const objs = await env.DB.prepare(`SELECT id FROM stage_objects WHERE project_id = ?`).bind(projectId).all();
    projectObjIds = new Set((objs.results || []).map(o => o.id));
  }

  const position = JSON.stringify(body?.position || { x: 0, y: 0, z: 0 });
  const rotation = JSON.stringify(body?.rotation || { pitch: 0, yaw: 0, roll: 0 });
  const fov = typeof body?.fov === 'number' && isFinite(body.fov) ? body.fov : 60;
  // 淡入淡出秒數：有給就用；複製的 cue 沿用來源的；都沒有 → 1 秒（0 = 硬切，要明確給 0 才是）
  // （影片時間不複製：兩個 cue 對到同一秒沒有意義，複製出來的 cue 由使用者自己設）
  const crossfade = typeof body?.crossfadeSeconds === 'number' && isFinite(body.crossfadeSeconds) && body.crossfadeSeconds >= 0
    ? body.crossfadeSeconds
    : (cloneSrc && typeof cloneSrc.crossfade_seconds === 'number' ? cloneSrc.crossfade_seconds : DEFAULT_CUE_CROSSFADE_SECONDS);

  const maxRow = await env.DB.prepare(
    `SELECT COALESCE(MAX("order"), -1) AS max_order FROM cues WHERE song_id = ? AND status = 'master'`
  ).bind(songId).first();
  const order = (maxRow?.max_order ?? -1) + 1;

  const id = 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  await env.DB.prepare(`
    INSERT INTO cues (id, song_id, name, "order", position_xyz, rotation_xyz, fov, crossfade_seconds, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'master')
  `).bind(id, songId, name, order, position, rotation, fov, crossfade).run();

  // 三選一：cloneFrom 或 snapshotStates 或空白
  if (body?.cloneFrom && /^[a-zA-Z0-9_-]{1,64}$/.test(body.cloneFrom)) {
    // 複製來源 cue 的所有 cue_object_states
    const src = await env.DB.prepare(`
      SELECT stage_object_id, position, rotation, scale, visible, custom_props
      FROM cue_object_states WHERE cue_id = ?
    `).bind(body.cloneFrom).all();

    const stmts = [];
    for (const r of (src.results || [])) {
      const newId = 'cos_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + stmts.length;
      stmts.push(env.DB.prepare(`
        INSERT INTO cue_object_states (id, cue_id, stage_object_id, position, rotation, scale, visible, custom_props)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(newId, id, r.stage_object_id, r.position, r.rotation, r.scale, r.visible, r.custom_props));
    }
    if (stmts.length > 0) await env.DB.batch(stmts);
    // 來源 cue 自己設的機關位置也一起複製
    await mech.cloneCuePositions(env, body.cloneFrom, id);
  } else if (Array.isArray(body?.snapshotStates) && body.snapshotStates.length > 0) {
    // 顯式 snapshot：每個 object 的 position/rotation
    const stmts = [];
    for (const s of body.snapshotStates.slice(0, 1000)) {
      if (!s?.objectId || !/^[a-zA-Z0-9_-]{1,64}$/.test(s.objectId)) continue;
      if (!projectObjIds?.has(s.objectId)) continue;  // 不是這個專案的物件 → 略過
      const cosId = 'cos_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + stmts.length;
      const sPos = s.position ? JSON.stringify(s.position) : null;
      const sRot = s.rotation ? JSON.stringify(s.rotation) : null;
      const sScl = s.scale    ? JSON.stringify(s.scale)    : null;
      stmts.push(env.DB.prepare(`
        INSERT INTO cue_object_states (id, cue_id, stage_object_id, position, rotation, scale)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(cosId, id, s.objectId, sPos, sRot, sScl));
    }
    if (stmts.length > 0) await env.DB.batch(stmts);
  } else if (body?.fromTemplateId) {
    // 從 cue template 套用：用 mesh_name 對應到當前 project 的 stage_object_id
    const tpl = await env.DB.prepare(`SELECT payload FROM cue_templates WHERE id = ? LIMIT 1`).bind(body.fromTemplateId).first();
    if (tpl) {
      let payload = {};
      try { payload = JSON.parse(tpl.payload); } catch {}
      // 拿當前 project 的 stage_objects（mesh_name → id map）
      const objs = await env.DB.prepare(`SELECT id, mesh_name FROM stage_objects WHERE project_id = ?`).bind(projectId).all();
      const meshToId = new Map();
      for (const o of (objs.results || [])) meshToId.set(o.mesh_name, o.id);
      // 更新 cue 的 position/rotation/fov/crossfade（如果 template 有）
      if (payload.position || payload.rotation || payload.fov != null || payload.crossfadeSeconds != null) {
        const sets = [], vals = [];
        if (payload.position) { sets.push('position_xyz = ?'); vals.push(JSON.stringify(payload.position)); }
        if (payload.rotation) { sets.push('rotation_xyz = ?'); vals.push(JSON.stringify(payload.rotation)); }
        if (payload.fov != null) { sets.push('fov = ?'); vals.push(payload.fov); }
        if (payload.crossfadeSeconds != null) { sets.push('crossfade_seconds = ?'); vals.push(payload.crossfadeSeconds); }
        if (sets.length > 0) {
          vals.push(id);
          await env.DB.prepare(`UPDATE cues SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        }
      }
      // 套 snapshotStates（用 mesh_name 對 stage_object_id）
      const stmts = [];
      for (const s of (payload.snapshotStates || [])) {
        const oid = meshToId.get(s.meshName);
        if (!oid) continue;
        const cosId = 'cos_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + stmts.length;
        const sPos = s.position ? JSON.stringify(s.position) : null;
        const sRot = s.rotation ? JSON.stringify(s.rotation) : null;
        const sScl = s.scale ? JSON.stringify(s.scale) : null;
        stmts.push(env.DB.prepare(`
          INSERT INTO cue_object_states (id, cue_id, stage_object_id, position, rotation, scale)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(cosId, id, oid, sPos, sRot, sScl));
      }
      if (stmts.length > 0) await env.DB.batch(stmts);
      // 常用擺位裡的機關位置（用機關名稱對到這個專案的機關）
      await mech.applyNamedPositions(env, projectId, id, payload.mechanismPositions);
    }
  }
  // 從目前 3D 畫面建立：前端給每個機關現在的值 → 存成這個 cue 自己的
  if (!body?.cloneFrom && !body?.fromTemplateId && body?.snapshotMechanisms) {
    await mech.snapshotCuePositions(env, projectId, id, body.snapshotMechanisms);
  }
  // 都沒給 → 空白 cue（無 override）

  const cueOrigin = body?.cloneFrom ? 'clone'
                  : body?.fromTemplateId ? 'template'
                  : (Array.isArray(body?.snapshotStates) && body.snapshotStates.length > 0) ? 'snapshot'
                  : 'blank';
  await logActivity(request, env, projectId, 'create', 'cue', id, { name, songId, origin: cueOrigin });

  return jsonResp({ ok: true, id, order }, 201);
}

async function resetCue(request, env, projectId, cueId) {
  const before = await env.DB.prepare(`SELECT name FROM cues WHERE id = ? LIMIT 1`).bind(cueId).first();
  const result = await env.DB.prepare(
    `DELETE FROM cue_object_states WHERE cue_id = ?`
  ).bind(cueId).run();
  // 這個 cue 自己設的機關位置也清掉（回到沿用上一個 cue）
  const removedMechanismPositions = await mech.clearCuePositions(env, cueId);
  await logActivity(request, env, projectId, 'reset', 'cue', cueId, { name: before?.name, removed: result.meta.changes, removedMechanismPositions });
  return jsonResp({ ok: true, removed: result.meta.changes, removedMechanismPositions });
}

async function reorderCues(request, env, projectId, songId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const ids = Array.isArray(body?.orderedIds) ? body.orderedIds : null;
  if (!ids || !ids.length) return jsonResp({ error: 'orderedIds required' }, 400);

  const stmts = ids.map((id, i) =>
    env.DB.prepare(`UPDATE cues SET "order" = ? WHERE id = ? AND song_id = ?`).bind(i, id, songId)
  );
  await env.DB.batch(stmts);
  await logActivity(request, env, projectId, 'reorder', 'cue', null, { songId, count: ids.length });
  return jsonResp({ ok: true, updated: ids.length });
}

async function getCue(env, songId, cueId) {
  const row = await env.DB.prepare(`SELECT * FROM cues WHERE id = ? AND song_id = ? LIMIT 1`).bind(cueId, songId).first();
  if (!row) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ cue: parseCueRow(row) });
}

const CUE_STATUSES = ['master', 'proposal', 'alternate'];

async function updateCue(request, env, projectId, songId, cueId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResp({ error: 'Invalid JSON' }, 400);

  const before = await env.DB.prepare(`SELECT name FROM cues WHERE id = ? AND song_id = ? LIMIT 1`).bind(cueId, songId).first();

  const isNum = (v) => typeof v === 'number' && isFinite(v);
  const sets = [], values = [];
  if ('name' in body) { sets.push('name = ?'); values.push((body.name || '').toString().trim().slice(0, CUE_NAME_MAX)); }
  if ('order' in body) {
    if (!isNum(body.order)) return jsonResp({ error: '順序不合法' }, 400);
    sets.push('"order" = ?'); values.push(body.order);
  }
  if ('position' in body) { sets.push('position_xyz = ?'); values.push(JSON.stringify(body.position)); }
  if ('rotation' in body) { sets.push('rotation_xyz = ?'); values.push(JSON.stringify(body.rotation)); }
  if ('fov' in body) {
    if (!isNum(body.fov)) return jsonResp({ error: 'fov 不合法' }, 400);
    sets.push('fov = ?'); values.push(body.fov);
  }
  if ('crossfadeSeconds' in body) {
    if (!isNum(body.crossfadeSeconds) || body.crossfadeSeconds < 0) return jsonResp({ error: '淡入淡出秒數不合法' }, 400);
    sets.push('crossfade_seconds = ?'); values.push(body.crossfadeSeconds);
  }
  if ('videoTimeSec' in body) {
    const v = body.videoTimeSec;
    sets.push('video_time_sec = ?');
    values.push(isNum(v) && v >= 0 ? v : null);
  }
  if ('status' in body) {
    if (!CUE_STATUSES.includes(body.status)) return jsonResp({ error: 'cue 狀態不正確' }, 400);
    sets.push('status = ?'); values.push(body.status);
  }

  if (!sets.length) return jsonResp({ error: 'no updatable fields' }, 400);
  values.push(cueId, songId);

  const result = await env.DB.prepare(
    `UPDATE cues SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ? AND song_id = ?`
  ).bind(...values).run();
  if (!result.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  await logActivity(request, env, projectId, 'update', 'cue', cueId, { name: before?.name, changes: body });
  return jsonResp({ ok: true });
}

async function deleteCue(request, env, projectId, songId, cueId) {
  const before = await env.DB.prepare(`SELECT name FROM cues WHERE id = ? AND song_id = ? LIMIT 1`).bind(cueId, songId).first();
  const result = await env.DB.prepare(`DELETE FROM cues WHERE id = ? AND song_id = ?`).bind(cueId, songId).run();
  if (!result.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  await logActivity(request, env, projectId, 'delete', 'cue', cueId, { name: before?.name });
  return jsonResp({ ok: true });
}

// ─────────────────────────────────────────────
// Stage Objects API（每個專案的可動物件清單）
// GET    /api/projects/:id/stage-objects                  → list
// POST   /api/projects/:id/stage-objects                  body: {meshName, displayName?, category?, defaultPosition?, defaultRotation?, metadata?}
// PATCH  /api/projects/:id/stage-objects/:objId
// DELETE /api/projects/:id/stage-objects/:objId
// POST   /api/projects/:id/stage-objects/seed-defaults    → 一鍵塞範例
// ─────────────────────────────────────────────

const STAGE_OBJ_CATEGORIES = ['led_panel', 'walk_point', 'mechanism', 'fixture', 'performer', 'other'];

async function listStageObjects(env, projectId) {
  const r = await env.DB.prepare(`
    SELECT id, mesh_name, display_name, category, "order",
           default_position, default_rotation, default_scale, metadata, created_at,
           locked, material_props, led_props
    FROM stage_objects
    WHERE project_id = ?
    ORDER BY "order" ASC, created_at ASC
  `).bind(projectId).all();

  return jsonResp({ stageObjects: (r.results || []).map(parseStageObjectRow) });
}

function parseStageObjectRow(o) {
  const safe = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
  return {
    id: o.id,
    meshName: o.mesh_name,
    displayName: o.display_name || o.mesh_name,
    category: o.category,
    order: o.order,
    defaultPosition: safe(o.default_position, { x: 0, y: 0, z: 0 }),
    defaultRotation: safe(o.default_rotation, { pitch: 0, yaw: 0, roll: 0 }),
    defaultScale: safe(o.default_scale, { x: 1, y: 1, z: 1 }),
    metadata: o.metadata ? safe(o.metadata, null) : null,
    createdAt: o.created_at,
    locked: !!o.locked,
    materialProps: o.material_props ? safe(o.material_props, null) : null,
    ledProps: o.led_props ? safe(o.led_props, null) : null,
  };
}

async function createStageObject(request, env, projectId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }

  const meshName = (body?.meshName || '').toString().trim().slice(0, 80);
  if (!meshName) return jsonResp({ error: 'meshName is required' }, 400);

  const category = STAGE_OBJ_CATEGORIES.includes(body?.category) ? body.category : 'other';
  const displayName = (body?.displayName || '').toString().slice(0, 80) || null;
  const defaultPosition = JSON.stringify(body?.defaultPosition || { x: 0, y: 0, z: 0 });
  const defaultRotation = JSON.stringify(body?.defaultRotation || { pitch: 0, yaw: 0, roll: 0 });
  const defaultScale = JSON.stringify(body?.defaultScale || { x: 1, y: 1, z: 1 });
  const metadata = body?.metadata ? JSON.stringify(body.metadata) : null;

  // 計算 order
  const maxRow = await env.DB.prepare(
    `SELECT COALESCE(MAX("order"), -1) AS max_order FROM stage_objects WHERE project_id = ?`
  ).bind(projectId).first();
  const order = (maxRow?.max_order ?? -1) + 1;

  const id = 'so_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  try {
    await env.DB.prepare(`
      INSERT INTO stage_objects (id, project_id, mesh_name, display_name, category, "order",
        default_position, default_rotation, default_scale, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, projectId, meshName, displayName, category, order,
            defaultPosition, defaultRotation, defaultScale, metadata).run();
  } catch (e) {
    if (/UNIQUE/.test(e.message)) {
      return jsonResp({ error: `mesh "${meshName}" 已存在` }, 409);
    }
    throw e;
  }

  await logActivity(request, env, projectId, 'create', 'stage_object', id, { name: displayName || meshName, category });
  return jsonResp({ ok: true, id }, 201);
}

async function updateStageObject(request, env, projectId, objId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }

  const sets = [], values = [];
  if ('displayName' in body) { sets.push('display_name = ?'); values.push((body.displayName || '').toString().slice(0, 80) || null); }
  if ('category' in body && STAGE_OBJ_CATEGORIES.includes(body.category)) {
    sets.push('category = ?'); values.push(body.category);
  }
  if ('order' in body) { sets.push('"order" = ?'); values.push(body.order); }
  if ('defaultPosition' in body) { sets.push('default_position = ?'); values.push(JSON.stringify(body.defaultPosition)); }
  if ('defaultRotation' in body) { sets.push('default_rotation = ?'); values.push(JSON.stringify(body.defaultRotation)); }
  if ('defaultScale' in body) { sets.push('default_scale = ?'); values.push(JSON.stringify(body.defaultScale)); }
  if ('metadata' in body) { sets.push('metadata = ?'); values.push(body.metadata ? JSON.stringify(body.metadata) : null); }
  if ('locked' in body) { sets.push('locked = ?'); values.push(body.locked ? 1 : 0); }
  if ('materialProps' in body) {
    sets.push('material_props = ?');
    values.push(body.materialProps ? JSON.stringify(body.materialProps) : null);
  }
  if ('ledProps' in body) {
    sets.push('led_props = ?');
    values.push(body.ledProps ? JSON.stringify(body.ledProps) : null);
  }

  if (!sets.length) return jsonResp({ error: 'no updatable fields' }, 400);

  // 抓物件名稱以利 log（同時偵測是否有 meta 性質的改動）
  const before = await env.DB.prepare(
    `SELECT display_name, mesh_name FROM stage_objects WHERE id = ? LIMIT 1`
  ).bind(objId).first();

  values.push(objId, projectId);
  const result = await env.DB.prepare(
    `UPDATE stage_objects SET ${sets.join(', ')} WHERE id = ? AND project_id = ?`
  ).bind(...values).run();
  if (!result.meta.changes) return jsonResp({ error: 'Not found' }, 404);

  // 只有有意義的 meta 變更才寫 activity，避免 transform 拖動 spam
  const META_KEYS = ['displayName', 'category', 'locked', 'materialProps', 'ledProps'];
  const hasMeta = META_KEYS.some(k => k in body);
  if (hasMeta) {
    const meta = {};
    for (const k of META_KEYS) if (k in body) meta[k] = body[k];
    await logActivity(request, env, projectId, 'update', 'stage_object', objId, {
      name: before?.display_name || before?.mesh_name,
      changes: meta,
    });
  }
  return jsonResp({ ok: true });
}

async function deleteStageObject(request, env, projectId, objId) {
  const before = await env.DB.prepare(
    `SELECT display_name, mesh_name FROM stage_objects WHERE id = ? LIMIT 1`
  ).bind(objId).first();
  const result = await env.DB.prepare(
    `DELETE FROM stage_objects WHERE id = ? AND project_id = ?`
  ).bind(objId, projectId).run();
  if (!result.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  await logActivity(request, env, projectId, 'delete', 'stage_object', objId, {
    name: before?.display_name || before?.mesh_name,
  });
  return jsonResp({ ok: true });
}

// ─────────────────────────────────────────────
// Model file (R2) — upload & retrieve
// PUT /api/projects/:id/model         body: binary glb（直接 raw bytes）
// GET /api/projects/:id/model         → 回模型 metadata（r2 key、大小）
// GET /r2/models/:projectId/:key      → 串流真檔
// ─────────────────────────────────────────────

const MAX_MODEL_SIZE = 100 * 1024 * 1024; // 100 MB

async function handleModel(request, env, projectId, subAction, subAction2) {
  if (!env.MODELS) return jsonResp({ error: 'R2 not configured' }, 500);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) return jsonResp({ error: 'Invalid project id' }, 400);

  // 子路徑：/model/use-asset
  if (subAction === 'use-asset') {
    if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405);
    return useSharedAssetForProject(request, env, projectId);
  }

  // 子路徑：/model/versions, /model/versions/activate, /model/versions/:ts
  if (subAction === 'versions') {
    if (!subAction2) {
      if (request.method === 'GET') return listModelVersions(env, projectId);
      return jsonResp({ error: 'Method not allowed' }, 405);
    }
    if (subAction2 === 'activate') {
      if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405);
      return activateModelVersion(request, env, projectId);
    }
    // /model/versions/:tsFile  → DELETE 一個舊版本（不能刪 active）
    if (request.method === 'DELETE') return deleteModelVersion(request, env, projectId, subAction2);
    return jsonResp({ error: 'Method not allowed' }, 405);
  }

  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      `SELECT model_r2_key FROM projects WHERE id = ? LIMIT 1`
    ).bind(projectId).first();
    if (!row?.model_r2_key) return jsonResp({ model: null });
    const obj = await env.MODELS.head(row.model_r2_key);
    return jsonResp({
      model: {
        key: row.model_r2_key,
        url: `/r2/${row.model_r2_key}`,
        size: obj?.size || 0,
        uploaded: obj?.uploaded?.toISOString?.() || null,
      },
    });
  }

  if (request.method === 'PUT') {
    const ct = request.headers.get('content-type') || '';
    if (!ct.includes('model/gltf-binary') && !ct.includes('application/octet-stream')) {
      return jsonResp({ error: 'Content-Type must be model/gltf-binary or application/octet-stream' }, 400);
    }
    const cl = parseInt(request.headers.get('content-length') || '0', 10);
    if (cl > MAX_MODEL_SIZE) {
      return jsonResp({ error: `File too large (max ${MAX_MODEL_SIZE / 1024 / 1024} MB)` }, 413);
    }

    // 每次上傳一個新檔（保留版本紀錄）：models/<專案>/<時間>-<128 bits 隨機>.glb（modelKeys.mjs；網址不用登入就能讀，所以要猜不到）
    const key = newProjectModelKey(projectId);

    // 把 body 直接串到 R2
    await env.MODELS.put(key, request.body, {
      httpMetadata: { contentType: 'model/gltf-binary' },
      customMetadata: { projectId, uploadedAt: new Date().toISOString() },
    });

    // ?hold=1（自動貼 UV）：只放進 R2、先不換成目前使用的版本；前端檢查完再用 POST /led-uv/apply 一次換好
    if (new URL(request.url).searchParams.get('hold') === '1') {
      await logActivity(request, env, projectId, 'upload', 'model', key, { key, sizeBytes: cl, held: true });
      return jsonResp({ ok: true, key, url: `/r2/${key}`, held: true });
    }

    // 更新 project.model_r2_key
    const before = await env.DB.prepare(`SELECT model_r2_key FROM projects WHERE id = ? LIMIT 1`).bind(projectId).first();
    await env.DB.prepare(
      `UPDATE projects SET model_r2_key = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(key, projectId).run();
    // 上一版有自動貼 UV / 畫布的紀錄 → 這一版沿用（例如壓縮模型），換版本時畫布和舊影片才不會亂
    try { await uvLayouts.inheritLayoutOnUpload(env, projectId, before?.model_r2_key || null, key, await getRequestUserId(request, env)); }
    catch (e) { console.warn('inheritLayoutOnUpload failed', e?.message || e); }

    await logActivity(request, env, projectId, 'upload', 'model', key, { key, sizeBytes: cl });
    return jsonResp({ ok: true, key, url: `/r2/${key}` });
  }

  return jsonResp({ error: 'Method not allowed' }, 405);
}

// 切換 project 的 model 到某個共用資產
async function useSharedAssetForProject(request, env, projectId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const assetId = (body?.assetId || '').toString();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(assetId)) return jsonResp({ error: 'Invalid assetId' }, 400);

  const a = await env.DB.prepare(
    `SELECT id, r2_key, name FROM shared_assets WHERE id = ? AND deactivated = 0 LIMIT 1`
  ).bind(assetId).first();
  if (!a) return jsonResp({ error: 'Asset 不存在或已停用' }, 404);

  // 確認 R2 上有檔案（避免設成空 key 卡 viewport）
  const head = await env.MODELS.head(a.r2_key);
  if (!head) return jsonResp({ error: 'Asset 還沒上傳檔案，請先上傳 .glb 後再使用' }, 400);

  // 換回自動貼 UV 以前用的模型庫模型時，畫布和舊影片也跟著換回來（沒有紀錄的專案 = 只換模型，跟以前一樣）
  const swapped = await uvLayouts.activateVersion(env, projectId, a.r2_key);

  await logActivity(request, env, projectId, 'activate', 'model', a.r2_key, {
    fromAsset: assetId, assetName: a.name, key: a.r2_key,
  });
  return jsonResp({ ok: true, key: a.r2_key, url: `/r2/${a.r2_key}`, restoredCanvas: swapped.restoredCanvas, ledCanvas: swapped.ledCanvas });
}

// 列某 project 的所有 model 版本（依時間倒序）
async function listModelVersions(env, projectId) {
  const prefix = `models/${projectId}/`;
  const listed = await env.MODELS.list({ prefix });

  // 取得當前 active key（用來標 isActive）
  const row = await env.DB.prepare(
    `SELECT model_r2_key FROM projects WHERE id = ? LIMIT 1`
  ).bind(projectId).first();
  const activeKey = row?.model_r2_key || null;

  // 自動貼 UV：每個版本搭配的畫布、說明（沒有紀錄的版本這幾欄是 null / false）
  let layouts = new Map();
  try { layouts = await uvLayouts.versionInfoMap(env, projectId); } catch (e) { console.warn('versionInfoMap failed', e?.message || e); }

  // 上傳時間用 R2 記的時間（不從檔名解析：舊的「時間.glb」、新的「時間-隨機.glb」都一樣）
  const versions = (listed.objects || []).map(obj => {
    const ts = modelVersionTimestamp(obj);
    const lay = layouts.get(obj.key);
    return {
      key: obj.key,
      url: `/r2/${obj.key}`,
      size: obj.size,
      uploaded: obj.uploaded?.toISOString?.() || null,
      timestamp: ts,
      isActive: obj.key === activeKey,
      note: lay?.note ?? null,
      ledCanvas: lay?.ledCanvas ?? null,
      hasLayout: !!lay?.hasLayout,
      autoUv: !!lay?.autoUv,
    };
  }).sort((a, b) => b.timestamp - a.timestamp);

  return jsonResp({ versions, activeKey });
}

// 切換 active 版本（更新 projects.model_r2_key）
async function activateModelVersion(request, env, projectId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const key = (body?.key || '').toString();
  if (!key.startsWith(`models/${projectId}/`) || !key.endsWith('.glb') || key.includes('..')) {
    return jsonResp({ error: 'Invalid key' }, 400);
  }
  // 確認該 key 真的存在於 R2
  const head = await env.MODELS.head(key);
  if (!head) return jsonResp({ error: 'Version not found in R2' }, 404);

  const beforeRow = await env.DB.prepare(
    `SELECT model_r2_key FROM projects WHERE id = ? LIMIT 1`
  ).bind(projectId).first();

  // 換版本：模型 + 這個版本搭配的 LED 畫布 + 自動貼 UV 時改成用「舊版面」的舊影片，一個交易（modelUvLayouts.mjs）
  const swapped = await uvLayouts.activateVersion(env, projectId, key);

  await logActivity(request, env, projectId, 'activate', 'model', key, {
    fromKey: beforeRow?.model_r2_key,
    toKey: key,
    ...(swapped.restoredCanvas ? { ledCanvas: swapped.ledCanvas } : {}),
  });
  return jsonResp({ ok: true, key, url: `/r2/${key}`, restoredCanvas: swapped.restoredCanvas, ledCanvas: swapped.ledCanvas, objectTypesChanged: !!swapped.objectTypesChanged });
}

// 刪除某舊版本（不能刪當前 active）
async function deleteModelVersion(request, env, projectId, tsFile) {
  if (!isModelVersionFile(tsFile)) return jsonResp({ error: 'Invalid version' }, 400);
  const key = `models/${projectId}/${tsFile}`;
    ...(swapped.objectTypesChanged ? { objectTypesChanged: true } : {}),

  const row = await env.DB.prepare(
    `SELECT model_r2_key FROM projects WHERE id = ? LIMIT 1`
  ).bind(projectId).first();
  if (row?.model_r2_key === key) {
    return jsonResp({ error: '不能刪除當前使用的版本，請先切到別的版本再刪' }, 400);
  }

  await env.MODELS.delete(key);
  try { await uvLayouts.deleteVersionRow(env, projectId, key); } catch (e) { console.warn('deleteVersionRow failed', e?.message || e); }
  await logActivity(request, env, projectId, 'delete', 'model', key, { key });
  return jsonResp({ ok: true });
}

async function handleModelDownload(request, env, url) {
  if (!env.MODELS) return jsonResp({ error: 'R2 not configured' }, 500);

  // url.pathname 形如 /r2/models/<projectId>/<file>.glb 或 /r2/assets/models/<assetId>.glb
  const r2Key = url.pathname.replace(/^\/r2\//, '');
  if (!(r2Key.startsWith('models/') || r2Key.startsWith('assets/')) || r2Key.includes('..')) {
    return jsonResp({ error: 'Invalid key' }, 400);
  }

  // If-None-Match 對上 → 304（大模型不用再下載一次）
  const obj = await env.MODELS.get(r2Key, { onlyIf: request.headers });
  if (!obj) return jsonResp({ error: 'Not found' }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  // 新格式（帶隨機碼）的專案模型寫一次就不會改 → 快取一年；舊的和模型庫照舊 1 小時（modelKeys.mjs）
  headers.set('Cache-Control', modelCacheControl(r2Key));
  if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
  Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));

  if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers });
  return new Response(obj.body, { status: 200, headers });
}

// Bulk create stage_objects（GLB 解析後一次匯入）
async function bulkCreateStageObjects(request, env, projectId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }

  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || !items.length) return jsonResp({ error: 'items required' }, 400);
  if (items.length > 200) return jsonResp({ error: 'too many items (max 200)' }, 400);

  // replace = true：先清掉專案所有舊物件 → 每首歌每個 cue 裡這些物件的位置也會一起刪掉（資料庫 cascade）
  // 這很傷 → 前端一定要再帶 confirmReplace: true 才做；沒帶就回 409 + 會刪掉多少東西，給畫面問使用者
  const replace = !!body?.replace;
  let deleted = null;
  if (replace) {
    const [objN, stateN, cueN] = await env.DB.batch([
      env.DB.prepare(`SELECT COUNT(*) AS n FROM stage_objects WHERE project_id = ?`).bind(projectId),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM cue_object_states cos JOIN stage_objects o ON o.id = cos.stage_object_id WHERE o.project_id = ?`).bind(projectId),
      env.DB.prepare(`SELECT COUNT(DISTINCT cos.cue_id) AS n FROM cue_object_states cos JOIN stage_objects o ON o.id = cos.stage_object_id WHERE o.project_id = ?`).bind(projectId),
    ]);
    const willDelete = {
      stageObjects: objN.results?.[0]?.n || 0,
      cueStates: stateN.results?.[0]?.n || 0,
      cuesAffected: cueN.results?.[0]?.n || 0,
      // 機關裡選的物件也會被清掉（機關的設定和每個 cue 的位置留著，之後重新選物件）
      mechanismObjects: await mech.countMechanismObjects(env, projectId),
    };
    const mechNote = willDelete.mechanismObjects > 0 ? `，也會清掉 ${willDelete.mechanismObjects} 個機關裡選的物件` : '';
    if (body?.confirmReplace !== true) {
      return jsonResp({
        error: willDelete.cueStates > 0
          ? `清除現有物件會一起刪掉 ${willDelete.cuesAffected} 個 cue 裡的 ${willDelete.cueStates} 筆物件位置${mechNote}，而且不能復原。確定要清除的話請再確認一次。`
          : `清除現有物件會刪掉 ${willDelete.stageObjects} 個物件${mechNote}。確定要清除的話請再確認一次。`,
        requiresConfirmation: true,
        willDelete,
      }, 409);
    }
    await env.DB.prepare(`DELETE FROM stage_objects WHERE project_id = ?`).bind(projectId).run();
    deleted = willDelete;
  }

  const maxRow = await env.DB.prepare(
    `SELECT COALESCE(MAX("order"), -1) AS max_order FROM stage_objects WHERE project_id = ?`
  ).bind(projectId).first();
  let order = (maxRow?.max_order ?? -1) + 1;

  const stmts = [];
  let inserted = 0, skipped = 0;
  for (const it of items) {
    const meshName = (it?.meshName || '').toString().trim().slice(0, 80);
    if (!meshName) { skipped++; continue; }
    const category = STAGE_OBJ_CATEGORIES.includes(it?.category) ? it.category : 'other';
    const displayName = (it?.displayName || '').toString().slice(0, 80) || null;
    const defaultPosition = JSON.stringify(it?.defaultPosition || { x: 0, y: 0, z: 0 });
    const defaultRotation = JSON.stringify(it?.defaultRotation || { pitch: 0, yaw: 0, roll: 0 });
    const defaultScale = JSON.stringify(it?.defaultScale || { x: 1, y: 1, z: 1 });
    const id = 'so_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + (order % 1000);

    stmts.push(env.DB.prepare(`
      INSERT OR IGNORE INTO stage_objects
        (id, project_id, mesh_name, display_name, category, "order",
         default_position, default_rotation, default_scale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, projectId, meshName, displayName, category, order,
            defaultPosition, defaultRotation, defaultScale));
    order += 1;
    inserted += 1;
  }

  await env.DB.batch(stmts);
  await logActivity(request, env, projectId, 'bulk_create', 'stage_object', null, { inserted, skipped, replace, ...(deleted ? { deleted } : {}) });
  return jsonResp({ ok: true, inserted, skipped, ...(deleted ? { deleted } : {}) });
}

const DEFAULT_STAGE_OBJECTS = [
  { meshName: 'SKY',         displayName: '天幕 LED',  category: 'led_panel'  },
  { meshName: 'LED-1',       displayName: '主牆 LED-1', category: 'led_panel' },
  { meshName: 'LED-2',       displayName: '主牆 LED-2', category: 'led_panel' },
  { meshName: 'LED-3',       displayName: '主牆 LED-3', category: 'led_panel' },
  { meshName: 'LED-4',       displayName: '主牆 LED-4', category: 'led_panel' },
  { meshName: 'LED-樂手',     displayName: '樂手 LED',   category: 'led_panel' },
  { meshName: '旋轉舞臺',     displayName: '旋轉舞臺',   category: 'mechanism' },
  { meshName: '升降台-中',    displayName: '中央升降台', category: 'mechanism' },
  { meshName: '走位-FOH',    displayName: '走位 - FOH',  category: 'walk_point' },
  { meshName: '走位-中',      displayName: '走位 - 中',   category: 'walk_point' },
];

async function seedDefaultStageObjects(request, env, projectId) {
  // 檢查專案存在
  const p = await env.DB.prepare(`SELECT id FROM projects WHERE id = ? LIMIT 1`).bind(projectId).first();
  if (!p) return jsonResp({ error: 'Project not found' }, 404);

  const maxRow = await env.DB.prepare(
    `SELECT COALESCE(MAX("order"), -1) AS max_order FROM stage_objects WHERE project_id = ?`
  ).bind(projectId).first();
  let order = (maxRow?.max_order ?? -1) + 1;

  let inserted = 0;
  const stmts = [];
  for (const def of DEFAULT_STAGE_OBJECTS) {
    const id = 'so_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + order;
    stmts.push(env.DB.prepare(`
      INSERT OR IGNORE INTO stage_objects (id, project_id, mesh_name, display_name, category, "order",
        default_position, default_rotation, default_scale)
      VALUES (?, ?, ?, ?, ?, ?,
        '{"x":0,"y":0,"z":0}', '{"pitch":0,"yaw":0,"roll":0}', '{"x":1,"y":1,"z":1}')
    `).bind(id, projectId, def.meshName, def.displayName, def.category, order));
    order += 1;
    inserted += 1;
  }
  await env.DB.batch(stmts);
  await logActivity(request, env, projectId, 'seed', 'stage_object', null, { inserted });
  return jsonResp({ ok: true, inserted });
}

// ─────────────────────────────────────────────
// Cue Object States API
// GET    /api/projects/:id/songs/:songId/cues/:cueId/states
//        → 含每個 stage_object 的「當前 cue 狀態（如有覆蓋）+ default」
// PUT    /api/projects/:id/songs/:songId/cues/:cueId/states/:objId
//        body: {position?, rotation?, scale?, visible?, customProps?}
//        → upsert override
// DELETE /api/projects/:id/songs/:songId/cues/:cueId/states/:objId
//        → 重置為 default（刪除 row）
// ─────────────────────────────────────────────

// 某個 cue 時每個物件在哪裡。管理頁 / 導演頁 / 動畫師工作站和分享連結都用這一個（計算在 cueStates.mjs）
//   → 分享連結看到的位置跟導演看到的一模一樣（包含「沒改的物件沿用前面 cue 的位置」）
// 呼叫的人要先確認 cueId 屬於 projectId
async function loadCueStates(env, projectId, cueId) {
  const [objR, earlierR] = await env.DB.batch([
    // 每個物件 + 這個 cue 自己的設定
    env.DB.prepare(`
      SELECT
        o.id            AS object_id,
        o.mesh_name,
        o.display_name,
        o.category,
        o."order"       AS object_order,
        o.default_position,
        o.default_rotation,
        o.default_scale,
        o.locked        AS object_locked,
        cos.position    AS state_position,
        cos.rotation    AS state_rotation,
        cos.scale       AS state_scale,
        cos.visible     AS state_visible,
        cos.custom_props AS state_custom,
        cos.updated_at  AS state_updated_at
      FROM stage_objects o
      LEFT JOIN cue_object_states cos
        ON cos.stage_object_id = o.id AND cos.cue_id = ?
      WHERE o.project_id = ?
      ORDER BY o."order" ASC, o.created_at ASC
    `).bind(cueId, projectId),
    // 同一首歌、順序在這個 cue 前面的 cue 的設定（tracking：沒改的物件沿用前面最近一次的設定）
    env.DB.prepare(`
      SELECT cos.stage_object_id, cos.position, cos.rotation, cos.scale, cos.visible, c."order" AS cue_order
        FROM cue_object_states cos
        JOIN cues c ON cos.cue_id = c.id
        JOIN songs s ON s.id = c.song_id
       WHERE s.project_id = ?
         AND c.song_id = (SELECT song_id FROM cues WHERE id = ?)
         AND c."order" < (SELECT "order" FROM cues WHERE id = ?)
       ORDER BY c."order" ASC
    `).bind(projectId, cueId, cueId),
  ]);
  return buildCueStates(objR.results || [], earlierR.results || []);
}

async function listCueStates(env, projectId, cueId) {
  return jsonResp({ states: await loadCueStates(env, projectId, cueId) });
}

async function upsertCueState(request, env, cueId, objId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }

  // 看 row 是否已存在
  const existing = await env.DB.prepare(
    `SELECT id FROM cue_object_states WHERE cue_id = ? AND stage_object_id = ?`
  ).bind(cueId, objId).first();

  const position = 'position' in body ? JSON.stringify(body.position) : (existing ? null : null);
  const rotation = 'rotation' in body ? JSON.stringify(body.rotation) : null;
  const scale    = 'scale' in body    ? JSON.stringify(body.scale)    : null;
  const visible  = 'visible' in body  ? (body.visible ? 1 : 0)        : null;
  const custom   = 'customProps' in body ? JSON.stringify(body.customProps) : null;

  if (existing) {
    // PATCH-style merge
    const sets = [], values = [];
    if ('position' in body)    { sets.push('position = ?');    values.push(position); }
    if ('rotation' in body)    { sets.push('rotation = ?');    values.push(rotation); }
    if ('scale' in body)       { sets.push('scale = ?');       values.push(scale); }
    if ('visible' in body)     { sets.push('visible = ?');     values.push(visible); }
    if ('customProps' in body) { sets.push('custom_props = ?'); values.push(custom); }
    if (!sets.length) return jsonResp({ ok: true, noop: true });
    sets.push(`updated_at = datetime('now')`);
    values.push(existing.id);
    await env.DB.prepare(`UPDATE cue_object_states SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
    return jsonResp({ ok: true, id: existing.id });
  }

  // 新增
  const id = 'cos_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  await env.DB.prepare(`
    INSERT INTO cue_object_states (id, cue_id, stage_object_id, position, rotation, scale, visible, custom_props)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(id, cueId, objId, position, rotation, scale, visible, custom).run();
  return jsonResp({ ok: true, id }, 201);
}

async function deleteCueState(request, env, projectId, cueId, objId) {
  const before = await env.DB.prepare(`
    SELECT c.name AS cue_name, o.display_name, o.mesh_name
    FROM cues c, stage_objects o
    WHERE c.id = ? AND o.id = ? LIMIT 1
  `).bind(cueId, objId).first();
  const result = await env.DB.prepare(
    `DELETE FROM cue_object_states WHERE cue_id = ? AND stage_object_id = ?`
  ).bind(cueId, objId).run();
  if (result.meta.changes > 0) {
    await logActivity(request, env, projectId, 'reset', 'cue_state', cueId, {
      cueName: before?.cue_name,
      objectName: before?.display_name || before?.mesh_name,
    });
  }
  return jsonResp({ ok: true, removed: result.meta.changes });
}

// ─────────────────────────────────────────────
// Comments API — /api/comments?session=<projectId>-<songId>（一首歌一串，session 規則見 access.mjs commentSessionFor）
//   GET                                → { comments: [...] }
//   POST   body: { comment: {..., videoId?, parentId?} } → 新增一則 / 回覆；作者 = 登入的人（不信前端送的名字 / 身分）
//   PATCH  body: { id, text?, status?, resolvedVideoId? } → 改文字：留言的人或 admin；已改好 / 重新打開：見 access.mjs
//   DELETE ?id=<留言 id>                → 留言的人或 admin（底下的回覆一起刪）
// 審片 v2（綁版本、回覆、已改好（V3）、通知）的寫入在 reviews.mjs；舊版前端不帶新欄位照樣能用。
// 都要登入，而且要是這個專案的成員（或 admin）；分享連結的訪客碰不到。回傳都是整串最新的留言。
// 存在 D1 comments 表（一則一列，同時留言不會互相蓋掉）；格式見 comments.mjs。
// ─────────────────────────────────────────────

async function handleComments(request, env, url) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '請先登入' }, 401);

  const session = url.searchParams.get('session');
  if (!session || !SESSION_ID_RE.test(session)) {
    return jsonResp({ error: 'Missing or invalid session' }, 400);
  }

  try {
    const thread = await resolveCommentThread(env, me, session);
    if (!thread) {
      // 對不到任何一首歌 = 舊版單頁工具的留言串（還存在 KV）→ 只有 admin 能看 / 管
      if (me.role !== 'admin') return jsonResp({ error: '沒有權限看這個留言串' }, 403);
      return await handleLegacyKvComments(request, env, url, session);
    }
    if (thread.archived && me.role !== 'admin') return jsonResp({ error: '找不到這個專案（可能已封存）' }, 404);
    if (!thread.role) return jsonResp({ error: '沒有權限存取此專案' }, 403);
    const isRead = request.method === 'GET' || request.method === 'HEAD';
    if (thread.archived && !isRead) return jsonResp({ error: '這個專案已封存，請先還原再修改' }, 409);

    if (request.method === 'GET') {
      return jsonResp({ comments: await listThreadComments(env, thread.songId) });
    }
    // 發 / 回覆 / 改 / 刪：規則和寫入在 reviews.mjs（權限在 access.mjs）
    if (request.method === 'POST' || request.method === 'PATCH') {
      // 留言 + 縮圖（約 480 px 的 JPEG）+ 畫記 → 最多 400 KB
      const body = await readJsonLimited(request, guest.GUEST_BODY_MAX_BYTES);
      if (body.error) return jsonResp({ error: body.error }, body.status);
      return await reviewsResp(request.method === 'POST'
        ? reviews.postComment(env.DB, { me, thread, body: body.value, r2: env.MODELS || null })
        : reviews.patchComment(env.DB, { me, thread, body: body.value, r2: env.MODELS || null }));
    }
    if (request.method === 'DELETE') {
      return await reviewsResp(reviews.deleteComment(env.DB, { me, thread, id: url.searchParams.get('id'), r2: env.MODELS || null }));
    }
    return jsonResp({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

// session id → 哪個專案的哪首歌 + 我在那個專案的角色；對不到回 null
async function resolveCommentThread(env, me, session) {
  const base = `SELECT s.id AS song_id, s.project_id, p.status AS project_status, pm.role AS member_role
                  FROM songs s
                  JOIN projects p ON p.id = s.project_id
                  LEFT JOIN project_members pm ON pm.project_id = s.project_id AND pm.user_id = ?`;
  let list = [];
  const guess = parseCommentSession(session);
  if (guess) {
    list = (await env.DB.prepare(`${base} WHERE s.id = ? AND s.project_id = ? LIMIT 1`)
      .bind(me.id, guess.songId, guess.projectId).all()).results || [];
  }
  if (!list.length) {
    // id 很長被截斷過 → 整張歌曲表比對（歌曲數不多）
    list = (await env.DB.prepare(`${base} WHERE substr(s.project_id, 1, 28) || '-' || substr(s.id, 1, 28) = ? LIMIT 5`)
      .bind(me.id, session).all()).results || [];
    list = list.filter(r => commentSessionFor(r.project_id, r.song_id) === session);
  }
  if (!list.length) return null;
  const pick = list.find(r => projectRoleOf(me.role, r.member_role)) || list[0];
  return {
    projectId: pick.project_id,
    songId: pick.song_id,
    archived: pick.project_status === 'archived',
    role: projectRoleOf(me.role, pick.member_role),
  };
}

// GET /api/projects/:id/comments/summary — 每首歌幾則留言、最新一則（工作站一次拿全部算未讀，不用一首一首抓）
//   沒有留言的歌也列（count 0）；「別人留的」= 不是我留的（舊資料沒記作者 id 的也算別人）
async function commentsSummary(env, ctx) {
  const r = await env.DB.prepare(`
    SELECT s.id AS song_id,
           COUNT(c.id) AS count,
           SUM(CASE WHEN c.status = 'open' THEN 1 ELSE 0 END) AS open_count,
           MAX(c.created_at) AS latest_at,
           (SELECT c2.id FROM comments c2 WHERE c2.song_id = s.id
             ORDER BY c2.created_at DESC, c2.rowid DESC LIMIT 1) AS latest_id,
           SUM(CASE WHEN c.id IS NOT NULL AND (c.author_user_id IS NULL OR c.author_user_id != ?) THEN 1 ELSE 0 END) AS others_count,
           MAX(CASE WHEN c.author_user_id IS NULL OR c.author_user_id != ? THEN c.created_at END) AS others_latest_at
      FROM songs s
      LEFT JOIN comments c ON c.song_id = s.id
     WHERE s.project_id = ?
     GROUP BY s.id
     ORDER BY s."order", s.created_at
  `).bind(ctx.me.id, ctx.me.id, ctx.projectId).all();
  return jsonResp({ songs: (r.results || []).map(commentSummaryRow), generatedAt: new Date().toISOString() });
}

async function listThreadComments(env, songId) {
  return reviews.listSongComments(env.DB, songId);   // 含參考圖片（0028）
}

// /api/comment-attachments?session=…（0028）：POST 上傳一張（multipart file + thumb）、DELETE &id= 拿掉還沒送出的
//   誰可以：跟發留言一樣（commentAttachments.mjs）；登入、成員、封存檢查跟 /api/comments 一樣
async function handleCommentAttachments(request, env, url) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '請先登入' }, 401);
  const session = url.searchParams.get('session');
  if (!session || !SESSION_ID_RE.test(session)) return jsonResp({ error: 'Missing or invalid session' }, 400);
  try {
    const thread = await resolveCommentThread(env, me, session);
    if (!thread) return jsonResp({ error: '找不到這首歌' }, 404);
    if (thread.archived && me.role !== 'admin') return jsonResp({ error: '找不到這個專案（可能已封存）' }, 404);
    if (!thread.role) return jsonResp({ error: '沒有權限存取此專案' }, 403);
    if (thread.archived) return jsonResp({ error: '這個專案已封存，請先還原再修改' }, 409);
    if (request.method === 'POST') {
      return await reviewsResp(attachments.uploadMemberAttachment(env.DB, env.MODELS || null, { me, thread, request }));
    }
    if (request.method === 'DELETE') {
      return await reviewsResp(attachments.discardMemberAttachment(env.DB, env.MODELS || null, { me, thread, id: url.searchParams.get('id') }));
    }
    return jsonResp({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

// reviews.mjs 的結果（{ status, body }）→ Response
async function reviewsResp(promise) {
  const r = await promise;
  return jsonResp(r.body, r.status);
}

// 讀 JSON body，太大就擋（留言含縮圖最多幾百 KB）
async function readJsonLimited(request, maxBytes) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) return { status: 413, error: '送出的內容太大了' };
  let text;
  try { text = await request.text(); } catch { return { status: 400, error: 'Invalid JSON' }; }
  if (text.length > maxBytes) return { status: 413, error: '送出的內容太大了' };
  try { return { value: JSON.parse(text) }; } catch { return { status: 400, error: 'Invalid JSON' }; }
}

// GET /api/comment-thumbs/<專案>/<留言>-<隨機碼>.jpg — 留言縮圖（R2；網址有 128 bits 隨機碼，跟模型檔一樣不用登入）
async function handleCommentThumb(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return jsonResp({ error: 'Method not allowed' }, 405);
  if (!env.MODELS) return jsonResp({ error: 'R2 not configured' }, 500);
  const key = thumbKeyFromPath(url.pathname);
  if (!key) return jsonResp({ error: 'Not found' }, 404);
  const obj = await env.MODELS.get(key, { onlyIf: request.headers });
  if (!obj) return jsonResp({ error: 'Not found' }, 404);
  const headers = new Headers(corsHeaders());
  headers.set('Content-Type', 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
  if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : obj.body, { status: 200, headers });
}

// ─────────────────────────────────────────────
// 站內通知 /api/notifications（只看自己的；寫入在事情發生的當下，見 reviews.mjs）
//   GET                → { items: [...最新的在前], unreadCount, generatedAt }
//   POST /read         body: { ids: [...] } 或 { all: true } → { ok, unreadCount }
// ─────────────────────────────────────────────

async function handleNotifications(request, env, url) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '請先登入' }, 401);
  const route = describeNotificationRoute(request.method, url.pathname.split('/').filter(Boolean));
  if (!route) return jsonResp({ error: 'Not found' }, 404);
  if (route.methodNotAllowed) return jsonResp({ error: 'Method not allowed' }, 405);
  try {
    if (route.kind === 'notifications.list') {
      return await reviewsResp(reviews.listNotifications(env.DB, me, { limit: url.searchParams.get('limit') || 30 }));
    }
    let body;
    try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
    return await reviewsResp(reviews.markNotificationsRead(env.DB, me, body));
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

// 舊版單頁工具的留言（存在 KV，key = s:<session>）— 只有 admin 走到這裡
async function handleLegacyKvComments(request, env, url, session) {
  if (!env.COMMENTS) return jsonResp({ error: 'KV not configured' }, 500);
  const key = `s:${session}`;

  if (request.method === 'GET') {
    const data = await env.COMMENTS.get(key);
    const comments = data ? JSON.parse(data) : [];
    return jsonResp({ comments });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
    const c = sanitizeComment(body && body.comment);
    if (!c) return jsonResp({ error: 'Invalid comment' }, 400);
    const existing = await env.COMMENTS.get(key);
    const list = existing ? JSON.parse(existing) : [];
    if (list.length >= MAX_COMMENTS_PER_SESSION) return jsonResp({ error: 'Session comment limit reached' }, 429);
    if (list.some(x => x.id === c.id)) return jsonResp({ ok: true, duplicate: true, comments: list });
    list.push(c);
    await env.COMMENTS.put(key, JSON.stringify(list));
    return jsonResp({ ok: true, comments: list });
  }

  if (request.method === 'PATCH') {
    let body;
    try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
    const id = (body && typeof body.id === 'string') ? body.id : null;
    if (!id || !COMMENT_ID_RE.test(id)) return jsonResp({ error: 'Missing or invalid id' }, 400);
    const existing = await env.COMMENTS.get(key);
    if (!existing) return jsonResp({ error: 'Not found' }, 404);
    const list = JSON.parse(existing);
    const idx = list.findIndex(x => x.id === id);
    if (idx < 0) return jsonResp({ error: 'Not found' }, 404);
    const patched = { ...list[idx] };
    for (const k of ['status', 'text', 'resolvedBy', 'resolvedAt']) if (k in body) patched[k] = body[k];
    const safe = sanitizeComment(patched);
    if (!safe) return jsonResp({ error: 'Invalid patched comment' }, 400);
    list[idx] = safe;
    await env.COMMENTS.put(key, JSON.stringify(list));
    return jsonResp({ ok: true, comments: list });
  }

  if (request.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id || !COMMENT_ID_RE.test(id)) return jsonResp({ error: 'Missing or invalid id' }, 400);
    const existing = await env.COMMENTS.get(key);
    if (!existing) return jsonResp({ ok: true, comments: [] });
    const list = JSON.parse(existing).filter(x => x.id !== id);
    await env.COMMENTS.put(key, JSON.stringify(list));
    return jsonResp({ ok: true, comments: list });
  }

  return jsonResp({ error: 'Method not allowed' }, 405);
}

// ─────────────────────────────────────────────
// GDrive Proxy（原本邏輯 + 友善 quota 錯誤訊息）
//
// 以前誰都能用（網址 /?id=<Drive 檔案>，任何公開的 Drive 檔都能透過我們轉）→ 等於幫全世界免費轉檔，
// 用量一多，Cloudflare 每天的請求額度用完，整個後台（含登入）都會停。
// 現在只給登入的人用（瀏覽器的登入 cookie 或 Authorization header）。
// 新版 / 舊版（0d6df54）前端都不用這個網址：成員看影片走 /api/drive/stream/:id、/api/videos/:id/stream，
// 分享連結走 /api/share/:token/...（都已經各自檢查成員 / 分享通行證）。只有最早的單頁工具（index.html）還在用。
// ─────────────────────────────────────────────

async function handleDriveProxy(request, env, url) {
  const me = await getCurrentUser(request, env);
  if (!me) {
    return jsonResp({ error: '要先登入才能用這個網址播放 Drive 影片', code: 'LOGIN_REQUIRED' }, 401);
  }
  const fileId = url.searchParams.get('id');
  if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) {
    return jsonResp({ error: 'Missing or invalid id parameter' }, 400);
  }

  try {
    const directURL = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
    let resp = await fetch(directURL, {
      headers: forwardHeaders(request)
    });

    const contentType = resp.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      const html = await resp.text();
      // 明確處理 quota exceeded（download endpoint 對熱門檔案會擋）
      if (/Quota exceeded|Too many users have viewed/.test(html)) {
        return jsonResp({
          error: 'Drive 對這支影片下載已限流（24h trailing quota）。請在 Drive 右鍵「製作副本」拿新連結，副本配額從零起算。',
          code: 'DRIVE_QUOTA_EXCEEDED'
        }, 429);
      }
      const tokens = parseConfirmTokens(html);
      if (!tokens) return jsonResp({ error: 'Could not parse Drive confirm tokens' }, 502);

      const tokenURL = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=${tokens.confirm}&uuid=${tokens.uuid}&at=${encodeURIComponent(tokens.at)}`;
      resp = await fetch(tokenURL, { headers: forwardHeaders(request) });
    }

    const headers = new Headers(resp.headers);
    Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
    headers.set('Accept-Ranges', 'bytes');

    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers
    });
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

// 瀏覽器跨網站送出時允許帶的自訂 header：
//   x-share-password — 分享連結的密碼（只在第一次解鎖時送）
//   x-share-access   — 密碼對了以後拿到的短期通行證（之後的請求都用它）
const CORS_ALLOW_HEADERS = 'Range, Content-Type, Authorization, X-Share-Password, X-Share-Access';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Access-Control-Max-Age': '86400'
  };
}

function forwardHeaders(request) {
  const fwd = new Headers();
  const range = request.headers.get('range');
  if (range) fwd.set('Range', range);
  fwd.set('User-Agent', 'Mozilla/5.0 (compatible; StagePrevizProxy/1.0)');
  return fwd;
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' }
  });
}

// ─────────────────────────────────────────────
// Auth — 共享密碼系統（admin 後台發放密碼）
// ─────────────────────────────────────────────

const SESSION_COOKIE = 'sp_session';
// SESSION_TTL_SEC（90 天）在 sessions.mjs：登入是什麼時候發的用「到期時間 − 90 天」倒推，不要改
const SETUP_TOKEN_TTL = 600; // setup token 10 分鐘

function getAuthSecret(env) {
  return env.AUTH_SECRET || 'dev-only-secret-change-me';
}

async function hmacSign(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return base64UrlEncode(new Uint8Array(sig));
}

function base64UrlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToBase64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 登入碼現在怎麼存（loginCodes.mjs）：app_settings 有 login_code_storage = 'hashed' → 雜湊；沒有 → 明文（跟以前一樣）
// 還沒跑 0022 migration（沒有 app_settings 表）→ 明文；其他資料庫錯誤照樣丟出去（不要因為一時讀不到就當成明文，害大家登不進去）
async function getLoginCodeMode(env) {
  try {
    const r = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = ? LIMIT 1`).bind(LOGIN_CODE_STORAGE_KEY).first();
    return loginCodeStorageMode(r?.value);
  } catch (e) {
    if (/no such table/i.test(String(e?.message || e))) return 'plain';
    throw e;
  }
}

// issuedSec：這個登入算哪一秒發的（sessions.mjs sessionIssueSec：不早於這個人的失效時間點）
async function newSessionToken(secret, userId, issuedSec = Math.floor(Date.now() / 1000)) {
  const exp = issuedSec + SESSION_TTL_SEC;
  const data = `${userId}.${exp}`;
  const sig = await hmacSign(secret, data);
  return `${data}.${sig}`;
}

async function verifySessionToken(secret, token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts;
  const exp = parseInt(expStr, 10);
  if (!exp || exp < Math.floor(Date.now() / 1000)) return null;
  const expectedSig = await hmacSign(secret, `${userId}.${expStr}`);
  if (!timingSafeEqualStr(sig, expectedSig)) return null;
  return userId;
}

function parseCookies(request) {
  const header = request.headers.get('cookie') || '';
  const map = {};
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k) map[k] = rest.join('=');
  }
  return map;
}

// 同一個請求只查一次登入身分（router、handler、活動紀錄都會問）
const requestUserCache = new WeakMap();

async function getRequestUserId(request, env) {
  const u = await getCurrentUser(request, env);
  return u ? u.id : null;
}

function getCurrentUser(request, env) {
  if (!request || typeof request !== 'object') return Promise.resolve(null);
  let p = requestUserCache.get(request);
  if (!p) {
    p = loadRequestUser(request, env);
    requestUserCache.set(request, p);
  }
  return p;
}

async function loadRequestUser(request, env) {
  if (!env.DB) return null;
  // 優先讀 Authorization: Bearer <token>（避開 third-party cookie 限制）
  let token = null;
  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    token = auth.slice(7).trim();
  }
  // fallback：cookie（<video src> 這種帶不了 header 的請求靠它）
  // 別人的網站帶著 cookie 打過來（瀏覽器會附上 Origin）→ 不認，防止冒用登入身分改資料
  if (!token) {
    const origin = request.headers.get('origin');
    if (origin && !isTrustedOrigin(origin)) return null;
    const cookies = parseCookies(request);
    token = cookies[SESSION_COOKIE] || null;
  }
  if (!token) return null;
  const userId = await verifySessionToken(getAuthSecret(env), token);
  if (!userId) return null;
  // 確認該 user 仍然 active（停用的帳號 token 立刻失效）
  // 重設登入碼 / 停用過 → 那個時間點以前發的登入不算（sessions.mjs；製作改自己時留下自己這一個）
  const u = await loadSessionUserRow(env, userId);
  if (!u) return null;
  const allowed = await sessionAllowed(
    { issuedAtSec: sessionIssuedAtSec(sessionTokenExp(token)) },
    { revokedAt: u.sessions_revoked_at, keepHash: u.session_keep_hash },
    () => sessionTokenHash(token),
  );
  if (!allowed) return null;
  requestSessionTokens.set(request, token);
  return { id: u.id, name: u.name, role: u.role, avatarColor: u.avatar_color };
}

// 這個請求用的登入字串（製作重設自己的登入碼時，要留下這一個）
const requestSessionTokens = new WeakMap();

// 還沒跑 0025 migration（沒有 sessions_revoked_at 欄位）→ 照舊只查基本欄位
async function loadSessionUserRow(env, userId) {
  try {
    return await env.DB.prepare(
      `SELECT id, name, role, avatar_color, sessions_revoked_at, session_keep_hash
         FROM users WHERE id = ? AND deactivated = 0 LIMIT 1`
    ).bind(userId).first();
  } catch (e) {
    if (!/no such column/i.test(String(e?.message || e))) throw e;
    return env.DB.prepare(
      `SELECT id, name, role, avatar_color FROM users WHERE id = ? AND deactivated = 0 LIMIT 1`
    ).bind(userId).first();
  }
}

// 發一個新的登入（登入、用邀請連結進來）：不早於這個人的失效時間點（剛重設完、同一秒內登入也算數）
async function issueSessionToken(env, userId) {
  let revokedAt = null;
  try {
    const r = await env.DB.prepare(`SELECT sessions_revoked_at FROM users WHERE id = ? LIMIT 1`).bind(userId).first();
    revokedAt = r?.sessions_revoked_at ?? null;
  } catch (e) {
    if (!/no such column/i.test(String(e?.message || e))) throw e;
  }
  return newSessionToken(getAuthSecret(env), userId, sessionIssueSec(Date.now(), revokedAt));
}

// 讓這個人之前的登入全部失效要寫的兩個值（製作改自己 → 留下自己現在這一個登入）
async function sessionRevokeColumns(request, me, targetUserId) {
  const token = requestSessionTokens.get(request);
  const actorTokenHash = me && me.id === targetUserId && token ? await sessionTokenHash(token) : null;
  return revokeSessionsUpdate({ nowMs: Date.now(), targetUserId, actorUserId: me?.id, actorTokenHash });
}

function setSessionCookie(token) {
  // SameSite=None 必填：前端在 localhost / stage-previz.vercel.app 等等 cross-site
  // fetch 到 proxy.haimiaan.com，瀏覽器才會送 cookie。SameSite=None 必須配 Secure。
  // （previz.haimiaan.com → proxy.haimiaan.com 是同一個網站，連擋第三方 cookie 的瀏覽器也會送）
  // 哪些網站的請求會被認 cookie：見 getRequestUserId + origins.mjs
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_TTL_SEC}`;
}
function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`;
}

// 加 cookie 到既有的 jsonResp
function jsonRespWithCookie(obj, cookieValue, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json', 'Set-Cookie': cookieValue }
  });
}

// ─── Auth endpoints ───

async function authLogin(request, env) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const code = normalizeLoginCode(body?.accessCode);
  if (!code) return jsonResp({ error: '請輸入登入碼' }, 400);

  // 防猜登入碼：同一個 IP 15 分鐘內錯 10 次 → 鎖 15 分鐘（鎖定中就算登入碼對也擋，也不會算雜湊）
  // 順手清掉一天以前的紀錄
  const ipKey = loginClientKey(request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for'));
  const now = Date.now();
  const [, recentFailures] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM login_attempts WHERE attempted_at < ?`).bind(now - LOGIN_ATTEMPT_KEEP_MS),
    env.DB.prepare(`SELECT attempted_at FROM login_attempts WHERE ip = ? AND attempted_at > ?`)
      .bind(ipKey, now - LOGIN_LOOKBACK_MS),
  ]);
  const gate = loginThrottleDecision((recentFailures.results || []).map(r => r.attempted_at), now);
  if (!gate.allowed) {
    const retryAfterSec = Math.ceil(gate.retryAfterMs / 1000);
    return new Response(JSON.stringify({ error: loginLockedMessage(gate.retryAfterMs), retryAfterSec }), {
      status: 429,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSec) }
    });
  }

  // 明文存法（現在）：跟以前一樣直接比對明文
  // 雜湊存法（上線時切）：算一次雜湊（約 5ms）拿去查；還沒換掉的舊明文也認，對了就換成雜湊、明文清掉
  const mode = await getLoginCodeMode(env);
  let u, codeHash = null;
  if (mode === 'hashed') {
    codeHash = await hashLoginCode(code);
    u = await env.DB.prepare(
      `SELECT id, name, role, avatar_color, deactivated, access_code_hash
         FROM users WHERE access_code_hash = ? OR access_code = ?
        ORDER BY (access_code_hash = ?) DESC LIMIT 1`
    ).bind(codeHash, code, codeHash).first();
  } else {
    u = await env.DB.prepare(
      `SELECT id, name, role, avatar_color, deactivated
         FROM users WHERE access_code = ? LIMIT 1`
    ).bind(code).first();
  }
  if (!u) {
    await env.DB.prepare(`INSERT INTO login_attempts (ip, attempted_at) VALUES (?, ?)`).bind(ipKey, now).run();
    return jsonResp({ error: '登入碼不對，請再確認一次' }, 401);
  }
  if (u.deactivated) return jsonResp({ error: '這個帳號已停用，請聯絡製作' }, 403);

  if (mode === 'hashed' && u.access_code_hash !== codeHash) {
    try {
      await env.DB.prepare(
        `UPDATE users SET access_code_hash = ?, access_code = NULL WHERE id = ? AND access_code = ?`
      ).bind(codeHash, u.id, code).run();
    } catch (e) {
      console.warn('[login] 舊登入碼換成雜湊失敗', e?.message || e);
    }
  }

  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET last_seen_at = datetime('now') WHERE id = ?`).bind(u.id),
    env.DB.prepare(`DELETE FROM login_attempts WHERE ip = ?`).bind(ipKey),  // 登入成功 → 這個 IP 的錯誤歸零
  ]);

  const token = await issueSessionToken(env, u.id);
  return jsonRespWithCookie({
    user: { id: u.id, name: u.name, role: u.role, avatarColor: u.avatar_color },
    token,  // 前端把這個存 localStorage，每個 request 帶 Authorization: Bearer <token>
  }, setSessionCookie(token));
}

function authLogout() {
  return jsonRespWithCookie({ ok: true }, clearSessionCookie());
}

async function authMe(request, env) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);
  // 0038：浮水印上印自己的名字 + email（建用戶時系統塞的假 email 不給；查不到就不帶，舊版前端不看這一欄）
  let email = null;
  try {
    const row = await env.DB.prepare(`SELECT email FROM users WHERE id = ? LIMIT 1`).bind(me.id).first();
    const e = String(row?.email || '').trim();
    if (e && !/@auto\.local$/i.test(e)) email = e;
  } catch { /* 沒有 email 就只印名字 */ }
  return jsonResp({ user: email ? { ...me, email } : me });
}

// ─── Users (admin) CRUD ───

async function handleUsersRouter(request, env, url) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);
  if (me.role !== 'admin') return jsonResp({ error: '只有製作可以管理用戶' }, 403);

  const segs = url.pathname.split('/').filter(Boolean);
  const userId = segs[2] || null;
  const action = segs[3] || null;

  try {
    if (!userId) {
      if (request.method === 'GET') return listUsers(env);
      if (request.method === 'POST') return createUser(request, env);
      return jsonResp({ error: 'Method not allowed' }, 405);
    }
    if (action === 'access-code') {
      if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405);
      return setAccessCode(request, env, userId);
    }
    if (action === 'projects') {
      if (request.method === 'GET') return listUserProjects(env, userId);
      if (request.method === 'POST') return addUserToProject(request, env, userId);
      if (request.method === 'DELETE') return removeUserFromProject(request, env, userId);
      return jsonResp({ error: 'Method not allowed' }, 405);
    }
    if (request.method === 'PATCH') return updateUser(request, env, userId);
    if (request.method === 'DELETE') return deleteUser(env, me.id, userId);
    return jsonResp({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

async function listUsers(env) {
  // 含每人的 project memberships
  // 登入碼：明文存法才回（舊版前端的用戶頁要顯示）；雜湊存法只回「有沒有」（loginCodes.mjs userLoginCodeView）
  const mode = await getLoginCodeMode(env);
  const users = await env.DB.prepare(
    `SELECT id, name, role, avatar_color, access_code, access_code_hash, deactivated, created_at, last_seen_at
       FROM users ORDER BY created_at`
  ).all();
  const memberships = await env.DB.prepare(`
    SELECT pm.user_id, pm.project_id, pm.role, p.name AS project_name
      FROM project_members pm
      JOIN projects p ON pm.project_id = p.id
     WHERE p.status != 'archived'
  `).all();
  const byUser = {};
  for (const m of memberships.results || []) {
    (byUser[m.user_id] = byUser[m.user_id] || []).push({
      projectId: m.project_id, projectName: m.project_name, role: m.role,
    });
  }
  return jsonResp({
    users: (users.results || []).map(u => ({
      id: u.id, name: u.name, role: u.role, avatarColor: u.avatar_color,
      ...userLoginCodeView(u, mode), deactivated: !!u.deactivated,
      createdAt: u.created_at, lastSeenAt: u.last_seen_at,
      projects: byUser[u.id] || [],
    })),
    // 'hashed' = 登入碼只在建立 / 重設時顯示一次
    loginCodeStorage: mode,
  });
}

/**
 * 建立 / 重設時要用的登入碼：
 *   自訂（body.accessCode 有填）→ 只有明文存法收（舊版前端的「自訂」），雜湊存法擋掉
 *   沒填 → 系統產生 10 個字（loginCodes.mjs）
 * @returns {{ok: true, custom: string|null} | {ok: false, status: number, error: string}}
 */
function loginCodeRequest(body, mode) {
  const raw = (body?.accessCode ?? '').toString().trim();
  if (!raw) return { ok: true, custom: null };
  if (mode === 'hashed') return { ok: false, status: 400, error: CUSTOM_CODE_NOT_ALLOWED };
  const d = legacyCustomCodeDecision(raw);
  return d.ok ? { ok: true, custom: d.code } : { ok: false, status: 400, error: d.error };
}

/** 要寫進資料庫的兩個欄位：明文存法 → access_code；雜湊存法 → access_code_hash（明文清掉） */
async function loginCodeColumns(code, mode) {
  if (mode === 'hashed') return { access_code: null, access_code_hash: await hashLoginCode(code) };
  return { access_code: code, access_code_hash: null };
}

async function createUser(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const name = (body?.name || '').toString().trim().slice(0, 80);
  const role = ['admin', 'animator', 'director'].includes(body?.role) ? body.role : 'animator';
  const avatarColor = (body?.avatarColor || '#10c78a').toString().slice(0, 8);
  if (!name) return jsonResp({ error: 'name 必填' }, 400);
  const mode = await getLoginCodeMode(env);
  const req = loginCodeRequest(body, mode);
  if (!req.ok) return jsonResp({ error: req.error }, req.status);

  // 自訂的（只有明文存法）：先檢查重複
  if (req.custom) {
    const exists = await env.DB.prepare(`SELECT id FROM users WHERE access_code = ? LIMIT 1`).bind(req.custom).first();
    if (exists) return jsonResp({ error: '這個登入碼已被使用，請改一個' }, 409);
  }

  const id = 'u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  // email 必填（schema NOT NULL）→ 內部 placeholder
  const placeholderEmail = `${id}@auto.local`;
  let accessCode = null;
  for (let attempt = 0; ; attempt++) {
    const code = req.custom || generateLoginCode();
    const cols = await loginCodeColumns(code, mode);
    try {
      await env.DB.prepare(
        `INSERT INTO users (id, email, name, role, avatar_color, access_code, access_code_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, placeholderEmail, name, role, avatarColor, cols.access_code, cols.access_code_hash).run();
      accessCode = code;
      break;
    } catch (e) {
      if (!isUniqueError(e)) throw e;
      if (req.custom) return jsonResp({ error: '這個登入碼已被使用，請改一個' }, 409);
      if (attempt >= 3) throw e;  // 系統產生的剛好跟別人一樣 → 換一組再試
    }
  }

  // optional: 同時指派 project
  const projectIds = Array.isArray(body?.projectIds) ? body.projectIds : [];
  for (const pid of projectIds) {
    if (typeof pid !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(pid)) continue;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)`
    ).bind(pid, id, role).run();
  }

  // 雜湊存法時這是唯一一次看得到登入碼（shownOnce）
  return jsonResp({ ok: true, id, accessCode, shownOnce: mode === 'hashed' }, 201);
}

async function updateUser(request, env, userId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const sets = [], values = [];
  if ('name' in body) { sets.push('name = ?'); values.push((body.name || '').toString().slice(0, 80)); }
  if ('role' in body && ['admin', 'animator', 'director'].includes(body.role)) {
    sets.push('role = ?'); values.push(body.role);
  }
  if ('avatarColor' in body) { sets.push('avatar_color = ?'); values.push(body.avatarColor); }
  if ('deactivated' in body) {
    // 停用 → 那個人所有裝置的登入失效（重新啟用也不會活回來）；不能停用自己（sessions.mjs）
    const me = await getCurrentUser(request, env);
    const d = deactivateDecision({ targetUserId: userId, actorUserId: me?.id, deactivated: !!body.deactivated });
    if (!d.ok) return jsonResp({ error: d.error }, d.status);
    sets.push('deactivated = ?'); values.push(body.deactivated ? 1 : 0);
    if (d.revoke) {
      const rv = await sessionRevokeColumns(request, me, userId);
      sets.push('sessions_revoked_at = ?', 'session_keep_hash = ?'); values.push(rv.revokedAt, rv.keepHash);
    }
  }
  if (!sets.length) return jsonResp({ error: 'no updatable fields' }, 400);
  values.push(userId);
  const r = await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
  if (!r.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ ok: true });
}

// 重設登入碼（也用來給「用邀請連結進來、還沒有登入碼」的人產生一組）：舊的登入碼馬上不能用
async function setAccessCode(request, env, userId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const mode = await getLoginCodeMode(env);
  const req = loginCodeRequest(body, mode);
  if (!req.ok) return jsonResp({ error: req.error }, req.status);

  if (req.custom) {
    const exists = await env.DB.prepare(
      `SELECT id FROM users WHERE access_code = ? AND id != ? LIMIT 1`
    ).bind(req.custom, userId).first();
    if (exists) return jsonResp({ error: '這個登入碼已被別人使用' }, 409);
  }

  // 舊的登入碼不能用了 → 那個人其他裝置的登入也一起失效（製作重設自己的 → 留下自己現在這一個；sessions.mjs）
  // 本來沒有登入碼（用邀請連結進來的人第一次拿登入碼）→ 不登出（SET 裡的欄位都是改之前的值）
  const rv = await sessionRevokeColumns(request, await getCurrentUser(request, env), userId);
  for (let attempt = 0; ; attempt++) {
    const code = req.custom || generateLoginCode();
    const cols = await loginCodeColumns(code, mode);
    try {
      const r = await env.DB.prepare(
        `UPDATE users SET
            sessions_revoked_at = CASE WHEN access_code IS NOT NULL OR access_code_hash IS NOT NULL THEN ? ELSE sessions_revoked_at END,
            session_keep_hash   = CASE WHEN access_code IS NOT NULL OR access_code_hash IS NOT NULL THEN ? ELSE session_keep_hash END,
            access_code = ?, access_code_hash = ?
          WHERE id = ?`
      ).bind(rv.revokedAt, rv.keepHash, cols.access_code, cols.access_code_hash, userId).run();
      if (!r.meta.changes) return jsonResp({ error: 'Not found' }, 404);
      return jsonResp({ ok: true, accessCode: code, shownOnce: mode === 'hashed' });
    } catch (e) {
      if (!isUniqueError(e)) throw e;
      if (req.custom) return jsonResp({ error: '這個登入碼已被別人使用' }, 409);
      if (attempt >= 3) throw e;
    }
  }
}

async function deleteUser(env, currentUserId, targetUserId) {
  if (currentUserId === targetUserId) return jsonResp({ error: '不能刪除自己的帳號' }, 400);
  const r = await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(targetUserId).run();
  if (!r.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ ok: true });
}

// ─── User project memberships（admin 專案指派）

async function listUserProjects(env, userId) {
  const r = await env.DB.prepare(`
    SELECT pm.project_id, pm.role, p.name
      FROM project_members pm
      JOIN projects p ON pm.project_id = p.id
     WHERE pm.user_id = ? AND p.status != 'archived'
     ORDER BY p.updated_at DESC
  `).bind(userId).all();
  return jsonResp({
    projects: (r.results || []).map(m => ({
      projectId: m.project_id, projectName: m.name, role: m.role,
    })),
  });
}

async function addUserToProject(request, env, userId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const projectId = (body?.projectId || '').toString();
  const role = ['admin', 'animator', 'director'].includes(body?.role) ? body.role : null;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) return jsonResp({ error: 'Invalid projectId' }, 400);
  if (!role) return jsonResp({ error: '請選角色（製作 / 動畫師 / 導演）' }, 400);

  // 確認 project 跟 user 都存在
  const p = await env.DB.prepare(`SELECT id FROM projects WHERE id = ? LIMIT 1`).bind(projectId).first();
  if (!p) return jsonResp({ error: 'Project not found' }, 404);
  const u = await env.DB.prepare(`SELECT id FROM users WHERE id = ? LIMIT 1`).bind(userId).first();
  if (!u) return jsonResp({ error: 'User not found' }, 404);

  await env.DB.prepare(
    `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`
  ).bind(projectId, userId, role).run();
  return jsonResp({ ok: true });
}

async function removeUserFromProject(request, env, userId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const projectId = (body?.projectId || '').toString();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) return jsonResp({ error: 'Invalid projectId' }, 400);

  const r = await env.DB.prepare(
    `DELETE FROM project_members WHERE project_id = ? AND user_id = ?`
  ).bind(projectId, userId).run();
  if (!r.meta.changes) return jsonResp({ error: '此 user 不在這個 project 內' }, 404);
  return jsonResp({ ok: true });
}

// ─────────────────────────────────────────────
// 邀請連結（規則在 invites.mjs；表在 migrations/0022）
//   GET    /api/projects/:id/invites              這個專案還能用的邀請         全站 admin（access.mjs）
//   POST   /api/projects/:id/invites              建立 → 回 { invite, token }  全站 admin；token 只回這一次
//   DELETE /api/projects/:id/invites/:inviteId    撤銷                         全站 admin
//   GET    /api/invites                           所有專案還能用的邀請（用戶頁） 全站 admin
//   POST   /api/invites/peek    { token }         打開前先看是誰、哪個專案（不會用掉）  不用登入
//   POST   /api/invites/redeem  { token }         用掉：登入（新的人這時建帳號）+ 加進專案  不用登入
// 邀請碼放在 body，不放在後台的網址上（不會出現在請求紀錄裡）
// ─────────────────────────────────────────────

const AVATAR_PALETTE = ['#10c78a', '#ffaa44', '#5294ff', '#c264ff', '#ff5470', '#ffd84a'];

async function handleInvitesRouter(request, env, url) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  const segs = url.pathname.split('/').filter(Boolean);  // [api, invites, sub?]
  if (segs.length > 3) return jsonResp({ error: 'Not found' }, 404);
  const sub = segs[2] || null;
  try {
    if (!sub) {
      if (request.method !== 'GET') return jsonResp({ error: 'Method not allowed' }, 405);
      const me = await getCurrentUser(request, env);
      if (!me) return jsonResp({ error: '未登入' }, 401);
      if (me.role !== 'admin') return jsonResp({ error: '只有製作可以做這件事' }, 403);
      return await listOpenInvites(env, { projectId: null });
    }
    if (sub === 'peek' || sub === 'redeem') {
      if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405);
      let body;
      try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
      return sub === 'peek' ? await peekInvite(env, body?.token) : await redeemInvite(env, body?.token);
    }
    return jsonResp({ error: 'Not found' }, 404);
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

const INVITE_LIST_SELECT = `
  SELECT i.id, i.project_id, i.role, i.user_id, i.new_user_name, i.created_at, i.expires_at,
         i.max_uses, i.use_count, i.last_used_at,
         p.name AS project_name, u.name AS user_name, c.name AS created_by_name
    FROM invites i
    JOIN projects p ON p.id = i.project_id
    LEFT JOIN users u ON u.id = i.user_id
    LEFT JOIN users c ON c.id = i.created_by_user_id`;

// 還能用的（沒撤銷、沒過期、還有次數、專案沒封存）
async function listOpenInvites(env, { projectId }) {
  const now = Date.now();
  const r = await env.DB.prepare(
    `${INVITE_LIST_SELECT}
      WHERE i.revoked_at IS NULL AND i.expires_at > ? AND i.use_count < i.max_uses AND p.status != 'archived'
        ${projectId ? 'AND i.project_id = ?' : ''}
      ORDER BY i.created_at DESC LIMIT 200`
  ).bind(...(projectId ? [now, projectId] : [now])).all();
  return jsonResp({ invites: (r.results || []).map(inviteToApi) });
}

async function createInvite(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const now = Date.now();
  const p = parseInviteCreate(body, now);
  if (!p.ok) return jsonResp({ error: p.error }, p.status);
  const { role, userId, name, expiresAt, maxUses } = p.value;
  if (userId) {
    const u = await env.DB.prepare(`SELECT id, name, role, deactivated FROM users WHERE id = ? LIMIT 1`).bind(userId).first();
    const d = inviteUserDecision(u, 'create');
    if (!d.ok) return jsonResp({ error: d.error }, d.status);
  }
  const token = generateInviteToken();
  const id = newInviteId();
  await env.DB.prepare(
    `INSERT INTO invites (id, token_hash, project_id, role, user_id, new_user_name, created_by_user_id, created_at, expires_at, max_uses, use_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(id, await hashInviteToken(token), ctx.projectId, role, userId, userId ? null : name, ctx.me.id, now, expiresAt, maxUses).run();
  const row = await env.DB.prepare(`${INVITE_LIST_SELECT} WHERE i.id = ? LIMIT 1`).bind(id).first();
  // token 只有這一次拿得到（資料庫只存雜湊）→ 前端組成 https://<網站>/invite/<token>
  return jsonResp({ invite: inviteToApi(row), token }, 201);
}

async function revokeInvite(env, ctx, inviteId) {
  const r = await env.DB.prepare(
    `UPDATE invites SET revoked_at = ?, revoked_by_user_id = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL`
  ).bind(Date.now(), ctx.me.id, inviteId, ctx.projectId).run();
  if (!r.meta.changes) return jsonResp({ error: '找不到這個邀請（可能已經撤銷了）' }, 404);
  return jsonResp({ ok: true });
}

async function loadInviteByToken(env, token) {
  if (!isInviteTokenShape(token)) return null;
  return env.DB.prepare(
    `SELECT i.*, p.name AS project_name, p.status AS project_status,
            u.name AS user_name, u.role AS user_role, u.deactivated AS user_deactivated
       FROM invites i
       JOIN projects p ON p.id = i.project_id
       LEFT JOIN users u ON u.id = i.user_id
      WHERE i.token_hash = ? LIMIT 1`
  ).bind(await hashInviteToken(token)).first();
}

const inviteUserOf = (inv) => (inv.user_role ? { role: inv.user_role, deactivated: inv.user_deactivated } : null);

/** 這條邀請現在不能用的話，回要給對方看的錯誤；能用回 null */
function inviteProblemResp(inv, now) {
  const state = inviteState(inv, now);
  if (state !== 'ok') {
    const p = inviteProblem(state);
    return jsonResp({ error: p.error, reason: p.reason }, p.status);
  }
  if (inv.user_id) {
    const d = inviteUserDecision(inviteUserOf(inv), 'redeem');
    if (!d.ok) return jsonResp({ error: d.error, reason: d.reason }, d.status);
  }
  return null;
}

async function peekInvite(env, token) {
  const inv = await loadInviteByToken(env, token);
  const bad = inviteProblemResp(inv, Date.now());
  if (bad) return bad;
  return jsonResp({
    invite: {
      projectName: inv.project_name,
      role: inv.role,
      personName: inv.user_name || inv.new_user_name || '',
      expiresAt: new Date(Number(inv.expires_at)).toISOString(),
    },
  });
}

async function redeemInvite(env, token) {
  const now = Date.now();
  const inv = await loadInviteByToken(env, token);
  const bad = inviteProblemResp(inv, now);
  if (bad) return bad;

  // 先佔一次使用：同時有兩個人按，只能用一次的邀請也只有一個會成功
  const claim = await env.DB.prepare(
    `UPDATE invites SET use_count = use_count + 1, last_used_at = ?
      WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND use_count < max_uses`
  ).bind(now, inv.id, now).run();
  if (!claim.meta?.changes) {
    const again = await loadInviteByToken(env, token);
    const state = inviteState(again, now);
    const p = inviteProblem(state === 'ok' ? 'used' : state);
    return jsonResp({ error: p.error, reason: p.reason }, p.status);
  }

  let userId = inv.user_id;
  if (!userId) {
    // 新的人：第一次打開才建帳號（角色 = 邀請的角色；沒有登入碼，之後要的話製作在用戶頁產生）
    // 可以用好幾次的邀請：之後打開的都是同一個人。兩個請求同時建 → 只有一個會綁上去
    const newId = 'u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const color = AVATAR_PALETTE[crypto.getRandomValues(new Uint8Array(1))[0] % AVATAR_PALETTE.length];
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, email, name, role, avatar_color)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM invites WHERE id = ? AND user_id IS NULL)`
      ).bind(newId, `${newId}@auto.local`, inv.new_user_name || '新成員', inv.role, color, inv.id),
      env.DB.prepare(
        `UPDATE invites SET user_id = ? WHERE id = ? AND user_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = ?)`
      ).bind(newId, inv.id, newId),
    ]);
    const bound = await env.DB.prepare(`SELECT user_id FROM invites WHERE id = ? LIMIT 1`).bind(inv.id).first();
    userId = bound?.user_id || null;
    if (!userId) return jsonResp({ error: '建立帳號失敗，請再試一次' }, 500);
  }

  const u = await env.DB.prepare(
    `SELECT id, name, role, avatar_color, deactivated FROM users WHERE id = ? LIMIT 1`
  ).bind(userId).first();
  const d = inviteUserDecision(u, 'redeem');
  if (!d.ok) return jsonResp({ error: d.error, reason: d.reason }, d.status);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`
    ).bind(inv.project_id, u.id, inv.role),
    env.DB.prepare(`UPDATE users SET last_seen_at = datetime('now') WHERE id = ?`).bind(u.id),
    env.DB.prepare(`UPDATE invites SET used_by_user_id = ? WHERE id = ?`).bind(u.id, inv.id),
  ]);

  // 跟一般登入一樣：90 天的登入狀態（cookie + 給前端存的 token）
  const sessionToken = await issueSessionToken(env, u.id);
  return jsonRespWithCookie({
    user: { id: u.id, name: u.name, role: u.role, avatarColor: u.avatar_color },
    token: sessionToken,
    projectId: inv.project_id,
    projectRole: inv.role,
    landingPath: inviteLandingPath(inv.role, inv.project_id),
  }, setSessionCookie(sessionToken));
}

// ─────────────────────────────────────────────
// Shared Assets（admin Tier 1 #10）— 跨專案共用的 model 庫
// GET    /api/assets                       → 列所有 active asset
// POST   /api/assets    body json{name,description}  → 建 metadata，回 id + r2_key（前端再 PUT binary）
// PATCH  /api/assets/:id                   → 改 name / description / deactivated
// DELETE /api/assets/:id                   → 軟刪除（deactivated=1，不真砍 R2，避免引用 broken）
// PUT    /api/assets/:id/file              → 上傳 .glb binary（content-type: model/gltf-binary）
// POST   /api/projects/:id/model/use-asset → 把 project 的 model 切到某個 shared asset
// ─────────────────────────────────────────────

const MAX_ASSET_NAME = 80;
const MAX_ASSET_DESC = 300;

async function handleAssetsRouter(request, env, url) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);

  const segs = url.pathname.split('/').filter(Boolean);
  const assetId = segs[2] || null;
  const action = segs[3] || null;

  try {
    // 看模型庫：全站 admin，或至少是一個專案的 admin（舊版前端專案頁的「從模型庫選」）；
    // 以前任何登入的人都能列出所有模型（名稱、誰傳的、檔案網址）
    if (me.role !== 'admin') {
      const pa = await env.DB.prepare(
        `SELECT 1 AS ok FROM project_members pm JOIN projects p ON p.id = pm.project_id
          WHERE pm.user_id = ? AND pm.role = 'admin' AND p.status != 'archived' LIMIT 1`
      ).bind(me.id).first();
      if (!canBrowseSharedAssets({ globalRole: me.role, isProjectAdminSomewhere: !!pa })) {
        return jsonResp({ error: '只有製作可以看模型庫' }, 403);
      }
    }
    if (!assetId) {
      if (request.method === 'GET') return listAssets(env);
      if (request.method === 'POST') {
        if (me.role !== 'admin') return jsonResp({ error: '只有製作可以改模型庫' }, 403);
        return createAsset(request, env, me);
      }
      return jsonResp({ error: 'Method not allowed' }, 405);
    }

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(assetId)) return jsonResp({ error: 'Invalid asset id' }, 400);

    if (action === 'file') {
      if (request.method === 'PUT') {
        if (me.role !== 'admin') return jsonResp({ error: '只有製作可以改模型庫' }, 403);
        return uploadAssetFile(request, env, assetId);
      }
      return jsonResp({ error: 'Method not allowed' }, 405);
    }

    if (request.method === 'GET') return getAsset(env, assetId);
    if (request.method === 'PATCH') {
      if (me.role !== 'admin') return jsonResp({ error: '只有製作可以改模型庫' }, 403);
      return updateAsset(request, env, assetId);
    }
    if (request.method === 'DELETE') {
      if (me.role !== 'admin') return jsonResp({ error: '只有製作可以改模型庫' }, 403);
      return deleteAsset(env, assetId);
    }
    return jsonResp({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

async function listAssets(env) {
  const r = await env.DB.prepare(`
    SELECT a.id, a.type, a.name, a.description, a.r2_key, a.size_bytes,
           a.uploaded_by_user_id, a.created_at, a.updated_at,
           u.name AS uploader_name,
           (SELECT COUNT(*) FROM projects p WHERE p.model_r2_key = a.r2_key AND p.status != 'archived') AS used_by_count
      FROM shared_assets a
      LEFT JOIN users u ON a.uploaded_by_user_id = u.id
     WHERE a.deactivated = 0
     ORDER BY a.updated_at DESC
  `).all();
  return jsonResp({
    assets: (r.results || []).map(a => ({
      id: a.id, type: a.type, name: a.name, description: a.description,
      key: a.r2_key, url: `/r2/${a.r2_key}`, sizeBytes: a.size_bytes,
      uploaderName: a.uploader_name, usedByCount: a.used_by_count,
      createdAt: a.created_at, updatedAt: a.updated_at,
    })),
  });
}

async function getAsset(env, assetId) {
  const a = await env.DB.prepare(`SELECT * FROM shared_assets WHERE id = ? LIMIT 1`).bind(assetId).first();
  if (!a) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ asset: {
    id: a.id, type: a.type, name: a.name, description: a.description,
    key: a.r2_key, url: `/r2/${a.r2_key}`, sizeBytes: a.size_bytes,
    createdAt: a.created_at, updatedAt: a.updated_at,
    deactivated: !!a.deactivated,
  }});
}

async function createAsset(request, env, me) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const name = (body?.name || '').toString().trim().slice(0, MAX_ASSET_NAME);
  const description = (body?.description || '').toString().trim().slice(0, MAX_ASSET_DESC);
  const type = body?.type === 'model' ? 'model' : 'model';
  if (!name) return jsonResp({ error: 'name 必填' }, 400);

  const id = 'as_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  // assets/models/<資產 id>-<128 bits 隨機>.glb（modelKeys.mjs；重新上傳蓋同一個檔）
  const r2Key = newSharedAssetKey(id);

  await env.DB.prepare(`
    INSERT INTO shared_assets (id, type, name, description, r2_key, uploaded_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(id, type, name, description, r2Key, me.id).run();

  // 還沒上傳檔案 → r2_key 在 R2 還不存在，前端要接著 PUT /file
  return jsonResp({ ok: true, id, key: r2Key }, 201);
}

async function uploadAssetFile(request, env, assetId) {
  if (!env.MODELS) return jsonResp({ error: 'R2 not configured' }, 500);

  const ct = request.headers.get('content-type') || '';
  if (!ct.includes('model/gltf-binary') && !ct.includes('application/octet-stream')) {
    return jsonResp({ error: 'Content-Type must be model/gltf-binary' }, 400);
  }
  const cl = parseInt(request.headers.get('content-length') || '0', 10);
  if (cl > MAX_MODEL_SIZE) return jsonResp({ error: `File too large` }, 413);

  const a = await env.DB.prepare(
    `SELECT id, r2_key FROM shared_assets WHERE id = ? LIMIT 1`
  ).bind(assetId).first();
  if (!a) return jsonResp({ error: 'Asset not found' }, 404);

  await env.MODELS.put(a.r2_key, request.body, {
    httpMetadata: { contentType: 'model/gltf-binary' },
    customMetadata: { assetId, uploadedAt: new Date().toISOString() },
  });

  await env.DB.prepare(
    `UPDATE shared_assets SET size_bytes = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(cl, assetId).run();

  return jsonResp({ ok: true, key: a.r2_key, sizeBytes: cl });
}

async function updateAsset(request, env, assetId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const sets = [], values = [];
  if ('name' in body) { sets.push('name = ?'); values.push((body.name || '').toString().trim().slice(0, MAX_ASSET_NAME)); }
  if ('description' in body) { sets.push('description = ?'); values.push((body.description || '').toString().slice(0, MAX_ASSET_DESC)); }
  if ('deactivated' in body) { sets.push('deactivated = ?'); values.push(body.deactivated ? 1 : 0); }
  if (!sets.length) return jsonResp({ error: 'no updatable fields' }, 400);
  values.push(assetId);
  const r = await env.DB.prepare(
    `UPDATE shared_assets SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...values).run();
  if (!r.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ ok: true });
}

async function deleteAsset(env, assetId) {
  const a = await env.DB.prepare(`SELECT r2_key FROM shared_assets WHERE id = ? LIMIT 1`).bind(assetId).first();
  if (!a) return jsonResp({ error: 'Not found' }, 404);
  // 檢查是否有 project 還在用
  const inUse = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM projects WHERE model_r2_key = ? AND status != 'archived'`
  ).bind(a.r2_key).first();
  if ((inUse?.n || 0) > 0) {
    return jsonResp({ error: `這個資產還有 ${inUse.n} 個專案在用，請先把專案切到別的 model 再刪。` }, 400);
  }
  // 軟刪除：標 deactivated，R2 物件保留（避免 race 下舊 client 還在 fetch）
  await env.DB.prepare(`UPDATE shared_assets SET deactivated = 1 WHERE id = ?`).bind(assetId).run();
  return jsonResp({ ok: true });
}

// ─────────────────────────────────────────────
// Activity log（admin Tier 1 #1）
// 在每個 mutation success 之後 fire-and-forget 寫一筆。
// 寫失敗只 log 不 throw —— activity log 失敗不該影響 mutation 結果。
// userId 暫時 hardcoded 'u_phang'，等 #13 權限細分才有多人。
// ─────────────────────────────────────────────
async function logActivity(request, env, projectId, action, targetType, targetId, payload = {}) {
  if (!env.DB || !projectId) return;
  try {
    // 沒有登入身分（例如排程同步）→ 記成 NULL（「系統」），不要冒用某個人
    const userId = (request && (await getRequestUserId(request, env))) || null;
    const id = 'a_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    // 號碼、密碼、通行證這類欄位一律遮掉再存（activity 會給專案成員看）
    const safePayload = scrubActivityPayload(payload ?? {});
    await env.DB.prepare(
      `INSERT INTO activity_log (id, project_id, user_id, action, target_type, target_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, projectId, userId, action, targetType, targetId || null, JSON.stringify(safePayload)).run();
  } catch (e) {
    console.warn('logActivity failed', e?.message || e);
  }
}

async function listActivity(env, projectId, limit = 50) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const rows = await env.DB.prepare(
    `SELECT a.id, a.project_id, a.user_id, a.action, a.target_type, a.target_id, a.payload, a.created_at,
            u.name AS user_name, u.avatar_color AS user_avatar
       FROM activity_log a
       LEFT JOIN users u ON a.user_id = u.id
      WHERE a.project_id = ?
      ORDER BY a.created_at DESC
      LIMIT ?`
  ).bind(projectId, lim).all();

  const list = (rows.results || []).map(r => ({
    id: r.id,
    projectId: r.project_id,
    userId: r.user_id,
    userName: r.user_name || 'Unknown',
    userAvatar: r.user_avatar || '#888888',
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    payload: safeJson(r.payload),
    createdAt: r.created_at,
  }));
  return jsonResp({ activities: list });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function parseConfirmTokens(html) {
  const inputs = {};
  const re = /<input\s+[^>]*name="([^"]+)"\s+value="([^"]*)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    inputs[m[1]] = m[2];
  }
  if (!inputs.confirm || !inputs.uuid) return null;
  return {
    confirm: inputs.confirm,
    uuid: inputs.uuid,
    at: inputs.at || ''
  };
}

// ─────────────────────────────────────────────
// Google Drive integration（admin Phase 2 — Drive 來源）
//
// 設定：在 Cloudflare Workers 後台加 secret：
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REDIRECT_URI（例：https://proxy.haimiaan.com/api/drive/oauth/callback）
//
// 流程：
//   admin 點「連接 Google」→ /api/drive/oauth/start?return=/admin/drive-sources
//     → 302 到 Google 同意頁
//   用戶按同意 → Google 302 回 /api/drive/oauth/callback?code=...&state=...
//     → 用 code 換 refresh_token + access_token，加密存 oauth_tokens
//     → 302 回 admin 設定的 return url
//
// Drive API：用 fetch 直接打 https://www.googleapis.com/drive/v3/files
// （比拉 googleapis npm 套件穩、Workers compatibility 好）
// ─────────────────────────────────────────────

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_FILES_FETCH = 'https://www.googleapis.com/drive/v3/files';

function googleConfigured(env) {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI);
}

// ── AES-GCM 加密／解密 helpers（key 從 AUTH_SECRET 衍生）──
async function getEncKey(env) {
  const enc = new TextEncoder();
  const raw = enc.encode(getAuthSecret(env) + ':drive-enc');
  // 取前 32 bytes 做 AES-256 key
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return await crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptString(env, plaintext) {
  const key = await getEncKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  // out = iv(12) || ciphertext+tag
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return bytesToBase64(out);
}

async function decryptString(env, b64) {
  if (!b64) return null;
  const key = await getEncKey(env);
  const all = base64ToBytes(b64);
  const iv = all.slice(0, 12);
  const ct = all.slice(12);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

function randHex(nBytes) {
  const b = crypto.getRandomValues(new Uint8Array(nBytes));
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

// ── OAuth start ──
async function driveOAuthStart(request, env, url) {
  if (!googleConfigured(env)) return jsonResp({ error: 'Google OAuth 未設定。請聯絡平台管理員設定 GOOGLE_CLIENT_ID / SECRET / REDIRECT_URI' }, 503);
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);
  if (me.role !== 'admin') return jsonResp({ error: '只有製作可以連接 Drive' }, 403);

  // 接受完整 URL 或相對路徑；只允許 stage-previz.vercel.app / haimiaan.com 子網域 / localhost
  const rawReturn = url.searchParams.get('return') || '/admin/drive-sources';
  const returnTo = sanitizeReturnUrl(rawReturn);
  const state = randHex(16);

  await env.DB.prepare(
    `INSERT INTO oauth_states (state, user_id, return_to) VALUES (?, ?, ?)`
  ).bind(state, me.id, returnTo).run();

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_SCOPES,
    access_type: 'offline',
    prompt: 'consent',          // 強制每次拿 refresh_token
    include_granted_scopes: 'true',
    state,
  });
  const redirect = `${GOOGLE_AUTH_URL}?${params.toString()}`;
  // POST → 回 JSON 給前端 location.href（避開 cookie cross-origin 限制）
  if (request.method === 'POST') {
    return jsonResp({ authUrl: redirect });
  }
  // GET → 直接 302（跟 cookie auth 走，dev / 同 origin 用）
  return new Response(null, { status: 302, headers: { Location: redirect, ...corsHeaders() } });
}

// ── OAuth callback ──
async function driveOAuthCallback(request, env, url) {
  if (!googleConfigured(env)) return jsonResp({ error: 'Google OAuth 未設定' }, 503);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthErr = url.searchParams.get('error');
  if (oauthErr) return htmlPage(`<h1>連接失敗</h1><p>${escapeHtml(oauthErr)}</p><p><a href="/admin/drive-sources">返回</a></p>`);
  if (!code || !state) return htmlPage(`<h1>連接失敗</h1><p>缺少 code 或 state 參數</p>`);

  // 驗 state（5 分鐘內有效）
  const st = await env.DB.prepare(
    `SELECT user_id, return_to, created_at FROM oauth_states WHERE state = ? LIMIT 1`
  ).bind(state).first();
  if (!st) return htmlPage(`<h1>連接失敗</h1><p>state 無效或已過期</p>`);
  // 用過就刪
  await env.DB.prepare(`DELETE FROM oauth_states WHERE state = ?`).bind(state).run();
  // 5 分鐘過期
  const ageSec = (Date.now() - new Date(st.created_at + 'Z').getTime()) / 1000;
  if (ageSec > 600) return htmlPage(`<h1>連接失敗</h1><p>授權已過期，請重新連接</p>`);

  // 換 token
  let tokenResp;
  try {
    const r = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: env.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }).toString(),
    });
    tokenResp = await r.json();
    if (!r.ok || !tokenResp.access_token) {
      return htmlPage(`<h1>連接失敗</h1><p>Google token 換取失敗：${escapeHtml(tokenResp.error_description || tokenResp.error || 'unknown')}</p>`);
    }
  } catch (e) {
    return htmlPage(`<h1>連接失敗</h1><p>${escapeHtml(e.message)}</p>`);
  }
  if (!tokenResp.refresh_token) {
    return htmlPage(`<h1>連接失敗</h1><p>沒拿到 refresh_token，可能是已經連過。請去 <a href="https://myaccount.google.com/permissions" target="_blank">Google 帳號權限</a> 撤銷後重試。</p>`);
  }

  // 取用戶 email + 名字
  let emailLow = '';
  let nameStr = '';
  try {
    const ui = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenResp.access_token}` },
    }).then(r => r.json());
    emailLow = (ui.email || '').toLowerCase();
    nameStr = ui.name || ui.email || '';
  } catch {}
  if (!emailLow) return htmlPage(`<h1>連接失敗</h1><p>無法取得 Google 帳號 email</p>`);

  const enc_refresh = await encryptString(env, tokenResp.refresh_token);
  const expiresAt = new Date(Date.now() + (tokenResp.expires_in || 3600) * 1000).toISOString();
  const enc_access = await encryptString(env, tokenResp.access_token);

  // upsert（同 email 重連 → 更新 refresh token）
  const existing = await env.DB.prepare(
    `SELECT id FROM oauth_tokens WHERE provider='google' AND account_email=? LIMIT 1`
  ).bind(emailLow).first();
  let id;
  if (existing) {
    id = existing.id;
    await env.DB.prepare(`
      UPDATE oauth_tokens
         SET account_name = ?, scopes = ?, encrypted_refresh_token = ?,
             encrypted_access_token = ?, access_token_expires_at = ?, last_used_at = datetime('now')
       WHERE id = ?
    `).bind(nameStr, GOOGLE_SCOPES, enc_refresh, enc_access, expiresAt, id).run();
  } else {
    id = 'tok_' + randHex(8);
    await env.DB.prepare(`
      INSERT INTO oauth_tokens (id, provider, account_email, account_name, scopes,
                                 encrypted_refresh_token, encrypted_access_token,
                                 access_token_expires_at, created_by_user_id)
      VALUES (?, 'google', ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, emailLow, nameStr, GOOGLE_SCOPES, enc_refresh, enc_access, expiresAt, st.user_id).run();
  }

  const ret = (st.return_to || '/admin/drive-sources').toString();
  // 為了好看：用 HTML 自動跳轉而非 302（可顯示成功訊息）
  return htmlPage(`
    <h1>✅ 已連接 Google Drive</h1>
    <p>帳號：<strong>${escapeHtml(nameStr)}</strong> &lt;${escapeHtml(emailLow)}&gt;</p>
    <p>3 秒後跳回設定頁…</p>
    <script>setTimeout(()=>{ window.location.href=${JSON.stringify(ret)}; }, 3000);</script>
    <p><a href="${escapeHtml(ret)}">立即返回</a></p>
  `);
}

// ── List Google accounts（admin only）──
async function driveListAccounts(request, env) {
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);
  if (me.role !== 'admin') return jsonResp({ error: '只有製作可以管理 Drive' }, 403);

  const r = await env.DB.prepare(
    `SELECT id, account_email, account_name, scopes, created_at, last_used_at
       FROM oauth_tokens WHERE provider='google' ORDER BY created_at DESC`
  ).all();
  return jsonResp({
    configured: googleConfigured(env),
    accounts: (r.results || []).map(a => ({
      id: a.id,
      email: a.account_email,
      name: a.account_name,
      scopes: a.scopes,
      createdAt: a.created_at,
      lastUsedAt: a.last_used_at,
    })),
  });
}

async function driveDeleteAccount(request, env, accId) {
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);
  if (me.role !== 'admin') return jsonResp({ error: '只有製作可以管理 Drive' }, 403);

  // 把所有用此 token 的 project 的 drive_oauth_token_id 清空
  await env.DB.prepare(
    `UPDATE projects SET drive_oauth_token_id = NULL WHERE drive_oauth_token_id = ?`
  ).bind(accId).run();
  await env.DB.prepare(`DELETE FROM oauth_tokens WHERE id = ?`).bind(accId).run();
  return jsonResp({ ok: true });
}

// ── 拿 access token（會自動 refresh）──
async function driveGetAccessToken(env, tokenId) {
  const row = await env.DB.prepare(
    `SELECT encrypted_refresh_token, encrypted_access_token, access_token_expires_at
       FROM oauth_tokens WHERE id = ? LIMIT 1`
  ).bind(tokenId).first();
  if (!row) throw new Error('OAuth token not found');

  // 還有效就用 cache 的 access_token（提前 60s 過期才 refresh）
  if (row.encrypted_access_token && row.access_token_expires_at) {
    const exp = new Date(row.access_token_expires_at).getTime();
    if (exp - 60_000 > Date.now()) {
      const at = await decryptString(env, row.encrypted_access_token);
      if (at) return at;
    }
  }

  const refresh = await decryptString(env, row.encrypted_refresh_token);
  if (!refresh) throw new Error('Refresh token decrypt failed');

  const r = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const tr = await r.json();
  if (!r.ok || !tr.access_token) {
    throw new Error('Token refresh failed: ' + (tr.error_description || tr.error || 'unknown'));
  }

  const enc_access = await encryptString(env, tr.access_token);
  const expiresAt = new Date(Date.now() + (tr.expires_in || 3600) * 1000).toISOString();
  await env.DB.prepare(`
    UPDATE oauth_tokens
       SET encrypted_access_token = ?, access_token_expires_at = ?, last_used_at = datetime('now')
     WHERE id = ?
  `).bind(enc_access, expiresAt, tokenId).run();

  return tr.access_token;
}

// ── Drive API 包裝 ──
async function driveApiGet(env, tokenId, path, query = {}) {
  const at = await driveGetAccessToken(env, tokenId);
  const params = new URLSearchParams(query).toString();
  const r = await fetch(`${DRIVE_API}${path}${params ? '?' + params : ''}`, {
    headers: { Authorization: `Bearer ${at}` },
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Drive API ${path} → ${r.status}: ${text.slice(0, 200)}`);
  }
  try { return JSON.parse(text); } catch { return text; }
}

// ── 列 Drive 資料夾（admin 設定 project drive_folder_id 時挑 folder 用）──
async function driveListFolders(request, env, url) {
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);
  if (me.role !== 'admin') return jsonResp({ error: '只有製作可以管理 Drive' }, 403);

  const tokenId = url.searchParams.get('account');
  if (!tokenId) return jsonResp({ error: 'Missing account id' }, 400);

  const parent = url.searchParams.get('parent') || 'root';
  const q = `'${parent.replace(/'/g, "\\'")}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

  try {
    const data = await driveApiGet(env, tokenId, '/files', {
      q,
      pageSize: '100',
      fields: 'files(id,name,parents,modifiedTime)',
      orderBy: 'name',
    });
    return jsonResp({ folders: data.files || [] });
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

// ── 列某 project 已 cache 的 drive_files ──
async function driveListProjectFiles(env, projectId) {
  const r = await env.DB.prepare(`
    SELECT df.*, s.name AS song_name
      FROM drive_files df
      LEFT JOIN songs s ON df.song_id = s.id
     WHERE df.project_id = ?
     ORDER BY COALESCE(df.modified_time, df.cached_at) DESC
  `).bind(projectId).all();
  return jsonResp({
    files: (r.results || []).map(f => ({
      id: f.id,
      driveFileId: f.drive_file_id,
      filename: f.filename,
      mimeType: f.mime_type,
      modifiedTime: f.modified_time,
      sizeBytes: f.size_bytes,
      thumbnailUrl: f.thumbnail_url,
      viewUrl: f.view_url,
      songId: f.song_id,
      songName: f.song_name,
      classifiedBy: f.classified_by,
      cachedAt: f.cached_at,
    })),
  });
}

// ── 手動把檔案歸到某 song ──
async function driveAssignFile(request, env, projectId, fid) {
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);
  let body = {};
  try { body = await request.json(); } catch {}
  const songId = body?.songId || null;
  if (songId !== null && (typeof songId !== 'string' || !ID_RE.test(songId))) return jsonResp({ error: 'Invalid songId' }, 400);
  if (!fid || !ID_RE.test(fid)) return jsonResp({ error: 'Invalid file id' }, 400);
  // 只能歸到這個專案的歌
  if (songId) {
    const s = await env.DB.prepare(`SELECT id FROM songs WHERE id = ? AND project_id = ? LIMIT 1`).bind(songId, projectId).first();
    if (!s) return jsonResp({ error: '這個專案裡找不到這首歌' }, 404);
  }
  const r = await env.DB.prepare(
    `UPDATE drive_files SET song_id = ?, classified_by = 'manual'
      WHERE id = ? AND project_id = ?`
  ).bind(songId, fid, projectId).run();
  if (!r.meta.changes) return jsonResp({ error: '這個專案裡找不到這個檔案' }, 404);
  await logActivity(request, env, projectId, 'update', 'drive_file', fid, { songId });
  return jsonResp({ ok: true });
}

async function driveSyncLog(env, projectId) {
  const r = await env.DB.prepare(
    `SELECT * FROM drive_sync_log WHERE project_id = ? ORDER BY ran_at DESC LIMIT 30`
  ).bind(projectId).all();
  return jsonResp({
    logs: (r.results || []).map(l => ({
      id: l.id,
      triggeredBy: l.triggered_by,
      filesFound: l.files_found,
      filesClassified: l.files_classified,
      filesUnclassified: l.files_unclassified,
      errorMessage: l.error_message,
      durationMs: l.duration_ms,
      ranAt: l.ran_at,
    })),
  });
}

// ── 觸發同步（手動）──
async function driveSyncProject(request, env, projectId, triggeredBy) {
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);
  try {
    const stats = await driveSyncProjectInternal(env, projectId, triggeredBy);
    // 有新的影片要複製 → 這個請求做完後順便做一輪（其他的排程 / 畫面查進度時接著做）
    if (stats.versionsQueued) runInBackground(request, runVideoCopyJobs(env, { projectId, ...videoRequestStep(env) }));
    return jsonResp({ ok: true, ...stats });
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

// ── 同步邏輯（給手動 + cron 共用）──
async function driveSyncProjectInternal(env, projectId, triggeredBy) {
  const t0 = Date.now();
  const proj = await env.DB.prepare(
    `SELECT id, drive_folder_id, drive_filename_pattern, drive_oauth_token_id
       FROM projects WHERE id = ? AND status != 'archived' LIMIT 1`
  ).bind(projectId).first();
  if (!proj) throw new Error('Project not found');
  if (!proj.drive_folder_id) throw new Error('Project has no drive_folder_id');
  if (!proj.drive_oauth_token_id) throw new Error('Project has no drive_oauth_token_id');

  // 列 folder 內所有非 trashed 檔案（pageSize=1000，超過再分頁）
  const q = `'${proj.drive_folder_id.replace(/'/g, "\\'")}' in parents and trashed = false`;
  let pageToken = null;
  const all = [];
  let pages = 0;
  do {
    const data = await driveApiGet(env, proj.drive_oauth_token_id, '/files', {
      q,
      pageSize: '1000',
      fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,size,md5Checksum,videoMediaMetadata,thumbnailLink,webViewLink,webContentLink,iconLink)',
      orderBy: 'modifiedTime desc',
      ...(pageToken ? { pageToken } : {}),
    });
    // 只收影片檔（圖片、文件、資料夾不列）
    for (const f of (data.files || [])) if (isDriveVideoFile(f)) all.push(f);
    pageToken = data.nextPageToken || null;
    pages++;
    if (pages > 5) break; // safety: 5000 檔上限
  } while (pageToken);

  // 用歌曲固定代號對歌：檔名開頭 S01_ / S01- / S01 空白 → 代號 S01 的歌（不再看歌單第幾首，歌換順序不會對錯）
  // 舊專案的代號是照當時的順序補的（S03 = 第 3 首），所以已經同步過的檔案還是對到同一首
  const songs = await ensureSongCodes(env, projectId);

  // 既有的 drive_files（key 為 drive_file_id）→ 用來判斷新增/更新/移除
  const existingR = await env.DB.prepare(
    `SELECT id, drive_file_id, classified_by, song_id FROM drive_files WHERE project_id = ?`
  ).bind(projectId).all();
  const existingByDriveId = new Map();
  for (const e of (existingR.results || [])) existingByDriveId.set(e.drive_file_id, e);

  let classified = 0, unclassified = 0;
  const seenDriveIds = new Set();
  const stmts = [];
  const filesForVersions = [];  // [{ file, songId }] → 新的 / 改過的會建一版影片

  for (const f of all) {
    seenDriveIds.add(f.id);
    let songId = matchSongByFilename(f.name, songs);

    const existing = existingByDriveId.get(f.id);
    // 如果用戶手動 assign 過，保留他的 song_id（不要被代號蓋掉）
    if (existing && existing.classified_by === 'manual') {
      songId = existing.song_id;
    }
    // 對不到的留在「未分類」（song_id = NULL），不掛到任何一首歌
    if (songId) classified++;
    else unclassified++;
    filesForVersions.push({ file: f, songId });

    const thumbnail = f.thumbnailLink || null;
    const viewUrl = f.webViewLink || null;
    const streamUrl = f.webContentLink || null;
    const sizeBytes = f.size ? parseInt(f.size, 10) : null;
    const mimeType = f.mimeType || null;
    const modifiedTime = f.modifiedTime || null;

    if (existing) {
      stmts.push(env.DB.prepare(`
        UPDATE drive_files
           SET song_id = ?, filename = ?, mime_type = ?, modified_time = ?,
               size_bytes = ?, thumbnail_url = ?, view_url = ?, stream_url = ?,
               classified_by = ?, cached_at = datetime('now')
         WHERE id = ?
      `).bind(songId, f.name, mimeType, modifiedTime, sizeBytes, thumbnail, viewUrl, streamUrl,
              existing.classified_by === 'manual' ? 'manual' : 'pattern', existing.id));
    } else {
      const id = 'df_' + randHex(8);
      stmts.push(env.DB.prepare(`
        INSERT INTO drive_files (id, project_id, song_id, drive_file_id, filename,
                                  mime_type, modified_time, size_bytes,
                                  thumbnail_url, view_url, stream_url, classified_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pattern')
      `).bind(id, projectId, songId, f.id, f.name, mimeType, modifiedTime, sizeBytes,
              thumbnail, viewUrl, streamUrl));
    }
  }

  // 移除不再存在於 Drive 的檔案
  for (const [did, e] of existingByDriveId) {
    if (!seenDriveIds.has(did)) {
      stmts.push(env.DB.prepare(`DELETE FROM drive_files WHERE id = ?`).bind(e.id));
    }
  }

  // 分批 batch（D1 batch 大小限制大概 100 statements）
  const BATCH = 50;
  for (let i = 0; i < stmts.length; i += BATCH) {
    await env.DB.batch(stmts.slice(i, i + BATCH));
  }

  // 新的 / 內容改過的影片 → 建一版、複製到 R2（之後播放走 R2，不經過 Google）
  let versionsQueued = 0;
  try {
    versionsQueued = await queueDriveVideoVersions(env, proj, filesForVersions);
  } catch (e) {
    console.error('[drive sync versions]', projectId, e?.message || e);
  }

  const dur = Date.now() - t0;
  const logId = 'dsl_' + randHex(8);
  await env.DB.prepare(`
    INSERT INTO drive_sync_log (id, project_id, triggered_by, files_found,
                                  files_classified, files_unclassified, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(logId, projectId, triggeredBy, all.length, classified, unclassified, dur).run();

  return { filesFound: all.length, classified, unclassified, versionsQueued, durationMs: dur };
}

// ── Stream proxy（給導演 video player 用）──
// 設計：用 stream_url（webContentLink）會卡 Drive 的 100MB 確認頁，所以走 Drive API 的
//   GET /drive/v3/files/{id}?alt=media（要 access token）
//   Range header 直接 forward 給 Google
async function driveStreamFile(request, env, fid) {
  if (!fid) return jsonResp({ error: 'Missing file id' }, 400);

  // 找這個 drive_file_id 屬於哪個 project（順便驗權）
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(fid)) return jsonResp({ error: 'Invalid file id' }, 400);
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);

  const f = await env.DB.prepare(
    `SELECT df.project_id, df.filename, df.mime_type, p.drive_oauth_token_id, p.status AS project_status
       FROM drive_files df
       JOIN projects p ON df.project_id = p.id
      WHERE df.drive_file_id = ?
      LIMIT 1`
  ).bind(fid).first();
  if (!f) return jsonResp({ error: 'File not found' }, 404);

  // 非 admin 要在 project_members，而且專案沒封存
  if (me.role !== 'admin') {
    if (f.project_status === 'archived') return jsonResp({ error: 'File not found' }, 404);
    const m = await env.DB.prepare(
      `SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1`
    ).bind(f.project_id, me.id).first();
    if (!m) return jsonResp({ error: '沒有權限' }, 403);
  }

  if (!f.drive_oauth_token_id) return jsonResp({ error: 'Project missing OAuth token' }, 412);

  let at;
  try { at = await driveGetAccessToken(env, f.drive_oauth_token_id); }
  catch (e) { return jsonResp({ error: 'Token refresh failed: ' + e.message }, 500); }

  const range = request.headers.get('range');
  const headers = { Authorization: `Bearer ${at}` };
  if (range) headers['Range'] = range;

  const upstream = await fetch(`${DRIVE_FILES_FETCH}/${encodeURIComponent(fid)}?alt=media`, {
    method: request.method,
    headers,
  });

  // 把上游 headers 透傳（Content-Type / Content-Range / Length / Accept-Ranges）
  const passHeaders = new Headers();
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const v = upstream.headers.get(k);
    if (v) passHeaders.set(k, v);
  }
  if (!passHeaders.has('content-type') && f.mime_type) passHeaders.set('content-type', f.mime_type);
  return new Response(upstream.body, { status: upstream.status, headers: passHeaders });
}

// ─────────────────────────────────────────────
// 歌曲影片版本（V1、V2…，檔案一律放我們的 R2，播放不經過 Google）
//   API 文件：docs/videos-api.md；純判斷（版本號、連結、代號對歌、權限）在 videos.mjs
//
//   上傳：瀏覽器分段（每段 16 MiB）→ 後台一段一段轉給 R2 分段上傳 → 完成時給版本號
//   貼連結 / Drive 同步：後台一段一段（每段 32 MiB）從來源抓、放進 R2。一輪最多做十幾秒，
//     接著做的時機：貼連結的那個請求做完之後、畫面查進度（GET 清單 / 單一版本）時、排程每 5 分鐘
//     （Cloudflare 一個請求做完後最多再跑 30 秒、免費方案一次最多 50 個對外請求 → 不能一次複製完大檔）
//   播放：/api/videos/:id/stream?pass=<通行證>（<video src> 帶不了登入 header），支援 Range
// ─────────────────────────────────────────────

const VIDEO_COPY_LEASE_EXTRA_MS = 30_000;
const VIDEO_COPY_MAX_STALLS = 8;
const VIDEO_STALE_UPLOAD_MS = 2 * 86400_000;
// 請求順便複製一輪（waitUntil 最多 30 秒）；VIDEO_COPY_STEP_FETCHES 可以改一輪抓幾段（測試用）
const VIDEO_REQUEST_STEP = { budgetMs: 15_000, maxFetches: 10 };
function videoRequestStep(env) {
  const n = Number(env?.VIDEO_COPY_STEP_FETCHES);
  return { ...VIDEO_REQUEST_STEP, ...(Number.isInteger(n) && n >= 1 && n <= 40 ? { maxFetches: n } : {}) };
}
// 排程每 5 分鐘一次：做 3 分多鐘、最多 40 次對外請求（免費方案一次最多 50；每個 Drive 同步再扣 4 次）
const VIDEO_CRON_STEP = { budgetMs: 200_000, maxFetches: 40, allowLongSingle: true };
// 不能分段的來源：請求裡最多一次抓 150 MB，再大的交給排程（排程最多可以跑 15 分鐘）
const VIDEO_SINGLE_IN_REQUEST_MAX = 150 * MIB;
const VIDEO_FETCH_UA = 'Mozilla/5.0 (compatible; StagePrevizVideoCopy/1.0)';
const VIDEO_SELF_HOSTS = ['proxy.haimiaan.com'];

const nowIso = () => new Date().toISOString();

class VideoCopyFatal extends Error {}

function videoR2Key(projectId, songId, videoId, mime) {
  return `videos/${projectId}/${songId}/${videoId}.${extForMime(mime)}`;
}
function cleanVideoText(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function cleanVideoDim(v) { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 20000 ? n : null; }
function cleanVideoDuration(v) { const n = Number(v); return Number.isFinite(n) && n > 0 && n <= 86400 ? Math.round(n * 1000) / 1000 : null; }
function titleFromFilename(name) { return String(name || '').replace(/\.[A-Za-z0-9]{1,8}$/, '').trim().slice(0, VIDEO_TITLE_MAX); }
function isUniqueError(e) { return /UNIQUE constraint failed/i.test(String(e?.message || e)); }

async function memberVideoStreamUrl(env, videoId, userId) {
  const pass = await signVideoPass(getAuthSecret(env), { videoId, userId });
  return `/api/videos/${encodeURIComponent(videoId)}/stream?pass=${encodeURIComponent(pass)}`;
}

function videoUploadInfo(v, partNumbers) {
  const partCount = Math.max(1, Math.ceil((v.size_bytes || 0) / (v.part_size || UPLOAD_PART_SIZE)));
  return {
    partSize: v.part_size,
    partCount,
    uploadedParts: [...partNumbers].map(Number).sort((a, b) => a - b),
    maxConcurrency: 3,
  };
}

// 成員看到的一版影片
function videoToApi(v, { streamUrl = null, latestId = null, upload = null, duplicateOf = null, fingerprintPending = false } = {}) {
  const inFlight = v.status === 'uploading' || v.status === 'processing';
  return {
    id: v.id,
    projectId: v.project_id,
    songId: v.song_id,
    version: v.version ?? null,
    label: versionLabel(v.version),
    title: v.title || '',
    note: v.note || '',
    source: v.source,
    originalUrl: v.original_url || null,
    driveFileId: v.drive_file_id || null,
    mime: v.mime,
    sizeBytes: v.size_bytes ?? null,
    width: v.width ?? null,
    height: v.height ?? null,
    durationSec: v.duration_sec ?? null,
    status: v.status,
    error: v.error || null,
    progress: inFlight ? { bytesDone: v.bytes_done || 0, totalBytes: v.size_bytes ?? null } : null,
    createdBy: v.created_by ? { id: v.created_by, name: v.created_by_name || null } : null,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
    readyAt: v.ready_at || null,
    isLatest: !!latestId && v.id === latestId,
    streamUrl: v.status === 'ready' ? streamUrl : null,
    storageClass: v.storage_class || 'Standard',
    // 跟更早交的哪一版是同一個檔案（storage.mjs duplicateMarks；沒有 = null）；還在算指紋 → fingerprintPending
    duplicateOf,
    fingerprintPending,
    // 這一版做的時候用的 LED 版型和當時的排法（0034；沒有 = 整張畫布）
    templateId: v.template_id || null,
    template: ledTpl.snapshotToApi(v.template_snapshot),
    // 這一版上傳時整條版型時間線（中途換版型，0039；沒有 = null = 單一版型）
    templateTimeline: ledTpl.timelineSnapshotToApi(v.template_timeline),
    ...(upload ? { upload } : {}),
  };
}

// 分享連結看到的一版影片（不給說明、誰交的、原始連結）
function videoToShareApi(v, streamUrl) {
  return {
    id: v.id,
    songId: v.song_id,
    version: v.version,
    label: versionLabel(v.version),
    title: v.title || '',
    mime: v.mime,
    sizeBytes: v.size_bytes ?? null,
    width: v.width ?? null,
    height: v.height ?? null,
    durationSec: v.duration_sec ?? null,
    createdAt: v.created_at,
    readyAt: v.ready_at || null,
    streamUrl,
    template: ledTpl.snapshotToApi(v.template_snapshot),
    templateTimeline: ledTpl.timelineSnapshotToApi(v.template_timeline),
  };
}

// 每首歌最新的可播版本：Map(songId → row)
async function latestReadyVideos(env, projectId) {
  const r = await env.DB.prepare(`
    SELECT v.* FROM song_videos v
     WHERE v.project_id = ? AND v.status = 'ready' AND v.deleted_at IS NULL
       AND v.version = (SELECT MAX(v2.version) FROM song_videos v2
                         WHERE v2.song_id = v.song_id AND v2.status = 'ready' AND v2.deleted_at IS NULL)
  `).bind(projectId).all();
  const map = new Map();
  for (const row of (r.results || [])) map.set(row.song_id, row);
  return map;
}

// 沒有代號的歌依順序補上（新專案 / 匯入的 / 舊版建的歌），回傳 [{ id, name, code }]（依歌單順序）
async function ensureSongCodes(env, projectId) {
  const q = () => env.DB.prepare(
    `SELECT id, name, code FROM songs WHERE project_id = ? ORDER BY "order", created_at, id`
  ).bind(projectId).all();
  const songs = (await q()).results || [];
  const fill = fillMissingSongCodes(songs);
  if (!fill.length) return songs;
  try {
    await env.DB.batch(fill.map(f => env.DB.prepare(
      `UPDATE songs SET code = ? WHERE id = ? AND project_id = ? AND code IS NULL`
    ).bind(f.code, f.id, projectId)));
  } catch (e) {
    // 同時有別的請求在補 → 撞號整批取消，下次再補
    console.warn('[ensureSongCodes]', e?.message || e);
  }
  return (await q()).results || [];
}

// 畫面在看的歌如果有閒著的複製工作 → 這個請求做完後順便做一輪
function nudgeVideoCopies(request, env, rows, filter = {}) {
  const now = Date.now();
  const idle = (rows || []).some(v => v.status === 'processing' && !v.deleted_at
    && (!v.lease_until || v.lease_until < now)
    && !(v.copy_mode === 'single' && (v.size_bytes || 0) > VIDEO_SINGLE_IN_REQUEST_MAX));
  if (idle) runInBackground(request, runVideoCopyJobs(env, { ...filter, ...videoRequestStep(env) }));
}

// ── 清單 / 單一版本 ──

async function listSongVideos(request, env, ctx) {
  const { projectId, song, me } = ctx;
  const r = await env.DB.prepare(`
    SELECT v.*, u.name AS created_by_name
      FROM song_videos v LEFT JOIN users u ON u.id = v.created_by
     WHERE v.project_id = ? AND v.song_id = ? AND v.deleted_at IS NULL
     ORDER BY (v.version IS NULL) DESC, v.version DESC, v.created_at DESC
  `).bind(projectId, song.id).all();
  const rows = r.results || [];
  const latest = rows.filter(v => v.status === 'ready').sort((a, b) => b.version - a.version)[0] || null;
  const dups = await storage.duplicateMarks(env, projectId, rows).catch(() => ({ marks: new Map(), pending: new Set() }));
  const videos = [];
  for (const v of rows) {
    const streamUrl = v.status === 'ready' ? await memberVideoStreamUrl(env, v.id, me.id) : null;
    videos.push(videoToApi(v, {
      streamUrl, latestId: latest?.id, duplicateOf: dups.marks.get(v.id) || null, fingerprintPending: dups.pending.has(v.id),
    }));
  }
  nudgeVideoCopies(request, env, rows, { songId: song.id });
  // 交好的版本還沒有指紋 → 這個請求做完後順便算幾段（貼連結 / Drive 的好了以後很快就知道有沒有重複）
  if (rows.some(v => v.status === 'ready' && !v.fingerprint)) {
    runInBackground(request, storage.runFingerprintStep(env, { songId: song.id, maxBlocks: storage.STORAGE_DEFAULTS.fpBlocksRequest }));
  }
  return jsonResp({ videos, latestVideoId: latest?.id || null, songCode: song.code || null });
}

async function songVideoResponse(env, ctx, v, status = 200, extra = {}) {
  const fresh = await env.DB.prepare(
    `SELECT v.*, u.name AS created_by_name FROM song_videos v LEFT JOIN users u ON u.id = v.created_by WHERE v.id = ? LIMIT 1`
  ).bind(v.id).first();
  const row = fresh || v;
  let upload = null;
  if (row.status === 'uploading') {
    const pr = await env.DB.prepare(`SELECT part_number FROM song_video_parts WHERE video_id = ?`).bind(row.id).all();
    upload = videoUploadInfo(row, (pr.results || []).map(p => p.part_number));
  }
  let latestId = null;
  if (row.status === 'ready') {
    const l = await env.DB.prepare(
      `SELECT id FROM song_videos WHERE song_id = ? AND status = 'ready' AND deleted_at IS NULL ORDER BY version DESC LIMIT 1`
    ).bind(row.song_id).first();
    latestId = l?.id || null;
  }
  const streamUrl = row.status === 'ready' ? await memberVideoStreamUrl(env, row.id, ctx.me.id) : null;
  return jsonResp({ video: videoToApi(row, { streamUrl, latestId, upload }), ...extra }, status);
}

async function getSongVideo(request, env, ctx) {
  nudgeVideoCopies(request, env, [ctx.video], { videoId: ctx.video.id });
  return songVideoResponse(env, ctx, ctx.video);
}

// ── 上傳（分段）──

async function createVideoUpload(request, env, ctx) {
  const { me, projectId, song, role } = ctx;
  const d = videoUploadDecision({ role, userId: me.id, song });
  if (!d.ok) return jsonResp({ error: d.error }, d.status);
  if (!env.MODELS) return jsonResp({ error: 'R2 not configured' }, 500);
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const filename = cleanVideoText(body?.filename, 255);
  const size = Number(body?.sizeBytes);
  const maxBytes = videoMaxBytes(env);
  if (!Number.isInteger(size) || size <= 0) return jsonResp({ error: '檔案大小不正確' }, 400);
  if (size > maxBytes) {
    return jsonResp({ error: `檔案太大（${formatBytes(size)}），上限是 ${formatBytes(maxBytes)}`, maxBytes }, 413);
  }
  const mime = videoMimeFor({ mime: body?.mime, filename });
  if (!mime) return jsonResp({ error: unsupportedFormatMessage(filename, body?.mime) }, 415);
  const plan = planParts(size, UPLOAD_PART_SIZE);
  if (!plan.ok) return jsonResp({ error: plan.error }, 400);

  const id = 'sv_' + randHex(8);
  const key = videoR2Key(projectId, song.id, id, mime);
  const mpu = await env.MODELS.createMultipartUpload(key, {
    httpMetadata: { contentType: mime },
    customMetadata: { videoId: id, songId: song.id, projectId },
  });
  const t = nowIso();
  await env.DB.prepare(`
    INSERT INTO song_videos (id, project_id, song_id, title, note, source, r2_key, mime, size_bytes,
                             width, height, duration_sec, status, upload_id, part_size, created_by, created_at, updated_at, fingerprint)
    VALUES (?, ?, ?, ?, ?, 'upload', ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?, ?, ?, ?)
  `).bind(
    id, projectId, song.id,
    cleanVideoText(body?.title, VIDEO_TITLE_MAX) || titleFromFilename(filename),
    cleanVideoText(body?.note, VIDEO_NOTE_MAX),
    key, mime, size,
    cleanVideoDim(body?.width), cleanVideoDim(body?.height), cleanVideoDuration(body?.durationSec),
    mpu.uploadId, plan.partSize, me.id, t, t,
    // 瀏覽器交之前算好的檔案指紋（videoFingerprint.ts；格式不對就不存，之後排程從 R2 算）
    storage.cleanFingerprint(body?.fingerprint),
  ).run();
  // LED 版型（0034）：記下這一版做的時候用的版型（前端帶 templateId；沒帶 = 歌現在選的）
  await ledTpl.stampVideoTemplates(env, projectId, [{ id, songId: song.id }], 'templateId' in (body || {}) ? (body.templateId ?? null) : undefined);
  return songVideoResponse(env, ctx, { id }, 201);
}

async function uploadVideoPart(request, env, ctx, partNumberRaw) {
  const { me, song, role, video: v } = ctx;
  const d = videoModifyDecision({ role, userId: me.id, song, video: v });
  if (!d.ok) return jsonResp({ error: d.error }, d.status);
  if (v.status !== 'uploading' || !v.upload_id) {
    return jsonResp({ error: '這一版已經不在上傳中（可能已經完成或取消了）', status: v.status }, 409);
  }
  const plan = planParts(v.size_bytes, v.part_size);
  const n = Number(partNumberRaw);
  if (!Number.isInteger(n) || n < 1 || n > plan.partCount) {
    return jsonResp({ error: `段數不對（這個檔案是第 1 到第 ${plan.partCount} 段）` }, 400);
  }
  const expected = expectedPartSize(v.size_bytes, v.part_size, n);
  const lenHeader = request.headers.get('content-length');
  const len = lenHeader === null ? NaN : Number(lenHeader);
  if (len !== expected || !request.body) {
    return jsonResp({ error: `第 ${n} 段應該是 ${expected} bytes，收到 ${Number.isFinite(len) ? len : '不知道多少'} bytes`, expectedBytes: expected }, 400);
  }
  const mpu = env.MODELS.resumeMultipartUpload(v.r2_key, v.upload_id);
  let part;
  try {
    part = await mpu.uploadPart(n, request.body);
  } catch (e) {
    return jsonResp({ error: `第 ${n} 段沒有傳成功，請重傳這一段（${String(e?.message || e).slice(0, 120)}）` }, 502);
  }
  const t = nowIso();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO song_video_parts (video_id, part_number, etag, size_bytes) VALUES (?, ?, ?, ?)`
    ).bind(v.id, n, part.etag, expected),
    env.DB.prepare(
      `UPDATE song_videos SET bytes_done = (SELECT COALESCE(SUM(size_bytes), 0) FROM song_video_parts WHERE video_id = ?), updated_at = ?
        WHERE id = ? AND status = 'uploading'`
    ).bind(v.id, t, v.id),
    env.DB.prepare(`SELECT bytes_done FROM song_videos WHERE id = ?`).bind(v.id),
  ]);
  const bytesDone = results[2]?.results?.[0]?.bytes_done ?? null;
  return jsonResp({ ok: true, partNumber: n, etag: part.etag, bytesDone, totalBytes: v.size_bytes });
}

// 所有段都好了 → R2 合併 → 檢查大小 → 給版本號（上傳完成和後台複製完成共用）
async function completeVideoMultipart(env, v, request = null, meta = {}) {
  const pr = await env.DB.prepare(
    `SELECT part_number, etag, size_bytes FROM song_video_parts WHERE video_id = ? ORDER BY part_number`
  ).bind(v.id).all();
  const parts = pr.results || [];
  const plan = planParts(v.size_bytes, v.part_size);
  const missing = missingParts(plan.partCount, parts.map(p => p.part_number));
  if (missing.length) return { ok: false, status: 409, error: `還有 ${missing.length} 段沒傳完`, missingParts: missing.slice(0, 100) };
  for (const p of parts) {
    if (p.size_bytes !== expectedPartSize(v.size_bytes, v.part_size, p.part_number)) {
      return { ok: false, status: 409, error: `第 ${p.part_number} 段大小不對，請重傳這一段`, missingParts: [p.part_number] };
    }
  }
  const mpu = env.MODELS.resumeMultipartUpload(v.r2_key, v.upload_id);
  let obj;
  try {
    obj = await mpu.complete(parts.map(p => ({ partNumber: p.part_number, etag: p.etag })));
  } catch (e) {
    // 同時按了兩次完成：另一個已經合併好了
    const now = await env.DB.prepare(`SELECT status, version FROM song_videos WHERE id = ? LIMIT 1`).bind(v.id).first();
    if (now?.status === 'ready') return { ok: true, version: now.version };
    return { ok: false, status: 502, error: `合併檔案失敗，請再按一次完成（${String(e?.message || e).slice(0, 120)}）` };
  }
  if (obj?.size !== v.size_bytes) {
    try { await env.MODELS.delete(v.r2_key); } catch { /* ignore */ }
    await failSongVideo(env, v, `合併後的檔案大小不對（應該 ${v.size_bytes}，結果 ${obj?.size}），請重新交一次`);
    return { ok: false, status: 500, error: '合併後的檔案大小不對，請重新交一次' };
  }
  const row = await finalizeVideoReady(env, v, request, meta);
  return { ok: true, version: row?.version ?? null };
}

// 給版本號 + 標成可以播（同一個交易：歌的計數 +1、這一版拿到號碼；號碼只增不減，刪掉的也不會再用）
async function finalizeVideoReady(env, v, request = null, meta = {}) {
  const t = nowIso();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE songs
         SET video_version_seq = MAX(video_version_seq, (SELECT COALESCE(MAX(version), 0) FROM song_videos WHERE song_id = ?)) + 1
       WHERE id = ? AND EXISTS (SELECT 1 FROM song_videos WHERE id = ? AND version IS NULL
                                  AND status IN ('uploading', 'processing') AND deleted_at IS NULL)
    `).bind(v.song_id, v.song_id, v.id),
    env.DB.prepare(`
      UPDATE song_videos
         SET version = (SELECT video_version_seq FROM songs WHERE id = ?), status = 'ready', ready_at = ?, updated_at = ?,
             error = NULL, upload_id = NULL, lease_until = NULL, stall_count = 0, bytes_done = COALESCE(size_bytes, bytes_done),
             copy_url = CASE WHEN copy_kind = 'url' THEN NULL ELSE copy_url END,
             width = COALESCE(?, width), height = COALESCE(?, height), duration_sec = COALESCE(?, duration_sec)
       WHERE id = ? AND version IS NULL AND status IN ('uploading', 'processing') AND deleted_at IS NULL
    `).bind(v.song_id, t, t, meta.width ?? null, meta.height ?? null, meta.durationSec ?? null, v.id),
    env.DB.prepare(`DELETE FROM song_video_parts WHERE video_id = ?`).bind(v.id),
    env.DB.prepare(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`).bind(v.project_id),
  ]);
  const row = await env.DB.prepare(`SELECT version, status FROM song_videos WHERE id = ? LIMIT 1`).bind(v.id).first();
  if (row?.status === 'ready') {
    await logActivity(request, env, v.project_id, 'create', 'song_video', v.id, {
      songId: v.song_id, version: row.version, label: versionLabel(row.version), source: v.source, title: v.title,
      createdBy: v.created_by || null,
    });
    // 新的一版好了：歌在「需修改」→ 自動回到「審查中」；通知導演「新版等你審」（reviews.mjs）
    const after = await reviews.afterVideoReady(env.DB, { videoId: v.id });
    if (after.autoSubmitted) {
      await logActivity(request, env, v.project_id, 'update', 'song', v.song_id, {
        statusFrom: 'needs_changes', statusTo: 'in_review', auto: true, label: versionLabel(row.version),
      });
    }
  }
  return row;
}

async function failSongVideo(env, v, message) {
  // 重新讀 upload_id（這一輪中途才開的分段上傳也要取消）
  const cur = await env.DB.prepare(`SELECT r2_key, upload_id FROM song_videos WHERE id = ? LIMIT 1`).bind(v.id).first();
  if (cur?.upload_id) {
    try { await env.MODELS.resumeMultipartUpload(cur.r2_key, cur.upload_id).abort(); } catch { /* 已經沒了 */ }
  }
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE song_videos SET status = 'failed', error = ?, upload_id = NULL, lease_until = NULL, updated_at = ?
       WHERE id = ? AND status IN ('uploading', 'processing')
    `).bind(String(message).slice(0, 500), nowIso(), v.id),
    env.DB.prepare(`DELETE FROM song_video_parts WHERE video_id = ?`).bind(v.id),
  ]);
}

async function completeVideoUpload(request, env, ctx) {
  const { me, song, role, video: v } = ctx;
  const d = videoModifyDecision({ role, userId: me.id, song, video: v });
  if (!d.ok) return jsonResp({ error: d.error }, d.status);
  if (v.status === 'ready') return songVideoResponse(env, ctx, v);  // 按了兩次
  if (v.status !== 'uploading' || !v.upload_id) return jsonResp({ error: '這一版不在上傳中', status: v.status }, 409);
  let body = {};
  try { body = await request.json(); } catch { /* 沒帶也可以 */ }
  const r = await completeVideoMultipart(env, v, request, {
    width: cleanVideoDim(body?.width), height: cleanVideoDim(body?.height), durationSec: cleanVideoDuration(body?.durationSec),
  });
  if (!r.ok) return jsonResp({ error: r.error, ...(r.missingParts ? { missingParts: r.missingParts } : {}) }, r.status);
  return songVideoResponse(env, ctx, v);
}

// 取消上傳 / 複製（還沒好的才能取消；好了的請用刪除）
async function abortSongVideo(request, env, ctx) {
  const { me, song, role, video: v } = ctx;
  const d = videoModifyDecision({ role, userId: me.id, song, video: v });
  if (!d.ok) return jsonResp({ error: d.error }, d.status);
  if (v.status !== 'uploading' && v.status !== 'processing') {
    return jsonResp({ error: v.status === 'ready' ? '這一版已經好了；不要的話請用「刪除」' : '這一版已經停了', status: v.status }, 409);
  }
  await cancelAndHideVideo(env, v, '已取消');
  return jsonResp({ ok: true });
}

async function cancelAndHideVideo(env, v, reason, byUserId = null) {
  if (v.upload_id) {
    try { await env.MODELS.resumeMultipartUpload(v.r2_key, v.upload_id).abort(); } catch { /* ignore */ }
  }
  const now = Date.now();
  const t = new Date(now).toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE song_videos
         SET deleted_at = ?, updated_at = ?, lease_until = NULL, upload_id = NULL,
             purge_after = ?, deleted_by = ?,
             status = CASE WHEN status IN ('uploading', 'processing') THEN 'failed' ELSE status END,
             error = CASE WHEN status IN ('uploading', 'processing') THEN ? ELSE error END
       WHERE id = ? AND deleted_at IS NULL
    `).bind(t, t, storage.purgeAfterIso(now), byUserId, reason, v.id),
    env.DB.prepare(`DELETE FROM song_video_parts WHERE video_id = ?`).bind(v.id),
  ]);
}

async function patchSongVideo(request, env, ctx) {
  const { me, song, role, video: v } = ctx;
  const d = videoModifyDecision({ role, userId: me.id, song, video: v });
  if (!d.ok) return jsonResp({ error: d.error }, d.status);
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonResp({ error: 'Invalid JSON' }, 400);
  const sets = [], values = [];
  if ('title' in body) { sets.push('title = ?'); values.push(cleanVideoText(body.title, VIDEO_TITLE_MAX)); }
  if ('note' in body) { sets.push('note = ?'); values.push(cleanVideoText(body.note, VIDEO_NOTE_MAX)); }
  if ('width' in body) { sets.push('width = ?'); values.push(cleanVideoDim(body.width)); }
  if ('height' in body) { sets.push('height = ?'); values.push(cleanVideoDim(body.height)); }
  if ('durationSec' in body) { sets.push('duration_sec = ?'); values.push(cleanVideoDuration(body.durationSec)); }
  if (!sets.length) return jsonResp({ error: '沒有可以改的欄位（title / note / width / height / durationSec）' }, 400);
  sets.push('updated_at = ?'); values.push(nowIso());
  await env.DB.prepare(`UPDATE song_videos SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).bind(...values, v.id).run();
  return songVideoResponse(env, ctx, v);
}

// 刪掉一版：從清單拿掉（R2 的檔案留 30 天，製作可以在「最近刪除」救回來，之後排程清掉）；號碼不會再用。還沒好的會順便取消
async function deleteSongVideo(request, env, ctx) {
  const { me, song, role, video: v } = ctx;
  const d = videoModifyDecision({ role, userId: me.id, song, video: v });
  if (!d.ok) return jsonResp({ error: d.error }, d.status);
  await cancelAndHideVideo(env, v, '已取消', me.id);
  await logActivity(request, env, ctx.projectId, 'delete', 'song_video', v.id, {
    songId: v.song_id, version: v.version, label: versionLabel(v.version), title: v.title,
  });
  return jsonResp({ ok: true });
}

// 救回刪掉的版本（storage.mjs；號碼不變）
async function restoreDeletedVideo(request, env, ctx, videoId) {
  const r = await storage.restoreVideo(env, { projectId: ctx.projectId, songId: ctx.song.id, videoId });
  if (r.row) {
    await logActivity(request, env, ctx.projectId, 'restore', 'song_video', videoId, {
      songId: ctx.song.id, version: r.row.version, label: versionLabel(r.row.version), title: r.row.title,
    });
  }
  return jsonResp(r.body, r.status);
}

// 專案結束清影片（storage.mjs）：只留每首歌最後通過的那一版 / 搬到長期存放
async function applyProjectWrapUp(request, env, ctx) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const r = await storage.applyWrapUp(env, { projectId: ctx.projectId, me: ctx.me, keep: body?.keep, storage: body?.storage });
  if (r.status === 200 && (r.body.removedCount || r.body.queuedForInfrequent)) {
    await logActivity(request, env, ctx.projectId, 'update', 'project', ctx.projectId, {
      wrapUp: true, keep: r.body.keep, storage: r.body.storage, removed: r.body.removed.map(x => x.label).slice(0, 50),
      removedCount: r.body.removedCount, queuedForInfrequent: r.body.queuedForInfrequent,
    });
  }
  return jsonResp(r.body, r.status);
}

// 複製失敗 → 重試（格式不支援 / 太大的不能重試）
async function retrySongVideo(request, env, ctx) {
  const { me, song, role, video: v } = ctx;
  const d = videoModifyDecision({ role, userId: me.id, song, video: v });
  if (!d.ok) return jsonResp({ error: d.error }, d.status);
  if (v.status !== 'failed' || !v.copy_kind || !v.r2_key) {
    return jsonResp({ error: v.status === 'failed' ? '這一版沒辦法重試（格式不支援或檔案太大），請換一個檔案' : '這一版沒有失敗，不用重試', status: v.status }, 409);
  }
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE song_videos SET status = 'processing', error = NULL, stall_count = 0, bytes_done = 0, lease_until = NULL,
                             upload_id = NULL, updated_at = ?,
                             copy_token_id = CASE WHEN copy_kind = 'drive_api' THEN COALESCE(
                               (SELECT id FROM oauth_tokens WHERE id = song_videos.copy_token_id),
                               (SELECT drive_oauth_token_id FROM projects WHERE id = song_videos.project_id),
                               copy_token_id) ELSE copy_token_id END
       WHERE id = ? AND status = 'failed' AND deleted_at IS NULL
    `).bind(nowIso(), v.id),
    env.DB.prepare(`DELETE FROM song_video_parts WHERE video_id = ?`).bind(v.id),
  ]);
  runInBackground(request, runVideoCopyJobs(env, { videoId: v.id, ...videoRequestStep(env) }));
  return songVideoResponse(env, ctx, v, 202);
}

// ── 貼連結 ──

async function driveFileMeta(env, tokenId, fileId, resourceKey) {
  const at = await driveGetAccessToken(env, tokenId);
  const headers = { Authorization: `Bearer ${at}` };
  if (resourceKey) headers['X-Goog-Drive-Resource-Keys'] = `${fileId}/${resourceKey}`;
  const params = new URLSearchParams({
    fields: 'id,name,mimeType,size,md5Checksum,modifiedTime,videoMediaMetadata,parents,ownedByMe',
    supportsAllDrives: 'true',
  });
  const r = await fetch(`${DRIVE_FILES_FETCH}/${encodeURIComponent(fileId)}?${params}`, { headers });
  let data = null;
  try { data = await r.json(); } catch { /* ignore */ }
  return { ok: r.ok, status: r.status, data };
}

async function probeVideoUrl(downloadUrl, kind, filenameHint, maxBytes, extra = {}) {
  let resp;
  try {
    resp = await fetch(downloadUrl, { headers: { Range: 'bytes=0-0', 'User-Agent': VIDEO_FETCH_UA }, redirect: 'follow' });
  } catch (e) {
    console.warn('[video probe]', String(e?.message || e).slice(0, 200));
    return { ok: false, error: '連不到來源網站，請確認連結打得開，或稍後再試' };
  }
  const headers = {};
  for (const k of ['content-type', 'content-range', 'content-length', 'content-disposition']) headers[k] = resp.headers.get(k);
  try { await resp.body?.cancel(); } catch { /* ignore */ }
  let hint = filenameHint;
  if (!hint) { try { hint = decodeURIComponent(new URL(resp.url || downloadUrl).pathname.split('/').pop() || ''); } catch { hint = ''; } }
  const p = interpretProbe({ status: resp.status, headers, kind, filenameHint: hint, maxBytes });
  if (!p.ok) return p;
  return { ok: true, copyKind: 'url', copyUrl: downloadUrl, mime: p.mime, size: p.size, rangeSupported: p.rangeSupported, filename: p.filename, ...extra };
}

// 貼的連結 → 實際去哪裡抓、多大、什麼格式（先試抓一下，不行就馬上回清楚的錯誤）
async function resolveVideoLinkSource(env, ctx, cls) {
  const maxBytes = videoMaxBytes(env);
  if (cls.kind !== 'drive') return probeVideoUrl(cls.downloadUrl, cls.kind, cls.filenameHint, maxBytes);

  const proj = await env.DB.prepare(
    `SELECT drive_folder_id, drive_oauth_token_id FROM projects WHERE id = ? LIMIT 1`
  ).bind(ctx.projectId).first();
  // 連接的 Google 帳號：專案綁的那個優先，沒有就用最近用過的
  const tok = await env.DB.prepare(
    `SELECT id FROM oauth_tokens WHERE provider = 'google' ORDER BY (id = ?) DESC, last_used_at DESC LIMIT 1`
  ).bind(proj?.drive_oauth_token_id || '').first();
  if (tok) {
    let meta = null;
    try { meta = await driveFileMeta(env, tok.id, cls.fileId, cls.resourceKey); } catch (e) { console.warn('[drive meta]', e?.message || e); }
    if (meta?.ok && meta.data) {
      const f = meta.data;
      if (String(f.mimeType || '').startsWith('application/vnd.google-apps.')) {
        return { ok: false, error: '這是 Google 文件 / 資料夾，不是影片檔' };
      }
      // 連接的帳號自己的檔案（不在這個專案的 Drive 資料夾裡）只有 admin 能拿 → 不讓別人用連結把 admin 的私人影片抓出來
      const inProjectFolder = !!proj?.drive_folder_id && (f.parents || []).includes(proj.drive_folder_id);
      if (ctx.role === 'admin' || !f.ownedByMe || inProjectFolder) {
        const p = interpretProbe({
          status: 206, kind: 'drive', filenameHint: f.name, knownMime: f.mimeType, maxBytes,
          headers: { 'content-type': f.mimeType || null, 'content-range': f.size ? `bytes 0-0/${f.size}` : null },
        });
        if (!p.ok) return p;
        const vm = f.videoMediaMetadata || {};
        return {
          ok: true, copyKind: 'drive_api', copyTokenId: tok.id, copyUrl: cls.resourceKey || null, driveFileId: f.id,
          mime: p.mime, size: p.size, rangeSupported: true, filename: f.name || '',
          width: cleanVideoDim(vm.width), height: cleanVideoDim(vm.height),
          durationSec: vm.durationMillis ? cleanVideoDuration(Number(vm.durationMillis) / 1000) : null,
          sourceRev: driveSourceRev(f),
        };
      }
    }
  }
  // 公開檔案（「知道連結的使用者都能查看」）→ 直接下載
  const pub = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(cls.fileId)}&export=download&confirm=t`
    + (cls.resourceKey ? `&resourcekey=${encodeURIComponent(cls.resourceKey)}` : '');
  return probeVideoUrl(pub, 'drive', '', maxBytes, { driveFileId: cls.fileId });
}

async function createVideoFromLink(request, env, ctx) {
  const { me, projectId, song, role } = ctx;
  // 導演也可以貼連結（上傳檔案還是只有製作和動畫師）
  const d = videoLinkDecision({ role, userId: me.id, song });
  if (!d.ok) return jsonResp({ error: d.error }, d.status);
  if (!env.MODELS) return jsonResp({ error: 'R2 not configured' }, 500);
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const cls = classifyVideoLink(body?.url, { selfHosts: [...VIDEO_SELF_HOSTS, new URL(request.url).hostname] });
  if (!cls.ok) return jsonResp({ error: cls.error }, 400);

  // 同一個連結剛剛貼過、還在複製 → 回那一版（按兩次不會變兩版）
  const dup = await env.DB.prepare(
    `SELECT id FROM song_videos WHERE song_id = ? AND original_url = ? AND status = 'processing' AND deleted_at IS NULL LIMIT 1`
  ).bind(song.id, cls.url).first();
  if (dup) return songVideoResponse(env, ctx, dup, 200, { duplicate: true });

  const src = await resolveVideoLinkSource(env, ctx, cls);
  if (!src.ok) return jsonResp({ error: src.error }, src.status || 422);

  const id = 'sv_' + randHex(8);
  const key = videoR2Key(projectId, song.id, id, src.mime);
  const plan = planParts(src.size, copyPartSize(env));
  const t = nowIso();
  await env.DB.prepare(`
    INSERT INTO song_videos (id, project_id, song_id, title, note, source, original_url, drive_file_id, source_rev,
                             r2_key, mime, size_bytes, width, height, duration_sec, status, part_size,
                             copy_kind, copy_url, copy_token_id, copy_mode, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'link', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, projectId, song.id,
    cleanVideoText(body?.title, VIDEO_TITLE_MAX) || titleFromFilename(src.filename),
    cleanVideoText(body?.note, VIDEO_NOTE_MAX),
    cls.url, src.driveFileId || null, src.sourceRev || null,
    key, src.mime, src.size, src.width ?? null, src.height ?? null, src.durationSec ?? null,
    plan.partSize, src.copyKind, src.copyUrl ?? null, src.copyTokenId ?? null, src.rangeSupported ? 'range' : 'single',
    me.id, t, t,
  ).run();
  await ledTpl.stampVideoTemplates(env, projectId, [{ id, songId: song.id }], 'templateId' in (body || {}) ? (body.templateId ?? null) : undefined);
  runInBackground(request, runVideoCopyJobs(env, { videoId: id, ...videoRequestStep(env) }));
  return songVideoResponse(env, ctx, { id }, 202);
}

// ── 後台複製（貼連結 / Drive 同步）──

async function fetchVideoSource(env, v, range = null) {
  const headers = {};
  if (range) headers.Range = `bytes=${range.start}-${range.end}`;
  if (v.copy_kind === 'drive_api') {
    let at;
    try {
      at = await driveGetAccessToken(env, v.copy_token_id);
    } catch (e) {
      if (/OAuth token not found/i.test(String(e?.message))) {
        throw new VideoCopyFatal('連接的 Google 帳號被移除了：請製作重新連接 Google 帳號後按「重試」');
      }
      throw e;
    }
    headers.Authorization = `Bearer ${at}`;
    if (v.copy_url) headers['X-Goog-Drive-Resource-Keys'] = `${v.drive_file_id}/${v.copy_url}`;
    return fetch(`${DRIVE_FILES_FETCH}/${encodeURIComponent(v.drive_file_id)}?alt=media&supportsAllDrives=true`, { headers });
  }
  headers['User-Agent'] = VIDEO_FETCH_UA;
  return fetch(v.copy_url, { headers, redirect: 'follow' });
}

function sourceFailure(v, status, fetches) {
  const kind = v.copy_kind === 'drive_api' ? 'drive' : 'direct';
  if ([401, 403, 404, 410].includes(status)) {
    const p = interpretProbe({ status, headers: {}, kind });
    return Object.assign(new VideoCopyFatal(`來源檔案打不開了：${p.error}`), { fetches });
  }
  return Object.assign(new Error(`來源網站回應 HTTP ${status}`), { fetches });
}

async function copyVideoRanges(env, v, { t0, budgetMs, maxFetches }) {
  let uploadId = v.upload_id;
  if (!uploadId) {
    const mpu = await env.MODELS.createMultipartUpload(v.r2_key, {
      httpMetadata: { contentType: v.mime },
      customMetadata: { videoId: v.id, songId: v.song_id, projectId: v.project_id },
    });
    uploadId = mpu.uploadId;
    await env.DB.prepare(`UPDATE song_videos SET upload_id = ? WHERE id = ?`).bind(uploadId, v.id).run();
    v = { ...v, upload_id: uploadId };
  }
  const mpu = env.MODELS.resumeMultipartUpload(v.r2_key, uploadId);
  const pr = await env.DB.prepare(`SELECT part_number FROM song_video_parts WHERE video_id = ?`).bind(v.id).all();
  const done = new Set((pr.results || []).map(p => p.part_number));
  let fetches = 0;
  for (;;) {
    const next = nextCopyPart({ size: v.size_bytes, partSize: v.part_size, doneParts: done });
    if (!next) break;
    if (fetches >= maxFetches || Date.now() - t0 > budgetMs) break;
    fetches++;
    const resp = await fetchVideoSource(env, v, next);
    if (resp.status !== 206) {
      try { await resp.body?.cancel(); } catch { /* ignore */ }
      if (resp.status === 200) {
        // 來源不給分段了 → 改成一次複製（下一輪做）
        try { await mpu.abort(); } catch { /* ignore */ }
        await env.DB.batch([
          env.DB.prepare(`UPDATE song_videos SET copy_mode = 'single', upload_id = NULL, bytes_done = 0, lease_until = NULL WHERE id = ?`).bind(v.id),
          env.DB.prepare(`DELETE FROM song_video_parts WHERE video_id = ?`).bind(v.id),
        ]);
        return { fetches };
      }
      throw sourceFailure(v, resp.status, fetches);
    }
    const cr = resp.headers.get('content-range') || '';
    const m = /^bytes (\d+)-(\d+)\//.exec(cr);
    if (!m || Number(m[1]) !== next.start || Number(m[2]) !== next.end) {
      try { await resp.body?.cancel(); } catch { /* ignore */ }
      throw Object.assign(new Error(`來源給的範圍不對（要 ${next.start}-${next.end}，給 ${cr || '沒寫'}）`), { fetches });
    }
    const len = Number(resp.headers.get('content-length'));
    let payload = resp.body;
    if (len !== next.length) {
      payload = await resp.arrayBuffer();
      if (payload.byteLength !== next.length) throw Object.assign(new Error('這一段的大小不對'), { fetches });
    }
    const part = await mpu.uploadPart(next.partNumber, payload);
    done.add(next.partNumber);
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR REPLACE INTO song_video_parts (video_id, part_number, etag, size_bytes) VALUES (?, ?, ?, ?)`
      ).bind(v.id, next.partNumber, part.etag, next.length),
      env.DB.prepare(`
        UPDATE song_videos
           SET bytes_done = (SELECT COALESCE(SUM(size_bytes), 0) FROM song_video_parts WHERE video_id = ?),
               stall_count = 0, error = NULL, lease_until = ?, updated_at = ?
         WHERE id = ? AND status = 'processing' AND deleted_at IS NULL
      `).bind(v.id, Date.now() + budgetMs + VIDEO_COPY_LEASE_EXTRA_MS, nowIso(), v.id),
    ]);
    if (!results[1]?.meta?.changes) return { fetches, cancelled: true };  // 中途被取消 / 刪掉
  }
  if (!nextCopyPart({ size: v.size_bytes, partSize: v.part_size, doneParts: done })) {
    const r = await completeVideoMultipart(env, v);
    if (!r.ok) throw Object.assign(new Error(r.error), { fetches });
    return { fetches, ready: true };
  }
  await env.DB.prepare(`UPDATE song_videos SET lease_until = NULL WHERE id = ? AND status = 'processing'`).bind(v.id).run();
  return { fetches };
}

async function copyVideoSingle(env, v) {
  const resp = await fetchVideoSource(env, v, null);
  if (!resp.ok) {
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    throw sourceFailure(v, resp.status, 1);
  }
  const lenHeader = resp.headers.get('content-length');
  const len = lenHeader === null ? null : Number(lenHeader);
  if (len !== null && len !== v.size_bytes) {
    try { await resp.body?.cancel(); } catch { /* ignore */ }
    throw Object.assign(new VideoCopyFatal(`來源檔案大小變了（原本 ${formatBytes(v.size_bytes)}，現在 ${formatBytes(len)}），請重新貼一次連結`), { fetches: 1 });
  }
  let payload = resp.body;
  if (len === null) {
    // 來源沒說多大 → 用貼連結時量到的大小，不對就失敗
    const { readable, writable } = new FixedLengthStream(v.size_bytes);
    resp.body.pipeTo(writable).catch(() => { /* put 會失敗 */ });
    payload = readable;
  }
  const obj = await env.MODELS.put(v.r2_key, payload, { httpMetadata: { contentType: v.mime } });
  if (obj?.size !== v.size_bytes) throw Object.assign(new Error('複製後的大小不對'), { fetches: 1 });
  await finalizeVideoReady(env, v);
  return { fetches: 1, ready: true };
}

// 複製一輪：先搶到「這一輪我在做」（lease），做到時間 / 次數用完就放手，下次接著做
async function runVideoCopyStep(env, videoId, { budgetMs, maxFetches, allowLongSingle = false }) {
  const t0 = Date.now();
  const head = await env.DB.prepare(
    `SELECT copy_mode, size_bytes FROM song_videos WHERE id = ? AND status = 'processing' AND deleted_at IS NULL LIMIT 1`
  ).bind(videoId).first();
  if (!head) return { fetches: 0, skipped: true };
  const single = head.copy_mode === 'single';
  if (single && !allowLongSingle && (head.size_bytes || 0) > VIDEO_SINGLE_IN_REQUEST_MAX) return { fetches: 0, skipped: true };
  const leaseMs = single ? (allowLongSingle ? 16 * 60_000 : 45_000) : budgetMs + VIDEO_COPY_LEASE_EXTRA_MS;
  const got = await env.DB.prepare(`
    UPDATE song_videos SET lease_until = ?, stall_count = stall_count + 1
     WHERE id = ? AND status = 'processing' AND deleted_at IS NULL AND (lease_until IS NULL OR lease_until < ?)
  `).bind(t0 + leaseMs, videoId, t0).run();
  if (!got.meta?.changes) return { fetches: 0, skipped: true };
  const v = await env.DB.prepare(`SELECT * FROM song_videos WHERE id = ? LIMIT 1`).bind(videoId).first();
  if (!v) return { fetches: 0, skipped: true };
  if (v.stall_count > VIDEO_COPY_MAX_STALLS) {
    await failSongVideo(env, v, `複製一直沒有進度（試了 ${VIDEO_COPY_MAX_STALLS} 次），來源網站可能太慢或擋住了；請稍後按「重試」，或下載後用「上傳」交`);
    return { fetches: 0, failed: true };
  }
  try {
    return single ? await copyVideoSingle(env, v) : await copyVideoRanges(env, v, { t0, budgetMs, maxFetches });
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    if (e instanceof VideoCopyFatal) {
      await failSongVideo(env, v, msg);
    } else {
      // 這一輪對外請求次數用完（Cloudflare 的限制）不算「沒進度」
      const limitHit = /too many subrequests/i.test(msg) ? 1 : 0;
      await env.DB.prepare(
        `UPDATE song_videos SET lease_until = NULL, error = ?, updated_at = ?,
                stall_count = CASE WHEN ? = 1 THEN MAX(stall_count - 1, 0) ELSE stall_count END
          WHERE id = ? AND status = 'processing'`
      ).bind(limitHit ? null : `上次複製出錯（會自動重試）：${msg}`, nowIso(), limitHit, v.id).run();
    }
    console.warn('[video copy]', v.id, msg);
    return { fetches: e?.fetches ?? 1, error: msg };
  }
}

/**
 * 做幾個等著複製的工作（照建立時間，一個做完再做下一個 → 版本號照時間排）
 * filter：{ videoId } / { songId } / { projectId }，都沒給 = 全部
 */
async function runVideoCopyJobs(env, { videoId = null, songId = null, projectId = null, budgetMs, maxFetches, allowLongSingle = false } = {}) {
  if (!env.DB || !env.MODELS) return;
  const t0 = Date.now();
  let fetchesLeft = maxFetches;
  const where = ['status = \'processing\'', 'deleted_at IS NULL', '(lease_until IS NULL OR lease_until < ?)'];
  const binds = [t0];
  if (videoId) { where.push('id = ?'); binds.push(videoId); }
  if (songId) { where.push('song_id = ?'); binds.push(songId); }
  if (projectId) { where.push('project_id = ?'); binds.push(projectId); }
  const r = await env.DB.prepare(
    `SELECT id FROM song_videos WHERE ${where.join(' AND ')} ORDER BY created_at LIMIT 20`
  ).bind(...binds).all();
  for (const row of (r.results || [])) {
    const left = budgetMs - (Date.now() - t0);
    if (left < 3000 || fetchesLeft <= 0) break;
    const res = await runVideoCopyStep(env, row.id, { budgetMs: left, maxFetches: fetchesLeft, allowLongSingle });
    fetchesLeft -= res?.fetches || 0;
  }
}

// 上傳到一半就沒再動的（超過 2 天）→ 取消，R2 的半成品清掉
async function cleanupStaleVideoUploads(env) {
  if (!env.DB || !env.MODELS) return;
  const cutoff = new Date(Date.now() - VIDEO_STALE_UPLOAD_MS).toISOString();
  const r = await env.DB.prepare(
    `SELECT * FROM song_videos WHERE status = 'uploading' AND deleted_at IS NULL AND updated_at < ? LIMIT 20`
  ).bind(cutoff).all();
  for (const v of (r.results || [])) await cancelAndHideVideo(env, v, '上傳中斷超過 2 天，已自動取消');
}

// Drive 同步：新的 / 內容改過的影片 → 建一版、排進複製（不支援的格式 / 太大的也建一筆「失敗」讓人知道原因）
// 哪些要建在 videos.mjs 的 planDriveVersions（有測試）
async function queueDriveVideoVersions(env, proj, pairs) {
  if (!pairs.some(p => p.songId)) return 0;
  // 刪掉的版本也算看過（不然刪了下次同步又冒出來）；貼 Drive 連結交過的同一個檔案、同一個內容也算
  const seenR = await env.DB.prepare(
    `SELECT song_id, drive_file_id, source_rev FROM song_videos WHERE project_id = ? AND drive_file_id IS NOT NULL AND source_rev IS NOT NULL`
  ).bind(proj.id).all();
  const seen = new Set((seenR.results || []).map(r => driveVersionKey(r.song_id, r.drive_file_id, r.source_rev)));
  const plan = planDriveVersions({ pairs, seen, maxBytes: videoMaxBytes(env) });
  if (!plan.length) return 0;
  const base = Date.now();
  const partSize = copyPartSize(env);
  const createdRows = [];
  const stmts = plan.map((p, i) => {
    const id = 'sv_' + randHex(8);
    createdRows.push({ id, songId: p.songId });
    const created = new Date(base + i).toISOString();  // 一批裡也照 Drive 時間排
    const ok = p.status === 'processing';
    return env.DB.prepare(`
      INSERT INTO song_videos (id, project_id, song_id, title, source, drive_file_id, source_rev, r2_key, mime, size_bytes,
                               width, height, duration_sec, status, error, part_size, copy_kind, copy_token_id, copy_mode,
                               created_at, updated_at)
      VALUES (?, ?, ?, ?, 'drive', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'range', ?, ?)
    `).bind(
      id, proj.id, p.songId, titleFromFilename(p.file.name), p.file.id, p.rev,
      p.mime ? videoR2Key(proj.id, p.songId, id, p.mime) : '',
      p.mime || cleanVideoText(p.file.mimeType, 100) || 'application/octet-stream', p.size,
      p.width, p.height, p.durationSec, p.status, p.error,
      p.size ? planParts(p.size, partSize).partSize : null,
      ok ? 'drive_api' : null, proj.drive_oauth_token_id, created, created,
    );
  });
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await ledTpl.stampVideoTemplates(env, proj.id, createdRows).catch(() => {});
  return plan.filter(p => p.status === 'processing').length;
}

// ── 播放（R2，支援 Range）──

// playback.noStore：分享連結「禁止下載」的影片不讓瀏覽器 / 快取存起來
async function serveR2Video(request, env, v, playback = {}) {
  if (!env.MODELS) return jsonResp({ error: 'R2 not configured' }, 500);
  const isHead = request.method === 'HEAD';
  const size = Number(v.size_bytes);
  // Range 自己解析（大小資料庫有），本機和正式的 R2 行為才會一樣
  const range = isHead ? null : parseRangeHeader(request.headers.get('range'), size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...corsHeaders(), 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' } });
  }
  const opts = { onlyIf: request.headers };
  if (range) opts.range = { offset: range.start, length: range.end - range.start + 1 };
  let obj;
  try {
    obj = isHead ? await env.MODELS.head(v.r2_key) : await env.MODELS.get(v.r2_key, opts);
  } catch (e) {
    console.warn('[video stream]', v.id, String(e?.message || e).slice(0, 200));
    return jsonResp({ error: '讀影片檔失敗，請再試一次' }, 502);
  }
  if (!obj) return jsonResp({ error: '找不到這個影片檔' }, 404);
  const headers = new Headers(corsHeaders());
  headers.set('Content-Type', v.mime || obj.httpMetadata?.contentType || 'video/mp4');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('ETag', obj.httpEtag);
  headers.set('Last-Modified', obj.uploaded.toUTCString());
  // 每一版一個網址、內容永遠不變 → 瀏覽器可以一直快取（要登入才看得到 → private，CDN 不存）
  headers.set('Cache-Control', sharePlaybackCacheControl(!!playback.noStore));
  headers.set('Content-Disposition', 'inline');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (isHead) {
    headers.set('Content-Length', String(obj.size));
    return new Response(null, { status: 200, headers });
  }
  if (!('body' in obj) || !obj.body) {
    // If-None-Match / If-Modified-Since 對上 → 304；If-Match 對不上 → 412
    const notModified = request.headers.has('if-none-match') || request.headers.has('if-modified-since');
    return new Response(null, { status: notModified ? 304 : 412, headers });
  }
  if (range) {
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${obj.size}`);
    headers.set('Content-Length', String(range.end - range.start + 1));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

// /api/videos/:videoId/stream?pass=<通行證>（清單回的 streamUrl）；沒帶通行證也可以用登入身分
async function handleMemberVideoStream(request, env, url, videoId) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  if (!ID_RE.test(videoId || '')) return jsonResp({ error: '找不到這一版影片' }, 404);
  const pass = url.searchParams.get('pass');
  let userId = pass ? await verifyVideoPass(getAuthSecret(env), pass, { videoId }) : null;
  if (!userId) {
    const me = await getCurrentUser(request, env);
    userId = me?.id || null;
  }
  if (!userId) {
    return jsonResp(pass
      ? { error: '播放網址過期了，請重新整理頁面', passExpired: true }
      : { error: '未登入' }, 401);
  }
  const row = await env.DB.prepare(`
    SELECT v.id, v.r2_key, v.mime, v.size_bytes, v.status, v.deleted_at,
           p.status AS project_status, u.role AS user_role, u.deactivated, pm.role AS member_role
      FROM song_videos v
      JOIN projects p ON p.id = v.project_id
      LEFT JOIN users u ON u.id = ?
      LEFT JOIN project_members pm ON pm.project_id = v.project_id AND pm.user_id = ?
     WHERE v.id = ? LIMIT 1
  `).bind(userId, userId, videoId).first();
  if (!row || row.status !== 'ready' || row.deleted_at) return jsonResp({ error: '找不到這一版影片' }, 404);
  if (!row.user_role || row.deactivated) return jsonResp({ error: '未登入' }, 401);
  const role = projectRoleOf(row.user_role, row.member_role);
  if (!role) return jsonResp({ error: '沒有權限存取此專案' }, 403);
  if (row.project_status === 'archived' && row.user_role !== 'admin') return jsonResp({ error: '找不到這一版影片' }, 404);
  return serveR2Video(request, env, row);
}

// 刪歌時：那首歌的影片（R2 檔案、還沒傳完的分段）一起清掉
async function cleanupSongVideoFiles(env, rows) {
  if (!env.MODELS) return;
  const keys = [];
  for (const v of rows || []) {
    if (v.upload_id) { try { await env.MODELS.resumeMultipartUpload(v.r2_key, v.upload_id).abort(); } catch { /* ignore */ } }
    if (v.r2_key) keys.push(v.r2_key);
  }
  for (let i = 0; i < keys.length; i += 500) {
    try { await env.MODELS.delete(keys.slice(i, i + 500)); } catch (e) { console.warn('[song video cleanup]', e?.message || e); }
  }
}

// ── HTML helper（OAuth callback 用）──
function htmlPage(body) {
  const html = `<!doctype html>
<html lang="zh-TW"><head>
<meta charset="utf-8"><title>Stage Previz · Drive</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #16181c; color: #e8eaed; padding: 40px; max-width: 600px; margin: 0 auto; }
  h1 { color: #10c78a; }
  a { color: #10c78a; }
  strong { color: #fff; }
</style>
</head><body>${body}</body></html>`;
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 過濾 OAuth return URL — 只允許白名單 origin，避免被當 open redirect
function sanitizeReturnUrl(raw) {
  const allowedHosts = [
    'stage-previz.vercel.app',
    'haimiaan.com',
    'localhost',
    '127.0.0.1',
  ];
  if (!raw || typeof raw !== 'string') return 'https://stage-previz.vercel.app/admin/drive-sources';
  // 相對路徑 → 直接配 vercel
  if (raw.startsWith('/')) {
    return 'https://stage-previz.vercel.app' + raw;
  }
  try {
    const u = new URL(raw);
    const host = u.hostname;
    const okHost = allowedHosts.some(h => host === h || host.endsWith('.' + h));
    if (!okHost) return 'https://stage-previz.vercel.app/admin/drive-sources';
    return u.toString();
  } catch {
    return 'https://stage-previz.vercel.app/admin/drive-sources';
  }
}

// ─────────────────────────────────────────────
// 公開分享連結（share_links）
//
// admin / director 可建立 token → 寄給外部人；對方瀏覽器
// 開 https://previz.haimiaan.com/share/<token>（舊式）或 /s/<網址名稱>（好讀網址，可選）
// 直接看 read-only preview
// ─────────────────────────────────────────────

// 網址名稱（slug）：沒給 / 空字串 → null（不用好讀網址）；給了就整理 + 檢查
// 回 { slug } 或 { error }（中文說明）
function parseSlugInput(raw) {
  if (raw === undefined || raw === null) return { slug: null };
  if (typeof raw !== 'string') return { error: '網址名稱格式不對' };
  const slug = normalizeSlugInput(raw);
  if (!slug) return { slug: null };
  const problem = slugProblem(slug);
  if (problem) return { error: slugProblemMessage(problem, slug) };
  return { slug };
}

function isSlugTakenError(e) {
  const msg = String(e?.message || e || '');
  return /UNIQUE/i.test(msg) && /slug/i.test(msg);
}

const SLUG_TAKEN_MESSAGE = '這個網址已經有人用了，請換一個名字（或勾「加上隨機碼」）';

async function handleProjectShareLinks(request, env, ctx, token) {
  // /api/projects/:projectId/share-links               GET / POST
  // /api/projects/:projectId/share-links/:token        DELETE / PATCH（改網址名稱 { slug: '...' | null }）
  // 權限（admin 或這個專案的導演）、專案在不在、封存與否都在 handleProjectsRouter 檢查過了
  const { me, projectId } = ctx;
  if (token !== null && !/^[a-zA-Z0-9_-]{1,64}$/.test(token)) return jsonResp({ error: 'Invalid token' }, 400);

  if (!token) {
    if (request.method === 'GET') {
      const r = await env.DB.prepare(
        `SELECT l.token, l.slug, l.project_id, l.song_id,
                (l.password_hash IS NOT NULL OR l.password IS NOT NULL) AS has_password,
                l.expires_at, l.view_count, l.last_viewed_at, l.created_at, l.allow_comments, l.label,
                l.watermark, l.no_download,
                (SELECT COUNT(*) FROM comments c WHERE c.share_token = l.token) AS guest_comments
           FROM share_links l WHERE l.project_id = ? ORDER BY l.created_at DESC`
      ).bind(projectId).all();
      const rows = r.results || [];
      // 連結編號（浮水印上印的那組）：製作對得到是哪一條連結
      const shortIds = await Promise.all(rows.map(l => shortLinkId(l.token)));
      return jsonResp({
        links: rows.map((l, i) => ({
          token: l.token,
          slug: l.slug || null,
          projectId: l.project_id,
          songId: l.song_id,
          hasPassword: !!l.has_password,
          expiresAt: l.expires_at,
          viewCount: l.view_count,
          lastViewedAt: l.last_viewed_at,
          createdAt: l.created_at,
          // 0026：允許看的人留言（預設關）、連結名稱、訪客留了幾則
          allowComments: !!l.allow_comments,
          label: l.label || null,
          guestCommentCount: Number(l.guest_comments) || 0,
          // 0038：浮水印、禁止下載（舊連結都是關）、連結編號
          ...protectionOfRow(l),
          shortId: shortIds[i],
        })),
      });
    }
    if (request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      let songId = null;
      if (body?.songId) {
        if (typeof body.songId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.songId)) return jsonResp({ error: 'Invalid songId' }, 400);
        // 只能分享這個專案的歌
        const s = await env.DB.prepare(`SELECT id FROM songs WHERE id = ? AND project_id = ? LIMIT 1`).bind(body.songId, projectId).first();
        if (!s) return jsonResp({ error: '這個專案裡找不到這首歌' }, 404);
        songId = body.songId;
      }
      const password = typeof body?.password === 'string' && body.password ? body.password.slice(0, SHARE_PASSWORD_MAX) : null;
      const expiresInDays = typeof body?.expiresInDays === 'number' && body.expiresInDays > 0 ? Math.min(body.expiresInDays, 365) : null;
      const parsed = parseSlugInput(body?.slug);
      if (parsed.error) return jsonResp({ error: parsed.error }, 400);
      // 允許看的人留言（只有製作能打開）、連結名稱
      const extra = guest.shareLinkCommentFields(body, ctx.role);
      if (!extra.ok) return jsonResp({ error: extra.error }, extra.status);
      // 0038：浮水印、禁止下載；沒給（舊版前端）= 新連結的預設，兩個都開
      const prot = resolveNewLinkProtection(body);
      if (!prot.ok) return jsonResp({ error: prot.error }, 400);
      const tk = randHex(16);
      const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400_000).toISOString() : null;
      // 密碼只存加鹽雜湊，不存明文
      const hashed = password ? await hashSharePassword(password) : null;
      try {
        await env.DB.prepare(`
          INSERT INTO share_links (token, project_id, song_id, password, password_hash, password_salt, expires_at, created_by_user_id, slug,
                                   allow_comments, label, watermark, no_download)
          VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(tk, projectId, songId, hashed?.hash ?? null, hashed?.salt ?? null, expiresAt, me.id, parsed.slug,
          extra.fields.allow_comments ?? 0, extra.fields.label ?? null, prot.fields.watermark, prot.fields.no_download).run();
      } catch (e) {
        if (isSlugTakenError(e)) return jsonResp({ error: SLUG_TAKEN_MESSAGE, slugTaken: true }, 409);
        throw e;
      }
      return jsonResp({
        token: tk, slug: parsed.slug, expiresAt,
        allowComments: !!extra.fields.allow_comments, label: extra.fields.label ?? null,
        ...protectionOfRow(prot.fields), shortId: await shortLinkId(tk),
      }, 201);
    }
    return jsonResp({ error: 'Method not allowed' }, 405);
  }

  if (request.method === 'DELETE') {
    await env.DB.prepare(
      `DELETE FROM share_links WHERE token = ? AND project_id = ?`
    ).bind(token, projectId).run();
    return jsonResp({ ok: true });
  }
  if (request.method === 'PATCH') {
    // 設定 / 換 / 拿掉好讀網址。換掉之後舊的網址名稱馬上失效（舊式 /share/<連結碼> 照樣能用）
    // 可以改：好讀網址（slug）、允許看的人留言（allowComments，打開只有製作）、連結名稱（label）；舊版前端只送 slug
    let body = {};
    try { body = await request.json(); } catch {}
    const hasSlug = !!body && 'slug' in body;
    const extra = guest.shareLinkCommentFields(body, ctx.role);
    if (!extra.ok) return jsonResp({ error: extra.error }, extra.status);
    // 0038：浮水印、禁止下載（有給的才改）
    const prot = resolveLinkProtectionPatch(body);
    if (!prot.ok) return jsonResp({ error: prot.error }, 400);
    if (!hasSlug && Object.keys(extra.fields).length === 0 && Object.keys(prot.fields).length === 0) return jsonResp({ error: '缺少 slug' }, 400);
    const sets = [];
    const vals = [];
    let parsed = null;
    if (hasSlug) {
      parsed = parseSlugInput(body.slug);
      if (parsed.error) return jsonResp({ error: parsed.error }, 400);
      sets.push('slug = ?'); vals.push(parsed.slug);
    }
    for (const [k, v] of Object.entries(extra.fields)) { sets.push(`${k} = ?`); vals.push(v); }
    for (const [k, v] of Object.entries(prot.fields)) { sets.push(`${k} = ?`); vals.push(v); }
    let changes = 0;
    try {
      const r = await env.DB.prepare(
        `UPDATE share_links SET ${sets.join(', ')} WHERE token = ? AND project_id = ?`
      ).bind(...vals, token, projectId).run();
      changes = r.meta?.changes ?? 0;
    } catch (e) {
      if (isSlugTakenError(e)) return jsonResp({ error: SLUG_TAKEN_MESSAGE, slugTaken: true }, 409);
      throw e;
    }
    if (!changes) return jsonResp({ error: '找不到這個分享連結' }, 404);
    const cur = await env.DB.prepare(`SELECT slug, allow_comments, label, watermark, no_download FROM share_links WHERE token = ? LIMIT 1`).bind(token).first();
    return jsonResp({ ok: true, token, slug: cur?.slug ?? null, allowComments: !!cur?.allow_comments, label: cur?.label ?? null, ...protectionOfRow(cur) });
  }
  return jsonResp({ error: 'Method not allowed' }, 405);
}

// 分享連結過期了沒。expires_at 存的是 toISOString()（有 Z）；沒有時區的（SQLite datetime 格式）當 UTC。
// （以前寫成 expires_at + 'Z' → 變成「…ZZ」解析失敗，設了有效期的連結永遠不會過期）
function shareLinkExpired(expiresAt, now = Date.now()) {
  if (!expiresAt) return false;
  const s = String(expiresAt).trim();
  const t = Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) && t < now;
}

// ── 公開存取（read-only，無需登入）──
// ref ={ kind: 'token', key: 連結碼 }（/api/share/...）或 { kind: 'slug', key: 網址名稱 }（/api/s/...）
//
// 有密碼的連結：
//   第一次：X-Share-Password header 帶密碼（不收網址上的密碼）→ 對了就發「通行證」（8 小時，/data 回傳 access.token）
//   之後：X-Share-Access header 帶通行證就好；影片 <video src> 帶不了 header → 影片網址後面已經接好 ?access=<通行證>
//   （只有影片串流收網址上的通行證）
//   舊版前端每個請求都帶密碼 → 照樣可以（每個 isolate 記住算過的結果，不會每次都重算雜湊）
async function handleShareRouter(request, env, url, ref) {
  const bySlug = ref?.kind === 'slug';
  let key = ref?.key || '';
  if (bySlug) {
    // 網址名稱：大小寫不分（一律轉小寫），格式不對的一定不存在 → 直接 404，不查資料庫
    try { key = normalizeSlugInput(decodeURIComponent(key)); } catch { key = ''; }
    if (slugProblem(key)) return jsonResp({ error: 'Share link not found' }, 404);
  } else if (!key || !/^[a-zA-Z0-9_-]{1,64}$/.test(key)) {
    return jsonResp({ error: 'Invalid token' }, 400);
  }

  const segs = url.pathname.split('/').filter(Boolean);
  // [api, share|s, token|slug, ...rest]
  const sub = segs[3] || null;        // 'data' / 'songs' / 'videos' / 'song-videos'
  // 回給前端的影片網址用同一種開頭（用好讀網址開的人，看不到連結碼）
  const shareBase = bySlug ? `/api/s/${key}` : `/api/share/${key}`;
  const isStream = (sub === 'videos' || sub === 'song-videos') && !!segs[4] && segs[5] === 'stream' && !segs[6];

  // 密碼只收 header；通行證收 header，影片串流才收網址上的 ?access=
  const provided = request.headers.get('x-share-password') || '';
  const providedAccess = request.headers.get('x-share-access') || (isStream ? (url.searchParams.get('access') || '') : '');
  const now = Date.now();
  const ipKey = loginClientKey(request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for'));
  const failuresStmt = (k) => env.DB.prepare(
    `SELECT attempted_at FROM login_attempts WHERE ip = ? AND attempted_at > ?`
  ).bind(k, now - LOGIN_LOOKBACK_MS);
  const linkStmt = env.DB.prepare(
    `SELECT l.token, l.project_id, l.song_id, l.password, l.password_hash, l.password_salt, l.expires_at,
            l.slug, l.allow_comments, l.label, l.watermark, l.no_download, p.status AS project_status
       FROM share_links l
       JOIN projects p ON p.id = l.project_id
      WHERE l.${bySlug ? 'slug' : 'token'} = ? LIMIT 1`
  ).bind(key);

  // 防猜密碼：跟登入同一套（同一個 IP 對同一條連結 15 分鐘內錯 10 次 → 鎖 15 分鐘，鎖定中密碼對也擋）
  // 錯誤紀錄一律記在「查到的那條連結的連結碼」底下（shareAttemptKey(link.token, ...)），
  // 所以用舊式網址或好讀網址、換了網址名稱，猜同一條連結都算在一起
  let link, recentFailures = null;
  if (bySlug) {
    // 好讀網址比較短 → 這個 IP 最近一直打不存在的網址名稱就先擋（防一個一個猜）；跟查連結合成一次往返
    const missKey = slugMissKey(ipKey);
    const [linkR, missR] = await env.DB.batch([linkStmt, failuresStmt(missKey)]);
    link = (linkR.results || [])[0] || null;
    const gate = loginThrottleDecision((missR.results || []).map(r => r.attempted_at), now, { maxFailures: SLUG_MISS_MAX });
    if (!gate.allowed) {
      const retryAfterSec = Math.ceil(gate.retryAfterMs / 1000);
      return new Response(JSON.stringify({ error: slugLockedMessage(gate.retryAfterMs), retryAfterSec }), {
        status: 429,
        headers: { ...corsHeaders(), 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSec) }
      });
    }
    if (!link) {
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM login_attempts WHERE attempted_at < ?`).bind(now - LOGIN_ATTEMPT_KEEP_MS),
        env.DB.prepare(`INSERT INTO login_attempts (ip, attempted_at) VALUES (?, ?)`).bind(missKey, now),
      ]);
      return jsonResp({ error: 'Share link not found' }, 404);
    }
  } else if (provided) {
    // 舊式網址：連結碼就是網址上那串 → 有帶密碼時跟查連結合成一次往返；沒帶密碼（第一次打開頁面）不多查
    const [linkR, failR] = await env.DB.batch([linkStmt, failuresStmt(shareAttemptKey(key, ipKey))]);
    link = (linkR.results || [])[0] || null;
    recentFailures = (failR.results || []).map(r => r.attempted_at);
  } else {
    link = await linkStmt.first();
  }
  if (!link) return jsonResp({ error: 'Share link not found' }, 404);
  // 專案封存了 → 分享連結暫時不能看（還原後恢復）
  if (link.project_status === 'archived') return jsonResp({ error: '這個分享連結的專案已封存' }, 404);
  const token = link.token;
  if (shareLinkExpired(link.expires_at, now)) {
    return jsonResp({ error: 'Share link expired' }, 410);
  }

  // 密碼 / 通行證檢查
  let access = null;  // { token, expiresAt }：這次請求用的通行證（有密碼的連結才有）
  if (shareLinkHasPassword(link)) {
    const secret = getAuthSecret(env);
    const credential = await shareCredential(link);
    if (providedAccess && await verifyShareAccess(secret, { linkToken: token, credential, token: providedAccess, now })) {
      access = { token: providedAccess, expiresAt: Number(providedAccess.split('.')[0]) };
    } else {
      if (!provided) {
        return jsonResp({ error: providedAccess ? '通行證過期了，請重新輸入密碼' : 'Password required', requiresPassword: true }, 401);
      }
      const attemptKey = shareAttemptKey(token, ipKey);
      if (recentFailures === null) {
        // 好讀網址：查到連結才知道連結碼 → 這時才查密碼錯誤紀錄
        const failR = await failuresStmt(attemptKey).all();
        recentFailures = (failR.results || []).map(r => r.attempted_at);
      }
      const gate = loginThrottleDecision(recentFailures, now);
      if (!gate.allowed) {
        const retryAfterSec = Math.ceil(gate.retryAfterMs / 1000);
        return new Response(JSON.stringify({ error: loginLockedMessage(gate.retryAfterMs), retryAfterSec }), {
          status: 429,
          headers: { ...corsHeaders(), 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSec) }
        });
      }
      const check = await verifySharePasswordCached(provided, link);
      if (!check.ok) {
        // 記一次錯，順手清掉一天以前的紀錄
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM login_attempts WHERE attempted_at < ?`).bind(now - LOGIN_ATTEMPT_KEEP_MS),
          env.DB.prepare(`INSERT INTO login_attempts (ip, attempted_at) VALUES (?, ?)`).bind(attemptKey, now),
        ]);
        return jsonResp({ error: 'Password required', requiresPassword: true }, 401);
      }
      // 密碼對 → 這個 IP 對這條連結的錯誤歸零（有錯過才寫，不然每個請求都多一次寫入）
      if (recentFailures.length > 0) {
        await env.DB.prepare(`DELETE FROM login_attempts WHERE ip = ?`).bind(attemptKey).run();
      }
      let cred = credential;
      if (check.legacy) cred = await upgradeLegacySharePassword(env, link, provided);
      access = await signShareAccess(secret, { linkToken: token, credential: cred, now });
    }
  }
  // 0038：浮水印、禁止下載（舊連結都是關）
  const protection = protectionOfRow(link);
  // 影片網址：有密碼的連結接密碼通行證（?access=）；禁止下載的連結再接這支影片的播放通行證（&play=，綁這條連結 + 這支影片，幾小時失效）。
  // 兩個都沒有就是原本的網址。mediaId = 歌曲影片的 id（舊的 Drive 影片是檔案 id）
  const mediaUrl = async (path, mediaId) => withShareQuery(path, {
    access: access ? access.token : null,
    play: protection.noDownload ? await signSharePlay(getAuthSecret(env), { linkToken: token, mediaId, now }) : null,
  });
  // 串流請求要不要放行：禁止下載的連結一定要帶有效的播放通行證（沒帶 / 過期 / 別條連結的 / 別支影片的 → 401）
  const streamGate = (mediaId) => decideShareStream(getAuthSecret(env), {
    noDownload: protection.noDownload, playToken: url.searchParams.get('play') || '', linkToken: token, mediaId, now,
  });
  const streamDenied = (gate) => jsonResp({ error: gate.error, passExpired: gate.passExpired }, gate.status);

  // bump view counter（GET data 才算數，避免 stream 每幀 ++）
  if (sub === 'data' && request.method === 'GET') {
    await env.DB.prepare(
      `UPDATE share_links SET view_count = view_count + 1, last_viewed_at = datetime('now') WHERE token = ?`
    ).bind(token).run();
  }

  if (sub === 'data' && request.method === 'GET') {
    // bundle 給 share viewer：project meta + songs + stage_objects + model
    const proj = await env.DB.prepare(
      `SELECT id, name, description, model_r2_key, scale_correction, mechanism_offsets, look_settings, material_overrides, home_view, led_canvas, stage_props, camera_bookmarks FROM projects WHERE id = ? AND status != 'archived' LIMIT 1`
    ).bind(link.project_id).first();
    if (!proj) return jsonResp({ error: 'Project not found' }, 404);

    const songsR = await env.DB.prepare(
      `SELECT id, name, "order", status, code FROM songs WHERE project_id = ? ${link.song_id ? 'AND id = ?' : ''} ORDER BY "order"`
    ).bind(...(link.song_id ? [link.project_id, link.song_id] : [link.project_id])).all();
    // 每首歌最新的可播版本（R2）
    const latestVideos = await latestReadyVideos(env, link.project_id);

    const objsR = await env.DB.prepare(
      `SELECT * FROM stage_objects WHERE project_id = ? ORDER BY "order"`
    ).bind(link.project_id).all();

    const safeJsonObj = (s, def = {}) => { try { const v = JSON.parse(s || ''); return v || def; } catch { return def; } };
    const stageObjects = (objsR.results || []).map(o => ({
      id: o.id,
      meshName: o.mesh_name,
      displayName: o.display_name,
      category: o.category,
      order: o.order,
      defaultPosition: safeJsonObj(o.default_position, { x: 0, y: 0, z: 0 }),
      defaultRotation: safeJsonObj(o.default_rotation, { pitch: 0, yaw: 0, roll: 0 }),
      defaultScale: safeJsonObj(o.default_scale, { x: 1, y: 1, z: 1 }),
      metadata: safeJsonObj(o.metadata, null),
      createdAt: o.created_at,
      locked: !!o.locked,
      materialProps: safeJsonObj(o.material_props, null),
      ledProps: safeJsonObj(o.led_props, null),
    }));

    const shareSongs = await Promise.all((songsR.results || []).map(async s => {
      const lv = latestVideos.get(s.id);
      return {
        id: s.id, name: s.name, order: s.order, status: s.status, code: s.code || null,
        // 最新可以播的影片版本（R2；沒有 = null）。streamUrl 已經接好通行證
        latestVideo: lv ? videoToShareApi(lv, await mediaUrl(`${shareBase}/song-videos/${lv.id}/stream`, lv.id)) : null,
      };
    }));
    return jsonResp({
      project: { id: proj.id, name: proj.name, description: proj.description },
      modelUrl: proj.model_r2_key ? `/r2/${proj.model_r2_key}` : null,
      songs: shareSongs,
      stageObjects,
      restrictedToSongId: link.song_id,
      scaleCorrection: proj.scale_correction ?? 1,
      // 舊的全專案機關滑桿：新前端不讀了；正式站還在跑的舊版前端讀機關時會先用它（只讀，後台不再收修改）
      mechanismOffsets: safeJsonObj(proj.mechanism_offsets, {}),
      // 機關（定義）；每個 cue 的位置：GET songs/:songId/mechanism-positions
      mechanisms: await mech.loadMechanisms(env, link.project_id, null, { mech2: mech.wantsMech2(request), mech3: mech.wantsMech3(request) }).catch(() => []),
      lookSettings: safeJsonObj(proj.look_settings, {}),
      materialOverrides: safeJsonObj(proj.material_overrides, {}),
      homeView: proj.home_view ? safeJsonObj(proj.home_view, null) : null,
      ledCanvas: proj.led_canvas ? sanitizeLedCanvas(proj.led_canvas) : null,
      // 比例尺的樂手和器材（0033；訪客只看）
      stageProps: parseStoredStageProps(proj.stage_props),
      // 視角書籤（0035；訪客只看，點了飛過去）
      cameraBookmarks: parseStoredCameraBookmarks(proj.camera_bookmarks),
      // 有密碼的連結：之後的請求帶這張通行證（X-Share-Access header），不用再送密碼
      access,
      // 0026：製作有沒有打開「允許看的人留言」（連結名稱是團隊內部用的，不給訪客）
      allowComments: !!link.allow_comments,
      // 0038：浮水印、禁止下載。浮水印上印的字：連結編號（一定有）+ 連結名稱（開了浮水印才給；沒有名稱就用好讀網址名稱）。
      // 舊版前端不認得這個欄位，照舊能用
      protection: {
        watermark: protection.watermark,
        noDownload: protection.noDownload,
        linkId: await shortLinkId(token),
        linkName: protection.watermark ? (link.label || link.slug || null) : null,
      },
    });
  }

  // 訪客留言（0026；連結有打開「允許看的人留言」才行）：GET 看得到的留言串、POST 留言 / 回覆
  if (sub === 'songs' && segs[5] === 'comments' && !segs[6]) {
    if (request.method === 'GET') {
      return await reviewsResp(guest.listGuestComments(env.DB, { link, songId: segs[4] }));
    }
    if (request.method === 'POST') {
      const body = await readJsonLimited(request, guest.GUEST_BODY_MAX_BYTES);
      if (body.error) return jsonResp({ error: body.error }, body.status);
      return await reviewsResp(guest.postGuestComment(env.DB, {
        link, songId: segs[4], body: body.value, ipKey, accessToken: access?.token ?? null, now: new Date(now), r2: env.MODELS || null,
      }));
    }
    return jsonResp({ error: 'Method not allowed' }, 405);
  }
  // 訪客的參考圖片（0028）：POST 上傳一張、DELETE /:id 拿掉還沒送出的（額度在 guestComments.mjs）
  if (sub === 'songs' && segs[5] === 'comment-attachments' && !segs[7]) {
    if (request.method === 'POST' && !segs[6]) {
      return await reviewsResp(guest.uploadGuestAttachment(env.DB, env.MODELS || null, {
        link, songId: segs[4], request, ipKey, accessToken: access?.token ?? null, now: new Date(now),
      }));
    }
    if (request.method === 'DELETE' && segs[6]) {
      return await reviewsResp(guest.discardGuestAttachment(env.DB, env.MODELS || null, { link, songId: segs[4], id: segs[6] }));
    }
    return jsonResp({ error: 'Method not allowed' }, 405);
  }

  if (sub === 'songs' && request.method === 'GET') {
    const songId = segs[4];
    const cuesOnly = segs[5] === 'cues' && !segs[6];
    const cueId = segs[5] === 'cues' && segs[6] ? segs[6] : null;
    const wantStates = cueId && segs[7] === 'states' && !segs[8];
    const wantMechPositions = segs[5] === 'mechanism-positions' && !segs[6];
    const wantVideos = segs[5] === 'videos' && !segs[6];
    const wantVersions = segs[5] === 'versions' && !segs[6];
    if (!songId || !/^[a-zA-Z0-9_-]{1,64}$/.test(songId)) return jsonResp({ error: 'Missing songId' }, 400);
    // 驗證 song 屬於 project / 限制 song
    if (link.song_id && link.song_id !== songId) return jsonResp({ error: 'Song not in scope' }, 403);
    const song = await env.DB.prepare(
      `SELECT id, project_id FROM songs WHERE id = ? LIMIT 1`
    ).bind(songId).first();
    if (!song || song.project_id !== link.project_id) return jsonResp({ error: 'Song not found' }, 404);

    if (cuesOnly) {
      const r = await env.DB.prepare(
        `SELECT id, name, "order", crossfade_seconds, video_time_sec, status FROM cues WHERE song_id = ? AND status = 'master' ORDER BY "order"`
      ).bind(songId).all();
      return jsonResp({
        cues: (r.results || []).map(c => ({
          id: c.id, name: c.name, order: c.order,
          crossfadeSeconds: c.crossfade_seconds,
          videoTimeSec: typeof c.video_time_sec === 'number' ? c.video_time_sec : null,
          status: c.status,
        })),
      });
    }
    if (wantVideos) {
      const r = await env.DB.prepare(
        `SELECT id, drive_file_id, filename, mime_type, modified_time, size_bytes
           FROM drive_files WHERE project_id = ? AND song_id = ?
           ORDER BY COALESCE(modified_time, cached_at) DESC`
      ).bind(link.project_id, songId).all();
      return jsonResp({
        videos: await Promise.all((r.results || []).map(async f => ({
          id: f.id,
          driveFileId: f.drive_file_id,
          filename: f.filename,
          mimeType: f.mime_type,
          modifiedTime: f.modified_time,
          sizeBytes: f.size_bytes,
          // 公開存取的 stream URL：用同一條分享連結認證（跟這次用的網址同一種開頭）；
          // 有密碼的連結後面接著通行證（<video> 帶不了 header）；禁止下載的連結再接播放通行證
          streamUrl: await mediaUrl(`${shareBase}/videos/${f.drive_file_id}/stream`, f.drive_file_id),
        }))),
      });
    }
    if (wantVersions) {
      // 分享連結只看得到最新的可播版本（R2）
      const v = await env.DB.prepare(
        `SELECT * FROM song_videos WHERE song_id = ? AND project_id = ? AND status = 'ready' AND deleted_at IS NULL
          ORDER BY version DESC LIMIT 1`
      ).bind(songId, link.project_id).first();
      const videos = v ? [videoToShareApi(v, await mediaUrl(`${shareBase}/song-videos/${v.id}/stream`, v.id))] : [];
      return jsonResp({ videos, latestVideoId: v?.id || null });
    }
    if (wantMechPositions) {
      // 每個 cue 自己設的機關位置（只有正式 cue；跟管理頁同一套沿用規則在前端算）
      return jsonResp({ positions: await mech.loadSongPositions(env, songId, { masterOnly: true, mech2: mech.wantsMech2(request), mech3: mech.wantsMech3(request) }) });
    }
    if (wantStates) {
      // 跟管理頁 / 導演頁同一份計算（loadCueStates）→ 沒改的物件一樣沿用前面 cue 的位置
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cueId)) return jsonResp({ error: 'Invalid cue id' }, 400);
      const cue = await env.DB.prepare(
        `SELECT id FROM cues WHERE id = ? AND song_id = ? AND status = 'master' LIMIT 1`
      ).bind(cueId, songId).first();
      if (!cue) return jsonResp({ error: 'Cue not found' }, 404);
      return jsonResp({ states: await loadCueStates(env, link.project_id, cueId) });
    }
    return jsonResp({ error: 'Bad share sub-path' }, 404);
  }

  // /api/share/:token/song-videos/:videoId/stream — 歌曲影片版本（R2）
  if (isStream && sub === 'song-videos' && (request.method === 'GET' || request.method === 'HEAD')) {
    const videoId = segs[4];
    if (!ID_RE.test(videoId)) return jsonResp({ error: 'Video not found' }, 404);
    // 禁止下載：沒有有效的播放通行證就不碰資料庫、不給檔案
    const gate = await streamGate(videoId);
    if (!gate.ok) return streamDenied(gate);
    const v = await env.DB.prepare(
      `SELECT id, project_id, song_id, r2_key, mime, size_bytes FROM song_videos
        WHERE id = ? AND status = 'ready' AND deleted_at IS NULL LIMIT 1`
    ).bind(videoId).first();
    if (!v || v.project_id !== link.project_id) return jsonResp({ error: 'Video not found' }, 404);
    if (link.song_id && link.song_id !== v.song_id) return jsonResp({ error: '不在分享範圍' }, 403);
    return serveR2Video(request, env, v, { noStore: protection.noDownload });
  }

  // /api/share/:token/videos/:driveFileId/stream — 公開存取串流（舊的 Drive 直播，之後改用 song-videos）
  if (isStream && sub === 'videos' && (request.method === 'GET' || request.method === 'HEAD')) {
    const driveFileId = segs[4];
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(driveFileId)) return jsonResp({ error: 'Video not found' }, 404);
    // 禁止下載：沒有有效的播放通行證就不碰資料庫、不給檔案
    const gate = await streamGate(driveFileId);
    if (!gate.ok) return streamDenied(gate);
    // 驗 driveFileId 屬於這個分享範圍（同 project，且如有限制 song 的話也對）
    const f = await env.DB.prepare(`
      SELECT df.project_id, df.song_id, df.mime_type, p.drive_oauth_token_id
        FROM drive_files df
        JOIN projects p ON df.project_id = p.id
       WHERE df.drive_file_id = ?
       LIMIT 1
    `).bind(driveFileId).first();
    if (!f) return jsonResp({ error: 'Video not found' }, 404);
    if (f.project_id !== link.project_id) return jsonResp({ error: '不在分享範圍' }, 403);
    if (link.song_id && link.song_id !== f.song_id) return jsonResp({ error: '不在分享範圍' }, 403);
    if (!f.drive_oauth_token_id) return jsonResp({ error: 'Project missing OAuth token' }, 412);

    let at;
    try { at = await driveGetAccessToken(env, f.drive_oauth_token_id); }
    catch (e) { return jsonResp({ error: 'Token refresh failed: ' + e.message }, 500); }

    const range = request.headers.get('range');
    const headers = { Authorization: `Bearer ${at}` };
    if (range) headers['Range'] = range;
    const upstream = await fetch(`${DRIVE_FILES_FETCH}/${encodeURIComponent(driveFileId)}?alt=media`, {
      method: request.method,
      headers,
    });
    const passHeaders = new Headers();
    for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const v = upstream.headers.get(k);
      if (v) passHeaders.set(k, v);
    }
    if (!passHeaders.has('content-type') && f.mime_type) passHeaders.set('content-type', f.mime_type);
    if (protection.noDownload) passHeaders.set('cache-control', sharePlaybackCacheControl(true));
    return new Response(upstream.body, { status: upstream.status, headers: passHeaders });
  }

  return jsonResp({ error: 'Bad share request' }, 404);
}

// 算過的「密碼對了」記在這個 isolate 一陣子（舊版前端每個請求都帶密碼，不要每次都算 PBKDF2）
// key 含連結碼 + 目前的密碼雜湊 + 輸入密碼的 SHA-256 → 密碼換了自動失效；只記「對的」
const sharePasswordOkCache = new Map();
const SHARE_PASSWORD_CACHE_MS = 10 * 60 * 1000;

async function verifySharePasswordCached(provided, link) {
  if (!link.password_hash) return verifySharePassword(provided, link);  // 舊明文：比對很便宜，不用記
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(provided)));
  const cacheKey = `${link.token}|${link.password_hash}|${bytesToBase64(digest)}`;
  const hit = sharePasswordOkCache.get(cacheKey);
  if (hit && hit > Date.now()) return { ok: true };
  const r = await verifySharePassword(provided, link);
  if (r.ok) {
    if (sharePasswordOkCache.size > 500) sharePasswordOkCache.clear();
    sharePasswordOkCache.set(cacheKey, Date.now() + SHARE_PASSWORD_CACHE_MS);
  }
  return r;
}

// 舊的明文密碼第一次被正確輸入 → 換成加鹽雜湊、明文清掉；回傳通行證要綁的雜湊
async function upgradeLegacySharePassword(env, link, password) {
  const hashed = await hashSharePassword(password);
  const r = await env.DB.prepare(
    `UPDATE share_links SET password_hash = ?, password_salt = ?, password = NULL
      WHERE token = ? AND password = ? AND password_hash IS NULL`
  ).bind(hashed.hash, hashed.salt, link.token, password).run();
  if (r.meta?.changes) return hashed.hash;
  // 同時有別的請求先換好了 → 用資料庫裡的那個
  const now = await env.DB.prepare(`SELECT password, password_hash FROM share_links WHERE token = ? LIMIT 1`).bind(link.token).first();
  return now ? await shareCredential(now) : hashed.hash;
}
