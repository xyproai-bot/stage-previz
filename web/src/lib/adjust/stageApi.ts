// 調整舞台第 3 段：存起來的前端呼叫 — 對應 cf-worker/cueLibraryStage.mjs
// 權限（後台會檢查）：導演、這個專案的製作、全站製作；動畫師 403。每一條後台都只收下面列的欄位，多送別的 = 400。
// 跟 cueLibraryApi.ts 分開：那份是製作用的（改整個畫面、編號、刪除…），這份是導演用的（只能動機關位置、名字、轉場秒數）。

import { apiBase, getSessionToken } from '../api';
import { saveStatus } from '../saveStatus';

/** 一個機關在 Cue 庫的 cue 裡的位置（整份換掉時，沒改的也要原樣帶回去） */
export interface StageMechRow {
  mechanismId: string;
  value: number;
  delaySec: number | null;
  durationSec: number | null;
  /** 沿用：位置算畫面的一部分，但不打斷正在往這裡走的機器；有 carried 時不能有時間 */
  carried: boolean;
}

export interface StageSong { id: string; name: string; code: string | null }

/** 後台回的錯誤：message 是中文、可以直接顯示；409 + conflict = 剛剛被別人改過 */
export interface StageApiError extends Error {
  status: number;
  data: {
    error?: string;
    /** 409：這個 cue 剛剛被別人改過 */
    conflict?: boolean;
    /** 409：現在的版本 */
    rev?: number | null;
    /** 409：最後改的人（不知道 = null） */
    changedBy?: { id: string; name: string } | null;
    field?: string;
    [k: string]: unknown;
  };
}

export interface SaveBackResult {
  ok: true;
  /** 跟現在存的一樣，沒有東西要存 */
  unchanged?: boolean;
  /** 存完的新版本 */
  rev: number;
  /** 存之前的樣子（復原 = 用這個再存一次） */
  previous?: { rev: number; mechanisms: StageMechRow[] };
  /** 用到這個 cue 的歌（會一起變的） */
  songs: StageSong[];
  /** 幾個機關不一樣 */
  changed: number;
  notified: number;
}

export interface SaveAsResult {
  libraryCue: { id: string; label: string; name: string; basedOnId: string | null; rev: number; crossfadeSeconds: number };
  slot: { id: string; songId: string; libraryCueId: string };
  song: StageSong;
  notified: number;
}

export interface CopyResult {
  libraryCue: { id: string; label: string; name: string; basedOnId: string | null; rev: number; crossfadeSeconds: number };
}

const enc = encodeURIComponent;
const libPath = (projectId: string, lcId: string) => `/api/projects/${enc(projectId)}/library-cues/${enc(lcId)}`;

async function toError(resp: Response): Promise<StageApiError> {
  let data: StageApiError['data'] = {};
  try { data = await resp.json(); } catch { /* 不是 JSON */ }
  const e = new Error(data?.error || `HTTP ${resp.status}`) as StageApiError;
  e.status = resp.status;
  e.data = data || {};
  return e;
}

async function call<T>(path: string, method: string, body: unknown): Promise<T> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = getSessionToken();
  if (token) h.Authorization = `Bearer ${token}`;
  saveStatus.saving();
  try {
    const resp = await fetch(apiBase() + path, { method, credentials: 'include', headers: h, body: JSON.stringify(body) });
    if (!resp.ok) throw await toError(resp);
    const out = await resp.json() as T;
    saveStatus.done();
    return out;
  } catch (e) {
    saveStatus.done();
    // 409（被別人改過、這首歌的 cue 換掉了）是要問使用者的，不算存檔失敗
    if ((e as StageApiError).status !== 409) saveStatus.fail(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** 後台說「剛剛被別人改過」（版本對不上） */
export function isStageConflict(e: unknown): e is StageApiError {
  const x = e as StageApiError | null;
  return !!x && x.status === 409 && x.data?.conflict === true;
}

/**
 * 存回 Cue 庫：只換這個 cue 的機關位置（整份）。ifRev = 拿到這些位置的時候這個 cue 的版本，
 * 這中間被別人改過 → 409（isStageConflict）。songId = 導演現在看的歌（通知點開哪一首）。undo = 這次是復原
 */
export function saveStagePositions(projectId: string, lcId: string, body: { ifRev: number; mechanisms: StageMechRow[]; songId?: string; undo?: boolean }): Promise<SaveBackResult> {
  return call(`${libPath(projectId, lcId)}/mechanism-positions`, 'PUT', body);
}

/** 另存成新 cue：編號自動給下一個，物件設定照抄，只把這首歌的這個 cue 換成新的 */
export function saveStageAs(projectId: string, lcId: string, body: { name?: string; mechanisms: StageMechRow[]; songId: string; cueId: string }): Promise<SaveAsResult> {
  return call(`${libPath(projectId, lcId)}/stage-save-as`, 'POST', body);
}

/** 複製：放進 Cue 庫的新 cue（還沒放進任何歌） */
export function copyStageCue(projectId: string, lcId: string, body: { name?: string }): Promise<CopyResult> {
  return call(`${libPath(projectId, lcId)}/stage-copy`, 'POST', body);
}

/** 改名（編號不動）/ 改 Cue 庫的轉場秒數（用到的歌一起變）；songId = 通知點開哪一首 */
export function patchStageCue(projectId: string, lcId: string, body: { name?: string; crossfadeSeconds?: number; songId?: string }): Promise<{ libraryCue: { id: string; label: string; name: string; crossfadeSeconds: number }; notified: number }> {
  return call(`${libPath(projectId, lcId)}/stage`, 'PATCH', body);
}

/** 改「這首歌的這個 cue 自己設的」轉場秒數（沒另外設的後台會擋，要改 Cue 庫的） */
export function setSlotStageCrossfade(projectId: string, songId: string, cueId: string, crossfadeSeconds: number): Promise<{ ok: true; notified: number }> {
  return call(`/api/projects/${enc(projectId)}/songs/${enc(songId)}/cues/${enc(cueId)}/stage-crossfade`, 'PUT', { crossfadeSeconds });
}
