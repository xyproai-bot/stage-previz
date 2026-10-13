import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { ActivityEntry, Cue, CueState, Song, SongComment, StageObject } from '../lib/api';
import type { ProjectMember, ProjectRole } from '../lib/mockData';
import { useAuth } from '../lib/auth';
import StageScene from '../components/StageScene';
import { toast } from '../lib/toast';
import { markSeen, songUnread } from '../lib/unreadComments';
import { useProjectViewSettings } from '../lib/projectViewSettings';
import { cueTransitionSeconds } from '../lib/cueTiming';
import { helpUrl } from '../lib/helpLinks';
import { usePersonalLook } from '../lib/stageLook/personalLook';
import { useLiveRefresh } from '../lib/liveRefresh';
import { extractMentions } from '../lib/mentions';
import { formatRelativeTime } from '../lib/serverTime';
import {
  SONG_STATUS_LABEL as STATUS_LABEL, songStatusActions, songActionsHint, staleStatusMessage,
  friendlyError, projectGoneMessage, canModifyComment, sameSongs, sameComments, newCommentsFromOthers,
} from '../lib/songReview';
import './Studio.css';

type Tab = 'cues' | 'review' | 'activity';
type SongFilter = 'mine' | 'all';

export default function Studio() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  // 沒有專案 id 的 /studio 由「我的專案」頁處理（App 路由），這裡不會走到
  if (!projectId) return null;
  if (authLoading) return <div className="studio-loading">⏳ 載入中…</div>;
  if (!user) {
    navigate('/login', { replace: true });
    return null;
  }

  // key：換專案時整個重來（不會把上一個專案的歌 / 留言帶過來）
  return <StudioInner key={projectId} projectId={projectId} />;
}

/* ──────────── Studio Inner（projectId 存在時） ──────────── */

function StudioInner({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  // 校準倍率 + 機關滑桿位移（admin 在管理頁設的，動畫師這邊只看）
  const view = useProjectViewSettings(projectId, user?.role === 'admin');
  // 現場設定：專案預設 + 自己調過的（存在這台電腦）
  const personalLook = usePersonalLook(projectId, view.lookSettings);

  const [projectName, setProjectName] = useState<string>('');
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

  const projectRole: ProjectRole | null = myRole === undefined ? (user?.role ?? null) : myRole;
  // 動畫師只看：3D 工具列只剩重置攝影機、燈光照專案預設（不能自己調）
  const isAnimatorViewer = projectRole === 'animator';

  const [songFilter, setSongFilter] = useState<SongFilter>(() => {
    try { return (localStorage.getItem('sp_studio_filter') as SongFilter) || 'mine'; } catch { return 'mine'; }
  });
  useEffect(() => { try { localStorage.setItem('sp_studio_filter', songFilter); } catch {} }, [songFilter]);
  const [songSearch, setSongSearch] = useState('');

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
      toast.warn(`你正在看的「${was.name}」已經被刪除了（可能是製作主管剛刪的），畫面已更新`);
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

  // 抓每首歌的留言（4 個一起抓）。notify = 有別人的新留言就跳提示（第一次載入不跳）
  const fetchAllComments = useCallback(async (list: Song[], notify: boolean) => {
    const results = new Map<string, SongComment[]>();
    const queue = [...list];
    const work = async () => {
      while (queue.length > 0) {
        const s = queue.shift();
        if (!s) return;
        try { results.set(s.id, await api.listSongComments(projectId, s.id)); }
        catch { /* 這首抓不到就沿用上次的 */ }
      }
    };
    await Promise.all([work(), work(), work(), work()]);

    const current = commentsRef.current;  // 等待期間自己留言 / 刪除過的話，以最新的為準
    const next = new Map<string, SongComment[]>();
    let changed = false;
    for (const s of list) {
      const old = current.get(s.id);
      const got = results.get(s.id);
      if (!got || sameComments(old, got)) {
        if (old) next.set(s.id, old);
        continue;
      }
      changed = true;
      next.set(s.id, got);
      if (notify) {
        const fresh = newCommentsFromOthers(old, got, user);
        if (fresh.length > 0) {
          const c = fresh[fresh.length - 1];
          const more = fresh.length > 1 ? `（共 ${fresh.length} 則新留言）` : '';
          toast.info(`${s.name}：${c.author} 留言「${c.text.slice(0, 40)}${c.text.length > 40 ? '…' : ''}」${more}`);
        }
      }
    }
    if (!changed && next.size === current.size) return;
    commentsRef.current = next;
    setCommentsBySong(next);
  }, [projectId, user]);

  // 專案名 + 我的角色 + 成員
  const loadMeta = useCallback(async () => {
    try {
      const meta = await api.getProjectMeta(projectId);
      if (meta) {
        setProjectName(meta.name);
        setMyRole(meta.myRole ?? null);
        setMembers(meta.members || []);
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
      void fetchAllComments(list, false);
    } catch (e) {
      const gone = projectGoneMessage(e);
      if (gone) setGoneMessage(gone);
      else setSongsError('歌曲讀取失敗：' + friendlyError(e));
    } finally {
      setSongsLoading(false);
    }
    await metaDone;
  }, [projectId, loadMeta, applySongs, fetchAllComments]);

  useEffect(() => { refreshAll(); }, [refreshAll]);

  // 自動更新：每 25 秒 + 切回分頁時，重抓歌曲狀態 + 留言（導演改了狀態 / 留了言，這邊 30 秒內看得到）
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
    if (goneRef.current) return;
    const list = await reloadSongs();
    // 歌單這次沒讀到（網路一時不穩）也照樣更新留言；專案不見了就不用了
    if (!goneRef.current) await fetchAllComments(list ?? songsRef.current, true);
  }, { enabled: !goneMessage && !songsLoading });

  // 審查分頁開著時，看到的留言算已讀（在 cue 分頁時新留言要留著未讀數字）
  useEffect(() => {
    if (!user || !selectedSongId || tab !== 'review') return;
    const list = commentsBySong.get(selectedSongId);
    if (!list || list.length === 0) return;
    const latest = list.reduce((acc, c) => c.createdAt > acc ? c.createdAt : acc, '');
    markSeen(user.id, projectId, selectedSongId, latest);
  }, [user, projectId, selectedSongId, commentsBySong, tab]);

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

  const selectedComments = selectedSongId ? commentsBySong.get(selectedSongId) : undefined;
  const selectedUnread = user && selectedSongId && selectedComments
    ? songUnread(user.id, projectId, selectedSongId, selectedComments, user)
    : 0;

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
  async function handleSubmitForReview(song: Song, note: string): Promise<boolean> {
    if (!user) return false;

    // Pre-flight check：強制觸發 Drive 同步一次，然後檢查這首歌有沒有影片
    let hasVideo = false;
    try {
      toast.info('檢查 Drive 影片中…');
      // 先試強制同步（worker 端如果該 project 沒設 Drive 會 500，吞掉繼續）
      try { await api.syncDriveProject(projectId); } catch { /* 沒設 Drive 也 OK */ }
      const allFiles = await api.listDriveProjectFiles(projectId);
      hasVideo = allFiles.some(f => f.songId === song.id && (f.mimeType?.startsWith('video/')));
    } catch { /* 抓失敗就不擋 */ }

    if (!hasVideo) {
      const ok = confirm(
        `這首歌「${song.name}」目前還沒有影片在平台上。\n\n` +
        `導演看到的可能會是空的。\n\n` +
        `你確定要繼續提交嗎？\n\n` +
        `（如果你剛上傳到 Drive，可能需要再等 5 分鐘讓平台同步，或關掉這個視窗等一下再試）`
      );
      if (!ok) return false;
    }

    // 先改狀態（被導演搶先改掉的話，就不要送出「提交審查」的留言）
    const ok = await changeStatus(song, 'in_review');
    if (!ok) return false;

    if (note.trim()) {
      const text = `[提交審查] ${note.trim()}`;
      try {
        const updated = await api.postSongComment(projectId, song.id, { text, mentions: extractMentions(text, members) });
        setSongComments(song.id, updated);
      } catch (e) {
        toast.warn('已提交審查，但附的那段話沒送出去：' + friendlyError(e));
        return true;
      }
    }
    // 目前沒有站內通知 → 不要說「導演會收到通知」
    toast.success('已提交審查。導演的畫面 30 秒內會自動更新（目前不會另外通知導演，急的話請直接跟導演說）', 7000);
    return true;
  }

  async function refreshSongComments(songId: string) {
    try { setSongComments(songId, await api.listSongComments(projectId, songId)); }
    catch (e) { toast.error('留言讀取失敗：' + friendlyError(e)); }
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

  const topBar = (
    <header className="studio-top">
      <button className="studio-top__back" onClick={() => navigate('/studio')} title="所有專案">←</button>
      <span className="studio-top__role">🎨 ANIMATOR</span>
      <span className="studio-top__project">
        {projectName || (nameStatus === 'error' && !goneMessage ? (
          <>
            {projectId}（讀取失敗）
            <button className="btn btn--ghost" onClick={() => refreshAll()} style={{ marginLeft: 8, padding: '3px 10px', fontSize: 12 }}>重試</button>
          </>
        ) : goneMessage ? '' : '…')}
        {projectArchived && <span className="studio-top__archived">已封存，只能看</span>}
      </span>
      <span className="grow" />
      {/* 開新分頁：舞台、AE 即時連線都不會不見 */}
      <a className="studio-top__help" href={helpUrl()} target="_blank" rel="noopener">📖 使用說明</a>
      {/* 設定頁有 NDI / AE 連線檢查 */}
      <Link className="studio-top__help" to="/settings">設定</Link>
      {user && (
        <span className="studio-top__user">
          <span className="avatar avatar--sm" style={{ background: user.avatarColor }}>{user.name[0]}</span>
          <span>{user.name}</span>
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
                    ? <>還沒有指派給你的歌（製作主管會在編輯器指派）。<br />可以先按「全部」看所有歌。</>
                    : '這個專案還沒有歌')
                  : '這個專案還沒有歌'}
            </div>
          )}

          <ul className="studio-songs__list">
            {visibleSongs.map(s => {
              const list = commentsBySong.get(s.id) || [];
              const unread = user ? songUnread(user.id, projectId, s.id, list, user) : 0;
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
                        <CommentIcon />{unread}
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
                  defaultRenderMode="live"
                  enableNdi
                  ndiGuide
                  cueKey={selectedCueId}
                  crossfadeSeconds={cueTransitionSeconds(selectedCue)}
                  bookmarkScope={projectId}
                  scaleCorrection={view.scaleCorrection}
                  onScaleCorrectionChange={view.canEdit ? view.setScaleCorrection : undefined}
                  mechanismOffsets={view.mechanismOffsets}
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
              title={selectedUnread > 0 ? `${selectedUnread} 則新留言` : undefined}
            >
              審查 / 留言
              {selectedUnread > 0 && tab !== 'review' && <span className="studio-right__tab-badge">{selectedUnread}</span>}
            </button>
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
                emptyHint={
                  !selectedSong ? '先挑一首歌'
                  : cuesStatus === 'loading' ? '⏳ 載入 cue 中…'
                  : cuesStatus === 'error' ? (
                    <>
                      <div>⚠️ cue 載入失敗</div>
                      <button className="btn btn--ghost" onClick={() => setCuesReloadKey(k => k + 1)} style={{ marginTop: 8 }}>重試</button>
                    </>
                  )
                  : '這首歌還沒有 cue，請聯絡製作主管'
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
                onSubmitForReview={(note) => handleSubmitForReview(selectedSong, note)}
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
  projectId, song, user, projectRole, members, comments, onCommentsChange, onRefreshComments,
  onChangeStatus, onSubmitForReview,
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
  onSubmitForReview: (note: string) => Promise<boolean>;
}) {
  const [note, setNote] = useState('');
  const [posting, setPosting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  const actions = songStatusActions({ role: projectRole, userId: user.id, song, flow: 'animator' });
  const hint = actions.length === 0 ? songActionsHint({ role: projectRole, userId: user.id, song, flow: 'animator' }) : null;
  const canSubmit = actions.some(a => a.to === 'in_review');

  // 切歌時清空 note / 編輯中的留言
  const lastSongIdRef = useRef(song.id);
  useEffect(() => {
    if (lastSongIdRef.current !== song.id) {
      setNote('');
      setEditingId(null);
      lastSongIdRef.current = song.id;
    }
  }, [song.id]);

  async function handlePost() {
    const text = note.trim();
    if (!text) return;
    setPosting(true);
    try {
      const updated = await api.postSongComment(projectId, song.id, { text, mentions: extractMentions(text, members) });
      onCommentsChange(updated);
      setNote('');
    } catch (e) {
      toast.error('留言失敗：' + friendlyError(e));
    } finally {
      setPosting(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('刪除這則留言？')) return;
    try {
      onCommentsChange(await api.deleteSongComment(projectId, song.id, id));
    } catch (e) { toast.error('刪除失敗：' + friendlyError(e)); }
  }

  async function handleSaveEdit(id: string) {
    const text = editText.trim();
    if (!text) return;
    try {
      onCommentsChange(await api.patchSongComment(projectId, song.id, id, { text }));
      setEditingId(null);
    } catch (e) { toast.error('修改失敗：' + friendlyError(e)); }
  }

  async function handleAction(to: Song['status']) {
    setPosting(true);
    try {
      if (to === 'in_review') {
        if (!confirm(`把「${song.name}」狀態改為「審查中」？\n\n留言框裡的話會一起送出。`)) return;
        const ok = await onSubmitForReview(note);
        if (ok) setNote('');
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

  return (
    <div className="studio-review">
      <section className="studio-review__status">
        <div className="studio-review__status-label">目前狀態</div>
        <div className={'status-pill status-pill--' + song.status}>{STATUS_LABEL[song.status]}</div>

        <div className="studio-review__actions">
          {actions.map(a => (
            <button
              key={a.kind}
              className={'btn ' + (a.primary ? 'btn--primary' : 'btn--ghost')}
              onClick={() => handleAction(a.to)}
              disabled={posting}
            >
              {a.label}
            </button>
          ))}
          {hint && <span className="studio-review__hint">{hint}</span>}
        </div>
      </section>

      <section className="studio-review__notes">
        <div className="studio-review__notes-head">
          <span>留言／備註</span>
          <button className="link-btn" onClick={handleRefresh} disabled={refreshing}>{refreshing ? '更新中…' : '重新整理'}</button>
        </div>

        <div className="studio-review__compose">
          <textarea
            placeholder={canSubmit
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

        {comments === undefined ? (
          <div className="studio-review__loading">載入中…</div>
        ) : comments.length === 0 ? (
          <div className="studio-review__empty">還沒有留言</div>
        ) : (
          <ul className="studio-review__list">
            {[...comments].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(c => {
              const canModify = canModifyComment(c, user, projectRole);
              const editing = editingId === c.id;
              return (
                <li key={c.id} className={'studio-comment studio-comment--' + c.role}>
                  <div className="studio-comment__head">
                    <span className="studio-comment__author">{c.author}</span>
                    <span className="studio-comment__role">{roleLabel(c.role)}</span>
                    <span className="studio-comment__time">{formatRelativeTime(c.createdAt)}</span>
                    {canModify && !editing && (
                      <>
                        <button
                          className="studio-comment__del studio-comment__edit"
                          onClick={() => { setEditingId(c.id); setEditText(c.text); }}
                          title="修改"
                        >修改</button>
                        <button className="studio-comment__del" onClick={() => handleDelete(c.id)} title="刪除">×</button>
                      </>
                    )}
                  </div>
                  {editing ? (
                    <div className="studio-comment__editbox">
                      <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={3} autoFocus />
                      <div className="studio-review__compose-actions">
                        <button className="btn btn--ghost" onClick={() => setEditingId(null)}>取消</button>
                        <button className="btn btn--primary" onClick={() => handleSaveEdit(c.id)} disabled={!editText.trim()}>儲存</button>
                      </div>
                    </div>
                  ) : (
                    <div className="studio-comment__text">{c.text}</div>
                  )}
                </li>
              );
            })}
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
              {/* 後台時間是 UTC、沒寫時區 → 用 serverTime 轉成本地時間（以前會差 8 小時） */}
              <div className="activity-list__time">{formatRelativeTime(a.createdAt)}</div>
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
