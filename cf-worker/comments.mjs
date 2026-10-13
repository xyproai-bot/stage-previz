// 留言：整理前端送來的內容、資料庫一列 ↔ API 回傳的格式（純函式，不碰資料庫）。
// 留言現在存在 D1 的 comments 表（migrations/0019），一則一列 → 很多人同時留言不會互相蓋掉。
// API 的格式跟以前存在 KV 時完全一樣（前端不用改）：
//   { id, time, x, y, text, author, email, role, status, createdAt, anchor?, mentions?, resolvedBy?, resolvedAt?, authorUserId? }

export const MAX_TEXT_LEN = 2000;
export const MAX_COMMENTS_PER_SONG = 500;
export const COMMENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const num = (v, def = 0) => (typeof v === 'number' && isFinite(v)) ? v : def;
const str = (v, max = 200) => (typeof v === 'string') ? v.slice(0, max) : '';

/** 整理一則留言（前端送來的、或舊的 KV 資料）；不合格回 null */
export function sanitizeComment(c) {
  if (!c || typeof c !== 'object') return null;
  if (typeof c.id !== 'string' || !COMMENT_ID_RE.test(c.id)) return null;
  if (typeof c.text !== 'string') return null;

  const text = c.text.slice(0, MAX_TEXT_LEN).trim();
  if (!text) return null;

  // 3D 錨點（可選）— anchor.type = 'world' | 'mesh' | 'screen'
  let anchor = null;
  if (c.anchor && typeof c.anchor === 'object') {
    const a = c.anchor;
    if (a.type === 'world' && a.world && typeof a.world === 'object') {
      anchor = { type: 'world', world: { x: num(a.world.x, 0), y: num(a.world.y, 0), z: num(a.world.z, 0) } };
    } else if (a.type === 'mesh' && typeof a.meshName === 'string') {
      anchor = {
        type: 'mesh',
        meshName: str(a.meshName, 120),
        offset: a.offset && typeof a.offset === 'object'
          ? { x: num(a.offset.x, 0), y: num(a.offset.y, 0), z: num(a.offset.z, 0) }
          : null,
      };
    } else if (a.type === 'screen') {
      anchor = { type: 'screen' };
    }
  }

  // 身分：舊版只有 designer / director；後來加了 animator
  const role = (c.role === 'designer' || c.role === 'director' || c.role === 'animator') ? c.role : 'director';
  const status = (c.status === 'resolved' || c.status === 'open') ? c.status : 'open';

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
    createdAt: str(c.createdAt, 40) || new Date().toISOString(),
  };
  if (anchor) out.anchor = anchor;
  if (mentions && mentions.length > 0) out.mentions = mentions;
  if (typeof c.resolvedBy === 'string') out.resolvedBy = str(c.resolvedBy, 80);
  if (typeof c.resolvedAt === 'string') out.resolvedAt = str(c.resolvedAt, 40);
  if (typeof c.authorUserId === 'string' && COMMENT_ID_RE.test(c.authorUserId)) out.authorUserId = c.authorUserId;
  return out;
}

/** 整理好的留言 → comments 表的一列（不含 project_id / song_id，呼叫的人補） */
export function commentToRow(c) {
  const a = c.anchor || null;
  return {
    id: c.id,
    time_in_video: c.time,
    anchor_screen_xy: JSON.stringify({ x: c.x, y: c.y }),
    anchor_type: a ? a.type : null,
    anchor_world_xyz: a?.type === 'world' ? JSON.stringify(a.world) : null,
    anchor_mesh_name: a?.type === 'mesh' ? a.meshName : null,
    anchor_offset_xyz: a?.type === 'mesh' && a.offset ? JSON.stringify(a.offset) : null,
    text: c.text,
    mentions: c.mentions && c.mentions.length ? JSON.stringify(c.mentions) : null,
    status: c.status,
    resolved_by: c.resolvedBy ?? null,
    resolved_at: c.resolvedAt ?? null,
    author_user_id: c.authorUserId ?? null,
    author_name: c.author,
    author_role: c.role,
    author_email: c.email ?? null,
    created_at: c.createdAt,
  };
}

const parse = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } };

/** comments 表的一列 → API 格式（跟以前 KV 版本 sanitizeComment 的結果一樣） */
export function rowToComment(r) {
  const xy = parse(r.anchor_screen_xy) || {};
  const out = {
    id: r.id,
    time: num(r.time_in_video, 0),
    x: Math.max(0, Math.min(1, num(xy.x, 0.5))),
    y: Math.max(0, Math.min(1, num(xy.y, 0.5))),
    text: r.text,
    author: r.author_name || '匿名',
    email: r.author_email || null,
    role: r.author_role || 'director',
    status: r.status === 'resolved' ? 'resolved' : 'open',
    createdAt: r.created_at,
  };
  if (r.anchor_type === 'world') {
    const w = parse(r.anchor_world_xyz) || {};
    out.anchor = { type: 'world', world: { x: num(w.x, 0), y: num(w.y, 0), z: num(w.z, 0) } };
  } else if (r.anchor_type === 'mesh') {
    out.anchor = { type: 'mesh', meshName: r.anchor_mesh_name || '', offset: parse(r.anchor_offset_xyz) };
  } else if (r.anchor_type === 'screen') {
    out.anchor = { type: 'screen' };
  }
  const mentions = parse(r.mentions);
  if (Array.isArray(mentions) && mentions.length) out.mentions = mentions;
  if (r.resolved_by != null) out.resolvedBy = r.resolved_by;
  if (r.resolved_at != null) out.resolvedAt = r.resolved_at;
  if (r.author_user_id) out.authorUserId = r.author_user_id;
  return out;
}

/**
 * 改留言（PATCH）時，body 裡哪些欄位要改。
 * - 文字：要是留言的人或 admin（呼叫的人先檢查 canModifyComment）
 * - 已解決 / 重新打開：成員都可以；誰解決、什麼時候由後台記，不信前端
 * @returns {{ ok: true, changes: object, touchesText: boolean } | { ok: false, error: string }}
 */
export function commentPatch(body, me, now = new Date()) {
  const changes = {};
  let touchesText = false;
  if ('text' in body) {
    if (typeof body.text !== 'string') return { ok: false, error: '留言內容不正確' };
    const text = body.text.slice(0, MAX_TEXT_LEN).trim();
    if (!text) return { ok: false, error: '留言內容不能是空的' };
    changes.text = text;
    touchesText = true;
  }
  if ('status' in body) {
    if (body.status !== 'open' && body.status !== 'resolved') return { ok: false, error: '留言狀態不正確' };
    changes.status = body.status;
    if (body.status === 'resolved') {
      changes.resolved_by = String(me?.name || '').slice(0, 80);
      changes.resolved_at = now.toISOString();
    } else {
      changes.resolved_by = '';
      changes.resolved_at = '';
    }
  }
  if (!Object.keys(changes).length) return { ok: false, error: '沒有要改的內容' };
  return { ok: true, changes, touchesText };
}
