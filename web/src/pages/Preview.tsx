import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { Cue, CueState, DriveFile, Song, SongComment, StageObject } from '../lib/api';
import type { Project } from '../lib/mockData';
import { useAuth } from '../lib/auth';
import StageScene from '../components/StageScene';
import VideoTimeline from '../components/VideoTimeline';
import ActivityDrawer from '../components/ActivityDrawer';
import { ProjectCardSkeleton, CommentSkeleton } from '../components/Skeleton';
import { toast } from '../lib/toast';
import './Preview.css';

type Status = Song['status'];

const STATUS_COLUMNS: { key: Status; label: string; emoji: string }[] = [
  { key: 'todo',          label: '待製作', emoji: '⏳' },
  { key: 'in_review',     label: '審查中', emoji: '👀' },
  { key: 'needs_changes', label: '需修改', emoji: '✏️' },
  { key: 'approved',      label: '已通過', emoji: '✅' },
];

const STATUS_LABEL: Record<Status, string> = {
  todo:          '待製作',
  in_review:     '審查中',
  approved:      '已通過',
  needs_changes: '需修改',
};

export default function Preview() {
  const { projectId } = useParams();
  if (!projectId) return <ProjectPicker />;
  return <PreviewInner projectId={projectId} />;
}

/* ──────────── Project Picker ──────────── */

function ProjectPicker() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listProjects()
      .then(list => { if (!cancelled) setProjects(list); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  if (!user) return <div className="preview-loading">⏳ 請先登入</div>;

  return (
    <div className="preview-picker">
      <header className="preview-picker__hero">
        <button className="preview-picker__back" onClick={() => navigate('/')} title="回首頁">←</button>
        <div className="role-icon">🎬</div>
        <div>
          <h1>Director · 動畫進度</h1>
          <p>看每首歌的審查狀態、留言、3D 預覽</p>
        </div>
        <span className="grow" />
        <span className="preview-picker__user">
          <span className="avatar avatar--sm" style={{ background: user.avatarColor }}>{user.name[0]}</span>
          <span>{user.name}</span>
          <button className="link-btn" onClick={async () => { await logout(); navigate('/login'); }}>登出</button>
        </span>
      </header>

      {error && <div className="preview-error">載入失敗：{error}</div>}
      {!projects && !error && (
        <div className="preview-picker__grid">
          {Array.from({ length: 4 }).map((_, i) => <ProjectCardSkeleton key={i} />)}
        </div>
      )}

      {projects && projects.length === 0 && (
        <div className="preview-empty">
          <h2>還沒有可看的專案</h2>
          <p>請聯絡製作主管把你加入專案。</p>
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className="preview-picker__grid">
          {projects.map(p => {
            const counts = p.songStatusCounts || { todo: 0, in_review: 0, approved: 0, needs_changes: 0 };
            const total = counts.todo + counts.in_review + counts.approved + counts.needs_changes;
            const pct = total > 0 ? Math.round((counts.approved / total) * 100) : 0;
            return (
              <Link key={p.id} to={`/preview/${p.id}`} className="preview-picker__card">
                <div className="preview-picker__card-name">{p.name}</div>
                {p.description && <div className="preview-picker__card-desc">{p.description}</div>}
                <div className="preview-picker__card-progress">
                  <div className="preview-picker__bar">
                    {total > 0 && (
                      <>
                        <span style={{ width: `${(counts.approved / total) * 100}%` }} className="preview-picker__bar-segment preview-picker__bar-segment--approved" />
                        <span style={{ width: `${(counts.in_review / total) * 100}%` }} className="preview-picker__bar-segment preview-picker__bar-segment--review" />
                        <span style={{ width: `${(counts.needs_changes / total) * 100}%` }} className="preview-picker__bar-segment preview-picker__bar-segment--changes" />
                        <span style={{ width: `${(counts.todo / total) * 100}%` }} className="preview-picker__bar-segment preview-picker__bar-segment--todo" />
                      </>
                    )}
                  </div>
                  <div className="preview-picker__pct">{pct}%</div>
                </div>
                <div className="preview-picker__card-stats">
                  <span title="待製作">⏳ {counts.todo}</span>
                  <span title="審查中">👀 {counts.in_review}</span>
                  <span title="需修改">✏️ {counts.needs_changes}</span>
                  <span title="已通過">✅ {counts.approved}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ──────────── Preview Inner ──────────── */

function PreviewInner({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const [projectName, setProjectName] = useState<string>('');
  const [projectMembers, setProjectMembers] = useState<{ id: string; name: string }[]>([]);
  const [songs, setSongs] = useState<Song[]>([]);
  const [songsLoading, setSongsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
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

  const refresh = useCallback(async () => {
    setSongsLoading(true);
    setError(null);
    try {
      const [list, objs, model, meta] = await Promise.all([
        api.listSongs(projectId),
        api.listStageObjects(projectId).catch(() => [] as StageObject[]),
        api.getModelInfo(projectId).catch(() => null),
        api.getProjectMeta(projectId).catch(() => null),
      ]);
      setSongs(list);
      setStageObjects(objs);
      setModelUrl(model ? api.modelDownloadUrl(model.key) : null);
      setProjectName(meta?.name || '');
      setProjectMembers(meta?.members?.map(m => ({ id: m.id, name: m.name })) || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSongsLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!selectedSongId) { setCues([]); setSelectedCueId(null); return; }
    let cancelled = false;
    api.listCues(projectId, selectedSongId).then(list => {
      if (cancelled) return;
      setCues(list);
      const masters = list.filter(c => c.status === 'master');
      setSelectedCueId(masters[0]?.id ?? null);
    }).catch(() => { if (!cancelled) setCues([]); });
    return () => { cancelled = true; };
  }, [projectId, selectedSongId]);

  useEffect(() => {
    if (!selectedSongId || !selectedCueId) { setCueStates([]); return; }
    let cancelled = false;
    api.listCueStates(projectId, selectedSongId, selectedCueId).then(list => {
      if (!cancelled) setCueStates(list);
    }).catch(() => { if (!cancelled) setCueStates([]); });
    return () => { cancelled = true; };
  }, [projectId, selectedSongId, selectedCueId]);

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
    const masters = cues.filter(c => c.status === 'master');
    // 沒選歌就從第一首開始
    if (!selectedSongId && songs.length > 0) {
      setSelectedSongId(songs[0].id);
      return;
    }
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
  }, [showMode, cues, selectedSongId, showCueIntervalSec]);

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

  const masterCues = useMemo(() => cues.filter(c => c.status === 'master'), [cues]);
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

  // 沒選 cue 時 viewport 顯示 stage objects 的 default
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

  async function changeStatus(songId: string, status: Status) {
    const prev = songs;
    setSongs(prev.map(s => s.id === songId ? { ...s, status } : s));
    try {
      await api.updateSong(projectId, songId, { status });
    } catch (e) {
      setSongs(prev);
      toast.error('狀態更新失敗：' + msg(e));
    }
  }

  // 鍵盤：Shift+J/K 切 cue（在預覽區）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'j' && k !== 'k') return;
      if (!masterCues.length) return;
      e.preventDefault();
      const idx = masterCues.findIndex(c => c.id === selectedCueId);
      const next = k === 'j'
        ? (idx < 0 ? 0 : Math.min(idx + 1, masterCues.length - 1))
        : (idx <= 0 ? 0 : idx - 1);
      setSelectedCueId(masterCues[next].id);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [masterCues, selectedCueId]);

  return (
    <div className="preview">
      <header className="preview-top">
        <button className="preview-top__back" onClick={() => navigate('/preview')} title="所有專案">←</button>
        <span className="preview-top__role">🎬 DIRECTOR</span>
        <span className="preview-top__project">{projectName || '…'}</span>
        <div className="preview-top__progress">
          <div className="preview-top__progress-bar">
            <span style={{ width: `${overallPct}%` }} />
          </div>
          <span className="preview-top__progress-text">{approvedCount}/{totalCount} · {overallPct}%</span>
        </div>
        <span className="grow" />
        <button
          className="btn btn--sm btn--ghost"
          onClick={() => setActivityOpen(true)}
          title="最近活動"
        >🕒 活動</button>
        <button
          className={'btn btn--sm ' + (showMode ? 'btn--primary' : 'btn--ghost')}
          onClick={() => setShowMode(m => !m)}
          title={showMode ? '停止整場串播' : '從目前歌曲開始整場依序自動播放'}
          disabled={songs.length === 0}
        >
          {showMode ? '⏸ 停止整場' : '🎤 整場串播'}
        </button>
        {showMode && (
          <select
            className="preview-top__interval"
            value={showCueIntervalSec}
            onChange={e => setShowCueIntervalSec(parseInt(e.target.value, 10))}
            title="每 cue 停留秒數"
          >
            <option value={2}>2s/cue</option>
            <option value={3}>3s/cue</option>
            <option value={5}>5s/cue</option>
            <option value={10}>10s/cue</option>
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

      {error && <div className="preview-error">{error}</div>}

      {songsLoading ? (
        <div className="preview-loading">⏳ 載入中…</div>
      ) : songs.length === 0 ? (
        <div className="preview-empty">
          <h2>這個專案還沒有歌</h2>
          <p>請製作主管在 admin 加上歌曲</p>
        </div>
      ) : selectedSongId && selectedSong ? (
        <SongDetail
          projectId={projectId}
          song={selectedSong}
          cues={masterCues}
          selectedCueId={selectedCueId}
          onSelectCue={setSelectedCueId}
          autoStep={autoStep}
          onToggleAutoStep={() => setAutoStep(v => !v)}
          stageObjects={stageObjects}
          viewportStates={viewportStates}
          modelUrl={modelUrl}
          cueName={selectedCue?.name}
          user={user}
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
          canApprove={user?.role === 'director' || user?.role === 'admin'}
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
  songsByStatus, onPickSong, onChangeStatus, canApprove,
}: {
  songsByStatus: Record<Status, Song[]>;
  onPickSong: (id: string) => void;
  onChangeStatus: (id: string, status: Status) => void;
  canApprove: boolean;
}) {
  return (
    <div className="status-board">
      {STATUS_COLUMNS.map(col => (
        <div key={col.key} className={'status-col status-col--' + col.key}>
          <div className="status-col__head">
            <span className="status-col__emoji">{col.emoji}</span>
            <span className="status-col__name">{col.label}</span>
            <span className="status-col__count">{songsByStatus[col.key].length}</span>
          </div>
          <div className="status-col__body">
            {songsByStatus[col.key].length === 0 ? (
              <div className="status-col__empty">—</div>
            ) : (
              songsByStatus[col.key].map(s => (
                <div key={s.id} className="status-card">
                  <button
                    className="status-card__open"
                    onClick={() => onPickSong(s.id)}
                  >
                    <div className="status-card__name">{s.name}</div>
                    <div className="status-card__meta">
                      {s.cueCount} cue{s.proposalCount > 0 && ` · ${s.proposalCount} 提案`}
                    </div>
                  </button>
                  {canApprove && col.key === 'in_review' && (
                    <div className="status-card__actions">
                      <button
                        className="btn btn--primary btn--sm"
                        onClick={() => onChangeStatus(s.id, 'approved')}
                      >通過</button>
                      <button
                        className="btn btn--ghost btn--sm"
                        onClick={() => onChangeStatus(s.id, 'needs_changes')}
                      >需修改</button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ──────────── Song Detail ──────────── */

function SongDetail({
  projectId, song, cues, selectedCueId, onSelectCue, autoStep, onToggleAutoStep,
  stageObjects, viewportStates, modelUrl, cueName, user, onChangeStatus, onClose, onPickSong, songs, members,
}: {
  projectId: string;
  song: Song;
  cues: Cue[];
  selectedCueId: string | null;
  onSelectCue: (id: string) => void;
  autoStep: boolean;
  onToggleAutoStep: () => void;
  stageObjects: StageObject[];
  viewportStates: CueState[];
  modelUrl: string | null;
  cueName?: string;
  user: ReturnType<typeof useAuth>['user'];
  onChangeStatus: (songId: string, status: Status) => void | Promise<void>;
  onClose: () => void;
  onPickSong: (id: string) => void;
  songs: Song[];
  members: { id: string; name: string }[];
}) {
  const canApprove = user?.role === 'director' || user?.role === 'admin';

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

  const refreshComments = useCallback(async () => {
    setCommentsLoading(true);
    try {
      const list = await api.listSongComments(projectId, song.id);
      setComments(list);
    } catch (e) {
      console.warn('load comments failed', e);
    } finally {
      setCommentsLoading(false);
    }
  }, [projectId, song.id]);

  useEffect(() => { refreshComments(); }, [refreshComments]);

  // 每 60 秒輪詢一次（導演端）— 比對新增彈 toast
  const lastSeenIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const id = window.setInterval(async () => {
      try {
        const list = await api.listSongComments(projectId, song.id);
        const knownIds = lastSeenIdsRef.current;
        if (knownIds.size === 0) {
          // 第一次：記下既有 id，不通知
          lastSeenIdsRef.current = new Set(list.map(c => c.id));
        } else {
          const fresh = list.filter(c => !knownIds.has(c.id) && c.author !== user?.name);
          if (fresh.length > 0) {
            for (const c of fresh.slice(-3)) {
              toast.info(`💬 ${c.author}「${c.text.slice(0, 40)}${c.text.length > 40 ? '…' : ''}」`);
            }
            lastSeenIdsRef.current = new Set(list.map(c => c.id));
          }
        }
        setComments(list);
      } catch { /* swallow */ }
    }, 60_000);
    return () => clearInterval(id);
  }, [projectId, song.id, user?.name]);
  useEffect(() => { lastSeenIdsRef.current = new Set(comments.map(c => c.id)); }, [song.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="song-detail">
      <div className="song-detail__sub-top">
        <button className="link-btn" onClick={onClose}>← 回總覽</button>
        <span className="song-detail__nav">
          {prev && <button className="link-btn" onClick={() => onPickSong(prev.id)}>‹ {prev.name}</button>}
          <span className="song-detail__title">{song.name}</span>
          {next && <button className="link-btn" onClick={() => onPickSong(next.id)}>{next.name} ›</button>}
        </span>
        <span className={'status-pill status-pill--' + song.status}>{STATUS_LABEL[song.status]}</span>
        <span className="grow" />
        {canApprove && (
          <div className="song-detail__approve">
            {song.status !== 'approved' && (
              <button className="btn btn--primary btn--sm" onClick={() => onChangeStatus(song.id, 'approved')}>
                ✓ 通過
              </button>
            )}
            {song.status !== 'needs_changes' && song.status !== 'approved' && (
              <button className="btn btn--ghost btn--sm" onClick={() => onChangeStatus(song.id, 'needs_changes')}>
                ✏️ 需修改
              </button>
            )}
            {song.status === 'approved' && (
              <button className="btn btn--ghost btn--sm" onClick={() => onChangeStatus(song.id, 'in_review')}>
                撤回通過
              </button>
            )}
          </div>
        )}
      </div>

      <div className="song-detail__body">
        <main className="song-detail__main">
          <SongVideoPane
            projectId={projectId}
            songId={song.id}
            comments={comments}
            onAddCommentAtTime={(t) => setPendingCommentTime(t)}
          />

          <div className="song-detail__stage">
            {cues.length === 0 ? (
              <div className="song-detail__no-cue">
                <div className="empty-icon">🎬</div>
                <p>這首歌還沒有 cue</p>
              </div>
            ) : (
              <StageScene
                key={`${projectId}:${song.id}`}
                states={viewportStates}
                stageObjects={stageObjects}
                selectedObjectIds={[]}
                onSelect={() => {}}
                onTransform={() => {}}
                cueName={cueName}
                modelUrl={modelUrl}
                readOnly
                defaultRenderMode="cinematic"
                crossfadeSeconds={cues.find(c => c.id === selectedCueId)?.crossfadeSeconds ?? 0}
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
                onAddAnchoredComment={(anchor) => {
                  // 上層存暫存的 anchor，留言區會接著用
                  pendingAnchorRef.current = anchor;
                  // 觸發留言區「需要 anchor 模式」 — 用 pendingCommentTime 0 + 一個 flag
                  setPendingCommentAnchor(anchor);
                }}
              />
            )}
            {cues.length > 0 && (
              <div className="song-detail__cuebar">
                <button
                  className={'cuebar-btn' + (autoStep ? ' is-active' : '')}
                  onClick={onToggleAutoStep}
                  title={autoStep ? '停止自動播放' : '每 2 秒自動切 cue'}
                >{autoStep ? '⏸' : '▶'}</button>
                <div className="cuebar-track">
                  {cues.map((c, i) => (
                    <button
                      key={c.id}
                      className={'cuebar-cue' + (c.id === selectedCueId ? ' is-active' : '')}
                      onClick={() => onSelectCue(c.id)}
                      title={c.name}
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
            comments={comments}
            loading={commentsLoading}
            onChange={setComments}
            onRefresh={refreshComments}
            pendingTime={pendingCommentTime}
            onConsumedPendingTime={() => setPendingCommentTime(null)}
            pendingAnchor={pendingCommentAnchor}
            onConsumedPendingAnchor={() => { setPendingCommentAnchor(null); pendingAnchorRef.current = null; }}
            members={members}
          />
        </aside>
      </div>
    </div>
  );
}

/* ──────────── Comments ──────────── */

function SongComments({
  projectId, song, user, comments, loading, onChange, onRefresh,
  pendingTime, onConsumedPendingTime, pendingAnchor, onConsumedPendingAnchor, members,
}: {
  projectId: string;
  song: Song;
  user: ReturnType<typeof useAuth>['user'];
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
  // @-mention 自動完成
  const [mentionState, setMentionState] = useState<{
    open: boolean; query: string; startIdx: number; activeIdx: number;
  }>({ open: false, query: '', startIdx: 0, activeIdx: 0 });

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

  function extractMentions(t: string): { userId: string; name: string }[] {
    const names = (members || []).map(m => m.name).filter(Boolean);
    const found = new Map<string, { userId: string; name: string }>();
    for (const m of members || []) {
      const re = new RegExp('@' + escapeRegExp(m.name) + '\\b', 'g');
      if (re.test(t)) found.set(m.id, { userId: m.id, name: m.name });
    }
    void names;
    return Array.from(found.values());
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
      const updated = await api.postSongComment(projectId, song.id, {
        text: t,
        author: user.name,
        role: user.role === 'director' ? 'director' : (user.role === 'animator' ? 'animator' : 'designer'),
        time: attachTime ?? 0,
        anchor: attachAnchor ?? undefined,
        mentions: extractMentions(t),
      });
      onChange(updated);
      setText('');
      setAttachTime(null);
      setAttachAnchor(null);
    } catch (e) {
      toast.error('留言失敗：' + msg(e));
    } finally {
      setPosting(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('刪除這則留言？')) return;
    try {
      const updated = await api.deleteSongComment(projectId, song.id, id);
      onChange(updated);
    } catch (e) { toast.error('刪除失敗：' + msg(e)); }
  }

  async function bulkMarkResolved() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(`把 ${ids.length} 則留言標為已解決？`)) return;
    let okCount = 0;
    let lastList: SongComment[] | null = null;
    for (const id of ids) {
      try {
        const updated = await api.patchSongComment(projectId, song.id, id, {
          status: 'resolved',
          resolvedBy: user?.name || '',
          resolvedAt: new Date().toISOString(),
        });
        lastList = updated;
        okCount++;
      } catch { /* swallow per-item, continue */ }
    }
    if (lastList) onChange(lastList);
    clearSelection();
    toast.success(`已標 ${okCount}/${ids.length} 則為已解決`);
  }

  async function bulkDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (!confirm(`刪除 ${ids.length} 則留言？無法復原。`)) return;
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
      const updated = await api.patchSongComment(projectId, song.id, c.id, {
        status: next,
        resolvedBy: next === 'resolved' && user ? user.name : '',
        resolvedAt: next === 'resolved' ? new Date().toISOString() : '',
      });
      onChange(updated);
    } catch (e) { toast.error('狀態切換失敗：' + msg(e)); }
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
          <button className="btn btn--sm btn--primary" onClick={bulkMarkResolved}>✓ 標已解決</button>
          <button className="btn btn--sm btn--ghost" onClick={bulkDelete}>🗑 刪除</button>
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
              📍 掛在 <strong>{formatTimeMS(attachTime)}</strong>
              <button className="link-btn" onClick={() => setAttachTime(null)} title="取消綁時間">×</button>
            </div>
          )}
          {attachAnchor && (
            <div className="song-comments__attach song-comments__attach--3d">
              📌 3D 位置：<strong>
                {attachAnchor.type === 'mesh'
                  ? `物件「${attachAnchor.meshName}」`
                  : attachAnchor.type === 'world'
                    ? `場景座標 (${attachAnchor.world.x.toFixed(1)}, ${attachAnchor.world.y.toFixed(1)}, ${attachAnchor.world.z.toFixed(1)})`
                    : '螢幕'}
              </strong>
              <button className="link-btn" onClick={() => setAttachAnchor(null)} title="取消 3D 錨點">×</button>
            </div>
          )}
          <div style={{ position: 'relative' }}>
            <textarea
              ref={textareaRef}
              placeholder={attachTime !== null
                ? `在 ${formatTimeMS(attachTime)} 留言（@ 提及人會通知 TA）`
                : '留言給動畫師（例：第 3 個 cue 機關升起來太慢；@ 開頭可提及成員）'}
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
                    <span className="song-comment__attach" title="綁定影片時間">📍 {formatTimeMS(c.time)}</span>
                  )}
                  {c.anchor && c.anchor.type !== 'screen' && (
                    <span className="song-comment__attach" title="3D 位置">📌</span>
                  )}
                  {isResolved && (
                    <span className="song-comment__resolved-pill" title={c.resolvedBy ? `${c.resolvedBy} 解決於 ${formatTime(c.resolvedAt || '')}` : '已解決'}>✓ 已解決</span>
                  )}
                  <span className="song-comment__time">{formatTime(c.createdAt)}</span>
                  {user && (
                    <button
                      className="song-comment__del"
                      onClick={() => handleToggleResolved(c)}
                      title={isResolved ? '標為未解決' : '標為已解決'}
                    >{isResolved ? '↺' : '✓'}</button>
                  )}
                  {user && c.author === user.name && (
                    <button className="song-comment__del" onClick={() => handleDelete(c.id)} title="刪除">×</button>
                  )}
                </div>
                <div className="song-comment__text">{c.text}</div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ──────────── Video Pane（從 Drive 拉影片） ──────────── */

function SongVideoPane({
  projectId, songId, comments, onAddCommentAtTime,
}: {
  projectId: string;
  songId: string;
  comments: SongComment[];
  onAddCommentAtTime: (time: number) => void;
}) {
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 主版本 + 比較版本（V1/V2 並排對比模式）
  const [primaryFid, setPrimaryFid] = useState<string | null>(null);
  const [compareFid, setCompareFid] = useState<string | null>(null);   // null = 不開對比
  const [collapsed, setCollapsed] = useState(false);

  const videoARef = useRef<HTMLVideoElement>(null);
  const videoBRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // 影片載入失敗 retry（最多 3 次）— Drive proxy 偶爾 5xx
  const [videoRetryA, setVideoRetryA] = useState(0);
  const [videoRetryB, setVideoRetryB] = useState(0);
  const [videoErrorA, setVideoErrorA] = useState<string | null>(null);
  const [videoErrorB, setVideoErrorB] = useState<string | null>(null);
  useEffect(() => {
    setVideoRetryA(0);
    setVideoErrorA(null);
  }, [primaryFid]);
  useEffect(() => {
    setVideoRetryB(0);
    setVideoErrorB(null);
  }, [compareFid]);
  // 對比模式 sync 用：避免 onTimeUpdate / play / pause 互相觸發無限迴圈
  const syncingRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const all = await api.listDriveProjectFiles(projectId);
      const mine = all.filter(f => f.songId === songId).sort((a, b) => {
        const ta = a.modifiedTime || a.cachedAt;
        const tb = b.modifiedTime || b.cachedAt;
        return tb.localeCompare(ta);
      });
      setFiles(mine);
      if (mine.length > 0 && !primaryFid) setPrimaryFid(mine[0].driveFileId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId, songId, primaryFid]);

  useEffect(() => {
    setPrimaryFid(null);
    setCompareFid(null);
    setCurrentTime(0);
    setDuration(0);
  }, [songId]);
  useEffect(() => { refresh(); }, [refresh]);

  // ── 主 video 事件 → time/duration ──
  useEffect(() => {
    const v = videoARef.current;
    if (!v) return;
    const onTime = () => setCurrentTime(v.currentTime);
    const onMeta = () => setDuration(v.duration || 0);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('durationchange', onMeta);
    return () => {
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('durationchange', onMeta);
    };
  }, [primaryFid]);

  // ── 對比模式：A ↔ B sync（time + play/pause + rate）──
  useEffect(() => {
    const a = videoARef.current;
    const b = videoBRef.current;
    if (!a || !b || !compareFid) return;

    function sync(from: HTMLVideoElement, to: HTMLVideoElement) {
      if (syncingRef.current) return;
      // diff 太小不動（節流）
      if (Math.abs(to.currentTime - from.currentTime) > 0.15) {
        syncingRef.current = true;
        try { to.currentTime = from.currentTime; } catch {}
        setTimeout(() => { syncingRef.current = false; }, 50);
      }
      if (to.paused !== from.paused) {
        syncingRef.current = true;
        try { from.paused ? to.pause() : void to.play().catch(() => {}); } catch {}
        setTimeout(() => { syncingRef.current = false; }, 50);
      }
      if (Math.abs(to.playbackRate - from.playbackRate) > 0.01) {
        to.playbackRate = from.playbackRate;
      }
    }
    const onA = () => sync(a, b);
    const onB = () => sync(b, a);
    const events = ['play', 'pause', 'seeked', 'ratechange', 'timeupdate'];
    events.forEach(ev => { a.addEventListener(ev, onA); b.addEventListener(ev, onB); });
    return () => {
      events.forEach(ev => { a.removeEventListener(ev, onA); b.removeEventListener(ev, onB); });
    };
  }, [compareFid, primaryFid]);

  function handleSeek(t: number) {
    const v = videoARef.current;
    if (v) v.currentTime = Math.max(0, Math.min(duration || 1e9, t));
  }

  function handlePinClick(c: SongComment) {
    handleSeek(c.time);
    const el = document.getElementById(`comment-${c.id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('song-comment--flash');
      setTimeout(() => el.classList.remove('song-comment--flash'), 1500);
    }
  }

  if (files === null && !error) {
    return <div className="video-pane video-pane--empty">⏳ 載入影片清單…</div>;
  }
  if (error) {
    return <div className="video-pane video-pane--empty video-pane--err">⚠ {error}</div>;
  }
  if (files && files.length === 0) {
    return (
      <div className="video-pane video-pane--empty">
        <span>🎬 這首歌沒有 Drive 影片</span>
        <span className="muted small">（在 Drive 上傳檔名符合規則的檔案後，5 分鐘內自動同步）</span>
      </div>
    );
  }

  const primary = files?.find(f => f.driveFileId === primaryFid) || files?.[0] || null;
  const compare = compareFid ? files?.find(f => f.driveFileId === compareFid) || null : null;
  const primaryUrl = primary ? api.driveStreamUrl(primary.driveFileId) : null;
  const compareUrl = compare ? api.driveStreamUrl(compare.driveFileId) : null;
  const srcKey = primary ? primary.driveFileId : '';

  function versionLabel(f: DriveFile, idx: number, total: number): string {
    return idx === 0 ? `最新 · ${f.filename}` : `V${total - idx} · ${f.filename}`;
  }

  const canCompare = (files?.length ?? 0) >= 2;

  return (
    <div className={'video-pane' + (collapsed ? ' video-pane--collapsed' : '')}>
      <div className="video-pane__head">
        <button className="video-pane__toggle" onClick={() => setCollapsed(c => !c)}>
          {collapsed ? '▶' : '▼'}
        </button>
        <span className="video-pane__title">
          🎬 動畫稿{files && files.length > 1 ? `（${files.length} 版）` : ''}
        </span>
        {primary && !compareFid && (
          <span className="video-pane__filename">{primary.filename}</span>
        )}
        {files && files.length > 1 && (
          <select
            className="video-pane__version"
            value={primaryFid || ''}
            onChange={e => setPrimaryFid(e.target.value)}
            title="切換主版本"
          >
            {files.map((f, i) => (
              <option key={f.driveFileId} value={f.driveFileId}>
                {versionLabel(f, i, files.length)}
                {f.modifiedTime ? ` · ${formatRelativeTime(f.modifiedTime)}` : ''}
              </option>
            ))}
          </select>
        )}
        {canCompare && (
          <button
            className={'btn btn--sm ' + (compareFid ? 'btn--primary' : 'btn--ghost')}
            onClick={() => {
              if (compareFid) {
                setCompareFid(null);
              } else {
                // 預設挑跟 primary 不一樣的版本
                const other = files!.find(f => f.driveFileId !== primaryFid);
                setCompareFid(other?.driveFileId || null);
              }
            }}
            title={compareFid ? '關掉對比' : '開啟並排對比兩個版本'}
          >
            {compareFid ? '⊞ 關閉對比' : '⊞ 並排對比'}
          </button>
        )}
        {compareFid && files && (
          <select
            className="video-pane__version"
            value={compareFid}
            onChange={e => setCompareFid(e.target.value)}
            title="切換對比版本"
          >
            {files.filter(f => f.driveFileId !== primaryFid).map((f, _i) => {
              const idx = files.findIndex(x => x.driveFileId === f.driveFileId);
              return (
                <option key={f.driveFileId} value={f.driveFileId}>
                  vs {versionLabel(f, idx, files.length)}
                </option>
              );
            })}
          </select>
        )}
        <button className="link-btn" onClick={refresh} title="重新整理">↻</button>
      </div>
      {!collapsed && primaryUrl && (
        <>
          {compareUrl ? (
            <div className="video-pane__compare">
              <div className="video-pane__compare-side">
                <div className="video-pane__compare-label">A · {primary?.filename}</div>
                <video
                  ref={videoARef}
                  key={`${primaryUrl}#${videoRetryA}`}
                  className="video-pane__video"
                  src={primaryUrl}
                  controls
                  preload="metadata"
                  onError={() => {
                    if (videoRetryA < 3) {
                      const next = videoRetryA + 1;
                      setVideoRetryA(next);
                      toast.warn(`A 影片載入失敗，自動重試（${next}/3）…`);
                    } else {
                      setVideoErrorA('A 影片重試 3 次都失敗');
                    }
                  }}
                />
                {videoErrorA && <div className="video-pane__err">⚠ {videoErrorA}</div>}
              </div>
              <div className="video-pane__compare-side">
                <div className="video-pane__compare-label">B · {compare?.filename}</div>
                <video
                  ref={videoBRef}
                  key={`${compareUrl}#${videoRetryB}`}
                  className="video-pane__video"
                  src={compareUrl}
                  controls
                  preload="metadata"
                  muted
                  onError={() => {
                    if (videoRetryB < 3) {
                      const next = videoRetryB + 1;
                      setVideoRetryB(next);
                      toast.warn(`B 影片載入失敗，自動重試（${next}/3）…`);
                    } else {
                      setVideoErrorB('B 影片重試 3 次都失敗');
                    }
                  }}
                />
                {videoErrorB && <div className="video-pane__err">⚠ {videoErrorB}</div>}
              </div>
            </div>
          ) : (
            <>
              <video
                ref={videoARef}
                key={`${primaryUrl}#${videoRetryA}`}
                className="video-pane__video"
                src={primaryUrl}
                controls
                preload="metadata"
                onError={() => {
                  if (videoRetryA < 3) {
                    const next = videoRetryA + 1;
                    setVideoRetryA(next);
                    toast.warn(`影片載入失敗，自動重試（${next}/3）…`);
                  } else {
                    setVideoErrorA('影片重試 3 次都失敗，請手動重試');
                  }
                }}
              />
              {videoErrorA && (
                <div className="video-pane__err-row">
                  ⚠ {videoErrorA}
                  <button className="link-btn" onClick={() => { setVideoRetryA(0); setVideoErrorA(null); }}>重新整理</button>
                </div>
              )}
            </>
          )}
          <VideoTimeline
            videoEl={videoARef.current}
            duration={duration}
            currentTime={currentTime}
            comments={comments}
            srcKey={srcKey}
            onSeek={handleSeek}
            onCommentPinClick={handlePinClick}
            onAddCommentHere={onAddCommentAtTime}
          />
        </>
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

function formatRelativeTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return '剛剛';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' });
  } catch { return iso; }
}

function roleLabel(r: SongComment['role']): string {
  if (r === 'animator') return '動畫師';
  if (r === 'director') return '導演';
  return '製作';
}
function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return '剛剛';
    if (min < 60) return `${min} 分鐘前`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} 小時前`;
    return d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' });
  } catch { return iso; }
}
function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
