// 分享連結的訪客聽歌曲的音樂 — 對應 cf-worker/worker.js 的 handleShareRouter + songMusic.mjs「分享連結的訪客」
// 完整說明（每個網址、保護怎麼做、回傳格式）：docs/music-api.md 的「分享連結的訪客」
//
// 訪客只能聽：沒有上傳 / 換 / 移除。保護跟分享頁的影片一樣——
//   有密碼的連結帶通行證（getSharePublicData 回的 access.token，header x-share-access）；
//   播放網址（streamUrl）後台已經接好 ?access=（有密碼的連結）和 ?play=（禁止下載的連結），直接當 <audio> 的 src；
//   播放網址過期（幾小時）→ 再問一次 getShareSongMusic 拿新的。

import { apiBase, shareAccessHeaders, shareApiPath, shareError, type ShareRef } from './api';
import type { SongMusicSummary } from './musicApi';

/** 分享頁每首歌帶的音樂簡述（沒有播放網址、誰傳的、上傳時間；舊版後台沒有 → 這首歌沒有音樂） */
export type ShareMusicSummary = Pick<SongMusicSummary, 'id' | 'filename' | 'mime' | 'sizeBytes' | 'durationSec'>;

/** 這首歌的音樂 + 播放網址 */
export interface ShareSongMusic extends ShareMusicSummary {
  /** 相對路徑（absoluteMusicUrl 接上後台網址）；用好讀網址開的是 /api/s/<名稱>/song-music/…，網址裡沒有連結碼 */
  streamUrl: string;
}

/** /data 每首歌多的欄位（舊版 worker 沒有 → undefined = 沒有音樂） */
export interface ShareSongMusicFields {
  hasMusic: boolean;
  music: ShareMusicSummary | null;
}

/**
 * 這首歌的音樂（含播放網址）；沒有 = null。
 * access = getSharePublicData 回的 access.token（沒密碼的連結不用給）；通行證過期 → 丟 status 401（讓分享頁換新通行證）；
 * 不在分享範圍 403、連結過期 410、專案封存 404 → 丟出來，說明在 message
 */
export async function getShareSongMusic(ref: ShareRef, songId: string, access?: string): Promise<ShareSongMusic | null> {
  const r = await fetch(`${apiBase()}${shareApiPath(ref)}/songs/${encodeURIComponent(songId)}/music`, { headers: shareAccessHeaders(access) });
  if (!r.ok) throw await shareError(r);
  const data = await r.json() as { music?: ShareSongMusic | null };
  const m = data?.music;
  return m && typeof m.id === 'string' && typeof m.streamUrl === 'string' ? m : null;
}
