// 邀請連結（純計算，不碰資料庫；資料庫讀寫在 worker.js 的 handleInvitesRouter / handleProjectInvites）。
//
// 製作在用戶頁或專案頁幫某個人（已經有帳號的人，或新的名字）建一條邀請連結：
//   https://<網站>/invite/<邀請碼>
// 對方打開 → 按「進入」→ 登入（新的人這時才建帳號）、加進專案（用邀請時選的角色）→ 直接進專案
//   動畫師 → /studio/<專案>，導演 → /preview/<專案>
//
// 邀請碼：32 bytes 隨機（256 bits），資料庫只存 SHA-256（invites.token_hash），邀請碼本身只在建立時回傳一次。
//   邀請碼夠長、猜不到 → 用快速的 SHA-256 就好（PBKDF2 是給人想的短密碼用的），也能直接用雜湊查。
// 預設 7 天內有效、只能用一次；製作可以撤銷（revoked_at）。
// 角色只開放動畫師 / 導演：製作（admin）能改所有東西，連結外流風險太大 → 製作帳號請在用戶頁建、用登入碼登入。

export const INVITE_ROLES = ['animator', 'director'];
export const INVITE_DEFAULT_DAYS = 7;
export const INVITE_MAX_DAYS = 30;
/** 不勾「只能用一次」時最多可以用幾次（例如手機和電腦都要開） */
export const INVITE_MULTI_USE_MAX = 10;
export const INVITE_TOKEN_BYTES = 32;
export const INVITE_NAME_MAX = 80;

const DAY_MS = 86400_000;
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;  // 32 bytes 的 base64url（沒有 =）

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

/** 新的邀請碼（放在網址上給對方；不存進資料庫） */
export function generateInviteToken(rand = randomBytes) {
  return b64url(rand(INVITE_TOKEN_BYTES));
}

/** 長得像邀請碼嗎（不像就不用查資料庫） */
export function isInviteTokenShape(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

/** 存進資料庫 / 拿來查的雜湊 */
export async function hashInviteToken(token) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', enc.encode(String(token)));
  return b64url(new Uint8Array(d));
}

/** 邀請的 id（撤銷、清單用；不是邀請碼，看到也不能拿來登入） */
export function newInviteId(rand = randomBytes) {
  return 'inv_' + b64url(rand(9));
}

/**
 * 建立邀請時 body 的檢查
 * body: { role, userId?（已經有帳號的人）, name?（新的人）, expiresInDays?（預設 7，1～30）, singleUse?（預設 true） }
 * @returns {{ok: true, value: {role: string, userId: string|null, name: string|null, expiresAt: number, maxUses: number}}
 *         | {ok: false, status: number, error: string}}
 */
export function parseInviteCreate(body, now = Date.now()) {
  const b = body && typeof body === 'object' ? body : {};
  if (!INVITE_ROLES.includes(b.role)) {
    return { ok: false, status: 400, error: '請選擇角色：動畫師或導演（製作帳號請在用戶頁建立）' };
  }
  let userId = null, name = null;
  if (b.userId !== undefined && b.userId !== null && b.userId !== '') {
    if (typeof b.userId !== 'string' || !ID_RE.test(b.userId)) return { ok: false, status: 400, error: '選的用戶不正確' };
    userId = b.userId;
  } else {
    name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) return { ok: false, status: 400, error: '請輸入對方的名字' };
    if (name.length > INVITE_NAME_MAX) return { ok: false, status: 400, error: `名字太長（最多 ${INVITE_NAME_MAX} 個字）` };
  }
  let days = INVITE_DEFAULT_DAYS;
  if (b.expiresInDays !== undefined && b.expiresInDays !== null && b.expiresInDays !== '') {
    days = Number(b.expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > INVITE_MAX_DAYS) {
      return { ok: false, status: 400, error: `有效天數要是 1 到 ${INVITE_MAX_DAYS} 天` };
    }
  }
  const singleUse = b.singleUse === undefined ? true : b.singleUse !== false;
  return {
    ok: true,
    value: { role: b.role, userId, name, expiresAt: now + days * DAY_MS, maxUses: singleUse ? 1 : INVITE_MULTI_USE_MAX },
  };
}

/**
 * 邀請給「已經有帳號的人」時，這個帳號能不能用（建立時、打開時都看一次）
 * @param {{role: string, deactivated: number|boolean}|null} user
 * @param {'create'|'redeem'} phase
 */
export function inviteUserDecision(user, phase = 'create') {
  if (!user) {
    return phase === 'create'
      ? { ok: false, status: 404, error: '找不到這個用戶' }
      : { ok: false, status: 410, reason: 'not_found', error: INVITE_MESSAGES.not_found };
  }
  if (user.deactivated) {
    return phase === 'create'
      ? { ok: false, status: 400, error: '這個帳號已經停用，請先在用戶頁重新啟用' }
      : { ok: false, status: 403, reason: 'deactivated', error: INVITE_MESSAGES.deactivated };
  }
  if (user.role === 'admin') {
    return phase === 'create'
      ? { ok: false, status: 400, error: '製作帳號不能用邀請連結登入，請用登入碼' }
      : { ok: false, status: 403, reason: 'admin_account', error: INVITE_MESSAGES.admin_account };
  }
  return { ok: true };
}

/** 打開邀請時給對方看的話（白話，最後都叫他跟製作要新的） */
export const INVITE_MESSAGES = {
  not_found: '找不到這個邀請連結，可能網址沒有複製完整。請跟製作要一個新的連結。',
  revoked: '這個邀請連結已經被製作取消了。請跟製作要一個新的連結。',
  expired: '這個邀請連結已經過期了。請跟製作要一個新的連結。',
  used: '這個邀請連結已經用過了（只能用一次）。請跟製作要一個新的連結；如果是你自己剛剛用過，直接用剛剛那台電腦或手機打開網站就可以。',
  used_up: '這個邀請連結的使用次數已經用完了。請跟製作要一個新的連結。',
  archived: '這個專案已經封存，暫時不能進去。有問題請聯絡製作。',
  deactivated: '這個帳號已經停用了，請聯絡製作。',
  admin_account: '這個連結不能用來登入製作帳號，請用登入碼登入。',
};

/**
 * 這條邀請現在能不能用
 * @param {{revoked_at?: number|null, expires_at: number, use_count: number, max_uses: number, project_status?: string}|null} row
 * @returns {'ok'|'not_found'|'revoked'|'archived'|'used'|'used_up'|'expired'}
 */
export function inviteState(row, now = Date.now()) {
  if (!row) return 'not_found';
  if (row.revoked_at) return 'revoked';
  if (row.project_status === 'archived') return 'archived';
  if (Number(row.use_count) >= Number(row.max_uses)) return Number(row.max_uses) > 1 ? 'used_up' : 'used';
  if (!(Number(row.expires_at) > now)) return 'expired';
  return 'ok';
}

/** 不能用的邀請 → { status, reason, error } */
export function inviteProblem(state) {
  const status = state === 'not_found' ? 404 : 410;
  return { status, reason: state, error: INVITE_MESSAGES[state] || INVITE_MESSAGES.not_found };
}

/** 用了邀請之後要去的頁面 */
export function inviteLandingPath(role, projectId) {
  const base = role === 'director' ? '/preview' : '/studio';
  return `${base}/${encodeURIComponent(projectId)}`;
}

const iso = (ms) => (ms === null || ms === undefined || ms === '' ? null : new Date(Number(ms)).toISOString());

/** 資料庫一列 → 管理頁清單（永遠不含邀請碼；資料庫也沒有） */
export function inviteToApi(row) {
  const maxUses = Number(row.max_uses) || 1;
  const useCount = Number(row.use_count) || 0;
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    role: row.role,
    userId: row.user_id || null,
    personName: row.user_name || row.new_user_name || '',
    isNewPerson: !row.user_id,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    maxUses,
    useCount,
    usesLeft: Math.max(0, maxUses - useCount),
    createdByName: row.created_by_name ?? null,
    lastUsedAt: iso(row.last_used_at),
  };
}
