// 「設定 → 系統狀態」（只有製作）：最近一份資料庫備份、最近的前端錯誤
// 後台：cf-worker/ops.mjs（GET /api/admin/system-status、GET /api/admin/backups/<日期>.sql.gz）
import { apiBase, getSessionToken } from './api';

export interface BackupItem {
  day: string;
  file: string;
  size: number;
  createdAt: string | null;
  monthly: boolean;
}

export interface BackupStatus {
  last: { day: string; size: number; rows: number; tables: number; finishedAt: string } | null;
  running: { day: string; rows: number; parts: number; attempts: number; error: string | null } | null;
  lastError: { day: string; at: string; message: string } | null;
  failedDay: string | null;
  count: number;
  latest: BackupItem | null;
}

export interface ClientErrorGroup {
  fingerprint: string;
  message: string;
  count: number;
  users: number;
  firstAt: string;
  lastAt: string;
  sample: {
    stack: string | null;
    path: string | null;
    userAgent: string | null;
    appVersion: string | null;
    userId: string | null;
    userName: string | null;
  };
}

export interface SystemStatus {
  backup: BackupStatus;
  clientErrors: { days: number; groups: ClientErrorGroup[] };
}

function authHeaders(): Record<string, string> {
  const token = getSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function errorMessage(resp: Response): Promise<string> {
  try {
    const j = await resp.json();
    if (j && typeof j.error === 'string') return j.error;
  } catch { /* ignore */ }
  return `HTTP ${resp.status}`;
}

export async function getSystemStatus(): Promise<SystemStatus> {
  const resp = await fetch(`${apiBase()}/api/admin/system-status`, { headers: authHeaders(), credentials: 'include' });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  return resp.json() as Promise<SystemStatus>;
}

/** 全部備份的清單（新的在前）：最近 30 天每天一份 + 最近 12 個月每個月的第一份 */
export async function listBackups(): Promise<BackupItem[]> {
  const resp = await fetch(`${apiBase()}/api/admin/backups`, { headers: authHeaders(), credentials: 'include' });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  const data = await resp.json() as { backups?: BackupItem[] };
  return Array.isArray(data.backups) ? data.backups : [];
}

/** 清單上的一行字：「2026-10-14 · 1.2 MB」，每個月留下來的那份多寫「每月留存」 */
export function describeBackup(b: Pick<BackupItem, 'day' | 'size' | 'monthly'>): string {
  const size = formatBackupSize(b.size);
  return [b.day, size, b.monthly ? '每月留存' : ''].filter(Boolean).join(' · ');
}

/** 下載一份備份（帶登入狀態拿檔案，再讓瀏覽器存檔） */
export async function downloadBackup(file: string): Promise<void> {
  const resp = await fetch(`${apiBase()}/api/admin/backups/${encodeURIComponent(file)}`, { headers: authHeaders(), credentials: 'include' });
  if (!resp.ok) throw new Error(await errorMessage(resp));
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `stage-previz-db-${file}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 123456 → '120.6 KB' */
export function formatBackupSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
