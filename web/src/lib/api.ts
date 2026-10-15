// API client — 對接 cf-worker 在 proxy.haimiaan.com 的 endpoints

import type { Project, ProjectRole } from './mockData';
import { saveStatus } from './saveStatus';
import { normalizeLookSettings, type LookSettings } from './stageLook/lookSettings';
import { normalizeMaterialOverrides, type MaterialOverrides } from './stageLook/materialOverrides';
import { normalizeHomeView, type HomeView } from './homeView';
import { normalizeLedCanvas, type LedCanvas } from './ledCanvas';
import { normalizeStageProps, type StagePropItem } from './stageProps';
import type { ShareSongVideoFields, SongVideoFields } from './videoApi';
import type { SongReviewFields } from './reviewApi';
import { friendlyError } from './songReview';
import type { Annotation } from './review/annotations';

// 開發時可以用 localStorage 'stagepreviz-api-base' override
const DEFAULT_API_BASE = 'https://proxy.haimiaan.com';

export function apiBase(): string {
  if (typeof window !== 'undefined') {
    const override = window.localStorage.getItem('stagepreviz-api-base');
    if (override) return override;
  }
  return DEFAULT_API_BASE;
}

const TOKEN_STORAGE_KEY = 'sp_session_token';

export function getSessionToken(): string | null {
  try { return localStorage.getItem(TOKEN_STORAGE_KEY); } catch { return null; }
}
export function setSessionToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch { /* ignore quota/private */ }
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getSessionToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // 寫入操作（POST/PUT/PATCH/DELETE）→ 觸發 saveStatus
  const method = (init?.method || 'GET').toUpperCase();
  const isMutation = method !== 'GET' && method !== 'HEAD';
  if (isMutation) saveStatus.saving();
  try {
    const resp = await fetch(apiBase() + path, {
      credentials: 'include',  // 同 origin 時的 cookie 也會送
      ...init,
      headers,
    });
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      let errBody: Record<string, unknown> | undefined;
      try {
        const err = await resp.json();
        if (err && typeof err === 'object') errBody = err;
        if (err?.error) msg = err.error;
      } catch { /* ignore */ }
      // data = 後台回的整個錯誤內容（例如 409 時的 currentStatus / willDelete），畫面需要時可以讀
      const e: ApiError = new Error(msg);
      e.status = resp.status;
      e.data = errBody;
      // 後台回英文（例：Not found）或沒有說明時換成白話；中文的說明照原樣（songReview.ts friendlyError）
      e.message = friendlyError(e);
      throw e;
    }
    const result = await resp.json() as T;
    if (isMutation) saveStatus.done();
    return result;
  } catch (e) {
    if (isMutation) {
      saveStatus.done();
      saveStatus.fail(e instanceof Error ? e.message : String(e));
    }
    throw e;
  }
}

/** http() 丟出來的錯誤：status = HTTP 狀態碼；data = 後台回的整個錯誤內容 */
export type ApiError = Error & { status?: number; data?: Record<string, unknown> };

/** 錯誤的 HTTP 狀態碼（不是 API 錯誤 / 網路斷線 → undefined） */
export function errorStatus(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

// ─── Auth ───

export type UserRole = 'admin' | 'animator' | 'director';

export interface AuthUser {
  id: string;
  name: string;
  role: UserRole;
  avatarColor: string;
}

export async function authMe(): Promise<AuthUser | null> {
  try {
    const data = await http<{ user: AuthUser }>('/api/auth/me');
    return data.user;
  } catch (e) {
    if ((e as { status?: number }).status === 401) return null;
    throw e;
  }
}

export async function authLogin(accessCode: string): Promise<AuthUser> {
  const data = await http<{ user: AuthUser; token?: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ accessCode }),
  });
  if (data.token) setSessionToken(data.token);
  return data.user;
}

export async function authLogout(): Promise<void> {
  try { await http('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  setSessionToken(null);
}

// ─── Users (admin) ───

export interface UserProjectMembership {
  projectId: string;
  projectName: string;
  role: UserRole;
}

export interface UserAdmin {
  id: string;
  name: string;
  role: UserRole;
  avatarColor: string;
  /** 後台還是明文存法才有；雜湊存法 = null（只在建立 / 重設時拿得到一次） */
  accessCode: string | null;
  /** 有沒有登入碼（用邀請連結進來的人可能沒有）；舊版後台沒有這個欄位 */
  hasAccessCode?: boolean;
  deactivated: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  projects: UserProjectMembership[];
}

export async function listUsers(): Promise<UserAdmin[]> {
  const data = await http<{ users: UserAdmin[] }>('/api/users');
  return data.users;
}

export async function createUserAdmin(input: {
  name: string;
  role: UserRole;
  accessCode?: string;       // 留空就 server 自動產生
  avatarColor?: string;
  projectIds?: string[];
}): Promise<{ id: string; accessCode: string; shownOnce?: boolean }> {
  return http('/api/users', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateUserAdmin(id: string, patch: Partial<{
  name: string; role: UserRole; avatarColor: string; deactivated: boolean;
}>): Promise<void> {
  await http(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function setAccessCode(id: string, accessCode?: string): Promise<{ ok: true; accessCode: string; shownOnce?: boolean }> {
  return http(`/api/users/${encodeURIComponent(id)}/access-code`, {
    method: 'POST',
    body: JSON.stringify({ accessCode: accessCode ?? '' }),
  });
}

export async function deleteUserAdmin(id: string): Promise<void> {
  await http(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function addUserToProject(userId: string, projectId: string, role: UserRole): Promise<void> {
  await http(`/api/users/${encodeURIComponent(userId)}/projects`, {
    method: 'POST',
    body: JSON.stringify({ projectId, role }),
  });
}

export async function removeUserFromProject(userId: string, projectId: string): Promise<void> {
  await http(`/api/users/${encodeURIComponent(userId)}/projects`, {
    method: 'DELETE',
    body: JSON.stringify({ projectId }),
  });
}

// ─── Shows ───────────────────────────────────

export interface Show {
  id: string;
  name: string;
  description: string;
  projectCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ShowDetail extends Omit<Show, 'projectCount'> {
  projects: { id: string; name: string }[];
}

export async function listShows(): Promise<Show[]> {
  const data = await http<{ shows: Show[] }>('/api/shows');
  return data.shows;
}

export async function getShow(id: string): Promise<ShowDetail> {
  const data = await http<{ show: ShowDetail }>(`/api/shows/${encodeURIComponent(id)}`);
  return data.show;
}

export async function createShow(input: { name: string; description: string }): Promise<{ id: string }> {
  return http(`/api/shows`, { method: 'POST', body: JSON.stringify(input) });
}

export async function updateShow(id: string, patch: Partial<{ name: string; description: string }>): Promise<void> {
  await http(`/api/shows/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function deleteShow(id: string): Promise<void> {
  await http(`/api/shows/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ─── Projects ────────────────────────────────

export async function listProjects(): Promise<Project[]> {
  const data = await http<{ projects: Project[] }>('/api/projects');
  const list = data.projects;

  // Fallback：worker 還沒部最新版時自己拉 songs 補 status counts
  // worker 一旦回傳 songStatusCounts 就跳過此分支
  const needFallback = list.filter(p => p.songCount > 0 && !p.songStatusCounts);
  if (needFallback.length > 0) {
    await Promise.all(needFallback.map(async (p) => {
      try {
        const songs = await listSongs(p.id);
        const c = { todo: 0, in_review: 0, approved: 0, needs_changes: 0 };
        for (const s of songs) c[s.status]++;
        p.songStatusCounts = c;
      } catch { /* 容錯：拉不到就保持 undefined → 卡片顯示全灰 */ }
    }));
  }
  return list;
}

export async function createProject(input: { name: string; description: string; showId?: string | null }): Promise<{ id: string }> {
  return http<{ id: string }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateProject(id: string, patch: Partial<{ name: string; description: string; status: string; showId: string | null; tags: string[] }>): Promise<void> {
  await http(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

// ─── 專案共用 3D 檢視設定（測距校準倍率、現場設定、材質、重置視角、LED 畫布大小）──────
// 之前存各自瀏覽器 localStorage；現在存在 project 上，所有人共用，只有 admin 能改
// （機關在 lib/mechanisms/*；舊的全專案機關滑桿 mechanism_offsets 後台已經不收）

export interface ProjectViewSettings {
  scaleCorrection: number;
  lookSettings: LookSettings;
  materialOverrides: MaterialOverrides;
  /** 🎥 重置攝影機的畫面；null = 自動正面全景 */
  homeView: HomeView | null;
  /** AE 畫布尺寸（NDI Webcam 預覽要把 16:9 畫面放回 LED UV 用）；null = 還沒填 */
  ledCanvas: LedCanvas | null;
}

export async function getProjectViewSettings(projectId: string): Promise<ProjectViewSettings> {
  const data = await http<{ project: {
    scale_correction?: number; look_settings?: string; material_overrides?: string; home_view?: string | null;
    led_canvas?: string | null;
  } }>(
    `/api/projects/${encodeURIComponent(projectId)}`
  );
  const n = Number(data.project?.scale_correction);
  let look: unknown = {};
  try { look = JSON.parse(data.project?.look_settings || '{}'); } catch { /* 壞資料當沒有 */ }
  let materials: unknown = {};
  try { materials = JSON.parse(data.project?.material_overrides || '{}'); } catch { /* 壞資料當沒有 */ }
  return {
    scaleCorrection: isFinite(n) && n > 0 ? n : 1,
    lookSettings: normalizeLookSettings(look),
    materialOverrides: normalizeMaterialOverrides(materials),
    homeView: normalizeHomeView(data.project?.home_view ?? null),
    ledCanvas: normalizeLedCanvas(data.project?.led_canvas ?? null),
  };
}

export async function updateProjectViewSettings(
  projectId: string,
  patch: Partial<ProjectViewSettings>,
  opts?: { keepalive?: boolean },  // 關分頁時最後一次存檔用，瀏覽器才不會中途砍掉
): Promise<void> {
  await http(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    keepalive: opts?.keepalive,
  });
}

// ─── 比例尺的樂手和器材（0033，全專案共用；製作、導演可以改，其他人只能看）──────
// 格式和規則在 lib/stageProps.ts（後台 cf-worker 直接 import 同一個檔）

export async function getProjectStageProps(projectId: string): Promise<StagePropItem[]> {
  const data = await http<{ props?: unknown }>(`/api/projects/${encodeURIComponent(projectId)}/stage-props`);
  return normalizeStageProps(data?.props ?? []);
}

export async function saveProjectStageProps(
  projectId: string,
  props: StagePropItem[],
  opts?: { keepalive?: boolean },  // 關分頁時最後一次存檔用，瀏覽器才不會中途砍掉
): Promise<void> {
  await http(`/api/projects/${encodeURIComponent(projectId)}/stage-props`, {
    method: 'PUT',
    body: JSON.stringify({ props }),
    keepalive: opts?.keepalive,
  });
}

export async function archiveProject(id: string): Promise<void> {
  await http(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function listArchivedProjects(): Promise<Project[]> {
  try {
    const data = await http<{ projects: Project[] }>('/api/projects-archived');
    return data.projects;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return [];
    throw e;
  }
}

export async function restoreProject(id: string): Promise<void> {
  await http(`/api/projects/${encodeURIComponent(id)}/restore`, {
    method: 'POST', body: JSON.stringify({}),
  });
}

export async function duplicateProject(id: string, input: { newName?: string; showId?: string | null } = {}): Promise<{
  id: string;
  name: string;
  counts: { stageObjects: number; songs: number; cues: number; cueStates: number };
}> {
  return http(`/api/projects/${encodeURIComponent(id)}/duplicate`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** 下載 project 的 JSON 備份 — 走 fetch 拿 blob 觸發瀏覽器下載 */
export async function exportProjectToFile(projectId: string, projectName: string): Promise<void> {
  const token = getSessionToken();
  const resp = await fetch(`${apiBase()}/api/projects/${encodeURIComponent(projectId)}/export`, {
    credentials: 'include',
    headers: token ? { 'Authorization': `Bearer ${token}` } : {},
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { const e = await resp.json(); if (e?.error) msg = e.error; } catch {}
    throw new Error(msg);
  }
  const blob = await resp.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${projectName.replace(/[^\w-]/g, '_')}.stage-previz.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
}

export async function importProject(payload: object & { newName?: string }): Promise<{
  id: string; name: string;
  counts: { stageObjects: number; songs: number; cues: number; cueStates: number };
}> {
  return http('/api/projects/import', { method: 'POST', body: JSON.stringify(payload) });
}

// ─── Songs ────────────────────────────────

/** 歌單上的一首歌；code（歌曲代號 S01…）、latestVideoId / latestVideoVersion（最新可播的影片版本）見 videoApi.ts */
export interface Song extends SongVideoFields, Partial<SongReviewFields> {
  id: string;
  name: string;
  order: number;
  animatorUserId: string | null;
  status: 'todo' | 'in_review' | 'approved' | 'needs_changes';
  createdAt: string;
  cueCount: number;
  proposalCount: number;
}

export async function listSongs(projectId: string): Promise<Song[]> {
  const data = await http<{ songs: Song[] }>(`/api/projects/${encodeURIComponent(projectId)}/songs`);
  return data.songs;
}

/** 新增一首歌；code = 歌曲代號（不給 = 後台接著排 S01…；被別首歌用掉 → 409，error.data.codeTaken） */
export async function createSong(projectId: string, name: string, code?: string | null): Promise<{ id: string; order: number; code?: string | null }> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/songs`, {
    method: 'POST',
    body: JSON.stringify(code ? { name, code } : { name }),
  });
}

export async function updateSong(
  projectId: string,
  songId: string,
  // expectedStatus：畫面上以為的目前狀態。改狀態時帶上 → 別人剛改過的話後台回 409（error.data.currentStatus = 現在的狀態），不會蓋掉
  // reason：需修改的原因（一定要寫；也會發成一則留言）；reviewVideoId：看的是哪一版（沒帶 = 最新一版）
  patch: Partial<{
    name: string; order: number; status: Song['status']; expectedStatus: Song['status']; animator_user_id: string | null;
    reason: string; reviewVideoId: string | null;
  }>
): Promise<void> {
  await http(`/api/projects/${encodeURIComponent(projectId)}/songs/${encodeURIComponent(songId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteSong(projectId: string, songId: string): Promise<void> {
  await http(`/api/projects/${encodeURIComponent(projectId)}/songs/${encodeURIComponent(songId)}`, {
    method: 'DELETE',
  });
}

export async function reorderSongs(projectId: string, orderedIds: string[]): Promise<void> {
  await http(`/api/projects/${encodeURIComponent(projectId)}/songs/reorder`, {
    method: 'POST',
    body: JSON.stringify({ orderedIds }),
  });
}

// ─── Cues ────────────────────────────────

export interface Cue {
  id: string;
  name: string;
  order: number;
  position: { x: number; y: number; z: number };
  rotation: { pitch: number; yaw: number; roll: number };
  fov: number;
  crossfadeSeconds: number;
  videoTimeSec: number | null;   // 對應到 Drive 影片的第幾秒；null = 無對應
  status: 'master' | 'proposal' | 'alternate';
  proposedByUserId: string | null;
  baseCueId: string | null;
  thumbnailUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listCues(projectId: string, songId: string): Promise<Cue[]> {
  const data = await http<{ cues: Cue[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/songs/${encodeURIComponent(songId)}/cues`
  );
  return data.cues;
}

export async function createCue(
  projectId: string,
  songId: string,
  input: {
    name: string;
    position?: Cue['position'];
    rotation?: Cue['rotation'];
    fov?: number;
    crossfadeSeconds?: number;
    cloneFrom?: string;       // cue id — 複製其 overrides
    fromTemplateId?: string;  // 從 cue template 套用（mesh_name 對應）
    snapshotStates?: Array<{  // 顯式 snapshot
      objectId: string;
      position?: { x: number; y: number; z: number };
      rotation?: { pitch: number; yaw: number; roll: number };
    }>;
  }
): Promise<{ id: string }> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/songs/${encodeURIComponent(songId)}/cues`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function resetCue(projectId: string, songId: string, cueId: string): Promise<{ removed: number }> {
  return http(
    `/api/projects/${encodeURIComponent(projectId)}/songs/${encodeURIComponent(songId)}/cues/${encodeURIComponent(cueId)}/reset`,
    { method: 'POST', body: JSON.stringify({}) }
  );
}

export async function importCuesFromSong(
  projectId: string, songId: string,
  input: { fromSongId: string; replace?: boolean }
): Promise<{ ok: true; cuesInserted: number; statesInserted: number; statesSkipped: number; message: string }> {
  return http(
    `/api/projects/${encodeURIComponent(projectId)}/songs/${encodeURIComponent(songId)}/import-cues`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export async function reorderCues(projectId: string, songId: string, orderedIds: string[]): Promise<void> {
  await http(
    `/api/projects/${encodeURIComponent(projectId)}/songs/${encodeURIComponent(songId)}/cues/reorder`,
    { method: 'POST', body: JSON.stringify({ orderedIds }) }
  );
}

export async function updateCue(
  projectId: string,
  songId: string,
  cueId: string,
  patch: Partial<Pick<Cue, 'name' | 'order' | 'position' | 'rotation' | 'fov' | 'crossfadeSeconds' | 'videoTimeSec' | 'status'>>
): Promise<void> {
  await http(
    `/api/projects/${encodeURIComponent(projectId)}/songs/${encodeURIComponent(songId)}/cues/${encodeURIComponent(cueId)}`,
    { method: 'PATCH', body: JSON.stringify(patch) }
  );
}

export async function deleteCue(projectId: string, songId: string, cueId: string): Promise<void> {
  await http(
    `/api/projects/${encodeURIComponent(projectId)}/songs/${encodeURIComponent(songId)}/cues/${encodeURIComponent(cueId)}`,
    { method: 'DELETE' }
  );
}

// ─── Stage Objects ────────────────────────────────

export type StageObjectCategory = 'led_panel' | 'walk_point' | 'mechanism' | 'fixture' | 'performer' | 'other';

export interface Vec3 { x: number; y: number; z: number; }
export interface Euler { pitch: number; yaw: number; roll: number; }

export interface MaterialProps {
  color?: string;          // hex e.g. "#888888"
  roughness?: number;      // 0-1
  metalness?: number;      // 0-1
  opacity?: number;        // 0-1
  emissive?: string;       // hex
  emissiveIntensity?: number; // 0-3
}

export interface LedProps {
  brightness?: number;       // 0-3，1 = 正常
  saturation?: number;       // 0-2，1 = 原色
  hue?: number;              // -180~180 度
  castLightStrength?: number; // 0-3，影響 RectAreaLight intensity
  tint?: string;             // hex 色調，與 brightness 相乘
  imageUrl?: string;         // 短期測試：貼一張圖在 LED 面板上發光（CORS 友善的直連 URL）
}

export interface StageObject {
  id: string;
  meshName: string;
  displayName: string;
  category: StageObjectCategory;
  order: number;
  defaultPosition: Vec3;
  defaultRotation: Euler;
  defaultScale: Vec3;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  locked: boolean;
  materialProps: MaterialProps | null;
  ledProps: LedProps | null;
}

export async function listStageObjects(projectId: string): Promise<StageObject[]> {
  const data = await http<{ stageObjects: StageObject[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/stage-objects`
  );
  return data.stageObjects;
}

export async function createStageObject(projectId: string, input: {
  meshName: string;
  displayName?: string;
  category?: StageObjectCategory;
  defaultPosition?: Vec3;
  defaultRotation?: Euler;
}): Promise<{ id: string }> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/stage-objects`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateStageObject(projectId: string, objId: string, patch: Partial<{
  displayName: string;
  category: StageObjectCategory;
  order: number;
  defaultPosition: Vec3;
  defaultRotation: Euler;
  defaultScale: Vec3;
  metadata: Record<string, unknown> | null;
  locked: boolean;
  materialProps: MaterialProps | null;
  ledProps: LedProps | null;
}>): Promise<void> {
  await http(`/api/projects/${encodeURIComponent(projectId)}/stage-objects/${encodeURIComponent(objId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteStageObject(projectId: string, objId: string): Promise<void> {
  await http(`/api/projects/${encodeURIComponent(projectId)}/stage-objects/${encodeURIComponent(objId)}`, {
    method: 'DELETE',
  });
}

export async function seedDefaultStageObjects(projectId: string): Promise<{ inserted: number }> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/stage-objects/seed-defaults`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

// ─── Model file (R2) ────────────────────────────────

export interface ModelInfo {
  key: string;
  url: string;       // 相對 path（要 prepend apiBase 才能 fetch）
  size: number;
  uploaded: string | null;
}

export async function getModelInfo(projectId: string): Promise<ModelInfo | null> {
  const data = await http<{ model: ModelInfo | null }>(
    `/api/projects/${encodeURIComponent(projectId)}/model`
  );
  return data.model;
}

/** 把 .glb / .gltf binary 上傳到 R2 + 更新 project.model_r2_key — 支援進度回呼 */
export async function uploadModel(
  projectId: string,
  file: File | Blob | ArrayBuffer,
  onProgress?: (loaded: number, total: number) => void,
): Promise<{ key: string; url: string }> {
  // 用 XHR 才能拿 upload progress（fetch 沒支援上傳 progress）
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${apiBase()}/api/projects/${encodeURIComponent(projectId)}/model`);
    xhr.setRequestHeader('Content-Type', 'model/gltf-binary');
    const token = getSessionToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.withCredentials = true;
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('Invalid JSON response')); }
      } else {
        let msg = `HTTP ${xhr.status}`;
        try { const e = JSON.parse(xhr.responseText); if (e?.error) msg = e.error; } catch {}
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.onabort = () => reject(new Error('Upload aborted'));
    const body: BodyInit = file instanceof ArrayBuffer ? file : (file as Blob);
    xhr.send(body);
  });
}

/** 取得真檔 URL（給 GLTFLoader.load 用） */
export function modelDownloadUrl(key: string): string {
  return `${apiBase()}/r2/${key}`;
}

// ─── Model 版本歷史 ───

export interface ModelVersion {
  key: string;
  url: string;
  size: number;
  uploaded: string | null;
  timestamp: number;
  isActive: boolean;
}

export async function listModelVersions(projectId: string): Promise<{ versions: ModelVersion[]; activeKey: string | null }> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/model/versions`);
}

export async function activateModelVersion(projectId: string, key: string): Promise<{ key: string; url: string }> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/model/versions/activate`, {
    method: 'POST',
    body: JSON.stringify({ key }),
  });
}

export async function deleteModelVersion(projectId: string, key: string): Promise<void> {
  // key = models/<projectId>/<ts>.glb → 取最後一段傳給 worker
  const tsFile = key.split('/').pop() || '';
  await http(
    `/api/projects/${encodeURIComponent(projectId)}/model/versions/${encodeURIComponent(tsFile)}`,
    { method: 'DELETE' }
  );
}

// ─── Global search ───

export interface SearchResults {
  projects: { id: string; name: string }[];
  songs: { id: string; name: string; projectId: string; projectName: string }[];
  cues: { id: string; name: string; songId: string; songName: string; projectId: string; projectName: string }[];
  stageObjects: { id: string; name: string; projectId: string; projectName: string }[];
}

export async function searchAll(q: string): Promise<SearchResults> {
  if (!q.trim()) return { projects: [], songs: [], cues: [], stageObjects: [] };
  return http(`/api/search?q=${encodeURIComponent(q)}`);
}

// ─── Shared Assets（model 庫） ───

export interface SharedAsset {
  id: string;
  type: 'model';
  name: string;
  description: string;
  key: string;
  url: string;
  sizeBytes: number;
  uploaderName: string | null;
  usedByCount: number;
  createdAt: string;
  updatedAt: string;
}

export async function listAssets(): Promise<SharedAsset[]> {
  const data = await http<{ assets: SharedAsset[] }>('/api/assets');
  return data.assets;
}

export async function createAsset(input: { name: string; description: string }): Promise<{ id: string; key: string }> {
  return http('/api/assets', { method: 'POST', body: JSON.stringify({ ...input, type: 'model' }) });
}

export async function uploadAssetFile(assetId: string, file: File | Blob | ArrayBuffer): Promise<{ key: string; sizeBytes: number }> {
  const body: BodyInit = file instanceof ArrayBuffer ? file : (file as Blob);
  const resp = await fetch(`${apiBase()}/api/assets/${encodeURIComponent(assetId)}/file`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'model/gltf-binary' },
    body,
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { const e = await resp.json(); if (e?.error) msg = e.error; } catch {}
    throw new Error(msg);
  }
  return resp.json();
}

export async function updateAsset(id: string, patch: Partial<{ name: string; description: string; deactivated: boolean }>): Promise<void> {
  await http(`/api/assets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function deleteAsset(id: string): Promise<void> {
  await http(`/api/assets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** 把 project 的 model 切到某個 shared asset */
export async function useAssetForProject(projectId: string, assetId: string): Promise<{ key: string; url: string }> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/model/use-asset`, {
    method: 'POST',
    body: JSON.stringify({ assetId }),
  });
}

// ─── Cue templates / palette ───

export interface CueTemplate {
  id: string;
  projectId: string | null;
  name: string;
  description: string;
  global: boolean;
  authorName: string | null;
  createdAt: string;
}

export async function listCueTemplates(projectId: string): Promise<CueTemplate[]> {
  const data = await http<{ templates: CueTemplate[] }>(`/api/projects/${encodeURIComponent(projectId)}/cue-templates`);
  return data.templates;
}

export async function createCueTemplate(projectId: string, input: { name: string; description: string; fromCueId: string; global?: boolean }): Promise<{ id: string }> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/cue-templates`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function deleteCueTemplate(id: string): Promise<void> {
  await http(`/api/cue-templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// 改 createCue 的 input type 加 fromTemplateId
// （已有 createCue function，只要 input type 多 optional 一欄）

// ─── Activity feed ───

export type ActivityAction = 'create' | 'update' | 'delete' | 'reorder' | 'reset' | 'activate' | 'archive' | 'upload' | 'bulk_create' | 'seed';
export type ActivityTargetType = 'project' | 'song' | 'cue' | 'cue_state' | 'stage_object' | 'model';

export interface ActivityEntry {
  id: string;
  projectId: string;
  userId: string | null;
  userName: string;
  userAvatar: string;
  action: ActivityAction;
  targetType: ActivityTargetType;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export async function listActivity(projectId: string, limit = 50): Promise<ActivityEntry[]> {
  const data = await http<{ activities: ActivityEntry[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/activity?limit=${limit}`
  );
  return data.activities;
}

export async function bulkCreateStageObjects(
  projectId: string,
  items: Array<{
    meshName: string;
    displayName?: string;
    category?: StageObjectCategory;
    defaultPosition?: Vec3;
    defaultRotation?: Euler;
    defaultScale?: Vec3;
  }>,
  // replace = 先清掉專案所有物件（每個 cue 裡這些物件的位置也會一起刪）。
  // 只帶 replace 不帶 confirmReplace → 後台回 409，error.data = { requiresConfirmation: true, willDelete: { stageObjects, cueStates, cuesAffected } }
  // 給使用者看過、按確定後再帶 confirmReplace: true 呼叫一次。
  options?: { replace?: boolean; confirmReplace?: boolean }
): Promise<{ inserted: number; skipped: number; deleted?: { stageObjects: number; cueStates: number; cuesAffected: number } }> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/stage-objects/bulk`, {
    method: 'POST',
    body: JSON.stringify({ items, replace: options?.replace ?? false, confirmReplace: options?.confirmReplace === true }),
  });
}

// ─── Cue Object States ────────────────────────────────

export interface CueState {
  objectId: string;
  meshName: string;
  displayName: string;
  category: StageObjectCategory;
  order: number;
  locked: boolean;
  default: { position: Vec3; rotation: Euler; scale: Vec3 };
  override: {
    position: Vec3 | null;
    rotation: Euler | null;
    scale: Vec3 | null;
    visible: boolean | null;
    customProps: Record<string, unknown> | null;
    updatedAt: string;
  } | null;
  effective: { position: Vec3; rotation: Euler; scale: Vec3; visible: boolean };
}

export async function listCueStates(projectId: string, songId: string, cueId: string): Promise<CueState[]> {
  const data = await http<{ states: CueState[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/songs/${encodeURIComponent(songId)}/cues/${encodeURIComponent(cueId)}/states`
  );
  return data.states;
}

export async function setCueState(
  projectId: string, songId: string, cueId: string, objId: string,
  patch: Partial<{ position: Vec3; rotation: Euler; scale: Vec3; visible: boolean; customProps: Record<string, unknown> }>
): Promise<void> {
  await http(
    `/api/projects/${encodeURIComponent(projectId)}/songs/${encodeURIComponent(songId)}/cues/${encodeURIComponent(cueId)}/states/${encodeURIComponent(objId)}`,
    { method: 'PUT', body: JSON.stringify(patch) }
  );
}

export async function resetCueState(
  projectId: string, songId: string, cueId: string, objId: string
): Promise<void> {
  await http(
    `/api/projects/${encodeURIComponent(projectId)}/songs/${encodeURIComponent(songId)}/cues/${encodeURIComponent(cueId)}/states/${encodeURIComponent(objId)}`,
    { method: 'DELETE' }
  );
}

// ─── Comments (legacy KV /api/comments — re-used per song) ─────
//
// session id 必須 ^[a-zA-Z0-9_-]{1,64}$ — project/song id 已合規。為了長度安全
// 取 12 + 12 字元 + 一個分隔線：`p_<12>-s_<12>`。
//
// 一首歌一個 thread；admin / director / animator 共用同一 thread。

export type CommentAnchor =
  | { type: 'screen' }
  | { type: 'world'; world: { x: number; y: number; z: number } }
  | { type: 'mesh'; meshName: string; offset?: { x: number; y: number; z: number } | null };

/** 留言當下的 3D 攝影機（0026）：position / target 是場景座標，fov 是上下的角度，aspect = 畫面寬 / 高 */
export interface CameraView {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  aspect?: number;
}

export interface SongComment {
  id: string;
  time: number;            // 影片秒數（無片時填 0）；區段留言 = 開始
  x: number;               // 0-1 螢幕座標（screen anchor 用）
  y: number;
  text: string;
  author: string;          // 顯示名稱（訪客：「訪客：小李（給經紀人）」）
  email: string | null;
  role: 'designer' | 'director' | 'animator' | 'guest';
  createdAt: string;
  authorUserId?: string;   // 留言的人（後台依登入的人填；很舊的留言沒有）
  anchor?: CommentAnchor;  // 3D 錨點
  status?: 'open' | 'resolved';
  resolvedBy?: string;
  resolvedAt?: string;
  mentions?: { userId: string; name: string }[];  // @ 提及
  // 審片 v2（舊留言沒有這些）
  videoId?: string;         // 留言時看的那一版
  videoVersion?: number;    // 那一版的號碼（V2 → 2）
  parentId?: string;        // 回覆哪一則（只有一層）
  resolvedVideoId?: string; // 「已改好（V3）」是哪一版
  resolvedVersion?: number;
  resolvedByUserId?: string;
  kind?: 'needs_changes';   // 導演按「需修改」時寫的原因
  // 審片像 Frame.io（0026；舊留言沒有）
  timeEnd?: number;         // 區段留言的結束（0:12–0:18）
  view?: CameraView;        // 留言當下的 3D 視角（點留言時飛過去）
  cueId?: string;           // 留言當下的 cue
  annotation?: Annotation;  // 畫記（畫在 3D 畫面上的）
  thumbUrl?: string;        // 縮圖（相對路徑，前面接 apiBase()）；含畫記
  guest?: { name: string; linkName: string };  // 分享連結的訪客留的
  // 參考圖片（0028；沒有圖片的留言沒有這個欄位）
  attachments?: CommentAttachment[];
  /** 只有圖片、沒寫字（text 是「（圖片）」，給舊版畫面看的；新版畫面不顯示這行字） */
  noText?: boolean;
}

/** 留言的參考圖片（url / thumbUrl 是相對路徑，前面接 apiBase()） */
export interface CommentAttachment {
  id: string;
  url: string;
  /** 清單上的小縮圖（沒有 = 用原圖） */
  thumbUrl?: string;
  type: string;
  size: number;
  width?: number;
  height?: number;
}

/** 參考圖片的網址（相對 → 完整） */
export function attachmentSrc(path: string | undefined | null): string {
  if (!path) return '';
  return /^https?:/.test(path) ? path : apiBase() + path;
}

/** 留言多帶的（0026）：區段、3D 視角、cue、畫記、縮圖（data:image/jpeg;base64,…） */
export interface CommentExtras {
  timeEnd?: number | null;
  view?: CameraView | null;
  cueId?: string | null;
  annotation?: Annotation | null;
  thumbnail?: string | null;
}

/** 有帶才放進要送的 JSON（舊版後台看不懂也沒關係） */
export function commentExtrasBody(x: CommentExtras): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (x.timeEnd != null) out.timeEnd = x.timeEnd;
  if (x.view) out.view = x.view;
  if (x.cueId) out.cueId = x.cueId;
  if (x.annotation && (x.annotation.shapes.length || x.annotation.images?.length)) out.annotation = x.annotation;
  if (x.thumbnail) out.thumbnail = x.thumbnail;
  return out;
}

/** 縮圖網址（相對 → 完整）；沒有 = null */
export function commentThumbSrc(c: Pick<SongComment, 'thumbUrl'>): string | null {
  if (!c.thumbUrl) return null;
  return /^https?:/.test(c.thumbUrl) ? c.thumbUrl : apiBase() + c.thumbUrl;
}

export function songCommentSession(projectId: string, songId: string): string {
  // truncate 每段 28 字元 + 連字號 = ≤ 57 字元，符合 64 字元上限
  const p = projectId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28);
  const s = songId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 28);
  return `${p}-${s}`;
}

async function commentsFetch<T>(session: string, init?: RequestInit, extraQuery = ''): Promise<T> {
  const token = getSessionToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const url = `${apiBase()}/api/comments?session=${encodeURIComponent(session)}${extraQuery}`;
  const resp = await fetch(url, { credentials: 'include', ...init, headers });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    let errBody: Record<string, unknown> | undefined;
    try {
      const e = await resp.json();
      if (e && typeof e === 'object') errBody = e;
      if (e?.error) msg = e.error;
    } catch {}
    const err: ApiError = new Error(msg);
    err.status = resp.status;
    err.data = errBody;
    throw err;
  }
  return resp.json() as Promise<T>;
}

export async function listSongComments(projectId: string, songId: string): Promise<SongComment[]> {
  try {
    const data = await commentsFetch<{ comments: SongComment[] }>(songCommentSession(projectId, songId));
    return Array.isArray(data.comments) ? data.comments : [];
  } catch (e) {
    // 沒設 KV / 沒有舊的 comment → 回空陣列，UI 不應因此整個壞掉
    if ((e as { status?: number }).status === 500) return [];
    throw e;
  }
}

// 作者 / 身分 / 誰解決的：後台依登入的人填（前端送的名字不算數），所以這裡不用帶
export async function postSongComment(
  projectId: string, songId: string,
  comment: {
    text: string; time?: number; x?: number; y?: number; email?: string | null; anchor?: CommentAnchor; mentions?: { userId: string; name: string }[];
    /** 正在看的那一版（V2）→ 留言綁這一版 */
    videoId?: string | null;
    /** 回覆哪一則 */
    parentId?: string | null;
    /** 參考圖片（先用 lib/review/attachmentsApi.ts 傳好的，照順序） */
    attachmentIds?: string[];
  } & CommentExtras
): Promise<SongComment[]> {
  const c: Record<string, unknown> = {
    id: 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    text: comment.text,
    time: comment.time ?? 0,
    x: comment.x ?? 0.5,
    y: comment.y ?? 0.5,
    email: comment.email ?? null,
    createdAt: new Date().toISOString(),
  };
  if (comment.anchor) c.anchor = comment.anchor;
  if (comment.mentions && comment.mentions.length > 0) c.mentions = comment.mentions;
  if (comment.videoId) c.videoId = comment.videoId;
  if (comment.parentId) c.parentId = comment.parentId;
  if (comment.attachmentIds && comment.attachmentIds.length) c.attachmentIds = comment.attachmentIds;
  Object.assign(c, commentExtrasBody(comment));
  const data = await commentsFetch<{ comments: SongComment[] }>(
    songCommentSession(projectId, songId),
    { method: 'POST', body: JSON.stringify({ comment: c }) }
  );
  return Array.isArray(data.comments) ? data.comments : [];
}

export async function deleteSongComment(projectId: string, songId: string, commentId: string): Promise<SongComment[]> {
  const data = await commentsFetch<{ comments: SongComment[] }>(
    songCommentSession(projectId, songId),
    { method: 'DELETE' },
    `&id=${encodeURIComponent(commentId)}`
  );
  return Array.isArray(data.comments) ? data.comments : [];
}

// 改文字：留言的人自己或 admin；「已改好（V3）」/ 重新打開：規則見 commentThreads.ts canResolveComment（誰、什麼時候由後台記）
// resolvedVideoId：哪一版改好的（沒帶 = 最新一版）
export async function patchSongComment(
  projectId: string, songId: string, commentId: string,
  patch: Partial<{ status: 'open' | 'resolved'; text: string; resolvedVideoId: string | null; attachmentIds: string[] }>
): Promise<SongComment[]> {
  const data = await commentsFetch<{ comments: SongComment[] }>(
    songCommentSession(projectId, songId),
    { method: 'PATCH', body: JSON.stringify({ id: commentId, ...patch }) }
  );
  return Array.isArray(data.comments) ? data.comments : [];
}

// ─── Convenience: get single project metadata (uses list, no separate endpoint) ───

export async function getProjectMeta(projectId: string): Promise<Project | null> {
  const list = await listProjects();
  return list.find(p => p.id === projectId) || null;
}

/** 單一專案 + 我在這個專案的角色（封存的只有 admin 拿得到；找不到 / 沒權限會丟錯誤，status 404 / 403） */
export async function getProjectInfo(projectId: string): Promise<{ project: ProjectFull; myRole: ProjectRole | null }> {
  const data = await http<{ project: ProjectFull; myRole?: ProjectRole | null }>(`/api/projects/${encodeURIComponent(projectId)}`);
  return { project: data.project, myRole: data.myRole ?? null };
}

// ─── Drive integration（OAuth + 同步） ────────

export interface DriveAccount {
  id: string;
  email: string;
  name: string;
  scopes: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listDriveAccounts(): Promise<{ configured: boolean; accounts: DriveAccount[] }> {
  try {
    const data = await http<{ configured: boolean; accounts: DriveAccount[] }>('/api/drive/accounts');
    return { configured: !!data.configured, accounts: Array.isArray(data.accounts) ? data.accounts : [] };
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 404) return { configured: false, accounts: [] };
    throw e;
  }
}

export async function deleteDriveAccount(id: string): Promise<void> {
  await http(`/api/drive/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** 開 Google 同意頁；callback 完成後 server 跳回 returnTo */
export async function startDriveOAuth(returnTo: string = '/admin/drive-sources'): Promise<void> {
  // 用完整 URL（含 origin）— worker 端會 validate 白名單
  // 這樣 callback 才知道要跳回哪個前端 host（vercel 而不是 worker proxy host）
  const absolute = returnTo.startsWith('http')
    ? returnTo
    : `${window.location.origin}${returnTo.startsWith('/') ? '' : '/'}${returnTo}`;
  const data = await http<{ authUrl: string }>(
    `/api/drive/oauth/start?return=${encodeURIComponent(absolute)}`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  window.location.href = data.authUrl;
}

export interface DriveFolder {
  id: string;
  name: string;
  parents?: string[];
  modifiedTime?: string;
}

export async function listDriveFolders(accountId: string, parent: string = 'root'): Promise<DriveFolder[]> {
  const data = await http<{ folders: DriveFolder[] }>(
    `/api/drive/folders?account=${encodeURIComponent(accountId)}&parent=${encodeURIComponent(parent)}`
  );
  return data.folders;
}

export interface DriveFile {
  id: string;
  driveFileId: string;
  filename: string;
  mimeType: string | null;
  modifiedTime: string | null;
  sizeBytes: number | null;
  thumbnailUrl: string | null;
  viewUrl: string | null;
  songId: string | null;
  songName: string | null;
  classifiedBy: 'pattern' | 'manual';
  cachedAt: string;
}

export async function listDriveProjectFiles(projectId: string): Promise<DriveFile[]> {
  try {
    const data = await http<{ files: DriveFile[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/drive/files`
    );
    return Array.isArray(data?.files) ? data.files : [];
  } catch (e) {
    // worker 還沒部新版 → 404 / Drive route not found，回空陣列即可（功能 graceful degrade）
    const status = (e as { status?: number }).status;
    if (status === 404) return [];
    throw e;
  }
}

export async function syncDriveProject(projectId: string): Promise<{
  filesFound: number;
  classified: number;
  unclassified: number;
  durationMs: number;
}> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/drive/sync`, {
    method: 'POST', body: JSON.stringify({}),
  });
}

export async function assignDriveFile(projectId: string, fileId: string, songId: string | null): Promise<void> {
  await http(
    `/api/projects/${encodeURIComponent(projectId)}/drive/files/${encodeURIComponent(fileId)}/assign`,
    { method: 'POST', body: JSON.stringify({ songId }) }
  );
}

export interface DriveSyncLogEntry {
  id: string;
  triggeredBy: 'cron' | 'manual';
  filesFound: number;
  filesClassified: number;
  filesUnclassified: number;
  errorMessage: string | null;
  durationMs: number | null;
  ranAt: string;
}

export async function listDriveSyncLog(projectId: string): Promise<DriveSyncLogEntry[]> {
  try {
    const data = await http<{ logs: DriveSyncLogEntry[] }>(
      `/api/projects/${encodeURIComponent(projectId)}/drive/sync-log`
    );
    return Array.isArray(data?.logs) ? data.logs : [];
  } catch (e) {
    if ((e as { status?: number }).status === 404) return [];
    throw e;
  }
}

/** 影片串流 URL（給 <video> 用） */
export function driveStreamUrl(driveFileId: string): string {
  return `${apiBase()}/api/drive/stream/${encodeURIComponent(driveFileId)}`;
}

/** 把 project 的 drive_folder_id / drive_filename_pattern / drive_oauth_token_id 一次更新 */
export async function updateProjectDriveSettings(projectId: string, patch: Partial<{
  drive_folder_id: string | null;
  drive_filename_pattern: string;
  drive_oauth_token_id: string | null;
}>): Promise<void> {
  await http(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

// ─── Share Links ──────────────────────────────

export interface ShareLink {
  token: string;
  /** 好讀網址名稱（/s/<slug>）；null = 沒設（舊版 worker 沒這欄 → undefined） */
  slug?: string | null;
  projectId: string;
  songId: string | null;
  hasPassword: boolean;
  expiresAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
  /** 允許看的人留言（0026；舊版 worker 沒這欄 → undefined = 關） */
  allowComments?: boolean;
  /** 連結名稱（例：給經紀人；團隊看訪客留言時顯示） */
  label?: string | null;
  /** 從這條連結留了幾則 */
  guestCommentCount?: number;
}

export async function listShareLinks(projectId: string): Promise<ShareLink[]> {
  const data = await http<{ links: ShareLink[] }>(`/api/projects/${encodeURIComponent(projectId)}/share-links`);
  return Array.isArray(data?.links) ? data.links : [];
}

export async function createShareLink(projectId: string, input: { songId?: string | null; password?: string; expiresInDays?: number; slug?: string | null; allowComments?: boolean; label?: string | null }): Promise<{ token: string; slug?: string | null; expiresAt: string | null }> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/share-links`, {
    method: 'POST',
    body: JSON.stringify(input || {}),
  });
}

/** 設定 / 換 / 拿掉（null）好讀網址名稱；被別條連結用掉了 → 丟 409 */
export async function updateShareLinkSlug(projectId: string, token: string, slug: string | null): Promise<{ slug: string | null }> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/share-links/${encodeURIComponent(token)}`, {
    method: 'PATCH',
    body: JSON.stringify({ slug }),
  });
}

/** 改「允許看的人留言」（打開只有製作）、連結名稱 */
export async function updateShareLink(projectId: string, token: string, patch: { allowComments?: boolean; label?: string | null }): Promise<{ allowComments: boolean; label: string | null }> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/share-links/${encodeURIComponent(token)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteShareLink(projectId: string, token: string): Promise<void> {
  await http(`/api/projects/${encodeURIComponent(projectId)}/share-links/${encodeURIComponent(token)}`, { method: 'DELETE' });
}

/** 分享頁是用哪種網址打開的：舊式 /share/<連結碼> 或好讀 /s/<網址名稱> */
export type ShareRef = { kind: 'token' | 'slug'; key: string };

export function shareApiPath(ref: ShareRef): string {
  return ref.kind === 'slug'
    ? `/api/s/${encodeURIComponent(ref.key)}`
    : `/api/share/${encodeURIComponent(ref.key)}`;
}

export interface SharePublicData {
  project: { id: string; name: string; description: string };
  modelUrl: string | null;
  /** code / latestVideo：舊版 worker 沒有 → undefined */
  songs: ({ id: string; name: string; order: number; status: string } & Partial<ShareSongVideoFields>)[];
  stageObjects: StageObject[];
  restrictedToSongId: string | null;
  /** 舊版 worker 沒有 → undefined */
  scaleCorrection?: number;
  lookSettings?: Partial<LookSettings>;
  materialOverrides?: MaterialOverrides;
  homeView?: unknown;
  /** AE 畫布尺寸 { width, height }；null = 還沒填；舊版 worker 沒有 → undefined（用 normalizeLedCanvas 讀） */
  ledCanvas?: unknown;
  /** 比例尺的樂手和器材（0033，只看；用 normalizeStageProps 讀）；舊版 worker 沒有 → undefined */
  stageProps?: unknown;
  /**
   * 有密碼的連結：密碼對了後台發的通行證（8 小時）。之後的請求帶它（getShareSongCues 等的 access 參數），
   * 不用每次都送密碼；影片網址（streamUrl）後台已經接好通行證。沒密碼的連結 = null；舊版 worker 沒有 → undefined
   */
  access?: { token: string; expiresAt: number } | null;
  /** 製作有沒有打開「允許看的人留言」（0026；舊版 worker 沒有 → undefined = 沒開） */
  allowComments?: boolean;
}

export async function shareError(r: Response): Promise<Error & { status?: number; requiresPassword?: boolean }> {
  const err = await r.json().catch(() => ({} as { error?: string; requiresPassword?: boolean }));
  const e: Error & { status?: number; requiresPassword?: boolean } = new Error(err.error || `HTTP ${r.status}`);
  e.status = r.status;
  e.requiresPassword = !!err.requiresPassword;
  return e;
}

/** 分享連結的通行證 header（密碼只在第一次 getSharePublicData 送，之後都用通行證） */
export function shareAccessHeaders(access?: string): Record<string, string> {
  return access ? { 'x-share-access': access } : {};
}

/** 公開存取 — 無需 auth；有密碼的連結第一次帶 password（只放 header，不放網址） */
export async function getSharePublicData(ref: ShareRef, password?: string, access?: string): Promise<SharePublicData> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...shareAccessHeaders(access) };
  if (password) headers['x-share-password'] = password;
  // ?mech=3：新版畫面看得懂機關 v2 的對開和吊掛；沒帶的舊版前端後台不給（零件靜止，不會往錯的方向動）
  const r = await fetch(`${apiBase()}${shareApiPath(ref)}/data?mech=3`, { headers });
  if (!r.ok) throw await shareError(r);
  return r.json();
}

/** access = getSharePublicData 回的 access.token（沒密碼的連結不用給）；通行證過期 → 丟 status 401 */
export async function getShareSongCues(ref: ShareRef, songId: string, access?: string): Promise<Cue[]> {
  const r = await fetch(`${apiBase()}${shareApiPath(ref)}/songs/${encodeURIComponent(songId)}/cues`, { headers: shareAccessHeaders(access) });
  if (!r.ok) throw await shareError(r);
  const data = await r.json() as { cues: Cue[] };
  return data.cues;
}

export interface ShareVideo {
  id: string;
  driveFileId: string;
  filename: string;
  mimeType: string | null;
  modifiedTime: string | null;
  sizeBytes: number | null;
  // 相對路徑 /api/share/:token/videos/:fid/stream（用好讀網址打開時是 /api/s/:slug/...）；
  // 有密碼的連結後面已經接好 ?access=<通行證>（<video> 帶不了 header），直接當 src 用
  streamUrl: string;
}

/** 抓不到就回空陣列；只有通行證過期（401）會丟出來，讓分享頁重新換通行證 */
export async function getShareSongVideos(ref: ShareRef, songId: string, access?: string): Promise<ShareVideo[]> {
  let r: Response;
  try {
    r = await fetch(`${apiBase()}${shareApiPath(ref)}/songs/${encodeURIComponent(songId)}/videos`, { headers: shareAccessHeaders(access) });
  } catch { return []; }
  if (r.status === 401) throw await shareError(r);
  if (!r.ok) return [];
  try {
    const data = await r.json() as { videos: ShareVideo[] };
    return Array.isArray(data?.videos) ? data.videos : [];
  } catch { return []; }
}

export async function getShareCueStates(ref: ShareRef, songId: string, cueId: string, access?: string): Promise<CueState[]> {
  const r = await fetch(
    `${apiBase()}${shareApiPath(ref)}/songs/${encodeURIComponent(songId)}/cues/${encodeURIComponent(cueId)}/states`,
    { headers: shareAccessHeaders(access) }
  );
  if (!r.ok) throw await shareError(r);
  const data = await r.json() as { states: CueState[] };
  return data.states;
}

/** 直接從 GET /api/projects/:id 拉完整 row（含 drive_folder_id / drive_filename_pattern / drive_oauth_token_id） */
export interface ProjectFull {
  id: string;
  name: string;
  description: string;
  drive_folder_id: string | null;
  drive_filename_pattern: string;
  drive_oauth_token_id: string | null;
  drive_refresh_interval_min: number;
  status: string;
  show_id: string | null;
  tags: string | null;   // JSON string
  created_at: string;
  updated_at: string;
}
export async function getProjectFull(projectId: string): Promise<ProjectFull | null> {
  try {
    const data = await http<{ project: ProjectFull }>(`/api/projects/${encodeURIComponent(projectId)}`);
    return data.project;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

// ─── 邀請連結（invites）────────────────────────
// 後台：cf-worker/worker.js handleInvitesRouter / createInvite；規則在 cf-worker/invites.mjs
// 建立、清單、撤銷只有製作；打開（peek / redeem）不用登入

export type InviteRole = 'animator' | 'director';

export interface Invite {
  id: string;
  projectId: string;
  projectName: string | null;
  role: InviteRole;
  userId: string | null;
  personName: string;
  /** 新的人（打開時才建帳號） */
  isNewPerson: boolean;
  createdAt: string | null;
  expiresAt: string | null;
  maxUses: number;
  useCount: number;
  usesLeft: number;
  createdByName: string | null;
  lastUsedAt: string | null;
}

export interface CreateInviteInput {
  role: InviteRole;
  /** 已經有帳號的人 */
  userId?: string;
  /** 新的人的名字 */
  name?: string;
  /** 幾天內有效（預設 7） */
  expiresInDays?: number;
  /** 只能用一次（預設 true；false = 最多 10 次） */
  singleUse?: boolean;
}

/** 這個專案還能用的邀請 */
export async function listProjectInvites(projectId: string): Promise<Invite[]> {
  const data = await http<{ invites: Invite[] }>(`/api/projects/${encodeURIComponent(projectId)}/invites`);
  return data.invites;
}

/** 所有專案還能用的邀請（用戶頁） */
export async function listAllInvites(): Promise<Invite[]> {
  const data = await http<{ invites: Invite[] }>('/api/invites');
  return data.invites;
}

/** 建立邀請：token 只有這一次拿得到（後台只存雜湊）→ 用 siteUrl.inviteUrl(token) 組成連結 */
export async function createInvite(projectId: string, input: CreateInviteInput): Promise<{ invite: Invite; token: string }> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/invites`, { method: 'POST', body: JSON.stringify(input) });
}

export async function revokeInvite(projectId: string, inviteId: string): Promise<void> {
  await http(`/api/projects/${encodeURIComponent(projectId)}/invites/${encodeURIComponent(inviteId)}`, { method: 'DELETE' });
}

export interface InvitePeek {
  projectName: string;
  role: InviteRole;
  personName: string;
  expiresAt: string;
}

/** 不能用的原因（後台的 reason） */
export type InviteProblemReason =
  'not_found' | 'revoked' | 'expired' | 'used' | 'used_up' | 'archived' | 'deactivated' | 'admin_account';

/** 打開邀請的錯誤：status / reason / 後台給的中文說明（message） */
export type InviteError = Error & { status?: number; reason?: InviteProblemReason };

// peek / redeem 不用登入、也不是「存檔」→ 不走 http()（不帶登入、不跳存檔狀態）
async function invitePost<T>(path: string, token: string): Promise<T> {
  const r = await fetch(apiBase() + path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const data = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok) {
    const e: InviteError = new Error(typeof data.error === 'string' ? data.error : `HTTP ${r.status}`);
    e.status = r.status;
    if (typeof data.reason === 'string') e.reason = data.reason as InviteProblemReason;
    throw e;
  }
  return data as T;
}

/** 打開前先看：給誰、哪個專案、什麼角色（不會用掉邀請） */
export async function peekInvite(token: string): Promise<InvitePeek> {
  const data = await invitePost<{ invite: InvitePeek }>('/api/invites/peek', token);
  return data.invite;
}

/** 用掉邀請：登入（跟一般登入一樣記在這台裝置）+ 加進專案；回要去的頁面 */
export async function redeemInvite(token: string): Promise<{ user: AuthUser; landingPath: string; projectId: string; projectRole: InviteRole }> {
  const data = await invitePost<{ user: AuthUser; token?: string; landingPath: string; projectId: string; projectRole: InviteRole }>('/api/invites/redeem', token);
  if (data.token) setSessionToken(data.token);
  return { user: data.user, landingPath: data.landingPath, projectId: data.projectId, projectRole: data.projectRole };
}
