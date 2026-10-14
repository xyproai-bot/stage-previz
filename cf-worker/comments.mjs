// 留言：整理前端送來的內容、資料庫一列 ↔ API 回傳的格式（純函式，不碰資料庫）。
// 留言現在存在 D1 的 comments 表（migrations/0019），一則一列 → 很多人同時留言不會互相蓋掉。
// API 的格式跟以前存在 KV 時完全一樣（前端不用改）：
//   { id, time, x, y, text, author, email, role, status, createdAt, anchor?, mentions?, resolvedBy?, resolvedAt?, authorUserId? }

export const MAX_TEXT_LEN = 2000;
export const MAX_COMMENTS_PER_SONG = 500;
export const COMMENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const num = (v, def = 0) => (typeof v === 'number' && isFinite(v)) ? v : def;
const str = (v, max = 200) => (typeof v === 'string') ? v.slice(0, max) : '';

// ─────────────────────────────────────────────
// 審片像 Frame.io（migration 0026）：區段、3D 視角、cue、畫記、縮圖
//   time / timeEnd   區段留言 0:12–0:18（timeEnd 沒有 = 一個時間點）
//   view             留言當下的攝影機：{ position: [x,y,z], target: [x,y,z], fov, aspect? }
//   cueId            留言當下的 cue
//   annotation       畫記（畫在 3D 畫面上的筆、箭頭、方框、圓圈），座標 0~1、跟螢幕大小無關：
//                    { v: 1, aspect, t?, shapes: [{ t: 'pen'|'arrow'|'rect'|'ellipse', c: '#ff3b30', w, p: [x0,y0,x1,y1,...] }] }
//                    （最外層的 t = 畫的那一格；打開留言時先停在那一格）
//   thumbUrl（只有讀）留言當下的畫面縮圖（含畫記），R2 comment-thumbs/…
// 舊版前端不帶這些 → 跟以前一模一樣。規則跟 web/src/lib/annotations.ts 一樣（前端先擋，這裡最後把關）。
// ─────────────────────────────────────────────

export const MAX_VIDEO_SEC = 36000;          // 影片時間最多 10 小時
export const MAX_RANGE_SEC = 3600;           // 一個區段最多 1 小時
export const MIN_RANGE_SEC = 0.05;
export const ANNOTATION_COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff'];
export const ANNOTATION_TOOLS = ['pen', 'arrow', 'rect', 'ellipse'];
export const MAX_SHAPES = 60;
export const MAX_PEN_POINTS = 400;           // 一筆最多幾個點
export const MAX_TOTAL_POINTS = 4000;        // 全部加起來
export const MAX_ANNOTATION_CHARS = 40000;   // 存起來的 JSON 最多幾個字
export const MAX_THUMB_BYTES = 150 * 1024;   // 縮圖 JPEG 最多 150 KB（約 480 px 寬）
export const THUMB_URL_PREFIX = '/api/comment-thumbs/';
const THUMB_KEY_RE = /^comment-thumbs\/[a-zA-Z0-9_-]{1,64}\/[a-zA-Z0-9_-]{1,64}-[0-9a-f]{32}\.jpg$/;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (n, d) => { const k = 10 ** d; return Math.round(n * k) / k; };

/** 3D 視角；不合格回 null（不擋留言，只是不記視角） */
export function sanitizeView(v) {
  if (!v || typeof v !== 'object') return null;
  const vec = (a) => (Array.isArray(a) && a.length === 3 && a.every(n => isNum(n) && Math.abs(n) <= 1e5))
    ? a.map(n => round(n, 4)) : null;
  const position = vec(v.position);
  const target = vec(v.target);
  if (!position || !target) return null;
  const d = Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]);
  if (!(d > 1e-6)) return null;
  if (!isNum(v.fov) || v.fov < 5 || v.fov > 120) return null;
  const out = { position, target, fov: round(v.fov, 3) };
  if (isNum(v.aspect) && v.aspect >= 0.2 && v.aspect <= 6) out.aspect = round(v.aspect, 4);
  return out;
}

/**
 * 畫記：整理好回 { ok: true, value }（沒有畫記 value = null）；格式不對 / 太複雜 → { ok: false, error }
 */
export function sanitizeAnnotation(a) {
  if (a === undefined || a === null) return { ok: true, value: null };
  const bad = (error = '畫記的格式不對，請重新畫一次') => ({ ok: false, error });
  if (typeof a !== 'object' || Array.isArray(a)) return bad();
  if (!Array.isArray(a.shapes)) return bad();
  if (a.shapes.length === 0) return { ok: true, value: null };
  if (a.shapes.length > MAX_SHAPES) return bad(`畫記太多筆了（最多 ${MAX_SHAPES} 筆），請擦掉一些`);
  if (!isNum(a.aspect) || a.aspect < 0.2 || a.aspect > 6) return bad();
  const clamp01 = (n) => round(Math.max(0, Math.min(1, n)), 4);
  let total = 0;
  const shapes = [];
  for (const s of a.shapes) {
    if (!s || typeof s !== 'object') return bad();
    if (!ANNOTATION_TOOLS.includes(s.t)) return bad();
    const color = typeof s.c === 'string' ? s.c.toLowerCase() : '';
    if (!ANNOTATION_COLORS.includes(color)) return bad('畫記的顏色不對');
    if (!isNum(s.w) || s.w <= 0 || s.w > 0.05) return bad();
    if (!Array.isArray(s.p) || s.p.length % 2 !== 0 || !s.p.every(isNum)) return bad();
    const n = s.p.length / 2;
    if (s.t === 'pen' ? (n < 1 || n > MAX_PEN_POINTS) : n !== 2) {
      return s.t === 'pen' && n > MAX_PEN_POINTS ? bad('有一筆畫得太長了，請分成幾筆畫') : bad();
    }
    total += n;
    if (total > MAX_TOTAL_POINTS) return bad('畫記太複雜了，請擦掉一些');
    shapes.push({ t: s.t, c: color, w: round(Math.max(0.001, s.w), 4), p: s.p.map(clamp01) });
  }
  const value = { v: 1, aspect: round(a.aspect, 4), shapes };
  // t = 畫的那一格（影片秒數）：區段留言先標 I / O 再畫時，畫的那一格不一定是區段的開頭
  if (isNum(a.t) && a.t >= 0 && a.t <= MAX_VIDEO_SEC) value.t = round(a.t, 3);
  if (JSON.stringify(value).length > MAX_ANNOTATION_CHARS) return bad('畫記太複雜了，請擦掉一些');
  return { ok: true, value };
}

/**
 * 留言的新欄位（區段、視角、cue、畫記）。區段 / 畫記不對 → 擋下來（說清楚哪裡不對）；視角 / cue 不對 → 當沒帶。
 * @returns {{ ok: true, extras: { timeEnd: number|null, view: object|null, cueId: string|null, annotation: object|null } } | { ok: false, error: string }}
 */
export function commentExtrasInput(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const time = num(c.time, 0);
  if (time < 0 || time > MAX_VIDEO_SEC) return { ok: false, error: '影片時間不正確' };
  let timeEnd = null;
  if (c.timeEnd !== undefined && c.timeEnd !== null) {
    if (!isNum(c.timeEnd)) return { ok: false, error: '區段的結束時間不正確' };
    if (c.timeEnd <= time + MIN_RANGE_SEC - 1e-9) return { ok: false, error: '區段的結束要在開始之後' };
    if (c.timeEnd - time > MAX_RANGE_SEC) return { ok: false, error: '區段太長了（最多 1 小時）' };
    if (c.timeEnd > MAX_VIDEO_SEC) return { ok: false, error: '區段的結束時間不正確' };
    timeEnd = round(c.timeEnd, 3);
  }
  const ann = sanitizeAnnotation(c.annotation);
  if (!ann.ok) return ann;
  const view = sanitizeView(c.view);
  const cueId = typeof c.cueId === 'string' && COMMENT_ID_RE.test(c.cueId) ? c.cueId : null;
  return { ok: true, extras: { timeEnd, view, cueId, annotation: ann.value } };
}

/**
 * 縮圖：前端送 'data:image/jpeg;base64,…'（留言當下抓一次 3D 畫面 + 畫記，最多約 480 px 寬）
 * @returns {{ ok: true, bytes: Uint8Array|null } | { ok: false, error: string, status: number }}
 */
export function decodeThumbnail(dataUrl) {
  if (dataUrl === undefined || dataUrl === null || dataUrl === '') return { ok: true, bytes: null };
  const PREFIX = 'data:image/jpeg;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PREFIX)) return { ok: false, status: 400, error: '縮圖的格式不對（要 JPEG）' };
  const b64 = dataUrl.slice(PREFIX.length);
  // base64 解開大約是 3/4；先擋明顯太大的，不用真的解開
  if (b64.length > Math.ceil(MAX_THUMB_BYTES / 3) * 4 + 4) return { ok: false, status: 413, error: '縮圖太大了' };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { ok: false, status: 400, error: '縮圖的格式不對（要 JPEG）' };
  let bytes;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return { ok: false, status: 400, error: '縮圖的格式不對（要 JPEG）' };
  }
  if (bytes.length > MAX_THUMB_BYTES) return { ok: false, status: 413, error: '縮圖太大了' };
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return { ok: false, status: 400, error: '縮圖的格式不對（要 JPEG）' };
  }
  return { ok: true, bytes };
}

/** R2 的縮圖位置：comment-thumbs/<專案>/<留言>-<32 個隨機 hex>.jpg（網址猜不到） */
export function commentThumbKey(projectId, commentId, rand32hex) {
  return `comment-thumbs/${projectId}/${commentId}-${rand32hex}.jpg`;
}

/** 縮圖網址（相對路徑，前面接 API 網址）；不是我們存的位置 → null */
export function thumbUrlFor(key) {
  if (typeof key !== 'string' || !THUMB_KEY_RE.test(key)) return null;
  return THUMB_URL_PREFIX + key.slice('comment-thumbs/'.length);
}

/** /api/comment-thumbs/<專案>/<檔名>.jpg → R2 key；格式不對 → null */
export function thumbKeyFromPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(THUMB_URL_PREFIX)) return null;
  const key = 'comment-thumbs/' + pathname.slice(THUMB_URL_PREFIX.length);
  return THUMB_KEY_RE.test(key) ? key : null;
}

// 訪客（分享連結）留言的顯示：「訪客：小李（給經紀人的連結）」
export function guestAuthorLabel(guestName, linkLabel) {
  const name = String(guestName || '').trim() || '訪客';
  return `訪客：${name}${linkLabel ? `（${linkLabel}）` : ''}`;
}

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
    // 0026：區段、視角、cue、畫記（沒有 = NULL）
    time_end: isNum(c.timeEnd) ? c.timeEnd : null,
    view_json: c.view ? JSON.stringify(c.view) : null,
    cue_id: c.cueId ?? null,
    annotation_json: c.annotation ? JSON.stringify(c.annotation) : null,
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
  // 審片 v2（migration 0024）：沒有的欄位不放，舊留言的格式跟以前一模一樣
  if (r.video_id) out.videoId = r.video_id;                         // 留言時看的那一版
  if (r.video_version != null) out.videoVersion = r.video_version;  // 那一版的號碼（V2 → 2）
  if (r.reply_to_comment_id) out.parentId = r.reply_to_comment_id;  // 回覆哪一則（只有一層）
  if (r.resolved_video_id) out.resolvedVideoId = r.resolved_video_id;          // 「已改好（V3）」是哪一版
  if (r.resolved_version != null) out.resolvedVersion = r.resolved_version;
  if (r.resolved_by_user_id) out.resolvedByUserId = r.resolved_by_user_id;
  if (r.kind) out.kind = r.kind;                                    // 'needs_changes' = 按需修改時寫的原因
  // 0026（沒有的欄位不放）
  if (isNum(r.time_end)) out.timeEnd = r.time_end;                  // 區段留言的結束
  const view = sanitizeView(parse(r.view_json));
  if (view) out.view = view;                                        // 留言當下的 3D 視角
  if (r.cue_id) out.cueId = r.cue_id;
  const ann = parse(r.annotation_json);
  if (ann && Array.isArray(ann.shapes) && ann.shapes.length) out.annotation = ann;  // 畫記
  const thumbUrl = thumbUrlFor(r.thumb_key);
  if (thumbUrl) out.thumbUrl = thumbUrl;
  if (r.guest_name) {
    // 分享連結的訪客留的：團隊看到「訪客：小李（給經紀人的連結）」（舊版畫面直接顯示 author 也看得懂）
    out.author = guestAuthorLabel(r.guest_name, r.share_label);
    out.role = 'guest';
    out.guest = { name: r.guest_name, linkName: r.share_label || '' };
  }
  return out;
}

/**
 * 給分享連結的訪客看的留言（不給 email、帳號 id、@ 誰、誰標的已改好）。
 *   訪客留的：author = 名字、role 'guest'；團隊的回覆：author = 名字、role = 身分
 */
export function rowToGuestComment(r) {
  const c = rowToComment(r);
  const out = {
    id: c.id,
    time: c.time,
    text: c.text,
    author: r.guest_name ? String(r.guest_name) : c.author,
    role: r.guest_name ? 'guest' : c.role,
    status: c.status,
    createdAt: c.createdAt,
  };
  for (const k of ['timeEnd', 'view', 'cueId', 'annotation', 'thumbUrl', 'parentId', 'videoVersion', 'resolvedVersion']) {
    if (c[k] !== undefined) out[k] = c[k];
  }
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
