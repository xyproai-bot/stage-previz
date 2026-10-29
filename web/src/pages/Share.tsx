import { CueNumBadge } from '../components/CueNumBadge';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { Cue, CueState, SharePublicData, ShareRef, SongComment } from '../lib/api';
import { defaultVisible, isDefaultHidden } from '../lib/defaultHidden';
import StageScene, { type StageViewApi } from '../components/StageScene';
import AnnotationLayer from '../components/AnnotationLayer';
import GuestCommentsPanel from '../components/GuestCommentsPanel';
import { isTouchDevice, revealStage, useReviewSession } from '../lib/review/useReviewSession';
import { playheadCommentId } from '../lib/review/playhead';
import { formatClockShort } from '../lib/review/timecode';
import MiniPlayer from '../components/MiniPlayer';
import SongVersionBar, { versionByline } from '../components/SongVersionBar';
import LedSourceSwitch, { readLedSource, saveLedSource, type LedSource } from '../components/LedSourceSwitch';
import { normalizeLookSettings } from '../lib/stageLook/lookSettings';
import { normalizeMaterialOverrides } from '../lib/stageLook/materialOverrides';
import { normalizeHomeView } from '../lib/homeView';
import { normalizeStageProps } from '../lib/stageProps';
import { normalizeCameraBookmarks } from '../lib/cameraBookmarks';
import { songTitle } from '../lib/songCode';
import { normalizeLedCanvas } from '../lib/ledCanvas';
import { normalizeOffPieces } from '../lib/ledOffPieces';
import { formatClock, useLocalVideo } from '../lib/localVideo';
import { localMediaKey, skippedFilesMessage, useLocalMedia } from '../lib/localMedia';
import { toast } from '../lib/toast';
import { cueTransitionSeconds } from '../lib/cueTiming';
import { useStageFullscreen } from '../lib/useStageFullscreen';
import { buildCueNav, buildSongNav } from '../lib/stageShow';
import { useVideoCueTimeline } from '../lib/videoCueSync';
import { useShareMechanisms } from '../lib/mechanisms/useMechanisms';
import { shareVersionFetcher, useSongVersions, type VersionFetcher } from '../lib/useSongVersions';
import { versionChoiceStorageKey } from '../lib/songVersions';
import { noSourceStatus, resolveShareSource, shareSourceStorageKey } from '../lib/shareSource';
import { ndiShortLabel, type NdiGuide } from '../lib/ndiSteps';
import { HELP_ANCHORS, helpUrl } from '../lib/helpLinks';
import ShareSetlist from './ShareSetlist';
import Icon from '../components/Icon';
import { shouldWatermarkGuest } from '../lib/watermark/policy';
import { useWatermarkScope } from '../lib/watermark/store';
import type { WatermarkIdentity } from '../lib/watermark/text';
import { applyVideoGuards, shouldBlockMediaEvent } from '../lib/watermark/downloadGuard';
import { SHARE_PAGE_WATERMARK_NOTE } from '../lib/watermark/copy';
import { GUEST_NAME_EVENT, readGuestName } from '../lib/review/guestApi';
import {
  BookOpen, Image, LoaderCircle, Lock, Pause, Play, Repeat, Stamp, TriangleAlert, Volume2, VolumeX, X,
} from 'lucide-react';
import './Share.css';


/** 這首歌每個 cue 的舞台位置先全部開始抓（點 cue / 影片走到那裡時馬上有） */
function prefetchCueStates(ref: ShareRef, songId: string, list: Cue[], access: string | undefined) {
  const cache = new Map<string, Promise<CueState[]>>();
  for (const c of list) {
    const p = api.getShareCueStates(ref, songId, c.id, access);
    p.catch(() => cache.delete(c.id));  // 失敗就丟掉，用到時再抓一次
    cache.set(c.id, p);
  }
  return cache;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 公開分享連結 viewer — 無需登入。
 * 路由：/share/:token（舊式網址）或 /s/:slug（好讀網址），畫面一模一樣
 * 有交影片的歌 → LED 放最新的一版（V3…）；動畫師開著 AE → 按「AE 即時」看即時畫面；
 * 沒開 AE → 拖影片 / 圖片進來放在 LED 上（本地檔案）
 */
export default function Share() {
  const { token, slug } = useParams();
  // 用哪種網址打開的 → 後端就用那一種去查（好讀網址只查網址名稱、舊式只查連結碼）
  const shareRef = useMemo<ShareRef | null>(
    () => (slug ? { kind: 'slug', key: slug } : token ? { kind: 'token', key: token } : null),
    [slug, token],
  );
  const [data, setData] = useState<SharePublicData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [submittedPwd, setSubmittedPwd] = useState<string | null>(null);
  /** 有密碼的連結：密碼對了後台發的通行證，之後的請求都帶它（密碼只送一次） */
  const [accessToken, setAccessToken] = useState<string | null>(null);
  /** 密碼框下面的提示（密碼不對 / 錯太多次被擋） */
  const [pwdError, setPwdError] = useState<string | null>(null);
  // 抓影片清單時也要能換通行證（下面才定義，先用 ref 接）
  const onShareFetchErrorRef = useRef<(e: unknown) => void>(() => {});

  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  // cues 是哪首歌的：剛切歌、新的還沒讀到時不能拿上一首的 cue 去問位置（以前每切一次歌就有一個 404）
  const [cuesSongId, setCuesSongId] = useState<string | null>(null);
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);
  const [cueStates, setCueStates] = useState<CueState[]>([]);

  // ── LED 畫面來源 ──
  // 一頁只有一個 <video>：歌曲影片、本地檔案輪流用它（同時是 LED 貼圖、也是小視窗的畫面）
  const local = useLocalVideo();
  const media = useLocalMedia(local);
  // 這個人在這個分享連結上次自己選的來源（影片 / AE 即時 / 本地檔案；每個連結分開記）。
  // 沒選過 = 有影片就放影片，沒有就什麼都不放（測試圖）；AE 即時要自己按了才連（lib/shareSource.ts）
  const sourceKey = shareRef ? shareSourceStorageKey(shareRef) : null;
  const [sourcePref, setSourcePref] = useState<LedSource | null>(() => (sourceKey ? readLedSource(sourceKey) : null));
  const [sourcePrefFor, setSourcePrefFor] = useState(sourceKey);
  if (sourcePrefFor !== sourceKey) {
    // 同一個分頁換到另一個分享連結 → 換成那個連結記的
    setSourcePrefFor(sourceKey);
    setSourcePref(sourceKey ? readLedSource(sourceKey) : null);
  }
  // AE 即時現在卡在哪一步（3D 畫面上的檢查清單卡片會帶著做；這裡只顯示一句狀態）
  const [ndiGuide, setNdiGuide] = useState<NdiGuide | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // 這首歌每個 cue 的舞台位置先全部抓好 → 點 cue 馬上開始動，不用等網路
  const cueStatesCacheRef = useRef<Map<string, Promise<CueState[]>>>(new Map());
  // 分頁切回來重抓 cue 時 +1 → 舞台位置、影片時間軸跟著換新的
  const [cueRefresh, setCueRefresh] = useState(0);

  const chooseSource = useCallback((s: LedSource) => {
    setSourcePref(s);
    if (sourceKey) saveLedSource(sourceKey, s);
  }, [sourceKey]);

  // 拖進來 / 選的檔案加進清單，第一個馬上放在 LED 上；不是影片或圖片的略過
  const addFiles = useCallback((files: FileList | null | undefined) => {
    if (!files || files.length === 0) return;
    const { rejected, shown } = media.add(Array.from(files));
    const skipped = skippedFilesMessage(rejected);
    if (skipped) toast.warn(skipped);
    if (shown) chooseSource('file');
  }, [media, chooseSource]);

  // ── 歌曲影片（最新的可播版本；沒有的話舊的 Drive 影片）──
  const fetchVersions = useMemo<VersionFetcher | null>(() => {
    if (!shareRef) return null;
    const f = shareVersionFetcher(shareRef, accessToken ?? undefined);
    return (songId) => f(songId).catch((e) => { onShareFetchErrorRef.current(e); throw e; });
  }, [shareRef, accessToken]);
  const projectIdForKey = data?.project.id ?? '';
  const versionStorageKey = useCallback(
    (songId: string) => versionChoiceStorageKey(`share:${shareRef?.key ?? ''}`, projectIdForKey, songId),
    [shareRef, projectIdForKey],
  );
  const versions = useSongVersions({
    songId: data ? selectedSongId : null,
    fetcher: fetchVersions,
    storageKey: versionStorageKey,
    reloadKey: cueRefresh,
  });
  const hasVideo = versions.items.length > 0;
  const versionsSettled = versions.status !== 'loading';
  // 選了「影片」（或沒選過）但這首歌沒有影片 → 什麼都不放（LED 測試圖、上面寫「這首歌還沒有影片」）
  const source = resolveShareSource({ pref: sourcePref, hasVideo, settled: versionsSettled });
  const selectedVersion = source === 'version' ? versions.selected : null;

  // 切到某一版 → 載進播放器（同一版不重載，不會從頭播）
  useEffect(() => {
    if (!selectedVersion?.url) return;
    if (local.getSrcKey() === selectedVersion.key) return;
    local.loadUrl(selectedVersion.url, { key: selectedVersion.key, name: selectedVersion.label, crossOrigin: selectedVersion.crossOrigin });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVersion?.key, local.loadUrl, local.getSrcKey]);

  // 切來源：AE 即時 → 影片先暫停（不然聲音還會在背景播）；
  // 回到本地檔案 → 正在放的那支被換掉了就重新載入；清單裡沒有影片 → 歌曲影片也先暫停；
  // 什麼都不放（換到沒有影片的歌）→ 上一首的影片不要繼續放
  const { pause: pausePlayer, getSrcKey, clear: clearPlayer } = local;
  const { reshow: reshowMedia } = media;
  useEffect(() => {
    if (source === 'ndi') pausePlayer();
    else if (source === 'file') {
      reshowMedia();
      if (!getSrcKey()?.startsWith('local:')) pausePlayer();
    } else if (source === null) {
      const k = getSrcKey();
      if (k && !k.startsWith('local:')) clearPlayer();
      else pausePlayer();
    }
  }, [source, pausePlayer, reshowMedia, getSrcKey, clearPlayer]);

  // 影片播放網址過期 / 網路斷掉 → 拿新網址接著同一秒播
  const retryVersion = useCallback(async () => {
    const r = await versions.reload();
    const it = r?.items.find(x => x.key === selectedVersion?.key) ?? versions.selected;
    if (it?.url) local.replaceUrl(it.url, { key: it.key, name: it.label, crossOrigin: it.crossOrigin });
  }, [versions, selectedVersion?.key, local]);

  // 正在 LED 上放影片（歌曲影片 / 本地影片；不是圖片 / AE）→ 影片時間軸、自動切 cue 才開
  const fileVideoMode = source === 'file' && media.active?.kind === 'video' && local.srcKey === localMediaKey(media.active.id);
  const versionVideoMode = !!selectedVersion && local.srcKey === selectedVersion.key;
  const videoMode = fileVideoMode || versionVideoMode;

  // 本地檔案：↑ / ↓ 換清單上一個 / 下一個（焦點在輸入框、拉桿、走路模式時不搶方向鍵）
  const stepMedia = media.step;
  useEffect(() => {
    if (source !== 'file') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || document.pointerLockElement) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (stepMedia(e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [source, stepMedia]);

  const load = useCallback(async (pwd?: string) => {
    if (!shareRef) return;
    setLoading(true);
    setError(null);
    try {
      const d = await api.getSharePublicData(shareRef, pwd);
      setData(d);
      setAccessToken(d.access?.token ?? null);
      setRequiresPassword(false);
      setPwdError(null);
      const firstSong = d.songs[0];
      if (firstSong) setSelectedSongId(firstSong.id);
    } catch (e) {
      const status = (e as { status?: number }).status;
      const reqPwd = (e as { requiresPassword?: boolean }).requiresPassword;
      if (status === 401 && reqPwd) {
        // 第一次打開（還沒輸入）不算錯；輸入了還是 401 = 密碼不對
        setRequiresPassword(true);
        setPwdError(pwd ? '密碼不對，再試一次' : null);
      } else if (status === 429 && !pwd) {
        // 沒帶密碼就被擋 = 這台電腦一直打開不存在的好讀網址，被擋一陣子 → 直接說原因
        setError(e instanceof Error && e.message && !e.message.startsWith('HTTP ') ? e.message : '請稍後再試');
      } else if (status === 429) {
        // 密碼錯太多次被擋一陣子：留在密碼畫面說明（不是連結壞了）
        setRequiresPassword(true);
        setPwdError(e instanceof Error && e.message && !e.message.startsWith('HTTP ') ? e.message : '錯太多次了，請稍後再試');
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }, [shareRef]);

  useEffect(() => { load(); }, [load]);

  // 通行證過期（開著頁面超過 8 小時）→ 用剛剛輸入的密碼再換一張；換到之後下面的抓資料會自動重跑。
  // 密碼被改了 → 回到密碼畫面
  const renewingRef = useRef(false);
  const submittedPwdRef = useRef(submittedPwd);
  submittedPwdRef.current = submittedPwd;
  const onShareFetchError = useCallback((e: unknown) => {
    const pwd = submittedPwdRef.current;
    if ((e as { status?: number }).status !== 401 || !shareRef || !pwd || renewingRef.current) return;
    renewingRef.current = true;
    api.getSharePublicData(shareRef, pwd)
      .then(d => setAccessToken(d.access?.token ?? null))
      .catch((err) => {
        if ((err as { status?: number }).status !== 401) return;  // 網路一時不通 → 下次再試
        setPwdError('密碼已更改，請重新輸入');
        setRequiresPassword(true);
      })
      .finally(() => { renewingRef.current = false; });
  }, [shareRef]);
  onShareFetchErrorRef.current = onShareFetchError;

  // 切歌 → 拉 cues（影片清單在 useSongVersions）
  useEffect(() => {
    if (!shareRef || !selectedSongId) return;
    let cancelled = false;
    const access = accessToken ?? undefined;
    cueStatesCacheRef.current = new Map();
    api.getShareSongCues(shareRef, selectedSongId, access).then(list => {
      if (cancelled) return;
      cueStatesCacheRef.current = prefetchCueStates(shareRef, selectedSongId, list, access);
      setCues(list);  // 新的一首歌 → 影片時間重新對 cue（useVideoCueTimeline）
      setCuesSongId(selectedSongId);
      setSelectedCueId(list[0]?.id ?? null);
    }).catch((e) => { if (!cancelled) { setCues([]); onShareFetchError(e); } });
    return () => { cancelled = true; };
  }, [shareRef, selectedSongId, accessToken, onShareFetchError]);

  // 分頁切回來 → 重抓這首歌的 cue 和位置（管理頁改了淡入淡出 / 對應影片時間，不用重新整理就跟上）
  // 現在選的 cue 和正在播的影片都不動
  useEffect(() => {
    if (!shareRef || !selectedSongId) return;
    let cancelled = false;
    let lastTs = 0;
    const access = accessToken ?? undefined;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastTs < 2000) return;  // 切分頁時 visibilitychange 和 focus 會一起來
      lastTs = now;
      api.getShareSongCues(shareRef, selectedSongId, access).then(list => {
        if (cancelled) return;
        cueStatesCacheRef.current = prefetchCueStates(shareRef, selectedSongId, list, access);
        setCues(prev => sameJson(prev, list) ? prev : list);
        setSelectedCueId(prev => (prev && list.some(c => c.id === prev)) ? prev : (list[0]?.id ?? null));
        setCueRefresh(n => n + 1);
      }).catch((e) => { if (!cancelled) onShareFetchError(e); /* 網路一時不通就下次再抓 */ });
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [shareRef, selectedSongId, accessToken, onShareFetchError]);

  // 切 cue → 拉 states
  useEffect(() => {
    if (!shareRef || !selectedSongId || !selectedCueId || cuesSongId !== selectedSongId) { setCueStates([]); return; }
    let cancelled = false;  // 連點好幾個 cue 時，只套最後點的那個
    const cache = cueStatesCacheRef.current;
    let p = cache.get(selectedCueId);
    if (!p) {
      p = api.getShareCueStates(shareRef, selectedSongId, selectedCueId, accessToken ?? undefined);
      cache.set(selectedCueId, p);
    }
    // 內容一樣就不換（分頁切回來重抓時，沒改的話舞台不用重算）
    p.then(list => { if (!cancelled) setCueStates(prev => sameJson(prev, list) ? prev : list); })
      .catch((e) => { cache.delete(selectedCueId); if (!cancelled) { setCueStates([]); onShareFetchError(e); } });
    return () => { cancelled = true; };
  }, [shareRef, selectedSongId, selectedCueId, cuesSongId, accessToken, cueRefresh, onShareFetchError]);

  // 沒選 cue 時用 default
  const viewportStates: CueState[] = useMemo(() => {
    if (selectedCueId && cueStates.length > 0) return cueStates;
    if (!data) return [];
    return data.stageObjects.map(o => ({
      objectId: o.id,
      meshName: o.meshName,
      displayName: o.displayName,
      category: o.category,
      order: o.order,
      locked: o.locked,
      default: { position: o.defaultPosition, rotation: o.defaultRotation, scale: o.defaultScale },
      defaultHidden: isDefaultHidden(o),
      override: null,
      effective: { position: o.defaultPosition, rotation: o.defaultRotation, scale: o.defaultScale, visible: defaultVisible(o) },
    }));
  }, [selectedCueId, cueStates, data]);

  const selectedCue = useMemo(() => cues.find(c => c.id === selectedCueId), [cues, selectedCueId]);

  // 現場燈光：一律照專案預設（動畫師只看，不能調）
  const projectLook = useMemo(() => normalizeLookSettings(data?.lookSettings), [data]);
  const materialOverrides = useMemo(() => normalizeMaterialOverrides(data?.materialOverrides), [data]);
  const homeView = useMemo(() => normalizeHomeView(data?.homeView ?? null), [data]);
  // 比例尺的樂手和器材（導演 / 製作擺的；訪客只能看）
  const stageProps = useMemo(() => normalizeStageProps(data?.stageProps), [data]);
  // 視角書籤（導演 / 製作存的；訪客點了飛過去，不能改）
  const cameraBookmarks = useMemo(() => normalizeCameraBookmarks(data?.cameraBookmarks), [data]);
  const ledCanvas = useMemo(() => normalizeLedCanvas(data?.ledCanvas ?? null), [data]);
  const ledOffPieces = useMemo(() => normalizeOffPieces(data?.ledOffPieces), [data]);

  // ── 浮水印 / 禁止下載（0038；舊連結和舊版後台都是關）──
  // 浮水印：3D 畫面和小播放器（還有全螢幕預演）印上「誰在看 + 現在的時間」；訪客寫過留言的名字就印名字，沒有就印連結名稱 + 編號
  const protection = data?.protection;
  const watermarkOn = shouldWatermarkGuest(protection);
  const noDownload = !!protection?.noDownload;
  const [guestName, setGuestName] = useState(readGuestName);
  useEffect(() => {
    const sync = () => setGuestName(readGuestName());
    window.addEventListener(GUEST_NAME_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => { window.removeEventListener(GUEST_NAME_EVENT, sync); window.removeEventListener('storage', sync); };
  }, []);
  const watermarkIdentity = useMemo<WatermarkIdentity | null>(
    () => (watermarkOn && protection
      ? { kind: 'guest', guestName: guestName || null, linkName: protection.linkName, linkId: protection.linkId }
      : null),
    [watermarkOn, protection, guestName],
  );
  useWatermarkScope(watermarkIdentity);
  // 禁止下載：影片拿掉瀏覽器自己的下載鈕；有浮水印的影片也不能浮出去（子母畫面）
  const playerVideo = local.video;
  useEffect(() => {
    applyVideoGuards(playerVideo, { noDownload, watermark: watermarkOn });
  }, [playerVideo, noDownload, watermarkOn]);
  // 右鍵「另存」、把畫面拖出去存：打在畫面（影片、3D 舞台、圖片）上才擋，留言框照常能用右鍵
  const blockMediaEvent = useCallback((e: React.SyntheticEvent) => {
    if (shouldBlockMediaEvent(e.target)) e.preventDefault();
  }, []);

  // ── LED 上在放影片（歌曲影片 / 本地影片）→ 舞台、cue 列跟著影片時間走 ──
  // cue 在「對應影片時間」剛好到位，提前「轉場」秒數等速出發；暫停就停在半路、拉時間軸就跟著退。
  // 手動點了沒設時間的 cue → 舞台照那個 cue，留到影片走進下一段才回到時間軸（規則在 videoCueSync）
  const statesFor = useCallback((id: string) => cueStatesCacheRef.current.get(id) ?? null, []);
  // 機關：定義跟著 /data 來，每首歌的位置抓一次；播影片時跟著影片時間（只看，沒有提醒）
  const mech = useShareMechanisms({
    shareRef, mechanisms: (data as { mechanisms?: unknown } | null)?.mechanisms, songId: selectedSongId, accessToken,
    cues, selectedCueId, refreshKey: cueRefresh, video: local.video,
  });
  // 還沒設時間的正式 cue 用暫排的時間（跟機關同一份，lib/provisionalCues.ts）
  const { poseAtFrame, selectCueByUser: selectCue } = useVideoCueTimeline({
    cues: mech.plannedCues,
    statesFor,
    refreshKey: cueRefresh,
    resetKey: selectedSongId,
    active: videoMode,
    ready: local.ready,
    video: local.video,
    time: local.time,
    selectedCueId,
    onSelectCue: setSelectedCueId,
    seek: local.seek,
  });

  // ── 審片的播放控制（空白鍵、J / K / L、逐格、速度、時間碼）；製作打開「允許看的人留言」→ 還有留言、區段、畫記 ──
  const allowComments = !!data?.allowComments;
  const viewApiRef = useRef<StageViewApi | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [guestComments, setGuestComments] = useState<SongComment[]>([]);
  const [pendingCommentTime, setPendingCommentTime] = useState<number | null>(null);
  useEffect(() => { setGuestComments([]); }, [selectedSongId]);
  const cueStep = useCallback((dir: 1 | -1) => {
    if (!cues.length) return;
    const idx = cues.findIndex(c => c.id === selectedCueId);
    const next = dir > 0 ? (idx < 0 ? 0 : Math.min(idx + 1, cues.length - 1)) : (idx <= 0 ? 0 : idx - 1);
    selectCue(cues[next]);
  }, [cues, selectedCueId, selectCue]);
  // 手機：留言面板平常收在底下；要打字（畫好記號、「在 0:12 加留言」）時請它打開
  const [openNonce, setOpenNonce] = useState(0);
  const focusComposer = useCallback(() => {
    setOpenNonce(n => n + 1);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }));
  }, []);
  const session = useReviewSession({
    player: local, videoActive: versionVideoMode, resetKey: selectedSongId, viewApiRef,
    versions: { items: versions.items, currentKey: selectedVersion?.key ?? null, select: versions.select },
    beforeOpenVersion: () => chooseSource('version'),
    cueId: selectedCueId, onCueStep: cueStep, onFocusComposer: allowComments ? focusComposer : undefined,
    // 圖片貼到 3D 畫面上之後：觸控裝置把 3D 畫面捲回來才看得到（手機的留言面板由 GuestCommentsPanel 收下去）
    onStickerPlaced: () => { if (isTouchDevice()) revealStage(stageRef.current); },
  });
  const guestRoots = useMemo(() => guestComments.filter(c => !c.parentId), [guestComments]);
  const activeCommentId = versionVideoMode && allowComments ? playheadCommentId(guestRoots, local.time) : null;
  const openedComment = session.selectedId ? guestComments.find(c => c.id === session.selectedId) ?? null : null;
  const stageRef = useRef<HTMLDivElement>(null);
  // 全螢幕預演（給客戶看的簡報畫面）：全螢幕套在 3D 舞台外面這一層，不是 3D 舞台自己——
  // 換歌時 3D 舞台（key 是歌的 id）會整個重建，套在它身上的全螢幕會被瀏覽器退出；外層不會被換掉，所以換歌後還在全螢幕
  const stageShowCtl = useStageFullscreen(stageRef, true);
  const openComment = useCallback((c: SongComment) => {
    void session.open(c);
    revealStage(stageRef.current);
    const el = document.getElementById(`comment-${c.id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      el.classList.add('song-comment--flash');
      setTimeout(() => el.classList.remove('song-comment--flash'), 1500);
    }
  }, [session]);
  const startDraw = useCallback(() => {
    if (!session.draft.start()) return;
    if (isTouchDevice()) revealStage(stageRef.current);
    else focusComposer();
  }, [session.draft, focusComposer]);

  if (loading) return <div className="share-loading"><Icon icon={LoaderCircle} size="lg" spin /> 載入中…</div>;

  if (requiresPassword) {
    return (
      <div className="share-pwd">
        <h1><Icon icon={Lock} size="lg" /> 此分享需要密碼</h1>
        <form onSubmit={(e) => { e.preventDefault(); setSubmittedPwd(password); load(password); }}>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="輸入分享密碼"
            autoFocus
          />
          <button type="submit" className="btn btn--primary">解鎖</button>
        </form>
        {pwdError && <p className="share-pwd__error" role="alert">{pwdError}</p>}
      </div>
    );
  }

  if (error) {
    return (
      <div className="share-error">
        <h1><Icon icon={TriangleAlert} size="lg" /> 分享連結無效</h1>
        <p>{error}</p>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="share" onContextMenu={noDownload ? blockMediaEvent : undefined} onDragStart={noDownload ? blockMediaEvent : undefined}>
      <header className="share-top">
        <span className="share-top__brand"><span className="brand-mark" aria-hidden="true" />STAGE PREVIZ</span>
        <span className="share-top__title">{data.project.name}</span>
        {watermarkOn && <span className="share-top__wm"><Icon icon={Stamp} size="xs" /> {SHARE_PAGE_WATERMARK_NOTE}</span>}
        <span className="grow" />
        {/* 開新分頁：舞台、AE 即時連線都不會不見 */}
        <a className="share-top__help" href={helpUrl()} target="_blank" rel="noopener" title="使用說明" aria-label="使用說明"><Icon icon={BookOpen} /><span className="share-top__help-label"> 使用說明</span></a>
        <span className="share-top__hint">{data.allowComments ? '公開預覽 · 可以留言' : '公開預覽 · 唯讀'}</span>
      </header>
      {/* 手機：標題列放不下，這句改放在標題列下面一條細的 */}
      {watermarkOn && <div className="share-wm-strip" role="note"><Icon icon={Stamp} size="xs" /> {SHARE_PAGE_WATERMARK_NOTE}</div>}

      {/* 檔案拖到頁面哪裡都收（左邊清單、舞台都可以）；清單裡拖曳排順序的不算（沒有 'Files'） */}
      <div
        className="share-body"
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false); }}
        onDrop={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        {/* 左邊欄：歌曲（多首歌才有）在上、本地檔案清單（選了本地檔案才有）在下；兩個都沒有 → 舞台吃滿寬度 */}
        {((data.songs.length > 1 && !data.restrictedToSongId) || source === 'file') && (
          <aside className="share-side">
            {data.songs.length > 1 && !data.restrictedToSongId && (
              <section className="share-songs">
                <div className="share-side__title">歌曲</div>
                <ul>
                  {data.songs.map(s => (
                    <li key={s.id}>
                      <button
                        className={'share-songs__item' + (s.id === selectedSongId ? ' is-active' : '')}
                        onClick={() => setSelectedSongId(s.id)}
                      >
                        {s.code && <span className="share-songs__code">{s.code}</span>}
                        {s.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {source === 'file' && (
              <ShareSetlist
                items={media.items}
                activeId={media.active?.id ?? null}
                activePlaying={local.playing}
                activeDuration={local.duration}
                fileDragOver={dragOver}
                onSelect={media.select}
                onRemove={media.remove}
                onMove={media.move}
                onAddFiles={addFiles}
              />
            )}
          </aside>
        )}

        <div className="share-center">
        <main className="share-stage">
          <LedSourceSwitch
            source={source}
            onChange={chooseSource}
            showVersion={hasVideo}
            versionLabel={versions.items[0]?.label ?? null}
            status={source === 'ndi'
              ? (!ndiGuide ? '連線中…'
                : ndiGuide.step === 'live'
                ? <><span className="ndi-dot ndi-dot--on" aria-hidden="true" /> {ndiGuide.source ?? 'AE'}{ndiGuide.fps != null ? ` · ${ndiGuide.fps} fps` : ''}</>
                : ndiShortLabel(ndiGuide))
              : source === null
              ? noSourceStatus(versions.status === 'error' ? versions.error : null)
              : source === 'version'
              ? (selectedVersion
                ? `${local.playing ? '播放中' : '暫停'} · ${selectedVersion.label}${selectedVersion.title ? ` · ${selectedVersion.title}` : ''}`
                : versions.status === 'loading' ? '讀取影片中…' : '這首歌還沒有影片')
              : media.active?.kind === 'video' ? <><Icon icon={local.playing ? Play : Pause} size="xs" /> {media.active.name}</>
              : media.active ? <><Icon icon={Image} size="xs" /> {media.active.name}</>
              : media.items.length > 0 ? '點清單裡的檔案，放到 LED 上' : '還沒選檔案'}
          />

          {/* 分享連結看得到最新的一版；舊的 Drive 影片有好幾個時可以選 */}
          {source === 'version' && hasVideo && (
            <SongVersionBar
              status={versions.status}
              error={versions.error}
              items={versions.items}
              selectedKey={selectedVersion?.key ?? null}
              onSelect={versions.select}
              pending={[]}
              jobs={[]}
              ledCanvas={ledCanvas}
            />
          )}

          {selectedSongId && data.stageObjects.length > 0 ? (
            <div className="share-stage__scene" ref={stageRef}>
              <StageScene
                key={selectedSongId}
                states={viewportStates}
                stageObjects={data.stageObjects}
                selectedObjectIds={[]}
                onSelect={() => {}}
                onTransform={() => {}}
                cueName={selectedCue?.name}
                modelUrl={data.modelUrl ? api.apiBase() + data.modelUrl : null}
                toolbarMode="viewer"
                hideDownloads={noDownload}
                cueKey={selectedCueId}
                crossfadeSeconds={cueTransitionSeconds(selectedCue)}
                scaleCorrection={data.scaleCorrection ?? 1}
                stageProps={stageProps}
                bookmarkScope={data.project.id}
                cameraBookmarks={cameraBookmarks}
                stageShow={{
                  title: (() => { const s = data.songs.find(x => x.id === selectedSongId); return s ? songTitle(s) : undefined; })(),
                  transport: videoMode ? { playing: local.playing, time: local.time, duration: local.duration, onTogglePlay: local.togglePlay } : undefined,
                  controller: stageShowCtl,
                  // 連結只開放一首歌（restrictedToSongId）或只有一首 → 沒有換歌
                  songNav: data.restrictedToSongId ? undefined : buildSongNav(data.songs.map(s => ({ id: s.id, label: songTitle(s) })), selectedSongId, setSelectedSongId),
                  cueNav: buildCueNav(cuesSongId === selectedSongId ? cues : [], selectedCueId, cueStep),
                }}
                {...mech.sceneProps}
                lookSettings={projectLook}
                materialOverrides={materialOverrides}
                homeView={homeView}
                enableNdi={source === 'ndi'}
                onNdiStatus={setNdiGuide}
                ndiGuide
                ndiGuideHint="沒有 AE？按上面的「本地檔案」把影片或圖片拖進來"
                ledVideo={videoMode && local.ready ? local.video : null}
                ledImage={source === 'file' && media.active?.kind === 'image' ? media.image : null}
                ledTemplate={versionVideoMode ? selectedVersion?.template ?? null : null}
                ledTimeline={versionVideoMode ? selectedVersion?.timeline ?? null : null}
                poseAtFrame={poseAtFrame}
                projectName={data.project.name}
                ledCanvas={ledCanvas}
                ledOffPieces={ledOffPieces}
                helpHref={helpUrl(HELP_ANCHORS.client)}
                viewApiRef={viewApiRef}
                transportKeys
              >
                <AnnotationLayer
                  draft={session.draft}
                  showing={session.showing}
                  showingLabel={openedComment ? `${openedComment.author}${(openedComment.annotation?.t ?? openedComment.time) > 0 ? ` · ${formatClockShort(openedComment.annotation?.t ?? openedComment.time)}` : ''}` : undefined}
                  onHideShowing={session.clearSelection}
                  onDone={focusComposer}
                  stickers={allowComments ? session.stickers : undefined}
                  showingAttachments={openedComment?.attachments}
                />
              </StageScene>
              {/* 歌曲影片的小播放器（浮在 3D 畫面上，可以拖、可以收起來；不會蓋到下面的 cue 列） */}
              {selectedVersion && (
                <MiniPlayer
                  player={local}
                  label={selectedVersion.label}
                  detail={versionByline(selectedVersion) || selectedVersion.title}
                  storageKey="sp_mini_player:share"
                  collapseOnTouch
                  onRetry={retryVersion}
                  comments={allowComments ? guestComments : undefined}
                  onAddCommentAtTime={allowComments ? (t) => { setPendingCommentTime(t); focusComposer(); } : undefined}
                  review={{
                    session, activeId: activeCommentId, onOpenComment: openComment,
                    onDraw: allowComments ? startDraw : undefined, ranges: allowComments,
                  }}
                />
              )}
            </div>
          ) : (
            <div className="share-empty">這個專案沒有可預覽的內容</div>
          )}

          {/* 拖檔提示 / 選影片提示 / 播放錯誤（AE 即時的步驟在 3D 畫面上的卡片） */}
          {dragOver && (
            <div className="share-overlay share-overlay--drop">放開，影片 / 圖片會加進清單、放在 LED 上（只在這台電腦播，不會上傳）</div>
          )}
          {!dragOver && source === 'file' && media.items.length === 0 && (
            <div className="share-overlay">
              <strong>把影片或圖片拖進來，或按「＋ 加入影片 / 圖片…」</strong>
              <span>可以一次放好幾個，點清單裡的哪個，LED 就放哪個。只在這台電腦播，不會上傳。</span>
              <span className="share-overlay__hint">畫面要是跟 AE 送 NDI 時一樣的整張畫布，才會對到每一片 LED。</span>
            </div>
          )}
          {!dragOver && source === 'file' && media.active && (media.active.kind === 'video' ? local.error : media.imageError) && (
            <div className="share-overlay share-overlay--error">
              <strong><Icon icon={TriangleAlert} /> {media.active.kind === 'video' ? local.error : media.imageError}</strong>
            </div>
          )}

          {fileVideoMode && media.active && (
            <div className="share-player">
              <button className="share-player__btn" onClick={local.togglePlay} title={local.playing ? '暫停' : '播放'} aria-label={local.playing ? '暫停' : '播放'}>
                <Icon icon={local.playing ? Pause : Play} size="md" />
              </button>
              <span className="share-player__time">{formatClock(local.time)} / {formatClock(local.duration)}</span>
              <input
                className="share-player__seek"
                type="range" min={0} max={local.duration || 0} step={0.01}
                value={Math.min(local.time, local.duration || 0)}
                onChange={(e) => local.seek(parseFloat(e.target.value))}
              />
              <button
                className={'share-player__btn' + (local.loop ? ' is-active' : '')}
                onClick={() => local.setLoop(!local.loop)}
                title={local.loop ? '循環播放：開' : '循環播放：關'}
                aria-label="循環播放"
                aria-pressed={local.loop}
              ><Icon icon={Repeat} size="md" /></button>
              <button className="share-player__btn" onClick={() => local.setMuted(!local.muted)} title={local.muted ? '開聲音' : '靜音'} aria-label={local.muted ? '開聲音' : '靜音'}>
                <Icon icon={local.muted ? VolumeX : Volume2} size="md" />
              </button>
              <span className="share-player__name" title={media.active.name}>{media.active.name}</span>
              <button className="share-player__btn" onClick={() => { if (media.active) media.remove(media.active.id); }} title="從清單移除這支影片" aria-label="從清單移除這支影片"><Icon icon={X} size="md" /></button>
            </div>
          )}

          {cues.length > 0 && (
            <div className="share-cuebar">
              {cues.map((c, i) => (
                <button
                  key={c.id}
                  className={'share-cuebar__cue' + (c.id === selectedCueId ? ' is-active' : '')}
                  onClick={() => selectCue(c)}
                  title={c.videoTimeSec != null ? `影片 ${formatClock(c.videoTimeSec)}` : undefined}
                >
                  <span className="share-cuebar__num">{i + 1}</span>
                  <CueNumBadge cue={c} /><span className="share-cuebar__name">{c.name}</span>
                </button>
              ))}
            </div>
          )}
        </main>
        {allowComments && shareRef && selectedSongId && (
          <GuestCommentsPanel
            shareRef={shareRef}
            accessToken={accessToken}
            songId={selectedSongId}
            session={session}
            videoActive={versionVideoMode}
            playing={local.playing}
            videoId={selectedVersion?.kind === 'version' ? selectedVersion.id : null}
            activeId={activeCommentId}
            onOpen={openComment}
            onStartDraw={startDraw}
            composerRef={composerRef}
            pendingTime={pendingCommentTime}
            onConsumedPendingTime={() => setPendingCommentTime(null)}
            onComments={setGuestComments}
            currentTime={local.time}
            onAuthError={onShareFetchError}
            onDisabled={() => { setData(d => (d ? { ...d, allowComments: false } : d)); toast.info('製作把這個連結的留言關掉了'); }}
            openNonce={openNonce}
          />
        )}
        </div>
      </div>
    </div>
  );
}
