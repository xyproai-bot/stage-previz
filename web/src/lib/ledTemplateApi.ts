// LED 畫布版型的前端呼叫 — 對應 cf-worker/ledTemplates.mjs；完整說明（每個網址、回傳格式、錯誤碼）：docs/led-templates-api.md
// 跟 api.ts 分開（像 videoApi.ts / mechanismApi.ts）：別的頁面正在改 api.ts，這裡自己一份。
//
// 權限（後台會檢查，畫面只是先擋）：看 = 專案成員；改（版型、手動切的螢幕、每首歌選版型）= 這個專案的製作

import { apiBase, getSessionToken } from './api';
import { saveStatus } from './saveStatus';
import { parsePlan, type LedTemplatePlan, type ManualScreen, type PlacementInput, type UvBox } from './ledTemplate';
import type { CanvasSize } from './ledMap';
import { parseSwitches, type TimelineInput, type TimelineSwitch } from './ledTemplateTimeline';

export interface LedTemplateApiError extends Error {
  status: number;
  data: { error?: string; needsLedCanvas?: boolean; nameTaken?: boolean; inUse?: boolean; songCount?: number; [k: string]: unknown };
}

/** 一個版型（後台給的）：plan + 種類 / 幾首歌在用 */
export interface LedTemplate extends LedTemplatePlan {
  id: string;
  kind: 'full' | 'custom';
  sortOrder: number;
  songCount: number;
  /** 「全部」在專案還沒填 LED 畫布大小時是 null；其他版型一定有 */
  canvas: CanvasSize;
}

export interface LedTemplateList {
  /** 專案的 LED 畫布（= 「全部」版型的畫布，每塊螢幕的真實點數從這裡算）；還沒填 = null */
  fullCanvas: CanvasSize | null;
  /** 第一個一定是「全部」 */
  templates: LedTemplate[];
  /** 手動切的螢幕 */
  screens: ManualScreen[];
}

export interface TemplateBody {
  name: string;
  canvas: CanvasSize;
  scalePct: number;
  screens: PlacementInput[];
}

const enc = encodeURIComponent;
const base = (projectId: string) => `/api/projects/${enc(projectId)}`;

async function toError(resp: Response): Promise<LedTemplateApiError> {
  let data: LedTemplateApiError['data'] = {};
  try { data = await resp.json(); } catch { /* 不是 JSON */ }
  const e = new Error(data?.error || `HTTP ${resp.status}`) as LedTemplateApiError;
  e.status = resp.status;
  e.data = data || {};
  return e;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const h: Record<string, string> = {};
  const token = getSessionToken();
  if (token) h.Authorization = `Bearer ${token}`;
  if (typeof init.body === 'string') h['Content-Type'] = 'application/json';
  const method = (init.method || 'GET').toUpperCase();
  const mutation = method !== 'GET' && method !== 'HEAD';
  if (mutation) saveStatus.saving();
  try {
    const resp = await fetch(apiBase() + path, { credentials: 'include', ...init, headers: h });
    if (!resp.ok) throw await toError(resp);
    const out = await resp.json() as T;
    if (mutation) saveStatus.done();
    return out;
  } catch (e) {
    if (mutation) {
      saveStatus.done();
      if ((e as LedTemplateApiError).status !== 409) saveStatus.fail(e instanceof Error ? e.message : String(e));
    }
    throw e;
  }
}

const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);

function parseManual(raw: unknown): ManualScreen | null {
  const r = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null;
  if (!r || typeof r.id !== 'string' || typeof r.objectId !== 'string' || !Array.isArray(r.uv) || r.uv.length !== 4) return null;
  const uv = r.uv.map(n => num(n, NaN)) as UvBox;
  if (uv.some(n => Number.isNaN(n))) return null;
  return { id: r.id, objectId: r.objectId, name: typeof r.name === 'string' ? r.name : '螢幕', uv };
}

export function parseTemplateList(raw: unknown): LedTemplateList {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fc = r.fullCanvas as { width?: unknown; height?: unknown } | null;
  const fullCanvas = fc && typeof fc.width === 'number' && typeof fc.height === 'number' ? { width: fc.width, height: fc.height } : null;
  const templates: LedTemplate[] = [];
  for (const t of Array.isArray(r.templates) ? r.templates : []) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const kind = o.kind === 'full' ? 'full' : 'custom';
    // 「全部」沒有自己的畫布（跟著專案）：畫成 plan 時用專案的；還沒填 = 0×0（畫面上不會用到）
    const plan = parsePlan(kind === 'full' ? { ...o, canvas: fullCanvas ?? { width: 16, height: 16 } } : o);
    if (!plan || typeof o.id !== 'string') continue;
    templates.push({
      ...plan, id: o.id, kind, canvas: kind === 'full' ? (fullCanvas ?? { width: 0, height: 0 }) : plan.canvas,
      sortOrder: num(o.sortOrder, 0), songCount: num(o.songCount, 0),
    });
  }
  const screens = (Array.isArray(r.screens) ? r.screens : []).map(parseManual).filter((x): x is ManualScreen => !!x);
  return { fullCanvas, templates, screens };
}

/** 版型清單；舊的後台沒有這個網址（404）→ null（畫面當作沒有這個功能） */
export async function listLedTemplates(projectId: string): Promise<LedTemplateList | null> {
  try {
    return parseTemplateList(await call<unknown>(`${base(projectId)}/led-templates`));
  } catch (e) {
    if ((e as LedTemplateApiError).status === 404) return null;
    throw e;
  }
}

export async function createLedTemplate(projectId: string, body: TemplateBody): Promise<void> {
  await call(`${base(projectId)}/led-templates`, { method: 'POST', body: JSON.stringify(body) });
}

export async function updateLedTemplate(projectId: string, templateId: string, body: Partial<TemplateBody>): Promise<void> {
  await call(`${base(projectId)}/led-templates/${enc(templateId)}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function deleteLedTemplate(projectId: string, templateId: string): Promise<void> {
  await call(`${base(projectId)}/led-templates/${enc(templateId)}`, { method: 'DELETE' });
}

export async function createLedScreen(projectId: string, body: { objectId: string; name: string; uv: UvBox }): Promise<void> {
  await call(`${base(projectId)}/led-screens`, { method: 'POST', body: JSON.stringify(body) });
}

export async function deleteLedScreen(projectId: string, screenId: string): Promise<void> {
  await call(`${base(projectId)}/led-screens/${enc(screenId)}`, { method: 'DELETE' });
}

/**
 * 這首歌的版型時間線（0039）：整份換掉。start = 開頭的版型（也就是這首歌選的版型；有換版型的點就一定要是自己排的版型），
 * switches = 中途換版型的點（用 Cue 或直接寫時間，二選一）。回傳存好的開頭版型和換版型的點。
 * 畫布大小不一樣、Cue 沒有影片時間之類的問題，後台回 409 + 中文說明（error.message 可以直接顯示）
 */
export async function setSongTimeline(projectId: string, songId: string, body: TimelineInput): Promise<{ templateId: string | null; templateSwitches: TimelineSwitch[] }> {
  const r = await call<{ templateId?: string | null; templateSwitches?: unknown }>(
    `${base(projectId)}/songs/${enc(songId)}/template-timeline`, { method: 'PUT', body: JSON.stringify(body) },
  );
  return { templateId: r.templateId ?? null, templateSwitches: parseSwitches(r.templateSwitches) };
}

/** 這首歌用哪個版型（null = 整張畫布） */
export async function setSongTemplate(projectId: string, songId: string, templateId: string | null): Promise<void> {
  await call(`${base(projectId)}/songs/${enc(songId)}`, { method: 'PATCH', body: JSON.stringify({ template_id: templateId }) });
}
