// 專案成員（「成員」面板用）：誰在這個專案、幫人加進專案 / 改角色 / 移出專案。
// 上半是純判斷（members.test.mjs 測），下半是資料庫讀寫（worker.js 的 dispatchProjectRoute 呼叫，回 { status, body }）。
//
// 路由（access.mjs describeProjectRoute，權限 'memberManager' = 全站製作，或這個專案的製作）：
//   GET    /api/projects/:id/members                  這個專案的成員（含角色、上次登入）
//   PUT    /api/projects/:id/members/:userId  { role } 加進專案 / 改角色（同一個動作：已經是成員 = 改角色）
//   DELETE /api/projects/:id/members/:userId          移出專案
//   GET    /api/projects/:id/member-candidates?q=     用名字找現有的用戶（加進專案、邀請已經有帳號的人用）
//
// 角色一律是「這個專案裡的角色」（project_members.role）：
//   admin = 這個專案的製作（可以編輯這個專案、管這個專案的成員；看不到別的專案、管不了全站用戶）。
//   這支檔案永遠只寫 project_members，不碰 users.role —— 不會有人因此變成「全站製作」。
//
// 規則（全站製作和專案製作都一樣，只是專案製作只管得到自己的專案，路由表就擋掉了別的專案）：
//   - 全站製作的帳號本來就看得到所有專案，不用加進專案，也不能從這裡改 / 移出
//   - 不能改自己在專案裡的角色、不能把自己移出專案（專案製作自己把自己降級會被鎖在外面；全站製作自己想改請到用戶頁）
//   - 停用的帳號不能新加進專案
//   - 找人（member-candidates）一定要輸入名字：專案製作不能用空白一次列出全站所有人

import { ROLES } from './access.mjs';

export const MEMBER_ROLES = ROLES;  // admin / animator / director（在這個專案裡的角色）
export const MEMBER_ROLE_LABEL = { admin: '製作', director: '導演', animator: '動畫師' };
export const CANDIDATE_LIMIT = 20;
export const CANDIDATE_QUERY_MAX = 40;

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const roleLabel = (r) => MEMBER_ROLE_LABEL[r] || r;

/** body 裡的角色（admin / director / animator 才算數） */
export function parseMemberRole(role) {
  if (typeof role === 'string' && MEMBER_ROLES.includes(role)) return { ok: true, role };
  return { ok: false, status: 400, error: '請選角色：製作、導演或動畫師' };
}

/**
 * 能不能把 target 加進專案 / 改成 nextRole / 移出專案（nextRole = null）
 *
 * @param {object} p
 * @param {{id: string, role: string}} p.actor        動手的人（role = 帳號的預設角色）
 * @param {string|null} p.actorProjectRole            動手的人在這個專案的角色（projectRoleOf 的結果）
 * @param {{id: string, name?: string, role: string, deactivated?: number|boolean}|null} p.target  被動的人（找不到 = null）
 * @param {string|null} p.currentRole                 target 現在在這個專案的角色（不是成員 = null）
 * @param {string|null} p.nextRole                    想改成的角色；null = 移出專案
 * @returns {{ok: true, kind: 'add'|'change'|'remove'|'noop', from: string|null, to: string|null}
 *         | {ok: false, status: number, error: string}}
 */
export function memberChangeDecision({ actor, actorProjectRole, target, currentRole, nextRole }) {
  if (actorProjectRole !== 'admin') {
    return { ok: false, status: 403, error: '只有這個專案的製作可以管理成員' };
  }
  const removing = nextRole === null || nextRole === undefined;
  if (!removing && !MEMBER_ROLES.includes(nextRole)) {
    return { ok: false, status: 400, error: '請選角色：製作、導演或動畫師' };
  }
  if (!target) {
    return { ok: false, status: 404, error: removing ? '這個人不在這個專案裡' : '找不到這個用戶' };
  }
  const who = target.name ? `「${target.name}」` : '這個人';
  if (target.role === 'admin') {
    return { ok: false, status: 400, error: `${who}是全站製作，本來就看得到所有專案，不用加進專案，也不能從這裡改` };
  }
  if (actor?.id && actor.id === target.id) {
    return {
      ok: false, status: 400,
      error: removing ? '不能把自己移出專案，請別的製作幫你' : '不能改自己在專案裡的角色，請別的製作幫你',
    };
  }
  if (removing) {
    if (!currentRole) return { ok: false, status: 404, error: `${who}不在這個專案裡` };
    return { ok: true, kind: 'remove', from: currentRole, to: null };
  }
  if (!currentRole) {
    if (target.deactivated) {
      return { ok: false, status: 400, error: `${who}的帳號已經停用，請先請全站的製作重新啟用` };
    }
    return { ok: true, kind: 'add', from: null, to: nextRole };
  }
  if (currentRole === nextRole) return { ok: true, kind: 'noop', from: currentRole, to: nextRole };
  return { ok: true, kind: 'change', from: currentRole, to: nextRole };
}

/** 找人的名字：去頭尾空白、連續空白變一個、最多 40 個字；沒有字 = '' */
export function parseCandidateQuery(q) {
  if (typeof q !== 'string') return '';
  return q.trim().replace(/\s+/g, ' ').slice(0, CANDIDATE_QUERY_MAX);
}

/** LIKE 的樣式（名字裡的 % _ \ 不當萬用字元用）；配 `LIKE ? ESCAPE '\'` */
export function likePattern(q) {
  return '%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

const iso = (v) => (v === null || v === undefined || v === '' ? null : v);

/** project_members + users 的一列 → 「成員」面板的一列（不含登入碼這些） */
export function memberToApi(row, meId) {
  return {
    id: row.user_id,
    name: row.name,
    avatarColor: row.avatar_color,
    role: row.role,
    /** 全站製作：本來就看得到所有專案，面板上鎖住不能改 */
    globalAdmin: row.user_role === 'admin',
    deactivated: !!row.deactivated,
    lastSeenAt: iso(row.last_seen_at),
    isMe: !!meId && row.user_id === meId,
  };
}

/** 找人的結果一列（只有名字、頭像、帳號預設角色、在這個專案的角色） */
export function candidateToApi(row) {
  return {
    id: row.id,
    name: row.name,
    avatarColor: row.avatar_color,
    role: row.role,
    projectRole: MEMBER_ROLES.includes(row.project_role) ? row.project_role : null,
  };
}

/** 一句話：這次改了什麼（活動紀錄的內容） */
export function memberChangeSummary(decision, name) {
  if (decision.kind === 'add') return `把「${name}」加進專案（${roleLabel(decision.to)}）`;
  if (decision.kind === 'change') return `把「${name}」從${roleLabel(decision.from)}改成${roleLabel(decision.to)}`;
  if (decision.kind === 'remove') return `把「${name}」移出專案`;
  return '';
}

// ─────────────────────────────────────────────
// 資料庫（handler 回 { status, body }，worker.js 用 mechResp 包成 Response）
// ─────────────────────────────────────────────

const MEMBER_SELECT = `
  SELECT pm.user_id, pm.role, u.name, u.role AS user_role, u.avatar_color, u.last_seen_at, u.deactivated
    FROM project_members pm
    JOIN users u ON u.id = pm.user_id`;

/** GET members */
export async function listMembers(env, ctx) {
  const r = await env.DB.prepare(`${MEMBER_SELECT} WHERE pm.project_id = ? ORDER BY u.name`).bind(ctx.projectId).all();
  return { status: 200, body: { members: (r.results || []).map(row => memberToApi(row, ctx.me.id)) } };
}

/** GET member-candidates?q= */
export async function listCandidates(env, ctx, url) {
  const q = parseCandidateQuery(url.searchParams.get('q'));
  if (!q) return { status: 200, body: { users: [], needQuery: true } };
  // 停用的、全站製作（本來就看得到全部）不列
  const r = await env.DB.prepare(
    `SELECT u.id, u.name, u.role, u.avatar_color, pm.role AS project_role
       FROM users u
       LEFT JOIN project_members pm ON pm.user_id = u.id AND pm.project_id = ?
      WHERE u.deactivated = 0 AND u.role != 'admin' AND u.name LIKE ? ESCAPE '\\'
      ORDER BY u.name LIMIT ?`
  ).bind(ctx.projectId, likePattern(q), CANDIDATE_LIMIT).all();
  return { status: 200, body: { users: (r.results || []).map(candidateToApi), needQuery: false } };
}

async function loadTarget(env, projectId, userId) {
  const [u, pm] = await env.DB.batch([
    env.DB.prepare(`SELECT id, name, role, deactivated FROM users WHERE id = ? LIMIT 1`).bind(userId),
    env.DB.prepare(`SELECT role FROM project_members WHERE project_id = ? AND user_id = ? LIMIT 1`).bind(projectId, userId),
  ]);
  return { target: (u.results || [])[0] || null, currentRole: (pm.results || [])[0]?.role || null };
}

/**
 * PUT members/:userId  body { role }：加進專案 / 改角色
 * @param {(action: string, targetType: string, targetId: string, payload: object) => unknown} [log] 寫活動紀錄
 */
export async function putMember(request, env, ctx, userId, log) {
  if (!ID_RE.test(String(userId))) return { status: 400, body: { error: 'Invalid id' } };
  let body;
  try { body = await request.json(); } catch { return { status: 400, body: { error: 'Invalid JSON' } }; }
  const want = parseMemberRole(body?.role);
  if (!want.ok) return { status: want.status, body: { error: want.error } };

  const { target, currentRole } = await loadTarget(env, ctx.projectId, userId);
  const d = memberChangeDecision({
    actor: ctx.me, actorProjectRole: ctx.role, target, currentRole, nextRole: want.role,
  });
  if (!d.ok) return { status: d.status, body: { error: d.error } };
  if (d.kind !== 'noop') {
    await env.DB.prepare(
      `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`
    ).bind(ctx.projectId, userId, d.to).run();
    await log?.(d.kind === 'add' ? 'create' : 'update', 'member', userId, {
      name: target.name, from: d.from, to: d.to, summary: memberChangeSummary(d, target.name),
    });
  }
  return { status: 200, body: { ok: true, kind: d.kind, role: d.to } };
}

/** DELETE members/:userId：移出專案 */
export async function deleteMember(env, ctx, userId, log) {
  if (!ID_RE.test(String(userId))) return { status: 400, body: { error: 'Invalid id' } };
  const { target, currentRole } = await loadTarget(env, ctx.projectId, userId);
  const d = memberChangeDecision({
    actor: ctx.me, actorProjectRole: ctx.role, target, currentRole, nextRole: null,
  });
  if (!d.ok) return { status: d.status, body: { error: d.error } };
  await env.DB.prepare(`DELETE FROM project_members WHERE project_id = ? AND user_id = ?`).bind(ctx.projectId, userId).run();
  await log?.('delete', 'member', userId, { name: target.name, from: d.from, summary: memberChangeSummary(d, target.name) });
  return { status: 200, body: { ok: true, kind: 'remove' } };
}
