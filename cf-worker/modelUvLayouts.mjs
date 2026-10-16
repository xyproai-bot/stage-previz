// 自動貼 UV（第 1 階段）的後台：把新的模型版本、LED 畫布、「舊版面」版型、舊影片的快照在同一個交易裡一次換好；
// 模型版本記住自己搭配的畫布（換回舊版時畫布跟著回來）。
// 設計：docs/superpowers/specs/2026-10-16-auto-uv-design.md；API：docs/led-uv-api.md
//
// 為什麼是「先上傳、再套用」兩步：
//   1. PUT /model?hold=1  先把新模型檔放進 R2（不換成目前使用的版本、不動資料庫）
//   2. 前端把放好的檔案下載回來再檢查一次（網站真正載入模型的方法）
//   3. POST /led-uv/apply  檢查都過了才換：新模型 + 新畫布 + 舊版面 + 舊影片的快照 + 新切出來的螢幕，全部在一個 D1 交易裡，
//      要嘛全換、要嘛全部不換。中途失敗只會留下一個沒人用的模型版本（可以在「模型版本」刪掉），不會有「模型換了、舊影片沒保護」的半套狀態。
//
// 舊影片怎麼保護（跟版型快照的設計一致）：
//   影片版本的 template_snapshot = NULL 的意思是「做的時候用整張畫布」。套用以後整張畫布變了，這些舊影片就會貼歪。
//   所以套用時建一個「舊版面」版型（畫布 = 套用前的整張畫布，每塊螢幕放在它原本的像素位置、方向用原本的方向），
//   然後把「那一刻」所有 template_snapshot = NULL 的影片版本，寫上這個版型和它的排法（快照，自成一體）。
//   套用「之後」新上傳的影片仍然是 NULL = 新的整張畫布（照新的 UV 做的）。
//   歌選的版型（songs.template_id）不動：AE 即時 / 本地檔案是現在在做的新畫面，而且歌的版型也是新上傳影片的預設，
//   改成舊版面會讓之後新做的影片被當成舊畫布。想用舊版面看舊的本地檔案，到歌單的「LED 版型」自己選「舊版面」。
//   換回舊版模型時，這些影片還原成 NULL（因為舊的 UV 本來就對得上舊畫面）；再換回新版時重新套上。

import {
  normalizeManualScreenInput, normalizePlacementInputs, normalizeTemplateName, parseScreenKey,
  MAX_SCREENS_PER_OBJECT, TEMPLATE_VERSION,
} from '../web/src/lib/ledTemplate.ts';
import { normalizeLedCanvas } from '../web/src/lib/ledCanvas.ts';
import { ensureFullTemplate, MAX_MANUAL_SCREENS, MAX_TEMPLATES } from './ledTemplates.mjs';

export const LEGACY_TEMPLATE_NAME = '舊版面';
export const MAX_RECIPE_BYTES = 256 * 1024;
const NOTE_MAX = 80;
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const REF_RE = /^[a-zA-Z0-9_#-]{1,100}$/;
const CHUNK = 80;

const ok = (body, status = 200) => ({ status, body });
const bad = (error, status = 400, extra = {}) => ({ status, body: { error, ...extra } });
const newId = (prefix) => prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const nowIso = () => new Date().toISOString();
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

async function readJson(request) {
  try { const b = await request.json(); return isObj(b) ? b : null; } catch { return null; }
}

function parseJsonList(text) {
  if (!text) return [];
  try { const v = JSON.parse(text); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; }
}

/** 一串 id 分成一段一段（D1 一個陳述式最多綁 100 個參數） */
function chunks(list) {
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

async function layoutRow(env, projectId, key) {
  if (!key) return null;
  return env.DB.prepare(`SELECT * FROM model_uv_layouts WHERE project_id = ? AND model_key = ? LIMIT 1`).bind(projectId, key).first();
}

// ─────────────────────────────────────────────
// POST /led-uv/apply
// ─────────────────────────────────────────────

/** 取一個沒被用過的版型名稱：舊版面、舊版面 2、舊版面 3… */
function freeName(base, taken) {
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const n = `${base} ${i}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
  return `${base} ${Date.now()}`;
}

export async function applyAutoUv(request, env, ctx, log) {
  const { projectId, me } = ctx;
  if (!env.MODELS) return bad('R2 not configured', 500);
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');

  const key = typeof body.key === 'string' ? body.key : '';
  if (!key.startsWith(`models/${projectId}/`) || !key.endsWith('.glb') || key.includes('..')) return bad('模型檔的位置不對');
  if (!('ifActive' in body) || (body.ifActive !== null && typeof body.ifActive !== 'string')) return bad('要附上分析時的模型版本（ifActive）');
  const ledCanvas = normalizeLedCanvas(body.ledCanvas);
  if (!ledCanvas) return bad('LED 畫布大小不對（寬高要是 16 ~ 32768 的整數）');
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, NOTE_MAX) : '';
  let recipe = null;
  if (body.recipe !== undefined && body.recipe !== null) {
    if (!isObj(body.recipe)) return bad('recipe 格式不對');
    recipe = JSON.stringify(body.recipe);
    if (recipe.length > MAX_RECIPE_BYTES) return bad('recipe 太大（最多 256 KB）', 413);
  }

  const cur = await env.DB.prepare(`SELECT model_r2_key, led_canvas FROM projects WHERE id = ? LIMIT 1`).bind(projectId).first();
  if (!cur) return bad('Not found', 404);
  if ((body.ifActive ?? null) !== (cur.model_r2_key ?? null)) {
    return bad('模型已經被別人換過了，請重新分析', 409, { conflict: true });
  }
  if (key === cur.model_r2_key) return bad('這個模型已經是目前使用的版本');
  const head = await env.MODELS.head(key);
  if (!head) return bad('找不到剛上傳的模型檔，請再試一次', 404);

  // LED 物件、已經切好的螢幕
  const objects = new Set(((await env.DB.prepare(`SELECT id FROM stage_objects WHERE project_id = ? AND category = 'led_panel'`).bind(projectId).all()).results || []).map(r => r.id));
  const existing = new Map(((await env.DB.prepare(`SELECT * FROM led_screens WHERE project_id = ?`).bind(projectId).all()).results || []).map(r => [r.id, r]));

  // 新切出來的螢幕（一個物件有好幾片分開的平面：每片各一個）
  const pieces = Array.isArray(body.pieceScreens) ? body.pieceScreens : [];
  if (pieces.length > MAX_MANUAL_SCREENS) return bad(`一次最多切出 ${MAX_MANUAL_SCREENS} 塊螢幕`);
  const perObject = new Map();
  for (const r of existing.values()) perObject.set(r.object_id, (perObject.get(r.object_id) || 0) + 1);
  const refToId = new Map();
  const newScreens = [];
  for (const p of pieces) {
    if (!isObj(p) || typeof p.ref !== 'string' || !REF_RE.test(p.ref) || refToId.has(p.ref)) return bad('新切出來的螢幕格式不對');
    if (typeof p.objectId !== 'string' || !objects.has(p.objectId)) return bad('這個專案裡找不到這個 LED 物件（可能被刪掉了，請重新整理）', 404);
    const parsed = normalizeManualScreenInput({ name: p.name, objectId: p.objectId, uv: p.uv }, { partial: false, fullCanvas: ledCanvas });
    if (!parsed.ok) return bad(parsed.error);
    const n = (perObject.get(p.objectId) || 0) + 1;
    if (n > MAX_SCREENS_PER_OBJECT) return bad(`一個 LED 物件最多切成 ${MAX_SCREENS_PER_OBJECT} 塊螢幕`, 409);
    perObject.set(p.objectId, n);
    const id = newId('ls_');
    refToId.set(p.ref, id);
    newScreens.push({ id, objectId: p.objectId, name: parsed.value.name, uv: parsed.value.uv });
  }
  if (existing.size + newScreens.length > MAX_MANUAL_SCREENS) return bad(`一個專案最多 ${MAX_MANUAL_SCREENS} 塊手動切的螢幕`, 409);

  // 原本就切好的螢幕：範圍跟著物件平移
  const updates = [];
  for (const u of Array.isArray(body.screenUpdates) ? body.screenUpdates : []) {
    if (!isObj(u) || typeof u.id !== 'string' || !existing.has(u.id)) return bad('這個專案裡找不到要更新的螢幕', 404);
    const parsed = normalizeManualScreenInput({ uv: u.uv }, { partial: true, fullCanvas: ledCanvas });
    if (!parsed.ok) return bad(parsed.error);
    updates.push({ id: u.id, uv: parsed.value.uv });
  }
  const screenUv = new Map([...existing.values()].map(r => [r.id, { objectId: r.object_id, uv: [r.u0, r.v0, r.u1, r.v1] }]));
  for (const u of updates) screenUv.get(u.id).uv = u.uv;
  for (const s of newScreens) screenUv.set(s.id, { objectId: s.objectId, uv: s.uv });

  // 舊版面
  let legacy = null;
  if (body.legacy !== undefined && body.legacy !== null) {
    const lg = body.legacy;
    if (!isObj(lg)) return bad('舊版面的格式不對');
    const canvas = normalizeLedCanvas(lg.canvas);
    if (!canvas) return bad('舊版面的畫布大小不對（寬高要是 16 ~ 32768 的整數）');
    const rawScreens = Array.isArray(lg.screens) ? lg.screens : [];
    const resolved = [];
    for (const s of rawScreens) {
      if (!isObj(s) || typeof s.key !== 'string') return bad('舊版面的螢幕格式不對');
      let k = s.key;
      if (k.startsWith('s:@')) {
        const id = refToId.get(k.slice(3));
        if (!id) return bad(`舊版面用到的新螢幕找不到（${k.slice(0, 40)}）`);
        k = 's:' + id;
      }
      resolved.push({ ...s, key: k });
    }
    const placed = normalizePlacementInputs(resolved);
    if (!placed.ok) return bad(placed.error);
    const screens = [];
    for (const p of placed.value) {
      const k = parseScreenKey(p.key);
      if (k.kind === 'object') {
        if (!objects.has(k.id)) return bad(`舊版面用到的 LED 物件找不到（${p.key}）`, 404);
        screens.push({ key: p.key, objectId: k.id, uv: null, dest: p.dest, rotate: p.rotate, flipH: p.flipH, flipV: p.flipV });
      } else {
        const sv = screenUv.get(k.id);
        if (!sv) return bad(`舊版面用到的螢幕找不到（${p.key}）`, 404);
        screens.push({ key: p.key, objectId: sv.objectId, uv: sv.uv, dest: p.dest, rotate: p.rotate, flipH: p.flipH, flipV: p.flipV });
      }
    }
    if (screens.length > 0) legacy = { canvas, screens };
  }

  const curCanvasJson = cur.led_canvas ? JSON.stringify(normalizeLedCanvas(cur.led_canvas)) : null;
  const stmts = [];
  const t = nowIso();
  const tId = (me && me.id) || null;

  // 新切出來的螢幕、原本螢幕的新範圍
  let sort = ((await env.DB.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM led_screens WHERE project_id = ?`).bind(projectId).first())?.m || 0);
  for (const s of newScreens) {
    stmts.push(env.DB.prepare(
      `INSERT INTO led_screens (id, project_id, object_id, name, u0, v0, u1, v1, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(s.id, projectId, s.objectId, s.name, s.uv[0], s.uv[1], s.uv[2], s.uv[3], ++sort, t, t));
  }
  for (const u of updates) {
    stmts.push(env.DB.prepare(`UPDATE led_screens SET u0 = ?, v0 = ?, u1 = ?, v1 = ?, updated_at = ? WHERE id = ? AND project_id = ?`)
      .bind(u.uv[0], u.uv[1], u.uv[2], u.uv[3], t, u.id, projectId));
  }

  // 舊版面版型 + 舊影片的快照
  let legacyId = null, legacyName = null, stamped = [], legacyPlanJson = null;
  if (legacy) {
    await ensureFullTemplate(env, projectId);
    const tpls = (await env.DB.prepare(`SELECT name FROM led_templates WHERE project_id = ?`).bind(projectId).all()).results || [];
    const customCount = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM led_templates WHERE project_id = ? AND kind = 'custom'`).bind(projectId).first())?.n || 0;
    if (customCount >= MAX_TEMPLATES) return bad(`版型已經有 ${MAX_TEMPLATES} 個（上限），先刪掉不用的版型再套用（要建「${LEGACY_TEMPLATE_NAME}」保護舊影片）`, 409);
    legacyName = freeName(LEGACY_TEMPLATE_NAME, new Set(tpls.map(r => String(r.name).toLowerCase())));
    const named = normalizeTemplateName(legacyName);
    if (!named.ok) return bad(named.error);
    legacyId = newId('lt_');
    const sortT = ((await env.DB.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM led_templates WHERE project_id = ?`).bind(projectId).first())?.m || 0) + 1;
    stmts.push(env.DB.prepare(
      `INSERT INTO led_templates (id, project_id, name, kind, canvas_w, canvas_h, scale_pct, sort_order, created_by, created_at, updated_at) VALUES (?, ?, ?, 'custom', ?, ?, 100, ?, ?, ?, ?)`
    ).bind(legacyId, projectId, legacyName, legacy.canvas.width, legacy.canvas.height, sortT, tId, t, t));
    for (const p of legacy.screens) {
      stmts.push(env.DB.prepare(
        `INSERT INTO led_template_screens (template_id, screen_key, dest_x, dest_y, dest_w, dest_h, rotate, flip_h, flip_v) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(legacyId, p.key, p.dest.x, p.dest.y, p.dest.w, p.dest.h, p.rotate, p.flipH ? 1 : 0, p.flipV ? 1 : 0));
    }
    const plan = { v: TEMPLATE_VERSION, id: legacyId, name: legacyName, canvas: legacy.canvas, scalePct: 100, screens: legacy.screens };
    legacyPlanJson = JSON.stringify(plan);
    stamped = ((await env.DB.prepare(`SELECT id FROM song_videos WHERE project_id = ? AND template_snapshot IS NULL`).bind(projectId).all()).results || []).map(r => r.id);
    for (const part of chunks(stamped)) {
      stmts.push(env.DB.prepare(
        `UPDATE song_videos SET template_id = ?, template_snapshot = ? WHERE project_id = ? AND template_snapshot IS NULL AND id IN (${part.map(() => '?').join(',')})`
      ).bind(legacyId, legacyPlanJson, projectId, ...part));
    }
  }

  // 模型 + 畫布 + 版本紀錄
  stmts.push(env.DB.prepare(`UPDATE projects SET model_r2_key = ?, led_canvas = ?, updated_at = datetime('now') WHERE id = ?`).bind(key, JSON.stringify(ledCanvas), projectId));
  if (cur.model_r2_key) {
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO model_uv_layouts (project_id, model_key, led_canvas, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(projectId, cur.model_r2_key, curCanvasJson, '套用自動貼 UV 前', tId, t));
  }
  stmts.push(env.DB.prepare(
    `INSERT OR REPLACE INTO model_uv_layouts (project_id, model_key, led_canvas, recipe, note, legacy_template_id, legacy_plan, stamped_videos, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(projectId, key, JSON.stringify(ledCanvas), recipe, note || '自動貼 UV', legacyId, legacyPlanJson, legacy ? JSON.stringify(stamped) : null, tId, t));

  try {
    await env.DB.batch(stmts);
  } catch (e) {
    return bad('套用沒有成功（資料庫拒絕了）：' + String(e?.message || e).slice(0, 160), 400);
  }
  await log?.('upload', 'model', key, { note, ledCanvas, autoUv: true, legacyTemplate: legacyName, stampedVideos: stamped.length });
  return ok({
    ok: true, key, url: `/r2/${key}`, ledCanvas,
    legacyTemplateId: legacyId, legacyTemplateName: legacyName, stampedVideos: stamped.length,
    pieceScreens: [...refToId].map(([ref, id]) => ({ ref, id })),
  });
}

// ─────────────────────────────────────────────
// GET /led-uv/impact：套用前先告訴製作會動到什麼
// ─────────────────────────────────────────────

export async function uvImpact(env, ctx) {
  const { projectId } = ctx;
  const [v, s, t, ts, m] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM song_videos WHERE project_id = ? AND template_snapshot IS NULL AND purged_at IS NULL`).bind(projectId),
    env.DB.prepare(`SELECT COUNT(DISTINCT song_id) AS n FROM song_videos WHERE project_id = ? AND template_snapshot IS NULL AND purged_at IS NULL`).bind(projectId),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM led_templates WHERE project_id = ? AND kind = 'custom'`).bind(projectId),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM led_template_screens lts JOIN led_templates lt ON lt.id = lts.template_id WHERE lt.project_id = ? AND lt.kind = 'custom'`).bind(projectId),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM led_screens WHERE project_id = ?`).bind(projectId),
  ]);
  const n = (r) => r.results?.[0]?.n || 0;
  return ok({ videoVersions: n(v), songsWithVideos: n(s), customTemplates: n(t), templateScreens: n(ts), manualSplits: n(m) });
}

// ─────────────────────────────────────────────
// 排到一半的東西（第 3 階段）：勾的螢幕、每片的點數、辨識類型、自己排的排法，存在目前使用的模型版本的 recipe.edit 裡
//   - 排到一半就存（前端停手 1.5 秒），重新整理、關掉再開，同一個模型版本從上次的樣子繼續
//   - 套用的時候 recipe（含 edit）跟著新版本一起存，下次打開接著做
//   沒有新的 migration：recipe 欄位 0036 就有了。這個版本還沒有紀錄的話建一筆（畫布 = 現在的畫布，跟「套用前」那筆一樣的意思）。
// ─────────────────────────────────────────────

export const MAX_EDIT_BYTES = 200 * 1024;

export async function getLayoutEdit(env, ctx) {
  const { projectId } = ctx;
  const cur = await env.DB.prepare(`SELECT model_r2_key FROM projects WHERE id = ? LIMIT 1`).bind(projectId).first();
  if (!cur) return bad('Not found', 404);
  const key = cur.model_r2_key || null;
  const row = await layoutRow(env, projectId, key);
  let edit = null;
  if (row && row.recipe) {
    try { const r = JSON.parse(row.recipe); if (isObj(r) && isObj(r.edit)) edit = r.edit; } catch { /* 壞掉的 recipe 當沒有 */ }
  }
  return ok({ key, edit });
}

export async function putLayoutEdit(request, env, ctx) {
  const { projectId, me } = ctx;
  const body = await readJson(request);
  if (!body) return bad('Invalid JSON');
  if (!('ifActive' in body) || (body.ifActive !== null && typeof body.ifActive !== 'string')) return bad('要附上打開時的模型版本（ifActive）');
  if (!isObj(body.edit) || body.edit.v !== 1) return bad('要存的內容格式不對');
  const edit = JSON.stringify(body.edit);
  if (edit.length > MAX_EDIT_BYTES) return bad('要存的內容太大（最多 200 KB）', 413);

  const cur = await env.DB.prepare(`SELECT model_r2_key, led_canvas FROM projects WHERE id = ? LIMIT 1`).bind(projectId).first();
  if (!cur) return bad('Not found', 404);
  if (!cur.model_r2_key) return bad('這個專案還沒有 3D 模型');
  if ((body.ifActive ?? null) !== cur.model_r2_key) return bad('模型已經被別人換過了，請重新分析', 409, { conflict: true });

  const row = await layoutRow(env, projectId, cur.model_r2_key);
  let recipe = {};
  if (row && row.recipe) {
    try { const r = JSON.parse(row.recipe); if (isObj(r)) recipe = r; } catch { /* 壞掉的 recipe 重新開始 */ }
  }
  recipe.v = 1;
  recipe.edit = body.edit;
  const text = JSON.stringify(recipe);
  if (text.length > MAX_RECIPE_BYTES) return bad('要存的內容太大（最多 256 KB）', 413);
  const t = nowIso();
  if (row) {
    await env.DB.prepare(`UPDATE model_uv_layouts SET recipe = ? WHERE project_id = ? AND model_key = ?`).bind(text, projectId, cur.model_r2_key).run();
  } else {
    const canvasJson = cur.led_canvas ? JSON.stringify(normalizeLedCanvas(cur.led_canvas)) : null;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO model_uv_layouts (project_id, model_key, led_canvas, recipe, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(projectId, cur.model_r2_key, canvasJson, text, null, (me && me.id) || null, t).run();
  }
  return ok({ ok: true, key: cur.model_r2_key });
}

// ─────────────────────────────────────────────
// 模型版本：列表上的說明、換版本時畫布和舊影片跟著換、刪除、一般上傳時沿用
// ─────────────────────────────────────────────

/** 每個版本搭配的資料（模型版本列表用） */
export async function versionInfoMap(env, projectId) {
  const rows = (await env.DB.prepare(
    `SELECT model_key, led_canvas, note, recipe IS NOT NULL AS has_recipe, legacy_template_id FROM model_uv_layouts WHERE project_id = ?`
  ).bind(projectId).all()).results || [];
  const out = new Map();
  for (const r of rows) {
    out.set(r.model_key, {
      note: r.note || null,
      ledCanvas: r.led_canvas ? normalizeLedCanvas(r.led_canvas) : null,
      hasLayout: !!r.has_recipe,
      autoUv: !!r.legacy_template_id || !!r.has_recipe,
    });
  }
  return out;
}

/**
 * 換成某個版本：模型 + 畫布（這個版本有紀錄就換回它的畫布）+ 舊影片（離開套用過自動貼 UV 的版本 → 舊影片還原；進入 → 重新套上），一個交易。
 * 回傳 { ledCanvas, restoredCanvas }
 */
export async function activateVersion(env, projectId, key) {
  const cur = await env.DB.prepare(`SELECT model_r2_key FROM projects WHERE id = ? LIMIT 1`).bind(projectId).first();
  const prevKey = cur?.model_r2_key || null;
  const stmts = [];
  let restored = false;
  let canvasJson = null;
  if (prevKey && prevKey !== key) {
    const [prevRow, targetRow] = await Promise.all([layoutRow(env, projectId, prevKey), layoutRow(env, projectId, key)]);
    if (prevRow) {
      // 離開之前把現在的畫布記在這個版本上（製作可能在這個版本上手動改過畫布）
      stmts.push(env.DB.prepare(`UPDATE model_uv_layouts SET led_canvas = (SELECT led_canvas FROM projects WHERE id = ?) WHERE project_id = ? AND model_key = ?`).bind(projectId, projectId, prevKey));
      const ids = parseJsonList(prevRow.stamped_videos);
      if (prevRow.legacy_template_id) {
        for (const part of chunks(ids)) {
          stmts.push(env.DB.prepare(
            `UPDATE song_videos SET template_id = NULL, template_snapshot = NULL WHERE project_id = ? AND template_id = ? AND id IN (${part.map(() => '?').join(',')})`
          ).bind(projectId, prevRow.legacy_template_id, ...part));
        }
      }
    }
    if (targetRow) {
      restored = true;
      canvasJson = targetRow.led_canvas || null;
      const ids = parseJsonList(targetRow.stamped_videos);
      if (targetRow.legacy_plan && targetRow.legacy_template_id) {
        for (const part of chunks(ids)) {
          stmts.push(env.DB.prepare(
            `UPDATE song_videos SET template_id = ?, template_snapshot = ? WHERE project_id = ? AND template_snapshot IS NULL AND id IN (${part.map(() => '?').join(',')})`
          ).bind(targetRow.legacy_template_id, targetRow.legacy_plan, projectId, ...part));
        }
      }
    }
  }
  if (restored) {
    stmts.push(env.DB.prepare(`UPDATE projects SET model_r2_key = ?, led_canvas = ?, updated_at = datetime('now') WHERE id = ?`).bind(key, canvasJson, projectId));
  } else {
    stmts.push(env.DB.prepare(`UPDATE projects SET model_r2_key = ?, updated_at = datetime('now') WHERE id = ?`).bind(key, projectId));
  }
  await env.DB.batch(stmts);
  return { ledCanvas: restored && canvasJson ? normalizeLedCanvas(canvasJson) : null, restoredCanvas: restored };
}

/** 刪掉某個版本時，它的紀錄也刪掉 */
export function deleteVersionRow(env, projectId, key) {
  return env.DB.prepare(`DELETE FROM model_uv_layouts WHERE project_id = ? AND model_key = ?`).bind(projectId, key).run();
}

/**
 * 一般上傳新模型（例如「壓縮這個模型」）時，如果上一版有紀錄（畫布，或自動貼 UV 的舊版面）→ 新的這版沿用（畫布、舊版面、哪些影片），
 * 這樣壓縮完的新版本換來換去時，舊影片還是跟著對的模型走。沒有紀錄的專案什麼都不做。
 */
export async function inheritLayoutOnUpload(env, projectId, prevKey, newKey, userId) {
  if (!prevKey || !newKey || prevKey === newKey) return;
  const prev = await layoutRow(env, projectId, prevKey);
  if (!prev) return;
  const canvas = (await env.DB.prepare(`SELECT led_canvas FROM projects WHERE id = ? LIMIT 1`).bind(projectId).first())?.led_canvas || null;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO model_uv_layouts (project_id, model_key, led_canvas, recipe, note, legacy_template_id, legacy_plan, stamped_videos, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(projectId, newKey, canvas, prev.recipe, prev.note ? `${prev.note}（沿用）` : null, prev.legacy_template_id, prev.legacy_plan, prev.stamped_videos, userId || null, nowIso()).run();
}
