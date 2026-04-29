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

  if (url.pathname === '/api/users' || url.pathname.startsWith('/api/users/')) {
    return handleUsersRouter(request, env, url);
  }

  if (url.pathname === '/api/assets' || url.pathname.startsWith('/api/assets/')) {
    return handleAssetsRouter(request, env, url);
  }

  if (url.pathname === '/api/projects/import' && request.method === 'POST') {
    return importProject(request, env);
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

  if (sub === 'export') {
    if (request.method !== 'GET') return jsonResp({ error: 'Method not allowed' }, 405);
    return exportProject(request, env, projectId);
  }

  if (sub === 'songs' && sub2 === 'cues' && sub3 === 'states') {
    return handleCueStates(request, env, projectId, songId, cueId, objId);
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
      if (request.method === 'GET') return listProjects(env, me);
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

async function listProjects(env, me) {
  // admin 看全部，其他 role 只看自己被加進 project_members 的 project
  const memberFilter = me?.role === 'admin'
    ? ''
    : ` AND p.id IN (SELECT pm.project_id FROM project_members pm WHERE pm.user_id = ?)`;
  const binds = me?.role === 'admin' ? [] : [me.id];

  const projects = await env.DB.prepare(`
    SELECT
      p.id, p.name, p.description, p.thumbnail_r2_key, p.status, p.show_id,
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
    WHERE p.status != 'archived'${memberFilter}
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

  const list = (projects.results || []).map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    thumbnailUrl: p.thumbnail_r2_key ? `/r2/${p.thumbnail_r2_key}` : null,
    status: p.status,
    showId: p.show_id || null,
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

  const allowed = ['name', 'description', 'status', 'drive_folder_id', 'drive_filename_pattern', 'show_id'];
  // 前端 camelCase showId 轉 snake_case show_id
  if ('showId' in body && !('show_id' in body)) body.show_id = body.showId;
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

async function listCues(env, songId) {
  const r = await env.DB.prepare(`
    SELECT id, name, "order", position_xyz, rotation_xyz, fov, crossfade_seconds,
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
  }
  // 都沒給 → 空白 cue（無 override）

  const cueOrigin = body?.cloneFrom ? 'clone'
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
  // LEFT JOIN：每個 stage_object 都列出，有覆蓋的話 state 有值，沒覆蓋 state 為 NULL
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
      // 「effective」= override 蓋過 default
      effective: {
        position: hasOverride && row.state_position ? safe(row.state_position, def.position) : def.position,
        rotation: hasOverride && row.state_rotation ? safe(row.state_rotation, def.rotation) : def.rotation,
        scale: hasOverride && row.state_scale ? safe(row.state_scale, def.scale) : def.scale,
        visible: hasOverride && row.state_visible != null ? !!row.state_visible : true,
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

  return {
    id: c.id,
    time: num(c.time, 0),
    x: Math.max(0, Math.min(1, num(c.x, 0.5))),
    y: Math.max(0, Math.min(1, num(c.y, 0.5))),
    text,
    author: str(c.author, 80) || '匿名',
    email: str(c.email, 200) || null,
    role: (c.role === 'designer' || c.role === 'director') ? c.role : 'director',
    createdAt: str(c.createdAt, 40) || new Date().toISOString()
  };
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
