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
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === '/api/comments') {
      return handleComments(request, env, url);
    }

    if (url.pathname === '/api/projects' || url.pathname.startsWith('/api/projects/')) {
      return handleProjectsRouter(request, env, url);
    }

    if (url.pathname === '/' || url.pathname === '') {
      return handleDriveProxy(request, url);
    }

    return jsonResp({ error: 'Not found' }, 404);
  }
};

// 統一 router：把 /api/projects/* 分派到 projects / songs / cues 對應 handler
async function handleProjectsRouter(request, env, url) {
  const segs = url.pathname.split('/').filter(Boolean);
  // 路徑形態：
  //   /api/projects                          → projects collection
  //   /api/projects/:id                      → project item
  //   /api/projects/:id/songs                → songs collection
  //   /api/projects/:id/songs/:songId        → song item
  //   /api/projects/:id/songs/:songId/cues   → cues collection
  //   /api/projects/:id/songs/:songId/cues/:cueId → cue item

  const projectId = segs[2] || null;
  const sub = segs[3] || null; // 'songs' or undefined
  const songId = segs[4] || null;
  const sub2 = segs[5] || null; // 'cues' or undefined
  const cueId = segs[6] || null;

  if (!projectId) {
    return handleProjects(request, env, null, null);
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

  try {
    if (!projectId) {
      if (request.method === 'GET') return listProjects(env);
      if (request.method === 'POST') return createProject(request, env);
      return jsonResp({ error: 'Method not allowed' }, 405);
    }

    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) {
      return jsonResp({ error: 'Invalid project id' }, 400);
    }

    if (request.method === 'GET') return getProject(env, projectId);
    if (request.method === 'PATCH') return updateProject(request, env, projectId);
    if (request.method === 'DELETE') return archiveProject(env, projectId);
    return jsonResp({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

async function listProjects(env) {
  // 主資料 + 子計數（song/cue/proposal）+ 成員
  const projects = await env.DB.prepare(`
    SELECT
      p.id, p.name, p.description, p.thumbnail_r2_key, p.status,
      p.created_at, p.updated_at,
      (SELECT COUNT(*) FROM songs s WHERE s.project_id = p.id) AS song_count,
      (SELECT COUNT(*) FROM cues c
        JOIN songs s ON c.song_id = s.id
        WHERE s.project_id = p.id AND c.status = 'master') AS cue_count,
      (SELECT COUNT(*) FROM cues c
        JOIN songs s ON c.song_id = s.id
        WHERE s.project_id = p.id AND c.status = 'proposal') AS proposal_count
    FROM projects p
    WHERE p.status != 'archived'
    ORDER BY p.updated_at DESC
  `).all();

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
    songCount: p.song_count,
    cueCount: p.cue_count,
    proposalCount: p.proposal_count,
    updatedAt: p.updated_at,
    createdAt: p.created_at,
    members: membersByProject[p.id] || [],
  }));

  return jsonResp({ projects: list });
}

async function createProject(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }

  const name = (body?.name || '').toString().trim().slice(0, PROJECT_NAME_MAX);
  const description = (body?.description || '').toString().trim().slice(0, PROJECT_DESC_MAX);
  if (!name) return jsonResp({ error: 'name is required' }, 400);

  const id = 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  await env.DB.prepare(`
    INSERT INTO projects (id, name, description, created_by_user_id)
    VALUES (?, ?, ?, 'u_phang')
  `).bind(id, name, description).run();

  // 把建立者加進 project_members
  await env.DB.prepare(`
    INSERT INTO project_members (project_id, user_id, role)
    VALUES (?, 'u_phang', 'admin')
  `).bind(id).run();

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

  const allowed = ['name', 'description', 'status', 'drive_folder_id', 'drive_filename_pattern'];
  const sets = [], values = [];
  for (const k of allowed) {
    if (k in body) { sets.push(`${k} = ?`); values.push(body[k]); }
  }
  if (!sets.length) return jsonResp({ error: 'no updatable fields' }, 400);

  values.push(projectId);
  const result = await env.DB.prepare(
    `UPDATE projects SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...values).run();

  if (!result.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ ok: true });
}

async function archiveProject(env, projectId) {
  const result = await env.DB.prepare(
    `UPDATE projects SET status = 'archived', updated_at = datetime('now') WHERE id = ?`
  ).bind(projectId).run();
  if (!result.meta.changes) return jsonResp({ error: 'Not found' }, 404);
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
    if (request.method === 'PATCH') return updateSong(request, env, songId);
    if (request.method === 'DELETE') return deleteSong(env, songId);
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
  return jsonResp({ ok: true, id, order }, 201);
}

async function getSong(env, songId) {
  const row = await env.DB.prepare(`SELECT * FROM songs WHERE id = ? LIMIT 1`).bind(songId).first();
  if (!row) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ song: row });
}

async function updateSong(request, env, songId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }

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
  return jsonResp({ ok: true });
}

async function deleteSong(env, songId) {
  const result = await env.DB.prepare(`DELETE FROM songs WHERE id = ?`).bind(songId).run();
  if (!result.meta.changes) return jsonResp({ error: 'Not found' }, 404);
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
      if (request.method === 'POST') return createCue(request, env, songId);
      return jsonResp({ error: 'Method not allowed' }, 405);
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cueId)) return jsonResp({ error: 'Invalid cue id' }, 400);

    if (request.method === 'GET') return getCue(env, cueId);
    if (request.method === 'PATCH') return updateCue(request, env, cueId);
    if (request.method === 'DELETE') return deleteCue(env, cueId);
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

async function createCue(request, env, songId) {
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

  return jsonResp({ ok: true, id, order }, 201);
}

async function getCue(env, cueId) {
  const row = await env.DB.prepare(`SELECT * FROM cues WHERE id = ? LIMIT 1`).bind(cueId).first();
  if (!row) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ cue: parseCueRow(row) });
}

async function updateCue(request, env, cueId) {
  let body;
  try { body = await request.json(); } catch { return jsonResp({ error: 'Invalid JSON' }, 400); }

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
  return jsonResp({ ok: true });
}

async function deleteCue(env, cueId) {
  const result = await env.DB.prepare(`DELETE FROM cues WHERE id = ?`).bind(cueId).run();
  if (!result.meta.changes) return jsonResp({ error: 'Not found' }, 404);
  return jsonResp({ ok: true });
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
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type',
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
