// 自動貼 UV 的前端呼叫 — 對應 cf-worker/modelUvLayouts.mjs；說明：docs/led-uv-api.md
// 跟 api.ts 分開（像 ledTemplateApi.ts）：別的頁面正在改 api.ts，這裡自己一份。
//
// 流程：先把新模型 hold 上傳（只放進 R2，不換版本）→ 前端把它下載回來再檢查 → 檢查都過了才呼叫 apply 一次換好。
// 權限（後台會檢查，畫面只是先擋）：全部都是這個專案的製作

import { apiBase, getSessionToken } from './api';
import { saveStatus } from './saveStatus';
import type { CanvasSize } from './ledMap';
import type { UvBox } from './ledTemplate';
import type { LegacyScreen, PieceScreen } from './ledUv/plan';

export interface LedUvApiError extends Error {
  status: number;
  data: { error?: string; conflict?: boolean; [k: string]: unknown };
}

const enc = encodeURIComponent;
const base = (projectId: string) => `/api/projects/${enc(projectId)}`;

async function toError(resp: Response): Promise<LedUvApiError> {
  let data: LedUvApiError['data'] = {};
  try { data = await resp.json(); } catch { /* 不是 JSON */ }
  const e = new Error(data?.error || `HTTP ${resp.status}`) as LedUvApiError;
  e.status = resp.status;
  e.data = data || {};
  return e;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const h: Record<string, string> = {};
  const token = getSessionToken();
  if (token) h.Authorization = `Bearer ${token}`;
  if (typeof init.body === 'string') h['Content-Type'] = 'application/json';
  const mutation = (init.method || 'GET').toUpperCase() !== 'GET';
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
      if ((e as LedUvApiError).status !== 409) saveStatus.fail(e instanceof Error ? e.message : String(e));
    }
    throw e;
  }
}

/** 套用前會動到什麼（只有數字） */
export interface UvImpact {
  /** 沒有版型的舊影片版本（會自動改用「舊版面」） */
  videoVersions: number;
  songsWithVideos: number;
  customTemplates: number;
  templateScreens: number;
  manualSplits: number;
}

/** 舊的後台沒有這個網址（404）→ null（畫面當作沒有這個功能） */
export async function getUvImpact(projectId: string): Promise<UvImpact | null> {
  try {
    return await call<UvImpact>(`${base(projectId)}/led-uv/impact`);
  } catch (e) {
    if ((e as LedUvApiError).status === 404) return null;
    throw e;
  }
}

/** 把新模型放進 R2，但先不換成目前使用的版本（?hold=1）；回傳新模型的 key */
export function uploadModelHeld(projectId: string, file: Blob, onProgress?: (loaded: number, total: number) => void): Promise<{ key: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${apiBase()}${base(projectId)}/model?hold=1`);
    xhr.setRequestHeader('Content-Type', 'model/gltf-binary');
    const token = getSessionToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.withCredentials = true;
    if (onProgress && xhr.upload) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
    xhr.onload = () => {
      let data: { key?: string; held?: boolean; error?: string } = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* 不是 JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && data.key) {
        // 舊的後台不認識 ?hold=1，會直接換成新模型：那就不能用這個流程（沒有檢查就換了）
        if (!data.held) reject(new Error('這個後台還不支援自動貼 UV（新模型已經直接換上去了，請到「模型版本」換回上一版）'));
        else resolve({ key: data.key });
      } else reject(new Error(data.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.onabort = () => reject(new Error('Upload aborted'));
    xhr.send(file);
  });
}

export interface ApplyBody {
  key: string;
  /** 分析時的模型版本（別人在這之後換過 → 409） */
  ifActive: string | null;
  ledCanvas: CanvasSize;
  note: string;
  recipe: Record<string, unknown>;
  legacy: { canvas: CanvasSize; screens: Pick<LegacyScreen, 'key' | 'dest' | 'rotate' | 'flipH' | 'flipV'>[]; originalUv?: string[] } | null;
  pieceScreens: PieceScreen[];
  screenUpdates: { id: string; uv: UvBox }[];
}

export interface ApplyResult {
  ok: boolean;
  key: string;
  ledCanvas: CanvasSize;
  legacyTemplateId: string | null;
  legacyTemplateName: string | null;
  stampedVideos: number;
  pieceScreens: { ref: string; id: string }[];
}

export function applyAutoUv(projectId: string, body: ApplyBody): Promise<ApplyResult> {
  return call<ApplyResult>(`${base(projectId)}/led-uv/apply`, { method: 'POST', body: JSON.stringify(body) });
}

/**
 * 目前使用的模型版本上次存的「製作填的東西」（勾的螢幕、點數、排法…，格式見 ledUv/editState.ts）。
 * 舊的後台沒有這個網址（404）→ null（照常用，只是不會記住上次排的）。key = 目前使用的模型版本。
 */
export async function getUvLayoutEdit(projectId: string): Promise<{ key: string | null; edit: unknown } | null> {
  try {
    return await call<{ key: string | null; edit: unknown }>(`${base(projectId)}/led-uv/layout`);
  } catch (e) {
    if ((e as LedUvApiError).status === 404) return null;
    throw e;
  }
}

/** 排到一半存起來（停手一下就存）。ifActive = 打開時的模型版本；別人換過 = 409，不存 */
export function saveUvLayoutEdit(projectId: string, ifActive: string | null, edit: Record<string, unknown>): Promise<{ ok: boolean; key: string }> {
  return call<{ ok: boolean; key: string }>(`${base(projectId)}/led-uv/layout`, { method: 'PUT', body: JSON.stringify({ ifActive, edit }) });
}
