import { CueNumBadge } from '../components/CueNumBadge';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { ActivityEntry, Cue, CueState, Song, SongComment, StageObject } from '../lib/api';
import { defaultVisible, isDefaultHidden } from '../lib/defaultHidden';
import type { ProjectMember, ProjectRole } from '../lib/mockData';
import { useAuth } from '../lib/auth';
import AccountMenu, { useAccountEdit } from '../components/AccountMenu';
import { useMemberWatermark } from '../lib/watermark/useMemberWatermark';
import { memberWatermarkOn } from '../lib/watermark/policy';
import { useViewAs, useViewAsUser } from '../lib/viewAsContext';
import StageScene, { type StageViewApi } from '../components/StageScene';
import AnnotationLayer from '../components/AnnotationLayer';
import { CommentFilterBar, ReviewCompose, readFollow, saveFollow, type StatusFilter } from '../components/ReviewCompose';
import ExportCommentsDialog from '../components/ExportCommentsDialog';
import { isTouchDevice, revealStage, useReviewSession, type ReviewSession } from '../lib/review/useReviewSession';
import { isCompactLayout, isPhoneLayout } from '../lib/viewportVars';
import { playheadCommentId } from '../lib/review/playhead';
import { formatClockShort } from '../lib/review/timecode';
import MiniPlayer from '../components/MiniPlayer';
import SongVersionBar, { versionByline } from '../components/SongVersionBar';
import AddVideoDialog from '../components/AddVideoDialog';
import RecordStageDialog, { type RecordChoice } from '../components/RecordStageDialog';
import { useStageRecorder } from '../lib/useStageRecorder';
import { captionForCue, progressLabel, recordFileName, stripExt, WEBM_NOTE } from '../lib/stageRecording';
import LedSourceSwitch, { readLedSource, saveLedSource, type LedSource } from '../components/LedSourceSwitch';
import LedTemplateChip, { LedTemplateHint } from '../components/LedTemplateChip';
import { useLedTemplates } from '../lib/useLedTemplates';
import { useSongTimeline } from '../lib/useSongTimeline';
import { chooseLedTemplate, ledTemplateChip, liveSourceHint, songTemplatePlan } from '../lib/ledLiveTemplate';
import ShareSetlist from './ShareSetlist';
import NotificationBell from '../components/NotificationBell';
import OverflowMenu from '../components/OverflowMenu';
import TourOverlay from '../components/TourOverlay';
import { ANIMATOR_TUTORIAL_PATH, animatorTourSteps, markTourSeen, readTourSeen, shouldAutoStartTour } from '../lib/tutorial/animatorTour';
import EmptyState from '../components/EmptyState';
import ReviewHistory from '../components/ReviewHistory';
import CommentThreadList from '../components/CommentThreadList';
import { AttachButton, AttachmentDropZone, AttachmentTray } from '../components/CommentAttachments';
import { memberUploader } from '../lib/review/attachmentsApi';
import { draftBlocksSend, useAttachmentDraft } from '../lib/review/useAttachmentDraft';
import { useStickerBridge } from '../lib/review/useStickerBridge';
import { buildThreads, canPostComment, defaultScope, filterAndSortThreads, scopeThreads, visibleInScope, type CommentScope } from '../lib/commentThreads';
import { lastReviewSentence, newVersionLabel } from '../lib/reviewHistory';
import { parseDeepLink, type DeepLink } from '../lib/notifications';
import { toast } from '../lib/toast';
import { confirmDialog, splitQuestion } from '../components/dialogs';
import { getLastSeen, markSeen, newFromOthersSince, songsToFetch, unreadFromSummary } from '../lib/unreadComments';
import { formatClock, useLocalVideo } from '../lib/localVideo';
import { localMediaKey, skippedFilesMessage, useLocalMedia } from '../lib/localMedia';
import { useVideoCueTimeline } from '../lib/videoCueSync';
import MusicBar from '../components/MusicBar';
import { useSongMusic } from '../lib/useSongMusic';
import { useMusicHotkeys } from '../lib/musicClock';
import { studioHasVideo } from '../lib/songMusic';
import { useStageMechanisms } from '../lib/mechanisms/useMechanisms';
import { memberVersionFetcher, useSongVersions } from '../lib/useSongVersions';
import { useAbCompare } from '../lib/useAbCompare';
import LedCompareBadge from '../components/LedCompareBadge';
import { useNewVersionHint } from '../lib/newVersionHint';
import { canAddVideo, canModifyVideo, deleteVersionMessage, removePendingQuestion, versionChoiceStorageKey, versionKey, type VersionItem } from '../lib/songVersions';
import { deleteSongVideo, getCommentsSummary, retrySongVideo, type CommentSummary, type SongVideo } from '../lib/videoApi';
import { editVersionNote } from '../lib/editVersionNote';
import { useVideoJobDone, useVideoJobs, useWarnBeforeUnloadWhileUploading, videoJobs, type VideoJob } from '../lib/videoJobs';
import { resumeFileProblem, trackedVideoIds, useStalledUploads } from '../lib/stalledUploads';
import { songTitle } from '../lib/songCode';
import { useProjectViewSettings } from '../lib/projectViewSettings';
import { useStageProps } from '../lib/useStageProps';
import { canEditStageProps } from '../lib/stageProps';
import { useCameraBookmarks } from '../lib/useCameraBookmarks';
import { canEditCameraBookmarks } from '../lib/cameraBookmarks';
import { crossfadeLabel, cueTransitionSeconds } from '../lib/cueTiming';
import { HELP_ANCHORS, helpUrl } from '../lib/helpLinks';
import HelpLink from '../components/HelpLink';
import { ndiShortLabel, type NdiGuide } from '../lib/ndiSteps';
import { usePersonalLook } from '../lib/stageLook/personalLook';
import { STOP_LIVE_REFRESH, liveRefreshWanted, useLiveRefresh } from '../lib/liveRefresh';
import { extractMentions } from '../lib/mentions';
import { formatRelativeTime } from '../lib/serverTime';
import { describeActivity } from '../lib/activityText';
import {
  SONG_STATUS_LABEL as STATUS_LABEL, songStatusActions, songActionsHint, staleStatusMessage,
  friendlyError, projectGoneMessage, sameSongs, sameComments,
} from '../lib/songReview';
import Icon, { StatusDot } from '../components/Icon';
import {
  ArrowLeft, BookOpen, Clapperboard, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Film, Footprints, GraduationCap, HistoryIcon, Image, ListMusic, LoaderCircle, LogOut, Music, Pause, Pencil, Play, RefreshCw, Repeat,
  SearchX, Settings, TriangleAlert, UserRoundSearch, Volume2, VolumeX, X,
} from 'lucide-react';
import { projectEditorPath } from '../lib/landing';
import './Studio.css';

type Tab = 'cues' | 'review' | 'activity';
type SongFilter = 'mine' | 'all';
/** 記住這台電腦上次選的 LED 來源（沒選過 = AE 即時，跟以前一樣） */
const SOURCE_KEY = 'sp_led_source:studio';
const EMPTY_CUES: Cue[] = [];

export default function Studio() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  // 沒有專案 id 的 /studio 由「我的專案」頁處理（App 路由），這裡不會走到
  if (!projectId) return null;
  if (authLoading) return <div className="studio-loading"><Icon icon={LoaderCircle} spin /> 載入中…</div>;
  if (!user) {
    navigate('/login', { replace: true });
    return null;
  }

  // key：換專案時整個重來（不會把上一個專案的歌 / 留言帶過來）
  return <StudioInner key={projectId} projectId={projectId} />;
}

/* ──────────── Studio Inner（projectId 存在時） ──────────── */

/** 這台電腦的 localStorage；瀏覽器擋掉（無痕、設定）就是 null */
function browserStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

function StudioInner({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const account = useAccountEdit();
  // 製作用「動畫師畫面」預覽時：user / 角色換成那個動畫師，寫入的按鈕按不下去（lib/viewAsContext.tsx）
  const user = useViewAsUser();
  const va = useViewAs();
  // 校準倍率、現場設定、LED 畫布大小（製作在管理頁設的，動畫師這邊只看）
  const view = useProjectViewSettings(projectId, user?.role === 'admin');
  // 現場設定：專案預設 + 自己調過的（存在這台電腦）
  const personalLook = usePersonalLook(projectId, view.lookSettings);

  const [projectName, setProjectName] = useState<string>('');
  // 專案有打開「成員看片也加浮水印」→ 3D 畫面和小播放器印上自己的名字和時間（lib/watermark）
  const [watermarkMembers, setWatermarkMembers] = useState(false);
  useMemberWatermark(watermarkMembers);
  // 專案名讀不到時不能一直停在「…」，要顯示讀取失敗 + 重試
  const [nameStatus, setNameStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [projectArchived, setProjectArchived] = useState(false);
  // 我在這個專案的角色（審查按鈕看這個，不是帳號的預設角色）；undefined = 還沒讀到
  const [myRole, setMyRole] = useState<ProjectRole | null | undefined>(undefined);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  // 專案整個看不到了（封存 / 刪除 / 被移出專案）→ 整頁換成說明
  const [goneMessage, setGoneMessage] = useState<string | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [songsLoading, setSongsLoading] = useState(true);
  const [songsError, setSongsError] = useState<string | null>(null);

  const projectRole: ProjectRole | null = va.projectRole(myRole === undefined ? (user?.role ?? null) : myRole);
  // 比例尺的樂手和器材：製作、導演可以擺，動畫師只能看（預覽別人的畫面時也只能看）
  const band = useStageProps(projectId, canEditStageProps(projectRole) && !va.readOnly);
  // 視角書籤（專案共用）：製作、導演可以存 / 改，動畫師點了飛過去
  const camBm = useCameraBookmarks(projectId, canEditCameraBookmarks(projectRole) && !va.readOnly);
  // 動畫師只看：3D 工具列只剩重置攝影機、燈光照專案預設（不能自己調）
  const isAnimatorViewer = projectRole === 'animator';

  // 預覽某個動畫師 → 先看「我的」（指派給他的歌），也不記到這台電腦
  const [songFilter, setSongFilter] = useState<SongFilter>(() => {
    if (va.active) return 'mine';
    try { return (localStorage.getItem('sp_studio_filter') as SongFilter) || 'mine'; } catch { return 'mine'; }
  });
  useEffect(() => { if (va.active) return; try { localStorage.setItem('sp_studio_filter', songFilter); } catch {} }, [songFilter, va.active]);
  const [songSearch, setSongSearch] = useState('');
  // 手機上的歌單：平常收成一行，點開才是整個清單（點外面或選了歌就收起來）
  const [songsSheetOpen, setSongsSheetOpen] = useState(false);
  const songsAsideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!songsSheetOpen) return;
    const onDown = (e: PointerEvent) => {
      if (songsAsideRef.current && !songsAsideRef.current.contains(e.target as Node)) setSongsSheetOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSongsSheetOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [songsSheetOpen]);

  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  // 載入中 / 失敗時不能顯示「這首歌還沒有 cue」，會讓動畫師以為真的沒 cue
  const [cuesStatus, setCuesStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [cuesReloadKey, setCuesReloadKey] = useState(0);
  // cues 是哪首歌的：切歌後新的還沒讀到前，不能拿上一首的 cue id 去問位置
  const [cuesFor, setCuesFor] = useState<string | null>(null);
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);
  const [cueStates, setCueStates] = useState<CueState[]>([]);
  const [stageObjects, setStageObjects] = useState<StageObject[]>([]);
  const [modelUrl, setModelUrl] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('cues');
  // 手機（窄螢幕）：右邊的 cue / 審查 / 活動是從底下拉上來的面板（CSS 的 .studio-right）；iPad、電腦這個狀態沒作用
  const [sheetOpen, setSheetOpen] = useState(false);
  // 通知點進來（?song=&video=&comment=）：選到那首歌、那一版、打開留言捲到那則
  const [searchParams, setSearchParams] = useSearchParams();
  const [target, setTarget] = useState<(DeepLink & { nonce: number }) | null>(null);
  const [focusComment, setFocusComment] = useState<{ id: string; nonce: number } | null>(null);
  // 全專案留言（歌單的未讀數字 + 審查分頁的留言清單共用同一份；自動更新）
  const [commentsBySong, setCommentsBySong] = useState<Map<string, SongComment[]>>(new Map());

  // 非同步回來時要拿「現在」的值（不是發出請求那時候的）
  const songsRef = useRef<Song[]>([]);
  const commentsRef = useRef<Map<string, SongComment[]>>(new Map());
  const selectedSongIdRef = useRef<string | null>(null);
  selectedSongIdRef.current = selectedSongId;
  const goneRef = useRef(false);
  goneRef.current = !!goneMessage;

  // ── Loaders ──

  // 換上新的歌單；跟現在的一樣就不換（自動更新時畫面不會閃）。正在看的歌被刪了要講
  const applySongs = useCallback((list: Song[]) => {
    const prev = songsRef.current;
    const sel = selectedSongIdRef.current;
    const was = sel ? prev.find(s => s.id === sel) : undefined;
    if (was && !list.some(s => s.id === sel)) {
      toast.warn(`你正在看的「${was.name}」已經被刪除了（可能是製作剛刪的），畫面已更新`);
    }
    if (sameSongs(prev, list)) return;
    songsRef.current = list;
    setSongs(list);
  }, []);

  const setSongComments = useCallback((songId: string, list: SongComment[]) => {
    const next = new Map(commentsRef.current);
    next.set(songId, list);
    commentsRef.current = next;
    setCommentsBySong(next);
  }, []);

  // 留言：每次更新只叫一次「留言摘要」（每首歌幾則、最新一則）算未讀，只抓需要的那幾首歌的整串
  // （正在看的那首、有比上次看的還新的別人留言的）。docs/comments-api.md
  const summaryRef = useRef<Map<string, CommentSummary> | null>(null);
  const [summary, setSummary] = useState<Map<string, CommentSummary> | null>(null);
  const refreshComments = useCallback(async (notify: boolean) => {
    if (!user) return;
    const fetchSongs = async (ids: string[]) => {
      const results = new Map<string, SongComment[]>();
      const queue = [...ids];
      const work = async () => {
        while (queue.length > 0) {
          const sid = queue.shift();
          if (!sid) return;
          try { results.set(sid, await api.listSongComments(projectId, sid)); }
          catch { /* 這首抓不到就沿用上次的 */ }
        }
      };
      await Promise.all([work(), work(), work(), work()]);
      return results;
    };
    let rows: CommentSummary[] | null = null;
    try { rows = await getCommentsSummary(projectId); } catch { /* 網路一時不通 → 至少更新正在看的這首 */ }
    const prev = summaryRef.current;
    const ids = rows
      ? songsToFetch(rows, prev, (sid) => getLastSeen(user.id, projectId, sid), (sid) => commentsRef.current.has(sid), selectedSongIdRef.current)
      : (selectedSongIdRef.current ? [selectedSongIdRef.current] : []);
    const results = await fetchSongs(ids);

    const current = commentsRef.current;  // 等待期間自己留言 / 刪除過的話，以最新的為準
    let next: Map<string, SongComment[]> | null = null;
    for (const [sid, got] of results) {
      if (sameComments(current.get(sid), got)) continue;
      next ??= new Map(current);
      next.set(sid, got);
    }
    if (next) {
      commentsRef.current = next;
      setCommentsBySong(next);
    }
    if (!rows) return;
    const map = new Map(rows.map(r => [r.songId, r]));
    summaryRef.current = map;
    setSummary(map);

    // 有別人的新留言 → 跳提示（第一次載入不跳）
    if (!notify || !prev) return;
    for (const r of rows) {
      const before = prev.get(r.songId);
      if (!before || (r.latestFromOthersAt ?? '') <= (before.latestFromOthersAt ?? '')) continue;
      const list = results.get(r.songId);
      if (!list) continue;
      const fresh = newFromOthersSince(list, before.latestFromOthersAt, user);
      if (fresh.length === 0) continue;
      const c = fresh[fresh.length - 1];
      const songName = songsRef.current.find(x => x.id === r.songId)?.name ?? '';
      const more = fresh.length > 1 ? `（共 ${fresh.length} 則新留言）` : '';
      toast.info(`${songName}：${c.author} 留言「${c.text.slice(0, 40)}${c.text.length > 40 ? '…' : ''}」${more}`);
    }
  }, [projectId, user]);

  // 專案名 + 我的角色 + 成員
  const loadMeta = useCallback(async () => {
    try {
      const meta = await api.getProjectMeta(projectId);
      if (meta) {
        setProjectName(meta.name);
        setWatermarkMembers(!!meta.watermarkMembers);
        setMyRole(meta.myRole ?? null);
        setMembers(meta.members || []);
        setProjectArchived(false);
        setNameStatus('ready');
        return;
      }
      // 清單裡沒有（封存的專案只有 admin 看得到 / 不是成員）→ 直接問這個專案
      const info = await api.getProjectInfo(projectId);
      setProjectName(info.project.name);
      setWatermarkMembers(memberWatermarkOn(info.project.watermark_members));
      setMyRole(info.myRole);
      setProjectArchived(info.project.status === 'archived');
      setNameStatus('ready');
    } catch (e) {
      const gone = projectGoneMessage(e);
      if (gone) setGoneMessage(gone);
      setNameStatus('error');
    }
  }, [projectId]);

  const refreshAll = useCallback(async () => {
    setSongsLoading(true);
    setSongsError(null);
    setNameStatus('loading');
    const metaDone = loadMeta();
    try {
      const [list, objs, model] = await Promise.all([
        api.listSongs(projectId),
        api.listStageObjects(projectId).catch(() => [] as StageObject[]),
        api.getModelInfo(projectId).catch(() => null),
      ]);
      applySongs(list);
      setStageObjects(objs);
      setModelUrl(model ? api.modelDownloadUrl(model.key) : null);
      void refreshComments(false);
    } catch (e) {
      const gone = projectGoneMessage(e);
      if (gone) setGoneMessage(gone);
      else setSongsError('歌曲讀取失敗：' + friendlyError(e));
    } finally {
      setSongsLoading(false);
    }
    await metaDone;
  }, [projectId, loadMeta, applySongs, refreshComments]);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  useEffect(() => {
    const link = parseDeepLink(searchParams);
    if (!link) return;
    setTarget({ ...link, nonce: Date.now() });
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      for (const k of ['song', 'video', 'comment']) next.delete(k);
      return next;
    }, { replace: true });
  }, [searchParams, setSearchParams]);

  // 自動更新：每 25 秒 + 切回分頁時，重抓歌曲狀態 + 留言（導演改了狀態 / 留了言，這邊 30 秒內看得到）
  const reloadSongs = useCallback(async (): Promise<Song[] | null> => {
    try {
      const list = await api.listSongs(projectId);
      applySongs(list);
      return list;
    } catch (e) {
      const gone = projectGoneMessage(e);
      if (gone) {
        goneRef.current = true;  // 馬上算數：同一輪後面的留言就不用問了
        setGoneMessage(gone);
      }
      return null;
    }
  }, [projectId, applySongs]);

  // 專案被封存 / 刪除、被移出專案 → 不再自動更新（以前會一直每 25 秒拿一次 404）；
  // 已封存（製作打開來看）也不用更新：封存的專案沒有人能改
  const live = liveRefreshWanted({ gone: !!goneMessage, archived: projectArchived });
  useLiveRefresh(async () => {
    if (goneRef.current) return STOP_LIVE_REFRESH;
    await reloadSongs();
    // 歌單這次沒讀到（網路一時不穩）也照樣更新留言；專案不見了就不用了
    if (goneRef.current) return STOP_LIVE_REFRESH;
    await refreshComments(true);
  }, { enabled: live && !songsLoading });

  // 審查分頁開著時，看到的留言算已讀（在 cue 分頁時新留言要留著未讀數字）
  const [, setSeenRev] = useState(0);
  useEffect(() => {
    if (!user || !selectedSongId || tab !== 'review') return;
    const list = commentsBySong.get(selectedSongId);
    if (!list || list.length === 0) return;
    const latest = list.reduce((acc, c) => c.createdAt > acc ? c.createdAt : acc, '');
    if (getLastSeen(user.id, projectId, selectedSongId) === latest) return;
    markSeen(user.id, projectId, selectedSongId, latest);
    setSeenRev(n => n + 1);  // 歌單上的未讀數字跟著歸零
  }, [user, projectId, selectedSongId, commentsBySong, tab]);

  // 換歌 → 這首的留言還沒抓過就抓（審查分頁要顯示整串）
  useEffect(() => {
    if (!selectedSongId || commentsRef.current.has(selectedSongId)) return;
    const sid = selectedSongId;
    api.listSongComments(projectId, sid).then(list => setSongComments(sid, list)).catch(() => { /* 下次自動更新再抓 */ });
  }, [projectId, selectedSongId, setSongComments]);

  // 切歌 → 拉 cues
  useEffect(() => {
    if (!selectedSongId) { setCues([]); setSelectedCueId(null); return; }
    let cancelled = false;
    // 切歌時先清掉上一首的 cue，不然載入期間會顯示舊歌的 cue
    setCues([]);
    setSelectedCueId(null);
    setCueStates([]);
    setCuesFor(null);
    setCuesStatus('loading');
    api.listCues(projectId, selectedSongId).then(list => {
      if (cancelled) return;
      const masters = list.filter(c => c.status === 'master');
      setCues(list);
      setCuesFor(selectedSongId);
      setSelectedCueId(masters[0]?.id ?? null);
      setCuesStatus('ready');
    }).catch(() => {
      if (cancelled) return;
      setCues([]);
      setCuesStatus('error');
    });
    return () => { cancelled = true; };
  }, [projectId, selectedSongId, cuesReloadKey]);

  // 切 cue → 拉 states
  useEffect(() => {
    if (!selectedSongId || !selectedCueId || cuesFor !== selectedSongId) { setCueStates([]); return; }
    let cancelled = false;
    api.listCueStates(projectId, selectedSongId, selectedCueId).then(list => {
      if (!cancelled) setCueStates(list);
    }).catch(() => { if (!cancelled) setCueStates([]); });
    return () => { cancelled = true; };
  }, [projectId, selectedSongId, selectedCueId, cuesFor]);

  // ── Derived ──
  const masterCues = useMemo(() => cues.filter(c => c.status === 'master'), [cues]);
  const selectedCue = useMemo(() => cues.find(c => c.id === selectedCueId) || null, [cues, selectedCueId]);
  const selectedSong = useMemo(() => songs.find(s => s.id === selectedSongId) || null, [songs, selectedSongId]);

  const isAdmin = projectRole === 'admin';
  // mine 篩選對 admin 沒意義（所以 admin 預設看全部）
  const effectiveFilter: SongFilter = isAdmin ? 'all' : songFilter;
  const visibleSongs = useMemo(() => {
    let list = songs;
    if (effectiveFilter !== 'all' && user) {
      list = list.filter(s => s.animatorUserId === user.id);
    }
    const q = songSearch.trim().toLowerCase();
    if (q) list = list.filter(s => s.name.toLowerCase().includes(q));
    return list;
  }, [songs, effectiveFilter, user, songSearch]);

  // 自動選第一個可見的歌（除非用戶已選一個還在清單裡）
  useEffect(() => {
    if (!visibleSongs.length) { setSelectedSongId(null); return; }
    if (selectedSongId && visibleSongs.some(s => s.id === selectedSongId)) return;
    setSelectedSongId(visibleSongs[0].id);
  }, [visibleSongs, selectedSongId]);

  // 通知點進來：那首歌不在「我的」→ 換到「全部」；選到那首歌；有留言 → 打開留言分頁
  useEffect(() => {
    if (!target || songsLoading) return;
    const song = songs.find(s => s.id === target.songId);
    if (!song) {
      toast.warn('通知裡的那首歌已經不在了（可能剛被刪掉）');
      setTarget(null);
      return;
    }
    if (songFilter === 'mine' && song.animatorUserId !== user?.id) setSongFilter('all');
    setSongSearch('');
    setSelectedSongId(song.id);
    if (target.commentId || target.videoId) { setTab('review'); setSheetOpen(true); }
  }, [target, songs, songsLoading]);  // eslint-disable-line react-hooks/exhaustive-deps

  // 沒選 cue 時 viewport 顯示 stage objects 的 default position
  const viewportStates: CueState[] = useMemo(() => {
    if (selectedCueId && cueStates.length > 0) return cueStates;
    return stageObjects.map(o => ({
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
  }, [selectedCueId, cueStates, stageObjects]);

  const selectedComments = selectedSongId ? commentsBySong.get(selectedSongId) : undefined;
  /** 一首歌的未讀留言數（摘要 + 抓到的留言；docs/comments-api.md 的做法） */
  const unreadOf = (songId: string) => (user
    ? unreadFromSummary(summary?.get(songId), getLastSeen(user.id, projectId, songId), commentsBySong.get(songId), user)
    : 0);
  const selectedUnread = selectedSongId ? unreadOf(selectedSongId) : 0;

  // ── LED 畫面：歌曲影片（V3…）/ AE 即時 / 本地檔案 ──
  // 一頁只有一個 <video>：歌曲影片、本地檔案輪流用它（同時是 LED 貼圖、也是小視窗的畫面）
  const player = useLocalVideo();
  const media = useLocalMedia(player);
  // 上次選的來源；沒選過 = AE 即時（跟以前一樣）；手機、iPad（觸控）沒選過 = 影片（Safari 不支援 AE 即時，說明卡會蓋住大半個 3D 畫面）
  const [sourcePref, setSourcePref] = useState<LedSource | null>(() => readLedSource(SOURCE_KEY));
  const source: LedSource = sourcePref ?? (isTouchDevice() ? 'version' : 'ndi');
  const chooseSource = useCallback((next: LedSource) => {
    setSourcePref(next);
    saveLedSource(SOURCE_KEY, next);
  }, []);
  const [ndiGuide, setNdiGuide] = useState<NdiGuide | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const fetchVersions = useMemo(() => memberVersionFetcher(projectId), [projectId]);
  const viewerId = user?.id ?? 'anon';
  const versionStorageKey = useCallback(
    (sid: string) => versionChoiceStorageKey(viewerId, projectId, sid),
    [viewerId, projectId],
  );
  // 歌單上的最新版本換了（交了新版、有人刪了）→ 重抓這首歌的版本
  // 專案看不到了 → 不抓（複製中的那一版也不再每 5 秒問）
  const versions = useSongVersions({
    songId: goneMessage ? null : selectedSongId, fetcher: fetchVersions, storageKey: versionStorageKey, reloadKey: selectedSong?.latestVideoId ?? null,
  });
  const selectedVersion = source === 'version' ? versions.selected : null;
  const { loadUrl, getSrcKey, pause: pausePlayer, clear: clearPlayer } = player;
  useEffect(() => {
    if (!selectedVersion?.url) {
      // 選了「影片」但這首歌（還）沒有 → 上一首的影片不要繼續放
      const k = getSrcKey();
      if (source === 'version' && k && !k.startsWith('local:')) clearPlayer();
      return;
    }
    if (getSrcKey() === selectedVersion.key) return;
    loadUrl(selectedVersion.url, { key: selectedVersion.key, name: selectedVersion.label, crossOrigin: selectedVersion.crossOrigin });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVersion?.key, source, loadUrl, getSrcKey, clearPlayer]);

  // 切來源：AE 即時 → 影片先暫停（不然聲音還會在背景播）；
  // 回到本地檔案 → 正在放的那支被換掉了就重新載入；清單裡沒有影片 → 歌曲影片也先暫停
  const { reshow: reshowMedia } = media;
  useEffect(() => {
    if (source === 'ndi') pausePlayer();
    else if (source === 'file') {
      reshowMedia();
      if (!getSrcKey()?.startsWith('local:')) pausePlayer();
    }
  }, [source, pausePlayer, reshowMedia, getSrcKey]);

  // 播放網址過期（開著超過幾小時）/ 網路斷掉 → 拿新網址接著同一秒播
  const retryVersion = useCallback(async () => {
    const r = await versions.reload();
    const it = r?.items.find(x => x.key === selectedVersion?.key) ?? selectedVersion;
    if (it?.url) player.replaceUrl(it.url, { key: it.key, name: it.label, crossOrigin: it.crossOrigin });
  }, [versions, selectedVersion, player]);

  // 比較（A/B）：跟導演頁同一套（lib/useAbCompare.ts）——拿自己的 V3 跟 V2 比，停在同一秒，按 C 切換
  const { select: selectVersion } = versions;
  const selectVersionForCompare = useCallback((key: string) => { selectVersion(key); chooseSource('version'); }, [selectVersion, chooseSource]);
  const compare = useAbCompare({
    resetKey: selectedSongId,
    items: versions.items,
    currentKey: selectedVersion?.key ?? null,
    select: selectVersionForCompare,
    player,
    enabled: !!selectedVersion,
  });
  // 看到一半有新版進來（別人交的 / 25 秒自動更新）：播放照舊，版本旁邊「有新版 V3 · 切換」（LED 在放影片時才顯示）
  const newVersion = useNewVersionHint({
    scope: selectedSongId, loaded: !!selectedSongId && versions.loadedSongId === selectedSongId, items: versions.items,
    currentKey: versions.selected?.key ?? null, select: selectVersionForCompare, player,
  });

  // 通知點進來：等這首歌的版本清單抓到 → 選那一版、放到 LED 上；捲到那則留言
  useEffect(() => {
    if (!target || selectedSongId !== target.songId || versions.loadedSongId !== target.songId) return;
    if (target.videoId) {
      const key = versionKey(target.videoId);
      if (versions.items.some(it => it.key === key)) {
        versions.select(key);
        chooseSource('version');
      } else {
        toast.warn('通知裡的那一版已經不在了（可能被刪掉）');
      }
    }
    if (target.commentId) setFocusComment({ id: target.commentId, nonce: target.nonce });
    setTarget(null);
  }, [target, selectedSongId, versions, chooseSource]);

  // 正在 LED 上放影片（歌曲影片 / 本地影片；不是圖片 / AE）→ 舞台、cue 列跟著影片時間走
  const fileVideoMode = source === 'file' && media.active?.kind === 'video' && player.srcKey === localMediaKey(media.active.id);
  const versionVideoMode = !!selectedVersion && player.srcKey === selectedVersion.key;
  const videoMode = fileVideoMode || versionVideoMode;

  // ── LED 版型（lib/ledLiveTemplate.ts）──
  // 歌曲影片版本用那一版自己的快照；AE 即時、本地檔案照這首歌「現在」選的版型（暫時用整張畫布看：只有這個畫面，不存）
  const ledTpls = useLedTemplates(projectId);
  const reloadLedTpls = ledTpls.reload;
  const tplReloadSong = useRef(selectedSongId);
  useEffect(() => {
    // 換歌時重讀一次版型清單（製作可能在別的視窗改過排法）；第一次已經讀過了
    if (tplReloadSong.current === selectedSongId) return;
    tplReloadSong.current = selectedSongId;
    void reloadLedTpls();
  }, [selectedSongId, reloadLedTpls]);
  const songTplPlan = useMemo(() => songTemplatePlan(ledTpls.list, selectedSong?.templateId), [ledTpls.list, selectedSong?.templateId]);
  // 中途換版型（時間線）：開頭 = 歌選的版型，換版型的點 = 歌的 templateSwitches；Cue 的時間用畫面上最新的
  const songTimelineState = useSongTimeline(ledTpls.list, selectedSong?.templateId, selectedSong?.templateSwitches, cuesFor === selectedSongId ? cues : null);
  const [ledSegPick, setLedSegPick] = useState<number | null>(null);        // 沒有播放時間的畫面（AE 即時、本地圖片）手動選看哪一段，只有這個畫面，不存
  useEffect(() => { setLedSegPick(null); }, [selectedSongId]);
  // 3D 工具列「⋯」的對位圖 / AE 合成腳本 / 位置表：這首歌用了版型就照版型下載（有中途換版型就整條時間線一起）
  const ledSongTpl = useMemo(
    () => (songTplPlan && ledTpls.list ? { plan: songTplPlan, manuals: ledTpls.list.screens, timeline: songTimelineState.timeline, songName: selectedSong?.name } : null),
    [songTplPlan, ledTpls.list, songTimelineState.timeline, selectedSong?.name],
  );
  const [ledFullView, setLedFullView] = useState(false);
  useEffect(() => { setLedFullView(false); }, [selectedSongId]);
  const [aeFrameSize, setAeFrameSize] = useState<{ width: number; height: number } | null>(null);
  const customLedTemplates = useMemo(() => (ledTpls.list?.templates ?? []).filter(t => t.kind === 'custom'), [ledTpls.list]);
  const ledChoice = useMemo(
    () => chooseLedTemplate({
      source,
      versionPlan: versionVideoMode ? selectedVersion?.template ?? null : null,
      versionTimeline: versionVideoMode ? selectedVersion?.timeline ?? null : null,
      songPlan: songTplPlan,
      songTimeline: songTimelineState.timeline,
      fullView: ledFullView,
    }),
    [source, versionVideoMode, selectedVersion?.template, selectedVersion?.timeline, songTplPlan, songTimelineState.timeline, ledFullView],
  );
  // 中途換版型現在看到的時間：影片（版本、本地影片）= 播放時間；AE 即時、本地圖片沒有播放時間 = 手動選的那一段，沒選就是選到的 Cue 的影片時間
  const ledTimeSec = useMemo(() => {
    const tl = ledChoice.timeline;
    if (!tl) return 0;
    if (videoMode) return player.time;
    if (ledSegPick !== null && tl.segments[ledSegPick]) return tl.segments[ledSegPick].fromSec;
    return selectedCue?.videoTimeSec ?? 0;
  }, [ledChoice.timeline, videoMode, player.time, ledSegPick, selectedCue?.videoTimeSec]);
  const ledChip = useMemo(
    () => ledTemplateChip(ledChoice, { source, songPlan: songTplPlan, list: ledTpls.list, timeSec: ledTimeSec, clocked: videoMode, pickedSegment: ledSegPick }),
    [ledChoice, source, songTplPlan, ledTpls.list, ledTimeSec, videoMode, ledSegPick],
  );
  // 本地檔案現在的畫面大小（影片載好、圖片解碼好才知道）；AE 即時的由 StageScene 通知
  const fileW = source === 'file' ? (media.active?.kind === 'video' ? (fileVideoMode && player.ready ? player.video.videoWidth : 0) : media.image?.naturalWidth ?? 0) : 0;
  const fileH = source === 'file' ? (media.active?.kind === 'video' ? (fileVideoMode && player.ready ? player.video.videoHeight : 0) : media.image?.naturalHeight ?? 0) : 0;
  const ledHint = useMemo(() => {
    const frame = source === 'ndi' ? aeFrameSize : fileW > 0 && fileH > 0 ? { width: fileW, height: fileH } : null;
    return liveSourceHint({ choice: ledChoice, frame, source, fullCanvas: ledTpls.list?.fullCanvas ?? null, templates: customLedTemplates });
  }, [ledChoice, source, aeFrameSize, fileW, fileH, ledTpls.list?.fullCanvas, customLedTemplates]);

  // 拖進來 / 選的檔案加進本地檔案清單，第一個馬上放在 LED 上（只在這台電腦播，不上傳）
  const addFiles = useCallback((files: FileList | File[] | null | undefined) => {
    if (!files || files.length === 0) return;
    const { rejected, shown } = media.add(Array.from(files));
    const skipped = skippedFilesMessage(rejected);
    if (skipped) toast.warn(skipped);
    if (shown) chooseSource('file');
  }, [media, chooseSource]);

  // ── 音樂（沒有影片的歌，用音樂當歌的時間；動畫師只能聽，上傳 / 換 / 移除在編輯頁和導演頁）──
  // 規則跟導演頁一樣：有影片（這首歌交過影片，或 LED 放的是本地影片）→ 放影片的聲音，不放音樂；沒影片才放音樂。
  // 音樂播放器的介面跟影片播放器一樣（lib/useMusicPlayer.ts），所以舞台、cue 列、3D 的機關跟著音樂走的方式跟跟著影片一樣
  const songMusic = useSongMusic({
    projectId,
    song: selectedSong,
    hasVideo: studioHasVideo({
      hasVersion: !!versions.selected,
      latestVideoId: selectedSong?.latestVideoId,
      source,
      localKind: media.active?.kind,
    }),
    videosLoaded: !!selectedSongId && versions.loadedSongId === selectedSongId,
  });
  const musicMode = songMusic.musicMode;
  const musicPlayer = songMusic.player;

  // 影片時間軸要每個 cue 的位置（放影片時才抓；抓過的留著）
  const statesCacheRef = useRef(new Map<string, Promise<CueState[]>>());
  useEffect(() => { statesCacheRef.current = new Map(); }, [selectedSongId]);
  const statesFor = useCallback((cueId: string) => {
    if (!selectedSongId) return null;
    const cache = statesCacheRef.current;
    let p = cache.get(cueId);
    if (!p) {
      p = api.listCueStates(projectId, selectedSongId, cueId);
      p.catch(() => cache.delete(cueId));  // 失敗就丟掉，下次再抓
      cache.set(cueId, p);
    }
    return p;
  }, [projectId, selectedSongId]);
  // 機關（製作在管理頁設的；這裡只看）：點 cue 照機器速度走、放影片時跟著影片時間；25 秒自動更新
  const mech = useStageMechanisms({
    projectId, songId: selectedSongId, cues: cuesFor === selectedSongId ? masterCues : EMPTY_CUES, selectedCueId, video: player.video, live,
  });
  // 還沒設時間的正式 cue 用暫排的時間（跟機關同一份，lib/provisionalCues.ts）
  const { poseAtFrame, selectCueByUser } = useVideoCueTimeline({
    cues: mech.plannedCues,
    statesFor,
    resetKey: selectedSongId,
    active: videoMode || musicMode,
    ready: musicMode ? musicPlayer.ready : player.ready,
    video: musicMode ? musicPlayer.video : player.video,
    time: musicMode ? musicPlayer.time : player.time,
    selectedCueId,
    onSelectCue: setSelectedCueId,
    seek: musicMode ? musicPlayer.seek : player.seek,
  });
  // 音樂是歌的時間：3D 的機關跟著音樂的時間走（上面的 useStageMechanisms 讀的是影片）
  const musicTimelineRef = useRef(mech.timeline);
  musicTimelineRef.current = mech.timeline;
  const musicMechAtFrame = useCallback(() => musicTimelineRef.current?.valuesAt(musicPlayer.video.currentTime) ?? null, [musicPlayer.video]);
  // 音樂當歌的時間時：空白鍵播放 / 暫停（有影片時空白鍵是影片的，在 useReviewSession）
  useMusicHotkeys({ enabled: musicMode, onToggle: musicPlayer.togglePlay });
  /** 點 cue（cue 列、右邊清單、Shift+J/K）：有在放影片的話影片跳到那個 cue 的時間 */
  const selectCueById = useCallback((id: string) => {
    const c = masterCues.find(x => x.id === id);
    if (c) selectCueByUser(c);
  }, [masterCues, selectCueByUser]);

  // ── 審片：播放快捷鍵（空白鍵、J / K / L、, / .、I / O）、Shift+J / K 切 cue、[ / ] 切歌、區段、打開留言、畫記 ──
  const viewApiRef = useRef<StageViewApi | null>(null);
  // 錄成影片：本地檔案、已交的版本都能錄（AE 即時不行）；錄的時候整頁鎖住
  const captionState = useRef({ cues: masterCues, cueId: selectedCueId });
  captionState.current = { cues: masterCues, cueId: selectedCueId };
  const getCaption = useCallback(() => captionForCue(captionState.current.cues, captionState.current.cueId), []);
  const recorder = useStageRecorder({ player, viewApiRef, getCaption });
  const [recordOpen, setRecordOpen] = useState(false);
  const recordSource = versionVideoMode && selectedVersion ? selectedVersion.label : fileVideoMode && media.active ? stripExt(media.active.name) : '';
  const canRecord = videoMode && player.ready && !recorder.locked;
  const startRecord = (c: RecordChoice) => {
    setRecordOpen(false);
    const bm = c.bookmarkId ? camBm.bookmarks.find(b => b.id === c.bookmarkId) : null;
    const song = selectedSong ? songTitle(selectedSong) : '';
    void recorder.start({
      resolution: c.resolution,
      scope: c.scope,
      view: bm ? { position: bm.position, target: bm.target, fov: bm.fov } : null,
      caption: c.caption,
      fileName: (ext) => recordFileName({ project: projectName, song, source: recordSource, date: new Date(), ext }),
    });
  };
  const recordButton = (cls: string, withText: boolean) => (
    <button
      type="button"
      className={cls}
      onClick={() => setRecordOpen(true)}
      disabled={!canRecord || !!recorder.unsupported}
      title={recorder.unsupported ?? '錄成影片：把 3D 舞台和 LED 上的影片錄成 mp4，可以傳給導演'}
      aria-label="錄成影片"
      data-tour="record"
    >
      <Icon icon={Clapperboard} />{withText && ' 錄成影片'}
    </button>
  );
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [pendingCommentTime, setPendingCommentTime] = useState<number | null>(null);
  const cueStep = useCallback((dir: 1 | -1) => {
    if (!masterCues.length) return;
    const idx = masterCues.findIndex(c => c.id === selectedCueId);
    const next = dir > 0
      ? (idx < 0 ? 0 : Math.min(idx + 1, masterCues.length - 1))
      : (idx <= 0 ? 0 : idx - 1);
    selectCueByUser(masterCues[next]);
  }, [masterCues, selectedCueId, selectCueByUser]);
  const songStep = useCallback((dir: 1 | -1) => {
    if (!visibleSongs.length) return;
    const idx = visibleSongs.findIndex(s => s.id === selectedSongId);
    const next = dir > 0
      ? (idx < 0 ? 0 : Math.min(idx + 1, visibleSongs.length - 1))
      : (idx <= 0 ? 0 : idx - 1);
    setSelectedSongId(visibleSongs[next].id);
  }, [visibleSongs, selectedSongId]);
  const focusComposer = useCallback(() => {
    setTab('review');
    setSheetOpen(true);  // 手機：先把面板拉上來，輸入框才看得到
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }));
  }, []);
  // 螢幕鍵盤跳出來（看得到的高度縮小）時，右邊面板裡正在打字的欄位捲到看得到的地方
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    if (!vv) return;
    const onResize = () => {
      const el = document.activeElement;
      if (el instanceof HTMLElement && /^(TEXTAREA|INPUT)$/.test(el.tagName) && el.closest('.studio-right__body')) {
        // 整個「寫留言」區塊（輸入框 + 送出按鈕）一起捲進來，不只是輸入框
        const box = el.closest('.studio-review__compose') ?? el;
        requestAnimationFrame(() => requestAnimationFrame(() => box.scrollIntoView({ block: 'nearest' })));
      }
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);
  // 通知點進來要看某一則留言 → 手機把面板拉上來；換歌 → 收回去
  useEffect(() => { if (focusComment) setSheetOpen(true); }, [focusComment]);
  useEffect(() => { setSheetOpen(false); }, [selectedSongId]);
  const session = useReviewSession({
    player, videoActive: versionVideoMode, resetKey: selectedSongId, viewApiRef,
    versions: { items: versions.items, currentKey: selectedVersion?.key ?? null, select: versions.select },
    beforeOpenVersion: () => chooseSource('version'),
    cueId: selectedCueId, onCueStep: cueStep, onSongStep: songStep, onFocusComposer: focusComposer,
    // 圖片貼到 3D 畫面上之後：觸控裝置切到審片分頁、3D 畫面捲回來才看得到
    onStickerPlaced: () => { if (isTouchDevice()) { setTab('review'); revealStage(stageRef.current); } },
  });
  const selectedRootComments = useMemo(() => (selectedComments ?? []).filter(c => !c.parentId), [selectedComments]);
  const activeCommentId = versionVideoMode ? playheadCommentId(selectedRootComments, player.time) : null;
  const openedComment = session.selectedId ? (selectedComments ?? []).find(c => c.id === session.selectedId) ?? null : null;
  const stageRef = useRef<HTMLDivElement>(null);
  const openComment = useCallback((c: SongComment) => {
    setTab('review');
    // 手機：面板收下去，才看得到跳過去的那一格、3D 視角和畫記
    if (isPhoneLayout()) setSheetOpen(false);
    void session.open(c);
    revealStage(stageRef.current);
    requestAnimationFrame(() => {
      const el = document.getElementById(`comment-${c.id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        el.classList.add('song-comment--flash');
        setTimeout(() => el.classList.remove('song-comment--flash'), 1500);
      }
    });
  }, [session]);
  const startDraw = useCallback(() => {
    if (!session.draft.start()) return;
    // 手機、iPad：3D 畫面捲回來畫（不跳鍵盤；手機的面板也收下去）；電腦：留言框拿到焦點，畫好直接打字
    if (isPhoneLayout()) setSheetOpen(false);
    if (isTouchDevice()) { setTab('review'); revealStage(stageRef.current); }
    else focusComposer();
  }, [session.draft, focusComposer]);

  // ── 交影片（admin / 負責這首歌的動畫師；歌沒指派人 = 專案裡的動畫師都可以）──
  const videoPerm = { accountRole: user?.role ?? null, projectRole, userId: user?.id ?? null, song: selectedSong };
  const canAdd = canAddVideo(videoPerm);
  const [addOpen, setAddOpen] = useState(false);
  const allJobs = useVideoJobs(projectId);
  const songJobs = useMemo(() => allJobs.filter(j => j.songId === selectedSongId), [allJobs, selectedSongId]);
  useWarnBeforeUnloadWhileUploading();
  const reloadVersions = versions.reload;
  const selectVersionRef = useRef(versions.select);
  selectVersionRef.current = versions.select;
  // 交的影片好了 → 這首歌選到新的一版、放到 LED 上停在第一格（按播放才開始；在別首歌的話，回去那首就是新的一版）
  const onJobDone = useCallback((job: VideoJob) => {
    if (job.projectId !== projectId) return;
    const here = job.songId === selectedSongIdRef.current;
    toast.success(`${job.songLabel}：${job.result?.label || '新的一版'} 好了${here ? '，LED 已經換成這一版，按播放開始看' : ''}`);
    if (here) {
      chooseSource('version');
      // 選到新的那一版（正在看的版本平常會固定住，自己交的要換過去）
      void reloadVersions().then(() => { if (job.result) selectVersionRef.current(versionKey(job.result.id)); });
    }
    void reloadSongs();
  }, [projectId, chooseSource, reloadVersions, reloadSongs]);
  useVideoJobDone(onJobDone);

  async function handleDeleteVersion(item: VersionItem) {
    if (!selectedSong || !(await confirmDialog({ ...splitQuestion(deleteVersionMessage(item)), confirmLabel: '永久刪除', destructive: true }))) return;
    try {
      await deleteSongVideo(projectId, selectedSong.id, item.id);
      toast.success(`已刪除 ${item.label}`);
      await versions.reload();
      void reloadSongs();
    } catch (e) {
      toast.error('刪除失敗：' + friendlyError(e));
    }
  }
  async function handleEditNote(item: VersionItem) {
    if (!selectedSong) return;
    if (await editVersionNote(projectId, selectedSong.id, item)) await versions.reload();
  }
  const canModifyPending = (v: SongVideo) => canModifyVideo({ ...videoPerm, item: { kind: 'version', byId: v.createdBy?.id ?? null } });
  async function handleRetryPending(v: SongVideo) {
    if (!selectedSong) return;
    try { await retrySongVideo(projectId, selectedSong.id, v.id); await versions.reload(); }
    catch (e) { toast.error('重試失敗：' + friendlyError(e)); }
  }
  async function handleRemovePending(v: SongVideo) {
    if (!selectedSong) return;
    const name = v.title || '這一版';
    if (!(await confirmDialog(removePendingQuestion(v, name)))) return;
    try { await deleteSongVideo(projectId, selectedSong.id, v.id); await versions.reload(); }
    catch (e) { toast.error('沒有成功：' + friendlyError(e)); }
  }
  // 上傳停住的那一版（傳的分頁關掉了）：每一段都傳上來了 → 有權限的人打開就自動完成；還有段沒傳 → 選同一個檔案接著傳
  const trackedIds = useMemo(() => trackedVideoIds(songJobs), [songJobs]);
  const stalled = useStalledUploads({
    // 預覽（只能看）不幫人完成上傳
    projectId, songId: goneMessage ? null : selectedSongId, pending: versions.pending, trackedIds, canModify: (v) => !va.readOnly && canModifyPending(v),
    onFinished: (video) => {
      if (video) toast.success(`「${video.title || (selectedSong ? songTitle(selectedSong) : '影片')}」上傳完成，變成 ${video.label || '新的一版'}`);
      void reloadVersions();
      void reloadSongs();
    },
  });
  function handleResumePending(v: SongVideo, file: File) {
    if (!selectedSong) return;
    const problem = resumeFileProblem(v, file);
    if (problem) { toast.warn(problem); return; }
    videoJobs.startUpload({ projectId, songId: selectedSong.id, songLabel: songTitle(selectedSong), file, note: v.note || undefined, resumeVideoId: v.id });
  }

  // ── Actions ──

  /** 改狀態；成功回 true。帶上畫面上以為的目前狀態 → 別人剛改過的話後台回 409，不會蓋掉 */
  async function changeStatus(song: Song, to: Song['status']): Promise<boolean> {
    const expected = song.status;
    const setStatus = (status: Song['status']) => {
      const next = songsRef.current.map(s => s.id === song.id ? { ...s, status } : s);
      songsRef.current = next;
      setSongs(next);
    };
    setStatus(to);
    try {
      await api.updateSong(projectId, song.id, { status: to, expectedStatus: expected });
      return true;
    } catch (e) {
      const status = api.errorStatus(e);
      if (status === 409) {
        const stale = staleStatusMessage((e as api.ApiError).data?.currentStatus, expected);
        const list = await reloadSongs();
        if (!list) setStatus(expected);
        toast.warn(stale ?? friendlyError(e));
      } else if (status === 404) {
        // 歌被刪了（reloadSongs 會講）或整個專案不見了（會換成說明頁）
        const list = await reloadSongs();
        if (list && list.some(s => s.id === song.id)) {
          setStatus(expected);
          toast.error('狀態沒有改成：' + friendlyError(e));
        }
      } else {
        setStatus(expected);
        toast.error('狀態沒有改成：' + friendlyError(e));
      }
      return false;
    }
  }

  /** 提交審查（附一段話給導演）；成功回 true */
  async function handleSubmitForReview(song: Song, note: string, attachmentIds: string[] = []): Promise<boolean> {
    if (!user) return false;

    // 先確認這首歌有影片：有交過版本（V1、V2…）就好；沒有的話看舊的 Drive 影片（先同步一次）
    let hasVideo = !!song.latestVideoId;
    if (!hasVideo) {
      try {
        // 先試強制同步（worker 端如果該 project 沒設 Drive 會 500，吞掉繼續）
        try { await api.syncDriveProject(projectId); } catch { /* 沒設 Drive 也 OK */ }
        const allFiles = await api.listDriveProjectFiles(projectId);
        hasVideo = allFiles.some(f => f.songId === song.id && (f.mimeType?.startsWith('video/')));
      } catch { /* 抓失敗就不擋 */ }
    }

    if (!hasVideo) {
      const ok = await confirmDialog({
        title: `「${song.name}」還沒有影片，還是要提交審查嗎？`,
        message: '導演看到的會是空的，建議先按「加影片」交一版。',
        confirmLabel: '還是提交',
        cancelLabel: '先不要',
      });
      if (!ok) return false;
    }

    // 先改狀態（被導演搶先改掉的話，就不要送出「提交審查」的留言）
    const ok = await changeStatus(song, 'in_review');
    if (!ok) return false;

    if (note.trim() || attachmentIds.length) {
      const text = note.trim() ? `[提交審查] ${note.trim()}` : '[提交審查]';
      try {
        // 記在交上去的那一版（最新一版）：導演在「這一版」就看得到，不會變成「舊留言」
        const updated = await api.postSongComment(projectId, song.id, { text, mentions: extractMentions(text, members), videoId: song.latestVideoId ?? null, attachmentIds });
        setSongComments(song.id, updated);
      } catch (e) {
        toast.warn('已提交審查，但附的那段話沒送出去：' + friendlyError(e));
        return true;
      }
    }
    // 導演會收到站內通知（小鈴鐺），導演頁 30 秒內也會自動更新
    toast.success('已提交審查，導演會收到通知（右上角的小鈴鐺）', 6000);
    return true;
  }

  async function refreshSongComments(songId: string) {
    try { setSongComments(songId, await api.listSongComments(projectId, songId)); }
    catch (e) { toast.error('留言讀取失敗：' + friendlyError(e)); }
  }

  /* ──────────── UI ──────────── */

  // 鍵盤（[ / ] 切歌、Shift+J / K 切 cue、播放快捷鍵）在上面的 useReviewSession

  // ── 動畫師「帶著做」（步驟和規則：lib/tutorial/animatorTour.ts；亮框和說明框：components/TourOverlay.tsx）──
  const [tourIndex, setTourIndex] = useState<number | null>(null);
  const tourAutoRef = useRef(false);
  // LED 現在有沒有畫面：跟 StageScene 決定要不要顯示測試圖是同一個條件（影片 / 本地圖片 / AE 即時有在送）
  const ledHasPicture = (videoMode && player.ready)
    || (source === 'file' && media.active?.kind === 'image' && !!media.image)
    || (source === 'ndi' && !!ndiGuide?.hasFrame);
  const producerNames = useMemo(() => members.filter(m => m.role === 'admin').map(m => m.name), [members]);
  const tourSteps = useMemo(() => animatorTourSteps({ ledHasPicture, producerNames }), [ledHasPicture, producerNames]);
  const tourStepId = tourIndex !== null ? tourSteps[Math.min(tourIndex, tourSteps.length - 1)]?.id ?? null : null;
  // 專案資料、我的角色、歌單都載好、而且有選到歌之後，第一次進來自動跑一次（同一個分頁只判斷一次）
  const tourReady = nameStatus === 'ready' && myRole !== undefined && !songsLoading && !!selectedSongId;
  useEffect(() => {
    if (tourAutoRef.current || !tourReady) return;
    tourAutoRef.current = true;
    const store = browserStorage();
    if (!shouldAutoStartTour({ projectRole, viewAsActive: va.active, seen: readTourSeen(store) })) return;
    markTourSeen(store);   // 一跳出來就記下來：關掉分頁也不會被逼著再看一次（想再看從「使用說明」選單叫）
    setTourIndex(0);
  }, [tourReady, projectRole, va.active]);
  // 錄影中整頁鎖住：正在帶的話先關掉
  useEffect(() => { if (recorder.locked) setTourIndex(null); }, [recorder.locked]);
  // 「轉轉看舞台」：LED 來源是 AE 即時、而且 AE 沒在送畫面（3D 上蓋著連線說明卡）→ 先換成「本地檔案」（跟他自己按一樣、會記住），舞台和測試圖才看得到
  useEffect(() => {
    if (tourStepId !== 'stage') return;
    if (source === 'ndi' && !ndiGuide?.hasFrame) chooseSource('file');
  }, [tourStepId]);  // eslint-disable-line react-hooks/exhaustive-deps
  // 「轉轉看舞台」：在舞台上按住拖一下（超過 20px）→ 0.6 秒後自動到下一步（這之間他自己按了下一步就不會再跳一次）
  useEffect(() => {
    if (tourStepId !== 'stage') return;
    const el = document.querySelector<HTMLElement>('[data-tour="stage"]');
    if (!el) return;
    const stageIdx = tourSteps.findIndex(s => s.id === 'stage');
    let down: { x: number; y: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const onMove = (e: PointerEvent) => {
      if (!down || timer) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 20) return;
      down = null;
      timer = setTimeout(() => setTourIndex(i => (i === stageIdx ? stageIdx + 1 : i)), 600);
    };
    const onUp = () => { down = null; };
    el.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (timer) clearTimeout(timer);
    };
  }, [tourStepId, tourSteps]);
  // 「把你的動畫放上去」：來源是本地檔案、而且已經有一支放在 LED 上 → 說明框換成「成功了」（不自動往下）
  const tourStepDone = tourStepId === 'local-file' && source === 'file' && !!media.active;
  // 使用說明的選單：說明頁、上手教學（開新分頁，舞台、AE 即時連線都不會不見）、再帶一遍（任何身分、「用動畫師的畫面看」都能叫）
  const helpMenuItems = [
    { key: 'help', label: '使用說明', icon: BookOpen, href: helpUrl(HELP_ANCHORS.animator), external: true },
    { key: 'tutorial', label: '上手教學', icon: GraduationCap, href: ANIMATOR_TUTORIAL_PATH, external: true },
    { key: 'tour', label: '帶我走一遍', icon: Footprints, onSelect: () => setTourIndex(0) },
  ];

  // 帳號不是全站製作、但在這個專案是製作：可以進專案編輯頁（全站製作從管理頁進）
  const canEditProject = !!user && user.role !== 'admin' && projectRole === 'admin' && !va.active;

  const topBar = (
    <header className="studio-top">
      <button className="studio-top__back" onClick={() => navigate('/studio')} title="所有專案" aria-label="所有專案"><Icon icon={ArrowLeft} size="md" /></button>
      <span className="studio-top__role">動畫師</span>
      <span className="studio-top__project" title={projectName || undefined}>
        {projectName ? <span className="studio-top__name">{projectName}</span> : (nameStatus === 'error' && !goneMessage ? (
          <>
            {projectId}（讀取失敗）
            <button className="btn btn--ghost" onClick={() => refreshAll()} style={{ marginLeft: 8, padding: '3px 10px', fontSize: 12 }}>重試</button>
          </>
        ) : goneMessage ? '' : '…')}
        {projectArchived && <span className="studio-top__archived">已封存，只能看</span>}
      </span>
      <span className="grow" />
      {/* 這個專案的製作（帳號不是全站製作）：進專案編輯頁 */}
      {canEditProject && (
        <Link className="studio-top__help ovf-hide-narrow" to={projectEditorPath(projectId)} title="編輯這個專案（你是這個專案的製作）"><Icon icon={Pencil} /> 編輯專案</Link>
      )}
      {/* 開新分頁：舞台、AE 即時連線都不會不見 */}
      <OverflowMenu
        className="ovf-hide-narrow"
        label="使用說明"
        trigger={{ icon: BookOpen, text: ' 使用說明', className: 'studio-top__help ovf-hide-narrow', dataTour: 'help' }}
        items={helpMenuItems}
      />
      {/* 設定頁有 NDI / AE 連線檢查 */}
      <Link className="studio-top__help ovf-hide-narrow" to="/settings">設定</Link>
      <NotificationBell />
      {/* 手機：使用說明、設定、登出收進「⋯」 */}
      <OverflowMenu
        className="ovf-only-narrow"
        header={user ? `${user.name} · 動畫師工作站` : undefined}
        items={[
          ...(canEditProject ? [{ key: 'edit', label: '編輯專案', icon: Pencil, onSelect: () => navigate(projectEditorPath(projectId)) }] : []),
          ...helpMenuItems,
          { key: 'settings', label: '設定（AE 即時連線檢查）', icon: Settings, onSelect: () => navigate('/settings') },
          ...(user && !va.active ? account.itemsAfterSeparator : []),
          ...(user ? [{ key: 'logout', label: '登出', icon: LogOut, danger: true, separatorBefore: true, onSelect: async () => { await logout(); navigate('/login'); } }] : []),
        ]}
      />
      {user && (
        <span className="studio-top__user ovf-hide-narrow">
          {/* 「用其他身分看」時畫面上的「我」是被看的人，不能在這裡改名字（改的是製作自己的帳號） */}
          {va.active ? (
            <>
              <span className="avatar avatar--sm" style={{ background: user.avatarColor }} title={user.name}>{user.name[0]}</span>
              <span className="studio-top__user-name">{user.name}</span>
            </>
          ) : <AccountMenu nameClassName="studio-top__user-name" />}
          <button className="link-btn" onClick={async () => { await logout(); navigate('/login'); }}>登出</button>
        </span>
      )}
    </header>
  );

  if (goneMessage) {
    return (
      <div className="studio">
        {topBar}
        <div className="studio-empty studio-gone">
          <h2>看不到這個專案</h2>
          <p>{goneMessage}</p>
          <button className="btn btn--primary" onClick={() => navigate('/studio')} style={{ marginTop: 16 }}>回專案清單</button>
        </div>
      </div>
    );
  }

  return (
    <div className="studio">
      {topBar}

      <div className="studio-body">
        <aside className={'studio-songs' + (songsSheetOpen ? ' is-sheet-open' : '')} ref={songsAsideRef}>
          {/* 手機：上面一行寫現在這首歌，點了才打開整個歌單（直的清單，不會左右捲、卡片不會被切掉） */}
          <button
            type="button"
            className="studio-songs__toggle"
            onClick={() => setSongsSheetOpen(o => !o)}
            aria-expanded={songsSheetOpen}
            aria-label={songsSheetOpen ? '收起歌單' : '打開歌單（換歌）'}
          >
            <Icon icon={ListMusic} size="sm" />
            <span className="studio-songs__toggle-name">
              {selectedSong ? <>{selectedSong.code && <span className="song-code">{selectedSong.code}</span>}{selectedSong.name}</> : '選一首歌'}
            </span>
            <span className="studio-songs__toggle-count">{source === 'file' ? `本地檔案 ${media.items.length}` : `${visibleSongs.length} 首`}</span>
            <Icon icon={songsSheetOpen ? ChevronUp : ChevronDown} size="sm" />
          </button>
          <div className="studio-songs__sheet">
          <div className="studio-songs__head">
            <div className="studio-songs__title">歌曲</div>
            {!isAdmin && (
              <div className="studio-songs__filter">
                <button
                  className={'tab' + (songFilter === 'mine' ? ' is-active' : '')}
                  onClick={() => setSongFilter('mine')}
                  data-tour="songs-mine"
                >我的</button>
                <button
                  className={'tab' + (songFilter === 'all' ? ' is-active' : '')}
                  onClick={() => setSongFilter('all')}
                >全部</button>
              </div>
            )}
            <input
              type="text"
              className="studio-songs__search"
              value={songSearch}
              onChange={e => setSongSearch(e.target.value)}
              placeholder="搜尋歌名…"
            />
          </div>

          {songsLoading && <div className="studio-songs__empty"><Icon icon={LoaderCircle} spin /> 載入中…</div>}
          {songsError && (
            <div className="studio-songs__empty studio-songs__empty--err">
              {songsError}
              <div><button className="btn btn--ghost" onClick={() => refreshAll()} style={{ marginTop: 8 }}>重試</button></div>
            </div>
          )}
          {!songsLoading && !songsError && visibleSongs.length === 0 && (
            <div className="studio-songs__empty">
              {songSearch.trim() ? '沒有符合的歌'
                : effectiveFilter === 'mine'
                  ? (songs.length > 0
                    ? <>還沒有指派給你的歌<br /><button type="button" className="link-btn studio-songs__empty-action" onClick={() => setSongFilter('all')}>看全部的歌</button></>
                    : '這個專案還沒有歌')
                  : '這個專案還沒有歌'}
            </div>
          )}

          <ul className="studio-songs__list">
            {visibleSongs.map(s => {
              const unread = unreadOf(s.id);
              const newer = newVersionLabel(s);
              return (
                <li key={s.id}>
                  <button
                    className={'studio-songs__item' + (s.id === selectedSongId ? ' is-active' : '')}
                    onClick={() => { setSelectedSongId(s.id); setSongsSheetOpen(false); }}
                  >
                    <span className={'status-dot status-dot--' + s.status} title={STATUS_LABEL[s.status]} />
                    {/* 歌名放不下時「有新版」「新留言」換到第二行，歌名不會被擠成「S01 ··」 */}
                    <span className="studio-songs__item-body">
                      <span className="studio-songs__item-name">
                        {s.code && <span className="song-code" title="歌曲代號">{s.code}</span>}
                        {s.name}
                      </span>
                      {newer && (
                        <span className="studio-songs__item-newer" title={`導演上次看的是 V${s.reviewedVersion ?? s.lastReview?.version ?? ''}，${newer} 還沒審`}>
                          <Icon icon={Film} size="xs" /> 有新版 {newer}
                        </span>
                      )}
                      {unread > 0 && (
                        <span className="studio-songs__item-unread" title={`${unread} 則新留言`}>
                          <CommentIcon />{unread}
                        </span>
                      )}
                    </span>
                    <span className="studio-songs__item-count">{s.cueCount}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="studio-songs__hint">
            <span className="studio-songs__hint-item"><kbd>[</kbd>/<kbd>]</kbd> 切歌</span>
            <span className="studio-songs__hint-sep" aria-hidden="true">·</span>
            <span className="studio-songs__hint-item"><kbd>Shift</kbd>+<kbd>J</kbd>/<kbd>K</kbd> 切 cue</span>
          </div>

          {/* 本地檔案清單（選了「本地檔案」才有）：跟分享頁一樣，點哪個 LED 就放哪個，只在這台電腦播 */}
          {source === 'file' && (
            <ShareSetlist
              items={media.items}
              activeId={media.active?.id ?? null}
              activePlaying={player.playing}
              activeDuration={player.duration}
              fileDragOver={dragOver}
              onSelect={media.select}
              onRemove={media.remove}
              onMove={media.move}
              onAddFiles={addFiles}
            />
          )}
          </div>
        </aside>

        <main
          className="studio-stage"
          onDragOver={(e) => { if (selectedSong && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false); }}
          onDrop={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return;
            e.preventDefault();
            setDragOver(false);
            addFiles(e.dataTransfer.files);
          }}
        >
          {selectedSong ? (
            <>
              <LedSourceSwitch
                source={source}
                // 手機、iPad：選「本地檔案」把歌單打開（本地檔案的清單和「加入影片 / 圖片」在歌單裡）
                onChange={(s) => { chooseSource(s); if (s === 'file' && isCompactLayout()) setSongsSheetOpen(true); }}
                showVersion
                /* 正在放哪一版就寫哪一版（比較時切到 V1 不會還寫「影片 V2」） */
                versionLabel={(source === 'version' ? selectedVersion?.label : null) || versions.items[0]?.label || (selectedSong.latestVideoVersion ? `V${selectedSong.latestVideoVersion}` : null)}
                status={source === 'ndi'
                  ? (!ndiGuide ? '連線中…'
                    : ndiGuide.step === 'live'
                    ? <><span className="ndi-dot ndi-dot--on" aria-hidden="true" /> {ndiGuide.source ?? 'AE'}{ndiGuide.fps != null ? ` · ${ndiGuide.fps} fps` : ''}</>
                    : ndiShortLabel(ndiGuide))
                  : source === 'version'
                  ? (selectedVersion
                    ? `${player.playing ? '播放中' : '暫停'} · ${selectedVersion.label}${selectedVersion.title ? ` · ${selectedVersion.title}` : ''}`
                    : versions.status === 'loading' ? '讀取影片中…' : '這首歌還沒有影片')
                  : media.active?.kind === 'video' ? <><Icon icon={player.playing ? Play : Pause} size="xs" /> {media.active.name}</>
                  : media.active ? <><Icon icon={Image} size="xs" /> {media.active.name}</>
                  : media.items.length > 0 ? '點清單裡的檔案，放到 LED 上' : '還沒選檔案'}
              >
                {ledChip && <LedTemplateChip chip={ledChip} onToggleFullView={() => setLedFullView(v => !v)} onPickSegment={setLedSegPick} />}
                <HelpLink anchor={HELP_ANCHORS.animSource} />
              </LedSourceSwitch>
              <LedTemplateHint hint={ledHint} />
              {/* 這首歌交上來的影片：V3、V2、V1…（點哪一版就放到 LED 上）＋ 加影片 */}
              <SongVersionBar
                status={versions.status}
                error={versions.error}
                items={versions.items}
                selectedKey={source === 'version' ? (versions.selected?.key ?? null) : null}
                onSelect={(key) => { versions.select(key); chooseSource('version'); }}
                pending={versions.pending}
                jobs={songJobs}
                onRetryLoad={() => { void versions.reload(); }}
                onAdd={canAdd ? () => setAddOpen(true) : undefined}
                canDelete={(it) => canModifyVideo({ ...videoPerm, item: it })}
                onDelete={handleDeleteVersion}
                onEditNote={handleEditNote}
                canModifyPending={canModifyPending}
                onRetryPending={handleRetryPending}
                onRemovePending={handleRemovePending}
                stalled={stalled.views}
                onResumePending={handleResumePending}
                onRetryFinish={stalled.retryFinish}
                emptyText={canAdd ? '還沒有影片，按右邊「加影片」交第一版給導演看' : '這首歌還沒有影片'}
                newVersion={source === 'version' ? newVersion : null}
                ledCanvas={view.ledCanvas}
                songTemplate={songTplPlan}
                extra={videoMode ? recordButton('vbar__btn', true) : undefined}
              />
              <div className="studio-stage__scene" ref={stageRef} data-tour="stage">
                <StageScene
                  key={`${projectId}:${selectedSongId}`}
                  states={viewportStates}
                  stageObjects={stageObjects}
                  selectedObjectIds={[]}
                  onSelect={() => {}}
                  onTransform={() => {}}
                  cueName={selectedCue?.name}
                  modelUrl={modelUrl}
                  readOnly
                  enableNdi={source === 'ndi'}
                  onNdiStatus={setNdiGuide}
                  ndiGuide
                  ndiGuideHint="沒有 AE？按上面的「本地檔案」把影片放到 LED 上，或按「加影片」交給導演看"
                  ledVideo={videoMode && player.ready ? player.video : null}
                  ledImage={source === 'file' && media.active?.kind === 'image' ? media.image : null}
                  ledTemplate={ledChoice.plan}
                  ledTimeline={ledChoice.timeline ?? null}
                  ledTimelineSec={ledTimeSec}
                  ledSongTemplate={ledSongTpl}
                  onNdiFrameSize={setAeFrameSize}
                  poseAtFrame={poseAtFrame}
                  cueKey={selectedCueId}
                  crossfadeSeconds={cueTransitionSeconds(selectedCue)}
                  bookmarkScope={projectId}
                  scaleCorrection={view.scaleCorrection}
                  onScaleCorrectionChange={view.canEdit ? view.setScaleCorrection : undefined}
                  stageProps={band.stageProps}
                  onStagePropsChange={band.onStagePropsChange}
                  stagePropsHistory={band.history}
                  cameraBookmarks={camBm.bookmarks}
                  onCameraBookmarksChange={camBm.onChange}
                  stageShow={{
                    title: selectedSong ? songTitle(selectedSong) : undefined,
                    // 全螢幕預演小條的播放 / 暫停 + 時間：有影片是影片的；沒影片、有音樂是音樂的
                    transport: videoMode
                      ? { playing: player.playing, time: player.time, duration: player.duration, onTogglePlay: player.togglePlay }
                      : musicMode
                        ? { playing: musicPlayer.playing, time: musicPlayer.time, duration: musicPlayer.duration, onTogglePlay: musicPlayer.togglePlay }
                        : undefined,
                  }}
                  {...mech.sceneProps}
                  {...(musicMode ? { mechanismAtFrame: musicMechAtFrame } : null)}
                  toolbarMode={isAnimatorViewer ? 'viewer' : 'full'}
                  lookSettings={isAnimatorViewer ? view.lookSettings : personalLook.effective}
                  onLookSettingsChange={isAnimatorViewer ? undefined : personalLook.set}
                  lookCustomized={isAnimatorViewer ? false : personalLook.customized}
                  onLookReset={isAnimatorViewer ? undefined : personalLook.reset}
                  onLookSaveAsDefault={view.canEdit ? () => view.setLookSettings(personalLook.effective) : undefined}
                  materialOverrides={view.materialOverrides}
                  homeView={view.homeView}
                  onHomeViewChange={view.canEdit ? view.setHomeView : undefined}
                  onMaterialOverrideChange={view.canEdit ? view.setMaterialOverride : undefined}
                  projectName={projectName}
                  ledCanvas={view.ledCanvas}
                  ledOffPieces={view.ledOffPieces}
                  onLedCanvasChange={view.canEdit ? view.setLedCanvas : undefined}
                  viewApiRef={viewApiRef}
                  transportKeys
                >
                  <AnnotationLayer
                    draft={session.draft}
                    showing={session.showing}
                    showingLabel={openedComment ? `${openedComment.author}${(openedComment.annotation?.t ?? openedComment.time) > 0 ? ` · ${formatClockShort(openedComment.annotation?.t ?? openedComment.time)}` : ''}` : undefined}
                    onHideShowing={session.clearSelection}
                    onDone={focusComposer}
                    stickers={session.stickers}
                    showingAttachments={openedComment?.attachments}
                  />
                </StageScene>
                {/* 比較兩版時，LED 現在放的是哪一版 */}
                <LedCompareBadge compare={compare} />
                {/* 歌曲影片的小播放器（浮在 3D 畫面上，可以拖、可以收起來；不會蓋到下面的 cue 列） */}
                {selectedVersion && (
                  <MiniPlayer
                    player={player}
                    label={selectedVersion.label}
                    detail={versionByline(selectedVersion) || selectedVersion.title}
                    storageKey="sp_mini_player:studio"
                    extra={recordButton('mini-player__btn', false)}
                    collapseOnTouch
                    onRetry={retryVersion}
                    compare={compare}
                    comments={selectedComments}
                    onAddCommentAtTime={canPostComment({ role: projectRole, userId: user?.id ?? null, song: selectedSong })
                      ? va.guard((t: number) => { setPendingCommentTime(t); focusComposer(); })
                      : undefined}
                    review={{
                      session, activeId: activeCommentId, onOpenComment: openComment,
                      onDraw: canPostComment({ role: projectRole, userId: user?.id ?? null, song: selectedSong }) ? va.guard(startDraw) : undefined,
                    }}
                  />
                )}
                {dragOver && (
                  <div className="share-overlay share-overlay--drop">放開，影片 / 圖片會加進本地檔案清單、放在 LED 上（只在這台電腦播，不會上傳）</div>
                )}
                {!dragOver && source === 'version' && versions.status === 'ready' && versions.items.length === 0 && (
                  <div className="share-overlay">
                    <strong>這首歌還沒有影片</strong>
                    {canAdd ? (
                      <>
                        <span>交一版影片，導演就能在 LED 上看到（V1、V2… 會自動編號）。</span>
                        <button type="button" className="btn btn--primary" onClick={() => setAddOpen(true)} style={{ alignSelf: 'flex-start' }} {...va.ro()}>加影片</button>
                      </>
                    ) : (
                      <span>負責這首歌的動畫師交了影片之後，這裡會自動出現。</span>
                    )}
                  </div>
                )}
                {!dragOver && source === 'file' && media.items.length === 0 && (
                  <div className="share-overlay">
                    <strong>把影片或圖片拖進來，或按左邊「加入影片 / 圖片…」</strong>
                    <span>只在這台電腦放到 LED 上，不會上傳、別人看不到。要給導演看請按「加影片」。</span>
                    <span className="share-overlay__hint">畫面要是跟 AE 送 NDI 時一樣的整張畫布，才會對到每一片 LED。</span>
                  </div>
                )}
                {!dragOver && source === 'file' && media.active && (media.active.kind === 'video' ? player.error : media.imageError) && (
                  <div className="share-overlay share-overlay--error">
                    <strong><Icon icon={TriangleAlert} /> {media.active.kind === 'video' ? player.error : media.imageError}</strong>
                  </div>
                )}
              </div>
              {/* 本地影片的播放列（跟分享頁一樣） */}
              {fileVideoMode && media.active && (
                <div className="share-player">
                  <button className="share-player__btn" onClick={player.togglePlay} title={player.playing ? '暫停' : '播放'} aria-label={player.playing ? '暫停' : '播放'}>
                    <Icon icon={player.playing ? Pause : Play} />
                  </button>
                  <span className="share-player__time">{formatClock(player.time)} / {formatClock(player.duration)}</span>
                  <input
                    className="share-player__seek"
                    type="range" min={0} max={player.duration || 0} step={0.01}
                    value={Math.min(player.time, player.duration || 0)}
                    onChange={(e) => player.seek(parseFloat(e.target.value))}
                    aria-label="影片時間"
                  />
                  <button
                    className={'share-player__btn' + (player.loop ? ' is-active' : '')}
                    onClick={() => player.setLoop(!player.loop)}
                    title={player.loop ? '循環播放：開' : '循環播放：關'}
                    aria-label={player.loop ? '循環播放：開' : '循環播放：關'}
                  ><Icon icon={Repeat} /></button>
                  <button
                    className="share-player__btn"
                    onClick={() => player.setMuted(!player.muted)}
                    title={player.muted ? '開聲音' : '靜音'}
                    aria-label={player.muted ? '開聲音' : '靜音'}
                  ><Icon icon={player.muted ? VolumeX : Volume2} /></button>
                  <span className="share-player__name" title={media.active.name}>{media.active.name}</span>
                  {recordButton('share-player__btn', false)}
                  <button
                    className="share-player__btn"
                    onClick={() => { if (media.active) media.remove(media.active.id); }}
                    title="從清單移除這支影片"
                    aria-label="從清單移除這支影片"
                  ><Icon icon={X} /></button>
                </div>
              )}
              {videoMode && (recorder.unsupported || recorder.lastDone || recorder.error) && (
                <p className="record-done" role="status">
                  {recorder.error ? `錄影沒成功：${recorder.error}`
                    : recorder.lastDone ? `已存成 ${recorder.lastDone.fileName}（${(recorder.lastDone.bytes / 1048576).toFixed(1)} MB，${progressLabel({ elapsed: recorder.lastDone.seconds, length: recorder.lastDone.seconds })}）${recorder.lastDone.partial ? '，中途停止，只有錄到的這一段' : ''}${recorder.lastDone.isMp4 ? '' : `。${WEBM_NOTE}`}`
                    : `錄成影片：${recorder.unsupported}`}
                </p>
              )}
              {/* 音樂播放列（沒有影片、有音樂）：播放 / 暫停、拖時間；cue 列、3D 的機關跟著音樂走。動畫師只能聽 */}
              {musicMode && songMusic.summary && (
                <MusicBar player={musicPlayer} label={songMusic.summary.filename} onReload={songMusic.reload} loadError={songMusic.error} />
              )}
              {masterCues.length > 0 && (
                <div className="studio-cuebar" data-tour="cue-bar">
                  <span className="studio-cuebar__label">Cue</span>
                  <button
                    className="studio-cuebar__nav"
                    onClick={() => {
                      const idx = masterCues.findIndex(c => c.id === selectedCueId);
                      const next = idx <= 0 ? masterCues.length - 1 : idx - 1;
                      selectCueByUser(masterCues[next]);
                    }}
                    title="上一個 cue (Shift+K)"
                    aria-label="上一個 cue"
                  ><Icon icon={ChevronLeft} size="md" /></button>
                  <div className="studio-cuebar__track">
                    {masterCues.map((c, i) => (
                      <button
                        key={c.id}
                        className={'studio-cuebar__cue' + (c.id === selectedCueId ? ' is-active' : '')}
                        onClick={() => selectCueByUser(c)}
                        title={c.videoTimeSec != null ? `${c.name}（影片 ${formatClock(c.videoTimeSec)}）` : c.name}
                      >
                        <span className="studio-cuebar__num">{i + 1}</span>
                        <CueNumBadge cue={c} /><span className="studio-cuebar__name">{c.name}</span>
                      </button>
                    ))}
                  </div>
                  <button
                    className="studio-cuebar__nav"
                    onClick={() => {
                      const idx = masterCues.findIndex(c => c.id === selectedCueId);
                      const next = idx < 0 ? 0 : (idx + 1) % masterCues.length;
                      selectCueByUser(masterCues[next]);
                    }}
                    title="下一個 cue (Shift+J)"
                    aria-label="下一個 cue"
                  ><Icon icon={ChevronRight} size="md" /></button>
                  <span className="studio-cuebar__hint">
                    {selectedCueId ? `${masterCues.findIndex(c => c.id === selectedCueId) + 1}/${masterCues.length}` : `0/${masterCues.length}`}
                  </span>
                </div>
              )}
            </>
          ) : (
            songsLoading ? (
              <div className="studio-stage__empty"><Icon icon={LoaderCircle} spin /> 載入中…</div>
            ) : songs.length === 0 ? (
              <EmptyState icon={ListMusic} title="這個專案還沒有歌">
                製作在管理頁加上歌曲、指派給你之後，就會出現在這裡，你也會收到通知（右上角的小鈴鐺）。
              </EmptyState>
            ) : visibleSongs.length === 0 && songSearch.trim() ? (
              <EmptyState icon={SearchX} title={`找不到「${songSearch.trim()}」`} actions={<button className="btn btn--ghost" onClick={() => setSongSearch('')}>清除搜尋</button>}>
                換個歌名或歌曲代號試試看。
              </EmptyState>
            ) : visibleSongs.length === 0 && effectiveFilter === 'mine' ? (
              <EmptyState
                icon={UserRoundSearch}
                title="還沒有指派給你的歌"
                actions={<button className="btn btn--primary" onClick={() => setSongFilter('all')}>先看全部的歌</button>}
              >
                製作把歌指派給你之後，會出現在「我的」，你也會收到通知（右上角的小鈴鐺）。這個專案目前有 {songs.length} 首歌。
              </EmptyState>
            ) : (
              <EmptyState icon={Music} title="先挑一首歌">
                從歌曲清單點一首歌，3D 舞台、影片和留言會出現在這裡。鍵盤 [ / ] 也可以切歌。
              </EmptyState>
            )
          )}
        </main>

        {/* 手機：面板拉開時，上面其餘的畫面壓暗，點一下收回去（電腦、iPad 這個不顯示） */}
        {sheetOpen && <div className="studio-scrim" onClick={() => setSheetOpen(false)} aria-hidden="true" />}
        <aside className={'studio-right' + (sheetOpen ? ' is-open' : '')}>
          {/* 手機：這一排收起來時就是面板露出來的那一條；點哪一個分頁就拉開到哪一頁，再點一次收起來 */}
          <div className="studio-right__tabs">
            <button
              className={'tab' + (tab === 'cues' ? ' is-active' : '')}
              onClick={() => { setSheetOpen(o => (tab === 'cues' ? !o : true)); setTab('cues'); }}
            >Cue（{masterCues.length}）</button>
            <button
              className={'tab' + (tab === 'review' ? ' is-active' : '')}
              onClick={() => { setSheetOpen(o => (tab === 'review' ? !o : true)); setTab('review'); }}
              title={selectedUnread > 0 ? `${selectedUnread} 則新留言` : undefined}
            >
              審查 / 留言
              {selectedUnread > 0 && tab !== 'review' && <span className="studio-right__tab-badge">{selectedUnread}</span>}
            </button>
            <button
              className={'tab' + (tab === 'activity' ? ' is-active' : '')}
              onClick={() => { setSheetOpen(o => (tab === 'activity' ? !o : true)); setTab('activity'); }}
            ><Icon icon={HistoryIcon} /> 活動</button>
            <button
              type="button"
              className="studio-right__sheet-toggle"
              onClick={() => setSheetOpen(o => !o)}
              aria-expanded={sheetOpen}
              aria-label={sheetOpen ? '收起面板' : '打開面板'}
              title={sheetOpen ? '收起面板' : '打開面板'}
            ><Icon icon={sheetOpen ? ChevronDown : ChevronUp} size="md" /></button>
          </div>
          <div className="studio-right__body">
            {tab === 'cues' && (
              <CuesTab
                cues={masterCues}
                selectedCueId={selectedCueId}
                onSelectCue={selectCueById}
                emptyHint={
                  !selectedSong ? '先挑一首歌'
                  : cuesStatus === 'loading' ? <><Icon icon={LoaderCircle} spin /> 載入 cue 中…</>
                  : cuesStatus === 'error' ? (
                    <>
                      <div><Icon icon={TriangleAlert} /> cue 載入失敗</div>
                      <button className="btn btn--ghost" onClick={() => setCuesReloadKey(k => k + 1)} style={{ marginTop: 8 }}>重試</button>
                    </>
                  )
                  : '這首歌還沒有 cue，請聯絡製作'
                }
              />
            )}
            {tab === 'review' && selectedSong && user && (
              <ReviewTab
                projectId={projectId}
                song={selectedSong}
                user={user}
                projectRole={projectRole}
                members={members}
                comments={selectedComments}
                onCommentsChange={(list) => setSongComments(selectedSong.id, list)}
                onRefreshComments={() => refreshSongComments(selectedSong.id)}
                onChangeStatus={(to) => changeStatus(selectedSong, to)}
                onSubmitForReview={(note, ids) => handleSubmitForReview(selectedSong, note, ids)}
                viewed={(() => {
                  // 正在 LED 上放的那一版；沒在放影片（AE 即時 / 本地檔案）→ 最新一版
                  const it = (source === 'version' && versions.selected?.kind === 'version' ? versions.selected : null)
                    ?? versions.items.find(x => x.kind === 'version' && x.version != null) ?? null;
                  return it && it.version != null ? { id: it.id, version: it.version, label: it.label } : null;
                })()}
                latest={(() => {
                  const it = versions.items.find(x => x.kind === 'version' && x.version != null);
                  return it ? { id: it.id, label: it.label } : null;
                })()}
                hasVersions={versions.hasVersions}
                focusComment={focusComment}
                onSeek={source === 'version' ? (t) => player.seek(t) : undefined}
                session={session}
                videoActive={versionVideoMode}
                playing={player.playing}
                activeId={activeCommentId}
                onOpen={openComment}
                onStartDraw={va.guard(startDraw)}
                composerRef={composerRef}
                pendingTime={pendingCommentTime}
                onConsumedPendingTime={() => setPendingCommentTime(null)}
                projectName={projectName}
                currentTime={player.time}
              />
            )}
            {tab === 'review' && !selectedSong && (
              <div className="studio-right__empty">先挑一首歌</div>
            )}
            {tab === 'activity' && projectId && (
              <ActivityList projectId={projectId} />
            )}
          </div>
        </aside>
      </div>

      {recordOpen && videoMode && (
        <RecordStageDialog
          onClose={() => setRecordOpen(false)}
          onStart={startRecord}
          format={recorder.format}
          bookmarks={camBm.bookmarks}
          currentTime={player.video.currentTime}
          duration={player.duration}
          sourceLabel={recordSource}
        />
      )}
      {recorder.locked && (
        <>
          <div className="record-lock" aria-hidden="true" />
          <div className="record-bar" role="status" aria-live="polite">
            <span className="record-bar__dot" aria-hidden="true" />
            <span className="record-bar__text">
              {recorder.phase === 'preparing' ? '準備錄影…' : recorder.phase === 'saving' ? '正在存檔…' : `錄影中 ${recorder.progress ? progressLabel(recorder.progress) : ''}`}
            </span>
            <span className="record-bar__track"><span className="record-bar__fill" style={{ width: `${Math.round((recorder.progress?.fraction ?? 0) * 100)}%`, display: 'block' }} /></span>
            <button type="button" className="btn btn--ghost" onClick={recorder.stop} disabled={recorder.phase !== 'recording'}>停止</button>
          </div>
        </>
      )}
      {addOpen && selectedSong && (
        <AddVideoDialog
          open
          onClose={() => setAddOpen(false)}
          projectId={projectId}
          song={selectedSong}
          jobs={songJobs}
          canUpload={canAdd}
          onLocalFiles={(files) => addFiles(files)}
          ledCanvas={view.ledCanvas}
        />
      )}
      {/* 動畫師「帶著做」：其他地方變暗、只亮要看的那個；整層不擋滑鼠。錄影中不顯示 */}
      {tourIndex !== null && !recorder.locked && (
        <TourOverlay
          steps={tourSteps}
          index={Math.min(tourIndex, tourSteps.length - 1)}
          onIndex={setTourIndex}
          onClose={() => setTourIndex(null)}
          stepDone={tourStepDone}
          tutorialHref={ANIMATOR_TUTORIAL_PATH}
        />
      )}
    </div>
  );
}

/** 留言小圖示（未讀數字旁邊） */
function CommentIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true" style={{ marginRight: 3, verticalAlign: '-1px' }}>
      <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6A1.5 1.5 0 0 1 12.5 11H7l-3.2 2.6c-.33.27-.8.03-.8-.39V11h-.5A1.5 1.5 0 0 1 1 9.5z" fill="currentColor" />
    </svg>
  );
}

/* ──────────── Cues Tab ──────────── */

function CuesTab({
  cues, selectedCueId, onSelectCue, emptyHint,
}: {
  cues: Cue[];
  selectedCueId: string | null;
  onSelectCue: (id: string) => void;
  emptyHint: ReactNode;
}) {
  if (cues.length === 0) return <div className="studio-right__empty">{emptyHint}</div>;
  return (
    <ul className="studio-cues">
      {cues.map((c, idx) => (
        <li key={c.id}>
          <button
            className={'studio-cues__item' + (c.id === selectedCueId ? ' is-active' : '')}
            onClick={() => onSelectCue(c.id)}
          >
            <span className="studio-cues__num">#{idx + 1}</span>
            <CueNumBadge cue={c} /><span className="studio-cues__name">{c.name}</span>
            {c.crossfadeSeconds > 0 && (
              <span className="studio-cues__cross">{crossfadeLabel(c.crossfadeSeconds)}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ──────────── Review Tab ──────────── */

function ReviewTab({
  projectId, song, user, projectRole, members, comments, onCommentsChange, onRefreshComments,
  onChangeStatus, onSubmitForReview, viewed, latest, hasVersions, focusComment, onSeek,
  session, videoActive, playing, activeId, onOpen, onStartDraw, composerRef, pendingTime, onConsumedPendingTime, projectName, currentTime,
}: {
  projectId: string;
  song: Song;
  user: { id: string; name: string; role: api.UserRole; avatarColor: string };
  projectRole: ProjectRole | null;
  members: ProjectMember[];
  /** 跟歌單未讀數字同一份（自動更新）；undefined = 還沒讀到 */
  comments: SongComment[] | undefined;
  onCommentsChange: (list: SongComment[]) => void;
  onRefreshComments: () => Promise<void>;
  onChangeStatus: (status: Song['status']) => Promise<boolean>;
  onSubmitForReview: (note: string, attachmentIds: string[]) => Promise<boolean>;
  /** 正在看的那一版（沒在放影片 = 最新一版）：留言綁這一版、「這一版」篩選 */
  viewed: { id: string; version: number; label: string } | null;
  /** 最新一版（「已改好（V3）」） */
  latest: { id: string; label: string } | null;
  hasVersions: boolean;
  /** 通知點進來：捲到這則留言 */
  focusComment: { id: string; nonce: number } | null;
  /** 點留言上的影片時間（正在放歌曲影片時才有） */
  onSeek?: (t: number) => void;
  /** 審片（區段、畫記、視角、打開留言） */
  session: ReviewSession;
  videoActive: boolean;
  playing: boolean;
  activeId: string | null;
  onOpen: (c: SongComment) => void;
  onStartDraw: () => void;
  composerRef: React.RefObject<HTMLTextAreaElement>;
  /** 小播放器「在 0:12 加留言」 */
  pendingTime: number | null;
  onConsumedPendingTime: () => void;
  projectName: string;
  /** 影片現在的時間（沒選時間時，留言綁在這裡） */
  currentTime: number;
}) {
  const [note, setNote] = useState('');
  // 參考圖片（貼上 / 拖進來 / 選檔案；換歌時還沒送出的拿掉）
  const uploader = useMemo(() => memberUploader(projectId, song.id), [projectId, song.id]);
  const draft = useAttachmentDraft(uploader, song.id);
  // 圖片檔拖進 3D 畫面、縮圖上的「放到畫面上」→ 貼在畫面上，跟留言一起存
  useStickerBridge(session.stickers, draft);
  const [attachTime, setAttachTime] = useState<number | null>(null);
  const [filterStatus, setFilterStatus] = useState<StatusFilter>(() => {
    try { return (localStorage.getItem('sp_comment_filter_studio') as StatusFilter) || 'all'; } catch { return 'all'; }
  });
  useEffect(() => { try { localStorage.setItem('sp_comment_filter_studio', filterStatus); } catch { /* 只是下次不記得 */ } }, [filterStatus]);
  const [follow, setFollowState] = useState(readFollow);
  const setFollow = (on: boolean) => { setFollowState(on); saveFollow(on); };
  const [exportOpen, setExportOpen] = useState(false);
  useEffect(() => {
    if (pendingTime === null) return;
    setAttachTime(pendingTime);
    onConsumedPendingTime();
  }, [pendingTime, onConsumedPendingTime]);
  const [posting, setPosting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [scope, setScope] = useState<CommentScope>(() => defaultScope(hasVersions));
  const scopeTouchedRef = useRef(false);

  const actions = songStatusActions({ role: projectRole, userId: user.id, song, flow: 'animator' });
  const hint = actions.length === 0 ? songActionsHint({ role: projectRole, userId: user.id, song, flow: 'animator' }) : null;
  const canSubmit = actions.some(a => a.to === 'in_review');
  const canPost = canPostComment({ role: projectRole, userId: user.id, song });
  const reviewSentence = lastReviewSentence(song.lastReview);
  // 預覽模式（製作用其他身分看）：提交 / 撤回、留言照樣出現但不能用
  const { ro, readOnly } = useViewAs();

  // 切歌時清空 note、回到預設的「這一版 / 全部」
  const lastSongIdRef = useRef(song.id);
  useEffect(() => {
    if (lastSongIdRef.current !== song.id) {
      setNote('');
      setAttachTime(null);
      lastSongIdRef.current = song.id;
      scopeTouchedRef.current = false;
      setScope(defaultScope(hasVersions));
    }
  }, [song.id, hasVersions]);
  useEffect(() => { if (!scopeTouchedRef.current) setScope(defaultScope(hasVersions)); }, [hasVersions]);
  const chooseScope = (s: CommentScope) => { scopeTouchedRef.current = true; setScope(s); };

  async function handlePost() {
    const text = note.trim();
    if (!text && !draft.ids.length) return;
    if (draftBlocksSend(draft)) return;
    setPosting(true);
    try {
      // 帶上區段、3D 視角、cue、畫記、縮圖（縮圖在按送出時抓一次；有畫記就用畫的那一格）、參考圖片
      const extras = session.collect(videoActive ? attachTime : null, draft.ids);
      const updated = await api.postSongComment(projectId, song.id, {
        text, mentions: extractMentions(text, members), videoId: viewed?.id ?? null, attachmentIds: draft.ids, ...extras,
      });
      onCommentsChange(updated);
      setNote('');
      draft.clear(false);
      setAttachTime(null);
      session.afterSend();
    } catch (e) {
      toast.error('留言失敗：' + friendlyError(e));
    } finally {
      setPosting(false);
    }
  }

  async function handleAction(to: Song['status']) {
    setPosting(true);
    try {
      if (to === 'in_review') {
        if (!(await confirmDialog({
          title: `把「${song.name}」交給導演審查？`,
          message: '狀態會改成「審查中」，留言框裡的話會一起送出，導演會收到通知。',
          confirmLabel: '提交審查',
        }))) return;
        if (draftBlocksSend(draft)) return;
        const ok = await onSubmitForReview(note, draft.ids);
        if (ok) { setNote(''); draft.clear(false); }
      } else {
        await onChangeStatus(to);
      }
    } finally {
      setPosting(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    try { await onRefreshComments(); } finally { setRefreshing(false); }
  }

  const list = comments ?? [];
  const threads = useMemo(() => buildThreads(list), [list]);
  const viewedVersion = viewed ? { id: viewed.id, version: viewed.version } : null;
  const effectiveScope: CommentScope = viewedVersion ? scope : 'all';
  const scopedThreads = scopeThreads(threads, effectiveScope, viewedVersion);
  const visible = filterAndSortThreads(scopedThreads, { status: filterStatus, sort: 'newest' });
  const statusCounts = {
    open: scopedThreads.filter(t => t.root.status !== 'resolved').length,
    resolved: scopedThreads.filter(t => t.root.status === 'resolved').length,
    all: scopedThreads.length,
  };
  const versionCount = viewedVersion ? scopeThreads(threads, 'version', viewedVersion).length : 0;

  // 通知點進來 → 這一版看不到就切到「全部」，捲過去閃一下
  const [flash, setFlash] = useState<{ id: string; nonce: number } | null>(null);
  useEffect(() => {
    if (!focusComment || comments === undefined) return;
    if (!list.some(c => c.id === focusComment.id)) { toast.warn('那則留言已經不在了（可能被刪掉）'); return; }
    if (!visibleInScope(list, focusComment.id, effectiveScope, viewedVersion)) chooseScope('all');
    setFlash(focusComment);
  }, [focusComment?.nonce, comments === undefined]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => {
      const el = document.getElementById(`comment-${flash.id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('song-comment--flash');
        window.setTimeout(() => el.classList.remove('song-comment--flash'), 1600);
      }
      setFlash(null);
    }, 60);
    return () => window.clearTimeout(t);
  }, [flash, visible.length, scope]);

  return (
    <div className="studio-review">
      <section className="studio-review__status">
        <div className="studio-review__status-label">目前狀態</div>
        <div className={'status-pill status-pill--' + song.status}>{STATUS_LABEL[song.status]}</div>
        {reviewSentence && (
          <div className={`studio-review__last studio-review__last--${song.lastReview!.status}`}>
            <StatusDot status={song.lastReview!.status} /> {reviewSentence}
          </div>
        )}

        <div className="studio-review__actions">
          {actions.map(a => (
            <button
              key={a.kind}
              className={'btn ' + (a.primary ? 'btn--primary' : 'btn--ghost')}
              onClick={() => handleAction(a.to)}
              disabled={posting}
              {...ro()}
            >
              {a.label}
            </button>
          ))}
          {hint && <span className="studio-review__hint">{hint}</span>}
        </div>
        {song.status === 'needs_changes' && canSubmit && (
          <div className="studio-review__hint">交新版（加影片）後會自動回到「審查中」，導演會收到通知</div>
        )}
      </section>

      <ReviewHistory
        projectId={projectId}
        songId={song.id}
        reloadKey={song.lastReview?.at ?? null}
        defaultOpen={false}
        onOpenComment={(id) => setFlash({ id, nonce: Date.now() })}
      />

      <section className="studio-review__notes">
        <div className="studio-review__notes-head">
          <span>留言／備註</span>
          {/* 手機、iPad：留言清單在前、寫留言的框在最後，這個按鈕直接跳去寫（電腦版不顯示） */}
          {canPost && (
            <button
              type="button"
              className="link-btn studio-review__jump"
              onClick={() => {
                const el = composerRef.current;
                if (!el) return;
                (el.closest('.studio-review__compose') ?? el).scrollIntoView({ block: 'center', behavior: 'smooth' });
                el.focus({ preventScroll: true });
              }}
            >寫留言</button>
          )}
          <button className="link-btn" onClick={handleRefresh} disabled={refreshing}>{refreshing ? '更新中…' : '重新整理'}</button>
        </div>

        <div className="comment-scope" role="tablist" aria-label="看哪些留言">
          <button
            type="button" role="tab" aria-selected={effectiveScope === 'version'}
            className={'comment-scope__btn' + (effectiveScope === 'version' ? ' is-active' : '')}
            onClick={() => chooseScope('version')}
            disabled={!viewedVersion}
            title={viewedVersion ? `${viewed!.label} 的留言 + 之前版本還沒改好的` : '這首歌還沒有版本'}
          >這一版{viewed ? `（${viewed.label}）` : ''}{viewedVersion ? ` ${versionCount}` : ''}</button>
          <button
            type="button" role="tab" aria-selected={effectiveScope === 'all'}
            className={'comment-scope__btn' + (effectiveScope === 'all' ? ' is-active' : '')}
            onClick={() => chooseScope('all')}
            title="所有版本的留言（含還沒有版本時的舊留言）"
          >所有版本 {threads.length}</button>
        </div>
        <CommentFilterBar
          status={filterStatus}
          onStatus={setFilterStatus}
          counts={statusCounts}
          follow={follow}
          onFollow={setFollow}
          onExport={list.length > 0 ? () => setExportOpen(true) : undefined}
        />

        {canPost ? (
          <div className="studio-review__compose">
            <ReviewCompose
              session={session}
              videoActive={videoActive}
              attachTime={videoActive ? attachTime : null}
              onClearTime={() => setAttachTime(null)}
              currentTime={currentTime}
              onStartDraw={onStartDraw}
            />
            <AttachmentDropZone draft={draft} disabled={readOnly}>
              <textarea
                ref={composerRef}
                placeholder={canSubmit
                  ? '寫一段給導演 / 製作的話，按「提交審查」會一起送出（可以貼上參考圖片）'
                  : `在這裡留言${viewed ? `（會記在 ${viewed.label}）` : ''}；打 @ 加名字可以提及成員；可以貼上參考圖片`}
                value={note}
                onChange={e => setNote(e.target.value)}
                rows={3}
                readOnly={readOnly}
                {...ro()}
              />
            </AttachmentDropZone>
            <AttachmentTray draft={draft} stickers={readOnly ? undefined : session.stickers} />
            <div className="studio-review__compose-actions att-compose-row">
              <AttachButton draft={draft} disabled={readOnly} />
              <button className="btn btn--ghost" onClick={handlePost} disabled={posting || draft.busy || (!note.trim() && !draft.ids.length)} {...ro()}>
                送出留言
              </button>
            </div>
          </div>
        ) : (
          <div className="studio-review__hint">這首歌指派給其他動畫師，只有他、導演和製作可以留言</div>
        )}

        {comments === undefined ? (
          <div className="studio-review__loading">載入中…</div>
        ) : (
          <CommentThreadList
            projectId={projectId}
            song={song}
            user={user}
            projectRole={projectRole}
            members={members}
            threads={visible}
            scope={effectiveScope}
            viewedVideoId={viewed?.id ?? null}
            latest={latest}
            onChange={onCommentsChange}
            onSeek={onSeek}
            onOpen={onOpen}
            selectedId={session.selectedId}
            activeId={activeId}
            autoScroll={follow && playing}
            emptyText={threads.length === 0
              ? '還沒有留言'
              : visible.length === 0 && scopedThreads.length > 0
              ? `沒有符合篩選的留言（共 ${scopedThreads.length} 則）`
              : `${viewed?.label ?? '這一版'} 沒有要改的留言（按「所有版本」看全部 ${threads.length} 則）`}
          />
        )}
      </section>
      {exportOpen && (
        <ExportCommentsDialog
          onClose={() => setExportOpen(false)}
          projectName={projectName}
          songTitle={`${song.code ? `${song.code} ` : ''}${song.name}`}
          comments={list}
          viewed={viewed ? { id: viewed.id, version: viewed.version, label: viewed.label } : null}
          fps={session.fps}
        />
      )}
    </div>
  );
}


/* ──────────── Activity feed (read-only viewer) ──────────── */

function ActivityList({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.listActivity(projectId, 30)
      .then(setItems)
      .catch(e => setError(friendlyError(e)));
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  if (error) return <div className="studio-right__empty">載入失敗：{error}</div>;
  if (items === null) return <div className="studio-right__empty">載入中…</div>;
  if (items.length === 0) return <div className="studio-right__empty">這個專案還沒有活動記錄</div>;

  return (
    <div className="activity-list">
      <div className="activity-list__head">
        <span>最近 {items.length} 筆</span>
        <button className="link-btn" onClick={refresh} title="重新整理" aria-label="重新整理"><Icon icon={RefreshCw} /></button>
      </div>
      <ul>
        {items.map(a => (
          <li key={a.id} className="activity-list__row">
            <span className="avatar avatar--sm" style={{ background: a.userAvatar }} title={a.userName}>{a.userName[0]}</span>
            <div className="activity-list__body">
              <div className="activity-list__line">
                <strong>{a.userName}</strong> {describeActivity(a)}
              </div>
              {/* 後台時間是 UTC、沒寫時區 → 用 serverTime 轉成本地時間（以前會差 8 小時） */}
              <div className="activity-list__time">{formatRelativeTime(a.createdAt)}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
