import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { Cue, CueState, Song, SongComment, StageObject } from '../lib/api';
import type { ProjectRole } from '../lib/mockData';
import { useAuth } from '../lib/auth';
import StageScene from '../components/StageScene';
import MiniPlayer from '../components/MiniPlayer';
import SongVersionBar, { versionByline } from '../components/SongVersionBar';
import AddVideoDialog from '../components/AddVideoDialog';
import ActivityDrawer from '../components/ActivityDrawer';
import { CommentSkeleton } from '../components/Skeleton';
import { toast } from '../lib/toast';
import { useProjectViewSettings } from '../lib/projectViewSettings';
import { cueTransitionSeconds } from '../lib/cueTiming';
import { useLocalVideo } from '../lib/localVideo';
import { useVideoCueTimeline } from '../lib/videoCueSync';
import { memberVersionFetcher, useSongVersions } from '../lib/useSongVersions';
import { canAddVideo, canModifyVideo, deleteVersionMessage, versionChoiceStorageKey, versionKey, type VersionItem } from '../lib/songVersions';
import { deleteSongVideo, retrySongVideo, type SongVideo } from '../lib/videoApi';
import { useVideoJobDone, useVideoJobs, useWarnBeforeUnloadWhileUploading, type VideoJob } from '../lib/videoJobs';
import { usePersonalLook } from '../lib/stageLook/personalLook';
import { useLiveRefresh } from '../lib/liveRefresh';
import { extractMentions } from '../lib/mentions';
import { formatRelativeTime } from '../lib/serverTime';
import {
  SONG_STATUS_LABEL as STATUS_LABEL, songStatusActions, songActionsHint, staleStatusMessage,
  friendlyError, projectGoneMessage, canModifyComment, isOwnComment, sameSongs, sameComments,
} from '../lib/songReview';
import Icon, { StatusDot } from '../components/Icon';
import { roleLabel } from '../lib/roleLabels';
import {
  ArrowLeft, Check, ChevronLeft, ChevronRight, Clock, HistoryIcon, LoaderCircle, MapPin, Pause, Play,
  RotateCcw, Square, X,
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
  const { user, logout } = useAuth();

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

  const projectRole: ProjectRole | null = myRole === undefined ? (user?.role ?? null) : myRole;

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

  // 自動更新歌曲狀態：每 25 秒 + 切回分頁時（動畫師提交了，這邊 30 秒內看得到）
  const reloadSongs = useCallback(async (): Promise<Song[] | null> => {
    try {
      const list = await api.listSongs(projectId);
      applySongs(list);
      return list;
    } catch (e) {
      const gone = projectGoneMessage(e);
      if (gone) setGoneMessage(gone);
      return null;
    }
  }, [projectId, applySongs]);

  useLiveRefresh(async () => {
    if (!goneRef.current) await reloadSongs();
  }, { enabled: !goneMessage && !songsLoading });

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

  /** 改狀態。帶上畫面上以為的目前狀態 → 別人剛改過的話後台回 409，不會蓋掉 */
  async function changeStatus(songId: string, to: Status) {
    const song = songsRef.current.find(s => s.id === songId);
    if (!song) return;
    const expected = song.status;
    const setStatus = (status: Status) => {
      const next = songsRef.current.map(s => s.id === songId ? { ...s, status } : s);
      songsRef.current = next;
      setSongs(next);
    };
    setStatus(to);
    try {
      await api.updateSong(projectId, songId, { status: to, expectedStatus: expected });
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
    }
  }

  // 上傳影片中關分頁 → 先問一聲（admin 在這頁也可以交影片）
  useWarnBeforeUnloadWhileUploading();

  return (
    <div className="preview">
      <header className="preview-top">
        <button className="preview-top__back" onClick={() => navigate('/preview')} title="所有專案" aria-label="所有專案"><Icon icon={ArrowLeft} size="md" /></button>
        <span className="preview-top__role">導演</span>
        <span className="preview-top__project">
          {projectName || (nameStatus === 'error' && !goneMessage ? (
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
              className="btn btn--sm btn--ghost"
              onClick={() => setActivityOpen(true)}
              title="最近活動"
            ><Icon icon={HistoryIcon} /> 活動</button>
            <button
              className={'btn btn--sm ' + (showMode ? 'btn--primary' : 'btn--ghost')}
              onClick={() => setShowMode(m => !m)}
              title={showMode ? '停止整場串播' : '從目前歌曲開始整場依序自動播放'}
              disabled={songs.length === 0}
            >
              {showMode ? <><Icon icon={Square} /> 停止整場</> : <><Icon icon={Play} /> 整場串播</>}
            </button>
          </>
        )}
        {showMode && (
          <select
            className="preview-top__interval"
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
        {user && (
          <span className="preview-top__user">
            <span className="avatar avatar--sm" style={{ background: user.avatarColor }}>{user.name[0]}</span>
            <span>{user.name}</span>
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
        <div className="preview-empty">
          <h2>這個專案還沒有歌</h2>
          <p>請製作在管理頁加上歌曲</p>
        </div>
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
          cueName={selectedCue?.name}
          user={user}
          projectRole={projectRole}
          onChangeStatus={changeStatus}
          onClose={() => setSelectedSongId(null)}
          onPickSong={setSelectedSongId}
          songs={songs}
          members={projectMembers}
        />
      ) : (
        <StatusBoard
          songsByStatus={songsByStatus}
          onPickSong={setSelectedSongId}
          onChangeStatus={changeStatus}
          projectRole={projectRole}
          userId={user?.id ?? null}
        />
      )}

      <ActivityDrawer
        open={activityOpen}
        projectId={projectId}
        onClose={() => setActivityOpen(false)}
      />
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
              <div className="status-col__empty">—</div>
            ) : (
              songsByStatus[col.key].map(s => {
                // 總覽只放審查中的快速按鈕（通過 / 需修改）；撤回通過請點進歌曲
                const actions = col.key === 'in_review'
                  ? songStatusActions({ role: projectRole, userId, song: s, flow: 'director' })
                  : [];
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
                        {s.cueCount} 個 cue{s.proposalCount > 0 && ` · ${s.proposalCount} 提案`}
                      </div>
                    </button>
                    {actions.length > 0 && (
                      <div className="status-card__actions">
                        {actions.map(a => (
                          <button
                            key={a.kind}
                            className={'btn btn--sm ' + (a.primary ? 'btn--primary' : 'btn--ghost')}
                            onClick={() => onChangeStatus(s.id, a.to)}
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
  cueName?: string;
  user: ReturnType<typeof useAuth>['user'];
  projectRole: ProjectRole | null;
  onChangeStatus: (songId: string, status: Status) => void | Promise<void>;
  onClose: () => void;
  onPickSong: (id: string) => void;
  songs: Song[];
  members: { id: string; name: string }[];
}) {
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

  // 自動更新留言：每 25 秒 + 切回分頁時；有別人的新留言就跳提示
  useLiveRefresh(() => loadComments(true));

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
    if (!confirm(deleteVersionMessage(item))) return;
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
    if (!confirm(v.status === 'failed' ? `把「${name}」從清單拿掉？` : `取消「${name}」？已經傳的部分會丟掉。`)) return;
    try { await deleteSongVideo(projectId, song.id, v.id); await versions.reload(); }
    catch (e) { toast.error('沒有成功：' + friendlyError(e)); }
  }

  return (
    <div className="song-detail">
      <div className="song-detail__sub-top">
        <button className="link-btn" onClick={onClose}><Icon icon={ArrowLeft} /> 回總覽</button>
        <span className="song-detail__nav">
          {prev && <button className="link-btn" onClick={() => onPickSong(prev.id)}><Icon icon={ChevronLeft} /> {prev.name}</button>}
          <span className="song-detail__title">
            {song.code && <span className="song-code" title="歌曲代號">{song.code}</span>}
            {song.name}
          </span>
          {next && <button className="link-btn" onClick={() => onPickSong(next.id)}>{next.name} <Icon icon={ChevronRight} /></button>}
        </span>
        <span className={'status-pill status-pill--' + song.status}>{STATUS_LABEL[song.status]}</span>
        <span className="grow" />
        {actions.length > 0 && (
          <div className="song-detail__approve">
            {actions.map(a => (
              <button
                key={a.kind}
                className={'btn btn--sm ' + (a.primary ? 'btn--primary' : 'btn--ghost')}
                onClick={() => onChangeStatus(song.id, a.to)}
              >{a.label}</button>
            ))}
          </div>
        )}
        {actionsHint && <span className="muted small">{actionsHint}</span>}
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
            emptyText={canAdd ? '這首歌還沒有影片，按右邊「加影片」交第一版' : '這首歌還沒有影片（動畫師交了之後會自動出現）'}
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
                lookSettings={personalLook.effective}
                onLookSettingsChange={personalLook.set}
                lookCustomized={personalLook.customized}
                onLookReset={personalLook.reset}
                onLookSaveAsDefault={view.canEdit ? () => view.setLookSettings(personalLook.effective) : undefined}
                materialOverrides={view.materialOverrides}
                homeView={view.homeView}
                onHomeViewChange={view.canEdit ? view.setHomeView : undefined}
                onMaterialOverrideChange={view.canEdit ? view.setMaterialOverride : undefined}
                onAddAnchoredComment={(anchor) => {
                  // 上層存暫存的 anchor，留言區會接著用
                  pendingAnchorRef.current = anchor;
                  // 觸發留言區「需要 anchor 模式」 — 用 pendingCommentTime 0 + 一個 flag
                  setPendingCommentAnchor(anchor);
                }}
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
                  onAddCommentAtTime={(t) => setPendingCommentTime(t)}
                  onRetry={retryVersion}
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
          <SongComments
            projectId={projectId}
            song={song}
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
}) {
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  // 用戶可以「掛在某個時間」留言（從 timeline 來、或自己 toggle）
  const [attachTime, setAttachTime] = useState<number | null>(null);
  const [attachAnchor, setAttachAnchor] = useState<import('../lib/api').CommentAnchor | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 修改留言（自己的，或 admin）
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  // @-mention 自動完成
  const [mentionState, setMentionState] = useState<{
    open: boolean; query: string; startIdx: number; activeIdx: number;
  }>({ open: false, query: '', startIdx: 0, activeIdx: 0 });

  // 切歌：清掉打到一半的修改 / 多選
  useEffect(() => {
    setEditingId(null);
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

  const filteredMembers = (members || []).filter(m =>
    m.name.toLowerCase().includes(mentionState.query.toLowerCase())
  ).slice(0, 6);

  // Bulk-select 模式
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
  const canModify = (c: SongComment) => canModifyComment(c, user, projectRole);
  // 多選裡面可以刪的（自己的，或 admin）
  const deletableSelected = comments.filter(c => selectedIds.has(c.id) && canModify(c));
  // Filter / sort
  const [filterStatus, setFilterStatus] = useState<'all' | 'open' | 'resolved'>(() => {
    try { return (localStorage.getItem('sp_comment_filter') as 'all' | 'open' | 'resolved') || 'open'; } catch { return 'open'; }
  });
  const [filterRole, setFilterRole] = useState<'all' | 'animator' | 'director' | 'designer'>('all');
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'time-asc'>(() => {
    try { return (localStorage.getItem('sp_comment_sort') as 'newest' | 'oldest' | 'time-asc') || 'newest'; } catch { return 'newest'; }
  });
  useEffect(() => { try { localStorage.setItem('sp_comment_filter', filterStatus); } catch {} }, [filterStatus]);
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
      // 作者 / 身分由後台依登入的人填
      const updated = await api.postSongComment(projectId, song.id, {
        text: t,
        time: attachTime ?? 0,
        anchor: attachAnchor ?? undefined,
        mentions: extractMentions(t, members),
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

  async function handleDelete(id: string) {
    if (!confirm('刪除這則留言？')) return;
    try {
      const updated = await api.deleteSongComment(projectId, song.id, id);
      onChange(updated);
    } catch (e) { toast.error('刪除失敗：' + friendlyError(e)); }
  }

  async function handleSaveEdit(id: string) {
    const t = editText.trim();
    if (!t) return;
    try {
      onChange(await api.patchSongComment(projectId, song.id, id, { text: t }));
      setEditingId(null);
    } catch (e) { toast.error('修改失敗：' + friendlyError(e)); }
  }

  async function bulkMarkResolved() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(`把 ${ids.length} 則留言標為已解決？`)) return;
    let okCount = 0;
    let lastList: SongComment[] | null = null;
    for (const id of ids) {
      try {
        // 誰解決、什麼時候由後台記
        const updated = await api.patchSongComment(projectId, song.id, id, { status: 'resolved' });
        lastList = updated;
        okCount++;
      } catch { /* swallow per-item, continue */ }
    }
    if (lastList) onChange(lastList);
    clearSelection();
    toast.success(`已標 ${okCount}/${ids.length} 則為已解決`);
  }

  async function bulkDelete() {
    const ids = deletableSelected.map(c => c.id);
    if (ids.length === 0) return;
    const skipped = selectedIds.size - ids.length;
    const note = skipped > 0 ? `\n\n（另外 ${skipped} 則是別人的留言，只有留言的人或製作能刪，會跳過）` : '';
    if (!confirm(`刪除 ${ids.length} 則留言？無法復原。${note}`)) return;
    let okCount = 0;
    let lastList: SongComment[] | null = null;
    for (const id of ids) {
      try {
        const updated = await api.deleteSongComment(projectId, song.id, id);
        lastList = updated;
        okCount++;
      } catch { /* swallow */ }
    }
    if (lastList) onChange(lastList);
    clearSelection();
    toast.success(`已刪除 ${okCount}/${ids.length} 則`);
  }

  async function handleToggleResolved(c: SongComment) {
    const next = c.status === 'resolved' ? 'open' : 'resolved';
    try {
      const updated = await api.patchSongComment(projectId, song.id, c.id, { status: next });
      onChange(updated);
    } catch (e) { toast.error('狀態切換失敗：' + friendlyError(e)); }
  }

  // Filter + sort
  const filteredComments = (() => {
    let list = comments.slice();
    if (filterStatus !== 'all') list = list.filter(c => (c.status ?? 'open') === filterStatus);
    if (filterRole !== 'all') list = list.filter(c => c.role === filterRole);
    list.sort((a, b) => {
      if (sortBy === 'newest') return b.createdAt.localeCompare(a.createdAt);
      if (sortBy === 'oldest') return a.createdAt.localeCompare(b.createdAt);
      // time-asc：依綁定的影片時間
      return (a.time || 0) - (b.time || 0);
    });
    return list;
  })();

  return (
    <div className="song-comments">
      <div className="song-comments__head">
        <span>留言（{filteredComments.length}/{comments.length}）</span>
        <button className="link-btn" onClick={onRefresh}>重新整理</button>
      </div>

      {selectedIds.size > 0 && (
        <div className="song-comments__bulk">
          <span>已選 <strong>{selectedIds.size}</strong> 則</span>
          <button className="btn btn--sm btn--primary" onClick={bulkMarkResolved}>標已解決</button>
          {deletableSelected.length > 0 && (
            <button className="btn btn--sm btn--ghost" onClick={bulkDelete}>
              刪除{deletableSelected.length < selectedIds.size ? `（${deletableSelected.length} 則可刪）` : ''}
            </button>
          )}
          <button className="link-btn" onClick={clearSelection}>取消</button>
        </div>
      )}

      <div className="song-comments__filters">
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as 'all' | 'open' | 'resolved')}>
          <option value="open">未解決</option>
          <option value="resolved">已解決</option>
          <option value="all">全部</option>
        </select>
        <select value={filterRole} onChange={e => setFilterRole(e.target.value as 'all' | 'animator' | 'director' | 'designer')}>
          <option value="all">所有角色</option>
          <option value="director">導演</option>
          <option value="animator">動畫師</option>
          <option value="designer">製作</option>
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value as 'newest' | 'oldest' | 'time-asc')}>
          <option value="newest">最新優先</option>
          <option value="oldest">最舊優先</option>
          <option value="time-asc">依影片時間</option>
        </select>
      </div>

      {user && (
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
                ? `在 ${formatTimeMS(attachTime)} 留言（打 @ 可以提及成員）`
                : '留言給動畫師（例：第 3 個 cue 機關升起來太慢；打 @ 可以提及成員）'}
              value={text}
              onChange={handleTextChange}
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
          <button className="btn btn--primary btn--sm" onClick={handlePost} disabled={posting || !text.trim()}>
            送出
          </button>
        </div>
      )}

      {loading ? (
        <div className="song-comments__list">
          {Array.from({ length: 3 }).map((_, i) => <CommentSkeleton key={i} />)}
        </div>
      ) : filteredComments.length === 0 ? (
        <div className="song-comments__empty">
          {comments.length === 0 ? '還沒有留言' : `沒有符合篩選的留言（共 ${comments.length} 則）`}
        </div>
      ) : (
        <ul className="song-comments__list">
          {filteredComments.map(c => {
            const isResolved = c.status === 'resolved';
            const isSelected = selectedIds.has(c.id);
            const editing = editingId === c.id;
            return (
              <li
                key={c.id}
                id={`comment-${c.id}`}
                className={'song-comment song-comment--' + c.role + (isResolved ? ' is-resolved' : '') + (isSelected ? ' is-selected' : '')}
              >
                <div className="song-comment__head">
                  <input
                    type="checkbox"
                    className="song-comment__check"
                    checked={isSelected}
                    onChange={() => toggleSelect(c.id)}
                    title="多選"
                  />
                  <span className="song-comment__author">{c.author}</span>
                  <span className="song-comment__role">{roleLabel(c.role)}</span>
                  {c.time > 0 && (
                    <span className="song-comment__attach" title="綁定影片時間"><Icon icon={Clock} size="xs" /> {formatTimeMS(c.time)}</span>
                  )}
                  {c.anchor && c.anchor.type !== 'screen' && (
                    <span className="song-comment__attach" title="3D 位置"><Icon icon={MapPin} size="xs" label="3D 位置" /></span>
                  )}
                  {isResolved && (
                    <span className="song-comment__resolved-pill" title={c.resolvedBy ? `${c.resolvedBy} 解決於 ${formatRelativeTime(c.resolvedAt || '')}` : '已解決'}><Icon icon={Check} size="xs" /> 已解決</span>
                  )}
                  <span className="song-comment__time">{formatRelativeTime(c.createdAt)}</span>
                  {user && (
                    <button
                      className="song-comment__del"
                      onClick={() => handleToggleResolved(c)}
                      title={isResolved ? '標為未解決' : '標為已解決'}
                      aria-label={isResolved ? '標為未解決' : '標為已解決'}
                    ><Icon icon={isResolved ? RotateCcw : Check} /></button>
                  )}
                  {canModify(c) && !editing && (
                    <>
                      <button
                        className="song-comment__del"
                        style={{ fontSize: 11.5 }}
                        onClick={() => { setEditingId(c.id); setEditText(c.text); }}
                        title="修改"
                      >修改</button>
                      <button className="song-comment__del" onClick={() => handleDelete(c.id)} title="刪除" aria-label="刪除"><Icon icon={X} /></button>
                    </>
                  )}
                </div>
                {editing ? (
                  <div className="song-comments__compose">
                    <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={3} autoFocus />
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn btn--ghost btn--sm" onClick={() => setEditingId(null)}>取消</button>
                      <button className="btn btn--primary btn--sm" onClick={() => handleSaveEdit(c.id)} disabled={!editText.trim()}>儲存</button>
                    </div>
                  </div>
                ) : (
                  <div className="song-comment__text">{c.text}</div>
                )}
              </li>
            );
          })}
        </ul>
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

