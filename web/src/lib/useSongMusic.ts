// 一首歌的音樂接到頁面上：目前這首歌有沒有音樂、要不要放音樂（沒影片才放）、放進音樂播放器。
//   編輯頁（製作）和導演頁共用；播放器的介面跟影片一樣（useMusicPlayer.ts），所以頁面可以把它當成「歌的時間」的來源。
//
//   summary   這首歌的音樂（歌單帶的簡短資料；本機剛上傳 / 移除的先算數，歌單之後跟上就交給歌單）
//   source    'video' | 'music' | 'none'（clockSource：有影片 → 影片，不放音樂；沒影片才放音樂）
//   musicMode source === 'music'：音樂是這首歌的時間
//   player    音樂播放器（musicMode 才有載入；不是的時候是空的）
//   apply     上傳 / 移除成功後把結果交進來
//   reload    播放網址過期了（播放器回報載入失敗）→ 重新拿網址，接著同一秒播

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LocalVideoState } from './localVideo';
import { absoluteMusicUrl, getSongMusic, musicErrorText, type SongMusic, type SongMusicSummary } from './musicApi';
import { clockSource, musicSummaryOf, type ClockSource } from './songMusic';
import { useMusicPlayer } from './useMusicPlayer';

export interface SongMusicState {
  summary: SongMusicSummary | null;
  /** 含播放網址的完整資料（musicMode 才會去拿） */
  music: SongMusic | null;
  source: ClockSource;
  musicMode: boolean;
  player: LocalVideoState;
  /** 拿播放網址失敗的說明 */
  error: string | null;
  apply: (m: SongMusic | SongMusicSummary | null) => void;
  reload: () => void;
}

/** 播放器裡這首音樂的 key（同一首再載一次不會從頭播） */
export const musicPlayerKey = (musicId: string) => `m:${musicId}`;

interface Override { songId: string; base: string | null; music: SongMusicSummary | null }

export function useSongMusic(o: {
  projectId: string | undefined;
  /** 現在看的歌；null = 還沒選歌 */
  song: { id: string; music?: SongMusicSummary | null } | null;
  /** 這首歌有影片（有影片就不放音樂） */
  hasVideo: boolean;
  /** 這首歌的影片版本讀完了沒（還沒讀完時不能確定「沒有影片」） */
  videosLoaded: boolean;
}): SongMusicState {
  const { projectId, song, hasVideo, videosLoaded } = o;
  const player = useMusicPlayer();
  const songId = song?.id ?? null;
  const listed = song?.music ?? null;

  // 本機剛上傳 / 移除的（override）：在歌單跟上（或別人又改了）之前先算數；full = 含播放網址的完整資料。
  // 兩個放在同一個狀態裡一起換（分開換會有一瞬間「換了音樂、卻還拿著舊的網址」，多問一次後台）。
  // reloads = 使用者按了「重新載入」、而且新的資料已經拿到的次數（網址沒變也要照樣重載，見下面放進播放器那段）
  const [local, setLocal] = useState<{ override: Override | null; full: SongMusic | null; reloads: number }>({ override: null, full: null, reloads: 0 });
  const { override, full, reloads } = local;
  const effective = override && override.songId === songId && override.base === (listed?.id ?? null) ? override.music : listed;
  const summary = songId ? effective : null;
  const source = clockSource({ hasVideo, videosLoaded, hasMusic: !!summary });
  const musicMode = source === 'music';

  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const lastNonce = useRef(0);

  const apply = useCallback((m: SongMusic | SongMusicSummary | null) => {
    if (!songId) return;
    setLocal(l => ({ ...l, override: { songId, base: listed?.id ?? null, music: m ? musicSummaryOf(m) : null }, full: m && 'streamUrl' in m ? m : null }));
    setError(null);
  }, [songId, listed?.id]);

  const reload = useCallback(() => setNonce(n => n + 1), []);

  // 要放音樂了、還沒有（或過期了）播放網址 → 去拿
  const wantId = musicMode && summary ? summary.id : null;
  const haveId = full?.id ?? null;
  const listedId = listed?.id ?? null;
  useEffect(() => {
    if (!projectId || !songId || !wantId) return;
    if (haveId === wantId && nonce === lastNonce.current) return;
    const forced = nonce !== lastNonce.current;   // 使用者按了「重新載入」
    lastNonce.current = nonce;
    let cancelled = false;
    getSongMusic(projectId, songId).then(m => {
      if (cancelled) return;
      setError(null);
      const bump = (l: { reloads: number }) => (forced ? l.reloads + 1 : l.reloads);
      if (m?.id === wantId) { setLocal(l => ({ ...l, full: m, reloads: bump(l) })); return; }
      // 後台說的跟畫面上以為的不一樣（剛好被別人換掉 / 移除了）→ 以後台為準
      setLocal(l => ({ override: { songId, base: listedId, music: m ? musicSummaryOf(m) : null }, full: m, reloads: bump(l) }));
    }).catch(e => {
      if (!cancelled) setError(musicErrorText(e));
    });
    return () => { cancelled = true; };
  }, [projectId, songId, wantId, haveId, nonce, listedId]);

  // 放進播放器：換一首 / 換新網址（過期）接著同一秒；不是音樂模式（有影片、換歌、被移除）→ 清掉
  // 網址一樣也要重載的情況：使用者按「重新載入」。通行證在有效期間內網址不會變，網路暫時斷掉造成的失敗，
  // 重新拿到的網址跟原本一模一樣；如果只比網址，按了什麼都不會發生，播放器永遠停在錯誤上。
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

  return { summary, music: full, source, musicMode, player, error, apply, reload };
}
