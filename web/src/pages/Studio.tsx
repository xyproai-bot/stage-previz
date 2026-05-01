import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { ActivityEntry, Cue, CueState, Song, SongComment, StageObject } from '../lib/api';
import type { Project } from '../lib/mockData';
import { useAuth } from '../lib/auth';
import StageScene from '../components/StageScene';
import { ProjectCardSkeleton } from '../components/Skeleton';
import { toast } from '../lib/toast';
import { markSeen, songUnread } from '../lib/unreadComments';
import './Studio.css';

type Tab = 'cues' | 'review' | 'activity';
type SongFilter = 'mine' | 'all';

const STATUS_LABEL: Record<Song['status'], string> = {
  todo:          '待製作',
  in_review:     '審查中',
  approved:      '已通過',
  needs_changes: '需修改',
};

export default function Studio() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  // 沒有 projectId 時 → 顯示我可進的專案清單
  if (!projectId) return <ProjectPicker />;
  if (authLoading) return <div className="studio-loading">⏳ 載入中…</div>;
  if (!user) {
    navigate('/login', { replace: true });
    return null;
  }

  return <StudioInner projectId={projectId} />;
}

/* ──────────── Project Picker（無 projectId 時的入口） ──────────── */

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

  if (!user) return <div className="studio-loading">⏳ 請先登入</div>;

  return (
    <div className="studio-picker">
      <header className="studio-picker__hero">
        <button className="studio-picker__back" onClick={() => navigate('/')} title="回首頁">←</button>
        <div className="role-icon">🎨</div>
        <div>
          <h1>Animator · 動畫師工作站</h1>
          <p>挑一個專案進去看你被指派的歌曲與 cue</p>
        </div>
        <span className="grow" />
        <span className="studio-picker__user">
          <span className="avatar avatar--sm" style={{ background: user.avatarColor }}>{user.name[0]}</span>
          <span className="studio-picker__user-name">{user.name}</span>
          <button className="link-btn" onClick={async () => { await logout(); navigate('/login'); }}>登出</button>
        </span>
      </header>

      {error && <div className="studio-error">載入失敗：{error}</div>}

      {!projects && !error && (
        <div className="studio-picker__grid">
          {Array.from({ length: 4 }).map((_, i) => <ProjectCardSkeleton key={i} />)}
        </div>
      )}

      {projects && projects.length === 0 && (
        <div className="studio-empty">
          <h2>還沒有被指派任何專案</h2>
          <p>請聯絡製作主管把你加入專案。</p>
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className="studio-picker__grid">
          {projects.map(p => (
            <Link key={p.id} to={`/studio/${p.id}`} className="studio-picker__card">
              <div className="studio-picker__card-name">{p.name}</div>
              {p.description && <div className="studio-picker__card-desc">{p.description}</div>}
              <div className="studio-picker__card-stats">
                <span>{p.songCount} 首歌</span>
                {p.proposalCount > 0 && <span className="badge badge--warn">{p.proposalCount} 個提案</span>}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/* ──────────── Studio Inner（projectId 存在時） ──────────── */

function StudioInner({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const [projectName, setProjectName] = useState<string>('');
  const [songs, setSongs] = useState<Song[]>([]);
  const [songsLoading, setSongsLoading] = useState(true);
  const [songsError, setSongsError] = useState<string | null>(null);

  const [songFilter, setSongFilter] = useState<SongFilter>(() => {
    try { return (localStorage.getItem('sp_studio_filter') as SongFilter) || 'mine'; } catch { return 'mine'; }
  });
  useEffect(() => { try { localStorage.setItem('sp_studio_filter', songFilter); } catch {} }, [songFilter]);
  const [songSearch, setSongSearch] = useState('');

  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);
  const [cueStates, setCueStates] = useState<CueState[]>([]);
  const [stageObjects, setStageObjects] = useState<StageObject[]>([]);
  const [modelUrl, setModelUrl] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('cues');
  // 全專案留言 cache（給未讀 badge 用）— 開啟 Studio 時批次抓一次
  const [commentsBySong, setCommentsBySong] = useState<Map<string, SongComment[]>>(new Map());

  // ── Loaders ──
  const refreshAll = useCallback(async () => {
    setSongsLoading(true);
    setSongsError(null);
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSongsError(msg);
    } finally {
      setSongsLoading(false);
    }
  }, [projectId]);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  // 批次抓所有歌的留言（給未讀 badge）— 4 個併發 + 每 60 秒輪詢
  useEffect(() => {
    if (songs.length === 0) return;
    let cancelled = false;
    let pollTimer: number | null = null;

    async function fetchAll() {
      const newMap = new Map<string, SongComment[]>();
      const queue = [...songs];
      const work = async () => {
        while (queue.length > 0 && !cancelled) {
          const s = queue.shift();
          if (!s) return;
          try {
            const list = await api.listSongComments(projectId, s.id);
            if (!cancelled) newMap.set(s.id, list);
          } catch { /* 略過 */ }
        }
      };
      await Promise.all([work(), work(), work(), work()]);
      if (cancelled) return;

      // 比對舊 commentsBySong → 新留言出現就 toast 通知
      setCommentsBySong(prev => {
        if (user && prev.size > 0) {
          for (const s of songs) {
            const before = prev.get(s.id) || [];
            const after = newMap.get(s.id) || [];
            if (after.length > before.length) {
              const beforeIds = new Set(before.map(c => c.id));
              const fresh = after.filter(c => !beforeIds.has(c.id) && c.author !== user.name);
              if (fresh.length > 0) {
                const c = fresh[fresh.length - 1];
                toast.info(`💬 ${s.name}：${c.author}「${c.text.slice(0, 40)}${c.text.length > 40 ? '…' : ''}」`);
              }
            }
          }
        }
        return newMap;
      });
    }

    fetchAll();
    pollTimer = window.setInterval(fetchAll, 60_000);
    return () => {
      cancelled = true;
      if (pollTimer !== null) clearInterval(pollTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songs, projectId, user?.id]);

  // 進入某首歌時自動標已讀
  useEffect(() => {
    if (!user || !selectedSongId) return;
    const list = commentsBySong.get(selectedSongId);
    if (!list || list.length === 0) return;
    const latest = list.reduce((acc, c) => c.createdAt > acc ? c.createdAt : acc, '');
    markSeen(user.id, projectId, selectedSongId, latest);
  }, [user, projectId, selectedSongId, commentsBySong]);

  // 切歌 → 拉 cues
  useEffect(() => {
    if (!selectedSongId) { setCues([]); setSelectedCueId(null); return; }
    let cancelled = false;
    api.listCues(projectId, selectedSongId).then(list => {
      if (cancelled) return;
      const masters = list.filter(c => c.status === 'master');
      setCues(list);
      setSelectedCueId(masters[0]?.id ?? null);
    }).catch(() => { if (!cancelled) setCues([]); });
    return () => { cancelled = true; };
  }, [projectId, selectedSongId]);

  // 切 cue → 拉 states
  useEffect(() => {
    if (!selectedSongId || !selectedCueId) { setCueStates([]); return; }
    let cancelled = false;
    api.listCueStates(projectId, selectedSongId, selectedCueId).then(list => {
      if (!cancelled) setCueStates(list);
    }).catch(() => { if (!cancelled) setCueStates([]); });
    return () => { cancelled = true; };
  }, [projectId, selectedSongId, selectedCueId]);

  // ── Derived ──
  const masterCues = useMemo(() => cues.filter(c => c.status === 'master'), [cues]);
  const selectedCue = useMemo(() => cues.find(c => c.id === selectedCueId) || null, [cues, selectedCueId]);
  const selectedSong = useMemo(() => songs.find(s => s.id === selectedSongId) || null, [songs, selectedSongId]);

  const isAdmin = user?.role === 'admin';
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
      override: null,
      effective: { position: o.defaultPosition, rotation: o.defaultRotation, scale: o.defaultScale, visible: true },
    }));
  }, [selectedCueId, cueStates, stageObjects]);

  // ── Actions ──
  async function changeStatus(status: Song['status']) {
    if (!selectedSong) return;
    const prev = songs;
    setSongs(prev.map(s => s.id === selectedSong.id ? { ...s, status } : s));
    try {
      await api.updateSong(projectId, selectedSong.id, { status });
    } catch (e) {
      setSongs(prev);
      toast.error('狀態更新失敗：' + msg(e));
    }
  }

  async function handleSubmitForReview(note: string) {
    if (!selectedSong || !user) return;

    // Pre-flight check：強制觸發 Drive 同步一次，然後檢查這首歌有沒有影片
    let hasVideo = false;
    try {
      toast.info('檢查 Drive 影片中…');
      // 先試強制同步（worker 端如果該 project 沒設 Drive 會 500，吞掉繼續）
      try { await api.syncDriveProject(projectId); } catch { /* 沒設 Drive 也 OK */ }
      const allFiles = await api.listDriveProjectFiles(projectId);
      hasVideo = allFiles.some(f => f.songId === selectedSong.id && (f.mimeType?.startsWith('video/')));
    } catch { /* 抓失敗就不擋 */ }

    if (!hasVideo) {
      const ok = confirm(
        `這首歌「${selectedSong.name}」目前還沒有影片在平台上。\n\n` +
        `導演看到的可能會是空的。\n\n` +
        `你確定要繼續提交嗎？\n\n` +
        `（如果你剛上傳到 Drive，可能需要再等 5 分鐘讓平台同步，或關掉這個視窗等一下再試）`
      );
      if (!ok) return;
    }

    if (note.trim()) {
      try {
        await api.postSongComment(projectId, selectedSong.id, {
          text: `[提交審查] ${note.trim()}`,
          author: user.name,
          role: 'animator',
        });
      } catch (e) {
        toast.warn('留言發送失敗（但會繼續變更狀態）：' + msg(e));
      }
    }
    await changeStatus('in_review');
    toast.success('已提交審查 ✓ 導演會收到通知');
  }

  /* ──────────── UI ──────────── */

  // 鍵盤：j/k 切歌、Shift+J/K 切 cue
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'j' && k !== 'k') return;
      e.preventDefault();
      if (e.shiftKey) {
        if (!masterCues.length) return;
        const idx = masterCues.findIndex(c => c.id === selectedCueId);
        const next = k === 'j'
          ? (idx < 0 ? 0 : Math.min(idx + 1, masterCues.length - 1))
          : (idx <= 0 ? 0 : idx - 1);
        setSelectedCueId(masterCues[next].id);
      } else {
        if (!visibleSongs.length) return;
        const idx = visibleSongs.findIndex(s => s.id === selectedSongId);
        const next = k === 'j'
          ? (idx < 0 ? 0 : Math.min(idx + 1, visibleSongs.length - 1))
          : (idx <= 0 ? 0 : idx - 1);
        setSelectedSongId(visibleSongs[next].id);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [masterCues, visibleSongs, selectedCueId, selectedSongId]);

  return (
    <div className="studio">
      <header className="studio-top">
        <button className="studio-top__back" onClick={() => navigate('/studio')} title="所有專案">←</button>
        <span className="studio-top__role">🎨 ANIMATOR</span>
        <span className="studio-top__project">{projectName || '…'}</span>
        <span className="grow" />
        {user && (
          <span className="studio-top__user">
            <span className="avatar avatar--sm" style={{ background: user.avatarColor }}>{user.name[0]}</span>
            <span>{user.name}</span>
            <button className="link-btn" onClick={async () => { await logout(); navigate('/login'); }}>登出</button>
          </span>
        )}
      </header>

      <div className="studio-body">
        <aside className="studio-songs">
          <div className="studio-songs__head">
            <div className="studio-songs__title">歌曲</div>
            {!isAdmin && (
              <div className="studio-songs__filter">
                <button
                  className={'tab' + (songFilter === 'mine' ? ' is-active' : '')}
                  onClick={() => setSongFilter('mine')}
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
              placeholder="🔍 搜尋歌名…"
            />
          </div>

          {songsLoading && <div className="studio-songs__empty">⏳ 載入中…</div>}
          {songsError && <div className="studio-songs__empty studio-songs__empty--err">{songsError}</div>}
          {!songsLoading && !songsError && visibleSongs.length === 0 && (
            <div className="studio-songs__empty">
              {songFilter === 'mine' ? '沒有指派給你的歌' : '這個專案沒有歌'}
            </div>
          )}

          <ul className="studio-songs__list">
            {visibleSongs.map(s => {
              const list = commentsBySong.get(s.id) || [];
              const unread = user ? songUnread(user.id, projectId, s.id, list, user.name) : 0;
              return (
                <li key={s.id}>
                  <button
                    className={'studio-songs__item' + (s.id === selectedSongId ? ' is-active' : '')}
                    onClick={() => setSelectedSongId(s.id)}
                  >
                    <span className={'status-dot status-dot--' + s.status} title={STATUS_LABEL[s.status]} />
                    <span className="studio-songs__item-name">{s.name}</span>
                    {unread > 0 && (
                      <span className="studio-songs__item-unread" title={`${unread} 則新留言`}>
                        💬{unread}
                      </span>
                    )}
                    <span className="studio-songs__item-count">{s.cueCount}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="studio-songs__hint">
            <kbd>J</kbd>/<kbd>K</kbd> 切歌 · <kbd>Shift</kbd>+<kbd>J</kbd>/<kbd>K</kbd> 切 cue
          </div>
        </aside>

        <main className="studio-stage">
          {selectedSong ? (
            <>
              <div className="studio-stage__scene">
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
                  defaultRenderMode="realistic"
                  enableNdi
                  crossfadeSeconds={selectedCue?.crossfadeSeconds ?? 0}
                  bookmarkScope={projectId}
                />
              </div>
              {masterCues.length > 0 && (
                <div className="studio-cuebar">
                  <span className="studio-cuebar__label">Cues</span>
                  <button
                    className="studio-cuebar__nav"
                    onClick={() => {
                      const idx = masterCues.findIndex(c => c.id === selectedCueId);
                      const next = idx <= 0 ? masterCues.length - 1 : idx - 1;
                      setSelectedCueId(masterCues[next].id);
                    }}
                    title="上一個 cue (Shift+K)"
                  >‹</button>
                  <div className="studio-cuebar__track">
                    {masterCues.map((c, i) => (
                      <button
                        key={c.id}
                        className={'studio-cuebar__cue' + (c.id === selectedCueId ? ' is-active' : '')}
                        onClick={() => setSelectedCueId(c.id)}
                        title={c.name}
                      >
                        <span className="studio-cuebar__num">{i + 1}</span>
                        <span className="studio-cuebar__name">{c.name}</span>
                      </button>
                    ))}
                  </div>
                  <button
                    className="studio-cuebar__nav"
                    onClick={() => {
                      const idx = masterCues.findIndex(c => c.id === selectedCueId);
                      const next = idx < 0 ? 0 : (idx + 1) % masterCues.length;
                      setSelectedCueId(masterCues[next].id);
                    }}
                    title="下一個 cue (Shift+J)"
                  >›</button>
                  <span className="studio-cuebar__hint">
                    {selectedCueId ? `${masterCues.findIndex(c => c.id === selectedCueId) + 1}/${masterCues.length}` : `0/${masterCues.length}`}
                  </span>
                </div>
              )}
            </>
          ) : (
            <div className="studio-stage__empty">
              <div className="studio-stage__empty-icon">🎤</div>
              <p>{visibleSongs.length === 0 ? '從左側挑一首歌開始' : '挑一首歌'}</p>
            </div>
          )}
        </main>

        <aside className="studio-right">
          <div className="studio-right__tabs">
            <button
              className={'tab' + (tab === 'cues' ? ' is-active' : '')}
              onClick={() => setTab('cues')}
            >Cues ({masterCues.length})</button>
            <button
              className={'tab' + (tab === 'review' ? ' is-active' : '')}
              onClick={() => setTab('review')}
            >審查 / 留言</button>
            <button
              className={'tab' + (tab === 'activity' ? ' is-active' : '')}
              onClick={() => setTab('activity')}
            >🕒 活動</button>
          </div>
          <div className="studio-right__body">
            {tab === 'cues' && (
              <CuesTab
                cues={masterCues}
                selectedCueId={selectedCueId}
                onSelectCue={setSelectedCueId}
                emptyHint={selectedSong ? '這首歌還沒有 cue，請聯絡製作主管' : '先挑一首歌'}
              />
            )}
            {tab === 'review' && selectedSong && user && (
              <ReviewTab
                projectId={projectId}
                song={selectedSong}
                user={user}
                onChangeStatus={changeStatus}
                onSubmitForReview={handleSubmitForReview}
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
    </div>
  );
}

/* ──────────── Cues Tab ──────────── */

function CuesTab({
  cues, selectedCueId, onSelectCue, emptyHint,
}: {
  cues: Cue[];
  selectedCueId: string | null;
  onSelectCue: (id: string) => void;
  emptyHint: string;
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
            <span className="studio-cues__name">{c.name}</span>
            {c.crossfadeSeconds > 0 && (
              <span className="studio-cues__cross">⤴ {c.crossfadeSeconds}s</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ──────────── Review Tab ──────────── */

function ReviewTab({
  projectId, song, user, onChangeStatus, onSubmitForReview,
}: {
  projectId: string;
  song: Song;
  user: { id: string; name: string; role: api.UserRole; avatarColor: string };
  onChangeStatus: (status: Song['status']) => Promise<void>;
  onSubmitForReview: (note: string) => Promise<void>;
}) {
  const [comments, setComments] = useState<SongComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [posting, setPosting] = useState(false);
  const isAnimator = user.role === 'animator';

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.listSongComments(projectId, song.id);
      setComments(list);
    } catch (e) {
      console.warn('load comments failed', e);
    } finally {
      setLoading(false);
    }
  }, [projectId, song.id]);

  useEffect(() => { refresh(); }, [refresh]);

  // 切歌時清空 note
  const lastSongIdRef = useRef(song.id);
  useEffect(() => {
    if (lastSongIdRef.current !== song.id) {
      setNote('');
      lastSongIdRef.current = song.id;
    }
  }, [song.id]);

  async function handlePost() {
    const text = note.trim();
    if (!text) return;
    setPosting(true);
    try {
      const updated = await api.postSongComment(projectId, song.id, {
        text,
        author: user.name,
        role: isAnimator ? 'animator' : (user.role === 'director' ? 'director' : 'designer'),
      });
      setComments(updated);
      setNote('');
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
      setComments(updated);
    } catch (e) { toast.error('刪除失敗：' + msg(e)); }
  }

  async function handleSubmit() {
    if (!confirm(`把「${song.name}」狀態改為「審查中」？\n\n留言會一起送出。`)) return;
    setPosting(true);
    try {
      await onSubmitForReview(note);
      setNote('');
      await refresh();
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="studio-review">
      <section className="studio-review__status">
        <div className="studio-review__status-label">目前狀態</div>
        <div className={'status-pill status-pill--' + song.status}>{STATUS_LABEL[song.status]}</div>

        <div className="studio-review__actions">
          {song.status === 'todo' && (
            <button className="btn btn--primary" onClick={handleSubmit} disabled={posting}>
              提交審查 →
            </button>
          )}
          {song.status === 'needs_changes' && (
            <button className="btn btn--primary" onClick={handleSubmit} disabled={posting}>
              修改完成 → 重新提交
            </button>
          )}
          {song.status === 'in_review' && (
            <button className="btn btn--ghost" onClick={() => onChangeStatus('todo')}>
              撤回（改回待製作）
            </button>
          )}
          {song.status === 'approved' && (
            <span className="studio-review__hint">這首歌已通過 ✓</span>
          )}
        </div>
      </section>

      <section className="studio-review__notes">
        <div className="studio-review__notes-head">
          <span>留言／備註</span>
          <button className="link-btn" onClick={refresh}>重新整理</button>
        </div>

        <div className="studio-review__compose">
          <textarea
            placeholder={song.status === 'todo' || song.status === 'needs_changes'
              ? '寫一段給導演 / 製作主管的話，按「提交審查」會一起送出'
              : '在這裡留言（給協作者看）'}
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={3}
          />
          <div className="studio-review__compose-actions">
            <button className="btn btn--ghost" onClick={handlePost} disabled={posting || !note.trim()}>
              送出留言
            </button>
          </div>
        </div>

        {loading ? (
          <div className="studio-review__loading">載入中…</div>
        ) : comments.length === 0 ? (
          <div className="studio-review__empty">還沒有留言</div>
        ) : (
          <ul className="studio-review__list">
            {[...comments].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(c => (
              <li key={c.id} className={'studio-comment studio-comment--' + c.role}>
                <div className="studio-comment__head">
                  <span className="studio-comment__author">{c.author}</span>
                  <span className="studio-comment__role">{roleLabel(c.role)}</span>
                  <span className="studio-comment__time">{formatTime(c.createdAt)}</span>
                  {c.author === user.name && (
                    <button className="studio-comment__del" onClick={() => handleDelete(c.id)} title="刪除">×</button>
                  )}
                </div>
                <div className="studio-comment__text">{c.text}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
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

/* ──────────── Activity feed (read-only viewer) ──────────── */

function ActivityList({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.listActivity(projectId, 30)
      .then(setItems)
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  if (error) return <div className="studio-right__empty">載入失敗：{error}</div>;
  if (items === null) return <div className="studio-right__empty">載入中…</div>;
  if (items.length === 0) return <div className="studio-right__empty">這個專案還沒有活動記錄</div>;

  return (
    <div className="activity-list">
      <div className="activity-list__head">
        <span>最近 {items.length} 筆</span>
        <button className="link-btn" onClick={refresh}>↻</button>
      </div>
      <ul>
        {items.map(a => (
          <li key={a.id} className="activity-list__row">
            <span className="avatar avatar--sm" style={{ background: a.userAvatar }} title={a.userName}>{a.userName[0]}</span>
            <div className="activity-list__body">
              <div className="activity-list__line">
                <strong>{a.userName}</strong> {actionLabel(a.action)} {targetLabel(a.targetType)}
                {(a.payload?.name as string) && <span className="muted small"> · {a.payload.name as string}</span>}
              </div>
              <div className="activity-list__time">{formatRelativeShort(a.createdAt)}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function actionLabel(action: string): string {
  return ({
    create: '建立', update: '改了', delete: '刪了', reorder: '重排',
    reset: '重置', activate: '啟用', archive: '封存', upload: '上傳',
    bulk_create: '批次建', seed: '初始化',
  } as Record<string, string>)[action] || action;
}
function targetLabel(t: string): string {
  return ({
    project: '專案', song: '歌曲', cue: 'cue', cue_state: 'cue 狀態',
    stage_object: '物件', model: '模型', drive_file: 'Drive 檔',
  } as Record<string, string>)[t] || t;
}
function formatRelativeShort(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return '剛剛';
    if (diff < 3600) return Math.floor(diff / 60) + 'm';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h';
    return d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' });
  } catch { return iso; }
}
