// 省空間（後台 cf-worker/storage.mjs，0029）：最近刪除 / 救回來、上傳前問有沒有重複、專案結束清影片、空間用量和估計費用。
//   費用只是估計：R2 標準存放每 GB 每月 US$0.015（整個帳號前 10 GB 免費）、長期存放 US$0.01（打開時每 GB 另外 US$0.01）；
//   看影片、下載在 Cloudflare 不收錢。台幣用 1 美元 = 32 元粗估。

import { apiBase, getSessionToken } from './api';

// ─── 共用 ───

const enc = encodeURIComponent;

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const h: Record<string, string> = {};
  const token = getSessionToken();
  if (token) h.Authorization = `Bearer ${token}`;
  if (typeof init.body === 'string') h['Content-Type'] = 'application/json';
  const resp = await fetch(apiBase() + path, { credentials: 'include', ...init, headers: h });
  let data: unknown = null;
  try { data = await resp.json(); } catch { /* 不是 JSON */ }
  if (!resp.ok) {
    const msg = (data as { error?: string } | null)?.error || `HTTP ${resp.status}`;
    const e = new Error(msg) as Error & { status: number };
    e.status = resp.status;
    throw e;
  }
  return data as T;
}

// ─── 最近刪除 / 救回來（只有製作） ───

export interface DeletedVideo {
  id: string;
  songId: string;
  version: number;
  label: string;
  title: string;
  note: string;
  sizeBytes: number | null;
  createdBy: { id: string; name: string | null } | null;
  createdAt: string;
  readyAt: string | null;
  deletedAt: string;
  deletedBy: { id: string; name: string | null } | null;
  purgeAfter: string | null;
  /** 還剩幾天就清掉（0 = 這幾分鐘就會清） */
  daysLeft: number;
}

export function listDeletedVideos(projectId: string, songId: string): Promise<{ videos: DeletedVideo[]; keepDays: number }> {
  return call(`/api/projects/${enc(projectId)}/songs/${enc(songId)}/videos/deleted`);
}

export function restoreDeletedVideo(projectId: string, songId: string, videoId: string): Promise<{ ok: true; label: string }> {
  return call(`/api/projects/${enc(projectId)}/songs/${enc(songId)}/videos/${enc(videoId)}/restore`, { method: 'POST' });
}

// ─── 重複的檔案 ───

export interface DuplicateMatch {
  videoId: string;
  songId: string;
  songCode: string | null;
  songName: string;
  /** 是不是同一首歌 */
  sameSong: boolean;
  version: number;
  label: string;
  sizeBytes: number | null;
  createdBy: { id: string; name: string | null } | null;
  createdAt: string;
  /** 最近刪掉（30 天內）的那一版 */
  deleted: boolean;
  deletedAt: string | null;
  daysLeft: number | null;
}

/** 上傳之前問：這個專案有沒有一模一樣的檔案（指紋見 videoFingerprint.ts） */
export async function checkDuplicateVideo(projectId: string, songId: string, fingerprint: string): Promise<DuplicateMatch[]> {
  const r = await call<{ matches: DuplicateMatch[] }>(`/api/projects/${enc(projectId)}/songs/${enc(songId)}/videos/duplicates`, {
    method: 'POST', body: JSON.stringify({ fingerprint }),
  });
  return r.matches || [];
}

/** 「S03 夜曲」（沒有代號就只有歌名） */
export function matchSongName(m: Pick<DuplicateMatch, 'songCode' | 'songName'>): string {
  return [m.songCode, m.songName].filter(Boolean).join(' ');
}

/** 月 / 日 */
function shortDate(s: string | null): string {
  const t = Date.parse(s || '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 選好檔案後的提醒：「這個檔案跟「S03 夜曲」的 V2 一模一樣（小明 10/14 交的）」，別首歌的再加一句 */
export function duplicateWarning(m: DuplicateMatch): string {
  const who = [m.createdBy?.name, shortDate(m.createdAt)].filter(Boolean).join(' ');
  const where = `這個檔案跟「${matchSongName(m)}」的 ${m.label} 一模一樣${who ? `（${who} 交的）` : ''}`;
  const del = m.deleted ? `，那一版最近刪掉了（還在「最近刪除」裡）` : '';
  return m.sameSong ? `${where}${del}` : `${where}${del}，上傳到別首歌了，要不要確認一下？`;
}

// ─── 專案結束清影片 ───

export interface WrapUpPreview {
  songs: {
    songId: string; code: string | null; name: string;
    keep: { id: string; label: string; reason: 'approved' | 'latest'; sizeBytes: number };
    remove: { id: string; label: string; sizeBytes: number }[];
  }[];
  totals: {
    videoCount: number; videoBytes: number;
    removeCount: number; removeBytes: number;
    keepCount: number; keepBytes: number; keepIaBytes: number; allIaBytes: number;
  };
  storageJobs: { queued: number; done: number; failed: number };
  keepDays: number;
}

export type WrapUpKeep = 'all' | 'final';
export type WrapUpStorage = 'standard' | 'infrequent';

export function getWrapUpPreview(projectId: string): Promise<WrapUpPreview> {
  return call(`/api/projects/${enc(projectId)}/wrap-up`);
}

export function applyWrapUp(projectId: string, keep: WrapUpKeep, storage: WrapUpStorage): Promise<{ removedCount: number; removedBytes: number; queuedForInfrequent: number; keepDays: number }> {
  return call(`/api/projects/${enc(projectId)}/wrap-up`, { method: 'POST', body: JSON.stringify({ keep, storage }) });
}

// ─── 空間用量（系統狀態） ───

export interface ProjectUsage {
  id: string;
  name: string;
  status: string | null;
  videoBytes: number; videoIaBytes: number; videoCount: number;
  deletedBytes: number; deletedCount: number;
  modelBytes: number; commentImageBytes: number; otherBytes: number;
  totalBytes: number; iaBytes: number; standardBytes: number;
  storageJobs: { queued: number; done: number; failed: number };
}

export interface DuplicateGroup {
  projectId: string;
  projectName: string;
  projectArchived: boolean;
  sizeBytes: number;
  wasteBytes: number;
  versions: { videoId: string; songId: string; songCode: string | null; songName: string; version: number; label: string }[];
}

export interface StorageSummary {
  projects: ProjectUsage[];
  account: {
    assets: number; backups: number; downloads: number; other: number; accountBytes: number;
    totalBytes: number; iaBytes: number; standardBytes: number;
    videoBytes: number; deletedBytes: number; modelBytes: number; commentImageBytes: number;
    videoCount: number; deletedCount: number;
    r2: { bytes: number; iaBytes: number; objects: number; videoBytes: number; scannedAt: string | null; scanning: boolean };
  };
  duplicates: { groups: DuplicateGroup[]; groupCount: number; wasteBytes: number };
  fingerprints: { pending: number };
  purge: { mode: 'on' | 'dry-run'; keepDays: number; last: { at: string; candidates: number; purged: number } | null; totalPurged: number };
  generatedAt: string;
}

export function getStorageSummary(): Promise<StorageSummary> {
  return call('/api/admin/storage');
}

export function requestStorageRescan(): Promise<{ requested?: boolean; already?: boolean }> {
  return call('/api/admin/storage/rescan', { method: 'POST' });
}

// ─── 費用（估計） ───

export const USD_TO_TWD = 32;
export const R2_STANDARD_USD_PER_GB = 0.015;
export const R2_IA_USD_PER_GB = 0.01;
export const R2_IA_READ_USD_PER_GB = 0.01;
export const R2_FREE_GB = 10;
const GB = 1024 ** 3;

/** 每月大概多少美金。freeTier = 整個帳號（扣掉標準存放的前 10 GB）；一個專案的不扣（免費額度是整個帳號一起算） */
export function monthlyCostUsd({ standardBytes, iaBytes }: { standardBytes: number; iaBytes: number }, freeTier = false): number {
  const std = Math.max(0, standardBytes / GB - (freeTier ? R2_FREE_GB : 0));
  return std * R2_STANDARD_USD_PER_GB + Math.max(0, iaBytes / GB) * R2_IA_USD_PER_GB;
}

/** 1.23 GB（小的寫 MB / KB；沒有寫 0） */
export function formatGb(bytes: number): string {
  const b = Math.max(0, Number(bytes) || 0);
  if (b === 0) return '0';
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  if (b < GB / 10) return `${Math.round(b / 1024 / 1024)} MB`;
  return `${(b / GB).toFixed(b < 10 * GB ? 2 : 1)} GB`;
}

/** US$0.12（不到一分錢寫 US$0.00） */
export function formatUsd(usd: number): string {
  return `US$${(Math.max(0, usd)).toFixed(usd >= 100 ? 0 : 2)}`;
}

/** NT$4（台幣用 32 粗估，取整數；不到 1 塊寫「不到 NT$1」） */
export function formatTwd(usd: number): string {
  const twd = Math.max(0, usd) * USD_TO_TWD;
  if (twd > 0 && twd < 1) return '不到 NT$1';
  return `NT$${Math.round(twd).toLocaleString('zh-TW')}`;
}

/** 搬到長期存放每個月大概省多少（負的 = 反而比較貴：帳號還在 10 GB 免費額度裡） */
export function infrequentSavingUsd(bytes: number, accountStandardBytes: number): number {
  const before = monthlyCostUsd({ standardBytes: accountStandardBytes, iaBytes: 0 }, true);
  const after = monthlyCostUsd({ standardBytes: Math.max(0, accountStandardBytes - bytes), iaBytes: bytes }, true);
  return before - after;
}
