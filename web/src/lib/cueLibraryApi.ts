// Cue 庫的前端呼叫 — 對應 cf-worker/cueLibraryCrud.mjs（規格 docs/superpowers/specs/2026-10-22-cue-library-design.md 4.1、4.2；第 10 節）
// 只有 Cue 庫模式的專案（project.cueLibrary === true）能用；舊模式專案後台回 400「這個專案還沒有 Cue 庫」。
// 權限（後台會檢查）：看 = 專案成員；改 = 這個專案的製作（導演 / 動畫師 403）。
// 編號（label）是用戶自己打的文字（最多 16 個字、同專案不能重複）；每個 cue 是獨立快照，沒有「沿用」。

import { apiBase, getSessionToken, type CueState } from './api';
import { saveStatus } from './saveStatus';

/** 後台回的錯誤：message 是中文、可以直接顯示；status 409 = 編號重複 / 時間重複 / rev 過期 / 還有歌在用 */
export interface CueLibraryApiError extends Error {
  status: number;
  data: {
    error?: string;
    /** 畫面被別人改過（409）：目前的 rev */
    rev?: number;
    /** 還有歌在用、刪不掉（409） */
    usage?: LibraryCueUsage;
    [k: string]: unknown;
  };
}

/** 哪一首歌的哪一個 slot 在用 */
export interface LibraryCueUsageSlot {
  cueId: string;
  songId: string;
  songName: string;
  songCode: string | null;
  videoTimeSec: number | null;
}
export interface LibraryCueUsage { songCount: number; slotCount: number; slots: LibraryCueUsageSlot[] }

export interface LibraryCue {
  id: string;
  /** 編號：用戶打的文字（「12」「3-1」） */
  label: string;
  name: string;
  note: string;
  /** 另存的來源（只記錄） */
  basedOnId: string | null;
  /** 畫面每改一次 +1；更新畫面時帶 ifRev 防止兩個人同時改 */
  rev: number;
  createdAt: string;
  updatedAt: string;
  usage: LibraryCueUsage;
  counts: { objects: number; mechanisms: number };
}

export type LookOwnField = 'position' | 'rotation' | 'scale' | 'visible' | 'customProps';
type Vec3 = { x: number; y: number; z: number };
type Euler = { pitch: number; yaw: number; roll: number };

/** 畫面裡的一個物件（沒有列 = 預設位置；欄位 null = 那個欄位用預設） */
export interface LookObjectRow {
  objectId: string;
  position: Vec3 | null;
  rotation: Euler | null;
  scale: Vec3 | null;
  visible: boolean | null;
  customProps: Record<string, unknown> | null;
  own: boolean;
  ownFields: LookOwnField[];
}
/** 畫面裡的一個機關（carried = 位置算畫面的一部分，但不打斷正在往這裡走的機器；有 carried 時不能有時間） */
export interface LookMechRow {
  mechanismId: string;
  value: number;
  delaySec: number | null;
  durationSec: number | null;
  carried: boolean;
}
export interface Look { objects: LookObjectRow[]; mechanisms: LookMechRow[] }
export interface LookWithRev extends Look { rev: number; updatedAt: string }

/** 這首歌的一個 cue（slot）；libraryCue = 它指到的 Cue 庫的 cue */
export interface LibrarySlot {
  id: string;
  songId: string;
  name: string;
  order: number;
  crossfadeSeconds: number;
  videoTimeSec: number | null;
  status: 'master' | 'proposal' | 'alternate';
  libraryCueId: string | null;
  libraryCue: { id: string; label: string; name: string } | null;
}
/** 加 / 改時間之後，這首歌所有 cue 的新順序 */
export type SlotOrder = { id: string; order: number }[];

/** 另存時放到哪裡：換掉這首歌的某個 cue，或在這首歌加一個 cue */
export type SaveAsPlace =
  | { songId: string; replaceCueId: string }
  | { songId: string; videoTimeSec: number | null; crossfadeSeconds?: number };

export interface CreateLibraryCueInput {
  /** 沒給 = 用建議編號（現有最大的開頭整數 + 1） */
  label?: string;
  /** 沒給 = 用來源的名稱（沒有來源就一定要給） */
  name?: string;
  note?: string;
  /** 另存的來源；沒給 look 時原樣複製來源的畫面 */
  basedOnId?: string;
  look?: Look;
  place?: SaveAsPlace;
}

const enc = encodeURIComponent;
const base = (projectId: string) => `/api/projects/${enc(projectId)}`;
const libPath = (projectId: string, lcId?: string) => `${base(projectId)}/library-cues${lcId ? `/${enc(lcId)}` : ''}`;
const songCues = (projectId: string, songId: string) => `${base(projectId)}/songs/${enc(songId)}/cues`;

async function toError(resp: Response): Promise<CueLibraryApiError> {
  let data: CueLibraryApiError['data'] = {};
  try { data = await resp.json(); } catch { /* 不是 JSON */ }
  const e = new Error(data?.error || `HTTP ${resp.status}`) as CueLibraryApiError;
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
      // 409（編號重複、時間重複、被別人改過、還有歌在用）是要問使用者的，不算存檔失敗
      if ((e as CueLibraryApiError).status !== 409) saveStatus.fail(e instanceof Error ? e.message : String(e));
    }
    throw e;
  }
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

// ───────── Cue 庫的 cue ─────────

/** 專案所有 Cue 庫的 cue（後台照編號排：1, 2, 2.5, 3-1, 12） */
export async function listLibraryCues(projectId: string): Promise<LibraryCue[]> {
  return (await call<{ libraryCues: LibraryCue[] }>(libPath(projectId))).libraryCues;
}

export async function getLibraryCue(projectId: string, lcId: string): Promise<LibraryCue> {
  return (await call<{ libraryCue: LibraryCue }>(libPath(projectId, lcId))).libraryCue;
}

/**
 * 新增 / 另存 / 複製。place 有給時一起放進這首歌（換掉某個 cue 或加一個），全部成功或全部沒動。
 * 回 { libraryCue, slot?, order? }；slot / order 只有帶 place 才有
 */
export async function createLibraryCue(projectId: string, input: CreateLibraryCueInput):
  Promise<{ libraryCue: LibraryCue; slot?: LibrarySlot; order?: SlotOrder }> {
  return call(libPath(projectId), json('POST', input));
}

/** 改名稱 / 編號 / 備註（編號重複 409「這個編號已經有了」） */
export async function updateLibraryCue(projectId: string, lcId: string, patch: { name?: string; label?: string; note?: string }): Promise<LibraryCue> {
  return (await call<{ libraryCue: LibraryCue }>(libPath(projectId, lcId), json('PATCH', patch))).libraryCue;
}

/** 刪除；還有歌在用 → 409，error.data.usage 列出在用的歌 */
export async function deleteLibraryCue(projectId: string, lcId: string): Promise<void> {
  await call<{ ok: true }>(libPath(projectId, lcId), { method: 'DELETE' });
}

/** 誰在用（哪幾首歌的哪幾個 cue） */
export async function getLibraryCueUsage(projectId: string, lcId: string): Promise<LibraryCueUsage> {
  return (await call<{ usage: LibraryCueUsage }>(`${libPath(projectId, lcId)}/usage`)).usage;
}

/** 畫面的原始列（草稿 / 另存 / 復原用） */
export async function getLibraryLook(projectId: string, lcId: string): Promise<LookWithRev> {
  return call<LookWithRev>(`${libPath(projectId, lcId)}/look`);
}

/**
 * 整個畫面一次換掉（更新 / 復原 / 全部回到預設）。ifRev 是讀畫面時拿到的 rev：
 * 這中間被別人改過 → 409（error.data.rev 是目前的 rev），這次什麼都不會寫。
 * 回新的 rev 和換掉之前的畫面（previous，復原用）
 */
export async function putLibraryLook(projectId: string, lcId: string, look: Look, ifRev?: number): Promise<{ rev: number; previous: Look }> {
  return call(`${libPath(projectId, lcId)}/look`, json('PUT', { ...(ifRev === undefined ? {} : { ifRev }), objects: look.objects, mechanisms: look.mechanisms }));
}

/** 這個 Cue 庫的 cue 算好的每個物件狀態（跟 cue 的物件狀態同一個格式） */
export async function getLibraryStates(projectId: string, lcId: string): Promise<CueState[]> {
  return (await call<{ states: CueState[] }>(`${libPath(projectId, lcId)}/states`)).states;
}

// ───────── 這首歌的 cue（slot） ─────────

/** 這首歌加一個指到 Cue 庫的 cue 的 cue（時間重複 409「這首歌 1:23 已經有 cue 了」）；回新的 cue 和這首歌新的順序 */
export async function addSongSlot(projectId: string, songId: string, input: { libraryCueId: string; videoTimeSec?: number | null; crossfadeSeconds?: number }):
  Promise<{ slot: LibrarySlot; order: SlotOrder }> {
  return call(songCues(projectId, songId), json('POST', input));
}

/** 換指向 / 改時間（照時間重排）；也可以同時改 name、crossfadeSeconds。回新的 cue；改時間時多一個新順序 */
export async function updateSongSlot(projectId: string, songId: string, cueId: string, patch: { libraryCueId?: string; videoTimeSec?: number | null; name?: string; crossfadeSeconds?: number }):
  Promise<{ ok: true; slot?: LibrarySlot; order?: SlotOrder }> {
  return call(`${songCues(projectId, songId)}/${enc(cueId)}`, json('PATCH', patch));
}

/** 從這首歌拿掉一個 cue（Cue 庫的 cue 不會被刪） */
export async function removeSongSlot(projectId: string, songId: string, cueId: string): Promise<void> {
  await call<{ ok: true }>(`${songCues(projectId, songId)}/${enc(cueId)}`, { method: 'DELETE' });
}
