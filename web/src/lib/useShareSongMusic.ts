// 分享頁：一首歌的音樂接到頁面上（訪客只能聽）。介面跟 useSongMusic（導演頁 / 編輯頁）一樣，少了「上傳 / 移除後交進來」（apply）——訪客不能改。
//
//   summary   這首歌的音樂簡述（分享頁 /data 每首歌帶的；播放網址拿到以後以後台給的為準）
//   source    'video' | 'music' | 'none'（clockSource：有影片 → 影片，不放音樂；沒影片才放音樂）
//   musicMode source === 'music'：音樂是這首歌的時間（舞台、cue 列、機關跟著音樂走）
//   player    音樂播放器（musicMode 才有載入；不是的時候是空的）
//   reload    播放網址過期了（播放器回報載入失敗）→ 重新拿網址，接著同一秒播
//
// 播放網址不在 /data 裡，要聽的時候才問後台（getShareSongMusic）：有密碼的連結帶通行證、禁止下載的連結後台會接好播放通行證。
// 問的時候出錯（通行證過期 401 等）→ 交給 onAuthError（分享頁用剛輸入的密碼換一張新的）；新的通行證拿到以後自動再問一次。
// 為什麼不直接用 useSongMusic：它問的是成員的網址（要登入），分享頁沒有登入；兩邊的保護完全分開。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ShareRef } from './api';
import type { LocalVideoState } from './localVideo';
import { absoluteMusicUrl } from './musicApi';
import { getShareSongMusic, type ShareMusicSummary, type ShareSongMusic } from './shareMusicApi';
import { clockSource, type ClockSource } from './songMusic';
import { musicPlayerKey } from './useSongMusic';
import { useMusicPlayer } from './useMusicPlayer';

/** 畫面上的字 */
export const SHARE_MUSIC_TEXT = {
  /** LED 來源那一行：沒有影片、有音樂 */
  statusNoVideo: '這首歌沒有影片，用音樂當歌的時間',
  fetchFailed: '音樂的播放網址拿不到：可能是網路斷了，或這個連結已經過期、被關掉了',
} as const;

export interface ShareSongMusicState {
  summary: ShareMusicSummary | null;
  /** 含播放網址的完整資料（musicMode 才會去拿） */
  music: ShareSongMusic | null;
  source: ClockSource;
  musicMode: boolean;
  player: LocalVideoState;
  /** 拿播放網址失敗的說明 */
  error: string | null;
  reload: () => void;
}

export function useShareSongMusic(o: {
  shareRef: ShareRef | null;
  /** 有密碼的連結：密碼對了後台發的通行證（沒密碼 = null） */
  accessToken: string | null;
  /** 現在看的歌（music = /data 每首歌帶的簡述）；null = 還沒選歌 */
  song: { id: string; music?: ShareMusicSummary | null } | null;
  /** 這首歌有影片（有影片就不放音樂） */
  hasVideo: boolean;
  /** 這首歌的影片版本讀完了沒（還沒讀完時不能確定「沒有影片」） */
  videosLoaded: boolean;
  /** 拿播放網址出錯（通行證過期 401 等）；分享頁用它換新通行證 */
  onAuthError?: (e: unknown) => void;
}): ShareSongMusicState {
  const { shareRef, accessToken, song, hasVideo, videosLoaded } = o;
  const player = useMusicPlayer();
  const songId = song?.id ?? null;
  const listed = song?.music ?? null;

  // 問過後台的結果（含播放網址）：以後台為準（剛好被換掉 / 移除了就跟著變）。
  // reloads = 使用者按了「重新載入」、新的資料已經拿到的次數（網址沒變也要照樣重載，見下面放進播放器那段）
  const [fetched, setFetched] = useState<{ songId: string; music: ShareSongMusic | null; reloads: number } | null>(null);
  const live = fetched && fetched.songId === songId ? fetched : null;
  const full = live?.music ?? null;
  const summary: ShareMusicSummary | null = songId ? (live ? full : listed) : null;
  const source = clockSource({ hasVideo, videosLoaded, hasMusic: !!summary });
  const musicMode = source === 'music';
  const reloads = live?.reloads ?? 0;

  // 錯誤記著是哪首歌的（換歌就不顯示上一首的）
  const [errState, setErrState] = useState<{ songId: string; text: string } | null>(null);
  const error = errState && errState.songId === songId ? errState.text : null;
  const [nonce, setNonce] = useState(0);
  const lastNonce = useRef(0);       // 已經處理完的「重新載入」次數（拿到新資料才算）
  const failed = useRef(false);      // 上一次拿失敗了：通行證換新時再試一次
  const authErrorRef = useRef(o.onAuthError);
  authErrorRef.current = o.onAuthError;

  const reload = useCallback(() => setNonce(n => n + 1), []);

  // 要放音樂了、還沒有（或過期了）播放網址 → 去拿
  const wantId = musicMode && summary ? summary.id : null;
  const haveId = full?.id ?? null;
  useEffect(() => {
    if (!shareRef || !songId || !wantId) return;
    const forced = nonce !== lastNonce.current;                       // 使用者按了「重新載入」
    if (haveId === wantId && !forced && !failed.current) return;      // 拿過了
    let cancelled = false;
    getShareSongMusic(shareRef, songId, accessToken ?? undefined).then(m => {
      if (cancelled) return;
      failed.current = false;
      lastNonce.current = nonce;
      setErrState(null);
      setFetched(prev => ({ songId, music: m, reloads: (prev && prev.songId === songId ? prev.reloads : 0) + (forced ? 1 : 0) }));
    }).catch(e => {
      if (cancelled) return;
      failed.current = true;
      setErrState({ songId, text: SHARE_MUSIC_TEXT.fetchFailed });
      authErrorRef.current?.(e);
    });
    return () => { cancelled = true; };
  }, [shareRef, songId, wantId, haveId, accessToken, nonce]);

  // 放進播放器：換一首 / 換新網址（過期）接著同一秒；不是音樂模式（有影片了、換歌、被移除）→ 清掉
  // 網址一樣也要重載的情況：使用者按「重新載入」（通行證在有效期間內網址不會變，網路暫時斷掉造成的失敗，重新拿到的網址跟原本一模一樣）
  const loadedUrl = useRef<string | null>(null);
  const loadedReloads = useRef(0);
  const { loadUrl, replaceUrl, clear, getSrcKey } = player;
  useEffect(() => {
    if (!musicMode || !full || !wantId || full.id !== wantId) {
      if (getSrcKey()) { clear(); loadedUrl.current = null; }
      return;
    }
    const url = absoluteMusicUrl(full.streamUrl);
    if (loadedUrl.current === url && getSrcKey() === musicPlayerKey(full.id) && loadedReloads.current === reloads) return;
    loadedReloads.current = reloads;
    const opts = { key: musicPlayerKey(full.id), name: full.filename };
    if (getSrcKey() === opts.key) replaceUrl(url, opts);   // 同一首換新網址（或網址沒變、重新載入一次）
    else loadUrl(url, opts);
    loadedUrl.current = url;
  }, [musicMode, full, wantId, reloads, loadUrl, replaceUrl, clear, getSrcKey]);

  // 離開音樂模式（有影片了、換歌）時停下來
  useEffect(() => {
    if (!musicMode && player.playing) player.pause();
  }, [musicMode, player]);

  return { summary, music: full, source, musicMode, player, error, reload };
}
