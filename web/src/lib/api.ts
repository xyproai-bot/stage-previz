// API client — 對接 cf-worker 在 proxy.haimiaan.com 的 endpoints

import type { Project } from './mockData';

// 開發時可以用 localStorage 'stagepreviz-api-base' override
const DEFAULT_API_BASE = 'https://proxy.haimiaan.com';

function apiBase(): string {
  if (typeof window !== 'undefined') {
    const override = window.localStorage.getItem('stagepreviz-api-base');
    if (override) return override;
  }
  return DEFAULT_API_BASE;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(apiBase() + path, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const err = await resp.json();
      if (err?.error) msg = err.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return resp.json() as Promise<T>;
}

// ─── Projects ────────────────────────────────

export async function listProjects(): Promise<Project[]> {
  const data = await http<{ projects: Project[] }>('/api/projects');
  return data.projects;
}

export async function createProject(input: { name: string; description: string }): Promise<{ id: string }> {
  return http<{ id: string }>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function archiveProject(id: string): Promise<void> {
  await http(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
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
  input: { name: string; position?: Cue['position']; rotation?: Cue['rotation']; fov?: number; crossfadeSeconds?: number }
): Promise<{ id: string }> {
  return http(`/api/projects/${encodeURIComponent(projectId)}/songs/${encodeURIComponent(songId)}/cues`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
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
