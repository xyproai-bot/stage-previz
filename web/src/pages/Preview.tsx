import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { Cue, CueState, Song, SongComment, StageObject } from '../lib/api';
import type { ProjectRole } from '../lib/mockData';
import { useAuth } from '../lib/auth';
import { useViewAs, useViewAsUser } from '../lib/viewAsContext';
import StageScene from '../components/StageScene';
import MiniPlayer from '../components/MiniPlayer';
import SongVersionBar, { versionByline } from '../components/SongVersionBar';
import AddVideoDialog from '../components/AddVideoDialog';
import ActivityDrawer from '../components/ActivityDrawer';
import NotificationBell from '../components/NotificationBell';
import OverflowMenu from '../components/OverflowMenu';
import EmptyState from '../components/EmptyState';
import DecisionDialog from '../components/DecisionDialog';
import ReviewHistory from '../components/ReviewHistory';
import HelpModal from '../components/HelpModal';
import CommentThreadList from '../components/CommentThreadList';
import { buildThreads, defaultScope, filterAndSortThreads, scopeThreads, visibleInScope, canPostComment, canResolveComment, type CommentScope } from '../lib/commentThreads';
import { useAbCompare } from '../lib/useAbCompare';
import { useNewVersionHint } from '../lib/newVersionHint';
import { decisionNotifyHint, newVersionLabel } from '../lib/reviewHistory';
import { parseDeepLink, type DeepLink } from '../lib/notifications';
import { CommentSkeleton } from '../components/Skeleton';
import { toast } from '../lib/toast';
import { confirmDialog, splitQuestion } from '../components/dialogs';
import { useProjectViewSettings } from '../lib/projectViewSettings';
import { cueTransitionSeconds } from '../lib/cueTiming';
import { useLocalVideo } from '../lib/localVideo';
import { useVideoCueTimeline } from '../lib/videoCueSync';
import { useStageMechanisms } from '../lib/mechanisms/useMechanisms';
import { memberVersionFetcher, useSongVersions } from '../lib/useSongVersions';
import { canAddVideo, canModifyVideo, deleteVersionMessage, removePendingQuestion, versionChoiceStorageKey, versionKey, type VersionItem } from '../lib/songVersions';
import { deleteSongVideo, retrySongVideo, type SongVideo } from '../lib/videoApi';
import { useVideoJobDone, useVideoJobs, useWarnBeforeUnloadWhileUploading, videoJobs, type VideoJob } from '../lib/videoJobs';
import { resumeFileProblem, trackedVideoIds, useStalledUploads } from '../lib/stalledUploads';
import { songTitle } from '../lib/songCode';
import { usePersonalLook } from '../lib/stageLook/personalLook';
import { STOP_LIVE_REFRESH, liveRefreshWanted, useLiveRefresh } from '../lib/liveRefresh';
import { extractMentions, mentionCandidates } from '../lib/mentions';
import {
  SONG_STATUS_LABEL as STATUS_LABEL, songStatusActions, songActionsHint, staleStatusMessage,
  friendlyError, projectGoneMessage, canModifyComment, isOwnComment, sameSongs, sameComments,
} from '../lib/songReview';
import Icon, { StatusDot } from '../components/Icon';
import HelpLink from '../components/HelpLink';
import { HELP_ANCHORS } from '../lib/helpLinks';
import {
  ArrowLeft, ChevronLeft, ChevronRight, CircleHelp, Clock, Film, HistoryIcon, Inbox, ListMusic, LoaderCircle, LogOut, MapPin, Pause, Play,
  Plus, RefreshCw, Square, X,
} from 'lucide-react';
import './Preview.css';

type Status = Song['status'];

const STATUS_COLUMNS: { key: Status; label: string }[] = [
  { key: 'todo',          label: STATUS_LABEL.todo },
  { key: 'in_review',     label: STATUS_LABEL.in_review },
  { key: 'needs_changes', label: STATUS_LABEL.needs_changes },
  { key: 'approved',      label: STATUS_LABEL.approved },
];

const EMPTY_CUES: Cue[] = [];

export default function Preview() {
  const { projectId } = useParams();
  // 沒有專案 id 的 /preview 由「我的專案」頁處理（App 路由），這裡不會走到
  if (!projectId) return null;
  // key：換專案時整個重來（不會把上一個專案的歌 / 留言帶過來）
  return <PreviewInner key={projectId} projectId={projectId} />;
}

/* ──────────── Preview Inner ──────────── */

function PreviewInner({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { logout } = useAuth();
  // 製作用「導演畫面」預覽時：user / 角色換成導演，寫入的按鈕按不下去（lib/viewAsContext.tsx）
  const user = useViewAsUser();
  const va = useViewAs();

  const [projectName, setProjectName] = useState<string>('');
  // 專案名讀不到時不能一直停在「…」，要顯示讀取失敗 + 重試
  const [nameStatus, setNameStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [projectArchived, setProjectArchived] = useState(false);
  const [projectMembers, setProjectMembers] = useState<{ id: string; name: string }[]>([]);
  // 我在這個專案的角色（通過 / 需修改按鈕看這個，不是帳號的預設角色）；undefined = 還沒讀到
  const [myRole, setMyRole] = useState<ProjectRole | null | undefined>(undefined);
  // 專案整個看不到了（封存 / 刪除 / 被移出專案）→ 整頁換成說明
  const [goneMessage, setGoneMessage] = useState<string | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [songsLoading, setSongsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  // cues 是哪首歌的（切歌後新的還沒讀到前，不能拿上一首的 cue 來顯示 / 自動播放）
  const [cuesFor, setCuesFor] = useState<string | null>(null);
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);
  const [cueStates, setCueStates] = useState<CueState[]>([]);
  const [stageObjects, setStageObjects] = useState<StageObject[]>([]);
  const [modelUrl, setModelUrl] = useState<string | null>(null);
  // Auto-step：用戶按播放後，依 cue 順序每 2 秒自動切換
  const [autoStep, setAutoStep] = useState(false);
  // Activity drawer
  const [activityOpen, setActivityOpen] = useState(false);
  // Show 整場串播：依歌單順序自動推進（每首跑完所有 cue 後切下首歌）
  const [showMode, setShowMode] = useState(false);
  const [showCueIntervalSec, setShowCueIntervalSec] = useState(3);  // 每 cue 停留秒數
  const [helpOpen, setHelpOpen] = useState(false);
  // 按「需修改」→ 先寫原因（看的是哪一版）
  const [decision, setDecision] = useState<{ songId: string; videoId: string | null; label: string } | null>(null);
  // 通知點進來（?song=&video=&comment=）：先選到那首歌，再交給 SongDetail 選版本、捲到那則留言
  const [searchParams, setSearchParams] = useSearchParams();
  const [target, setTarget] = useState<(DeepLink & { nonce: number }) | null>(null);

  const projectRole: ProjectRole | null = va.projectRole(myRole === undefined ? (user?.role ?? null) : myRole);

  // 非同步回來時要拿「現在」的值
  const songsRef = useRef<Song[]>([]);
  const selectedSongIdRef = useRef<string | null>(null);
  selectedSongIdRef.current = selectedSongId;
  const goneRef = useRef(false);
  goneRef.current = !!goneMessage;

  // 換上新的歌單；一樣就不換（自動更新時畫面不閃）。正在看的歌被刪了 → 講一聲、回總覽
  const applySongs = useCallback((list: Song[]) => {
    const prev = songsRef.current;
    const sel = selectedSongIdRef.current;
    const was = sel ? prev.find(s => s.id === sel) : undefined;
    if (was && !list.some(s => s.id === sel)) {
      toast.warn(`你正在看的「${was.name}」已經被刪除了（可能是製作剛刪的），已回到總覽`);
      setSelectedSongId(null);
    }
    if (sameSongs(prev, list)) return;
    songsRef.current = list;
    setSongs(list);
  }, []);

  const loadMeta = useCallback(async () => {
    try {
      const meta = await api.getProjectMeta(projectId);
      if (meta) {
        setProjectName(meta.name);
        setMyRole(meta.myRole ?? null);
        setProjectMembers(meta.members?.map(m => ({ id: m.id, name: m.name })) || []);
        setProjectArchived(false);
        setNameStatus('ready');
        return;
      }
      // 清單裡沒有（封存的專案只有 admin 看得到 / 不是成員）→ 直接問這個專案
      const info = await api.getProjectInfo(projectId);
      setProjectName(info.project.name);
      setMyRole(info.myRole);
      setProjectArchived(info.project.status === 'archived');
      setNameStatus('ready');
    } catch (e) {
      const gone = projectGoneMessage(e);
      if (gone) setGoneMessage(gone);
      setNameStatus('error');
    }
  }, [projectId]);

  const refresh = useCallback(async () => {
    setSongsLoading(true);
    setError(null);
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
    } catch (e) {
      const gone = projectGoneMessage(e);
      if (gone) setGoneMessage(gone);
      else setError('歌曲讀取失敗：' + friendlyError(e));
    } finally {
      setSongsLoading(false);
    }
    await metaDone;
  }, [projectId, loadMeta, applySongs]);

  useEffect(() => { refresh(); }, [refresh]);

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
  useEffect(() => {
    if (!target || songsLoading) return;
    if (songs.some(s => s.id === target.songId)) {
      setShowMode(false);
      setSelectedSongId(target.songId);
    } else {
      toast.warn('通知裡的那首歌已經不在了（可能剛被刪掉）');
      setTarget(null);
    }
  }, [target, songs, songsLoading]);

  // 自動更新歌曲狀態：每 25 秒 + 切回分頁時（動畫師提交了，這邊 30 秒內看得到）
  const reloadSongs = useCallback(async (): Promise<Song[] | null> => {
    try {
      const list = await api.listSongs(projectId);
      applySongs(list);
      return list;
    } catch (e) {
      const gone = projectGoneMessage(e);
      if (gone) {
        goneRef.current = true;
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
    if (goneRef.current) return STOP_LIVE_REFRESH;
  }, { enabled: live && !songsLoading });

  useEffect(() => {
    // 切歌時馬上清掉上一首的 cue / 位置，不然載入期間會閃一下上一首的 cue
    setCues([]);
    setCuesFor(null);
    setSelectedCueId(null);
    setCueStates([]);
    if (!selectedSongId) return;
    let cancelled = false;
    api.listCues(projectId, selectedSongId).then(list => {
      if (cancelled) return;
      setCues(list);
      setCuesFor(selectedSongId);
      const masters = list.filter(c => c.status === 'master');
      setSelectedCueId(masters[0]?.id ?? null);
    }).catch(() => {
      if (cancelled) return;
      setCues([]);
      setCuesFor(selectedSongId);
    });
    return () => { cancelled = true; };
  }, [projectId, selectedSongId]);

  const cuesReady = !!selectedSongId && cuesFor === selectedSongId;

  useEffect(() => {
    // 還在讀這首歌的 cue 時不要拿上一首的 cue id 去問
    if (!selectedSongId || !selectedCueId || cuesFor !== selectedSongId) { setCueStates([]); return; }
    let cancelled = false;
    api.listCueStates(projectId, selectedSongId, selectedCueId).then(list => {
      if (!cancelled) setCueStates(list);
    }).catch(() => { if (!cancelled) setCueStates([]); });
    return () => { cancelled = true; };
  }, [projectId, selectedSongId, selectedCueId, cuesFor]);

  // Auto-step：每 2 秒切下一個 cue
  useEffect(() => {
    if (!autoStep) return;
    const masters = cues.filter(c => c.status === 'master');
    if (masters.length === 0) return;
    const id = setInterval(() => {
      setSelectedCueId(prev => {
        const idx = masters.findIndex(c => c.id === prev);
        return masters[(idx + 1) % masters.length].id;
      });
    }, 2000);
    return () => clearInterval(id);
  }, [autoStep, cues]);

  // Show mode：每 N 秒切 cue；最後一個 cue 後切下一首歌（保留進入 detail 視圖）
  useEffect(() => {
    if (!showMode) return;
    // 沒選歌就從第一首開始
    if (!selectedSongId && songs.length > 0) {
      setSelectedSongId(songs[0].id);
      return;
    }
    // 這首的 cue 還在讀 → 等讀完再算
    if (!cuesReady) return;
    const masters = cues.filter(c => c.status === 'master');
    if (masters.length === 0) {
      // 這首沒 cue → 直接切下一首
      const t = setTimeout(() => advanceToNextSong(), 2000);
      return () => clearTimeout(t);
    }
    const id = setInterval(() => {
      setSelectedCueId(prev => {
        const idx = masters.findIndex(c => c.id === prev);
        if (idx < 0) return masters[0].id;
        if (idx + 1 >= masters.length) {
          // 最後一個 cue → 換歌
          requestAnimationFrame(() => advanceToNextSong());
          return masters[idx].id;
        }
        return masters[idx + 1].id;
      });
    }, showCueIntervalSec * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMode, cues, cuesReady, selectedSongId, showCueIntervalSec]);

  function advanceToNextSong() {
    setSelectedSongId(prev => {
      const idx = songs.findIndex(s => s.id === prev);
      if (idx < 0 || idx + 1 >= songs.length) {
        // 跑完整輪 → 停止 show mode
        setShowMode(false);
        return null;
      }
      return songs[idx + 1].id;
    });
  }

  const masterCues = useMemo(() => cuesReady ? cues.filter(c => c.status === 'master') : [], [cues, cuesReady]);
  const selectedCue = useMemo(() => cues.find(c => c.id === selectedCueId) || null, [cues, selectedCueId]);
  const selectedSong = useMemo(() => songs.find(s => s.id === selectedSongId) || null, [songs, selectedSongId]);
  const songsByStatus = useMemo(() => {
    const map: Record<Status, Song[]> = { todo: [], in_review: [], needs_changes: [], approved: [] };
    for (const s of songs) map[s.status].push(s);
    return map;
  }, [songs]);

  const totalCount = songs.length;
  const approvedCount = songsByStatus.approved.length;
  const overallPct = totalCount > 0 ? Math.round((approvedCount / totalCount) * 100) : 0;

  // 沒選 cue（或這首歌還沒有 cue）時 viewport 顯示 stage objects 的 default
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
      override: null,
      effective: { position: o.defaultPosition, rotation: o.defaultRotation, scale: o.defaultScale, visible: true },
    }));
  }, [selectedCueId, cueStates, stageObjects]);

  /**
   * 按狀態按鈕：需修改 → 先寫原因；通過 → 記下看的是哪一版（review = 正在看的版本；總覽上 = 最新一版）
   */
  function requestStatus(songId: string, to: Status, review?: { videoId: string | null; label: string }) {
    const song = songsRef.current.find(s => s.id === songId);
    if (!song) return;
    const r = review ?? { videoId: song.latestVideoId ?? null, label: song.latestVideoVersion ? `V${song.latestVideoVersion}` : '' };
    if (to === 'needs_changes') { setDecision({ songId, ...r }); return; }
    if (to === 'approved') {
      void changeStatus(songId, to, { reason: '', reviewVideoId: r.videoId }).then(ok => {
        if (ok) toast.success(`「${song.name}」${r.label ? ` ${r.label}` : ''} 已通過，${decisionNotifyHint(song)}`);
      });
      return;
    }
    void changeStatus(songId, to);
  }

  /** 改狀態；成功回 true。帶上畫面上以為的目前狀態 → 別人剛改過的話後台回 409，不會蓋掉 */
  async function changeStatus(songId: string, to: Status, review?: { reason: string; reviewVideoId: string | null }): Promise<boolean> {
    const song = songsRef.current.find(s => s.id === songId);
    if (!song) return false;
    const expected = song.status;
    const setStatus = (status: Status) => {
      const next = songsRef.current.map(s => s.id === songId ? { ...s, status } : s);
      songsRef.current = next;
      setSongs(next);
    };
    setStatus(to);
    try {
      await api.updateSong(projectId, songId, { status: to, expectedStatus: expected, ...(review || {}) });
      // 審片紀錄、「有新版」要用新的
      void reloadSongs();
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
        if (list && list.some(s => s.id === songId)) {
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

  // 上傳影片中關分頁 → 先問一聲（admin 在這頁也可以交影片）
  useWarnBeforeUnloadWhileUploading();

  return (
    <div className="preview">
      <header className="preview-top">
        <button className="preview-top__back" onClick={() => navigate('/preview')} title="所有專案" aria-label="所有專案"><Icon icon={ArrowLeft} size="md" /></button>
        <span className="preview-top__role">導演</span>
        <span className="preview-top__project" title={projectName || undefined}>
          {projectName ? <span className="preview-top__name">{projectName}</span> : (nameStatus === 'error' && !goneMessage ? (
            <>
              {projectId}（讀取失敗）
              <button className="btn btn--ghost btn--sm" onClick={() => refresh()} style={{ marginLeft: 8 }}>重試</button>
            </>
          ) : goneMessage ? '' : '…')}
          {projectArchived && <span className="status-pill status-pill--needs_changes" style={{ marginLeft: 8 }}>已封存，只能看</span>}
        </span>
        {!goneMessage && (
          <div className="preview-top__progress">
            <div className="preview-top__progress-bar">
              <span style={{ width: `${overallPct}%` }} />
            </div>
            <span className="preview-top__progress-text">{approvedCount}/{totalCount} · {overallPct}%</span>
          </div>
        )}
        <span className="grow" />
        {!goneMessage && (
          <>
            <button
              className="btn btn--sm btn--ghost ovf-hide-narrow"
              onClick={() => setActivityOpen(true)}
              title="最近活動"
            ><Icon icon={HistoryIcon} /> 活動</button>
            <button
              className={'btn btn--sm ' + (showMode ? 'btn--primary' : 'btn--ghost ovf-hide-narrow')}
              onClick={() => setShowMode(m => !m)}
              title={showMode ? '停止整場串播' : '從目前歌曲開始整場依序自動播放'}
              aria-label={showMode ? '停止整場串播' : '整場串播'}
              disabled={songs.length === 0}
            >
              {showMode ? <><Icon icon={Square} /><span className="preview-top__btn-label"> 停止整場</span></> : <><Icon icon={Play} /> 整場串播</>}
            </button>
          </>
        )}
        {showMode && (
          <select
            className="preview-top__interval ovf-hide-narrow"
            value={showCueIntervalSec}
            onChange={e => setShowCueIntervalSec(parseInt(e.target.value, 10))}
            title="每個 cue 停留幾秒"
          >
            <option value={2}>每 cue 2 秒</option>
            <option value={3}>每 cue 3 秒</option>
            <option value={5}>每 cue 5 秒</option>
            <option value={10}>每 cue 10 秒</option>
          </select>
        )}
        <button className="preview-top__icon-btn ovf-hide-narrow" onClick={() => setHelpOpen(true)} title="使用說明（比較版本、留言、通知）" aria-label="使用說明">
          <Icon icon={CircleHelp} size="md" />
        </button>
        <NotificationBell />
        {/* 手機：活動、整場串播、說明、登出收進「⋯」 */}
        <OverflowMenu
          className="ovf-only-narrow"
          header={user ? `${user.name} · 導演頁` : undefined}
          items={[
            ...(!goneMessage ? [
              { key: 'activity', label: '最近活動', icon: HistoryIcon, onSelect: () => setActivityOpen(true) },
              { key: 'show', label: showMode ? '停止整場串播' : '整場串播', icon: showMode ? Square : Play, active: showMode, disabled: songs.length === 0, onSelect: () => setShowMode(m => !m) },
            ] : []),
            { key: 'help', label: '使用說明', icon: CircleHelp, onSelect: () => setHelpOpen(true) },
            ...(user ? [{ key: 'logout', label: '登出', icon: LogOut, danger: true, separatorBefore: true, onSelect: async () => { await logout(); navigate('/login'); } }] : []),
          ]}
        />
        {user && (
          <span className="preview-top__user ovf-hide-narrow">
            <span className="avatar avatar--sm" style={{ background: user.avatarColor }} title={user.name}>{user.name[0]}</span>
            <span className="preview-top__user-name">{user.name}</span>
            <button className="link-btn" onClick={async () => { await logout(); navigate('/login'); }}>登出</button>
          </span>
        )}
      </header>

      {error && !goneMessage && <div className="preview-error">{error}</div>}

      {goneMessage ? (
        <div className="preview-empty">
          <h2>看不到這個專案</h2>
          <p>{goneMessage}</p>
          <button className="btn btn--primary" onClick={() => navigate('/preview')} style={{ marginTop: 16 }}>回專案清單</button>
        </div>
      ) : songsLoading ? (
        <div className="preview-loading"><Icon icon={LoaderCircle} spin /> 載入中…</div>
      ) : songs.length === 0 ? (
        <EmptyState
          icon={ListMusic}
          title="這個專案還沒有歌"
          className="preview-empty-state"
          actions={projectRole === 'admin' ? (
            <button className="btn btn--primary" onClick={() => navigate(`/admin/projects/${encodeURIComponent(projectId)}`)}>
              <Icon icon={Plus} /> 到管理頁加歌
            </button>
          ) : (
            <button className="btn btn--ghost" onClick={() => refresh()}>
              <Icon icon={RefreshCw} /> 重新整理
            </button>
          )}
        >
          {projectRole === 'admin'
            ? '在管理頁加上歌曲之後，導演就能在這裡一首一首看、留言、按通過。'
            : '製作在管理頁加上歌曲之後，就會出現在這裡（這頁也會自己更新）。'}
        </EmptyState>
      ) : selectedSongId && selectedSong ? (
        <SongDetail
          projectId={projectId}
          song={selectedSong}
          cues={masterCues}
          cuesReady={cuesReady}
          selectedCueId={selectedCueId}
          onSelectCue={setSelectedCueId}
          autoStep={autoStep}
          onToggleAutoStep={() => setAutoStep(v => !v)}
          stageObjects={stageObjects}
          viewportStates={viewportStates}
          modelUrl={modelUrl}
          projectName={projectName}
          cueName={selectedCue?.name}
          user={user}
          projectRole={projectRole}
          onChangeStatus={requestStatus}
          onClose={() => setSelectedSongId(null)}
          onPickSong={setSelectedSongId}
          songs={songs}
          members={projectMembers}
          target={target && target.songId === selectedSongId ? target : null}
          onTargetDone={() => setTarget(null)}
          live={live}
        />
      ) : (
        <StatusBoard
          songsByStatus={songsByStatus}
          onPickSong={setSelectedSongId}
          onChangeStatus={(id, to) => requestStatus(id, to)}
          projectRole={projectRole}
          userId={user?.id ?? null}
        />
      )}

      <ActivityDrawer
        open={activityOpen && !goneMessage}
        projectId={projectId}
        onClose={() => setActivityOpen(false)}
      />
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
      {decision && (
        <DecisionDialog
          songName={songs.find(s => s.id === decision.songId)?.name ?? ''}
          versionLabel={decision.label}
          onCancel={() => setDecision(null)}
          onSubmit={async (reason) => {
            const ok = await changeStatus(decision.songId, 'needs_changes', { reason, reviewVideoId: decision.videoId });
            if (ok) {
              setDecision(null);
              const ds = songs.find(s => s.id === decision.songId);
              toast.success(`已送出「需修改」${decision.label ? `（${decision.label}）` : ''}${ds ? `，${decisionNotifyHint(ds)}` : ''}`);
            }
            return ok;
          }}
        />
      )}
    </div>
  );
}

/* ──────────── Status Board (overview) ──────────── */

function StatusBoard({
  songsByStatus, onPickSong, onChangeStatus, projectRole, userId,
}: {
  songsByStatus: Record<Status, Song[]>;
  onPickSong: (id: string) => void;
  onChangeStatus: (id: string, status: Status) => void;
  projectRole: ProjectRole | null;
  userId: string | null;
}) {
  const { ro } = useViewAs();
  return (
    <div className="status-board">
      {STATUS_COLUMNS.map(col => (
        <div key={col.key} className={'status-col status-col--' + col.key}>
          <div className="status-col__head">
            <StatusDot status={col.key} className="status-col__dot" />
            <span className="status-col__name">{col.label}</span>
            <span className="status-col__count">{songsByStatus[col.key].length}</span>
          </div>
          <div className="status-col__body">
            {songsByStatus[col.key].length === 0 ? (
              col.key === 'in_review' ? (
                projectRole === 'director' ? (
                  <EmptyState icon={Inbox} title="目前沒有等你審的歌" size="compact">
                    動畫師按「提交審查」後會出現在這裡，你也會收到通知（右上角的小鈴鐺）。
                  </EmptyState>
                ) : (
                  // 「新版等你審」的通知只發給導演（製作不會收到）→ 不能說「你也會收到通知」
                  <EmptyState icon={Inbox} title="目前沒有在審查中的歌" size="compact">
                    動畫師按「提交審查」後會出現在這裡，導演會收到通知。
                  </EmptyState>
                )
              ) : (
                <div className="status-col__empty">{col.key === 'approved' ? '還沒有通過的歌' : `沒有「${col.label}」的歌`}</div>
              )
            ) : (
              songsByStatus[col.key].map(s => {
                // 總覽只放審查中的快速按鈕（通過 / 需修改）；撤回通過請點進歌曲
                const actions = col.key === 'in_review'
                  ? songStatusActions({ role: projectRole, userId, song: s, flow: 'director' })
                  : [];
                const newer = newVersionLabel(s);
                return (
                  <div key={s.id} className="status-card">
                    <button
                      className="status-card__open"
                      onClick={() => onPickSong(s.id)}
                    >
                      <div className="status-card__name">
                        {s.code && <span className="song-code" title="歌曲代號">{s.code}</span>}
                        {s.name}
                      </div>
                      <div className="status-card__meta">
                        {s.cueCount} 個 cue
                        {s.latestVideoVersion != null && ` · 最新 V${s.latestVideoVersion}`}
                        {/* 提案（proposal）只有製作在編輯頁看得到：還沒有「接受」的流程 */}
                        {projectRole === 'admin' && s.proposalCount > 0 && ` · ${s.proposalCount} 提案`}
                      </div>
                      {newer && (
                        <div className="status-card__newer" title={`導演上次看的是 V${s.reviewedVersion ?? s.lastReview?.version ?? ''}`}>
                          <Icon icon={Film} size="xs" /> 有新版 {newer}
                        </div>
                      )}
                      {!newer && s.lastReview && (
                        <div className="status-card__last">
                          上次：{s.lastReview.versionLabel ? `${s.lastReview.versionLabel} ` : ''}{STATUS_LABEL[s.lastReview.status]}
                        </div>
                      )}
                    </button>
                    {actions.length > 0 && (
                      <div className="status-card__actions">
                        {actions.map(a => (
                          <button
                            key={a.kind}
                            className={'btn btn--sm ' + (a.primary ? 'btn--primary' : 'btn--ghost')}
                            onClick={() => onChangeStatus(s.id, a.to)}
                            {...ro()}
                          >{a.label}</button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ──────────── Song Detail ──────────── */

function SongDetail({
  projectId, song, cues, cuesReady, selectedCueId, onSelectCue, autoStep, onToggleAutoStep,
  stageObjects, viewportStates, modelUrl, cueName, user, projectRole, onChangeStatus, onClose, onPickSong, songs, members,
  target, onTargetDone, projectName, live,
}: {
  projectId: string;
  song: Song;
  cues: Cue[];
  /** 這首歌的 cue 讀完了沒（還在讀時不要說「沒有 cue」） */
  cuesReady: boolean;
  selectedCueId: string | null;
  onSelectCue: (id: string | null) => void;
  autoStep: boolean;
  onToggleAutoStep: () => void;
  stageObjects: StageObject[];
  viewportStates: CueState[];
  modelUrl: string | null;
  /** LED 對位圖上寫的專案名稱 */
  projectName?: string;
  cueName?: string;
  user: ReturnType<typeof useAuth>['user'];
  projectRole: ProjectRole | null;
  /** review = 正在看的那一版（通過 / 需修改記這一版） */
  onChangeStatus: (songId: string, status: Status, review?: { videoId: string | null; label: string }) => void;
  onClose: () => void;
  onPickSong: (id: string) => void;
  songs: Song[];
  members: { id: string; name: string }[];
  /** 通知點進來：要選的版本、要捲到的留言 */
  target: (DeepLink & { nonce: number }) | null;
  onTargetDone: () => void;
  /** 自動更新（留言、機關）要不要開：專案已封存 → false */
  live: boolean;
}) {
  const va = useViewAs();
  const actions = songStatusActions({ role: projectRole, userId: user?.id, song, flow: 'director' });
  const actionsHint = actions.length === 0 ? songActionsHint({ role: projectRole, userId: user?.id, song, flow: 'director' }) : null;
  // 校準倍率 + 機關滑桿位移（admin 在管理頁設的，導演這邊只看）
  const view = useProjectViewSettings(projectId, user?.role === 'admin');
  // 現場設定：專案預設 + 自己調過的（存在這台電腦）
  const personalLook = usePersonalLook(projectId, view.lookSettings);

  // 在 song list 中找上下首
  const idx = songs.findIndex(s => s.id === song.id);
  const prev = idx > 0 ? songs[idx - 1] : null;
  const next = idx >= 0 && idx < songs.length - 1 ? songs[idx + 1] : null;

  // ── 共享狀態：comments + 「在 X 秒加留言」flow ──
  const [comments, setComments] = useState<SongComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  // 從 video timeline「在 X 加留言」按下後 → SongComments 預填 time + focus textarea
  const [pendingCommentTime, setPendingCommentTime] = useState<number | null>(null);
  // 從 StageScene「3D 留言」模式點 mesh 後 → SongComments 預填 anchor
  const [pendingCommentAnchor, setPendingCommentAnchor] = useState<import('../lib/api').CommentAnchor | null>(null);
  const pendingAnchorRef = useRef<import('../lib/api').CommentAnchor | null>(null);

  // 留言是哪首歌的、那首歌已經看過哪些留言 —— 切歌後第一次讀到的不算「新留言」
  // （以前切歌後第一次輪詢會把那首歌的舊留言全部當成新的跳出來）
  const songIdRef = useRef(song.id);
  songIdRef.current = song.id;
  const knownRef = useRef<{ songId: string; ids: Set<string> } | null>(null);

  const loadComments = useCallback(async (notify: boolean) => {
    const sid = song.id;
    try {
      const list = await api.listSongComments(projectId, sid);
      if (songIdRef.current !== sid) return;  // 已經換到別首歌，丟掉
      const known = knownRef.current;
      if (notify && known && known.songId === sid) {
        const fresh = list.filter(c => !known.ids.has(c.id) && !isOwnComment(c, user));
        for (const c of fresh.slice(-3)) {
          toast.info(`${c.author} 留言「${c.text.slice(0, 40)}${c.text.length > 40 ? '…' : ''}」`);
        }
      }
      knownRef.current = { songId: sid, ids: new Set(list.map(c => c.id)) };
      setComments(prevList => sameComments(prevList, list) ? prevList : list);
    } catch (e) {
      if (!notify) console.warn('load comments failed', e);
    } finally {
      if (songIdRef.current === sid) setCommentsLoading(false);
    }
  }, [projectId, song.id, user]);
  const loadCommentsRef = useRef(loadComments);
  loadCommentsRef.current = loadComments;

  // 切歌：先清掉上一首的留言，再讀這首的
  useEffect(() => {
    setComments([]);
    setCommentsLoading(true);
    knownRef.current = null;
    void loadCommentsRef.current(false);
  }, [projectId, song.id]);

  // 自動更新留言：每 25 秒 + 切回分頁時；有別人的新留言就跳提示。已封存 → 不再問
  //（專案看不到了的話，上面的歌單更新會發現、整個歌曲頁收掉）
  useLiveRefresh(() => loadComments(true), { enabled: live });

  // 自己留言 / 刪除 / 標已解決後拿到的最新整串
  const handleCommentsChange = useCallback((list: SongComment[]) => {
    knownRef.current = { songId: songIdRef.current, ids: new Set(list.map(c => c.id)) };
    setComments(list);
  }, []);

  const noCues = cuesReady && cues.length === 0;

  // ── 影片（V3、V2、V1…）：放在 LED 上；小播放器浮在 3D 畫面上 ──
  // 一頁只有一個 <video>：同時是 LED 的貼圖、也是小視窗的畫面
  const player = useLocalVideo();
  const fetchVersions = useMemo(() => memberVersionFetcher(projectId), [projectId]);
  const viewerId = user?.id ?? 'anon';
  const versionStorageKey = useCallback(
    (sid: string) => versionChoiceStorageKey(viewerId, projectId, sid),
    [viewerId, projectId],
  );
  // 歌單上的最新版本換了（動畫師交了新版、有人刪了）→ 重抓這首歌的版本
  const versions = useSongVersions({ songId: song.id, fetcher: fetchVersions, storageKey: versionStorageKey, reloadKey: song.latestVideoId });
  const selected = versions.selected;
  const { loadUrl, getSrcKey, clear: clearPlayer } = player;
  useEffect(() => {
    // 這首歌（還）沒有影片 → 上一首的影片不要繼續放
    if (!selected?.url) { if (getSrcKey()) clearPlayer(); return; }
    if (getSrcKey() === selected.key) return;
    loadUrl(selected.url, { key: selected.key, name: selected.label, crossOrigin: selected.crossOrigin });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.key, loadUrl, getSrcKey, clearPlayer]);
  // 播放網址過期（開著超過幾小時）/ 網路斷掉 → 拿新網址接著同一秒播
  const retryVersion = useCallback(async () => {
    const r = await versions.reload();
    const it = r?.items.find(x => x.key === selected?.key) ?? selected;
    if (it?.url) player.replaceUrl(it.url, { key: it.key, name: it.label, crossOrigin: it.crossOrigin });
  }, [versions, selected, player]);
  const videoMode = !!selected && player.srcKey === selected.key;

  // ── 比較（A/B）：選第二個版本，一個按鈕（或按 C）在兩版之間切，停在同一秒、播放 / 暫停照舊（lib/useAbCompare.ts，工作站共用）──
  const compare = useAbCompare({ resetKey: song.id, items: versions.items, currentKey: selected?.key ?? null, select: versions.select, player });
  // 看到一半有新版進來（25 秒自動更新）：播放照舊，版本旁邊「有新版 V3 · 切換」，按了停在同一秒換過去（跟比較一樣）
  const newVersion = useNewVersionHint({
    scope: song.id, loaded: versions.loadedSongId === song.id, items: versions.items,
    currentKey: selected?.key ?? null, select: versions.select, player,
  });
  const viewedReview = selected?.kind === 'version' ? { videoId: selected.id, label: selected.label } : { videoId: null, label: '' };
  const latestVersionItem = versions.items.find(it => it.kind === 'version' && it.version != null) ?? null;

  // ── 通知點進來：選那一版、捲到那則留言 ──
  const [focusComment, setFocusComment] = useState<{ id: string; nonce: number } | null>(null);
  const targetDoneRef = useRef(onTargetDone);
  targetDoneRef.current = onTargetDone;
  useEffect(() => {
    if (!target) return;
    // 等「這首歌」的版本清單抓到（剛換歌時清單還是空的）
    if (versions.loadedSongId !== song.id) return;
    if (target.videoId) {
      const key = versionKey(target.videoId);
      if (versions.items.some(it => it.key === key)) {
        if (selected?.key !== key) versions.select(key);
      } else {
        toast.warn('通知裡的那一版已經不在了（可能被刪掉），先放最新的一版');
      }
    }
    if (target.commentId) setFocusComment({ id: target.commentId, nonce: target.nonce });
    targetDoneRef.current();
  }, [target, versions, selected?.key, song.id]);

  // 影片時間軸要每個 cue 的位置（放影片時才抓；抓過的留著）
  const statesCacheRef = useRef(new Map<string, Promise<CueState[]>>());
  useEffect(() => { statesCacheRef.current = new Map(); }, [song.id]);
  const statesFor = useCallback((cueId: string) => {
    const cache = statesCacheRef.current;
    let p = cache.get(cueId);
    if (!p) {
      p = api.listCueStates(projectId, song.id, cueId);
      p.catch(() => cache.delete(cueId));  // 失敗就丟掉，下次再抓
      cache.set(cueId, p);
    }
    return p;
  }, [projectId, song.id]);
  // 舞台、cue 列跟著影片時間走（cue 在「對應影片時間」到位，提前「轉場」秒數等速出發）
  const { poseAtFrame, selectCueByUser } = useVideoCueTimeline({
    cues: cuesReady ? cues : EMPTY_CUES,
    statesFor,
    resetKey: song.id,
    active: videoMode,
    ready: player.ready,
    video: player.video,
    time: player.time,
    selectedCueId,
    onSelectCue,
    seek: player.seek,
  });
  // 機關（製作在管理頁設的；這裡只看）：點 cue 照機器速度走、放影片時跟著影片時間；25 秒自動更新
  const mech = useStageMechanisms({
    projectId, songId: song.id, cues: cuesReady ? cues : EMPTY_CUES, selectedCueId, video: player.video, live,
  });

  // 鍵盤：Shift+J/K 切 cue（有在放影片的話影片跟著跳到那個 cue 的時間）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'j' && k !== 'k') return;
      if (!cues.length) return;
      e.preventDefault();
      const idx = cues.findIndex(c => c.id === selectedCueId);
      const next = k === 'j'
        ? (idx < 0 ? 0 : Math.min(idx + 1, cues.length - 1))
        : (idx <= 0 ? 0 : idx - 1);
      selectCueByUser(cues[next]);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cues, selectedCueId, selectCueByUser]);

  // 點時間軸上的留言點 → 影片跳過去、捲到那則留言
  const handlePinClick = useCallback((c: SongComment) => {
    player.seek(c.time);
    const el = document.getElementById(`comment-${c.id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('song-comment--flash');
      setTimeout(() => el.classList.remove('song-comment--flash'), 1500);
    }
  }, [player]);

  // ── 交影片（admin / 負責的動畫師；導演只能看）──
  const perm = { accountRole: user?.role ?? null, projectRole, userId: user?.id ?? null, song };
  const canAdd = canAddVideo(perm);
  const [addOpen, setAddOpen] = useState(false);
  const allJobs = useVideoJobs(projectId);
  const songJobs = useMemo(() => allJobs.filter(j => j.songId === song.id), [allJobs, song.id]);
  const reloadVersions = versions.reload;
  const selectVersionRef = useRef(versions.select);
  selectVersionRef.current = versions.select;
  // 交的影片好了 → 這首歌選到新的一版開始播（在別首歌的話，回去那首就是新的一版）
  const onJobDone = useCallback((job: VideoJob) => {
    if (job.projectId !== projectId) return;
    const here = job.songId === song.id;
    toast.success(`${job.songLabel}：${job.result?.label || '新的一版'} 好了${here ? '，正在播' : ''}`);
    if (here) {
      // 選到新的那一版（正在看的版本平常會固定住，自己交的要換過去）
      void reloadVersions().then(() => { if (job.result) selectVersionRef.current(versionKey(job.result.id)); });
    }
  }, [projectId, song.id, reloadVersions]);
  useVideoJobDone(onJobDone);

  async function handleDeleteVersion(item: VersionItem) {
    if (!(await confirmDialog({ ...splitQuestion(deleteVersionMessage(item)), confirmLabel: `刪除 ${item.label || '這一版'}`, destructive: true }))) return;
    try {
      await deleteSongVideo(projectId, song.id, item.id);
      toast.success(`已刪除 ${item.label}`);
      await versions.reload();
    } catch (e) {
      toast.error('刪除失敗：' + friendlyError(e));
    }
  }
  const canModifyPending = (v: SongVideo) => canModifyVideo({ ...perm, item: { kind: 'version', byId: v.createdBy?.id ?? null } });
  async function handleRetryPending(v: SongVideo) {
    try { await retrySongVideo(projectId, song.id, v.id); await versions.reload(); }
    catch (e) { toast.error('重試失敗：' + friendlyError(e)); }
  }
  async function handleRemovePending(v: SongVideo) {
    const name = v.title || '這一版';
    if (!(await confirmDialog(removePendingQuestion(v, name)))) return;
    try { await deleteSongVideo(projectId, song.id, v.id); await versions.reload(); }
    catch (e) { toast.error('沒有成功：' + friendlyError(e)); }
  }
  // 上傳停住的那一版（傳的分頁關掉了）：每一段都傳上來了 → 有權限的人打開就自動完成；還有段沒傳 → 選同一個檔案接著傳
  const trackedIds = useMemo(() => trackedVideoIds(songJobs), [songJobs]);
  const stalled = useStalledUploads({
    // 預覽（只能看）不幫人完成上傳
    projectId, songId: song.id, pending: versions.pending, trackedIds, canModify: (v) => !va.readOnly && canModifyPending(v),
    onFinished: (video) => {
      if (video) toast.success(`「${video.title || songTitle(song)}」上傳完成，變成 ${video.label || '新的一版'}`);
      void reloadVersions();
    },
  });
  function handleResumePending(v: SongVideo, file: File) {
    const problem = resumeFileProblem(v, file);
    if (problem) { toast.warn(problem); return; }
    videoJobs.startUpload({ projectId, songId: song.id, songLabel: songTitle(song), file, note: v.note || undefined, resumeVideoId: v.id });
  }

  return (
    <div className="song-detail">
      <div className="song-detail__sub-top">
        <button className="link-btn song-detail__back" onClick={onClose} title="回總覽" aria-label="回總覽"><Icon icon={ArrowLeft} /><span className="song-detail__back-label"> 回總覽</span></button>
        <span className="song-detail__nav">
          {prev && <button className="link-btn song-detail__step" onClick={() => onPickSong(prev.id)} title={`上一首：${prev.name}`} aria-label={`上一首：${prev.name}`}><Icon icon={ChevronLeft} /><span className="song-detail__step-name">{prev.name}</span></button>}
          <span className="song-detail__title">
            {song.code && <span className="song-code" title="歌曲代號">{song.code}</span>}
            {song.name}
          </span>
          {next && <button className="link-btn song-detail__step" onClick={() => onPickSong(next.id)} title={`下一首：${next.name}`} aria-label={`下一首：${next.name}`}><span className="song-detail__step-name">{next.name}</span><Icon icon={ChevronRight} /></button>}
        </span>
        <span className={'status-pill status-pill--' + song.status}>{STATUS_LABEL[song.status]}</span>
        <span className="grow" />
        {actions.length > 0 && (
          <div className="song-detail__approve">
            {actions.map(a => (
              <button
                key={a.kind}
                className={'btn btn--sm ' + (a.primary ? 'btn--primary' : 'btn--ghost')}
                onClick={() => onChangeStatus(song.id, a.to, viewedReview)}
                {...va.ro((a.to === 'approved' || a.to === 'needs_changes') && viewedReview.label ? `${a.label}（記在 ${viewedReview.label}）` : undefined)}
              >{a.label}{(a.to === 'approved' || a.to === 'needs_changes') && viewedReview.label ? ` ${viewedReview.label}` : ''}</button>
            ))}
          </div>
        )}
        {actionsHint && <span className="muted small song-detail__hint">{actionsHint}</span>}
        <HelpLink anchor={HELP_ANCHORS.dirDecide} />
      </div>

      <div className="song-detail__body">
        <main className="song-detail__main">
          {/* 影片版本：V3、V2、V1…（誰交的、什麼時候、說明）；選哪一版 LED 就放哪一版 */}
          <SongVersionBar
            status={versions.status}
            error={versions.error}
            items={versions.items}
            selectedKey={selected?.key ?? null}
            onSelect={versions.select}
            pending={versions.pending}
            jobs={songJobs}
            onRetryLoad={() => { void versions.reload(); }}
            onAdd={canAdd ? () => setAddOpen(true) : undefined}
            canDelete={(it) => canModifyVideo({ ...perm, item: it })}
            onDelete={handleDeleteVersion}
            canModifyPending={canModifyPending}
            onRetryPending={handleRetryPending}
            onRemovePending={handleRemovePending}
            stalled={stalled.views}
            onResumePending={handleResumePending}
            onRetryFinish={stalled.retryFinish}
            emptyText={canAdd ? '這首歌還沒有影片，按右邊「加影片」交第一版' : '這首歌還沒有影片（動畫師交了之後會自動出現）'}
            newVersion={newVersion}
          />

          <div className="song-detail__stage">
            <div className="song-detail__scene">
              {/* 沒有 cue 也照樣顯示舞台（物件在預設位置），導演才看得到模型 */}
              <StageScene
                key={`${projectId}:${song.id}`}
                states={viewportStates}
                stageObjects={stageObjects}
                selectedObjectIds={[]}
                onSelect={() => {}}
                onTransform={() => {}}
                cueName={noCues ? '預設位置（還沒有 cue）' : cueName}
                modelUrl={modelUrl}
                readOnly
                defaultRenderMode="live"
                cueKey={selectedCueId}
                crossfadeSeconds={cueTransitionSeconds(cues.find(c => c.id === selectedCueId))}
                comments={comments}
                onCommentPinClick={(c) => {
                  const el = document.getElementById(`comment-${c.id}`);
                  if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.classList.add('song-comment--flash');
                    setTimeout(() => el.classList.remove('song-comment--flash'), 1500);
                  }
                }}
                bookmarkScope={projectId}
                scaleCorrection={view.scaleCorrection}
                onScaleCorrectionChange={view.canEdit ? view.setScaleCorrection : undefined}
                mechanismOffsets={view.mechanismOffsets}
                {...mech.sceneProps}
                lookSettings={personalLook.effective}
                onLookSettingsChange={personalLook.set}
                lookCustomized={personalLook.customized}
                onLookReset={personalLook.reset}
                onLookSaveAsDefault={view.canEdit ? () => view.setLookSettings(personalLook.effective) : undefined}
                materialOverrides={view.materialOverrides}
                homeView={view.homeView}
                onHomeViewChange={view.canEdit ? view.setHomeView : undefined}
                onMaterialOverrideChange={view.canEdit ? view.setMaterialOverride : undefined}
                projectName={projectName}
                ledCanvas={view.ledCanvas}
                onLedCanvasChange={view.canEdit ? view.setLedCanvas : undefined}
                onAddAnchoredComment={va.guard((anchor) => {
                  // 上層存暫存的 anchor，留言區會接著用
                  pendingAnchorRef.current = anchor;
                  // 觸發留言區「需要 anchor 模式」 — 用 pendingCommentTime 0 + 一個 flag
                  setPendingCommentAnchor(anchor);
                })}
                ledVideo={videoMode && player.ready ? player.video : null}
                poseAtFrame={poseAtFrame}
              />
              {/* 小播放器（子母畫面）：可以拖、可以收起來；在 3D 畫面裡面，不會蓋到下面的 cue 列 */}
              {selected && (
                <MiniPlayer
                  player={player}
                  label={selected.label}
                  detail={versionByline(selected) || selected.title}
                  storageKey="sp_mini_player:preview"
                  comments={comments}
                  onCommentPinClick={handlePinClick}
                  onAddCommentAtTime={va.guard((t: number) => setPendingCommentTime(t))}
                  onRetry={retryVersion}
                  compare={compare}
                />
              )}
            </div>
            {noCues && (
              <div className="song-detail__cuebar">
                <span className="cuebar-hint">這首歌還沒有 cue，3D 顯示的是物件的預設位置</span>
              </div>
            )}
            {cues.length > 0 && (
              <div className="song-detail__cuebar">
                <button
                  className={'cuebar-btn' + (autoStep ? ' is-active' : '')}
                  onClick={onToggleAutoStep}
                  title={autoStep ? '停止自動播放' : '每 2 秒自動切 cue'}
                  aria-label={autoStep ? '停止自動播放' : '每 2 秒自動切 cue'}
                ><Icon icon={autoStep ? Pause : Play} size="md" /></button>
                <div className="cuebar-track">
                  {cues.map((c, i) => (
                    <button
                      key={c.id}
                      className={'cuebar-cue' + (c.id === selectedCueId ? ' is-active' : '')}
                      onClick={() => selectCueByUser(c)}
                      title={c.videoTimeSec != null ? `${c.name}（影片 ${formatTimeMS(c.videoTimeSec)}）` : c.name}
                    >
                      <span className="cuebar-cue__num">{i + 1}</span>
                      <span className="cuebar-cue__name">{c.name}</span>
                    </button>
                  ))}
                </div>
                <div className="cuebar-hint">
                  <kbd>Shift</kbd>+<kbd>J</kbd>/<kbd>K</kbd>
                </div>
              </div>
            )}
          </div>
        </main>

        <aside className="song-detail__side">
          <div className="song-detail__history">
            <ReviewHistory
              projectId={projectId}
              songId={song.id}
              reloadKey={song.lastReview?.at ?? null}
              defaultOpen={false}
              onOpenComment={(id) => setFocusComment({ id, nonce: Date.now() })}
            />
          </div>
          <SongComments
            projectId={projectId}
            song={song}
            viewed={selected?.kind === 'version' && selected.version != null ? { id: selected.id, version: selected.version, label: selected.label } : null}
            latest={latestVersionItem ? { id: latestVersionItem.id, label: latestVersionItem.label } : null}
            hasVersions={versions.hasVersions}
            focusComment={focusComment}
            onSeek={(t) => player.seek(t)}
            user={user}
            projectRole={projectRole}
            comments={comments}
            loading={commentsLoading}
            onChange={handleCommentsChange}
            onRefresh={() => loadComments(false)}
            pendingTime={pendingCommentTime}
            onConsumedPendingTime={() => setPendingCommentTime(null)}
            pendingAnchor={pendingCommentAnchor}
            onConsumedPendingAnchor={() => { setPendingCommentAnchor(null); pendingAnchorRef.current = null; }}
            members={members}
          />
        </aside>
      </div>

      {addOpen && (
        <AddVideoDialog
          open
          onClose={() => setAddOpen(false)}
          projectId={projectId}
          song={song}
          jobs={songJobs}
          canUpload={canAdd}
        />
      )}
    </div>
  );
}

/* ──────────── Comments ──────────── */

function SongComments({
  projectId, song, user, projectRole, comments, loading, onChange, onRefresh,
  pendingTime, onConsumedPendingTime, pendingAnchor, onConsumedPendingAnchor, members,
  viewed, latest, hasVersions, focusComment, onSeek,
}: {
  projectId: string;
  song: Song;
  user: ReturnType<typeof useAuth>['user'];
  projectRole: ProjectRole | null;
  comments: SongComment[];
  loading: boolean;
  onChange: (next: SongComment[]) => void;
  onRefresh: () => void;
  pendingTime: number | null;
  onConsumedPendingTime: () => void;
  pendingAnchor: import('../lib/api').CommentAnchor | null;
  onConsumedPendingAnchor: () => void;
  members: { id: string; name: string }[];
  /** 正在看的那一版（留言綁這一版；「這一版」篩選看它） */
  viewed: { id: string; version: number; label: string } | null;
  /** 最新一版（「已改好（V3）」） */
  latest: { id: string; label: string } | null;
  hasVersions: boolean;
  /** 通知 / 審片紀錄點進來：捲到這則留言 */
  focusComment: { id: string; nonce: number } | null;
  onSeek: (t: number) => void;
}) {
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  // 用戶可以「掛在某個時間」留言（從 timeline 來、或自己 toggle）
  const [attachTime, setAttachTime] = useState<number | null>(null);
  const [attachAnchor, setAttachAnchor] = useState<import('../lib/api').CommentAnchor | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // @-mention 自動完成
  const [mentionState, setMentionState] = useState<{
    open: boolean; query: string; startIdx: number; activeIdx: number;
  }>({ open: false, query: '', startIdx: 0, activeIdx: 0 });

  // 「這一版 / 全部」：有版本的歌預設「這一版」；切歌回到預設
  const [scope, setScope] = useState<CommentScope>(() => defaultScope(hasVersions));
  const scopeTouchedRef = useRef(false);
  useEffect(() => { scopeTouchedRef.current = false; setScope(defaultScope(hasVersions)); }, [song.id]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!scopeTouchedRef.current) setScope(defaultScope(hasVersions)); }, [hasVersions]);
  const chooseScope = (s: CommentScope) => { scopeTouchedRef.current = true; setScope(s); };

  // 切歌：清掉多選
  useEffect(() => {
    setSelectedIds(new Set());
  }, [song.id]);

  function handleTextChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setText(v);
    // 偵測 @：找游標前最後一個 @
    const cursor = e.target.selectionStart || v.length;
    const before = v.slice(0, cursor);
    const at = before.lastIndexOf('@');
    if (at >= 0) {
      const between = before.slice(at + 1);
      // 沒空白 / 換行 / @ 才算還在 mention
      if (!/[\s@]/.test(between)) {
        setMentionState({ open: true, query: between, startIdx: at, activeIdx: 0 });
        return;
      }
    }
    if (mentionState.open) setMentionState(s => ({ ...s, open: false }));
  }

  function applyMention(member: { id: string; name: string }) {
    const before = text.slice(0, mentionState.startIdx);
    const after = text.slice(mentionState.startIdx + 1 + mentionState.query.length);
    const newText = `${before}@${member.name} ${after}`;
    setText(newText);
    setMentionState({ open: false, query: '', startIdx: 0, activeIdx: 0 });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  // 打「@小」先出名字開頭是「小」的人（lib/mentions.ts）
  const filteredMembers = mentionCandidates(members, mentionState.query);

  // Bulk-select 模式（每串最上面那則）
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function clearSelection() { setSelectedIds(new Set()); }
  const who = { role: projectRole, userId: user?.id ?? null, song };
  const canModify = (c: SongComment) => canModifyComment(c, user, projectRole);
  // 多選裡面可以刪的（自己的，或 admin）/ 可以標已改好的
  const deletableSelected = comments.filter(c => selectedIds.has(c.id) && canModify(c));
  const resolvableSelected = comments.filter(c => selectedIds.has(c.id) && c.status !== 'resolved' && canResolveComment(c, who));
  // Filter / sort（舊的「未解決」預設會把灰掉的「已改好」藏起來 → 換一個存的名字，預設全部）
  const [filterStatus, setFilterStatus] = useState<'all' | 'open' | 'resolved'>(() => {
    try { return (localStorage.getItem('sp_comment_filter_v2') as 'all' | 'open' | 'resolved') || 'all'; } catch { return 'all'; }
  });
  const [filterRole, setFilterRole] = useState<'all' | 'animator' | 'director' | 'designer'>('all');
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'time-asc'>(() => {
    try { return (localStorage.getItem('sp_comment_sort') as 'newest' | 'oldest' | 'time-asc') || 'newest'; } catch { return 'newest'; }
  });
  useEffect(() => { try { localStorage.setItem('sp_comment_filter_v2', filterStatus); } catch {} }, [filterStatus]);
  useEffect(() => { try { localStorage.setItem('sp_comment_sort', sortBy); } catch {} }, [sortBy]);

  // 收到 timeline 來的 pendingTime → 預填 + focus
  useEffect(() => {
    if (pendingTime === null) return;
    setAttachTime(pendingTime);
    requestAnimationFrame(() => textareaRef.current?.focus());
    onConsumedPendingTime();
  }, [pendingTime, onConsumedPendingTime]);

  useEffect(() => {
    if (pendingAnchor === null) return;
    setAttachAnchor(pendingAnchor);
    requestAnimationFrame(() => textareaRef.current?.focus());
    onConsumedPendingAnchor();
  }, [pendingAnchor, onConsumedPendingAnchor]);

  async function handlePost() {
    if (!user) return;
    const t = text.trim();
    if (!t) return;
    setPosting(true);
    try {
      // 作者 / 身分由後台依登入的人填；綁正在看的那一版
      const updated = await api.postSongComment(projectId, song.id, {
        text: t,
        time: attachTime ?? 0,
        anchor: attachAnchor ?? undefined,
        mentions: extractMentions(t, members),
        videoId: viewed?.id ?? null,
      });
      onChange(updated);
      setText('');
      setAttachTime(null);
      setAttachAnchor(null);
    } catch (e) {
      toast.error('留言失敗：' + friendlyError(e));
    } finally {
      setPosting(false);
    }
  }

  async function bulkMarkResolved() {
    const ids = resolvableSelected.map(c => c.id);
    if (ids.length === 0) return;
    const label = latest ? `已改好（${latest.label}）` : '已改好';
    if (!(await confirmDialog({ title: `把 ${ids.length} 則留言標成「${label}」？`, confirmLabel: '標成已改好' }))) return;
    let okCount = 0;
    let lastList: SongComment[] | null = null;
    for (const id of ids) {
      try {
        lastList = await api.patchSongComment(projectId, song.id, id, { status: 'resolved', resolvedVideoId: latest?.id ?? null });
        okCount++;
      } catch { /* swallow per-item, continue */ }
    }
    if (lastList) onChange(lastList);
    clearSelection();
    toast.success(`已標 ${okCount}/${ids.length} 則為${label}`);
  }

  async function bulkDelete() {
    const ids = deletableSelected.map(c => c.id);
    if (ids.length === 0) return;
    const skipped = selectedIds.size - ids.length;
    const note = skipped > 0 ? `\n另外 ${skipped} 則是別人的留言，只有留言的人或製作能刪，會跳過。` : '';
    if (!(await confirmDialog({
      title: `刪除 ${ids.length} 則留言？`,
      message: `底下的回覆會一起刪掉，刪了就救不回來。${note}`,
      confirmLabel: `刪除 ${ids.length} 則`,
      destructive: true,
    }))) return;
    let okCount = 0;
    let lastList: SongComment[] | null = null;
    for (const id of ids) {
      try {
        lastList = await api.deleteSongComment(projectId, song.id, id);
        okCount++;
      } catch { /* swallow */ }
    }
    if (lastList) onChange(lastList);
    clearSelection();
    toast.success(`已刪除 ${okCount}/${ids.length} 則`);
  }

  // 串 → 「這一版 / 全部」→ 狀態 / 角色篩選 → 排序
  const threads = useMemo(() => buildThreads(comments), [comments]);
  const viewedVersion = viewed ? { id: viewed.id, version: viewed.version } : null;
  const effectiveScope: CommentScope = viewedVersion ? scope : 'all';
  const scoped = useMemo(() => scopeThreads(threads, effectiveScope, viewedVersion), [threads, effectiveScope, viewedVersion?.id, viewedVersion?.version]);  // eslint-disable-line react-hooks/exhaustive-deps
  const visible = filterAndSortThreads(scoped, { status: filterStatus, role: filterRole, sort: sortBy });
  const versionCount = viewedVersion ? scopeThreads(threads, 'version', viewedVersion).length : 0;

  // 通知 / 審片紀錄點進來 → 這一版看不到就切到「全部」，捲過去閃一下
  const [flashId, setFlashId] = useState<{ id: string; nonce: number } | null>(null);
  useEffect(() => {
    if (!focusComment || loading) return;
    if (!comments.some(c => c.id === focusComment.id)) {
      toast.warn('那則留言已經不在了（可能被刪掉）');
      return;
    }
    if (!visibleInScope(comments, focusComment.id, effectiveScope, viewedVersion)) chooseScope('all');
    setFilterStatus('all');
    setFilterRole('all');
    setFlashId(focusComment);
  }, [focusComment?.nonce, loading]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!flashId) return;
    const t = window.setTimeout(() => {
      const el = document.getElementById(`comment-${flashId.id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('song-comment--flash');
        window.setTimeout(() => el.classList.remove('song-comment--flash'), 1600);
      }
      setFlashId(null);
    }, 60);
    return () => window.clearTimeout(t);
  }, [flashId, visible.length, scope]);

  const canPost = canPostComment(who);
  // 預覽模式（製作用其他身分看）：留言框、送出、批次動作照樣出現但不能用
  const { ro, readOnly } = useViewAs();

  return (
    <div className="song-comments">
      <div className="song-comments__head">
        <span>留言（{visible.length}/{threads.length}）</span>
        <button className="link-btn" onClick={onRefresh}>重新整理</button>
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
        >全部 {threads.length}</button>
      </div>

      {selectedIds.size > 0 && (
        <div className="song-comments__bulk">
          <span>已選 <strong>{selectedIds.size}</strong> 則</span>
          {resolvableSelected.length > 0 && (
            <button className="btn btn--sm btn--primary" onClick={bulkMarkResolved} {...ro()}>已改好{latest ? `（${latest.label}）` : ''}</button>
          )}
          {deletableSelected.length > 0 && (
            <button className="btn btn--sm btn--ghost" onClick={bulkDelete} {...ro()}>
              刪除{deletableSelected.length < selectedIds.size ? `（${deletableSelected.length} 則可刪）` : ''}
            </button>
          )}
          <button className="link-btn" onClick={clearSelection}>取消</button>
        </div>
      )}

      <div className="song-comments__filters">
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as 'all' | 'open' | 'resolved')} aria-label="狀態">
          <option value="all">全部狀態</option>
          <option value="open">還沒改好</option>
          <option value="resolved">已改好</option>
        </select>
        <select value={filterRole} onChange={e => setFilterRole(e.target.value as 'all' | 'animator' | 'director' | 'designer')} aria-label="角色">
          <option value="all">所有角色</option>
          <option value="director">導演</option>
          <option value="animator">動畫師</option>
          <option value="designer">製作</option>
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value as 'newest' | 'oldest' | 'time-asc')} aria-label="排序">
          <option value="newest">最新優先</option>
          <option value="oldest">最舊優先</option>
          <option value="time-asc">依影片時間</option>
        </select>
      </div>

      {user && canPost && (
        <div className="song-comments__compose">
          {attachTime !== null && (
            <div className="song-comments__attach">
              <Icon icon={Clock} /> 掛在 <strong>{formatTimeMS(attachTime)}</strong>
              <button className="link-btn" onClick={() => setAttachTime(null)} title="取消綁時間" aria-label="取消綁時間"><Icon icon={X} /></button>
            </div>
          )}
          {attachAnchor && (
            <div className="song-comments__attach song-comments__attach--3d">
              <Icon icon={MapPin} /> 3D 位置：<strong>
                {attachAnchor.type === 'mesh'
                  ? `物件「${attachAnchor.meshName}」`
                  : attachAnchor.type === 'world'
                    ? `場景座標 (${attachAnchor.world.x.toFixed(1)}, ${attachAnchor.world.y.toFixed(1)}, ${attachAnchor.world.z.toFixed(1)})`
                    : '螢幕'}
              </strong>
              <button className="link-btn" onClick={() => setAttachAnchor(null)} title="取消 3D 位置" aria-label="取消 3D 位置"><Icon icon={X} /></button>
            </div>
          )}
          <div style={{ position: 'relative' }}>
            <textarea
              ref={textareaRef}
              placeholder={attachTime !== null
                ? `在 ${formatTimeMS(attachTime)} 留言${viewed ? `（${viewed.label}）` : ''}（打 @ 可以提及成員）`
                : `留言給動畫師${viewed ? `（會記在 ${viewed.label}）` : ''}，例：第 3 個 cue 機關升起來太慢；打 @ 可以提及成員`}
              value={text}
              onChange={handleTextChange}
              readOnly={readOnly}
              {...ro()}
              onKeyDown={(e) => {
                if (!mentionState.open || filteredMembers.length === 0) return;
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMentionState(s => ({ ...s, activeIdx: (s.activeIdx + 1) % filteredMembers.length }));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMentionState(s => ({ ...s, activeIdx: (s.activeIdx - 1 + filteredMembers.length) % filteredMembers.length }));
                } else if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  applyMention(filteredMembers[mentionState.activeIdx]);
                } else if (e.key === 'Escape') {
                  setMentionState(s => ({ ...s, open: false }));
                }
              }}
              rows={3}
            />
            {mentionState.open && filteredMembers.length > 0 && (
              <div className="mention-popover">
                {filteredMembers.map((m, i) => (
                  <button
                    key={m.id}
                    className={'mention-item' + (i === mentionState.activeIdx ? ' is-active' : '')}
                    onClick={() => applyMention(m)}
                  >
                    @{m.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="btn btn--primary btn--sm" onClick={handlePost} disabled={posting || !text.trim()} {...ro()}>
            送出
          </button>
        </div>
      )}
      {user && !canPost && (
        <div className="song-comments__empty">這首歌指派給其他動畫師，只有他、導演和製作可以留言</div>
      )}

      {loading ? (
        <div className="song-comments__list">
          {Array.from({ length: 3 }).map((_, i) => <CommentSkeleton key={i} />)}
        </div>
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
          onChange={onChange}
          onSeek={onSeek}
          selection={{ ids: selectedIds, toggle: toggleSelect }}
          emptyText={threads.length === 0
            ? '還沒有留言'
            : effectiveScope === 'version'
              ? `${viewed?.label ?? '這一版'} 還沒有留言（按「全部」看所有版本的 ${threads.length} 則）`
              : `沒有符合篩選的留言（共 ${threads.length} 則）`}
        />
      )}
    </div>
  );
}

function formatTimeMS(s: number): string {
  if (!isFinite(s) || s < 0) return '00:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

