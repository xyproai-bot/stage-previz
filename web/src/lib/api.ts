// API client — 對接 cf-worker 在 proxy.haimiaan.com 的 endpoints

import type { Project } from './mockData';
import { saveStatus } from './saveStatus';

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
      try {
        const err = await resp.json();
        if (err?.error) msg = err.error;
      } catch { /* ignore */ }
      const e: Error & { status?: number } = new Error(msg);
      e.status = resp.status;
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
  accessCode: string | null;
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
}): Promise<{ id: string; accessCode: string }> {
  return http('/api/users', { method: 'POST', body: JSON.stringify(input) });
}

export async function updateUserAdmin(id: string, patch: Partial<{
  name: string; role: UserRole; avatarColor: string; deactivated: boolean;
}>): Promise<void> {
  await http(`/api/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function setAccessCode(id: string, accessCode?: string): Promise<{ ok: true; accessCode: string }> {
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

export interface Song {
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

export async function createSong(projectId: string, name: string): Promise<{ id: string; order: number }> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/songs`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export async function updateSong(
  projectId: string,
  songId: string,
  patch: Partial<{ name: string; order: number; status: Song['status']; animator_user_id: string }>
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
  patch: Partial<Pick<Cue, 'name' | 'order' | 'position' | 'rotation' | 'fov' | 'crossfadeSeconds' | 'status'>>
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
  options?: { replace?: boolean }
): Promise<{ inserted: number; skipped: number }> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/stage-objects/bulk`, {
    method: 'POST',
    body: JSON.stringify({ items, replace: options?.replace ?? false }),
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

export interface SongComment {
  id: string;
  time: number;            // 影片秒數（無片時填 0）
  x: number;               // 0-1 螢幕座標（screen anchor 用）
  y: number;
  text: string;
  author: string;          // 顯示名稱
  email: string | null;
  role: 'designer' | 'director' | 'animator';
  createdAt: string;
  anchor?: CommentAnchor;  // 3D 錨點
  status?: 'open' | 'resolved';
  resolvedBy?: string;
  resolvedAt?: string;
  mentions?: { userId: string; name: string }[];  // @ 提及
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
    try { const e = await resp.json(); if (e?.error) msg = e.error; } catch {}
    const err: Error & { status?: number } = new Error(msg);
    err.status = resp.status;
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

export async function postSongComment(
  projectId: string, songId: string,
  comment: { text: string; author: string; role: SongComment['role']; time?: number; x?: number; y?: number; email?: string | null; anchor?: CommentAnchor; mentions?: { userId: string; name: string }[] }
): Promise<SongComment[]> {
  const c: Record<string, unknown> = {
    id: 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    text: comment.text,
    author: comment.author,
    role: comment.role,
    time: comment.time ?? 0,
    x: comment.x ?? 0.5,
    y: comment.y ?? 0.5,
    email: comment.email ?? null,
    createdAt: new Date().toISOString(),
  };
  if (comment.anchor) c.anchor = comment.anchor;
  if (comment.mentions && comment.mentions.length > 0) c.mentions = comment.mentions;
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

export async function patchSongComment(
  projectId: string, songId: string, commentId: string,
  patch: Partial<{ status: 'open' | 'resolved'; text: string; resolvedBy: string; resolvedAt: string }>
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
  // 用 POST 拿 authUrl（POST 可以帶 Authorization header，避開 third-party cookie 限制）
  const data = await http<{ authUrl: string }>(
    `/api/drive/oauth/start?return=${encodeURIComponent(returnTo)}`,
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
  projectId: string;
  songId: string | null;
  hasPassword: boolean;
  expiresAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
  createdAt: string;
}

export async function listShareLinks(projectId: string): Promise<ShareLink[]> {
  const data = await http<{ links: ShareLink[] }>(`/api/projects/${encodeURIComponent(projectId)}/share-links`);
  return Array.isArray(data?.links) ? data.links : [];
}

export async function createShareLink(projectId: string, input: { songId?: string | null; password?: string; expiresInDays?: number }): Promise<{ token: string; expiresAt: string | null }> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/share-links`, {
    method: 'POST',
    body: JSON.stringify(input || {}),
  });
}

export async function deleteShareLink(projectId: string, token: string): Promise<void> {
  await http(`/api/projects/${encodeURIComponent(projectId)}/share-links/${encodeURIComponent(token)}`, { method: 'DELETE' });
}

export interface SharePublicData {
  project: { id: string; name: string; description: string };
  modelUrl: string | null;
  songs: { id: string; name: string; order: number; status: string }[];
  stageObjects: StageObject[];
  restrictedToSongId: string | null;
}

/** 公開存取 — 無需 auth，可選 password */
export async function getSharePublicData(token: string, password?: string): Promise<SharePublicData> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (password) headers['x-share-password'] = password;
  const r = await fetch(`${apiBase()}/api/share/${encodeURIComponent(token)}/data`, { headers });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    const e: Error & { status?: number; requiresPassword?: boolean } = new Error(err.error || `HTTP ${r.status}`);
    e.status = r.status;
    e.requiresPassword = !!err.requiresPassword;
    throw e;
  }
  return r.json();
}

export async function getShareSongCues(token: string, songId: string, password?: string): Promise<Cue[]> {
  const headers: Record<string, string> = {};
  if (password) headers['x-share-password'] = password;
  const r = await fetch(`${apiBase()}/api/share/${encodeURIComponent(token)}/songs/${encodeURIComponent(songId)}/cues`, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json() as { cues: Cue[] };
  return data.cues;
}

export async function getShareCueStates(token: string, songId: string, cueId: string, password?: string): Promise<CueState[]> {
  const headers: Record<string, string> = {};
  if (password) headers['x-share-password'] = password;
  const r = await fetch(
    `${apiBase()}/api/share/${encodeURIComponent(token)}/songs/${encodeURIComponent(songId)}/cues/${encodeURIComponent(cueId)}/states`,
    { headers }
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
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
