// 機關的前端呼叫 — 對應 cf-worker/mechanisms.mjs；完整說明（每個網址、回傳格式、錯誤碼）：docs/mechanisms-api.md
// 跟 api.ts 分開（像 videoApi.ts）：別的頁面正在改 api.ts，這裡自己一份。
//
// 權限（後台會檢查，畫面只是先擋）：看 = 專案成員；改 = 這個專案的製作（導演 / 動畫師 403）

import { apiBase, getSessionToken, type ShareRef } from '../api';
import { saveStatus } from '../saveStatus';
import type {
  CueMechanismPosition, GroupNumbering, Mechanism, MechanismGroup, MechanismGroupSettings, MechanismInput, MechanismMirror,
  MechanismPreset, MechanismSide, MechanismValues, MechVec3,
} from './model';
import type { BulkPositionItem } from './group';
import type { PositionsMode } from './track';
import type { SheetSong } from './cueSheet';

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
  songs: SheetSong[];
  positions: CueMechanismPosition[];
  mechanisms: Mechanism[];
  /** 後台說的模式；舊後台沒回 = legacy */
  mode?: PositionsMode;
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
/**
 * 機關 v2 起，讀機關和位置的網址要帶這個：新版畫面看得懂的機關，後台才給。
 *   沒帶（最舊的前端）→ 只給一般機關；?mech=2（第 2、3 階段的畫面，看得懂對開）→ 一般 + 對開；
 *   ?mech=3（第 4 階段：看得懂吊掛）→ 全部。吊掛的零件在舊畫面是靜止的，不會往錯的方向動
 */
export const MECH_V2 = 'mech=3';
/** 告訴後台「我看得懂 Cue 庫模式」；沒帶的舊前端後台照舊給它看得懂的資料 */
export const CUE_LIB = 'cuelib=1';

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
  const objectIds = Array.isArray(r.objectIds) ? (r.objectIds as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const axis = vec(r.axis, { x: 0, y: 1, z: 0 });
  // 對開（v2）：舊後台沒有這三欄 → 一般機關；B 邊的方向壞掉 → 直線用反方向、旋轉當一般機關
  const mraw = (r.mirror && typeof r.mirror === 'object' ? r.mirror : null) as Record<string, unknown> | null;
  let variant: Mechanism['variant'] = r.variant === 'split' ? 'split' : null;
  let mirror: MechanismMirror | null = null;
  if (variant === 'split') {
    if (mraw) {
      mirror = {
        axis: vec(mraw.axis, { x: -axis.x || 0, y: -axis.y || 0, z: -axis.z || 0 }),
        pivot: kind === 'rotary' ? vec(mraw.pivot, { x: 0, y: 0, z: 0 }) : null,
        consoleLabel: typeof mraw.consoleLabel === 'string' && mraw.consoleLabel ? mraw.consoleLabel : null,
      };
    } else if (kind === 'linear') {
      mirror = { axis: { x: -axis.x || 0, y: -axis.y || 0, z: -axis.z || 0 }, pivot: null, consoleLabel: null };
    } else variant = null;
  }
  const sidesRaw = (r.objectSides && typeof r.objectSides === 'object' ? r.objectSides : {}) as Record<string, unknown>;
  const objectSides: Record<string, MechanismSide> = {};
  if (variant === 'split') for (const id of objectIds) objectSides[id] = sidesRaw[id] === 'b' ? 'b' : 'a';
  // 吊掛（v2 第 4 階段）：整組沒有位置；吊點要有所屬的整組和位置，不然當一般機關（沒有物件，不會動到任何東西）
  const attachRaw = r.attach && typeof r.attach === 'object' ? r.attach as Partial<MechVec3> : null;
  const attach = attachRaw && [attachRaw.x, attachRaw.y, attachRaw.z].every(c => typeof c === 'number' && Number.isFinite(c))
    ? { x: attachRaw.x as number, y: attachRaw.y as number, z: attachRaw.z as number } : null;
  if (r.variant === 'hoist_rig') variant = 'hoist_rig';
  else if (r.variant === 'hoist' && attach && typeof r.rigId === 'string' && r.rigId) variant = 'hoist';
  return {
    id: String(r.id ?? ''),
    name: typeof r.name === 'string' ? r.name : '',
    kind,
    axis,
    pivot: kind === 'rotary' ? vec(r.pivot, { x: 0, y: 0, z: 0 }) : null,
    travelMin,
    travelMax,
    defaultValue: finite(r.defaultValue, 0),
    maxSpeed: typeof r.maxSpeed === 'number' && r.maxSpeed > 0 ? r.maxSpeed : null,
    presets,
    parentId: typeof r.parentId === 'string' && r.parentId ? r.parentId : null,
    objectIds,
    consoleLabel: typeof r.consoleLabel === 'string' && r.consoleLabel ? r.consoleLabel : null,
    order: finite(r.order, 0),
    metadata: r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata) ? r.metadata as Record<string, unknown> : null,
    cueCount: finite(r.cueCount, 0),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
    variant,
    mirror,
    objectSides,
    // 一排（v2 第 3 階段）：舊後台沒有這兩欄 → 不在任何一排裡
    groupId: typeof r.groupId === 'string' && r.groupId ? r.groupId : null,
    groupIndex: typeof r.groupIndex === 'number' && Number.isFinite(r.groupIndex) ? r.groupIndex : null,
    rigId: variant === 'hoist' ? String(r.rigId) : null,
    rigIndex: variant === 'hoist' && typeof r.rigIndex === 'number' && Number.isFinite(r.rigIndex) ? r.rigIndex : null,
    attach: variant === 'hoist' ? attach : null,
  };
}

const NUMBERINGS: GroupNumbering[] = ['leftToRight', 'rightToLeft', 'frontToBack', 'selection'];

export function parseGroup(raw: unknown): MechanismGroup {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const st = (r.settings && typeof r.settings === 'object' ? r.settings : null) as Record<string, unknown> | null;
  const settings: MechanismGroupSettings = {};
  if (st && typeof st.namePrefix === 'string' && st.namePrefix) settings.namePrefix = st.namePrefix;
  if (st && NUMBERINGS.includes(st.numbering as GroupNumbering)) settings.numbering = st.numbering as GroupNumbering;
  return {
    id: String(r.id ?? ''),
    name: typeof r.name === 'string' ? r.name : '',
    order: finite(r.order, 0),
    settings: Object.keys(settings).length ? settings : null,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
  };
}
export const parseGroups = (raw: unknown): MechanismGroup[] => (Array.isArray(raw) ? raw.map(parseGroup).filter(g => g.id) : []);

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
      ...(p.carried === true ? { carried: true } : {}),
      ...(typeof p.libraryCueId === 'string' ? { libraryCueId: p.libraryCueId } : {}),
    }));
}

export const parseMechanisms = (raw: unknown): Mechanism[] => (Array.isArray(raw) ? raw.map(parseMechanism) : []);

// ─── 機關 ───

export async function listMechanisms(projectId: string): Promise<Mechanism[]> {
  return (await listMechanismsAndGroups(projectId)).mechanisms;
}

/** 管理頁用：機關 + 一排一排的分組（舊後台沒有 groups → 空的） */
export async function listMechanismsAndGroups(projectId: string): Promise<{ mechanisms: Mechanism[]; groups: MechanismGroup[] }> {
  const d = await call<{ mechanisms: unknown; groups?: unknown }>(`${base(projectId)}/mechanisms?${MECH_V2}`);
  return { mechanisms: parseMechanisms(d.mechanisms), groups: parseGroups(d.groups) };
}

/** 一個吊點要送的內容（見 hoistRig.ts；有 id = 改原本的吊點，沒有 = 新增） */
export interface HoistPayload {
  id?: string;
  name?: string;
  attach: MechVec3;
  travelMin?: number;
  travelMax?: number;
  maxSpeed?: number | null;
  consoleLabel?: string | null;
  defaultValue?: number;
  presets?: MechanismPreset[];
}

/** 新增 / 修改整組吊掛時多一個 hoists（整個換成這份清單；沒送 = 吊點不動） */
export type MechanismPayload = Partial<MechanismInput> & { moveObjects?: boolean; hoists?: HoistPayload[] };

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

// ─── 一排機關（v2 第 3 階段） ───

/** 一次建立 N 個機關的內容（跟後台 POST …/mechanisms/batch 一樣；見 docs/mechanisms-api.md） */
export interface BatchPayload {
  /** 每個機關共用的設定（方向、行程、最高速度、常用位置、預設位置、metadata…） */
  base: Partial<MechanismInput>;
  /** 一個物件一個機關，照這個順序編 1、2、3… */
  objectIds: string[];
  namePrefix: string;
  groupName?: string;
  numbering?: GroupNumbering;
  /** 每個物件自己的轉軸（沿著邊緣翻要照每個物件自己的外框算） */
  overrides?: Record<string, { axis?: MechVec3; pivot?: MechVec3 }>;
  moveObjects?: boolean;
}

/** 一次建立；物件已經在別的機關 → 丟 409（data.conflicts），問使用者後帶 moveObjects: true 再送 */
export async function createMechanismBatch(projectId: string, input: BatchPayload): Promise<{ group: MechanismGroup; mechanisms: Mechanism[] }> {
  const d = await call<{ group: unknown; mechanisms: unknown }>(`${base(projectId)}/mechanisms/batch`, { method: 'POST', body: JSON.stringify(input) });
  return { group: parseGroup(d.group), mechanisms: parseMechanisms(d.mechanisms) };
}

/** 這一排的共用設定（改一次、每個成員都改）：name / travelMin / travelMax / defaultValue / maxSpeed / presets */
export type GroupPatch = Partial<Pick<MechanismInput, 'travelMin' | 'travelMax' | 'defaultValue' | 'maxSpeed' | 'presets'>> & { name?: string };

export async function updateMechanismGroup(projectId: string, groupId: string, patch: GroupPatch): Promise<{ group: MechanismGroup; mechanisms: Mechanism[]; outOfRangeCount: number }> {
  const d = await call<{ group: unknown; mechanisms: unknown; outOfRangeCount?: number }>(
    `${base(projectId)}/mechanism-groups/${enc(groupId)}`, { method: 'PATCH', body: JSON.stringify(patch) },
  );
  return { group: parseGroup(d.group), mechanisms: parseMechanisms(d.mechanisms), outOfRangeCount: finite(d.outOfRangeCount, 0) };
}

/** dissolve = 只解散這一排（機關都留著）；沒帶 = 這一排和裡面的機關一起刪掉 */
export async function deleteMechanismGroup(projectId: string, groupId: string, dissolve: boolean): Promise<{ removedMechanisms: number; removedPositions: number }> {
  const d = await call<{ removedMechanisms?: number; removedPositions?: number; mechanisms?: number }>(
    `${base(projectId)}/mechanism-groups/${enc(groupId)}${dissolve ? '?dissolve=1' : ''}`, { method: 'DELETE' },
  );
  return { removedMechanisms: finite(d.removedMechanisms, 0), removedPositions: finite(d.removedPositions, 0) };
}

/** 一次寫很多個機關在這個 cue 的位置和時間（套用花樣 / 復原）；value = null → 回到沿用 */
export interface BulkResultItem { mechanismId: string; removed?: boolean; value?: number; clamped?: boolean; delaySec?: number | null; durationSec?: number | null }
export async function setCuePositionsBulk(projectId: string, songId: string, cueId: string, items: BulkPositionItem[]): Promise<BulkResultItem[]> {
  const d = await call<{ items?: unknown }>(
    `${base(projectId)}/songs/${enc(songId)}/cues/${enc(cueId)}/mechanism-positions`,
    { method: 'PUT', body: JSON.stringify({ items }) },
  );
  return (Array.isArray(d.items) ? d.items : []).map(x => {
    const r = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const id = String(r.mechanismId ?? '');
    if (r.removed === true) return { mechanismId: id, removed: true };
    return { mechanismId: id, value: finite(r.value, 0), clamped: r.clamped === true, delaySec: secOrNull(r.delaySec), durationSec: secOrNull(r.durationSec) };
  });
}

// ─── 每個 cue 的位置 ───

const parseMode = (m: unknown): PositionsMode => (m === 'library' ? 'library' : 'legacy');
export interface SongPositions { mode: PositionsMode; positions: CueMechanismPosition[] }

export async function listSongPositionsWithMode(projectId: string, songId: string): Promise<SongPositions> {
  const d = await call<{ mode?: unknown; positions: unknown }>(`${base(projectId)}/songs/${enc(songId)}/mechanism-positions?${MECH_V2}&${CUE_LIB}`);
  return { mode: parseMode(d.mode), positions: parsePositions(d.positions) };
}
export async function listSongPositions(projectId: string, songId: string): Promise<CueMechanismPosition[]> {
  return (await listSongPositionsWithMode(projectId, songId)).positions;
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
  const d = await call<{ mode?: unknown; songs?: MechanismSheetData['songs']; positions?: unknown; mechanisms?: unknown }>(`${base(projectId)}/mechanism-sheet?${MECH_V2}&${CUE_LIB}`);
  return {
    mode: parseMode(d.mode),
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
  return (await getShareSongPositionsWithMode(ref, songId, access)).positions;
}
export async function getShareSongPositionsWithMode(ref: ShareRef, songId: string, access?: string): Promise<SongPositions> {
  const resp = await fetch(`${apiBase()}${shareApiPath(ref)}/songs/${enc(songId)}/mechanism-positions?${MECH_V2}&${CUE_LIB}`, {
    headers: access ? { 'x-share-access': access } : {},
  });
  if (!resp.ok) throw await toError(resp);
  const d = await resp.json() as { mode?: unknown; positions?: unknown };
  return { mode: parseMode(d.mode), positions: parsePositions(d.positions) };
}
