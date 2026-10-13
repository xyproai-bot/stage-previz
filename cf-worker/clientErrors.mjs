// 前端錯誤回報（表在 migrations/0025；前端在 web/src/lib/errorReporting.ts）
//
//   POST /api/client-errors       不用登入；有登入就記 user id（從登入狀態拿，不信任 body）
//                                  每個 IP 一天最多 PER_IP_PER_DAY 則、全站一天最多 PER_DAY 則、body 最多 16 KB
//   GET  /api/admin/client-errors 製作看最近的錯誤，同一個訊息算一組（ops.mjs）
//
// 只存：訊息、stack（截短）、網址的路徑（不含 ? 後面、分享連結碼 / 邀請碼 / 通行證遮掉）、
//       瀏覽器（User-Agent）、前端版本、user id。不存 IP（只拿 IP 的雜湊算今天送了幾則，隔天就清掉）。
// 超過 30 天的排程自動清掉。

export const CLIENT_ERROR_LIMITS = Object.freeze({
  maxBodyBytes: 16 * 1024,
  perIpPerDay: 50,
  perDay: 2000,
  keepDays: 30,
  messageMax: 500,
  stackMax: 4000,
  stackLines: 25,
  pathMax: 300,
  userAgentMax: 300,
  versionMax: 40,
});

const DAY_MS = 86400_000;

// 路徑上「後面那一段是鑰匙」的地方（前端路由 + 後台 API）
const SECRET_AFTER = new Set(['share', 's', 'invite', 'api/share', 'api/s', 'redeem', 'peek']);
// 看起來像隨機碼的一段（長、混了數字和字母）
const TOKENISH_RE = /^[A-Za-z0-9_-]{20,}$/;

function redactSegments(path) {
  const segs = path.split('/');
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const prev = segs[i - 1];
    const prev2 = i >= 2 ? `${segs[i - 2]}/${prev}` : null;
    if (i > 0 && s && (SECRET_AFTER.has(prev) || (prev2 && SECRET_AFTER.has(prev2)))) { out.push(':token'); continue; }
    if (TOKENISH_RE.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s)) { out.push(':token'); continue; }
    out.push(s);
  }
  return out.join('/');
}

/**
 * 網址 → 只留路徑（拿掉 ? 和 # 後面），分享連結碼 / 邀請碼 / 長的隨機碼遮成 :token
 * 'https://previz.haimiaan.com/share/abc123?pw=1#x' → '/share/:token'
 */
export function stripUrlPath(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  let s = raw.trim();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '');  // 去掉 https://網域
  s = s.split(/[?#]/)[0] || '/';
  if (!s.startsWith('/')) s = '/' + s;
  try { s = decodeURIComponent(s); } catch { /* 留原本的 */ }
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');
  return redactSegments(s).slice(0, CLIENT_ERROR_LIMITS.pathMax);
}

/**
 * 錯誤訊息 / stack 裡的網址和鑰匙遮掉：
 *   網址的 ? # 後面拿掉、路徑上的分享連結碼遮掉；Bearer xxx、pass=xxx、token=xxx、password=xxx、email 遮掉
 */
export function scrubText(text) {
  if (typeof text !== 'string') return '';
  let s = text.replace(/\u0000/g, '');
  // 網址（http(s):// 開頭）：只留網域 + 路徑（路徑上的鑰匙遮掉）
  // stack 裡的「網址?v=1:12:34」→ 留下後面的行號 :12:34
  s = s.replace(/\b(https?:\/\/[^\s/?#'"`<>()]+)([^\s?#'"`<>()]*)([?#][^\s'"`<>()]*)?/gi,
    (_m, origin, path, query) => origin + (path ? redactSegments(path) : '') + ((query && /(?::\d+){1,2}$/.exec(query)?.[0]) || ''));
  s = s.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [已隱藏]');
  s = s.replace(/\b(pass|token|password|pw|access_?code|code|key|sig)=([^\s&'"`]+)/gi, '$1=[已隱藏]');
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  return s;
}

/** stack 截短：最多 25 行、4000 字 */
export function trimStack(stack) {
  if (typeof stack !== 'string' || !stack.trim()) return null;
  const lines = scrubText(stack).split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean).slice(0, CLIENT_ERROR_LIMITS.stackLines);
  return lines.join('\n').slice(0, CLIENT_ERROR_LIMITS.stackMax) || null;
}

/**
 * 前端送來的 body → 要存的欄位；不合格 → { ok: false }
 * @param {unknown} body  { message, stack?, url?, path?, appVersion? }
 * @param {{userAgent?: string|null}} [meta]  User-Agent 從 header 拿
 */
export function sanitizeClientError(body, { userAgent = null } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: '格式不對' };
  const rawMsg = typeof body.message === 'string' ? body.message : '';
  const message = scrubText(rawMsg).replace(/\s+/g, ' ').trim().slice(0, CLIENT_ERROR_LIMITS.messageMax);
  if (!message) return { ok: false, error: '沒有錯誤訊息' };
  const rawUrl = typeof body.path === 'string' ? body.path : (typeof body.url === 'string' ? body.url : '');
  const appVersion = typeof body.appVersion === 'string'
    ? body.appVersion.replace(/[^\w.+-]/g, '').slice(0, CLIENT_ERROR_LIMITS.versionMax) || null
    : null;
  return {
    ok: true,
    value: {
      message,
      stack: trimStack(body.stack),
      path: stripUrlPath(rawUrl) || null,
      userAgent: typeof userAgent === 'string' && userAgent ? userAgent.replace(/[\u0000-\u001f]/g, '').slice(0, CLIENT_ERROR_LIMITS.userAgentMax) : null,
      appVersion,
    },
  };
}

async function sha256Hex(s) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 同一組錯誤：訊息裡的數字換成 #（「HTTP 502」「第 3 首」算同一組），再算雜湊 */
export async function errorFingerprint(message) {
  const norm = String(message || '').toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  return (await sha256Hex(norm)).slice(0, 16);
}

/** UTC 日期 'YYYY-MM-DD'（每天的上限用） */
export function utcDay(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** 每個 IP 每天一個計數（只存雜湊；加了每天不同的鹽，隔天就對不起來） */
export async function ipDayBucket(ip, day, secret) {
  return 'ip:' + (await sha256Hex(`client-errors|${secret || ''}|${day}|${ip || 'unknown'}`)).slice(0, 24);
}

/** 計數有沒有超過（計數已經包含這一則） */
export function rateLimitDecision({ ipCount, dayCount }, limits = CLIENT_ERROR_LIMITS) {
  if (ipCount > limits.perIpPerDay) return { allowed: false, reason: 'ip' };
  if (dayCount > limits.perDay) return { allowed: false, reason: 'day' };
  return { allowed: true };
}

/** 讀 body，超過上限就停（不信任 Content-Length） */
export async function readBodyCapped(request, maxBytes) {
  const cl = Number(request.headers.get('content-length'));
  if (Number.isFinite(cl) && cl > maxBytes) return { ok: false, tooLarge: true };
  if (!request.body) return { ok: true, text: '' };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return { ok: false, tooLarge: true };
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return { ok: true, text: new TextDecoder().decode(buf) };
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...extra } });
}

/**
 * POST /api/client-errors
 * @param {Request} request
 * @param {{DB: any, AUTH_SECRET?: string}} env
 * @param {{userId?: string|null, now?: number, limits?: typeof CLIENT_ERROR_LIMITS}} [opts]
 */
export async function handleClientErrorPost(request, env, { userId = null, now = Date.now(), limits = CLIENT_ERROR_LIMITS } = {}) {
  if (!env.DB) return json({ error: 'D1 not configured' }, 500);
  const read = await readBodyCapped(request, limits.maxBodyBytes);
  if (!read.ok) return json({ error: '內容太大' }, 413);
  let body;
  try { body = JSON.parse(read.text || 'null'); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const clean = sanitizeClientError(body, { userAgent: request.headers.get('user-agent') });
  if (!clean.ok) return json({ error: clean.error }, 400);

  const day = utcDay(now);
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const ipKey = await ipDayBucket(ip, day, env.AUTH_SECRET);
  const dayKey = `day:${day}`;
  const bump = (k) => env.DB.prepare(
    `INSERT INTO client_error_counts (bucket, day, n) VALUES (?, ?, 1)
       ON CONFLICT (bucket) DO UPDATE SET n = n + 1
     RETURNING n`
  ).bind(k, day);
  // 先算這個 IP；這個 IP 已經超過就不算進全站的（一個人狂送不會把大家今天的額度用光）
  const ipCount = Number((await bump(ipKey).all())?.results?.[0]?.n || 0);
  let decision = rateLimitDecision({ ipCount, dayCount: 0 }, limits);
  if (decision.allowed) {
    const dayCount = Number((await bump(dayKey).all())?.results?.[0]?.n || 0);
    decision = rateLimitDecision({ ipCount, dayCount }, limits);
  }
  if (!decision.allowed) {
    const tomorrow = Date.parse(day + 'T00:00:00Z') + DAY_MS;
    const retryAfterSec = Math.max(60, Math.ceil((tomorrow - now) / 1000));
    return json({ error: '今天回報太多次了，明天再試', reason: decision.reason }, 429, { 'Retry-After': String(retryAfterSec) });
  }

  const v = clean.value;
  const fp = await errorFingerprint(v.message);
  await env.DB.prepare(
    `INSERT INTO client_errors (fingerprint, message, stack, path, user_agent, app_version, user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(fp, v.message, v.stack, v.path, v.userAgent, v.appVersion, userId || null, now).run();
  return new Response(null, { status: 204 });
}

/**
 * 最近的錯誤，同一組算一列（最新的在前）
 * @returns {Promise<Array<{fingerprint, message, count, users, firstAt, lastAt, sample}>>}
 */
export async function listClientErrorGroups(db, { now = Date.now(), days = 7, limit = 50 } = {}) {
  const since = now - Math.max(1, Math.min(30, Number(days) || 7)) * DAY_MS;
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const [groups, samples] = await db.batch([
    db.prepare(
      `SELECT fingerprint, COUNT(*) AS n, COUNT(DISTINCT user_id) AS users, MIN(created_at) AS first_at, MAX(created_at) AS last_at, MAX(id) AS last_id
         FROM client_errors WHERE created_at >= ?
        GROUP BY fingerprint ORDER BY last_at DESC LIMIT ?`
    ).bind(since, lim),
    db.prepare(
      `SELECT e.id, e.fingerprint, e.message, e.stack, e.path, e.user_agent, e.app_version, e.user_id, e.created_at, u.name AS user_name
         FROM client_errors e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.id IN (SELECT MAX(id) FROM client_errors WHERE created_at >= ? GROUP BY fingerprint)`
    ).bind(since),
  ]);
  const byId = new Map((samples.results || []).map(r => [r.id, r]));
  return (groups.results || []).map(g => {
    const s = byId.get(g.last_id) || {};
    return {
      fingerprint: g.fingerprint,
      message: s.message || '',
      count: Number(g.n),
      users: Number(g.users),
      firstAt: new Date(Number(g.first_at)).toISOString(),
      lastAt: new Date(Number(g.last_at)).toISOString(),
      sample: {
        stack: s.stack || null,
        path: s.path || null,
        userAgent: s.user_agent || null,
        appVersion: s.app_version || null,
        userId: s.user_id || null,
        userName: s.user_name || null,
      },
    };
  });
}

/** 清掉 30 天以前的錯誤、昨天以前的計數 */
export async function pruneClientErrors(db, now = Date.now(), limits = CLIENT_ERROR_LIMITS) {
  const cutoff = now - limits.keepDays * DAY_MS;
  const yesterday = utcDay(now - DAY_MS);
  const [a, b] = await db.batch([
    db.prepare(`DELETE FROM client_errors WHERE created_at < ?`).bind(cutoff),
    db.prepare(`DELETE FROM client_error_counts WHERE day < ?`).bind(yesterday),
  ]);
  return { errors: a?.meta?.changes || 0, counters: b?.meta?.changes || 0 };
}
