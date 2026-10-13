// 頁面用：目前這首歌的影片版本（清單、要播哪一版、記住選擇、複製中自動更新）。
//   成員（導演頁、動畫師工作站）：memberVersionFetcher —— 版本清單；沒有版本的歌改看舊的 Drive 影片
//   分享連結：shareVersionFetcher —— 只有最新的可播版本；沒有的話看舊的 Drive 影片
// 排順序、選哪一版的規則在 songVersions.ts。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from './api';
import type { ShareRef } from './api';
import { absoluteVideoUrl, getShareSongVersions, listSongVideos, type SongVideo } from './videoApi';
import {
  choiceFor, itemFromShareVideo, itemFromVideo, itemsFromLegacyDrive, pendingVideos, pickVersion,
  readVersionChoice, readyItems, writeVersionChoice, type VersionItem,
} from './songVersions';
import { friendlyError } from './songReview';

export interface VersionsResult {
  /** 可以播的（版本號大到小；沒有版本時是舊的 Drive 影片） */
  items: VersionItem[];
  /** 還沒好的（上傳中 / 複製中 / 失敗） */
  pending: SongVideo[];
  /** 這首歌有沒有新系統的版本（沒有 = 在用舊的 Drive 影片或什麼都沒有） */
  hasVersions: boolean;
}

export type VersionFetcher = (songId: string) => Promise<VersionsResult>;

/** 成員：版本清單；一版都沒有 → 舊的 Drive 影片（同一個專案的 Drive 檔案清單一分鐘內共用） */
export function memberVersionFetcher(projectId: string): VersionFetcher {
  let driveCache: { at: number; files: Promise<api.DriveFile[]> } | null = null;
  const driveFiles = () => {
    if (!driveCache || Date.now() - driveCache.at > 60_000) {
      const files = api.listDriveProjectFiles(projectId).catch(() => [] as api.DriveFile[]);
      driveCache = { at: Date.now(), files };
    }
    return driveCache.files;
  };
  return async (songId) => {
    const list = await listSongVideos(projectId, songId);
    const items = readyItems(list.videos.map(v => itemFromVideo(v, absoluteVideoUrl)));
    const pending = pendingVideos(list.videos);
    if (items.length > 0) return { items, pending, hasVersions: true };
    const legacy = (await driveFiles())
      .filter(f => f.songId === songId && (f.mimeType?.startsWith('video/') ?? false))
      .map(f => ({
        driveFileId: f.driveFileId,
        filename: f.filename,
        modifiedTime: f.modifiedTime,
        cachedAt: f.cachedAt,
        url: api.driveStreamUrl(f.driveFileId),
        // 舊的 Drive 直播要登入（cookie）：LED 要讀畫面 → 帶著登入狀態跨網站讀
        crossOrigin: 'use-credentials' as const,
      }));
    return { items: itemsFromLegacyDrive(legacy), pending, hasVersions: false };
  };
}

/** 分享連結：最新的可播版本（0 或 1 個）；沒有 → 舊的 Drive 影片 */
export function shareVersionFetcher(ref: ShareRef, access: string | undefined): VersionFetcher {
  return async (songId) => {
    const r = await getShareSongVersions(ref, songId, access);
    const items = readyItems(r.videos.map(v => itemFromShareVideo(v, absoluteVideoUrl)));
    if (items.length > 0) return { items, pending: [], hasVersions: true };
    const legacy = (await api.getShareSongVideos(ref, songId, access)).map(v => ({
      driveFileId: v.driveFileId,
      filename: v.filename,
      modifiedTime: v.modifiedTime,
      url: api.apiBase() + v.streamUrl,
      crossOrigin: 'anonymous' as const,
    }));
    return { items: itemsFromLegacyDrive(legacy), pending: [], hasVersions: false };
  };
}

export interface SongVersionsState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  items: VersionItem[];
  pending: SongVideo[];
  hasVersions: boolean;
  /** 要播的這一版（沒有 = null）。看到一半有新版本進來不會自己換（點一下才換） */
  selected: VersionItem | null;
  /** 選某一版（記住這個人的選擇） */
  select: (key: string) => void;
  /** 重新抓（新的播放網址、別人交了新版）；回傳抓到的 */
  reload: () => Promise<VersionsResult | null>;
}

const EMPTY: VersionsResult = { items: [], pending: [], hasVersions: false };

/**
 * songId 換了 → 馬上清掉上一首、抓這首的；reloadKey 變了（歌單上的最新版本換了）→ 重新抓。
 * 有「複製中 / 上傳中」的版本時每 5 秒再抓一次（後台靠查詢推動複製），分頁在背景時不抓。
 * storageKey(songId) → 記住這個人選的版本（localStorage）
 */
export function useSongVersions(o: {
  songId: string | null;
  fetcher: VersionFetcher | null;
  storageKey: ((songId: string) => string) | null;
  reloadKey?: unknown;
}): SongVersionsState {
  const { songId, fetcher, storageKey, reloadKey } = o;
  const [data, setData] = useState<{ songId: string | null; result: VersionsResult }>({ songId: null, result: EMPTY });
  const [status, setStatus] = useState<SongVersionsState['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  // 選了之後 +1 → 重新讀記住的選擇
  const [choiceRev, setChoiceRev] = useState(0);
  const songIdRef = useRef(songId);
  songIdRef.current = songId;
  const seqRef = useRef(0);

  const load = useCallback(async (quiet: boolean): Promise<VersionsResult | null> => {
    const sid = songIdRef.current;
    if (!sid || !fetcher) return null;
    const seq = ++seqRef.current;
    if (!quiet) setStatus('loading');
    try {
      const result = await fetcher(sid);
      if (seq !== seqRef.current || songIdRef.current !== sid) return null;
      setData({ songId: sid, result });
      setStatus('ready');
      setError(null);
      return result;
    } catch (e) {
      if (seq !== seqRef.current || songIdRef.current !== sid) return null;
      if (!quiet) {
        setStatus('error');
        setError('影片清單讀取失敗：' + friendlyError(e));
      }
      return null;
    }
  }, [fetcher]);

  // 換歌 → 先清掉上一首的（不然會閃一下上一首的影片）
  useEffect(() => {
    setData({ songId, result: EMPTY });
    setError(null);
    if (!songId || !fetcher) { setStatus('idle'); return; }
    void load(false);
  }, [songId, fetcher, load]);

  // 歌單上「最新版本」換了（別人交了新版 / 刪了）→ 安靜地重抓
  //（換歌時 reloadKey 也會跟著變，那次上面已經在抓了）
  const lastReloadRef = useRef({ songId, reloadKey });
  useEffect(() => {
    const prev = lastReloadRef.current;
    lastReloadRef.current = { songId, reloadKey };
    if (prev.songId !== songId || Object.is(prev.reloadKey, reloadKey)) return;
    void load(true);
  }, [songId, reloadKey, load]);

  // 有複製中 / 上傳中的 → 每 5 秒更新一次進度（每次查詢也會推動後台繼續複製）
  const busy = data.result.pending.some(v => v.status === 'processing' || v.status === 'uploading');
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load(true);
    }, 5000);
    return () => window.clearInterval(id);
  }, [busy, load]);

  const result = data.songId === songId ? data.result : EMPTY;
  // 打開這首歌時選哪一版：記住的那版，或最新（規則在 pickVersion）
  const picked = useMemo(() => {
    void choiceRev;
    const choice = songId && storageKey ? readVersionChoice(storageKey(songId)) : null;
    return pickVersion(result.items, choice);
  }, [result.items, songId, storageKey, choiceRev]);
  // 正在看的那一版先固定住：看到一半別人交了新版，不會突然換掉（新版會出現在清單上，點一下就換）；
  // 換歌、那一版被刪了才重新選
  const [pinned, setPinned] = useState<{ songId: string | null; key: string | null }>({ songId: null, key: null });
  const selected = useMemo(() => {
    if (pinned.songId === songId && pinned.key) {
      const still = result.items.find(it => it.key === pinned.key);
      if (still) return still;
    }
    return picked;
  }, [pinned, songId, result.items, picked]);
  useEffect(() => {
    if (!songId || !selected) return;
    if (pinned.songId !== songId || pinned.key !== selected.key) setPinned({ songId, key: selected.key });
  }, [songId, selected, pinned]);

  const select = useCallback((key: string) => {
    if (!songId) return;
    if (storageKey) writeVersionChoice(storageKey(songId), choiceFor(result.items, key));
    setPinned({ songId, key });
    setChoiceRev(n => n + 1);
  }, [songId, storageKey, result.items]);

  const reload = useCallback(() => load(true), [load]);

  return {
    status: songId ? status : 'idle',
    error,
    items: result.items,
    pending: result.pending,
    hasVersions: result.hasVersions,
    selected,
    select,
    reload,
  };
}
