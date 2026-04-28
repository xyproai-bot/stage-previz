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
