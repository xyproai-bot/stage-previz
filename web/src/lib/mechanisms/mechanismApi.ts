// 機關的前端呼叫 — 對應 cf-worker/mechanisms.mjs；完整說明（每個網址、回傳格式、錯誤碼）：docs/mechanisms-api.md
// 跟 api.ts 分開（像 videoApi.ts）：別的頁面正在改 api.ts，這裡自己一份。
//
// 權限（後台會檢查，畫面只是先擋）：看 = 專案成員；改 = 這個專案的製作（導演 / 動畫師 403）

import { apiBase, getSessionToken, type ShareRef } from '../api';
import { saveStatus } from '../saveStatus';
import type { CueMechanismPosition, Mechanism, MechanismInput, MechanismPreset, MechanismValues, MechVec3 } from './model';

/** 後台回的錯誤：message 是中文、可以直接顯示；data 是整個錯誤內容 */
export interface MechanismApiError extends Error {
  status: number;
  data: {
    error?: string;
    /** 檢查沒過的欄位（400） */
    field?: string;
    /** 物件已經在別的機關（409） */
    conflicts?: MechanismConflict[];
    [k: string]: unknown;
  };
}

export interface MechanismConflict { objectId: string; objectName: string; mechanismId: string; mechanismName: string }

export interface MechanismSheetData {
  songs: { id: string; name: string; code: string | null; order: number; cues: { id: string; name: string; order: number; videoTimeSec: number | null; crossfadeSeconds: number }[] }[];
  positions: CueMechanismPosition[];
  mechanisms: Mechanism[];
}

export interface ConvertResult {
  ok: true;
  dryRun?: boolean;
  /** 轉成機關位置的 cue 數 */
  converted: number;
  /** 沒轉的 cue（name = 「歌名 · cue 名」） */
  skipped: { cueId: string; name: string; reason: 'inconsistent' | 'range' }[];
  positions: number;
  rowsChanged: number;
}

const enc = encodeURIComponent;
const base = (projectId: string) => `/api/projects/${enc(projectId)}`;

async function toError(resp: Response): Promise<MechanismApiError> {
  let data: MechanismApiError['data'] = {};
  try { data = await resp.json(); } catch { /* 不是 JSON */ }
  const e = new Error(data?.error || `HTTP ${resp.status}`) as MechanismApiError;
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
      // 409（物件已經在別的機關）是要問使用者的，不算存檔失敗
      if ((e as MechanismApiError).status !== 409) saveStatus.fail(e instanceof Error ? e.message : String(e));
    }
    throw e;
  }
}

// ─── 讀回來的資料：補預設值（後台舊版 / 壞資料不會讓畫面掛掉） ───

const finite = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
function vec(v: unknown, fb: MechVec3): MechVec3 {
  const o = v as Partial<MechVec3> | null;
  return o && typeof o === 'object' ? { x: finite(o.x, fb.x), y: finite(o.y, fb.y), z: finite(o.z, fb.z) } : fb;
}

export function parseMechanism(raw: unknown): Mechanism {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kind = r.kind === 'rotary' ? 'rotary' : 'linear';
  const travelMin = finite(r.travelMin, 0);
  const travelMax = Math.max(finite(r.travelMax, travelMin + 1), travelMin + 1e-6);
  const presets: MechanismPreset[] = Array.isArray(r.presets)
    ? (r.presets as unknown[])
      .map(p => p as Partial<MechanismPreset>)
      .filter(p => p && typeof p.name === 'string' && typeof p.value === 'number' && Number.isFinite(p.value))
      .map(p => ({ name: p.name as string, value: p.value as number }))
      .sort((a, b) => a.value - b.value)
    : [];
  return {
    id: String(r.id ?? ''),
    name: typeof r.name === 'string' ? r.name : '',
    kind,
    axis: vec(r.axis, { x: 0, y: 1, z: 0 }),
    pivot: kind === 'rotary' ? vec(r.pivot, { x: 0, y: 0, z: 0 }) : null,
    travelMin,
    travelMax,
    defaultValue: finite(r.defaultValue, 0),
    maxSpeed: typeof r.maxSpeed === 'number' && r.maxSpeed > 0 ? r.maxSpeed : null,
    presets,
    parentId: typeof r.parentId === 'string' && r.parentId ? r.parentId : null,
    objectIds: Array.isArray(r.objectIds) ? (r.objectIds as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    consoleLabel: typeof r.consoleLabel === 'string' && r.consoleLabel ? r.consoleLabel : null,
    order: finite(r.order, 0),
    metadata: r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata) ? r.metadata as Record<string, unknown> : null,
    cueCount: finite(r.cueCount, 0),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
  };
}

/** 延遲 / 走幾秒：舊後台沒有這兩欄 → null（跟著 cue） */
const secOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export function parsePositions(raw: unknown): CueMechanismPosition[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(p => p as Partial<CueMechanismPosition>)
    .filter(p => p && typeof p.cueId === 'string' && typeof p.mechanismId === 'string' && typeof p.value === 'number' && Number.isFinite(p.value))
    .map(p => ({
      cueId: p.cueId!, mechanismId: p.mechanismId!, value: p.value!,
      delaySec: secOrNull(p.delaySec), durationSec: secOrNull(p.durationSec),
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : '',
    }));
}

export const parseMechanisms = (raw: unknown): Mechanism[] => (Array.isArray(raw) ? raw.map(parseMechanism) : []);

// ─── 機關 ───

export async function listMechanisms(projectId: string): Promise<Mechanism[]> {
  const d = await call<{ mechanisms: unknown }>(`${base(projectId)}/mechanisms`);
  return parseMechanisms(d.mechanisms);
}

export type MechanismPayload = Partial<MechanismInput> & { moveObjects?: boolean };

/** 新增；物件已經在別的機關 → 丟 409（data.conflicts），問使用者後帶 moveObjects: true 再送 */
export async function createMechanism(projectId: string, input: MechanismPayload): Promise<Mechanism> {
  const d = await call<{ mechanism: unknown }>(`${base(projectId)}/mechanisms`, { method: 'POST', body: JSON.stringify(input) });
  return parseMechanism(d.mechanism);
}

/** 修改（只送要改的）；outOfRangeCount = 有幾個 cue 存的位置超出新的行程 */
export async function updateMechanism(projectId: string, mechId: string, patch: MechanismPayload): Promise<{ mechanism: Mechanism; outOfRangeCount: number }> {
  const d = await call<{ mechanism: unknown; outOfRangeCount?: number }>(`${base(projectId)}/mechanisms/${enc(mechId)}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
  return { mechanism: parseMechanism(d.mechanism), outOfRangeCount: finite(d.outOfRangeCount, 0) };
}

export async function deleteMechanism(projectId: string, mechId: string): Promise<{ removedPositions: number }> {
  const d = await call<{ removedPositions?: number }>(`${base(projectId)}/mechanisms/${enc(mechId)}`, { method: 'DELETE' });
  return { removedPositions: finite(d.removedPositions, 0) };
}

export async function reorderMechanisms(projectId: string, ids: string[]): Promise<void> {
  await call(`${base(projectId)}/mechanisms/reorder`, { method: 'POST', body: JSON.stringify({ ids }) });
}

// ─── 每個 cue 的位置 ───

export async function listSongPositions(projectId: string, songId: string): Promise<CueMechanismPosition[]> {
  const d = await call<{ positions: unknown }>(`${base(projectId)}/songs/${enc(songId)}/mechanism-positions`);
  return parsePositions(d.positions);
}

/** 存這個 cue 的位置；後台夾進行程，回傳存的值 */
export async function setCuePosition(projectId: string, songId: string, cueId: string, mechId: string, value: number): Promise<{ value: number; clamped: boolean }> {
  const d = await call<{ value: number; clamped?: boolean }>(
    `${base(projectId)}/songs/${enc(songId)}/cues/${enc(cueId)}/mechanisms/${enc(mechId)}`,
    { method: 'PUT', body: JSON.stringify({ value }) },
  );
  return { value: finite(d.value, value), clamped: !!d.clamped };
}

/**
 * 存這個 cue 這個機關的延遲 / 走幾秒（null = 跟著 cue；沒放的欄位不改）。
 * 這個 cue 還沒有自己的位置 → 一定要一起給 value（沿用來的值），不然後台 400
 */
export async function setCueTiming(
  projectId: string, songId: string, cueId: string, mechId: string,
  timing: { delaySec?: number | null; durationSec?: number | null; value?: number },
): Promise<{ value: number; delaySec: number | null; durationSec: number | null }> {
  const d = await call<{ value: number; delaySec?: unknown; durationSec?: unknown }>(
    `${base(projectId)}/songs/${enc(songId)}/cues/${enc(cueId)}/mechanisms/${enc(mechId)}`,
    { method: 'PUT', body: JSON.stringify(timing) },
  );
  return { value: finite(d.value, timing.value ?? 0), delaySec: secOrNull(d.delaySec), durationSec: secOrNull(d.durationSec) };
}

/** 回到沿用上一個 cue */
export async function clearCuePosition(projectId: string, songId: string, cueId: string, mechId: string): Promise<void> {
  await call(`${base(projectId)}/songs/${enc(songId)}/cues/${enc(cueId)}/mechanisms/${enc(mechId)}`, { method: 'DELETE' });
}

/**
 * 「從目前 3D 狀態建立 cue」時一起存機關現在的值（後台 POST …/cues 收 snapshotMechanisms）。
 * api.ts 的 createCue 型別還沒有這個欄位（之後清理時再加），先在這裡包一層
 */
export function withMechanismSnapshot<T extends object>(input: T, values: MechanismValues | null | undefined): T {
  return values && Object.keys(values).length > 0 ? ({ ...input, snapshotMechanisms: values } as T) : input;
}

// ─── 機關總表 / 轉換 ───

export async function getMechanismSheet(projectId: string): Promise<MechanismSheetData> {
  const d = await call<{ songs?: MechanismSheetData['songs']; positions?: unknown; mechanisms?: unknown }>(`${base(projectId)}/mechanism-sheet`);
  return {
    songs: Array.isArray(d.songs) ? d.songs : [],
    positions: parsePositions(d.positions),
    mechanisms: parseMechanisms(d.mechanisms),
  };
}

/** 把現有 cue 的位置轉成這個機關的位置；dryRun = 只看會轉幾個 */
export function convertCuePositions(projectId: string, mechId: string, dryRun: boolean): Promise<ConvertResult> {
  return call(`${base(projectId)}/mechanisms/${enc(mechId)}/convert-cue-positions`, { method: 'POST', body: JSON.stringify({ dryRun }) });
}

// ─── 分享連結（不用登入，只看正式 cue） ───

function shareApiPath(ref: ShareRef): string {
  return ref.kind === 'slug' ? `/api/s/${enc(ref.key)}` : `/api/share/${enc(ref.key)}`;
}

export async function getShareSongPositions(ref: ShareRef, songId: string, access?: string): Promise<CueMechanismPosition[]> {
  const resp = await fetch(`${apiBase()}${shareApiPath(ref)}/songs/${enc(songId)}/mechanism-positions`, {
    headers: access ? { 'x-share-access': access } : {},
  });
  if (!resp.ok) throw await toError(resp);
  const d = await resp.json() as { positions?: unknown };
  return parsePositions(d.positions);
}
