// 一首歌的影片版本（V3、V2、V1…）：排順序、要播哪一版、記住這個人選的版本、誰能加 / 刪。
//   後台說明：docs/videos-api.md；呼叫：videoApi.ts。這裡只有純函式（videoVersions.test.ts 有測）。
//
//   VersionItem — 畫面用的一版（成員看到的版本、分享連結看到的最新版、舊的 Drive 影片都轉成這個）
//   readyItems / pendingVideos — 可以播的（版本號大到小）/ 還沒好的（上傳中 / 複製中 / 失敗，新的在前）
//   pickVersion — 要播哪一版：預設最新；記住的那版還在、之後也沒有更新的版本 → 那版
//   readVersionChoice / writeVersionChoice — 記住選的版本（只存在這台電腦，localStorage 壞了也不會出錯）
//   canAddVideo / canModifyVideo — 畫面上要不要出現「＋加影片」「刪除」（後台還會再檢查）

import type { ProjectRole } from './mockData';
import type { ShareSongVideo, SongVideo, SongVideoStatus } from './videoApi';
import { parseServerTime } from './serverTime';

export interface VersionItem {
  /** 'v:<影片 id>'（版本）或 'd:<Drive 檔案 id>'（舊的 Drive 影片） */
  key: string;
  id: string;
  kind: 'version' | 'drive';
  /** 版本號；舊的 Drive 影片沒有 */
  version: number | null;
  /** 'V3'；舊的 Drive 影片：'Drive 最新' / 'Drive 舊版 2' */
  label: string;
  title: string;
  /** 一行說明（分享連結、Drive 沒有 → ''） */
  note: string;
  /** 誰交的（Drive 同步 / 分享連結看不到 → null） */
  by: string | null;
  byId: string | null;
  /** 什麼時候交的（伺服器時間字串） */
  at: string | null;
  /** 完整播放網址；還沒好的 = null */
  url: string | null;
  /** <video crossOrigin>：版本網址帶通行證 → anonymous；舊的 Drive 直播要登入 cookie → use-credentials */
  crossOrigin: 'anonymous' | 'use-credentials';
  status: SongVideoStatus;
  /** 成員看到的完整資料（刪除權限要看誰交的）；分享連結 / Drive = null */
  video: SongVideo | null;
}

export const versionKey = (id: string) => `v:${id}`;
export const driveKey = (fileId: string) => `d:${fileId}`;

/** 成員看到的一版 → 畫面用的 */
export function itemFromVideo(v: SongVideo, absolute: (u: string) => string): VersionItem {
  return {
    key: versionKey(v.id),
    id: v.id,
    kind: 'version',
    version: v.version,
    label: v.label || (v.version != null ? `V${v.version}` : ''),
    title: v.title || '',
    note: v.note || '',
    by: v.createdBy ? (v.createdBy.name || '（沒有名字）') : (v.source === 'drive' ? 'Drive 同步' : null),
    byId: v.createdBy?.id ?? null,
    at: v.readyAt || v.createdAt || null,
    url: v.status === 'ready' && v.streamUrl ? absolute(v.streamUrl) : null,
    crossOrigin: 'anonymous',
    status: v.status,
    video: v,
  };
}

/** 分享連結看到的最新版 → 畫面用的（沒有說明、誰交的） */
export function itemFromShareVideo(v: ShareSongVideo, absolute: (u: string) => string): VersionItem {
  return {
    key: versionKey(v.id),
    id: v.id,
    kind: 'version',
    version: v.version,
    label: v.label || `V${v.version}`,
    title: v.title || '',
    note: '',
    by: null,
    byId: null,
    at: v.readyAt || v.createdAt || null,
    url: absolute(v.streamUrl),
    crossOrigin: 'anonymous',
    status: 'ready',
    video: null,
  };
}

/** 舊的 Drive 影片（以前的系統）：新的在前，標「Drive 最新」「Drive 舊版 N」（跟以前導演頁一樣的順序） */
export interface LegacyDriveVideo {
  driveFileId: string;
  filename: string;
  modifiedTime: string | null;
  /** 舊的清單排序用（沒有修改時間時） */
  cachedAt?: string | null;
  url: string;
  crossOrigin: 'anonymous' | 'use-credentials';
}

export function itemsFromLegacyDrive(files: LegacyDriveVideo[]): VersionItem[] {
  const sorted = [...files].sort((a, b) => {
    const ta = parseServerTime(a.modifiedTime || a.cachedAt || '');
    const tb = parseServerTime(b.modifiedTime || b.cachedAt || '');
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
  });
  return sorted.map((f, i) => ({
    key: driveKey(f.driveFileId),
    id: f.driveFileId,
    kind: 'drive' as const,
    version: null,
    label: i === 0 ? 'Drive 最新' : `Drive 舊版 ${sorted.length - i}`,
    title: f.filename,
    note: '',
    by: null,
    byId: null,
    at: f.modifiedTime || f.cachedAt || null,
    url: f.url,
    crossOrigin: f.crossOrigin,
    status: 'ready' as const,
    video: null,
  }));
}

/** 可以播的版本：版本號由大到小（V3、V2、V1；不是看修改時間） */
export function readyItems(items: VersionItem[]): VersionItem[] {
  const ready = items.filter(it => it.status === 'ready' && it.url);
  const versions = ready.filter(it => it.kind === 'version' && it.version != null)
    .sort((a, b) => (b.version as number) - (a.version as number));
  // 舊的 Drive 影片已經照時間排好，接在後面（同一首歌通常只會有其中一種）
  const drive = ready.filter(it => it.kind === 'drive');
  return [...versions, ...drive];
}

/** 還沒好的（上傳中 / 複製中 / 失敗）：新的在前 */
export function pendingVideos(videos: SongVideo[]): SongVideo[] {
  return videos
    .filter(v => v.status !== 'ready')
    .sort((a, b) => (parseServerTime(b.createdAt) || 0) - (parseServerTime(a.createdAt) || 0));
}

// ─── 記住選的版本 ───

export interface VersionChoice {
  /** 選的那一版（VersionItem.key） */
  key: string;
  /** 選的時候最新的是哪一版：之後有更新的版本進來 → 回到最新（導演才不會一直看舊的） */
  latestKey: string | null;
}

/** 存在 localStorage 的 key：誰（帳號 id；分享連結 = 'share:<連結>'）、哪個專案、哪首歌 */
export function versionChoiceStorageKey(viewer: string, projectId: string, songId: string): string {
  return `sp_song_version:${viewer}:${projectId}:${songId}`;
}

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): KV | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function readVersionChoice(storageKey: string, storage: KV | null = defaultStorage()): VersionChoice | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<VersionChoice>;
    if (!v || typeof v.key !== 'string' || !v.key) return null;
    return { key: v.key, latestKey: typeof v.latestKey === 'string' ? v.latestKey : null };
  } catch {
    return null;
  }
}

export function writeVersionChoice(storageKey: string, choice: VersionChoice | null, storage: KV | null = defaultStorage()): void {
  if (!storage) return;
  try {
    if (choice) storage.setItem(storageKey, JSON.stringify(choice));
    else storage.removeItem(storageKey);
  } catch { /* 私密瀏覽 / 空間滿了：只是下次不會記得 */ }
}

/**
 * 要播哪一版（ready = readyItems 排好的，第一個是最新）：
 *   - 沒有記住 / 記住的那版不見了（被刪）→ 最新
 *   - 選了之後又有更新的版本（最新的不是選的時候那個）→ 最新
 *   - 不然 → 記住的那版
 */
export function pickVersion(ready: VersionItem[], choice: VersionChoice | null): VersionItem | null {
  if (ready.length === 0) return null;
  const latest = ready[0];
  if (!choice) return latest;
  const chosen = ready.find(it => it.key === choice.key);
  if (!chosen) return latest;
  if (choice.latestKey && choice.latestKey !== latest.key) return latest;
  return chosen;
}

/** 選了某一版 → 要記住的內容（選最新的 = 不用記，回到預設） */
export function choiceFor(ready: VersionItem[], key: string): VersionChoice | null {
  const latest = ready[0];
  if (!latest || latest.key === key) return null;
  return { key, latestKey: latest.key };
}

// ─── 權限（跟 cf-worker/videos.mjs 的 videoUploadDecision / videoModifyDecision 一樣） ───

interface PermInput {
  /** 帳號的角色（全站 admin 什麼都可以） */
  accountRole?: string | null;
  /** 在這個專案的角色 */
  projectRole: ProjectRole | null | undefined;
  userId: string | null | undefined;
  song: { animatorUserId: string | null } | null | undefined;
}

function effectiveRole(p: PermInput): ProjectRole | null {
  if (p.accountRole === 'admin') return 'admin';
  return p.projectRole ?? null;
}

/** 能不能幫這首歌交新版（上傳 / 貼連結）：admin；負責這首歌的動畫師（沒指派人 = 專案裡的動畫師都可以）；導演不行 */
export function canAddVideo(p: PermInput): boolean {
  const role = effectiveRole(p);
  if (!p.song || !p.userId) return false;
  if (role === 'admin') return true;
  if (role === 'animator') return !p.song.animatorUserId || p.song.animatorUserId === p.userId;
  return false;
}

/** 能不能貼連結交一版：能交影片的人 + 導演（導演只能貼連結，上傳檔案還是製作和動畫師；跟後台 videoLinkDecision 一樣） */
export function canPasteVideoLink(p: PermInput): boolean {
  if (canAddVideo(p)) return true;
  return !!p.song && !!p.userId && effectiveRole(p) === 'director';
}

/**
 * 能不能刪 / 取消某一版：admin；交這一版的人（而且還能交這首歌的影片）
 * 導演：只有自己貼連結交的那一版（item.source = 'link'）
 */
export function canModifyVideo(p: PermInput & { item: Pick<VersionItem, 'kind' | 'byId'> & { source?: string | null } }): boolean {
  if (p.item.kind !== 'version') return false;
  if (effectiveRole(p) === 'director') {
    return !!p.userId && p.item.source === 'link' && !!p.item.byId && p.item.byId === p.userId;
  }
  if (!canAddVideo(p)) return false;
  if (effectiveRole(p) === 'admin') return true;
  return !!p.item.byId && p.item.byId === p.userId;
}

/** 刪除前確認的話：講清楚號碼不會再用 */
export function deleteVersionMessage(item: Pick<VersionItem, 'label' | 'title'>): string {
  const name = item.label || '這一版';
  return `要刪掉 ${name}${item.title ? `（${item.title}）` : ''} 嗎？\n\n`
    + '刪掉後，所有人的清單上都看不到這一版，沒辦法從畫面上救回來。\n'
    + `${name} 這個號碼不會再用：之後交的新版本號碼會繼續往上加，不會補回 ${name}。`;
}

/**
 * 還沒好的那一版（上傳中 / 複製中 / 失敗）要拿掉時問的話（站內確認對話框用）。
 * 失敗的 → 從清單拿掉；還在傳 / 複製的 → 停下來，已經傳的部分會丟掉。
 */
export function removePendingQuestion(
  v: Pick<SongVideo, 'status'>, name: string,
): { title: string; message?: string; confirmLabel: string; cancelLabel?: string; destructive: true } {
  if (v.status === 'failed') return { title: `把「${name}」從清單拿掉？`, confirmLabel: '拿掉', destructive: true };
  return {
    title: v.status === 'uploading' ? `停止上傳「${name}」？` : `停止複製「${name}」？`,
    message: '已經傳的部分會丟掉。',
    confirmLabel: v.status === 'uploading' ? '停止上傳' : '停止複製',
    cancelLabel: '繼續',
    destructive: true,
  };
}
