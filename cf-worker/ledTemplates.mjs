// LED 畫布版型的後台：版型和手動切的螢幕的新增 / 修改 / 刪除、每首歌選版型、影片版本記住當時的版型、複製專案 / 匯出匯入。
// 設計：docs/superpowers/specs/2026-10-15-led-canvas-templates-design.md；API：docs/led-templates-api.md
//
// 檢查規則、plan 格式跟前端共用 web/src/lib/ledTemplate.ts（純函式，wrangler 打包時會一起編進來）。
// worker.js 只負責：路由（access.mjs）→ 檢查網址上的 id → 呼叫這裡。這裡的函式都只用 env.DB（D1），
// ledTemplates.test.mjs 用 node:sqlite 做一個一樣的 DB 測。
//
// 回應：handler 回傳 { status, body }（worker.js 包成 JSON 回應）。

import {
  normalizeTemplateInput, normalizeManualScreenInput, parsePlan, parseScreenKey, placementsFromInputs,
  FULL_TEMPLATE_NAME, MAX_SCREENS_PER_OBJECT, TEMPLATE_VERSION,
} from '../web/src/lib/ledTemplate.ts';
import { normalizeLedCanvas } from '../web/src/lib/ledCanvas.ts';
import { parseCabinet } from '../web/src/lib/ledCabinet.ts';
import {
  buildTimeline, canvasMismatch, checkTimeline, normalizeTimelineInput, parseTimeline, serializeTimeline, MAX_SWITCHES,
} from '../web/src/lib/ledTemplateTimeline.ts';

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
/** 一個專案最多幾個版型（不含「全部」） */
export const MAX_TEMPLATES = 50;
/** 一個專案最多幾塊手動切的螢幕 */
export const MAX_MANUAL_SCREENS = 200;

const newId = (prefix) => prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const ok = (body, status = 200) => ({ status, body });
const bad = (error, status = 400, extra = {}) => ({ status, body: { error, ...extra } });
const nowIso = () => new Date().toISOString();
const isUniqueError = (e) => /UNIQUE constraint failed/i.test(String(e?.message || e));

async function readJson(request) {
  try { const b = await request.json(); return b && typeof b === 'object' && !Array.isArray(b) ? b : null; } catch { return null; }
}

// ─────────────────────────────────────────────
// 讀
// ─────────────────────────────────────────────

/** 專案的 LED 畫布（還沒填 = null） */
export async function projectFullCanvas(env, projectId) {
  const row = await env.DB.prepare(`SELECT led_canvas FROM projects WHERE id = ? LIMIT 1`).bind(projectId).first();
  return row?.led_canvas ? normalizeLedCanvas(row.led_canvas) : null;
}

/** 這個專案的「全部」版型 id；沒有就補一個（舊版後台建的專案、migration 之後才建的專案） */
export async function ensureFullTemplate(env, projectId) {
  const id = 'lt_full_' + projectId;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO led_templates (id, project_id, name, kind, scale_pct, sort_order) VALUES (?, ?, ?, 'full', 100, 0)`
  ).bind(id, projectId, FULL_TEMPLATE_NAME).run();
  const row = await env.DB.prepare(`SELECT id FROM led_templates WHERE project_id = ? AND kind = 'full' LIMIT 1`).bind(projectId).first();
  return row?.id || id;
}

function manualRowToApi(r) {
  return { id: r.id, objectId: r.object_id, name: r.name, uv: [r.u0, r.v0, r.u1, r.v1], sortOrder: r.sort_order };
}

export async function loadManualScreens(env, projectId) {
  const r = await env.DB.prepare(
    `SELECT * FROM led_screens WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC`
  ).bind(projectId).all();
  return (r.results || []).map(manualRowToApi);
}

/** 資料庫的箱體大小兩欄 → { w, h }；任何一欄是空的 = 沒設（null） */
function cabinetOf(w, h) {
  return Number.isInteger(w) && Number.isInteger(h) ? { w, h } : null;
}

/** 版型一列 + 它的放法 → plan（和快照同一個格式）。「全部」沒有放法，畫布跟著專案 */
export function rowToPlan(row, placementRows, manuals, fullCanvas) {
  const isFull = row.kind === 'full';
  const screens = isFull ? [] : placementsFromInputs(
    (placementRows || []).map(p => ({
      key: p.screen_key,
      dest: { x: p.dest_x, y: p.dest_y, w: p.dest_w, h: p.dest_h },
      rotate: p.rotate, flipH: !!p.flip_h, flipV: !!p.flip_v,
      cabinet: cabinetOf(p.cabinet_w, p.cabinet_h),
    })),
    manuals,
  );
  return {
    v: TEMPLATE_VERSION,
    id: row.id,
    name: row.name,
    canvas: isFull ? fullCanvas : { width: row.canvas_w, height: row.canvas_h },
    scalePct: row.scale_pct ?? 100,
    ...(cabinetOf(row.cabinet_w, row.cabinet_h) ? { cabinet: cabinetOf(row.cabinet_w, row.cabinet_h) } : {}),
    screens,
  };
}

function templateToApi(row, placementRows, manuals, fullCanvas, songCount) {
  return {
    ...rowToPlan(row, placementRows, manuals, fullCanvas),
    kind: row.kind,
    sortOrder: row.sort_order,
    songCount: songCount || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadTemplatesWithPlacements(env, projectId) {
  const [t, p, s] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM led_templates WHERE project_id = ? ORDER BY (kind = 'full') DESC, sort_order ASC, created_at ASC, id ASC`).bind(projectId),
    env.DB.prepare(
      `SELECT lts.* FROM led_template_screens lts JOIN led_templates lt ON lt.id = lts.template_id WHERE lt.project_id = ? ORDER BY lts.rowid ASC`
    ).bind(projectId),
    // 幾首歌在用：開頭選了它，或中途換版型換成它（同一首歌算一次）
    env.DB.prepare(
      `SELECT template_id, COUNT(*) AS n FROM (
         SELECT template_id, id AS song_id FROM songs WHERE project_id = ? AND template_id IS NOT NULL
         UNION
         SELECT sw.template_id, sw.song_id FROM song_template_switches sw JOIN songs s ON s.id = sw.song_id WHERE s.project_id = ?
       ) GROUP BY template_id`
    ).bind(projectId, projectId),
  ]);
  const placementsBy = new Map();
  for (const r of (p.results || [])) {
    if (!placementsBy.has(r.template_id)) placementsBy.set(r.template_id, []);
    placementsBy.get(r.template_id).push(r);
  }
  const counts = new Map((s.results || []).map(r => [r.template_id, r.n]));
  return { rows: t.results || [], placementsBy, counts };
}

/** GET /led-templates */
export async function listTemplates(env, ctx) {
  const { projectId } = ctx;
  await ensureFullTemplate(env, projectId);
  const [fullCanvas, manuals, loaded] = await Promise.all([
    projectFullCanvas(env, projectId), loadManualScreens(env, projectId), loadTemplatesWithPlacements(env, projectId),
  ]);
  return ok({
    fullCanvas,
    templates: loaded.rows.map(r => templateToApi(r, loaded.placementsBy.get(r.id), manuals, fullCanvas, loaded.counts.get(r.id))),
    screens: manuals,
  });
}

async function loadOne(env, projectId, templateId) {
  if (!ID_RE.test(templateId || '')) return null;
  const row = await env.DB.prepare(`SELECT * FROM led_templates WHERE id = ? AND project_id = ? LIMIT 1`).bind(templateId, projectId).first();
  if (!row) return null;
  const [p, fullCanvas, manuals, sc] = await Promise.all([
    env.DB.prepare(`SELECT * FROM led_template_screens WHERE template_id = ? ORDER BY rowid ASC`).bind(templateId).all(),
    projectFullCanvas(env, projectId),
    loadManualScreens(env, projectId),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM (SELECT id FROM songs WHERE template_id = ? UNION SELECT song_id FROM song_template_switches WHERE template_id = ?)`
    ).bind(templateId, templateId).first(),
  ]);
  return { row, api: templateToApi(row, p.results || [], manuals, fullCanvas, sc?.n || 0) };
}

// ─────────────────────────────────────────────
// 版型：新增 / 修改 / 刪除
// ─────────────────────────────────────────────

/** 放法裡的螢幕都要真的存在：整個物件一塊 = 這個專案的 LED 物件；手動切的 = 這個專案的 led_screens */
async function checkScreenKeys(env, projectId, inputs) {
  if (!inputs.length) return null;
  const objs = new Set(((await env.DB.prepare(`SELECT id FROM stage_objects WHERE project_id = ? AND category = 'led_panel'`).bind(projectId).all()).results || []).map(r => r.id));
  const manual = new Set(((await env.DB.prepare(`SELECT id FROM led_screens WHERE project_id = ?`).bind(projectId).all()).results || []).map(r => r.id));
  for (const i of inputs) {
    const k = parseScreenKey(i.key);
    if (!k) return `螢幕代號不對：${i.key}`;
    if (k.kind === 'object' ? !objs.has(k.id) : !manual.has(k.id)) return `這個專案裡找不到這塊螢幕（${i.key}）：可能被刪掉了，請重新整理`;
  }
  return null;
}

function placementStatement(env, templateId, p) {
  return env.DB.prepare(
    `INSERT INTO led_template_screens (template_id, screen_key, dest_x, dest_y, dest_w, dest_h, rotate, flip_h, flip_v, cabinet_w, cabinet_h) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(templateId, p.key, p.dest.x, p.dest.y, p.dest.w, p.dest.h, p.rotate, p.flipH ? 1 : 0, p.flipV ? 1 : 0, p.cabinet?.w ?? null, p.cabinet?.h ?? null);
}

const nameTakenMessage = (name) => `已經有一個叫「${name}」的版型了，請換一個名字`;

export async function createTemplate(request, env, ctx, log) {
  const { projectId, me } = ctx;
  const body = await readJson(request);
  const parsed = normalizeTemplateInput(body, { partial: false });
  if (!parsed.ok) return bad(parsed.error);
  const v = parsed.value;
  const fullCanvas = await projectFullCanvas(env, projectId);
  if (!fullCanvas) return bad('請先填專案的 LED 畫布大小（編輯專案 → 3D 工具列的 LED 對位圖），再建立版型', 409, { needsLedCanvas: true });
  await ensureFullTemplate(env, projectId);
  const count = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM led_templates WHERE project_id = ? AND kind = 'custom'`).bind(projectId).first())?.n || 0;
  if (count >= MAX_TEMPLATES) return bad(`一個專案最多 ${MAX_TEMPLATES} 個版型`, 409);
  const problem = await checkScreenKeys(env, projectId, v.screens);
  if (problem) return bad(problem);
  const id = newId('lt_');
  const sort = ((await env.DB.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM led_templates WHERE project_id = ?`).bind(projectId).first())?.m || 0) + 1;
  const t = nowIso();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO led_templates (id, project_id, name, kind, canvas_w, canvas_h, scale_pct, sort_order, created_by, created_at, updated_at, cabinet_w, cabinet_h) VALUES (?, ?, ?, 'custom', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, projectId, v.name, v.canvas.width, v.canvas.height, v.scalePct, sort, me?.id ?? null, t, t, v.cabinet?.w ?? null, v.cabinet?.h ?? null),
      ...v.screens.map(p => placementStatement(env, id, p)),
    ]);
  } catch (e) {
    if (isUniqueError(e)) return bad(nameTakenMessage(v.name), 409, { nameTaken: true });
    throw e;
  }
  await log?.('create', 'led_template', id, { name: v.name, screens: v.screens.length });
  const one = await loadOne(env, projectId, id);
  return ok({ template: one.api }, 201);
}

export async function updateTemplate(request, env, ctx, templateId, log) {
  const { projectId } = ctx;
  const cur = await loadOne(env, projectId, templateId);
  if (!cur) return bad('這個專案裡找不到這個版型', 404);
  if (cur.row.kind === 'full') return bad(`「${FULL_TEMPLATE_NAME}」是整張畫布的預設版型，不能修改`, 409);
  const body = await readJson(request);
  const parsed = normalizeTemplateInput(body, { partial: true });
  if (!parsed.ok) return bad(parsed.error);
  const v = parsed.value;
  if (!('name' in v) && !v.canvas && v.scalePct === undefined && !('cabinet' in v) && !v.screens) return bad('沒有可以修改的欄位');
  if (v.screens) {
    const problem = await checkScreenKeys(env, projectId, v.screens);
    if (problem) return bad(problem);
  }
  if (v.canvas && (v.canvas.width !== cur.row.canvas_w || v.canvas.height !== cur.row.canvas_h)) {
    // 這個版型在某首歌的中途換版型裡：那首歌所有版型的畫布大小要一樣，不能只改它一個
    const conflict = await timelineCanvasConflict(env, projectId, templateId, v.canvas);
    if (conflict) return bad(conflict, 409, { inTimeline: true });
  }
  const sets = [], vals = [];
  if (v.name !== undefined) { sets.push('name = ?'); vals.push(v.name); }
  if (v.canvas) { sets.push('canvas_w = ?', 'canvas_h = ?'); vals.push(v.canvas.width, v.canvas.height); }
  if (v.scalePct !== undefined) { sets.push('scale_pct = ?'); vals.push(v.scalePct); }
  if ('cabinet' in v) { sets.push('cabinet_w = ?', 'cabinet_h = ?'); vals.push(v.cabinet?.w ?? null, v.cabinet?.h ?? null); }
  sets.push('updated_at = ?'); vals.push(nowIso());
  vals.push(templateId, projectId);
  try {
    await env.DB.batch([
      env.DB.prepare(`UPDATE led_templates SET ${sets.join(', ')} WHERE id = ? AND project_id = ?`).bind(...vals),
      ...(v.screens ? [env.DB.prepare(`DELETE FROM led_template_screens WHERE template_id = ?`).bind(templateId), ...v.screens.map(p => placementStatement(env, templateId, p))] : []),
    ]);
  } catch (e) {
    if (isUniqueError(e)) return bad(nameTakenMessage(v.name), 409, { nameTaken: true });
    throw e;
  }
  await log?.('update', 'led_template', templateId, { name: v.name ?? cur.row.name, fields: Object.keys(v) });
  const one = await loadOne(env, projectId, templateId);
  return ok({ template: one.api });
}

export async function deleteTemplate(request, env, ctx, templateId, log) {
  const { projectId } = ctx;
  const cur = await loadOne(env, projectId, templateId);
  if (!cur) return bad('這個專案裡找不到這個版型', 404);
  if (cur.row.kind === 'full') return bad(`「${FULL_TEMPLATE_NAME}」是整張畫布的預設版型，不能刪`, 409);
  const songs = ((await env.DB.prepare(
    `SELECT name FROM songs WHERE template_id = ? OR id IN (SELECT song_id FROM song_template_switches WHERE template_id = ?) ORDER BY "order" LIMIT 5`
  ).bind(templateId, templateId).all()).results || []).map(s => s.name);
  if (cur.api.songCount > 0) {
    return bad(`還有 ${cur.api.songCount} 首歌在用這個版型（${songs.join('、')}${cur.api.songCount > songs.length ? '…' : ''}），請先把它們改成別的版型`, 409, { inUse: true, songCount: cur.api.songCount });
  }
  await env.DB.prepare(`DELETE FROM led_templates WHERE id = ? AND project_id = ?`).bind(templateId, projectId).run();
  await log?.('delete', 'led_template', templateId, { name: cur.row.name });
  return ok({ ok: true });
}

// ─────────────────────────────────────────────
// 手動切的螢幕
// ─────────────────────────────────────────────

async function ledObjectExists(env, projectId, objectId) {
  const r = await env.DB.prepare(`SELECT id FROM stage_objects WHERE id = ? AND project_id = ? AND category = 'led_panel' LIMIT 1`).bind(objectId, projectId).first();
  return !!r;
}

export async function createScreen(request, env, ctx, log) {
  const { projectId } = ctx;
  const body = await readJson(request);
  const fullCanvas = await projectFullCanvas(env, projectId);
  const parsed = normalizeManualScreenInput(body, { partial: false, fullCanvas });
  if (!parsed.ok) return bad(parsed.error);
  const v = parsed.value;
  if (!(await ledObjectExists(env, projectId, v.objectId))) return bad('這個專案裡找不到這個 LED 物件', 404);
  const perObject = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM led_screens WHERE project_id = ? AND object_id = ?`).bind(projectId, v.objectId).first())?.n || 0;
  if (perObject >= MAX_SCREENS_PER_OBJECT) return bad(`一個 LED 物件最多切成 ${MAX_SCREENS_PER_OBJECT} 塊螢幕`, 409);
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM led_screens WHERE project_id = ?`).bind(projectId).first())?.n || 0;
  if (total >= MAX_MANUAL_SCREENS) return bad(`一個專案最多 ${MAX_MANUAL_SCREENS} 塊手動切的螢幕`, 409);
  const id = newId('ls_');
  const sort = ((await env.DB.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM led_screens WHERE project_id = ?`).bind(projectId).first())?.m || 0) + 1;
  const t = nowIso();
  await env.DB.prepare(
    `INSERT INTO led_screens (id, project_id, object_id, name, u0, v0, u1, v1, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, projectId, v.objectId, v.name, v.uv[0], v.uv[1], v.uv[2], v.uv[3], sort, t, t).run();
  await log?.('create', 'led_screen', id, { name: v.name, objectId: v.objectId });
  return ok({ screen: manualRowToApi({ id, object_id: v.objectId, name: v.name, u0: v.uv[0], v0: v.uv[1], u1: v.uv[2], v1: v.uv[3], sort_order: sort }) }, 201);
}

export async function updateScreen(request, env, ctx, screenId, log) {
  const { projectId } = ctx;
  if (!ID_RE.test(screenId || '')) return bad('Invalid id');
  const cur = await env.DB.prepare(`SELECT * FROM led_screens WHERE id = ? AND project_id = ? LIMIT 1`).bind(screenId, projectId).first();
  if (!cur) return bad('這個專案裡找不到這塊螢幕', 404);
  const body = await readJson(request);
  const fullCanvas = await projectFullCanvas(env, projectId);
  const parsed = normalizeManualScreenInput(body, { partial: true, fullCanvas });
  if (!parsed.ok) return bad(parsed.error);
  const v = parsed.value;
  if (v.objectId && v.objectId !== cur.object_id) return bad('螢幕屬於哪個 LED 物件不能改，請刪掉重切');
  if (v.name === undefined && !v.uv) return bad('沒有可以修改的欄位');
  const sets = [], vals = [];
  if (v.name !== undefined) { sets.push('name = ?'); vals.push(v.name); }
  if (v.uv) { sets.push('u0 = ?', 'v0 = ?', 'u1 = ?', 'v1 = ?'); vals.push(...v.uv); }
  sets.push('updated_at = ?'); vals.push(nowIso(), screenId, projectId);
  await env.DB.prepare(`UPDATE led_screens SET ${sets.join(', ')} WHERE id = ? AND project_id = ?`).bind(...vals).run();
  await log?.('update', 'led_screen', screenId, { name: v.name ?? cur.name });
  const row = await env.DB.prepare(`SELECT * FROM led_screens WHERE id = ? LIMIT 1`).bind(screenId).first();
  return ok({ screen: manualRowToApi(row) });
}

export async function deleteScreen(request, env, ctx, screenId, log) {
  const { projectId } = ctx;
  if (!ID_RE.test(screenId || '')) return bad('Invalid id');
  const cur = await env.DB.prepare(`SELECT name FROM led_screens WHERE id = ? AND project_id = ? LIMIT 1`).bind(screenId, projectId).first();
  if (!cur) return bad('這個專案裡找不到這塊螢幕', 404);
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM led_template_screens WHERE screen_key = ? AND template_id IN (SELECT id FROM led_templates WHERE project_id = ?)`
    ).bind('s:' + screenId, projectId),
    env.DB.prepare(`DELETE FROM led_screens WHERE id = ? AND project_id = ?`).bind(screenId, projectId),
  ]);
  await log?.('delete', 'led_screen', screenId, { name: cur.name });
  return ok({ ok: true });
}

// ─────────────────────────────────────────────
// 歌選版型、影片版本記住版型
// ─────────────────────────────────────────────

/**
 * 歌要選的版型：null / '' / 「全部」的 id = 整張畫布（存 NULL）；其他要是這個專案的自訂版型
 * 回傳 { ok: true, id: 自訂版型 id 或 null } 或 { ok: false, error }
 */
export async function resolveTemplateChoice(env, projectId, raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, id: null };
  if (typeof raw !== 'string' || !ID_RE.test(raw)) return { ok: false, error: '版型 id 不合法' };
  const row = await env.DB.prepare(`SELECT id, kind FROM led_templates WHERE id = ? AND project_id = ? LIMIT 1`).bind(raw, projectId).first();
  if (!row) return { ok: false, error: '這個專案裡找不到這個版型（可能剛被刪掉，請重新整理）' };
  return { ok: true, id: row.kind === 'full' ? null : row.id };
}

/** 版型的 plan（影片版本的快照用）；「全部」/ 找不到 = null */
export async function templatePlanForSnapshot(env, projectId, templateId) {
  if (!templateId) return null;
  const cur = await loadOne(env, projectId, templateId);
  if (!cur || cur.row.kind === 'full') return null;
  const { kind, sortOrder, songCount, createdAt, updatedAt, ...plan } = cur.api;
  void kind; void sortOrder; void songCount; void createdAt; void updatedAt;
  return plan;
}

/**
 * 新的一版影片記住做的時候用的版型和當時的排法：requestedId（上傳時前端帶的）優先，沒有指定就用歌現在選的。
 * 整張畫布（沒選 / 選「全部」）什麼都不寫：欄位是 NULL = 整張畫布
 * 這首歌有中途換版型（而且這一版用的就是歌的開頭版型）→ 另外把整條時間線（含 Cue 這一刻的時間）存進 template_timeline；
 * template_snapshot 仍然寫開頭的版型，舊版前端看得到、不認識時間線的地方也不會壞。
 * rows：[{ id, songId }]
 */
export async function stampVideoTemplates(env, projectId, rows, requestedId = undefined) {
  if (!rows.length) return;
  // requestedId：undefined = 沒指定（用歌現在選的）；null / '' = 指定整張畫布；字串 = 指定這個版型（找不到就當沒指定）
  let requested = null;
  let useRequested = requestedId !== undefined;
  if (requestedId) {
    const r = await resolveTemplateChoice(env, projectId, requestedId);
    if (r.ok) requested = r.id; else useRequested = false;
  }
  const songIds = [...new Set(rows.map(r => r.songId))];
  const ph = songIds.map(() => '?').join(',');
  const songTpl = new Map(((await env.DB.prepare(
    `SELECT id, template_id FROM songs WHERE project_id = ? AND id IN (${ph})`
  ).bind(projectId, ...songIds).all()).results || []).map(s => [s.id, s.template_id]));
  const plans = new Map();
  const timelines = new Map();
  const stmts = [];
  for (const r of rows) {
    const tid = useRequested ? requested : (songTpl.get(r.songId) || null);
    if (!tid) continue;
    if (!plans.has(tid)) plans.set(tid, await templatePlanForSnapshot(env, projectId, tid));
    const plan = plans.get(tid);
    if (!plan) continue;
    let timeline = null;
    if (!useRequested || tid === (songTpl.get(r.songId) || null)) {
      if (!timelines.has(r.songId)) timelines.set(r.songId, await timelineSnapshotText(env, projectId, r.songId, plan, plans));
      timeline = timelines.get(r.songId);
    }
    stmts.push(env.DB.prepare(
      `UPDATE song_videos SET template_id = ?, template_snapshot = ?, template_timeline = ? WHERE id = ?`
    ).bind(tid, JSON.stringify(plan), timeline, r.id));
  }
  if (stmts.length) await env.DB.batch(stmts);
}

/** 影片一列的快照欄位 → API 的 template（壞資料 / 沒有 = null） */
export function snapshotToApi(text) {
  if (!text) return null;
  return parsePlan(text);
}

/** 影片一列的 template_timeline → API 的 templateTimeline（沒有 / 壞資料 = null，前端當單一版型） */
export function timelineSnapshotToApi(text) {
  if (!text) return null;
  if (!parseTimeline(text)) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ─────────────────────────────────────────────
// 中途換版型（時間線，第 3 階段）
// ─────────────────────────────────────────────

const switchToApi = (r) => ({
  id: r.id,
  cueId: r.cue_id || null,
  cueName: r.cue_name ?? null,
  cueTimeSec: r.cue_id ? (r.cue_time ?? null) : null,
  atSec: r.at_sec ?? null,
  templateId: r.template_id,
});

/** 專案每首歌換版型的點：Map(songId → [api]) ；Cue 的名字和目前的影片時間一起 join 出來 */
export async function loadSwitchesByProject(env, projectId) {
  const r = await env.DB.prepare(
    `SELECT sw.id, sw.song_id, sw.cue_id, sw.at_sec, sw.template_id, c.name AS cue_name, c.video_time_sec AS cue_time
       FROM song_template_switches sw
       JOIN songs s ON s.id = sw.song_id
       LEFT JOIN cues c ON c.id = sw.cue_id
      WHERE s.project_id = ?
      ORDER BY sw.sort_order ASC, sw.created_at ASC, sw.id ASC`
  ).bind(projectId).all();
  const by = new Map();
  for (const row of (r.results || [])) {
    if (!by.has(row.song_id)) by.set(row.song_id, []);
    by.get(row.song_id).push(switchToApi(row));
  }
  return by;
}

async function loadSongSwitches(env, projectId, songId) {
  return (await loadSwitchesByProject(env, projectId)).get(songId) || [];
}

/** 專案所有版型（含「全部」）→ Map(id → { id, name, kind, canvas })，「全部」的畫布是專案的 LED 畫布 */
async function loadTemplateInfos(env, projectId) {
  const fullCanvas = await projectFullCanvas(env, projectId);
  const rows = (await env.DB.prepare(`SELECT id, name, kind, canvas_w, canvas_h FROM led_templates WHERE project_id = ?`).bind(projectId).all()).results || [];
  return new Map(rows.map(r => [r.id, {
    id: r.id, name: r.name, kind: r.kind,
    canvas: r.kind === 'full' ? fullCanvas : { width: r.canvas_w, height: r.canvas_h },
  }]));
}

/** 這首歌的正式 Cue → Map(id → { name, timeSec })（提案、備案不能當換版型的點） */
async function loadMasterCueTimes(env, songId) {
  const rows = (await env.DB.prepare(`SELECT id, name, video_time_sec FROM cues WHERE song_id = ? AND status = 'master'`).bind(songId).all()).results || [];
  return new Map(rows.map(c => [c.id, { name: c.name, timeSec: c.video_time_sec ?? null }]));
}

/**
 * PUT /songs/:sid/template-timeline（製作）：整份換掉一首歌的版型時間線 { start, switches }。
 * start = 開頭的版型（也就是 songs.template_id；null / 「全部」= 整張畫布，這時不能有換版型的點）。
 * 檢查：版型都存在、都是自己排的、畫布一樣大、Cue 有影片時間、時間大於 0、同一個時間只能換一次。
 */
export async function putSongTimeline(request, env, ctx, songId, log) {
  const { projectId } = ctx;
  const body = await readJson(request);
  const parsed = normalizeTimelineInput(body);
  if (!parsed.ok) return bad(parsed.error);
  const { start, switches } = parsed.value;
  const startR = await resolveTemplateChoice(env, projectId, start);
  if (!startR.ok) return bad(startR.error);
  const templates = await loadTemplateInfos(env, projectId);
  const cues = await loadMasterCueTimes(env, songId);
  const check = checkTimeline({ start: startR.id, switches, templates, cues });
  if (!check.ok) return bad(check.error, 409, { timeline: true });
  const t = nowIso();
  const stmts = [
    env.DB.prepare(`UPDATE songs SET template_id = ? WHERE id = ? AND project_id = ?`).bind(startR.id, songId, projectId),
    env.DB.prepare(`DELETE FROM song_template_switches WHERE song_id = ?`).bind(songId),
  ];
  switches.forEach((sw, i) => {
    const atSec = sw.cueId ? (cues.get(sw.cueId)?.timeSec ?? null) : sw.atSec;
    stmts.push(env.DB.prepare(
      `INSERT INTO song_template_switches (id, song_id, cue_id, at_sec, template_id, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(newId('tsw_') + i, songId, sw.cueId || null, atSec, sw.templateId, i, t));
  });
  await env.DB.batch(stmts);
  await log?.('update', 'song_template_timeline', songId, { start: startR.id, switches: switches.length });
  return ok({ templateId: startR.id, templateSwitches: await loadSongSwitches(env, projectId, songId) });
}

/**
 * 舊的「LED 版型」選單（PATCH songs 的 template_id）換開頭的版型時：這首歌有中途換版型 → 開頭要是自己排的版型、畫布要一樣大。
 * 沒問題 = null；有問題 = 說明
 */
export async function checkStartAgainstSwitches(env, projectId, songId, newStartId) {
  const switches = await loadSongSwitches(env, projectId, songId);
  if (!switches.length) return null;
  if (!newStartId) {
    return '這首歌有中途換版型的設定，開頭要選自己排的版型。要改成「全部」，請先到「換版型」把中途換版型的點全部拿掉';
  }
  const templates = await loadTemplateInfos(env, projectId);
  const used = [newStartId, ...switches.map(s => s.templateId)].map(id => templates.get(id)).filter(Boolean);
  return canvasMismatch(used);
}

/** 改版型的畫布大小前：它在哪首歌的中途換版型裡、改了以後會不會跟那首歌別的版型不一樣大 */
async function timelineCanvasConflict(env, projectId, templateId, newCanvas) {
  const songs = (await env.DB.prepare(
    `SELECT s.id, s.name, s.template_id FROM songs s
      WHERE s.project_id = ? AND s.id IN (SELECT song_id FROM song_template_switches)
        AND (s.template_id = ? OR s.id IN (SELECT song_id FROM song_template_switches WHERE template_id = ?))`
  ).bind(projectId, templateId, templateId).all()).results || [];
  if (!songs.length) return null;
  const templates = await loadTemplateInfos(env, projectId);
  const switchesBy = await loadSwitchesByProject(env, projectId);
  for (const song of songs) {
    const ids = [song.template_id, ...(switchesBy.get(song.id) || []).map(sw => sw.templateId)].filter(Boolean);
    const used = ids.map(id => {
      const info = templates.get(id);
      return info && id === templateId ? { ...info, canvas: newCanvas } : info;
    }).filter(Boolean);
    const bad = canvasMismatch(used);
    if (bad) return `這個版型用在「${song.name}」中途換版型的設定裡，那首歌所有版型的畫布大小要一樣。${bad}（或先到那首歌把換版型拿掉）`;
  }
  return null;
}

/**
 * 上傳那一刻的整條時間線 → 存進 song_videos.template_timeline 的 JSON 文字；這首歌沒有換版型 / 算不出時間 = null。
 * plansCache：stampVideoTemplates 裡已經讀過的版型排法（Map，會順手補進去）
 */
async function timelineSnapshotText(env, projectId, songId, startPlan, plansCache) {
  const switches = await loadSongSwitches(env, projectId, songId);
  if (!switches.length) return null;
  const plans = new Map();
  for (const sw of switches) {
    if (!plansCache.has(sw.templateId)) plansCache.set(sw.templateId, await templatePlanForSnapshot(env, projectId, sw.templateId));
    const plan = plansCache.get(sw.templateId);
    if (plan) plans.set(sw.templateId, plan);
  }
  const tl = buildTimeline(startPlan, switches, plans);
  return tl ? serializeTimeline(tl) : null;
}

// ─────────────────────────────────────────────
// 複製專案 / 匯出匯入
// ─────────────────────────────────────────────

/** 匯出檔的內容（資料庫原樣的列；「全部」不用匯：新專案自己會有） */
export async function exportTemplates(env, projectId) {
  const [t, p, s] = await env.DB.batch([
    env.DB.prepare(`SELECT id, name, canvas_w, canvas_h, scale_pct, sort_order, cabinet_w, cabinet_h FROM led_templates WHERE project_id = ? AND kind = 'custom' ORDER BY sort_order ASC`).bind(projectId),
    env.DB.prepare(
      `SELECT lts.template_id, lts.screen_key, lts.dest_x, lts.dest_y, lts.dest_w, lts.dest_h, lts.rotate, lts.flip_h, lts.flip_v, lts.cabinet_w, lts.cabinet_h
         FROM led_template_screens lts JOIN led_templates lt ON lt.id = lts.template_id WHERE lt.project_id = ? AND lt.kind = 'custom' ORDER BY lts.rowid ASC`
    ).bind(projectId),
    env.DB.prepare(`SELECT id, object_id, name, u0, v0, u1, v1, sort_order FROM led_screens WHERE project_id = ? ORDER BY sort_order ASC`).bind(projectId),
  ]);
  const sw = await env.DB.prepare(
    `SELECT sw.id, sw.song_id, sw.cue_id, sw.at_sec, sw.template_id, sw.sort_order FROM song_template_switches sw
       JOIN songs s ON s.id = sw.song_id WHERE s.project_id = ? ORDER BY sw.sort_order ASC`
  ).bind(projectId).all();
  return { ledTemplates: t.results || [], ledTemplateScreens: p.results || [], ledScreens: s.results || [], songTemplateSwitches: sw.results || [] };
}

/** 匯出檔的一列 → [cabinet_w, cabinet_h]（舊的匯出檔沒有這兩欄、或不合規格 = 兩個都 null） */
function importCabinet(row) {
  const c = parseCabinet({ w: row?.cabinet_w, h: row?.cabinet_h });
  return c ? [c.w, c.h] : [null, null];
}

/**
 * 匯入（或複製專案）：重新給 id；物件對不到的螢幕略過；舊的匯出檔沒有這些欄位 → 什麼都不做
 * objIdMap：舊物件 id → 新物件 id；songTemplates：[{ songId（新）, templateId（舊的版型 id） }]
 */
export async function importTemplates(env, projectId, data, objIdMap, songTemplates = [], ids = {}) {
  const tpls = Array.isArray(data?.ledTemplates) ? data.ledTemplates.slice(0, MAX_TEMPLATES) : [];
  const manualRaw = Array.isArray(data?.ledScreens) ? data.ledScreens.slice(0, MAX_MANUAL_SCREENS) : [];
  if (!tpls.length && !manualRaw.length) return { templates: 0, screens: 0 };
  await ensureFullTemplate(env, projectId);
  const stmts = [];
  const screenIdMap = new Map();
  for (const s of manualRaw) {
    const objectId = objIdMap.get(s?.object_id);
    if (!objectId || typeof s.id !== 'string') continue;
    const parsed = normalizeManualScreenInput({ name: s.name, objectId, uv: [s.u0, s.v0, s.u1, s.v1] }, { partial: false, fullCanvas: null });
    if (!parsed.ok) continue;
    const id = newId('ls_') + screenIdMap.size;
    screenIdMap.set(s.id, id);
    stmts.push(env.DB.prepare(
      `INSERT INTO led_screens (id, project_id, object_id, name, u0, v0, u1, v1, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, projectId, objectId, parsed.value.name, ...parsed.value.uv, Number(s.sort_order) || 0));
  }
  const tplIdMap = new Map();
  const names = new Set();
  const placementsByTpl = new Map();
  for (const p of (Array.isArray(data?.ledTemplateScreens) ? data.ledTemplateScreens : [])) {
    if (!placementsByTpl.has(p?.template_id)) placementsByTpl.set(p?.template_id, []);
    placementsByTpl.get(p?.template_id).push(p);
  }
  let n = 0;
  for (const t of tpls) {
    if (!t || typeof t.id !== 'string') continue;
    const canvas = normalizeLedCanvas({ width: t.canvas_w, height: t.canvas_h });
    let name = typeof t.name === 'string' ? t.name.trim().slice(0, 40) : '';
    if (!canvas || !name || name.toLowerCase() === FULL_TEMPLATE_NAME.toLowerCase()) continue;
    while (names.has(name.toLowerCase())) name = (name + ' 2').slice(0, 40);
    names.add(name.toLowerCase());
    const id = newId('lt_') + n++;
    tplIdMap.set(t.id, id);
    stmts.push(env.DB.prepare(
      `INSERT INTO led_templates (id, project_id, name, kind, canvas_w, canvas_h, scale_pct, sort_order, cabinet_w, cabinet_h) VALUES (?, ?, ?, 'custom', ?, ?, ?, ?, ?, ?)`
    ).bind(id, projectId, name, canvas.width, canvas.height, Number(t.scale_pct) >= 1 && Number(t.scale_pct) <= 400 ? Number(t.scale_pct) : 100, Number(t.sort_order) || n, ...importCabinet(t)));
    for (const p of (placementsByTpl.get(t.id) || [])) {
      const k = parseScreenKey(p.screen_key);
      if (!k) continue;
      let key;
      if (k.kind === 'object') { const o = objIdMap.get(k.id); if (!o) continue; key = 'o:' + o + (k.part !== undefined ? '~' + k.part : ''); }
      else { const sid = screenIdMap.get(k.id); if (!sid) continue; key = 's:' + sid; }
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO led_template_screens (template_id, screen_key, dest_x, dest_y, dest_w, dest_h, rotate, flip_h, flip_v, cabinet_w, cabinet_h) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, key, p.dest_x | 0, p.dest_y | 0, Math.max(1, p.dest_w | 0), Math.max(1, p.dest_h | 0),
        [0, 90, 180, 270].includes(Number(p.rotate)) ? Number(p.rotate) : 0, p.flip_h ? 1 : 0, p.flip_v ? 1 : 0, ...importCabinet(p)));
    }
  }
  // 每首歌中途換版型的點（歌、Cue、版型都換成新的 id；Cue 對不到的改成純時間；版型 / 歌對不到的略過）
  const switchCounts = new Map();
  let switchSeq = 0;
  for (const w of (Array.isArray(data?.songTemplateSwitches) ? data.songTemplateSwitches : [])) {
    const songId = ids.songIdMap?.get(w?.song_id);
    const templateId = tplIdMap.get(w?.template_id);
    if (!songId || !templateId) continue;
    const n = switchCounts.get(songId) || 0;
    if (n >= MAX_SWITCHES) continue;
    const cueId = w.cue_id ? (ids.cueIdMap?.get(w.cue_id) || null) : null;
    const atSec = typeof w.at_sec === 'number' && Number.isFinite(w.at_sec) && w.at_sec >= 0 ? w.at_sec : null;
    if (!cueId && atSec === null) continue;
    switchCounts.set(songId, n + 1);
    stmts.push(env.DB.prepare(
      `INSERT INTO song_template_switches (id, song_id, cue_id, at_sec, template_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(newId('tsw_') + switchSeq++, songId, cueId, atSec, templateId, Number(w.sort_order) || n));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  // 每首歌選的版型接回新的
  const songStmts = [];
  for (const st of songTemplates) {
    const nid = tplIdMap.get(st.templateId);
    if (nid) songStmts.push(env.DB.prepare(`UPDATE songs SET template_id = ? WHERE id = ? AND project_id = ?`).bind(nid, st.songId, projectId));
  }
  for (let i = 0; i < songStmts.length; i += 50) await env.DB.batch(songStmts.slice(i, i + 50));
  return { templates: tplIdMap.size, screens: screenIdMap.size };
}

export async function copyTemplatesToProject(env, srcProjectId, dstProjectId, objIdMap, songTemplates, ids = {}) {
  const exp = await exportTemplates(env, srcProjectId);
  return importTemplates(env, dstProjectId, exp, objIdMap, songTemplates, ids);
}
