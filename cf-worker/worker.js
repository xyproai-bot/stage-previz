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

const MAX_COMMENTS_PER_SESSION = 500;
const MAX_TEXT_LEN = 2000;
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const COMMENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export default {
  async fetch(request, env) {
    const response = await routeRequest(request, env);
    return applyCorsToResponse(response, request);
  },

  // Cron Trigger（每 5 分鐘掃所有有 drive_folder_id 的 project 同步檔案）
  async scheduled(_event, env, ctx) {
    if (!env.DB) return;
    try {
      const r = await env.DB.prepare(
        `SELECT id FROM projects
          WHERE status != 'archived'
            AND drive_folder_id IS NOT NULL
            AND drive_folder_id != ''
            AND drive_oauth_token_id IS NOT NULL`
      ).all();
      for (const row of (r.results || [])) {
        // 用 ctx.waitUntil 讓多個 sync 並行（每個 5s 上限避免拖太久）
        ctx.waitUntil(driveSyncProjectInternal(env, row.id, 'cron').catch(e => {
          console.error('[cron sync]', row.id, e?.message || e);
        }));
      }
    } catch (e) {
      console.error('[cron]', e?.message || e);
    }
  }
};

// 把 response 的 CORS header 改成 reflect 真實 origin + 支援 cookie credentials
// 為什麼：fetch 端用 credentials: 'include'，瀏覽器要求 Access-Control-Allow-Origin 是具體 origin
// 不可以是 '*'，且必須有 Allow-Credentials: true
function applyCorsToResponse(response, request) {
  const origin = request.headers.get('origin');
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Vary', 'Origin');
  // 確保 OPTIONS preflight 也帶 methods / headers
  if (!headers.has('Access-Control-Allow-Methods')) {
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
  }
  // 一律覆蓋 Allow-Headers，確保包含 Authorization（讓前端可送 Bearer token）
  headers.set('Access-Control-Allow-Headers', 'Range, Content-Type, Authorization');
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

  if (url.pathname === '/api/auth/login'  && request.method === 'POST')  return authLogin(request, env);
  if (url.pathname === '/api/auth/logout' && request.method === 'POST')  return authLogout();
  if (url.pathname === '/api/auth/me'     && request.method === 'GET')   return authMe(request, env);

  // 公開分享連結（read-only，無需登入）
  if (url.pathname.startsWith('/api/share/')) {
    const token = url.pathname.replace('/api/share/', '').split('/')[0];
    return handleShareRouter(request, env, url, token);
  }
  if (url.pathname === '/api/projects' || url.pathname.startsWith('/api/projects/')) {
    // 短路：share-links 子路由屬於 admin 管理
    if (url.pathname.match(/^\/api\/projects\/[^/]+\/share-links/)) {
      return handleProjectShareLinks(request, env, url);
    }
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

  if (url.pathname === '/api/assets' || url.pathname.startsWith('/api/assets/')) {
    return handleAssetsRouter(request, env, url);
  }

  if (url.pathname === '/api/projects/import' && request.method === 'POST') {
    return importProject(request, env);
  }
  if (url.pathname === '/api/projects-archived' && request.method === 'GET') {
    const me = await getCurrentUser(request, env);
    if (!me) return jsonResp({ error: '未登入' }, 401);
    if (me.role !== 'admin') return jsonResp({ error: '只有 admin 可看封存' }, 403);
    return listProjects(env, me, { archived: true });
  }
  if (url.pathname === '/api/search' && request.method === 'GET') {
    return handleSearch(request, env, url);
  }
  if (url.pathname.startsWith('/api/cue-templates/') && request.method === 'DELETE') {
    const tid = url.pathname.replace('/api/cue-templates/', '');
    return deleteCueTemplate(request, env, tid);
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
    return handleDriveProxy(request, url);
  }

  return jsonResp({ error: 'Not found' }, 404);
}

// 統一 router：把 /api/projects/* 分派到對應 handler
async function handleProjectsRouter(request, env, url) {
  // 必須登入
  const userId = await getRequestUserId(request, env);
  if (!userId) return jsonResp({ error: '未登入' }, 401);

  const segs = url.pathname.split('/').filter(Boolean);
  // 路徑形態：
  //   /api/projects                                            → projects collection
  //   /api/projects/:id                                        → project item
  //   /api/projects/:id/stage-objects                          → stage_objects collection
  //   /api/projects/:id/stage-objects/:objId                   → stage_object item
  //   /api/projects/:id/stage-objects/seed-defaults            → 一鍵塞範例物件
  //   /api/projects/:id/songs                                  → songs collection
  //   /api/projects/:id/songs/:songId                          → song item
  //   /api/projects/:id/songs/reorder                          → 批次排序
  //   /api/projects/:id/songs/:songId/cues                     → cues collection
  //   /api/projects/:id/songs/:songId/cues/:cueId              → cue item
  //   /api/projects/:id/songs/:songId/cues/:cueId/states       → object states for this cue
  //   /api/projects/:id/songs/:songId/cues/:cueId/states/:objId → set/clear single state

  const projectId = segs[2] || null;
  const sub = segs[3] || null;
  const songId = segs[4] || null;
  const sub2 = segs[5] || null;
  const cueId = segs[6] || null;
  const sub3 = segs[7] || null;
  const objId = segs[8] || null;

  if (!projectId) {
    return handleProjects(request, env, null, null);
  }

  if (sub === 'stage-objects') {
    // segs[4] is obj id (or 'seed-defaults' magic action)
    return handleStageObjects(request, env, projectId, segs[4] || null);
  }

  if (sub === 'model') {
    // /api/projects/:id/model              → upload (PUT) / get info (GET)
    // /api/projects/:id/model/versions     → list all versions (GET)
    // /api/projects/:id/model/versions/activate  → POST {key} 切換 active 版本
    // /api/projects/:id/model/versions/:keySuffix → DELETE 刪某舊版本
    return handleModel(request, env, projectId, segs[4] || null, segs[5] || null);
  }

  if (sub === 'activity') {
    // /api/projects/:id/activity?limit=50  → 列最近活動
    if (request.method !== 'GET') return jsonResp({ error: 'Method not allowed' }, 405);
    const limit = url.searchParams.get('limit') || '50';
    return listActivity(env, projectId, limit);
  }

  if (sub === 'duplicate') {
    if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405);
    return duplicateProject(request, env, projectId);
  }

  if (sub === 'restore') {
    if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405);
    if (me.role !== 'admin') return jsonResp({ error: '只有 admin 可還原' }, 403);
    await env.DB.prepare(
      `UPDATE projects SET status = 'active', updated_at = datetime('now') WHERE id = ?`
    ).bind(projectId).run();
    await logActivity(request, env, projectId, 'update', 'project', projectId, { restored: true });
    return jsonResp({ ok: true });
  }

  if (sub === 'export') {
    if (request.method !== 'GET') return jsonResp({ error: 'Method not allowed' }, 405);
    return exportProject(request, env, projectId);
  }

  if (sub === 'cue-templates') {
    if (request.method === 'GET') return listCueTemplates(env, projectId);
    if (request.method === 'POST') return createCueTemplate(request, env, projectId);
    return jsonResp({ error: 'Method not allowed' }, 405);
  }

  if (sub === 'drive') {
    // /api/projects/:id/drive/files            GET   → cached files list
    // /api/projects/:id/drive/sync             POST  → trigger manual sync
    // /api/projects/:id/drive/files/:fid/assign POST → 手動把檔案歸到某 song
    // /api/projects/:id/drive/sync-log         GET   → 看同步歷史
    const sub2v = segs[4] || null;
    const fid   = segs[5] || null;
    const sub3v = segs[6] || null;
    if (sub2v === 'files' && !fid && request.method === 'GET') return driveListProjectFiles(env, projectId);
    if (sub2v === 'files' && fid && sub3v === 'assign' && request.method === 'POST') return driveAssignFile(request, env, projectId, fid);
    if (sub2v === 'sync' && request.method === 'POST') return driveSyncProject(request, env, projectId, 'manual');
    if (sub2v === 'sync-log' && request.method === 'GET') return driveSyncLog(env, projectId);
    return jsonResp({ error: 'Drive route not found' }, 404);
  }

  if (sub === 'songs' && sub2 === 'cues' && sub3 === 'states') {
    return handleCueStates(request, env, projectId, songId, cueId, objId);
  }

  // /api/projects/:id/songs/:songId/import-cues  POST {fromSongId} → 從別的 song 把 cue 全複製進來
  if (sub === 'songs' && songId && sub2 === 'import-cues' && request.method === 'POST') {
    return importCuesFromSong(request, env, projectId, songId);
  }

  if (sub === 'songs' && sub2 === 'cues') {
    return handleCues(request, env, projectId, songId, cueId);
  }

  if (sub === 'songs') {
    return handleSongs(request, env, projectId, songId);
  }

  return handleProjects(request, env, projectId, null);
}

// ─────────────────────────────────────────────
// Projects API（Phase 1 backend — D1）
//   GET    /api/projects          → list（含 stats: songCount/cueCount/proposalCount/members）
//   POST   /api/projects          body: { name, description } → 建專案
//   GET    /api/projects/:id      → 單筆
//   PATCH  /api/projects/:id      body: 任何 projects 欄位 → 更新
//   DELETE /api/projects/:id      → 軟刪除（status=archived）
// ─────────────────────────────────────────────

const PROJECT_NAME_MAX = 80;
const PROJECT_DESC_MAX = 300;

async function handleProjects(request, env, projectId, _unused) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);

  try {
    if (!projectId) {
      if (request.method === 'GET') {
        // 用 URL search params 拿 archived flag — 但 handleProjects 沒拿到 url，找原 caller
        // 簡化：在 router 層多傳一個 archived flag
        return listProjects(env, me);
      }
      if (request.method === 'POST') return createProject(request, env);
      return jsonResp({ error: 'Method not allowed' }, 405);
    }

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) {
      return jsonResp({ error: 'Invalid project id' }, 400);
    }

    // 非 admin 要檢查 project_members
    if (me.role !== 'admin') {
      const member = await env.DB.prepare(
        `SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1`
      ).bind(projectId, me.id).first();
      if (!member) return jsonResp({ error: '沒有權限存取此專案' }, 403);
    }

    if (request.method === 'GET') return getProject(env, projectId);
    if (request.method === 'PATCH') return updateProject(request, env, projectId);
    if (request.method === 'DELETE') return archiveProject(request, env, projectId);
    return jsonResp({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

async function listProjects(env, me, opts = {}) {
  // admin 看全部，其他 role 只看自己被加進 project_members 的 project
  const memberFilter = me?.role === 'admin'
    ? ''
    : ` AND p.id IN (SELECT pm.project_id FROM project_members pm WHERE pm.user_id = ?)`;
  const binds = me?.role === 'admin' ? [] : [me.id];
  const archivedFilter = opts.archived ? `p.status = 'archived'` : `p.status != 'archived'`;

  const projects = await env.DB.prepare(`
    SELECT
      p.id, p.name, p.description, p.thumbnail_r2_key, p.status, p.show_id, p.tags,
      p.created_at, p.updated_at,
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
    SELECT pm.project_id, u.id, u.name, u.avatar_color
    FROM project_members pm
    JOIN users u ON pm.user_id = u.id
  `).all();

  const membersByProject = {};
  for (const m of members.results || []) {
    (membersByProject[m.project_id] = membersByProject[m.project_id] || []).push({
      id: m.id, name: m.name, avatarColor: m.avatar_color
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
  }));

  return jsonResp({ projects: list });
}

async function createProject(request, env) {
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }

  const name = (body?.name || '').toString().trim().slice(0, PROJECT_NAME_MAX);
  const description = (body?.description || '').toString().trim().slice(0, PROJECT_DESC_MAX);
  if (!name) return jsonResp({ error: 'name is required' }, 400);

  const showId = body?.showId && /^[a-zA-Z0-9_-]{1,64}$/.test(body.showId) ? body.showId : null;

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

async function getProject(env, projectId) {
  const row = await env.DB.prepare(`
    SELECT * FROM projects WHERE id = ? AND status != 'archived' LIMIT 1
  `).bind(projectId).first();
  if (!row) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ project: row });
}

async function updateProject(request, env, projectId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }

  const allowed = ['name', 'description', 'status', 'drive_folder_id', 'drive_filename_pattern', 'drive_oauth_token_id', 'show_id', 'tags'];
  // 前端 camelCase showId 轉 snake_case show_id
  if ('showId' in body && !('show_id' in body)) body.show_id = body.showId;
  // tags 是 array → 存成 JSON string
  if ('tags' in body && Array.isArray(body.tags)) {
    body.tags = JSON.stringify(body.tags.filter(t => typeof t === 'string').slice(0, 20));
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
  await logActivity(request, env, projectId, 'update', 'project', projectId, { name: before?.name, changes: body });
  return jsonResp({ ok: true });
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
    `SELECT id, name, description, model_r2_key, show_id FROM projects WHERE id = ? AND status != 'archived' LIMIT 1`
  ).bind(projectId).first();
  if (!src) return jsonResp({ error: 'Source project not found' }, 404);

  const newName = (body?.newName || `${src.name} (副本)`).toString().trim().slice(0, PROJECT_NAME_MAX);
  const showId = ('showId' in body ? body.showId : src.show_id) || null;
  const newId = 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  // 1. 建新 project
  await env.DB.prepare(
    `INSERT INTO projects (id, name, description, model_r2_key, show_id, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(newId, newName, src.description || '', src.model_r2_key, showId, me.id).run();

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
      INSERT INTO songs (id, project_id, name, "order", animator_user_id, drive_folder_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(newSongId, newId, s.name, s.order, s.animator_user_id, s.drive_folder_id, s.status));
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
                        status, base_cue_id, thumbnail_r2_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(newCueId, newSongId, c.name, c.order, c.position_xyz, c.rotation_xyz, c.fov, c.crossfade_seconds,
            c.status, newBaseCueId, c.thumbnail_r2_key));
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

async function createCueTemplate(request, env, projectId) {
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const name = (body?.name || '').toString().trim().slice(0, 80);
  const description = (body?.description || '').toString().trim().slice(0, 300);
  const fromCueId = (body?.fromCueId || '').toString();
  const isGlobal = !!body?.global;
  if (!name) return jsonResp({ error: 'name 必填' }, 400);
  if (!fromCueId) return jsonResp({ error: '需要來源 cue id' }, 400);

  // 抓 cue 跟所有 cue_object_states + 對應 stage_objects 的 mesh_name
  const cue = await env.DB.prepare(
    `SELECT * FROM cues WHERE id = ? LIMIT 1`
  ).bind(fromCueId).first();
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
  if (me.role !== 'admin') return jsonResp({ error: '需要 admin' }, 403);
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
  const modelKey = body.project.modelR2Key || null;

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
  for (const s of (body.songs || [])) {
    const newSongId = 's_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + songStmts.length;
    songIdMap.set(s.id, newSongId);
    songStmts.push(env.DB.prepare(`
      INSERT INTO songs (id, project_id, name, "order", animator_user_id, drive_folder_id, status)
      VALUES (?, ?, ?, ?, NULL, ?, ?)
    `).bind(newSongId, newId, s.name, s.order, s.drive_folder_id, s.status || 'todo'));
  }
  if (songStmts.length > 0) await env.DB.batch(songStmts);

  // cues
  const cueIdMap = new Map();
  const cueStmts = [];
  for (const c of (body.cues || [])) {
    const newCueId = 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + cueStmts.length;
    cueIdMap.set(c.id, newCueId);
    const newSongId = songIdMap.get(c.song_id);
    if (!newSongId) continue;
    cueStmts.push(env.DB.prepare(`
      INSERT INTO cues (id, song_id, name, "order", position_xyz, rotation_xyz, fov, crossfade_seconds, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(newCueId, newSongId, c.name, c.order, c.position_xyz, c.rotation_xyz,
            c.fov, c.crossfade_seconds, c.status || 'master'));
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
  const userId = await getRequestUserId(request, env);
  if (!userId) return jsonResp({ error: '未登入' }, 401);
  const segs = url.pathname.split('/').filter(Boolean);
  const showId = segs[2] || null;

  try {
    if (!showId) {
      if (request.method === 'GET') return listShows(env);
      if (request.method === 'POST') return createShow(request, env);
      return jsonResp({ error: 'Method not allowed' }, 405);
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(showId)) return jsonResp({ error: 'Invalid show id' }, 400);
    if (request.method === 'GET') return getShow(env, showId);
    if (request.method === 'PATCH') return updateShow(request, env, showId);
    if (request.method === 'DELETE') return deleteShow(env, showId);
    return jsonResp({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

async function listShows(env) {
  const rows = await env.DB.prepare(`
    SELECT s.id, s.name, s.description, s.created_at, s.updated_at,
           (SELECT COUNT(*) FROM projects p WHERE p.show_id = s.id AND p.status != 'archived') AS project_count
    FROM shows s
    ORDER BY s.updated_at DESC
  `).all();
  const list = (rows.results || []).map(s => ({
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

async function getShow(env, showId) {
  const show = await env.DB.prepare(
    `SELECT id, name, description, created_at, updated_at FROM shows WHERE id = ? LIMIT 1`
  ).bind(showId).first();
  if (!show) return jsonResp({ error: 'Not found' }, 404);

  const projects = await env.DB.prepare(`
    SELECT id, name FROM projects
    WHERE show_id = ? AND status != 'archived'
    ORDER BY updated_at DESC
  `).bind(showId).all();

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

async function handleSongs(request, env, projectId, songId) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) return jsonResp({ error: 'Invalid project id' }, 400);

  try {
    if (!songId) {
      if (request.method === 'GET') return listSongs(env, projectId);
      if (request.method === 'POST') return createSong(request, env, projectId);
      return jsonResp({ error: 'Method not allowed' }, 405);
    }

    if (songId === 'reorder') {
      if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405);
      return reorderSongs(request, env, projectId);
    }

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(songId)) return jsonResp({ error: 'Invalid song id' }, 400);

    if (request.method === 'GET') return getSong(env, songId);
    if (request.method === 'PATCH') return updateSong(request, env, projectId, songId);
    if (request.method === 'DELETE') return deleteSong(request, env, projectId, songId);
    return jsonResp({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

async function listSongs(env, projectId) {
  const r = await env.DB.prepare(`
    SELECT s.id, s.name, s."order", s.animator_user_id, s.status, s.created_at,
      (SELECT COUNT(*) FROM cues c WHERE c.song_id = s.id AND c.status = 'master') AS cue_count,
      (SELECT COUNT(*) FROM cues c WHERE c.song_id = s.id AND c.status = 'proposal') AS proposal_count
    FROM songs s
    WHERE s.project_id = ?
    ORDER BY s."order" ASC, s.created_at ASC
  `).bind(projectId).all();

  return jsonResp({ songs: (r.results || []).map(s => ({
    id: s.id, name: s.name, order: s.order,
    animatorUserId: s.animator_user_id, status: s.status,
    createdAt: s.created_at,
    cueCount: s.cue_count, proposalCount: s.proposal_count,
  })) });
}

async function createSong(request, env, projectId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const name = (body?.name || '').toString().trim().slice(0, SONG_NAME_MAX);
  if (!name) return jsonResp({ error: 'name is required' }, 400);

  // 找最大 order + 1
  const maxRow = await env.DB.prepare(
    `SELECT COALESCE(MAX("order"), -1) AS max_order FROM songs WHERE project_id = ?`
  ).bind(projectId).first();
  const order = (maxRow?.max_order ?? -1) + 1;

  const id = 's_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  await env.DB.prepare(
    `INSERT INTO songs (id, project_id, name, "order") VALUES (?, ?, ?, ?)`
  ).bind(id, projectId, name, order).run();

  // touch project updated_at
  await env.DB.prepare(`UPDATE projects SET updated_at = datetime('now') WHERE id = ?`).bind(projectId).run();
  await logActivity(request, env, projectId, 'create', 'song', id, { name });
  return jsonResp({ ok: true, id, order }, 201);
}

async function getSong(env, songId) {
  const row = await env.DB.prepare(`SELECT * FROM songs WHERE id = ? LIMIT 1`).bind(songId).first();
  if (!row) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ song: row });
}

async function updateSong(request, env, projectId, songId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }

  // 抓更動前狀態做 diff
  const before = await env.DB.prepare(`SELECT name, status FROM songs WHERE id = ? LIMIT 1`).bind(songId).first();

  const allowed = ['name', 'order', 'status', 'animator_user_id', 'drive_folder_id'];
  const sets = [], values = [];
  for (const k of allowed) {
    if (k in body) {
      sets.push(k === 'order' ? `"order" = ?` : `${k} = ?`);
      values.push(body[k]);
    }
  }
  if (!sets.length) return jsonResp({ error: 'no updatable fields' }, 400);
  values.push(songId);

  const result = await env.DB.prepare(
    `UPDATE songs SET ${sets.join(', ')} WHERE id = ?`
  ).bind(...values).run();
  if (!result.meta.changes) return jsonResp({ error: 'Not found' }, 404);

  await logActivity(request, env, projectId, 'update', 'song', songId, {
    name: before?.name,
    changes: body,
    statusFrom: before?.status,
    statusTo: 'status' in body ? body.status : undefined,
  });
  return jsonResp({ ok: true });
}

async function deleteSong(request, env, projectId, songId) {
  const before = await env.DB.prepare(`SELECT name FROM songs WHERE id = ? LIMIT 1`).bind(songId).first();
  const result = await env.DB.prepare(`DELETE FROM songs WHERE id = ?`).bind(songId).run();
  if (!result.meta.changes) return jsonResp({ error: 'Not found' }, 404);
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

async function handleCues(request, env, projectId, songId, cueId) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(songId)) return jsonResp({ error: 'Invalid song id' }, 400);

  try {
    if (!cueId) {
      if (request.method === 'GET') return listCues(env, songId);
      if (request.method === 'POST') return createCue(request, env, projectId, songId);
      return jsonResp({ error: 'Method not allowed' }, 405);
    }

    // 特殊 action：cues/reorder
    if (cueId === 'reorder') {
      if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405);
      return reorderCues(request, env, projectId, songId);
    }

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cueId)) return jsonResp({ error: 'Invalid cue id' }, 400);

    // /cues/:id/reset
    const segs = new URL(request.url).pathname.split('/').filter(Boolean);
    if (segs[7] === 'reset') {
      if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405);
      return resetCue(request, env, projectId, cueId);
    }

    if (request.method === 'GET') return getCue(env, cueId);
    if (request.method === 'PATCH') return updateCue(request, env, projectId, cueId);
    if (request.method === 'DELETE') return deleteCue(request, env, projectId, cueId);
    return jsonResp({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

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
    `SELECT id, project_id FROM songs WHERE id = ? LIMIT 1`
  ).bind(fromSongId).first();
  if (!srcSong) return jsonResp({ error: 'Source song not found' }, 404);
  if (me.role !== 'admin') {
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

  const position = JSON.stringify(body?.position || { x: 0, y: 0, z: 0 });
  const rotation = JSON.stringify(body?.rotation || { pitch: 0, yaw: 0, roll: 0 });
  const fov = typeof body?.fov === 'number' ? body.fov : 60;
  const crossfade = typeof body?.crossfadeSeconds === 'number' ? body.crossfadeSeconds : 0;

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
  } else if (Array.isArray(body?.snapshotStates) && body.snapshotStates.length > 0) {
    // 顯式 snapshot：每個 object 的 position/rotation
    const stmts = [];
    for (const s of body.snapshotStates) {
      if (!s?.objectId || !/^[a-zA-Z0-9_-]{1,64}$/.test(s.objectId)) continue;
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
    }
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
  await logActivity(request, env, projectId, 'reset', 'cue', cueId, { name: before?.name, removed: result.meta.changes });
  return jsonResp({ ok: true, removed: result.meta.changes });
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

async function getCue(env, cueId) {
  const row = await env.DB.prepare(`SELECT * FROM cues WHERE id = ? LIMIT 1`).bind(cueId).first();
  if (!row) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ cue: parseCueRow(row) });
}

async function updateCue(request, env, projectId, cueId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }

  const before = await env.DB.prepare(`SELECT name FROM cues WHERE id = ? LIMIT 1`).bind(cueId).first();

  const sets = [], values = [];
  if ('name' in body) { sets.push('name = ?'); values.push((body.name || '').toString().trim().slice(0, CUE_NAME_MAX)); }
  if ('order' in body) { sets.push('"order" = ?'); values.push(body.order); }
  if ('position' in body) { sets.push('position_xyz = ?'); values.push(JSON.stringify(body.position)); }
  if ('rotation' in body) { sets.push('rotation_xyz = ?'); values.push(JSON.stringify(body.rotation)); }
  if ('fov' in body) { sets.push('fov = ?'); values.push(body.fov); }
  if ('crossfadeSeconds' in body) { sets.push('crossfade_seconds = ?'); values.push(body.crossfadeSeconds); }
  if ('videoTimeSec' in body) {
    const v = body.videoTimeSec;
    sets.push('video_time_sec = ?');
    values.push(typeof v === 'number' && isFinite(v) && v >= 0 ? v : null);
  }
  if ('status' in body) { sets.push('status = ?'); values.push(body.status); }

  if (!sets.length) return jsonResp({ error: 'no updatable fields' }, 400);
  values.push(cueId);

  const result = await env.DB.prepare(
    `UPDATE cues SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...values).run();
  if (!result.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  await logActivity(request, env, projectId, 'update', 'cue', cueId, { name: before?.name, changes: body });
  return jsonResp({ ok: true });
}

async function deleteCue(request, env, projectId, cueId) {
  const before = await env.DB.prepare(`SELECT name FROM cues WHERE id = ? LIMIT 1`).bind(cueId).first();
  const result = await env.DB.prepare(`DELETE FROM cues WHERE id = ?`).bind(cueId).run();
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

async function handleStageObjects(request, env, projectId, objIdOrAction) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) return jsonResp({ error: 'Invalid project id' }, 400);

  try {
    if (!objIdOrAction) {
      if (request.method === 'GET') return listStageObjects(env, projectId);
      if (request.method === 'POST') return createStageObject(request, env, projectId);
      return jsonResp({ error: 'Method not allowed' }, 405);
    }

    if (objIdOrAction === 'seed-defaults') {
      if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405);
      return seedDefaultStageObjects(request, env, projectId);
    }
    if (objIdOrAction === 'bulk') {
      if (request.method !== 'POST') return jsonResp({ error: 'Method not allowed' }, 405);
      return bulkCreateStageObjects(request, env, projectId);
    }

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(objIdOrAction)) return jsonResp({ error: 'Invalid obj id' }, 400);

    if (request.method === 'PATCH') return updateStageObject(request, env, projectId, objIdOrAction);
    if (request.method === 'DELETE') return deleteStageObject(request, env, projectId, objIdOrAction);
    return jsonResp({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

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

    // 用 timestamp + project 當 key（保留版本紀錄）
    const ts = Date.now();
    const key = `models/${projectId}/${ts}.glb`;

    // 把 body 直接串到 R2
    await env.MODELS.put(key, request.body, {
      httpMetadata: { contentType: 'model/gltf-binary' },
      customMetadata: { projectId, uploadedAt: new Date().toISOString() },
    });

    // 更新 project.model_r2_key
    await env.DB.prepare(
      `UPDATE projects SET model_r2_key = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(key, projectId).run();

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

  await env.DB.prepare(
    `UPDATE projects SET model_r2_key = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(a.r2_key, projectId).run();

  await logActivity(request, env, projectId, 'activate', 'model', a.r2_key, {
    fromAsset: assetId, assetName: a.name, key: a.r2_key,
  });
  return jsonResp({ ok: true, key: a.r2_key, url: `/r2/${a.r2_key}` });
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

  // 物件解析：key = models/{projectId}/{ts}.glb；ts 是 Date.now()
  const versions = (listed.objects || []).map(obj => {
    const m = obj.key.match(/\/(\d+)\.glb$/);
    const ts = m ? parseInt(m[1], 10) : 0;
    return {
      key: obj.key,
      url: `/r2/${obj.key}`,
      size: obj.size,
      uploaded: obj.uploaded?.toISOString?.() || null,
      timestamp: ts,
      isActive: obj.key === activeKey,
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

  await env.DB.prepare(
    `UPDATE projects SET model_r2_key = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(key, projectId).run();

  await logActivity(request, env, projectId, 'activate', 'model', key, {
    fromKey: beforeRow?.model_r2_key,
    toKey: key,
  });
  return jsonResp({ ok: true, key, url: `/r2/${key}` });
}

// 刪除某舊版本（不能刪當前 active）
async function deleteModelVersion(request, env, projectId, tsFile) {
  if (!/^\d+\.glb$/.test(tsFile)) return jsonResp({ error: 'Invalid version' }, 400);
  const key = `models/${projectId}/${tsFile}`;

  const row = await env.DB.prepare(
    `SELECT model_r2_key FROM projects WHERE id = ? LIMIT 1`
  ).bind(projectId).first();
  if (row?.model_r2_key === key) {
    return jsonResp({ error: '不能刪除當前使用的版本，請先切到別的版本再刪' }, 400);
  }

  await env.MODELS.delete(key);
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

  const obj = await env.MODELS.get(r2Key);
  if (!obj) return jsonResp({ error: 'Not found' }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=3600');
  Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));

  return new Response(obj.body, { status: 200, headers });
}

// Bulk create stage_objects（GLB 解析後一次匯入）
async function bulkCreateStageObjects(request, env, projectId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }

  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || !items.length) return jsonResp({ error: 'items required' }, 400);
  if (items.length > 200) return jsonResp({ error: 'too many items (max 200)' }, 400);

  const replace = !!body?.replace; // 若 true，先清掉專案所有舊 stage_objects
  if (replace) {
    await env.DB.prepare(`DELETE FROM stage_objects WHERE project_id = ?`).bind(projectId).run();
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
  await logActivity(request, env, projectId, 'bulk_create', 'stage_object', null, { inserted, skipped, replace });
  return jsonResp({ ok: true, inserted, skipped });
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

async function handleCueStates(request, env, projectId, songId, cueId, objId) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  if (![projectId, songId, cueId].every(s => /^[a-zA-Z0-9_-]{1,64}$/.test(s))) {
    return jsonResp({ error: 'Invalid id' }, 400);
  }

  try {
    if (!objId) {
      if (request.method === 'GET') return listCueStates(env, projectId, cueId);
      return jsonResp({ error: 'Method not allowed' }, 405);
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(objId)) return jsonResp({ error: 'Invalid obj id' }, 400);

    if (request.method === 'PUT') return upsertCueState(request, env, cueId, objId);
    if (request.method === 'DELETE') return deleteCueState(request, env, projectId, cueId, objId);
    return jsonResp({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

async function listCueStates(env, projectId, cueId) {
  // 找當前 cue 的 song + order，用來算 tracking
  const cueRow = await env.DB.prepare(
    `SELECT song_id, "order" AS cue_order FROM cues WHERE id = ? LIMIT 1`
  ).bind(cueId).first();

  // 拿同 song 內 order < 當前 cue 的所有 cue 的 override（給 tracking 用）
  // tracking 規則：對每個 stage_object，若當前 cue 沒 override，找前面 cue 中最近一個有 override 的
  let trackingOverrides = new Map(); // stage_object_id -> { position, rotation, scale, visible, fromCueOrder }
  if (cueRow) {
    const earlier = await env.DB.prepare(`
      SELECT cos.stage_object_id, cos.position, cos.rotation, cos.scale, cos.visible, c."order" AS cue_order
        FROM cue_object_states cos
        JOIN cues c ON cos.cue_id = c.id
       WHERE c.song_id = ? AND c."order" < ?
       ORDER BY c."order" ASC
    `).bind(cueRow.song_id, cueRow.cue_order).all();
    for (const row of (earlier.results || [])) {
      // 取最近的（cue_order 最大）— 因為 ORDER BY ASC 後面 overwrite 前面
      trackingOverrides.set(row.stage_object_id, {
        position: row.position, rotation: row.rotation, scale: row.scale, visible: row.visible,
        fromCueOrder: row.cue_order,
      });
    }
  }

  // 主 query：每個 stage_object + 當前 cue 的 own override
  const r = await env.DB.prepare(`
    SELECT
      o.id            AS object_id,
      o.mesh_name,
      o.display_name,
      o.category,
      o."order"       AS object_order,
      o.default_position,
      o.default_rotation,
      o.default_scale,
      o.metadata,
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
  `).bind(cueId, projectId).all();

  const safe = (s, fb) => s == null ? fb : (() => { try { return JSON.parse(s); } catch { return fb; } })();

  const items = (r.results || []).map(row => {
    const def = {
      position: safe(row.default_position, { x: 0, y: 0, z: 0 }),
      rotation: safe(row.default_rotation, { pitch: 0, yaw: 0, roll: 0 }),
      scale: safe(row.default_scale, { x: 1, y: 1, z: 1 }),
    };
    const hasOverride = row.state_updated_at != null;
    const tracking = trackingOverrides.get(row.object_id);

    // effective 計算優先序：own override > tracking（前 cue 繼承）> default
    const effPosition = hasOverride && row.state_position ? safe(row.state_position, def.position)
                      : tracking?.position ? safe(tracking.position, def.position)
                      : def.position;
    const effRotation = hasOverride && row.state_rotation ? safe(row.state_rotation, def.rotation)
                      : tracking?.rotation ? safe(tracking.rotation, def.rotation)
                      : def.rotation;
    const effScale    = hasOverride && row.state_scale    ? safe(row.state_scale, def.scale)
                      : tracking?.scale ? safe(tracking.scale, def.scale)
                      : def.scale;
    const effVisible  = hasOverride && row.state_visible != null ? !!row.state_visible
                      : tracking?.visible != null ? !!tracking.visible
                      : true;

    return {
      objectId: row.object_id,
      meshName: row.mesh_name,
      displayName: row.display_name || row.mesh_name,
      category: row.category,
      order: row.object_order,
      locked: !!row.object_locked,
      default: def,
      override: hasOverride ? {
        position: safe(row.state_position, null),
        rotation: safe(row.state_rotation, null),
        scale: safe(row.state_scale, null),
        visible: row.state_visible == null ? null : !!row.state_visible,
        customProps: safe(row.state_custom, null),
        updatedAt: row.state_updated_at,
      } : null,
      // 標記是否來自 tracking（前 cue 繼承）— 給 UI 區分用
      tracked: !hasOverride && !!tracking,
      effective: {
        position: effPosition,
        rotation: effRotation,
        scale: effScale,
        visible: effVisible,
      },
    };
  });

  return jsonResp({ states: items });
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
// Comments API
// ─────────────────────────────────────────────

async function handleComments(request, env, url) {
  if (!env.COMMENTS) {
    return jsonResp({ error: 'KV not configured' }, 500);
  }

  const session = url.searchParams.get('session');
  if (!session || !SESSION_ID_RE.test(session)) {
    return jsonResp({ error: 'Missing or invalid session' }, 400);
  }

  const key = `s:${session}`;

  if (request.method === 'GET') {
    const data = await env.COMMENTS.get(key);
    const comments = data ? JSON.parse(data) : [];
    return jsonResp({ comments });
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResp({ error: 'Invalid JSON' }, 400);
    }

    const c = sanitizeComment(body && body.comment);
    if (!c) return jsonResp({ error: 'Invalid comment' }, 400);

    const existing = await env.COMMENTS.get(key);
    const list = existing ? JSON.parse(existing) : [];

    if (list.length >= MAX_COMMENTS_PER_SESSION) {
      return jsonResp({ error: 'Session comment limit reached' }, 429);
    }
    if (list.some(x => x.id === c.id)) {
      return jsonResp({ ok: true, duplicate: true, comments: list });
    }

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
    // 只允許特定欄位 patch
    const allowed = ['status', 'text', 'resolvedBy', 'resolvedAt'];
    const patched = { ...list[idx] };
    for (const k of allowed) {
      if (k in body) patched[k] = body[k];
    }
    // 重跑 sanitize
    const safe = sanitizeComment(patched);
    if (!safe) return jsonResp({ error: 'Invalid patched comment' }, 400);
    list[idx] = safe;
    await env.COMMENTS.put(key, JSON.stringify(list));
    return jsonResp({ ok: true, comments: list });
  }

  if (request.method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id || !COMMENT_ID_RE.test(id)) {
      return jsonResp({ error: 'Missing or invalid id' }, 400);
    }
    const existing = await env.COMMENTS.get(key);
    if (!existing) return jsonResp({ ok: true, comments: [] });

    const list = JSON.parse(existing).filter(x => x.id !== id);
    await env.COMMENTS.put(key, JSON.stringify(list));
    return jsonResp({ ok: true, comments: list });
  }

  return jsonResp({ error: 'Method not allowed' }, 405);
}

function sanitizeComment(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.id !== 'string' || !COMMENT_ID_RE.test(c.id)) return null;
  if (typeof c.text !== 'string') return null;

  const text = c.text.slice(0, MAX_TEXT_LEN).trim();
  if (!text) return null;

  const num = (v, def = 0) => (typeof v === 'number' && isFinite(v)) ? v : def;
  const str = (v, max = 200) => (typeof v === 'string') ? v.slice(0, max) : '';

  // 3D anchor（可選）— anchor.type = 'world' | 'mesh' | 'screen'
  let anchor = null;
  if (c.anchor && typeof c.anchor === 'object') {
    const a = c.anchor;
    if (a.type === 'world' && a.world && typeof a.world === 'object') {
      anchor = {
        type: 'world',
        world: {
          x: num(a.world.x, 0),
          y: num(a.world.y, 0),
          z: num(a.world.z, 0),
        },
      };
    } else if (a.type === 'mesh' && typeof a.meshName === 'string') {
      anchor = {
        type: 'mesh',
        meshName: str(a.meshName, 120),
        offset: a.offset && typeof a.offset === 'object' ? {
          x: num(a.offset.x, 0),
          y: num(a.offset.y, 0),
          z: num(a.offset.z, 0),
        } : null,
      };
    } else if (a.type === 'screen') {
      anchor = { type: 'screen' }; // 預設
    }
  }

  // role 兼容：舊版只有 designer / director；新增 animator
  const role = (c.role === 'designer' || c.role === 'director' || c.role === 'animator') ? c.role : 'director';

  // resolved 狀態：'open' | 'resolved'（預設 open）
  const status = (c.status === 'resolved' || c.status === 'open') ? c.status : 'open';

  // @mentions：[{ userId, name }, ...]
  let mentions = null;
  if (Array.isArray(c.mentions)) {
    mentions = c.mentions
      .filter(m => m && typeof m === 'object' && typeof m.userId === 'string' && typeof m.name === 'string')
      .slice(0, 20)
      .map(m => ({ userId: str(m.userId, 64), name: str(m.name, 80) }));
  }

  const out = {
    id: c.id,
    time: num(c.time, 0),
    x: Math.max(0, Math.min(1, num(c.x, 0.5))),
    y: Math.max(0, Math.min(1, num(c.y, 0.5))),
    text,
    author: str(c.author, 80) || '匿名',
    email: str(c.email, 200) || null,
    role,
    status,
    createdAt: str(c.createdAt, 40) || new Date().toISOString()
  };
  if (anchor) out.anchor = anchor;
  if (mentions && mentions.length > 0) out.mentions = mentions;
  // 同樣 pass-through resolvedBy / resolvedAt 給 client 用
  if (typeof c.resolvedBy === 'string') out.resolvedBy = str(c.resolvedBy, 80);
  if (typeof c.resolvedAt === 'string') out.resolvedAt = str(c.resolvedAt, 40);
  return out;
}

// ─────────────────────────────────────────────
// GDrive Proxy（原本邏輯 + 友善 quota 錯誤訊息）
// ─────────────────────────────────────────────

async function handleDriveProxy(request, url) {
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

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization',
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
const SESSION_TTL_SEC = 90 * 24 * 3600;
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

// 產生 8 位英數字 access code（去掉容易混的 0/O/1/I/l）
function generateAccessCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}

async function newSessionToken(secret, userId) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
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
  if (sig !== expectedSig) return null;
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

async function getRequestUserId(request, env) {
  // 優先讀 Authorization: Bearer <token>（避開 third-party cookie 限制）
  let token = null;
  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    token = auth.slice(7).trim();
  }
  // fallback：cookie（同 origin 部署時用）
  if (!token) {
    const cookies = parseCookies(request);
    token = cookies[SESSION_COOKIE] || null;
  }
  if (!token) return null;
  const userId = await verifySessionToken(getAuthSecret(env), token);
  if (!userId) return null;
  // 確認該 user 仍然 active
  const u = await env.DB.prepare(
    `SELECT id FROM users WHERE id = ? AND deactivated = 0 LIMIT 1`
  ).bind(userId).first();
  return u ? userId : null;
}

async function getCurrentUser(request, env) {
  const userId = await getRequestUserId(request, env);
  if (!userId) return null;
  const u = await env.DB.prepare(
    `SELECT id, name, role, avatar_color FROM users WHERE id = ? LIMIT 1`
  ).bind(userId).first();
  if (!u) return null;
  return { id: u.id, name: u.name, role: u.role, avatarColor: u.avatar_color };
}

function setSessionCookie(token) {
  // SameSite=None 必填：前端在 localhost / vercel.app / haimiaan.com 等等 cross-origin
  // fetch 到 proxy.haimiaan.com，瀏覽器才會送 cookie。SameSite=None 必須配 Secure。
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
  const code = (body?.accessCode || '').toString().trim().toUpperCase().replace(/\s+/g, '');
  if (!code) return jsonResp({ error: '請輸入號碼' }, 400);

  const u = await env.DB.prepare(
    `SELECT id, name, role, avatar_color, deactivated
       FROM users WHERE access_code = ? LIMIT 1`
  ).bind(code).first();
  if (!u) return jsonResp({ error: '號碼無效' }, 401);
  if (u.deactivated) return jsonResp({ error: '此號碼已停用，請聯絡 admin' }, 403);

  await env.DB.prepare(`UPDATE users SET last_seen_at = datetime('now') WHERE id = ?`).bind(u.id).run();

  const token = await newSessionToken(getAuthSecret(env), u.id);
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
  return jsonResp({ user: me });
}

// ─── Users (admin) CRUD ───

async function handleUsersRouter(request, env, url) {
  if (!env.DB) return jsonResp({ error: 'D1 not configured' }, 500);
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);
  if (me.role !== 'admin') return jsonResp({ error: '權限不足，需要 admin' }, 403);

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
  const users = await env.DB.prepare(
    `SELECT id, name, role, avatar_color, access_code, deactivated, created_at, last_seen_at
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
      accessCode: u.access_code, deactivated: !!u.deactivated,
      createdAt: u.created_at, lastSeenAt: u.last_seen_at,
      projects: byUser[u.id] || [],
    })),
  });
}

async function createUser(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  const name = (body?.name || '').toString().trim().slice(0, 80);
  const role = ['admin', 'animator', 'director'].includes(body?.role) ? body.role : 'animator';
  const avatarColor = (body?.avatarColor || '#10c78a').toString().slice(0, 8);
  let accessCode = (body?.accessCode || '').toString().trim().toUpperCase().replace(/\s+/g, '');
  if (!name) return jsonResp({ error: 'name 必填' }, 400);
  if (accessCode && accessCode.length < 4) return jsonResp({ error: '自訂 access code 至少 4 個字' }, 400);
  if (accessCode && accessCode.length > 32) return jsonResp({ error: 'access code 太長（最多 32 字）' }, 400);

  // 沒給就自動產生
  if (!accessCode) accessCode = generateAccessCode();

  // 檢查 code 重複
  const exists = await env.DB.prepare(`SELECT id FROM users WHERE access_code = ? LIMIT 1`).bind(accessCode).first();
  if (exists) return jsonResp({ error: '這個 access code 已被使用，請改一個' }, 409);

  const id = 'u_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  // email 必填（schema NOT NULL）→ 內部 placeholder
  const placeholderEmail = `${id}@auto.local`;
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, role, avatar_color, access_code)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, placeholderEmail, name, role, avatarColor, accessCode).run();

  // optional: 同時指派 project
  const projectIds = Array.isArray(body?.projectIds) ? body.projectIds : [];
  for (const pid of projectIds) {
    if (typeof pid !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(pid)) continue;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)`
    ).bind(pid, id, role).run();
  }

  return jsonResp({ ok: true, id, accessCode }, 201);
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
  if ('deactivated' in body) { sets.push('deactivated = ?'); values.push(body.deactivated ? 1 : 0); }
  if (!sets.length) return jsonResp({ error: 'no updatable fields' }, 400);
  values.push(userId);
  const r = await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
  if (!r.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ ok: true });
}

async function setAccessCode(request, env, userId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }
  let code = (body?.accessCode || '').toString().trim().toUpperCase().replace(/\s+/g, '');
  // 沒給就自動產生
  if (!code) code = generateAccessCode();
  if (code.length < 4) return jsonResp({ error: 'access code 至少 4 個字' }, 400);
  if (code.length > 32) return jsonResp({ error: 'access code 太長' }, 400);

  const exists = await env.DB.prepare(
    `SELECT id FROM users WHERE access_code = ? AND id != ? LIMIT 1`
  ).bind(code, userId).first();
  if (exists) return jsonResp({ error: '這個 access code 已被別人使用' }, 409);

  const r = await env.DB.prepare(`UPDATE users SET access_code = ? WHERE id = ?`).bind(code, userId).run();
  if (!r.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ ok: true, accessCode: code });
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
  if (!role) return jsonResp({ error: 'role 必填（admin/animator/director）' }, 400);

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
    if (!assetId) {
      if (request.method === 'GET') return listAssets(env);
      if (request.method === 'POST') {
        if (me.role !== 'admin') return jsonResp({ error: '需要 admin' }, 403);
        return createAsset(request, env, me);
      }
      return jsonResp({ error: 'Method not allowed' }, 405);
    }

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(assetId)) return jsonResp({ error: 'Invalid asset id' }, 400);

    if (action === 'file') {
      if (request.method === 'PUT') {
        if (me.role !== 'admin') return jsonResp({ error: '需要 admin' }, 403);
        return uploadAssetFile(request, env, assetId);
      }
      return jsonResp({ error: 'Method not allowed' }, 405);
    }

    if (request.method === 'GET') return getAsset(env, assetId);
    if (request.method === 'PATCH') {
      if (me.role !== 'admin') return jsonResp({ error: '需要 admin' }, 403);
      return updateAsset(request, env, assetId);
    }
    if (request.method === 'DELETE') {
      if (me.role !== 'admin') return jsonResp({ error: '需要 admin' }, 403);
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
  const r2Key = `assets/models/${id}.glb`;

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
    const userId = (request && (await getRequestUserId(request, env))) || 'u_phang';
    const id = 'a_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    await env.DB.prepare(
      `INSERT INTO activity_log (id, project_id, user_id, action, target_type, target_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, projectId, userId, action, targetType, targetId || null, JSON.stringify(payload)).run();
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
  if (me.role !== 'admin') return jsonResp({ error: '只有 admin 可連 Drive' }, 403);

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
  if (me.role !== 'admin') return jsonResp({ error: '只有 admin' }, 403);

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
  if (me.role !== 'admin') return jsonResp({ error: '只有 admin' }, 403);

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
  if (me.role !== 'admin') return jsonResp({ error: '只有 admin' }, 403);

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
  if (songId !== null && typeof songId !== 'string') return jsonResp({ error: 'Invalid songId' }, 400);
  await env.DB.prepare(
    `UPDATE drive_files SET song_id = ?, classified_by = 'manual'
      WHERE id = ? AND project_id = ?`
  ).bind(songId, fid, projectId).run();
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

  const pattern = proj.drive_filename_pattern || '^S(\\d+)_';

  let regex;
  try { regex = new RegExp(pattern); }
  catch (e) { throw new Error('Invalid filename pattern: ' + e.message); }

  // 列 folder 內所有非 trashed 檔案（pageSize=1000，超過再分頁）
  const q = `'${proj.drive_folder_id.replace(/'/g, "\\'")}' in parents and trashed = false`;
  let pageToken = null;
  const all = [];
  let pages = 0;
  do {
    const data = await driveApiGet(env, proj.drive_oauth_token_id, '/files', {
      q,
      pageSize: '1000',
      fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,size,thumbnailLink,webViewLink,webContentLink,iconLink)',
      orderBy: 'modifiedTime desc',
      ...(pageToken ? { pageToken } : {}),
    });
    for (const f of (data.files || [])) all.push(f);
    pageToken = data.nextPageToken || null;
    pages++;
    if (pages > 5) break; // safety: 5000 檔上限
  } while (pageToken);

  // 列 project 的歌（依 order）→ 按 pattern.match 結果分發
  const songsR = await env.DB.prepare(
    `SELECT id, "order" FROM songs WHERE project_id = ? ORDER BY "order"`
  ).bind(projectId).all();
  const songsByOrder = new Map();
  for (const s of (songsR.results || [])) songsByOrder.set(Number(s.order) + 1, s.id);
  // 也支援 1-based song.order：很多人習慣 song.order 從 0 開始，但 S03 對應 order=2
  // 為了相容兩者，下面分配時兩個都嘗試

  // 既有的 drive_files（key 為 drive_file_id）→ 用來判斷新增/更新/移除
  const existingR = await env.DB.prepare(
    `SELECT id, drive_file_id, classified_by, song_id FROM drive_files WHERE project_id = ?`
  ).bind(projectId).all();
  const existingByDriveId = new Map();
  for (const e of (existingR.results || [])) existingByDriveId.set(e.drive_file_id, e);

  let classified = 0, unclassified = 0;
  const seenDriveIds = new Set();
  const stmts = [];

  for (const f of all) {
    seenDriveIds.add(f.id);
    let songId = null;
    const m = regex.exec(f.name);
    if (m && m[1]) {
      const num = parseInt(m[1], 10);
      // 嘗試 1-based 然後 0-based
      songId = songsByOrder.get(num) || songsByOrder.get(num + 1) || null;
    }
    if (songId) classified++;
    else unclassified++;

    const existing = existingByDriveId.get(f.id);
    // 如果用戶手動 assign 過，保留他的 song_id（不要被 pattern 蓋掉）
    if (existing && existing.classified_by === 'manual') {
      songId = existing.song_id;
    }

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

  const dur = Date.now() - t0;
  const logId = 'dsl_' + randHex(8);
  await env.DB.prepare(`
    INSERT INTO drive_sync_log (id, project_id, triggered_by, files_found,
                                  files_classified, files_unclassified, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(logId, projectId, triggeredBy, all.length, classified, unclassified, dur).run();

  return { filesFound: all.length, classified, unclassified, durationMs: dur };
}

// ── Stream proxy（給導演 video player 用）──
// 設計：用 stream_url（webContentLink）會卡 Drive 的 100MB 確認頁，所以走 Drive API 的
//   GET /drive/v3/files/{id}?alt=media（要 access token）
//   Range header 直接 forward 給 Google
async function driveStreamFile(request, env, fid) {
  if (!fid) return jsonResp({ error: 'Missing file id' }, 400);

  // 找這個 drive_file_id 屬於哪個 project（順便驗權）
  const f = await env.DB.prepare(
    `SELECT df.project_id, df.filename, df.mime_type, p.drive_oauth_token_id
       FROM drive_files df
       JOIN projects p ON df.project_id = p.id
      WHERE df.drive_file_id = ?
      LIMIT 1`
  ).bind(fid).first();
  if (!f) return jsonResp({ error: 'File not found' }, 404);

  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);
  // 非 admin 要在 project_members
  if (me.role !== 'admin') {
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
// 開 https://stage-previz.vercel.app/share/<token> 直接看 read-only preview
// ─────────────────────────────────────────────

async function handleProjectShareLinks(request, env, url) {
  // /api/projects/:projectId/share-links               GET / POST
  // /api/projects/:projectId/share-links/:token        DELETE
  const me = await getCurrentUser(request, env);
  if (!me) return jsonResp({ error: '未登入' }, 401);

  const segs = url.pathname.split('/').filter(Boolean);
  // [api, projects, projectId, share-links, token?]
  const projectId = segs[2];
  const token = segs[4] || null;

  // 權限：admin 或 project_members
  if (me.role !== 'admin') {
    const m = await env.DB.prepare(
      `SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1`
    ).bind(projectId, me.id).first();
    if (!m) return jsonResp({ error: '沒有權限' }, 403);
  }

  if (!token) {
    if (request.method === 'GET') {
      const r = await env.DB.prepare(
        `SELECT token, project_id, song_id, password IS NOT NULL AS has_password,
                expires_at, view_count, last_viewed_at, created_at
           FROM share_links WHERE project_id = ? ORDER BY created_at DESC`
      ).bind(projectId).all();
      return jsonResp({
        links: (r.results || []).map(l => ({
          token: l.token,
          projectId: l.project_id,
          songId: l.song_id,
          hasPassword: !!l.has_password,
          expiresAt: l.expires_at,
          viewCount: l.view_count,
          lastViewedAt: l.last_viewed_at,
          createdAt: l.created_at,
        })),
      });
    }
    if (request.method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const songId = body?.songId && /^[a-zA-Z0-9_-]{1,64}$/.test(body.songId) ? body.songId : null;
      const password = typeof body?.password === 'string' && body.password ? body.password.slice(0, 60) : null;
      const expiresInDays = typeof body?.expiresInDays === 'number' && body.expiresInDays > 0 ? Math.min(body.expiresInDays, 365) : null;
      const tk = randHex(16);
      const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86400_000).toISOString() : null;
      await env.DB.prepare(`
        INSERT INTO share_links (token, project_id, song_id, password, expires_at, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(tk, projectId, songId, password, expiresAt, me.id).run();
      return jsonResp({ token: tk, expiresAt }, 201);
    }
    return jsonResp({ error: 'Method not allowed' }, 405);
  }

  if (request.method === 'DELETE') {
    await env.DB.prepare(
      `DELETE FROM share_links WHERE token = ? AND project_id = ?`
    ).bind(token, projectId).run();
    return jsonResp({ ok: true });
  }
  return jsonResp({ error: 'Method not allowed' }, 405);
}

// ── 公開存取（read-only，無需登入）──
async function handleShareRouter(request, env, url, token) {
  if (!token || !/^[a-zA-Z0-9_-]{1,64}$/.test(token)) return jsonResp({ error: 'Invalid token' }, 400);

  const segs = url.pathname.split('/').filter(Boolean);
  // [api, share, token, ...rest]
  const sub = segs[3] || null;        // 'data' / 'cues' / 'states' / 'comments'

  const link = await env.DB.prepare(
    `SELECT token, project_id, song_id, password, expires_at FROM share_links WHERE token = ? LIMIT 1`
  ).bind(token).first();
  if (!link) return jsonResp({ error: 'Share link not found' }, 404);
  if (link.expires_at && new Date(link.expires_at + 'Z').getTime() < Date.now()) {
    return jsonResp({ error: 'Share link expired' }, 410);
  }

  // 密碼檢查（password via header X-Share-Password）
  if (link.password) {
    const provided = request.headers.get('x-share-password') || url.searchParams.get('p') || '';
    if (provided !== link.password) {
      return jsonResp({ error: 'Password required', requiresPassword: true }, 401);
    }
  }

  // bump view counter（GET data 才算數，避免 stream 每幀 ++）
  if (sub === 'data' && request.method === 'GET') {
    await env.DB.prepare(
      `UPDATE share_links SET view_count = view_count + 1, last_viewed_at = datetime('now') WHERE token = ?`
    ).bind(token).run();
  }

  if (sub === 'data' && request.method === 'GET') {
    // bundle 給 share viewer：project meta + songs + stage_objects + model
    const proj = await env.DB.prepare(
      `SELECT id, name, description, model_r2_key FROM projects WHERE id = ? AND status != 'archived' LIMIT 1`
    ).bind(link.project_id).first();
    if (!proj) return jsonResp({ error: 'Project not found' }, 404);

    const songsR = await env.DB.prepare(
      `SELECT id, name, "order", status FROM songs WHERE project_id = ? ${link.song_id ? 'AND id = ?' : ''} ORDER BY "order"`
    ).bind(...(link.song_id ? [link.project_id, link.song_id] : [link.project_id])).all();

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

    return jsonResp({
      project: { id: proj.id, name: proj.name, description: proj.description },
      modelUrl: proj.model_r2_key ? `/r2/${proj.model_r2_key}` : null,
      songs: (songsR.results || []).map(s => ({ id: s.id, name: s.name, order: s.order, status: s.status })),
      stageObjects,
      restrictedToSongId: link.song_id,
    });
  }

  if (sub === 'songs' && request.method === 'GET') {
    const songId = segs[4];
    const cuesOnly = segs[5] === 'cues' && !segs[6];
    const cueId = segs[5] === 'cues' && segs[6] ? segs[6] : null;
    const wantStates = cueId && segs[7] === 'states';
    const wantVideos = segs[5] === 'videos';
    if (!songId) return jsonResp({ error: 'Missing songId' }, 400);
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
        videos: (r.results || []).map(f => ({
          id: f.id,
          driveFileId: f.drive_file_id,
          filename: f.filename,
          mimeType: f.mime_type,
          modifiedTime: f.modified_time,
          sizeBytes: f.size_bytes,
          // 公開存取的 stream URL：用 share token 認證
          streamUrl: `/api/share/${token}/videos/${f.drive_file_id}/stream`,
        })),
      });
    }
    if (wantStates) {
      // 套既有 listCueStates 邏輯（簡版：直接抓 cue_object_states + stage_objects join）
      // 這裡用 inline 簡化：把 stage_objects + cue_object_states 合成 effective state
      const objsR = await env.DB.prepare(
        `SELECT * FROM stage_objects WHERE project_id = ? ORDER BY "order"`
      ).bind(link.project_id).all();
      const statesR = await env.DB.prepare(
        `SELECT * FROM cue_object_states WHERE cue_id = ?`
      ).bind(cueId).all();
      const overrides = new Map();
      for (const s of (statesR.results || [])) overrides.set(s.stage_object_id, s);
      const safeJsonObj = (s, def = {}) => { try { const v = JSON.parse(s || ''); return v || def; } catch { return def; } };
      const out = (objsR.results || []).map(o => {
        const ov = overrides.get(o.id);
        const def = {
          position: safeJsonObj(o.default_position, { x: 0, y: 0, z: 0 }),
          rotation: safeJsonObj(o.default_rotation, { pitch: 0, yaw: 0, roll: 0 }),
          scale: safeJsonObj(o.default_scale, { x: 1, y: 1, z: 1 }),
        };
        const ovObj = ov ? {
          position: ov.position ? safeJsonObj(ov.position, null) : null,
          rotation: ov.rotation ? safeJsonObj(ov.rotation, null) : null,
          scale: ov.scale ? safeJsonObj(ov.scale, null) : null,
          visible: ov.visible !== null && ov.visible !== undefined ? !!ov.visible : null,
          customProps: ov.custom_props ? safeJsonObj(ov.custom_props, null) : null,
          updatedAt: ov.updated_at,
        } : null;
        const eff = {
          position: ovObj?.position || def.position,
          rotation: ovObj?.rotation || def.rotation,
          scale: ovObj?.scale || def.scale,
          visible: ovObj?.visible ?? true,
        };
        return {
          objectId: o.id, meshName: o.mesh_name, displayName: o.display_name,
          category: o.category, order: o.order, locked: !!o.locked,
          default: def, override: ovObj, effective: eff,
        };
      });
      return jsonResp({ states: out });
    }
    return jsonResp({ error: 'Bad share sub-path' }, 404);
  }

  // /api/share/:token/videos/:driveFileId/stream — 公開存取串流
  if (sub === 'videos' && segs[4] && segs[5] === 'stream' && (request.method === 'GET' || request.method === 'HEAD')) {
    const driveFileId = segs[4];
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
    return new Response(upstream.body, { status: upstream.status, headers: passHeaders });
  }

  return jsonResp({ error: 'Bad share request' }, 404);
}
