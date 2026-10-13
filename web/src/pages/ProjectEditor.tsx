import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { Song, Cue, CueState, StageObject, StageObjectCategory, MaterialProps, LedProps } from '../lib/api';
import { useAuth } from '../lib/auth';
import StageScene from '../components/StageScene';
import MechanismTab from '../components/mechanisms/MechanismTab';
import MechanismObjectHint, { MechanismHintProvider } from '../components/mechanisms/MechanismObjectHint';
import { useEditorMechanisms } from '../lib/mechanisms/useMechanisms';
import { withMechanismSnapshot } from '../lib/mechanisms/mechanismApi';
import { valuesOf } from '../lib/mechanisms/track';
import UploadModelDialog from '../components/UploadModelDialog';
import ModelVersionsDialog from '../components/ModelVersionsDialog';
import AssetPickerDialog from '../components/AssetPickerDialog';
import ActivityDrawer from '../components/ActivityDrawer';
import DriveSettingsDialog from '../components/DriveSettingsDialog';
import CueStoryboard from '../components/CueStoryboard';
import SaveIndicator from '../components/SaveIndicator';
import CueDiffDialog from '../components/CueDiffDialog';
import ImportCuesDialog from '../components/ImportCuesDialog';
import ShareLinksDialog from '../components/ShareLinksDialog';
import InviteDialog from '../components/InviteDialog';
import CommentSearchDialog from '../components/CommentSearchDialog';
import NotificationBell from '../components/NotificationBell';
import DecisionDialog from '../components/DecisionDialog';
import { decisionNotifyHint, newVersionLabel } from '../lib/reviewHistory';
import { pushRecentProject } from '../components/CommandPalette';
import { useProjectViewSettings } from '../lib/projectViewSettings';
import { usePersonalLook } from '../lib/stageLook/personalLook';
import { cueTransitionSeconds, crossfadeLabel, NEW_CUE_CROSSFADE_SECONDS, parseCrossfadeInput, parseVideoTimeInput } from '../lib/cueTiming';
import { EditHistory, historyScope } from '../lib/editHistory';
import { applyCueStatePatch, cueStateRestorePlan, overridePatch, type CueStateField, type CueStatePatch } from '../lib/cueStateUndo';
import { formatFieldNumber, metersToScene, parseNumberInput, sameAsShown, sceneToMeters, stepNumberInput } from '../lib/numberField';
import { toast } from '../lib/toast';
import { chooseDialog, confirmDialog, promptDialog } from '../components/dialogs';
import { friendlyError, staleStatusMessage } from '../lib/songReview';
import type { ProjectMember } from '../lib/mockData';
import { SONG_STATUS_LABEL } from '../lib/songReview';
import SongCodeField from '../components/SongCodeField';
import AddVideoDialog from '../components/AddVideoDialog';
import { isJobActive, jobStatusText, useVideoJobDone, useVideoJobs, useWarnBeforeUnloadWhileUploading, type VideoJob } from '../lib/videoJobs';
import { songTitle } from '../lib/songCode';
import Icon from '../components/Icon';
import { STAGE_CATEGORY } from '../components/stageCategories';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bookmark, BookmarkPlus, Camera, Check, ChevronDown, Clapperboard, Cloud, Columns2,
  Copy, Eye, EyeOff, HistoryIcon, Import, LayoutGrid, Library, Lightbulb, Link, Lock, LockOpen, MousePointerClick, Music,
  Palette, Pencil, Plus, Redo2, RotateCcw, Search, Shapes, Sprout, Trash2, Undo2, Upload, UserPlus, X,
} from 'lucide-react';
import './ProjectEditor.css';

type RightTab = 'cues' | 'state' | 'mechanisms' | 'proposals' | 'objects';
type LoadStatus = 'loading' | 'ready' | 'error';
/**
 * 改物件狀態：直接給要改的欄位，或給「從現在的樣子算出要改什麼」
 * （排隊輪到時才算 → 連續改 X、Y 不會互相蓋掉還沒存完的值）
 */
type StatePatchInput = CueStatePatch | ((current: CueState['effective']) => CueStatePatch);
type SongStatus = Song['status'];
type StatusFilter = SongStatus | 'all';

const CATEGORY_INFO = STAGE_CATEGORY;

const STATUS_INFO: Record<SongStatus, { label: string; mod: string }> = {
  todo:          { label: SONG_STATUS_LABEL.todo,          mod: 'todo' },
  in_review:     { label: SONG_STATUS_LABEL.in_review,     mod: 'review' },
  approved:      { label: SONG_STATUS_LABEL.approved,      mod: 'approved' },
  needs_changes: { label: SONG_STATUS_LABEL.needs_changes, mod: 'changes' },
};
/** 審片流程的順序：待製作 → 審查中 → 需修改 → 已通過 */
const STATUS_ORDER: SongStatus[] = ['todo', 'in_review', 'needs_changes', 'approved'];

export default function ProjectEditor() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();

  // Songs
  const [songs, setSongs] = useState<Song[]>([]);
  const [songsLoading, setSongsLoading] = useState(true);
  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // 「我改過的」filter — 用 activity log 算出當前用戶有動過的 song id
  const [mineOnly, setMineOnly] = useState(false);
  const [mineSongIds, setMineSongIds] = useState<Set<string>>(new Set());
  // 專案成員（「負責動畫師」選單只列這個專案裡角色是動畫師的人）
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api.getProjectMeta(projectId)
      .then(p => { if (!cancelled) setProjectMembers(p?.members || []); })
      .catch(() => { /* 讀不到就只顯示「還沒指派」 */ });
    return () => { cancelled = true; };
  }, [projectId]);
  const animatorMembers = useMemo(() => projectMembers.filter(m => m.role === 'animator'), [projectMembers]);

  // Cues
  const [cues, setCues] = useState<Cue[]>([]);
  const [cuesLoading, setCuesLoading] = useState(false);
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);

  // Stage objects (project-level)
  const [stageObjects, setStageObjectsState] = useState<StageObject[]>([]);
  // 第一次讀到之前是 loading：不要先跳「這個專案還沒有物件」
  const [stageObjectsStatus, setStageObjectsStatus] = useState<LoadStatus>('loading');
  // ref 跟 state 一起更新：排隊中的修改要拿最新的值，不能等畫面重畫
  const stageObjectsRef = useRef<StageObject[]>([]);
  const commitStageObjects = useCallback((list: StageObject[]) => {
    stageObjectsRef.current = list;
    setStageObjectsState(list);
  }, []);

  // 3D 模型檔案（R2）
  const [modelUrl, setModelUrl] = useState<string | null>(null);

  // Cue object states (per selected cue)
  const [cueStates, setCueStatesState] = useState<CueState[]>([]);
  // 這份 cueStates 是哪個 cue 的：換 cue 後新的還沒讀到前，不能拿上一個 cue 的來編輯
  const [cueStatesFor, setCueStatesFor] = useState<string | null>(null);
  const [statesError, setStatesError] = useState(false);
  const cueStatesRef = useRef<CueState[]>([]);
  const cueStatesForRef = useRef<string | null>(null);
  const commitCueStates = useCallback((cueId: string | null, list: CueState[]) => {
    cueStatesRef.current = list;
    cueStatesForRef.current = cueId;
    setCueStatesState(list);
    setCueStatesFor(cueId);
  }, []);
  const statesLoading = !!selectedCueId && cueStatesFor !== selectedCueId && !statesError;

  // Selected objects (multi-select supported — viewport 點選預設單選，下方清單可勾多個)
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([]);
  // 單選兼容：給 viewport 點選用（清空之前選的）
  const selectSingle = useCallback((id: string | null) => {
    setSelectedObjectIds(id ? [id] : []);
  }, []);
  // 加減選（checkbox / Shift+click 用）
  const toggleSelected = useCallback((id: string) => {
    setSelectedObjectIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }, []);

  // 機關 offset（per LED panel，公尺）+ 測距校準倍率 — 存在專案上，所有人共用，admin 才能改
  const view = useProjectViewSettings(projectId, user?.role === 'admin');
  // 現場設定：專案預設 + 自己調過的（存在這台電腦）
  const personalLook = usePersonalLook(projectId, view.lookSettings);

  const [rightTab, setRightTab] = useState<RightTab>('cues');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);
  const [storyboardOpen, setStoryboardOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // 邀請連結（幫這個專案加導演 / 動畫師）
  const [inviteOpen, setInviteOpen] = useState(false);
  const [commentSearchOpen, setCommentSearchOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [importCuesOpen, setImportCuesOpen] = useState(false);
  // 狀態選單選「需修改」→ 先寫原因
  const [decisionSongId, setDecisionSongId] = useState<string | null>(null);
  const [projectMeta, setProjectMeta] = useState<api.ProjectFull | null>(null);
  const [projectMetaFailed, setProjectMetaFailed] = useState(false);
  const refreshProjectMeta = useCallback(async () => {
    if (!projectId) return;
    try {
      const p = await api.getProjectFull(projectId);
      setProjectMeta(p);
      setProjectMetaFailed(!p); // 404 會回 null，也算載不到
    } catch (e) {
      console.warn('load project meta failed', e);
      setProjectMetaFailed(true);
    }
  }, [projectId]);
  useEffect(() => { refreshProjectMeta(); }, [refreshProjectMeta]);

  // ── 復原 / 重做：每個 cue 各一份（lib/editHistory.ts），換 cue 不會復原到別的 cue ──
  const historyRef = useRef(new EditHistory());
  const [, setHistoryVersion] = useState(0);
  const bumpHistory = useCallback(() => setHistoryVersion(v => v + 1), []);
  // 機關（右邊「機關」分頁）：每個 cue 的機關位置、定義、速度檢查；改了也記在同一份復原
  const mech = useEditorMechanisms({
    projectId, songId: selectedSongId, cues, selectedCueId, canEdit: true,
    history: { push: (scope, step) => historyRef.current.push(scope, step), bump: bumpHistory },
  });
  const currentHistoryScope = historyScope(selectedCueId);
  const historyScopeRef = useRef(currentHistoryScope);
  historyScopeRef.current = currentHistoryScope;
  const historyCounts = historyRef.current.counts(currentHistoryScope);

  // 改物件位置 / 顯示、復原、重做都排隊一個一個做：每一步都拿得到前一步存好的值（復原才記得對），
  // 全部做完才重新讀一次（多選拖曳時物件不會一個一個跳回舊位置再跳過來）
  const editQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingEditsRef = useRef(0);
  const refreshNeededRef = useRef({ states: false, objects: false });
  const refreshCueStatesRef = useRef<() => Promise<void>>(async () => {});
  const refreshStageObjectsRef = useRef<() => Promise<void>>(async () => {});
  const runEdit = useCallback(<T,>(job: () => Promise<T>, refresh: 'states' | 'objects'): Promise<T> => {
    pendingEditsRef.current++;
    const run = editQueueRef.current.then(async () => {
      try {
        return await job();
      } finally {
        refreshNeededRef.current[refresh] = true;
        pendingEditsRef.current--;
        if (pendingEditsRef.current === 0) {
          const need = refreshNeededRef.current;
          refreshNeededRef.current = { states: false, objects: false };
          if (need.objects) await refreshStageObjectsRef.current();
          if (need.states) await refreshCueStatesRef.current();
        }
      }
    });
    editQueueRef.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);
  const runHistory = useCallback((kind: 'undo' | 'redo') => {
    const scope = historyScopeRef.current;
    const history = historyRef.current;
    if (history.counts(scope)[kind] === 0) return;
    runEdit(async () => {
      // 排隊輪到時已經換到別的 cue → 不做（只復原 / 重做現在選的 cue）
      if (historyScopeRef.current !== scope) return;
      await history[kind](scope);
    }, scope === historyScope(null) ? 'objects' : 'states')
      .catch(e => { console.warn(kind + ' failed', e); toast.error((kind === 'undo' ? '復原' : '重做') + '失敗：' + msg(e)); })
      .finally(bumpHistory);
  }, [runEdit, bumpHistory]);

  // 把最新值放進 ref，給 keyboard listener 用（避免 useEffect 因 derived value 變化重綁）
  const navRef = useRef({ masterCues: [] as Cue[], visibleSongs: [] as Song[], selectedCueId: null as string | null, selectedSongId: null as string | null });
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

      // Cmd/Ctrl+Z = 復原；Cmd/Ctrl+Shift+Z 或 Ctrl+Y = 重做（在欄位裡打字時交給瀏覽器自己的復原）
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const key = e.key.toLowerCase();
        const isUndo = key === 'z' && !e.shiftKey;
        const isRedo = (key === 'z' && e.shiftKey) || (key === 'y' && !e.shiftKey);
        if (isUndo || isRedo) {
          if (inField) return;
          e.preventDefault();
          runHistory(isUndo ? 'undo' : 'redo');
          return;
        }
      }

      // j/k = 切歌；Shift+J/K = 切 cue
      if (inField || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'j' && k !== 'k') return;
      e.preventDefault();
      const { masterCues: cs, visibleSongs: ss, selectedCueId: cid, selectedSongId: sid } = navRef.current;
      if (e.shiftKey) {
        if (cs.length === 0) return;
        const curIdx = cs.findIndex(c => c.id === cid);
        const nextIdx = k === 'j'
          ? (curIdx < 0 ? 0 : Math.min(curIdx + 1, cs.length - 1))
          : (curIdx <= 0 ? 0 : curIdx - 1);
        setSelectedCueId(cs[nextIdx].id);
        setRightTab(t => (t === 'mechanisms' ? t : 'state'));
      } else {
        if (ss.length === 0) return;
        const curIdx = ss.findIndex(s => s.id === sid);
        const nextIdx = k === 'j'
          ? (curIdx < 0 ? 0 : Math.min(curIdx + 1, ss.length - 1))
          : (curIdx <= 0 ? 0 : curIdx - 1);
        setSelectedSongId(ss[nextIdx].id);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runHistory]);

  // ── Loaders ──
  const refreshSongs = useCallback(async () => {
    if (!projectId) return;
    setSongsLoading(true);
    try {
      const list = await api.listSongs(projectId);
      setSongs(list);
      setSelectedSongId(prev => prev || (list[0]?.id ?? null));
    } catch (e) {
      toast.error('歌單讀不到：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSongsLoading(false);
    }
  }, [projectId]);

  const refreshCues = useCallback(async () => {
    if (!projectId || !selectedSongId) { setCues([]); setSelectedCueId(null); return; }
    setCuesLoading(true);
    try {
      const list = await api.listCues(projectId, selectedSongId);
      setCues(list);
      setSelectedCueId(prev => list.find(c => c.id === prev) ? prev : (list[0]?.id ?? null));
    } finally {
      setCuesLoading(false);
    }
  }, [projectId, selectedSongId]);

  const refreshStageObjects = useCallback(async () => {
    if (!projectId) return;
    try {
      const list = await api.listStageObjects(projectId);
      commitStageObjects(list);
      setStageObjectsStatus('ready');
    } catch (e) {
      console.warn('load stage objects failed', e);
      // 已經讀到過就留著舊的；第一次就失敗 → 顯示載入失敗（不是「還沒有物件」）
      setStageObjectsStatus(s => (s === 'ready' ? s : 'error'));
    }
  }, [projectId, commitStageObjects]);

  const refreshModel = useCallback(async () => {
    if (!projectId) return;
    try {
      const info = await api.getModelInfo(projectId);
      setModelUrl(info ? api.modelDownloadUrl(info.key) : null);
    } catch (e) {
      console.warn('load model info failed', e);
      setModelUrl(null);
    }
  }, [projectId]);

  // 每次讀取編號：讀的途中換了 cue / 又有更新的讀取 → 舊的結果丟掉（不然會把別的 cue 的狀態放到這個 cue）
  const statesRequestRef = useRef(0);
  const refreshCueStates = useCallback(async () => {
    const req = ++statesRequestRef.current;
    if (!projectId || !selectedSongId || !selectedCueId) { commitCueStates(null, []); setStatesError(false); return; }
    const cueId = selectedCueId;
    if (cueStatesForRef.current !== cueId) setStatesError(false);
    try {
      const list = await api.listCueStates(projectId, selectedSongId, cueId);
      if (req !== statesRequestRef.current) return;
      commitCueStates(cueId, list);
      setStatesError(false);
    } catch (e) {
      console.warn('load cue states failed', e);
      if (req === statesRequestRef.current && cueStatesForRef.current !== cueId) setStatesError(true);
    }
  }, [projectId, selectedSongId, selectedCueId, commitCueStates]);
  refreshCueStatesRef.current = refreshCueStates;
  refreshStageObjectsRef.current = refreshStageObjects;

  useEffect(() => { setStageObjectsStatus('loading'); }, [projectId]);
  useEffect(() => { refreshSongs(); refreshStageObjects(); refreshModel(); }, [refreshSongs, refreshStageObjects, refreshModel]);

  // 進入專案時推進 recent（Cmd+K palette 用）— 等專案 metadata 拉到才推（取真實名稱）
  // 簡化：用 projectId + 從 listProjects 找 name；如果還沒拉到就用 projectId
  useEffect(() => {
    if (!projectId) return;
    // 拉 project name（不增 round-trip — 用 listProjects 一個 lazy fetch）
    api.listProjects().then(list => {
      const p = list.find(x => x.id === projectId);
      if (p) pushRecentProject(p.id, p.name);
    }).catch(() => { /* swallow */ });
  }, [projectId]);
  useEffect(() => { refreshCues(); }, [refreshCues]);
  useEffect(() => { refreshCueStates(); }, [refreshCueStates]);

  // ── Derived ──
  const masterCues = useMemo(() => cues.filter(c => c.status === 'master'), [cues]);
  const proposalCues = useMemo(() => cues.filter(c => c.status === 'proposal'), [cues]);
  const selectedCue = useMemo(() => cues.find(c => c.id === selectedCueId) || null, [cues, selectedCueId]);
  const selectedSong = useMemo(() => songs.find(s => s.id === selectedSongId) || null, [songs, selectedSongId]);

  const visibleSongs = useMemo(() => {
    let list = statusFilter === 'all' ? songs : songs.filter(s => s.status === statusFilter);
    if (mineOnly && mineSongIds.size > 0) list = list.filter(s => mineSongIds.has(s.id));
    return list;
  }, [songs, statusFilter, mineOnly, mineSongIds]);

  // 開啟 mineOnly 時拉 activity log 算出當前用戶有動過的 song
  useEffect(() => {
    if (!mineOnly || !projectId || !user) return;
    let cancelled = false;
    api.listActivity(projectId, 200).then(list => {
      if (cancelled) return;
      const ids = new Set<string>();
      for (const a of list) {
        if (a.userId !== user.id) continue;
        // payload 可能含 songId / song_id；target_type 是 song / cue / cue_state
        const payload = a.payload as Record<string, unknown>;
        if (a.targetType === 'song' && a.targetId) ids.add(a.targetId);
        if (typeof payload?.songId === 'string') ids.add(payload.songId);
        if (typeof payload?.song_id === 'string') ids.add(payload.song_id);
      }
      setMineSongIds(ids);
    }).catch(() => { /* 略 */ });
    return () => { cancelled = true; };
  }, [mineOnly, projectId, user?.id]);
  // 同步 navRef 給 keyboard listener
  navRef.current = { masterCues, visibleSongs, selectedCueId, selectedSongId };
  const statusCounts = useMemo(() => {
    const c: Record<SongStatus, number> = { todo: 0, in_review: 0, approved: 0, needs_changes: 0 };
    for (const s of songs) c[s.status]++;
    return c;
  }, [songs]);

  // 當 filter 把當前選中的歌篩掉時，跳到第一個可見的歌
  useEffect(() => {
    if (!selectedSongId) return;
    if (visibleSongs.some(s => s.id === selectedSongId)) return;
    setSelectedSongId(visibleSongs[0]?.id ?? null);
  }, [visibleSongs, selectedSongId]);

  // viewport 用的 states：有 cue 用 cueStates，沒 cue 用 stageObjects 的 default 假裝成 state
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

  // ── 歌曲影片（＋加影片）：上傳中切到別首歌也會繼續；好了歌單上的「影片 V3」跟著更新 ──
  const [addVideoSongId, setAddVideoSongId] = useState<string | null>(null);
  const addVideoSong = addVideoSongId ? songs.find(s => s.id === addVideoSongId) ?? null : null;
  const videoJobs = useVideoJobs(projectId ?? null);
  const videoJobsBySong = useMemo(() => {
    const m = new Map<string, VideoJob[]>();
    for (const j of videoJobs) m.set(j.songId, [...(m.get(j.songId) ?? []), j]);
    return m;
  }, [videoJobs]);
  useWarnBeforeUnloadWhileUploading();
  const onVideoJobDone = useCallback((job: VideoJob) => {
    if (!projectId || job.projectId !== projectId) return;
    toast.success(`${job.songLabel}：${job.result?.label || '新的一版'} 好了`);
    api.listSongs(projectId).then(setSongs).catch(() => { /* 下次重新整理就有 */ });
  }, [projectId]);
  useVideoJobDone(onVideoJobDone);

  // ── Song actions ──
  async function handleAddSong() {
    if (!projectId) return;
    const name = (await promptDialog({ title: '新增歌曲', label: '歌名', placeholder: '例：S03 主題曲', confirmLabel: '新增', maxLength: 100 }))?.trim();
    if (!name) return;
    try { await api.createSong(projectId, name); await refreshSongs(); }
    catch (e) { toast.error('歌曲沒有新增：' + msg(e)); }
  }
  async function handleRenameSong(songId: string, currentName: string) {
    if (!projectId) return;
    const name = (await promptDialog({ title: '改歌名', label: '歌名', defaultValue: currentName, confirmLabel: '改名', maxLength: 100 }))?.trim();
    if (!name || name === currentName) return;
    try { await api.updateSong(projectId, songId, { name }); await refreshSongs(); }
    catch (e) { toast.error('改名失敗：' + msg(e)); }
  }
  async function handleDeleteSong(songId: string, name: string) {
    if (!projectId) return;
    if (!(await confirmDialog({ title: `刪除歌曲「${name}」？`, message: '它的所有 cue 會一起刪掉，刪了就救不回來。', confirmLabel: '刪除', destructive: true }))) return;
    try {
      await api.deleteSong(projectId, songId);
      if (selectedSongId === songId) setSelectedSongId(null);
      await refreshSongs();
    } catch (e) { toast.error('刪除失敗：' + msg(e)); }
  }
  /**
   * 管理頁的狀態選單：帶上畫面上以為的目前狀態（expectedStatus）→ 導演 / 動畫師剛改過的話後台回 409，
   * 不會蓋掉別人的決定；這時重新讀歌單、用白話說現在是什麼狀態（跟動畫師頁、導演頁一樣）
   */
  async function handleUpdateSongStatus(songId: string, status: SongStatus, reason?: string): Promise<boolean> {
    if (!projectId) return false;
    const song = songs.find(s => s.id === songId);
    const expected = song?.status;
    if (!song || !expected || expected === status) return false;
    // 需修改一定要寫原因（動畫師才知道改什麼）→ 先開對話框；通過 / 需修改都記在最新一版
    if (status === 'needs_changes' && reason === undefined) {
      setDecisionSongId(songId);
      return false;
    }
    const review = (status === 'needs_changes' || status === 'approved')
      ? { reason: reason ?? '', reviewVideoId: song.latestVideoId ?? null }
      : {};
    const setStatus = (to: SongStatus) => setSongs(list => list.map(s => s.id === songId ? { ...s, status: to } : s));
    setStatus(status);  // 先改畫面
    try {
      await api.updateSong(projectId, songId, { status, expectedStatus: expected, ...review });
      // 審片紀錄、「有新版」要用新的
      api.listSongs(projectId).then(setSongs).catch(() => { /* 下次重新整理再拿 */ });
      return true;
    } catch (e) {
      if (api.errorStatus(e) === 409) {
        const stale = staleStatusMessage((e as api.ApiError).data?.currentStatus, expected);
        try {
          setSongs(await api.listSongs(projectId));
        } catch {
          setStatus(expected);
        }
        toast.warn(stale ?? friendlyError(e));
      } else {
        setStatus(expected);
        toast.error('狀態沒有改成：' + friendlyError(e));
      }
      return false;
    }
  }
  // 指派負責的動畫師（動畫師工作站「我的」清單就是看這個）
  async function handleAssignAnimator(songId: string, userId: string | null) {
    if (!projectId) return;
    const before = songs.find(s => s.id === songId)?.animatorUserId ?? null;
    if (before === userId) return;
    setSongs(list => list.map(s => s.id === songId ? { ...s, animatorUserId: userId } : s));
    try {
      await api.updateSong(projectId, songId, { animator_user_id: userId });
    } catch (e) {
      setSongs(list => list.map(s => s.id === songId ? { ...s, animatorUserId: before } : s));
      toast.error('指派沒有存到：' + friendlyError(e));
    }
  }
  async function moveSong(songId: string, direction: -1 | 1) {
    if (!projectId) return;
    const idx = songs.findIndex(s => s.id === songId);
    const newIdx = idx + direction;
    if (idx < 0 || newIdx < 0 || newIdx >= songs.length) return;
    const reordered = [...songs];
    [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];
    setSongs(reordered);
    try { await api.reorderSongs(projectId, reordered.map(s => s.id)); }
    catch (e) { toast.error('順序沒有存到：' + msg(e)); await refreshSongs(); }
  }

  // ── Cue templates / palette ──
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

  async function handleSaveCueAsTemplate(cueId: string, cueName: string) {
    if (!projectId) return;
    const name = (await promptDialog({
      title: '存成「常用擺位」',
      message: '把這個 cue 裡每個物件的位置存起來，之後新增 cue 時可以直接套用。',
      label: '名稱',
      defaultValue: cueName,
      confirmLabel: '下一步',
      maxLength: 100,
    }))?.trim();
    if (!name) return;
    const choice = await chooseDialog({
      title: `「${name}」要給哪些專案用？`,
      choices: [
        { value: 'project', label: '只給這個專案' },
        { value: 'global', label: '所有專案都能用', primary: true },
      ],
    });
    if (!choice) return;
    const scope = choice === 'global';
    try {
      await api.createCueTemplate(projectId, { name, description: '', fromCueId: cueId, global: scope });
      toast.success(`已存成${scope ? '所有專案都能用' : '這個專案'}的常用擺位「${name}」`);
    } catch (e) {
      toast.error('常用擺位沒有存到：' + msg(e));
    }
  }

  async function handleApplyTemplate(templateId: string) {
    if (!projectId || !selectedSongId) return;
    const defaultName = `Cue ${cues.length + 1}`;
    const name = (await promptDialog({ title: '用常用擺位新增 cue', label: 'cue 名稱', defaultValue: defaultName, confirmLabel: '新增', maxLength: 100 }))?.trim();
    if (!name) return;
    try {
      // 模板有自己的淡入淡出秒數會蓋過這個預設
      await api.createCue(projectId, selectedSongId, { name, fromTemplateId: templateId, crossfadeSeconds: NEW_CUE_CROSSFADE_SECONDS });
      await refreshCues();
      setRightTab('cues');
      setTemplatePickerOpen(false);
    } catch (e) { toast.error('常用擺位沒有套用：' + msg(e)); }
  }

  // ── Cue actions ──
  async function handleAddBlankCue() {
    if (!projectId || !selectedSongId) return;
    const defaultName = `Cue ${cues.length + 1}`;
    const name = (await promptDialog({ title: '新增空白 cue', message: '所有物件都在預設位置。', label: 'cue 名稱', defaultValue: defaultName, confirmLabel: '新增', maxLength: 100 }))?.trim();
    if (!name) return;
    try { await api.createCue(projectId, selectedSongId, { name, crossfadeSeconds: NEW_CUE_CROSSFADE_SECONDS }); await refreshCues(); setRightTab('cues'); }
    catch (e) { toast.error('cue 沒有新增：' + msg(e)); }
  }
  async function handleCloneCue(sourceCueId?: string) {
    if (!projectId || !selectedSongId) return;
    const src = sourceCueId
      ? cues.find(c => c.id === sourceCueId)
      : (selectedCue);
    if (!src) { toast.warn('還沒有選 cue，請先在清單裡選一個要沿用的 cue'); return; }
    const defaultName = `${src.name} (副本)`;
    const name = (await promptDialog({ title: `沿用「${src.name}」新增 cue`, label: '新 cue 名稱', defaultValue: defaultName, confirmLabel: '新增', maxLength: 100 }))?.trim();
    if (!name) return;
    try {
      // 後台複製 cue 時不會帶淡入淡出秒數 → 自己帶原本 cue 的
      await api.createCue(projectId, selectedSongId, { name, cloneFrom: src.id, crossfadeSeconds: src.crossfadeSeconds });
      await refreshCues();
      setRightTab('cues');
    } catch (e) { toast.error('沒有沿用成功：' + msg(e)); }
  }
  async function handleSnapshotCue() {
    if (!projectId || !selectedSongId) return;
    if (viewportStates.length === 0) { toast.warn('舞台上還沒有物件，沒有東西可以記下來'); return; }
    const defaultName = selectedCue ? `${selectedCue.name}（目前狀態）` : `Cue ${cues.length + 1}`;
    const name = (await promptDialog({ title: '用目前的 3D 畫面新增 cue', message: '每個物件現在的位置都會記進新的 cue。', label: 'cue 名稱', defaultValue: defaultName, confirmLabel: '新增', maxLength: 100 }))?.trim();
    if (!name) return;
    try {
      const snapshotStates = viewportStates.map(s => ({
        objectId: s.objectId,
        position: s.effective.position,
        rotation: s.effective.rotation,
      }));
      await api.createCue(projectId, selectedSongId, withMechanismSnapshot({ name, snapshotStates, crossfadeSeconds: NEW_CUE_CROSSFADE_SECONDS }, mech.currentValues));
      await refreshCues();
      setRightTab('cues');
    } catch (e) { toast.error('cue 沒有新增：' + msg(e)); }
  }
  async function handleDuplicateCueQuick(cueId: string) {
    if (!projectId || !selectedSongId) return;
    const src = cues.find(c => c.id === cueId);
    if (!src) return;
    try {
      await api.createCue(projectId, selectedSongId, { name: `${src.name} (副本)`, cloneFrom: cueId, crossfadeSeconds: src.crossfadeSeconds });
      await refreshCues();
    } catch (e) { toast.error('複製失敗：' + msg(e)); }
  }
  async function handleResetCue(cueId: string, name: string) {
    if (!projectId || !selectedSongId) return;
    if (!(await confirmDialog({ title: `重置 cue「${name}」？`, message: '這個 cue 自己設的物件位置和機關位置都會清掉，改回沿用上一個 cue。', confirmLabel: '重置', destructive: true }))) return;
    try {
      await api.resetCue(projectId, selectedSongId, cueId);
      await refreshCueStates();
      await mech.refreshPositions();
    } catch (e) { toast.error('重置失敗：' + msg(e)); }
  }
  async function handleRenameCue(cueId: string, currentName: string) {
    if (!projectId || !selectedSongId) return;
    const name = (await promptDialog({ title: '改 cue 名稱', label: 'cue 名稱', defaultValue: currentName, confirmLabel: '改名', maxLength: 100 }))?.trim();
    if (!name || name === currentName) return;
    try {
      await api.updateCue(projectId, selectedSongId, cueId, { name });
      await refreshCues();
    } catch (e) { toast.error('改名失敗：' + msg(e)); }
  }
  async function handleDeleteCue(cueId: string, name: string) {
    if (!projectId || !selectedSongId) return;
    if (!(await confirmDialog({ title: `刪除 cue「${name}」？`, message: '刪了就救不回來。', confirmLabel: '刪除', destructive: true }))) return;
    try {
      await api.deleteCue(projectId, selectedSongId, cueId);
      historyRef.current.clear(historyScope(cueId));
      if (selectedCueId === cueId) setSelectedCueId(null);
      await refreshCues();
    } catch (e) { toast.error('刪除失敗：' + msg(e)); }
  }
  async function moveCue(cueId: string, direction: -1 | 1) {
    if (!projectId || !selectedSongId) return;
    const list = masterCues;
    const idx = list.findIndex(c => c.id === cueId);
    const newIdx = idx + direction;
    if (idx < 0 || newIdx < 0 || newIdx >= list.length) return;
    const reordered = [...list];
    [reordered[idx], reordered[newIdx]] = [reordered[newIdx], reordered[idx]];
    try {
      await api.reorderCues(projectId, selectedSongId, reordered.map(c => c.id));
      await refreshCues();
    } catch (e) { toast.error('順序沒有存到：' + msg(e)); }
  }
  async function handleUpdateCueMeta(patch: Partial<Pick<Cue, 'name' | 'crossfadeSeconds' | 'videoTimeSec'>>) {
    if (!projectId || !selectedSongId || !selectedCueId) return;
    try {
      await api.updateCue(projectId, selectedSongId, selectedCueId, patch);
      await refreshCues();
    } catch (e) { toast.error('cue 沒有存到：' + msg(e)); }
  }

  // ── Cue state (per object override) actions ──
  // 這個 cue 目前的物件狀態：畫面上那份就是這個 cue 的 → 直接用；不是（還在讀）→ 去後台拿
  async function loadCueState(pid: string, songId: string, cueId: string, objId: string): Promise<CueState | null> {
    if (cueStatesForRef.current === cueId) return cueStatesRef.current.find(s => s.objectId === objId) ?? null;
    const list = await api.listCueStates(pid, songId, cueId);
    return list.find(s => s.objectId === objId) ?? null;
  }
  // 存成功後先套到畫面上（排隊的修改全部做完會再重新讀一次）；已經換到別的 cue 就不套
  function applyCueStateLocal(cueId: string, objId: string, patch: CueStatePatch) {
    if (cueStatesForRef.current !== cueId) return;
    commitCueStates(cueId, cueStatesRef.current.map(s => (s.objectId === objId ? applyCueStatePatch(s, patch) : s)));
  }
  function applyStageObjectLocal(objId: string, patch: Partial<StageObject>) {
    commitStageObjects(stageObjectsRef.current.map(o => (o.id === objId ? { ...o, ...patch } : o)));
  }

  function handleSetState(objId: string, input: StatePatchInput): Promise<void> {
    if (!projectId) return Promise.resolve();
    const pid = projectId;
    const songId = selectedSongId;
    const cueId = selectedCueId;
    const scope = historyScope(cueId);
    const resolvePatch = (cur: CueState['effective']) => (typeof input === 'function' ? input(cur) : input);

    // 沒選 cue → 改物件預設位置（影響所有沒自己設定的 cue）
    if (!cueId) {
      return runEdit(async () => {
        const obj = stageObjectsRef.current.find(o => o.id === objId);
        if (!obj) return;
        const patch = resolvePatch({ position: obj.defaultPosition, rotation: obj.defaultRotation, scale: obj.defaultScale, visible: true });
        const after: Partial<StageObject> = {};
        const before: Partial<StageObject> = {};
        if (patch.position) { after.defaultPosition = patch.position; before.defaultPosition = obj.defaultPosition; }
        if (patch.rotation) { after.defaultRotation = patch.rotation; before.defaultRotation = obj.defaultRotation; }
        if (Object.keys(after).length === 0) return;  // 預設位置沒有「顯示 / 隱藏」
        await api.updateStageObject(pid, objId, after);
        applyStageObjectLocal(objId, after);
        historyRef.current.push(scope, {
          undo: async () => { await api.updateStageObject(pid, objId, before); applyStageObjectLocal(objId, before); },
          redo: async () => { await api.updateStageObject(pid, objId, after); applyStageObjectLocal(objId, after); },
        });
        bumpHistory();
      }, 'objects');
    }
    if (!songId) return Promise.resolve();
    return runEdit(async () => {
      const cur = await loadCueState(pid, songId, cueId, objId);
      if (!cur) return;
      const patch = resolvePatch(cur.effective);
      const changed = Object.keys(patch) as CueStateField[];
      if (changed.length === 0) return;
      const before = cur.override;  // 改之前這個 cue 自己的設定（復原用）
      await api.setCueState(pid, songId, cueId, objId, patch);
      applyCueStateLocal(cueId, objId, patch);
      historyRef.current.push(scope, {
        undo: async () => {
          const plan = cueStateRestorePlan(before, changed);
          if (plan.reset) await api.resetCueState(pid, songId, cueId, objId);
          if (plan.put) await api.setCueState(pid, songId, cueId, objId, plan.put);
        },
        redo: async () => {
          await api.setCueState(pid, songId, cueId, objId, patch);
          applyCueStateLocal(cueId, objId, patch);
        },
      });
      bumpHistory();
    }, 'states');
  }
  /** 這個 cue 裡顯示 / 隱藏這個物件（排隊輪到時才看現在是顯示還是隱藏，連按兩下也對） */
  function handleToggleVisible(objId: string) {
    handleSetState(objId, cur => ({ visible: !cur.visible }))
      .catch(e => toast.error('顯示 / 隱藏沒有存到：' + msg(e)));
  }
  /** askFirst = false：多選一起重置時，外面已經問過一次了 */
  async function handleResetState(objId: string, askFirst = true) {
    if (!projectId || !selectedSongId || !selectedCueId) return;
    if (askFirst && !(await confirmDialog({ title: '把這個物件重置回預設位置？', message: '可以按「復原」改回來。', confirmLabel: '重置' }))) return;
    const pid = projectId, songId = selectedSongId, cueId = selectedCueId;
    const scope = historyScope(cueId);
    try {
      await runEdit(async () => {
        const cur = await loadCueState(pid, songId, cueId, objId);
        const restore = overridePatch(cur?.override);
        await api.resetCueState(pid, songId, cueId, objId);
        if (Object.keys(restore).length === 0) return;  // 本來就沒自己的設定 → 沒東西可復原
        historyRef.current.push(scope, {
          undo: async () => { await api.setCueState(pid, songId, cueId, objId, restore); },
          redo: async () => { await api.resetCueState(pid, songId, cueId, objId); },
        });
        bumpHistory();
      }, 'states');
    } catch (e) {
      toast.error('重置失敗：' + msg(e));
    }
  }

  // ── Stage object actions ──
  async function handleSeedObjects() {
    if (!projectId) return;
    if (!(await confirmDialog({ title: '加入 10 個常用物件範例？', message: 'SKY、LED-1～4、樂手 LED、旋轉舞臺、升降台、走位。之後可以改名或刪掉。', confirmLabel: '加入範例' }))) return;
    try {
      const r = await api.seedDefaultStageObjects(projectId);
      toast.success(`已新增 ${r.inserted} 個範例物件`);
      await refreshStageObjects();
      await refreshCueStates();
    } catch (e) { toast.error('範例物件沒有加入：' + msg(e)); }
  }
  async function handleAddObject() {
    if (!projectId) return;
    const meshName = (await promptDialog({ title: '新增物件', label: 'C4D 物件名稱', hint: '要跟 .glb 檔裡的物件名稱一模一樣', confirmLabel: '下一步', maxLength: 200 }))?.trim();
    if (!meshName) return;
    const shown = await promptDialog({ title: '新增物件', label: '畫面上顯示的名稱（可以留空）', defaultValue: meshName, confirmLabel: '新增', required: false, maxLength: 100 });
    if (shown == null) return;
    const displayName = shown.trim() || meshName;
    try {
      await api.createStageObject(projectId, { meshName, displayName, category: 'other' });
      await refreshStageObjects();
      await refreshCueStates();
    } catch (e) { toast.error('物件沒有新增：' + msg(e)); }
  }
  async function handleRenameObject(obj: StageObject) {
    if (!projectId) return;
    const displayName = (await promptDialog({ title: '改物件名稱', label: '畫面上顯示的名稱', defaultValue: obj.displayName, confirmLabel: '改名', maxLength: 100 }))?.trim();
    if (!displayName || displayName === obj.displayName) return;
    try {
      await api.updateStageObject(projectId, obj.id, { displayName });
      await refreshStageObjects();
      await refreshCueStates();
    } catch (e) { toast.error('改名失敗：' + msg(e)); }
  }
  async function handleChangeCategory(obj: StageObject, category: StageObjectCategory) {
    if (!projectId) return;
    try {
      await api.updateStageObject(projectId, obj.id, { category });
      await refreshStageObjects();
      await refreshCueStates();
    } catch (e) { toast.error('分類沒有存到：' + msg(e)); }
  }
  async function handleUpdateMaterial(objId: string, patch: MaterialProps) {
    if (!projectId) return;
    const obj = stageObjects.find(o => o.id === objId);
    if (!obj) return;
    const merged = { ...(obj.materialProps || {}), ...patch };
    try {
      await api.updateStageObject(projectId, objId, { materialProps: merged });
      await refreshStageObjects();
    } catch (e) { toast.error('材質沒有存到：' + msg(e)); }
  }
  async function handleUpdateLed(objId: string, patch: LedProps) {
    if (!projectId) return;
    const obj = stageObjects.find(o => o.id === objId);
    if (!obj) return;
    const merged = { ...(obj.ledProps || {}), ...patch };
    try {
      await api.updateStageObject(projectId, objId, { ledProps: merged });
      await refreshStageObjects();
    } catch (e) { toast.error('LED 設定沒有存到：' + msg(e)); }
  }

  async function handleToggleLock(obj: StageObject) {
    if (!projectId) return;
    try {
      await api.updateStageObject(projectId, obj.id, { locked: !obj.locked });
      // 鎖時取消當前 selection（如果鎖的剛好是 selected）
      if (!obj.locked) setSelectedObjectIds(prev => prev.filter(x => x !== obj.id));
      await refreshStageObjects();
      await refreshCueStates();
    } catch (e) { toast.error((obj.locked ? '沒有解鎖：' : '沒有鎖住：') + msg(e)); }
  }
  async function handleDeleteObject(obj: StageObject) {
    if (!projectId) return;
    if (!(await confirmDialog({ title: `刪除物件「${obj.displayName}」？`, message: '所有 cue 裡對它的調整也會一起刪掉，刪了就救不回來。', confirmLabel: '刪除', destructive: true }))) return;
    try {
      await api.deleteStageObject(projectId, obj.id);
      await refreshStageObjects();
      await refreshCueStates();
    } catch (e) { toast.error('刪除失敗：' + msg(e)); }
  }

  return (
    <div className="editor">
      {/* Top */}
      <header className="editor-topbar">
        <button className="editor-back" onClick={() => navigate('/admin')} title="返回專案總覽" aria-label="返回專案總覽"><Icon icon={ArrowLeft} size="md" /></button>
        <div className="editor-breadcrumb">
          <span className="muted">專案</span>
          <span className="sep">/</span>
          {/* 顯示專案名稱；載入中顯示「…」，載不到才退回代號 */}
          <span className="strong">{projectMeta ? (projectMeta.name || projectId) : (projectMetaFailed ? projectId : '…')}</span>
          {selectedSong && (<>
            <span className="sep">/</span>
            <span className="muted">{selectedSong.name}</span>
          </>)}
          {selectedCue && (<>
            <span className="sep">/</span>
            <span className="strong">{selectedCue.name}</span>
          </>)}
        </div>
        <div className="editor-topbar__right">
          <SaveIndicator />
          <span className="muted small editor-topbar__count">{stageObjectsStatus === 'ready' ? stageObjects.length : '…'} 物件</span>
          <button
            className="editor-topbar__activity"
            onClick={() => runHistory('undo')}
            disabled={historyCounts.undo === 0}
            title={historyCounts.undo > 0
              ? `復原${selectedCueId ? '這個 cue ' : ''}的上一步（還有 ${historyCounts.undo} 步）— Cmd/Ctrl+Z`
              : `${selectedCueId ? '這個 cue ' : ''}沒有可以復原的修改`}
          >
            <Icon icon={Undo2} /><span className="editor-topbar__label"> 復原</span>{historyCounts.undo > 0 && <span className="muted small"> ({historyCounts.undo})</span>}
          </button>
          <button
            className="editor-topbar__activity"
            onClick={() => runHistory('redo')}
            disabled={historyCounts.redo === 0}
            title={historyCounts.redo > 0
              ? `重做剛剛復原的修改（還有 ${historyCounts.redo} 步）— Cmd/Ctrl+Shift+Z 或 Ctrl+Y`
              : '沒有可以重做的修改'}
          >
            <Icon icon={Redo2} /><span className="editor-topbar__label"> 重做</span>{historyCounts.redo > 0 && <span className="muted small"> ({historyCounts.redo})</span>}
          </button>
          <button
            className="editor-topbar__activity editor-topbar__activity--secondary"
            onClick={() => setStoryboardOpen(true)}
            title="分鏡：這首歌所有 cue 的縮圖一覽"
            disabled={!selectedSong || masterCues.length === 0}
          >
            <Icon icon={LayoutGrid} /><span className="editor-topbar__label"> 分鏡</span>
          </button>
          <button
            className="editor-topbar__activity editor-topbar__activity--secondary"
            onClick={() => setDiffOpen(true)}
            title="兩個 cue 並排對比"
            disabled={!selectedSong || masterCues.length < 2}
          >
            <Icon icon={Columns2} /><span className="editor-topbar__label"> 對比</span>
          </button>
          <button
            className="editor-topbar__activity editor-topbar__activity--secondary"
            onClick={() => setImportCuesOpen(true)}
            title="從別首歌匯入 cue（巡迴複製、跨專案沿用）"
            disabled={!selectedSong}
          >
            <Icon icon={Import} /><span className="editor-topbar__label"> 匯入 Cue</span>
          </button>
          <button
            className="editor-topbar__activity editor-topbar__activity--secondary"
            onClick={() => setCommentSearchOpen(true)}
            title="搜尋專案內所有歌的留言"
          >
            <Icon icon={Search} /><span className="editor-topbar__label"> 搜留言</span>
          </button>
          <button
            className="editor-topbar__activity"
            onClick={() => setShareOpen(true)}
            title="建立公開分享連結（外部的人不用登入就能看，只能看不能改）"
          >
            <Icon icon={Link} /><span className="editor-topbar__label"> 分享</span>
          </button>
          <button
            className="editor-topbar__activity"
            onClick={() => setInviteOpen(true)}
            title="邀請連結：傳給導演 / 動畫師，點開就加進這個專案（不用登入碼）"
            aria-label="邀請連結"
          >
            <Icon icon={UserPlus} /><span className="editor-topbar__label"> 邀請</span>
          </button>
          <button
            className="editor-topbar__activity editor-topbar__activity--secondary"
            onClick={() => setDriveOpen(true)}
            title="Drive 來源設定"
          >
            <Icon icon={Cloud} /><span className="editor-topbar__label"> Drive</span>
            {projectMeta?.drive_folder_id && <span className="editor-topbar__dot" title="已設定 Drive 資料夾" />}
          </button>
          <button
            className="editor-topbar__activity editor-topbar__activity--secondary"
            onClick={() => setActivityOpen(true)}
            title="最近活動"
          >
            <Icon icon={HistoryIcon} /><span className="editor-topbar__label"> 最近活動</span>
          </button>
          <NotificationBell />
        </div>
      </header>

      <div className="editor-body">
        {/* Left — songs */}
        <aside className="editor-songs">
          <div className="editor-songs__header">
            <h3>歌曲</h3>
            <span className="muted">
              {statusFilter === 'all' ? `${songs.length} 首` : `${visibleSongs.length} / ${songs.length}`}
            </span>
          </div>

          {songs.length > 0 && (
            <StatusFilterChips
              counts={statusCounts}
              total={songs.length}
              value={statusFilter}
              onChange={setStatusFilter}
            />
          )}

          {user && songs.length > 0 && (
            <div className="editor-songs__mine-toggle">
              <label>
                <input
                  type="checkbox"
                  checked={mineOnly}
                  onChange={e => setMineOnly(e.target.checked)}
                />
                <span>只看我改過的{mineOnly ? `（${mineSongIds.size}）` : ''}</span>
              </label>
            </div>
          )}

          {songsLoading ? (
            <div className="editor-empty muted">載入中…</div>
          ) : songs.length === 0 ? (
            <div className="editor-empty">
              <Icon icon={Music} size="xl" className="editor-empty__icon" />
              <div>還沒有歌曲</div>
              <small className="muted">點下方按鈕新增第一首</small>
            </div>
          ) : visibleSongs.length === 0 ? (
            <div className="editor-empty muted">
              <Icon icon={Search} size="xl" className="editor-empty__icon" />
              <div>沒有「{STATUS_INFO[statusFilter as SongStatus].label}」狀態的歌</div>
              <button className="btn btn--ghost" style={{ marginTop: 8 }} onClick={() => setStatusFilter('all')}>顯示全部</button>
            </div>
          ) : (
            <ul className="song-list">
              {visibleSongs.map((s) => {
                const fullIdx = songs.findIndex(x => x.id === s.id);
                return (
                  <li
                    key={s.id}
                    className={'song-item' + (selectedSongId === s.id ? ' is-active' : '')}
                    onClick={() => setSelectedSongId(s.id)}
                  >
                    <div className="song-item__order">{String(fullIdx + 1).padStart(2, '0')}</div>
                    <div className="song-item__main">
                      <div className="song-item__name">
                        {projectId && (
                          <SongCodeField
                            projectId={projectId}
                            song={s}
                            songs={songs}
                            onSaved={(code) => setSongs(list => list.map(x => x.id === s.id ? { ...x, code } : x))}
                          />
                        )}
                        {s.name}
                      </div>
                      <div className="song-item__meta">
                        <span>{s.cueCount} 個 cue</span>
                        {s.proposalCount > 0 && <span className="proposal-badge">{s.proposalCount} 提案</span>}
                        {newVersionLabel(s) && <span className="song-item__newer" title={`導演上次看的是 V${s.reviewedVersion ?? s.lastReview?.version ?? ''}`}>有新版 {newVersionLabel(s)}</span>}
                        <SongVideoMeta song={s} jobs={videoJobsBySong.get(s.id)} onAdd={() => setAddVideoSongId(s.id)} />
                      </div>
                      <label
                        className="song-item__assign"
                        onClick={(e) => e.stopPropagation()}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}
                      >
                        <span style={{ flexShrink: 0 }}>負責動畫師</span>
                        <select
                          value={s.animatorUserId ?? ''}
                          onChange={(e) => handleAssignAnimator(s.id, e.target.value || null)}
                          disabled={animatorMembers.length === 0 && !s.animatorUserId}
                          title={animatorMembers.length === 0 ? '這個專案還沒有動畫師：先到「用戶」把動畫師加進這個專案' : '指派後，動畫師在工作站的「我的」就看得到這首歌'}
                          style={{
                            flex: 1, minWidth: 0, fontSize: 11, padding: '1px 4px',
                            background: 'var(--bg)', color: 'var(--text)',
                            border: '1px solid var(--border)', borderRadius: 4,
                          }}
                        >
                          <option value="">{animatorMembers.length === 0 ? '專案裡還沒有動畫師' : '還沒指派'}</option>
                          {animatorMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                          {s.animatorUserId && !animatorMembers.some(m => m.id === s.animatorUserId) && (
                            <option value={s.animatorUserId}>
                              {(projectMembers.find(m => m.id === s.animatorUserId)?.name || '已不在專案的人') + '（不是這個專案的動畫師）'}
                            </option>
                          )}
                        </select>
                      </label>
                    </div>
                    <div onClick={(e) => e.stopPropagation()}>
                      <StatusBadge
                        value={s.status}
                        onChange={(next) => handleUpdateSongStatus(s.id, next)}
                      />
                    </div>
                    <div className="song-item__actions" onClick={(e) => e.stopPropagation()}>
                      <button title="上移" aria-label="上移" onClick={() => moveSong(s.id, -1)} disabled={fullIdx === 0}><Icon icon={ArrowUp} /></button>
                      <button title="下移" aria-label="下移" onClick={() => moveSong(s.id, 1)} disabled={fullIdx === songs.length - 1}><Icon icon={ArrowDown} /></button>
                      <button title="改名" aria-label="改名" onClick={() => handleRenameSong(s.id, s.name)}><Icon icon={Pencil} /></button>
                      <button title="刪除" aria-label="刪除" onClick={() => handleDeleteSong(s.id, s.name)}><Icon icon={Trash2} /></button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <button className="btn btn--ghost editor-songs__add" onClick={handleAddSong}>＋ 新增歌曲</button>
        </aside>

        {/* Center — 3D viewport（永遠顯示；沒 cue 時編輯 = 改 default） */}
        <section className="editor-viewport">
          {stageObjectsStatus === 'loading' ? (
            <div className="viewport-stage">
              <div className="viewport-placeholder" role="status" aria-live="polite">
                <div className="editor-spinner" aria-hidden="true" />
                <div className="muted">載入舞台中…</div>
              </div>
            </div>
          ) : stageObjectsStatus === 'error' && stageObjects.length === 0 ? (
            <div className="viewport-stage">
              <div className="viewport-placeholder" role="alert">
                <div className="muted">舞台物件載入失敗</div>
                <small className="muted">可能是網路斷了，或伺服器暫時沒有回應</small>
                <button className="btn btn--ghost" onClick={() => { setStageObjectsStatus('loading'); refreshStageObjects(); }}>重新載入</button>
              </div>
            </div>
          ) : stageObjects.length === 0 ? (
            <div className="viewport-stage">
              <div className="viewport-placeholder">
                <Icon icon={Shapes} size="xxl" className="editor-empty__icon" />
                <div className="muted">這個專案還沒有物件</div>
                <small className="muted">到右側「物件」分頁上傳模型，或一鍵加入範例</small>
              </div>
            </div>
          ) : (
            <StageScene
              states={viewportStates}
              stageObjects={stageObjects}
              selectedObjectIds={selectedObjectIds}
              onSelect={(id, mode) => {
                if (mode === 'toggle' && id) toggleSelected(id);
                else selectSingle(id);
                if (id) setRightTab(t => (t === 'mechanisms' ? t : 'state'));
              }}
              onTransform={(objId, position, rotation) =>
                handleSetState(objId, { position, rotation }).catch(e => { toast.error('位置沒有存到：' + msg(e)); })
              }
              cueName={selectedCue ? selectedCue.name : '（沒選 cue：改的是物件預設位置）'}
              cueKey={selectedCueId}
              crossfadeSeconds={cueTransitionSeconds(selectedCue)}
              modelUrl={modelUrl}
              enableNdi
              bookmarkScope={projectId}
              mechanismOffsets={view.mechanismOffsets}
              {...mech.sceneProps}
              scaleCorrection={view.scaleCorrection}
              onScaleCorrectionChange={view.canEdit ? view.setScaleCorrection : undefined}
              lookSettings={personalLook.effective}
              onLookSettingsChange={personalLook.set}
              lookCustomized={personalLook.customized}
              onLookReset={personalLook.reset}
              onLookSaveAsDefault={view.canEdit ? () => view.setLookSettings(personalLook.effective) : undefined}
              materialOverrides={view.materialOverrides}
              onMaterialOverrideChange={view.canEdit ? view.setMaterialOverride : undefined}
              homeView={view.homeView}
              onHomeViewChange={view.canEdit ? view.setHomeView : undefined}
            />
          )}
        </section>

        {/* Right — Cue panel */}
        <aside className="editor-cues">
          <div className="editor-cues__tabs">
            {([
              ['cues',      `Cue (${masterCues.length})`],
              ['state',     '物件狀態'],
              ['mechanisms', mech.mechanisms.length > 0 ? `機關 (${mech.mechanisms.length})` : '機關'],
              // 提案：現在沒有「建立 / 接受提案」的流程，只有舊資料才會有 → 有提案才出現這個分頁（只能看、刪）
              ...(proposalCues.length > 0 || rightTab === 'proposals' ? [['proposals', `提案 (${proposalCues.length})`] as const] : []),
              ['objects',   stageObjectsStatus === 'ready' ? `物件 (${stageObjects.length})` : '物件'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                className={'tab' + (rightTab === key ? ' is-active' : '')}
                onClick={() => setRightTab(key)}
              >{label}{key === 'mechanisms' && mech.problemCount > 0 && (
                <span className="mech-tab-dot" title={`有 ${mech.problemCount} 個 cue 的機關來不及到位`} aria-label={`有 ${mech.problemCount} 個 cue 的機關來不及到位`} />
              )}</button>
            ))}
          </div>

          <div className="editor-cues__body">
            <MechanismHintProvider value={mech}>
            {songsLoading && !selectedSongId ? (
              <div className="editor-empty muted">載入中…</div>
            ) : !selectedSongId ? (
              <div className="editor-empty muted">先在左側選一首歌</div>
            ) : rightTab === 'cues' ? (
              <CueList
                cues={masterCues}
                loading={cuesLoading}
                selectedId={selectedCueId}
                onSelect={(id) => { setSelectedCueId(id); setRightTab('state'); }}
                onAddBlank={handleAddBlankCue}
                onClone={handleCloneCue}
                onSnapshot={handleSnapshotCue}
                onFromTemplate={() => setTemplatePickerOpen(true)}
                onDuplicateQuick={handleDuplicateCueQuick}
                onReset={handleResetCue}
                onRename={handleRenameCue}
                onDelete={handleDeleteCue}
                onMove={moveCue}
                onSaveTemplate={handleSaveCueAsTemplate}
              />
            ) : rightTab === 'state' ? (
              <ObjectStateEditor
                cue={selectedCue}
                states={cueStates}
                loading={statesLoading || stageObjectsStatus === 'loading'}
                error={statesError || (stageObjectsStatus === 'error' && stageObjects.length === 0)}
                onRetry={() => { refreshStageObjects(); refreshCueStates(); }}
                stageObjects={stageObjects}
                selectedObjectIds={selectedObjectIds}
                onSelectSingle={selectSingle}
                onToggleSelected={toggleSelected}
                scaleCorrection={view.scaleCorrection}
                unitsReady={view.loaded}
                onSet={handleSetState}
                onToggleVisible={handleToggleVisible}
                onReset={handleResetState}
                onUpdateCueMeta={handleUpdateCueMeta}
                onUpdateMaterial={handleUpdateMaterial}
                onUpdateLed={handleUpdateLed}
                onJumpToObjects={() => setRightTab('objects')}
              />
            ) : rightTab === 'mechanisms' ? (
              <MechanismTab
                mech={mech}
                projectId={projectId || ''}
                projectName={projectMeta?.name}
                cues={cues}
                selectedCue={selectedCue}
                onSelectCue={setSelectedCueId}
                stageObjects={stageObjects}
                selectedObjectIds={selectedObjectIds}
                scaleCorrection={view.scaleCorrection}
                onSetCrossfade={(s) => handleUpdateCueMeta({ crossfadeSeconds: s })}
                onStatesChanged={() => { void refreshCueStates(); }}
              />
            ) : rightTab === 'proposals' ? (
              <>
                <div className="editor-proposals-note">
                  這些是以前留下的「提案」cue。現在還沒有「接受提案」的功能（提案沒有記下要取代哪一個 cue，套上去可能蓋錯），
                  只能點進去看擺位、或刪掉。要用的話，請在 Cue 分頁「沿用目前的 cue」複製一份再改。
                </div>
                <CueList
                  cues={proposalCues}
                  loading={cuesLoading}
                  selectedId={selectedCueId}
                  onSelect={(id) => { setSelectedCueId(id); setRightTab('state'); }}
                  onDelete={handleDeleteCue}
                  emptyText="這首歌沒有提案"
                />
              </>
            ) : (
              <ObjectsManager
                objects={stageObjects}
                status={stageObjectsStatus}
                onSeed={handleSeedObjects}
                onAdd={handleAddObject}
                onUpload={() => setUploadOpen(true)}
                onShowVersions={() => setVersionsOpen(true)}
                onPickFromLibrary={() => setPickerOpen(true)}
                hasModel={!!modelUrl}
                onRename={handleRenameObject}
                onChangeCategory={handleChangeCategory}
                onToggleLock={handleToggleLock}
                onDelete={handleDeleteObject}
              />
            )}
            </MechanismHintProvider>
          </div>
        </aside>
      </div>

      <UploadModelDialog
        open={uploadOpen}
        projectId={projectId || ''}
        onClose={() => setUploadOpen(false)}
        onImported={() => {
          refreshStageObjects();
          refreshCueStates();
          refreshModel();
        }}
      />

      <ModelVersionsDialog
        open={versionsOpen}
        projectId={projectId || ''}
        onClose={() => setVersionsOpen(false)}
        onChanged={() => {
          refreshModel();
        }}
      />

      <AssetPickerDialog
        open={pickerOpen}
        projectId={projectId || ''}
        currentKey={modelUrl ? modelUrl.replace(api.apiBase() + '/r2/', '') : null}
        onClose={() => setPickerOpen(false)}
        onPicked={() => {
          refreshModel();
          refreshStageObjects();
          refreshCueStates();
        }}
      />

      <ActivityDrawer
        open={activityOpen}
        projectId={projectId || ''}
        onClose={() => setActivityOpen(false)}
      />

      <DriveSettingsDialog
        open={driveOpen}
        onClose={() => setDriveOpen(false)}
        projectId={projectId || ''}
        songs={songs}
        initialFolderId={projectMeta?.drive_folder_id || ''}
        initialAccountId={projectMeta?.drive_oauth_token_id || ''}
        onChanged={() => { refreshProjectMeta(); }}
      />

      {addVideoSong && projectId && (
        <AddVideoDialog
          open
          onClose={() => setAddVideoSongId(null)}
          projectId={projectId}
          song={addVideoSong}
          jobs={videoJobsBySong.get(addVideoSong.id) ?? []}
          canUpload
        />
      )}

      <ShareLinksDialog
        open={shareOpen}
        projectId={projectId || ''}
        projectName={projectMeta?.name}
        songs={songs}
        onClose={() => setShareOpen(false)}
      />

      <InviteDialog
        open={inviteOpen}
        projectId={projectId || ''}
        projectName={projectMeta?.name}
        onClose={() => setInviteOpen(false)}
      />

      <CommentSearchDialog
        open={commentSearchOpen}
        projectId={projectId || ''}
        songs={songs}
        onClose={() => setCommentSearchOpen(false)}
        onJump={(songId) => { setSelectedSongId(songId); setCommentSearchOpen(false); }}
      />

      {decisionSongId && (() => {
        const ds = songs.find(x => x.id === decisionSongId);
        return (
          <DecisionDialog
            songName={ds?.name ?? ''}
            versionLabel={ds?.latestVideoVersion ? `V${ds.latestVideoVersion}` : ''}
            onCancel={() => setDecisionSongId(null)}
            onSubmit={async (reason) => {
              const ok = await handleUpdateSongStatus(decisionSongId, 'needs_changes', reason);
              if (ok) { setDecisionSongId(null); toast.success(`已送出「需修改」${ds ? `，${decisionNotifyHint(ds)}` : ''}`); }
              return ok;
            }}
          />
        );
      })()}

      <CueDiffDialog
        open={diffOpen}
        projectId={projectId || ''}
        songId={selectedSongId || ''}
        cues={masterCues}
        onClose={() => setDiffOpen(false)}
      />

      <ImportCuesDialog
        open={importCuesOpen}
        projectId={projectId || ''}
        songId={selectedSongId || ''}
        songName={selectedSong?.name || ''}
        onClose={() => setImportCuesOpen(false)}
        onImported={refreshCues}
      />

      {storyboardOpen && selectedSong && projectId && (
        <div className="dlg-overlay" onClick={(e) => { if (e.target === e.currentTarget) setStoryboardOpen(false); }}>
          <div className="dlg" style={{ maxWidth: 1100, width: '95vw' }}>
            <header className="dlg__header">
              <h2>{selectedSong.name} — 分鏡</h2>
              <button className="dlg__close" onClick={() => setStoryboardOpen(false)} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
            </header>
            <div className="dlg__body">
              <CueStoryboard
                projectId={projectId}
                songId={selectedSong.id}
                cues={masterCues}
                stageObjects={stageObjects}
                modelUrl={modelUrl}
                selectedCueId={selectedCueId}
                onSelectCue={(id) => { setSelectedCueId(id); }}
                onReordered={refreshCues}
                projectName={projectMeta?.name}
                songName={selectedSong.name}
                scaleCorrection={view.scaleCorrection}
                mechanismOffsets={view.mechanismOffsets}
                mechanisms={mech.sceneProps.mechanisms}
                mechanismTargetsFor={(cueId) => valuesOf(mech.resolved.get(cueId))}
                lookSettings={personalLook.effective}
                materialOverrides={view.materialOverrides}
                homeView={view.homeView}
              />
            </div>
          </div>
        </div>
      )}

      <CueTemplatePickerDialog
        open={templatePickerOpen}
        projectId={projectId || ''}
        onClose={() => setTemplatePickerOpen(false)}
        onPick={handleApplyTemplate}
      />
    </div>
  );
}

function CueTemplatePickerDialog({
  open, projectId, onClose, onPick,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
  onPick: (templateId: string) => Promise<void>;
}) {
  const [templates, setTemplates] = useState<api.CueTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.listCueTemplates(projectId)
      .then(setTemplates)
      .catch(() => setTemplates([]))
      .finally(() => setLoading(false));
  }, [open, projectId]);
  if (!open) return null;

  async function handleDelete(t: api.CueTemplate) {
    if (!(await confirmDialog({ title: `刪除常用擺位「${t.name}」？`, message: '已經用它建好的 cue 不受影響。', confirmLabel: '刪除', destructive: true }))) return;
    try { await api.deleteCueTemplate(t.id); setTemplates(prev => prev.filter(x => x.id !== t.id)); }
    catch (e) { toast.error('刪除失敗：' + (e instanceof Error ? e.message : String(e))); }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2>從常用擺位建立 cue</h2>
          <button className="dialog__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <div className="dialog__body">
          {loading ? (
            <div className="editor-empty muted">載入中…</div>
          ) : templates.length === 0 ? (
            <div className="editor-empty muted">
              <Icon icon={Bookmark} size="xl" className="editor-empty__icon" />
              <div>還沒有任何常用擺位</div>
              <small>在 cue 旁邊按「存成常用擺位」（書籤圖示），就能把那個 cue 的物件位置存起來</small>
            </div>
          ) : (
            <ul className="versions-list">
              {templates.map(t => (
                <li key={t.id} className="version-row">
                  <div className="version-row__num"><Icon icon={Bookmark} size="md" /></div>
                  <div className="version-row__main">
                    <div className="version-row__title">
                      {t.name}
                      {t.global && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--accent)' }}>所有專案</span>}
                    </div>
                    {t.description && <div className="muted small">{t.description}</div>}
                    {t.authorName && <div className="muted small">{t.authorName} 建立</div>}
                  </div>
                  <div className="version-row__actions">
                    <button className="btn btn--primary btn--sm" onClick={() => onPick(t.id)}>套用</button>
                    <button className="btn btn--ghost btn--sm" onClick={() => handleDelete(t)} title="刪除這個常用擺位" aria-label="刪除這個常用擺位"><Icon icon={Trash2} /></button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────

function CueList({
  cues, loading, selectedId, onSelect, onAddBlank, onClone, onSnapshot, onFromTemplate, onDuplicateQuick,
  onReset, onRename, onDelete, onMove, onSaveTemplate, emptyText,
}: {
  cues: Cue[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddBlank?: () => void;
  onClone?: (sourceCueId?: string) => void;
  onSnapshot?: () => void;
  onFromTemplate?: () => void;
  onDuplicateQuick?: (cueId: string) => void;
  onReset?: (cueId: string, name: string) => void;
  onRename?: (cueId: string, name: string) => void;
  onDelete: (id: string, name: string) => void;
  onMove?: (cueId: string, direction: -1 | 1) => void;
  onSaveTemplate?: (cueId: string, name: string) => void;
  emptyText?: string;
}) {
  if (loading) return <div className="editor-empty muted">載入中…</div>;
  return (
    <>
      {cues.length === 0 ? (
        <div className="editor-empty">
          <Icon icon={Clapperboard} size="xl" className="editor-empty__icon" />
          <div className="muted">{emptyText || '還沒有 cue'}</div>
        </div>
      ) : (
        <ul className="cue-list">
          {cues.map((c, i) => (
            <li
              key={c.id}
              className={'cue-item' + (selectedId === c.id ? ' is-active' : '') + (c.status === 'proposal' ? ' is-proposal' : '')}
              onClick={() => onSelect(c.id)}
            >
              <div className="cue-item__num">{i + 1}</div>
              <div className="cue-item__main">
                <div className="cue-item__name">{c.name}</div>
                <div className="cue-item__meta muted small">
                  {crossfadeLabel(c.crossfadeSeconds)}
                  {c.status === 'proposal' && <span className="proposal-tag">提案</span>}
                </div>
              </div>
              <div className="cue-item__actions" onClick={(e) => e.stopPropagation()}>
                {onMove && <>
                  <button title="上移" aria-label="上移" onClick={() => onMove(c.id, -1)} disabled={i === 0}><Icon icon={ArrowUp} /></button>
                  <button title="下移" aria-label="下移" onClick={() => onMove(c.id, 1)} disabled={i === cues.length - 1}><Icon icon={ArrowDown} /></button>
                </>}
                {onDuplicateQuick && <button title="複製這個 cue" aria-label="複製這個 cue" onClick={() => onDuplicateQuick(c.id)}><Icon icon={Copy} /></button>}
                {onSaveTemplate && <button title="存成常用擺位（之後可以用它建類似的 cue）" aria-label="存成常用擺位" onClick={() => onSaveTemplate(c.id, c.name)}><Icon icon={BookmarkPlus} /></button>}
                {onReset && <button title="重置（清掉這個 cue 的所有調整）" aria-label="重置這個 cue" onClick={() => onReset(c.id, c.name)}><Icon icon={RotateCcw} /></button>}
                {onRename && <button title="改名" aria-label="改名" onClick={() => onRename(c.id, c.name)}><Icon icon={Pencil} /></button>}
                <button title="刪除" aria-label="刪除" onClick={() => onDelete(c.id, c.name)}><Icon icon={Trash2} /></button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {onAddBlank && (
        <CueAddSplitButton
          onAddBlank={onAddBlank}
          onClone={onClone}
          onSnapshot={onSnapshot}
          onFromTemplate={onFromTemplate}
          hasSelectedCue={!!selectedId}
        />
      )}
    </>
  );
}

function CueAddSplitButton({
  onAddBlank, onClone, onSnapshot, onFromTemplate, hasSelectedCue,
}: {
  onAddBlank: () => void;
  onClone?: (id?: string) => void;
  onSnapshot?: () => void;
  onFromTemplate?: () => void;
  hasSelectedCue: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  return (
    <div className="cue-split editor-cues__add" ref={ref}>
      <button className="cue-split__main btn btn--primary" onClick={onAddBlank} title="新增空白 cue（全部用預設位置）">
        <Icon icon={Plus} /> 新增 cue
      </button>
      <button className="cue-split__caret btn btn--primary" onClick={() => setOpen(o => !o)} aria-label="更多新增方式" title="更多新增方式">
        <Icon icon={ChevronDown} />
      </button>
      {open && (
        <div className="cue-split__menu">
          <button onClick={() => { setOpen(false); onAddBlank(); }}>
            <span><Icon icon={Plus} /> 空白 cue</span>
            <small>全部用預設位置</small>
          </button>
          <button
            onClick={() => { setOpen(false); onClone && onClone(); }}
            disabled={!onClone || !hasSelectedCue}
            title={!hasSelectedCue ? '先在左側選一個 cue' : ''}
          >
            <span><Icon icon={Copy} /> 沿用目前的 cue</span>
            <small>{hasSelectedCue ? '複製目前 cue 的所有調整' : '要先選一個 cue'}</small>
          </button>
          <button onClick={() => { setOpen(false); onSnapshot && onSnapshot(); }} disabled={!onSnapshot}>
            <span><Icon icon={Camera} /> 從目前 3D 狀態建立</span>
            <small>記下 3D 畫面現在的物件位置</small>
          </button>
          <button onClick={() => { setOpen(false); onFromTemplate && onFromTemplate(); }} disabled={!onFromTemplate}>
            <span><Icon icon={Bookmark} /> 從常用擺位建立</span>
            <small>選一個存好的常用擺位套用</small>
          </button>
        </div>
      )}
    </div>
  );
}

function ObjectStateEditor({
  cue, states, loading, error, onRetry, stageObjects, selectedObjectIds, onSelectSingle, onToggleSelected,
  scaleCorrection, unitsReady, onSet, onToggleVisible, onReset, onUpdateCueMeta, onUpdateMaterial, onUpdateLed, onJumpToObjects,
}: {
  cue: Cue | null;
  states: CueState[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  stageObjects: StageObject[];
  selectedObjectIds: string[];
  onSelectSingle: (id: string | null) => void;
  onToggleSelected: (id: string) => void;
  /** 測距校準倍率：位置欄位用公尺顯示 */
  scaleCorrection: number;
  /** 專案設定（校準倍率）讀完了沒；還沒讀完先不給改位置，免得用錯倍率換算 */
  unitsReady: boolean;
  onSet: (objId: string, patch: StatePatchInput) => Promise<void>;
  onToggleVisible: (objId: string) => void;
  onReset: (objId: string, askFirst?: boolean) => Promise<void>;
  onUpdateCueMeta: (patch: Partial<Pick<Cue, 'name' | 'crossfadeSeconds' | 'videoTimeSec'>>) => Promise<void>;
  onUpdateMaterial: (objId: string, patch: MaterialProps) => Promise<void>;
  onUpdateLed: (objId: string, patch: LedProps) => Promise<void>;
  onJumpToObjects: () => void;
}) {
  if (!cue) return <div className="editor-empty muted">先選一個 cue</div>;
  if (loading) return <div className="editor-empty muted">載入物件狀態中…</div>;
  if (error) {
    return (
      <div className="editor-empty" role="alert">
        <div className="muted">物件狀態載入失敗</div>
        <small className="muted">可能是網路斷了，或伺服器暫時沒有回應</small>
        <button className="btn btn--ghost" style={{ marginTop: 8 }} onClick={onRetry}>重新載入</button>
      </div>
    );
  }
  if (stageObjects.length === 0) {
    return (
      <div className="editor-empty">
        <Icon icon={Shapes} size="xl" className="editor-empty__icon" />
        <div>這個專案還沒有物件</div>
        <small className="muted">先到「物件」分頁新增，或一鍵加入範例</small>
        <button className="btn btn--primary" style={{ marginTop: 12 }} onClick={onJumpToObjects}>
          管理物件 <Icon icon={ArrowRight} />
        </button>
      </div>
    );
  }

  const selectedStates = states.filter(s => selectedObjectIds.includes(s.objectId));
  const selectedSo = selectedStates.length === 1
    ? stageObjects.find(o => o.id === selectedStates[0].objectId)
    : undefined;

  return (
    <div className="state-editor">
      <CueMetaEditor cue={cue} onUpdate={onUpdateCueMeta} />

      {/* 固定的 attribute panel — C4D / Maya 風格 */}
      <div className="attribute-panel">
        <div className="attribute-panel__selector">
          <span className="attribute-panel__selector-label">
            物件 {selectedObjectIds.length > 0 && <span className="muted small">已選 {selectedObjectIds.length}</span>}
          </span>
          <div className="attribute-panel__selector-actions">
            <button
              type="button"
              className="link-btn"
              onClick={() => onSelectSingle(null)}
              disabled={selectedObjectIds.length === 0}
            >清空</button>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                const allIds = states.filter(s => !s.locked).map(s => s.objectId);
                // 全選未鎖定的
                if (selectedObjectIds.length === allIds.length) onSelectSingle(null);
                else allIds.forEach(id => { if (!selectedObjectIds.includes(id)) onToggleSelected(id); });
              }}
            >全選</button>
          </div>
        </div>
        <ul className="attribute-panel__objects">
          {states.map(s => {
            const cat = CATEGORY_INFO[s.category];
            const checked = selectedObjectIds.includes(s.objectId);
            const visible = s.effective.visible;
            return (
              <li
                key={s.objectId}
                className={'attribute-panel__obj' + (checked ? ' is-selected' : '') + (s.locked ? ' is-locked' : '') + (visible ? '' : ' is-hidden-in-cue')}
              >
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={s.locked}
                    onChange={() => onToggleSelected(s.objectId)}
                  />
                  <span className="attribute-panel__obj-cat" title={cat.label}><Icon icon={cat.icon} /></span>
                  <span className="attribute-panel__obj-name">{s.displayName}</span>
                  {s.locked && <span className="lock-tag" title="已鎖定"><Icon icon={Lock} size="xs" /></span>}
                  {s.override && <span className="override-dot" title="此 cue 已自訂" />}
                </label>
                {/* 這個 cue 裡顯示 / 隱藏（前面的 cue 不受影響；後面沒另外設定的 cue 會跟著，跟位置一樣） */}
                <button
                  type="button"
                  className="vis-toggle"
                  onClick={() => onToggleVisible(s.objectId)}
                  disabled={s.locked}
                  aria-pressed={!visible}
                  aria-label={(visible ? '在這個 cue 隱藏「' : '在這個 cue 顯示「') + s.displayName + '」'}
                  title={s.locked ? '已鎖定，不能改' : visible ? '在這個 cue 隱藏（後面沒另外設定的 cue 也會跟著隱藏）' : '這個 cue 裡隱藏中 — 點一下顯示'}
                >
                  <Icon icon={visible ? Eye : EyeOff} size="md" />
                </button>
              </li>
            );
          })}
        </ul>

        {selectedStates.length === 0 ? (
          <div className="attribute-panel__hint">
            <Icon icon={MousePointerClick} size="xl" className="editor-empty__icon" />
            <div>從上方清單勾選一個或多個物件</div>
            <small className="muted">在 3D 畫面點物件 = 單選；右側勾選 = 加選</small>
          </div>
        ) : selectedStates.length === 1 ? (
          <ObjectAttributePanel
            key={selectedStates[0].objectId}
            state={selectedStates[0]}
            stageObject={selectedSo}
            scaleCorrection={scaleCorrection}
            unitsReady={unitsReady}
            onSet={onSet}
            onReset={onReset}
            onUpdateMaterial={onUpdateMaterial}
            onUpdateLed={onUpdateLed}
          />
        ) : (
          <ObjectAttributePanelMulti
            selectedStates={selectedStates}
            scaleCorrection={scaleCorrection}
            unitsReady={unitsReady}
            onSet={onSet}
            onReset={onReset}
            onUpdateMaterial={onUpdateMaterial}
          />
        )}
      </div>
    </div>
  );
}

/** 顯示 / 隱藏的眼睛圖示（線條 SVG，跟著文字顏色） */
const POS_AXES = ['x', 'y', 'z'] as const;
const ROT_AXES = [
  { key: 'pitch', label: 'P', title: 'Pitch（繞 X 軸轉）' },
  { key: 'yaw', label: 'Y', title: 'Yaw（繞 Y 軸轉）' },
  { key: 'roll', label: 'R', title: 'Roll（繞 Z 軸轉）' },
] as const;
const NUMBER_INVALID_MSG = '要填數字，已還原';

/**
 * 一格數字欄位：打字不會馬上存，按 Enter 或點別的地方才存；Esc 取消；↑↓ 微調（Shift 一次 10 倍）。
 * 不是數字 → 不存、還原（onInvalid）；跟原本一樣 → 不存。
 */
function NumberField({
  axisLabel, axisTitle, unit, value, placeholder, step, disabled, disabledTitle, onCommit, onInvalid,
}: {
  axisLabel: string;
  axisTitle?: string;
  unit: string;
  /** 目前的值（已經換好顯示單位）；null = 多選時「不改」，欄位留空 */
  value: number | null;
  placeholder?: string;
  step: number;
  disabled?: boolean;
  disabledTitle?: string;
  onCommit: (n: number) => Promise<unknown> | void;
  onInvalid?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // 剛存出去、畫面還沒拿到新值的這一下，先顯示打的數字（不會閃回舊值）
  const [pending, setPending] = useState<number | null>(null);
  const cancelRef = useRef(false);
  const shown = pending !== null ? formatFieldNumber(pending) : value === null ? '' : formatFieldNumber(value);

  function commit() {
    if (cancelRef.current) { cancelRef.current = false; setDraft(null); return; }
    if (draft === null) return;
    setDraft(null);
    if (value === null && draft.trim() === '') return;  // 多選：沒填 → 不動
    const n = parseNumberInput(draft);
    if (n === null) { onInvalid?.(); return; }
    if (value !== null && sameAsShown(n, value)) return;
    const r = onCommit(n);
    if (r && typeof (r as Promise<unknown>).then === 'function') {
      setPending(n);
      (r as Promise<unknown>).then(() => setPending(null), () => setPending(null));
    }
  }

  return (
    <label className={'num-field' + (disabled ? ' is-disabled' : '')} title={disabled ? disabledTitle : axisTitle}>
      <span className="num-field__axis">{axisLabel}</span>
      <input
        type="text"
        inputMode="decimal"
        value={draft ?? shown}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={(axisTitle || axisLabel) + '（' + unit + '）'}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') { cancelRef.current = true; e.currentTarget.blur(); }
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            setDraft(stepNumberInput(draft ?? shown, value ?? 0, delta));
          }
        }}
      />
      <span className="num-field__unit" aria-hidden="true">{unit}</span>
    </label>
  );
}

/** 多選 panel — 填的欄位才套到全部，沒填就不動；按 Enter 或點別的地方就套用 */
function ObjectAttributePanelMulti({
  selectedStates, scaleCorrection, unitsReady, onSet, onReset, onUpdateMaterial,
}: {
  selectedStates: CueState[];
  scaleCorrection: number;
  unitsReady: boolean;
  onSet: (objId: string, patch: StatePatchInput) => Promise<void>;
  onReset: (objId: string, askFirst?: boolean) => Promise<void>;
  onUpdateMaterial: (objId: string, patch: MaterialProps) => Promise<void>;
}) {
  const [color, setColor] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // 切換選中物件時清空輸入（避免上一次的殘留）
  const idsKey = selectedStates.map(s => s.objectId).join(',');
  useEffect(() => { setColor(''); setFieldError(null); }, [idsKey]);

  // 每個物件照它自己現在的值，只換掉打的那一軸（排隊一個一個存）
  async function applyToAll(make: (cur: CueState['effective']) => CueStatePatch) {
    setFieldError(null);
    const results = await Promise.allSettled(selectedStates.map(s => onSet(s.objectId, make)));
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) setFieldError(`有 ${failed} 個物件沒有存到，請再試一次`);
  }

  async function applyColor() {
    const c = color.trim();
    if (!c) return;
    if (!/^#[0-9a-f]{6}$/i.test(c)) { setFieldError('顏色要填像 #ff8800 這樣，已還原'); setColor(''); return; }
    setFieldError(null);
    setBusy(true);
    try {
      for (const s of selectedStates) await onUpdateMaterial(s.objectId, { color: c });
      setColor('');
    } finally {
      setBusy(false);
    }
  }

  async function resetAll() {
    if (!(await confirmDialog({ title: `把 ${selectedStates.length} 個物件重置回預設位置？`, message: '可以按「復原」改回來。', confirmLabel: '重置' }))) return;
    setBusy(true);
    try {
      for (const s of selectedStates) {
        if (s.override) await onReset(s.objectId, false);
      }
    } finally {
      setBusy(false);
    }
  }

  const invalid = () => setFieldError(NUMBER_INVALID_MSG);

  return (
    <div className="attribute-panel__body is-multi">
      <div className="attribute-panel__title">
        <span style={{ fontWeight: 700 }}>已選 {selectedStates.length} 個物件</span>
      </div>
      <div className="muted small" style={{ marginBottom: 8 }}>
        填的欄位才會套到全部選中的物件，沒填就不動；按 Enter 或點別的地方就套用。
      </div>

      <div className="form-row">
        <label>位置（套到全部）</label>
        <div className="vec3">
          {POS_AXES.map(axis => (
            <NumberField
              key={axis}
              axisLabel={axis.toUpperCase()}
              unit="m"
              step={0.1}
              value={null}
              placeholder="—"
              disabled={!unitsReady}
              disabledTitle="載入專案設定中…"
              onInvalid={invalid}
              onCommit={(meters) => {
                const v = metersToScene(meters, scaleCorrection);
                return applyToAll(cur => ({ position: { ...cur.position, [axis]: v } }));
              }}
            />
          ))}
        </div>
      </div>
      <div className="form-row">
        <label>角度（套到全部）</label>
        <div className="vec3">
          {ROT_AXES.map(axis => (
            <NumberField
              key={axis.key}
              axisLabel={axis.label}
              axisTitle={axis.title}
              unit="°"
              step={1}
              value={null}
              placeholder="—"
              onInvalid={invalid}
              onCommit={(deg) => applyToAll(cur => ({ rotation: { ...cur.rotation, [axis.key]: deg } }))}
            />
          ))}
        </div>
      </div>
      <div className="form-row">
        <label>材質顏色（套到全部）</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#888888'}
            onChange={(e) => setColor(e.target.value)}
            onBlur={applyColor}
            disabled={busy}
          />
          <input
            type="text"
            value={color}
            placeholder="— 不改 —"
            onChange={(e) => setColor(e.target.value)}
            onBlur={applyColor}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            style={{ flex: 1, fontFamily: 'var(--font-mono)' }}
            disabled={busy}
          />
          {/* 按下去不要先讓欄位失焦（不然會先把顏色套上去） */}
          {color && <button type="button" className="link-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setColor('')}>清除</button>}
        </div>
      </div>
      {fieldError && <div className="field-error small" role="alert">{fieldError}</div>}

      <div className="object-row__actions">
        <button className="btn btn--ghost" onClick={resetAll} disabled={busy}>
          <Icon icon={RotateCcw} /> 全部重置成預設
        </button>
      </div>
    </div>
  );
}

function CueMetaEditor({
  cue, onUpdate,
}: {
  cue: Cue;
  onUpdate: (patch: Partial<Pick<Cue, 'name' | 'crossfadeSeconds' | 'videoTimeSec'>>) => Promise<void>;
}) {
  const savedVideoTime = cue.videoTimeSec != null ? String(cue.videoTimeSec) : '';
  const [name, setName] = useState(cue.name);
  const [crossfade, setCrossfade] = useState(String(cue.crossfadeSeconds));
  const [videoTime, setVideoTime] = useState<string>(savedVideoTime);
  const [error, setError] = useState<string | null>(null);

  // 各欄位分開同步：存好一個欄位時，不要把另一個正在打的欄位洗掉
  useEffect(() => { setName(cue.name); }, [cue.id, cue.name]);
  useEffect(() => { setCrossfade(String(cue.crossfadeSeconds)); }, [cue.id, cue.crossfadeSeconds]);
  useEffect(() => { setVideoTime(cue.videoTimeSec != null ? String(cue.videoTimeSec) : ''); }, [cue.id, cue.videoTimeSec]);
  useEffect(() => { setError(null); }, [cue.id]);

  const parsedVideoTime = parseVideoTimeInput(videoTime);
  const enterToBlur = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') e.currentTarget.blur(); };

  async function saveName() {
    const v = name.trim().slice(0, 100);
    if (!v) { setName(cue.name); setError('名稱不能空白，已還原'); return; }
    if (v !== name) setName(v);
    if (v === cue.name) return;
    setError(null);
    await onUpdate({ name: v });
  }
  async function saveCrossfade() {
    const n = parseCrossfadeInput(crossfade);
    if (n === null) {
      setCrossfade(String(cue.crossfadeSeconds));
      setError('轉場秒數要填 0 或正的數字，已還原');
      return;
    }
    setCrossfade(String(n));
    if (n === cue.crossfadeSeconds) return;
    setError(null);
    await onUpdate({ crossfadeSeconds: n });
  }
  async function saveVideoTime() {
    const r = parseVideoTimeInput(videoTime);
    if (!r.ok) {
      setVideoTime(savedVideoTime);
      setError('影片時間要填像 15.5 或 1:23 這樣，已還原');
      return;
    }
    if (r.value === cue.videoTimeSec) return;
    setError(null);
    await onUpdate({ videoTimeSec: r.value });
  }

  return (
    <div className="cue-meta-editor">
      <div className="cue-meta-editor__row">
        <label>當前 cue 名稱</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={enterToBlur}
          maxLength={100}
        />
      </div>
      <div className="cue-meta-editor__row">
        <label>轉場（秒）</label>
        <input
          type="text"
          inputMode="decimal"
          value={crossfade}
          onChange={(e) => setCrossfade(e.target.value)}
          onBlur={saveCrossfade}
          onKeyDown={enterToBlur}
        />
        <small className="muted">換到這個 cue 時舞台滑過去的秒數；0 = 直接切換（不滑）</small>
      </div>
      <div className="cue-meta-editor__row">
        <label>對應影片時間</label>
        <input
          type="text"
          value={videoTime}
          onChange={(e) => setVideoTime(e.target.value)}
          onBlur={saveVideoTime}
          onKeyDown={enterToBlur}
          placeholder="例：15.5 或 1:23"
        />
        <small className="muted">
          {!parsedVideoTime.ok
            ? '格式：秒數（15.5）或 分:秒（1:23）'
            : parsedVideoTime.value != null
              ? `也就是 ${formatVideoTime(parsedVideoTime.value)}（導演那邊影片播到這一秒，會自動切到這個 cue）`
              : '空白 = 沒對應影片時間；填了之後播影片會自動切 cue'}
        </small>
      </div>
      {error && <div className="field-error small" role="alert">{error}</div>}
      <small className="muted">按 Enter 或點別的地方就會存</small>
    </div>
  );
}

function ObjectAttributePanel({
  state, stageObject, scaleCorrection, unitsReady, onSet, onReset, onUpdateMaterial, onUpdateLed,
}: {
  state: CueState;
  stageObject?: StageObject;
  scaleCorrection: number;
  unitsReady: boolean;
  onSet: (objId: string, patch: StatePatchInput) => Promise<void>;
  onReset: (objId: string, askFirst?: boolean) => Promise<void>;
  onUpdateMaterial: (objId: string, patch: MaterialProps) => Promise<void>;
  onUpdateLed: (objId: string, patch: LedProps) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const cat = CATEGORY_INFO[state.category];
  const hasOverride = !!state.override;
  const eff = state.effective;
  const meters = (v: number) => formatFieldNumber(sceneToMeters(v, scaleCorrection));

  // 只換掉打的那一軸，其他軸用排隊輪到時的最新值（連續改 X、Y 不會互相蓋掉）
  function save(make: (cur: CueState['effective']) => CueStatePatch) {
    setFieldError(null);
    return onSet(state.objectId, make).catch(e => setFieldError('沒有存到：' + msg(e)));
  }

  async function reset() {
    setBusy(true);
    try { await onReset(state.objectId); } finally { setBusy(false); }
  }

  const invalid = () => setFieldError(NUMBER_INVALID_MSG);

  return (
    <div className={'attribute-panel__body' + (hasOverride ? ' has-override' : '') + (state.locked ? ' is-locked' : '')}>
      <div className="attribute-panel__title">
        <span className="object-row__cat" title={cat.label}><Icon icon={cat.icon} /></span>
        <span className="object-row__name">{state.displayName}</span>
        {state.locked && <span className="lock-tag" title="已鎖定"><Icon icon={Lock} size="xs" /></span>}
        {hasOverride && <span className="override-dot" title="此 cue 把它放在自訂位置（跟其他 cue 獨立）" />}
      </div>

      {state.locked ? (
        <div className="muted small attribute-panel__locked">
          已鎖定，無法編輯。請到「物件」分頁按鎖頭圖示解鎖。
        </div>
      ) : (
        <>
          <div className="form-row">
            <label>位置</label>
            <div className="vec3">
              {POS_AXES.map(axis => (
                <NumberField
                  key={axis}
                  axisLabel={axis.toUpperCase()}
                  unit="m"
                  step={0.1}
                  value={sceneToMeters(eff.position[axis], scaleCorrection)}
                  disabled={!unitsReady}
                  disabledTitle="載入專案設定中…"
                  onInvalid={invalid}
                  onCommit={(m) => {
                    const v = metersToScene(m, scaleCorrection);
                    return save(cur => ({ position: { ...cur.position, [axis]: v } }));
                  }}
                />
              ))}
            </div>
          </div>
          <div className="form-row">
            <label>角度</label>
            <div className="vec3">
              {ROT_AXES.map(axis => (
                <NumberField
                  key={axis.key}
                  axisLabel={axis.label}
                  axisTitle={axis.title}
                  unit="°"
                  step={1}
                  value={eff.rotation[axis.key]}
                  onInvalid={invalid}
                  onCommit={(deg) => save(cur => ({ rotation: { ...cur.rotation, [axis.key]: deg } }))}
                />
              ))}
            </div>
          </div>
          <div className="muted small">改完按 Enter 或點別的地方就會存；Esc 取消；↑↓ 微調（按住 Shift 一次 10 倍）</div>
          {fieldError && <div className="field-error small" role="alert">{fieldError}</div>}
          <MechanismObjectHint objectId={state.objectId} />
          {hasOverride && (
            <div className="object-row__actions">
              <button className="btn btn--ghost" onClick={reset} disabled={busy} title="重置成預設位置">
                <Icon icon={RotateCcw} /> 重置
              </button>
            </div>
          )}
          {hasOverride && (
            <div className="muted small object-row__hint">
              這個 cue 有自己的設定（前面的 cue 不受影響；後面沒另外設定的 cue 會跟著）。原本的預設位置 ({meters(state.default.position.x)}, {meters(state.default.position.y)}, {meters(state.default.position.z)}) m
            </div>
          )}

          {stageObject && (
            <MaterialSection
              obj={stageObject}
              onUpdate={(patch) => onUpdateMaterial(state.objectId, patch)}
            />
          )}
          {stageObject && state.category === 'led_panel' && (
            <LedSection
              obj={stageObject}
              onUpdate={(patch) => onUpdateLed(state.objectId, patch)}
            />
          )}
        </>
      )}
    </div>
  );
}

function MaterialSection({ obj, onUpdate }: { obj: StageObject; onUpdate: (p: MaterialProps) => Promise<void> }) {
  const m = obj.materialProps || {};
  const [color, setColor] = useState(m.color || '#888888');
  const [roughness, setRoughness] = useState(m.roughness ?? 0.6);
  const [metalness, setMetalness] = useState(m.metalness ?? 0.1);
  const [opacity, setOpacity] = useState(m.opacity ?? 1.0);

  useEffect(() => {
    setColor(m.color || '#888888');
    setRoughness(m.roughness ?? 0.6);
    setMetalness(m.metalness ?? 0.1);
    setOpacity(m.opacity ?? 1.0);
  }, [obj.id, m.color, m.roughness, m.metalness, m.opacity]);

  function debouncedSave(patch: MaterialProps) {
    onUpdate(patch);
  }

  return (
    <div className="material-section">
      <div className="section-title"><Icon icon={Palette} /> 材質</div>
      <div className="form-row">
        <label>顏色</label>
        <div className="color-row">
          <input type="color" value={color}
            onChange={(e) => setColor(e.target.value)}
            onBlur={() => debouncedSave({ color })}
          />
          <span className="mono small muted">{color}</span>
        </div>
      </div>
      <div className="form-row">
        <label>粗糙度 Roughness: {roughness.toFixed(2)}</label>
        <input type="range" min={0} max={1} step={0.01}
          value={roughness}
          onChange={(e) => setRoughness(parseFloat(e.target.value))}
          onMouseUp={() => debouncedSave({ roughness })}
          onTouchEnd={() => debouncedSave({ roughness })}
        />
      </div>
      <div className="form-row">
        <label>金屬度 Metalness: {metalness.toFixed(2)}</label>
        <input type="range" min={0} max={1} step={0.01}
          value={metalness}
          onChange={(e) => setMetalness(parseFloat(e.target.value))}
          onMouseUp={() => debouncedSave({ metalness })}
          onTouchEnd={() => debouncedSave({ metalness })}
        />
      </div>
      <div className="form-row">
        <label>不透明度: {opacity.toFixed(2)}</label>
        <input type="range" min={0} max={1} step={0.01}
          value={opacity}
          onChange={(e) => setOpacity(parseFloat(e.target.value))}
          onMouseUp={() => debouncedSave({ opacity })}
          onTouchEnd={() => debouncedSave({ opacity })}
        />
      </div>
    </div>
  );
}

function LedSection({ obj, onUpdate }: { obj: StageObject; onUpdate: (p: LedProps) => Promise<void> }) {
  const led = obj.ledProps || {};
  const [brightness, setBrightness] = useState(led.brightness ?? 1.0);
  const [saturation, setSaturation] = useState(led.saturation ?? 1.0);
  const [hue, setHue] = useState(led.hue ?? 0);
  const [castStrength, setCastStrength] = useState(led.castLightStrength ?? 1.0);
  const [tint, setTint] = useState(led.tint || '#ffffff');
  const [imageUrl, setImageUrl] = useState(led.imageUrl || '');

  useEffect(() => {
    setBrightness(led.brightness ?? 1.0);
    setSaturation(led.saturation ?? 1.0);
    setHue(led.hue ?? 0);
    setCastStrength(led.castLightStrength ?? 1.0);
    setTint(led.tint || '#ffffff');
    setImageUrl(led.imageUrl || '');
  }, [obj.id, led.brightness, led.saturation, led.hue, led.castLightStrength, led.tint, led.imageUrl]);

  function save(patch: LedProps) { onUpdate(patch); }

  return (
    <div className="material-section material-section--led">
      <div className="section-title"><Icon icon={Lightbulb} /> LED 屬性</div>
      <div className="form-row">
        <label>亮度: {brightness.toFixed(2)} ×</label>
        <input type="range" min={0} max={3} step={0.05}
          value={brightness}
          onChange={(e) => setBrightness(parseFloat(e.target.value))}
          onMouseUp={() => save({ brightness })} onTouchEnd={() => save({ brightness })} />
      </div>
      <div className="form-row">
        <label>飽和度: {saturation.toFixed(2)} ×</label>
        <input type="range" min={0} max={2} step={0.05}
          value={saturation}
          onChange={(e) => setSaturation(parseFloat(e.target.value))}
          onMouseUp={() => save({ saturation })} onTouchEnd={() => save({ saturation })} />
      </div>
      <div className="form-row">
        <label>色相偏移: {hue}°</label>
        <input type="range" min={-180} max={180} step={1}
          value={hue}
          onChange={(e) => setHue(parseFloat(e.target.value))}
          onMouseUp={() => save({ hue })} onTouchEnd={() => save({ hue })} />
      </div>
      <div className="form-row">
        <label>色調 (Tint)</label>
        <div className="color-row">
          <input type="color" value={tint}
            onChange={(e) => setTint(e.target.value)}
            onBlur={() => save({ tint })} />
          <span className="mono small muted">{tint}</span>
        </div>
        <div className="color-swatches">
          {[
            { name: '白', val: '#ffffff' },
            { name: '紅', val: '#ff3838' },
            { name: '橘', val: '#ffaa44' },
            { name: '黃', val: '#ffd84a' },
            { name: '綠', val: '#10c78a' },
            { name: '青', val: '#22ccdd' },
            { name: '藍', val: '#5294ff' },
            { name: '紫', val: '#c264ff' },
            { name: '粉', val: '#ff64aa' },
          ].map(c => (
            <button
              key={c.val}
              type="button"
              className={'color-swatch' + (tint.toLowerCase() === c.val ? ' is-active' : '')}
              style={{ background: c.val }}
              onClick={() => { setTint(c.val); save({ tint: c.val }); }}
              title={`${c.name} ${c.val}`}
            />
          ))}
        </div>
      </div>
      <div className="form-row">
        <label>投光強度 (對周圍): {castStrength.toFixed(2)}</label>
        <input type="range" min={0} max={3} step={0.05}
          value={castStrength}
          onChange={(e) => setCastStrength(parseFloat(e.target.value))}
          onMouseUp={() => save({ castLightStrength: castStrength })}
          onTouchEnd={() => save({ castLightStrength: castStrength })} />
      </div>
      <div className="form-row">
        <label>貼圖 URL（測試用，CORS 友善的直連網址）</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            value={imageUrl}
            placeholder="https://picsum.photos/512  或留空"
            onChange={(e) => setImageUrl(e.target.value)}
            onBlur={() => save({ imageUrl: imageUrl.trim() })}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            style={{ flex: 1 }}
          />
          {imageUrl && (
            <button type="button" className="link-btn" onClick={() => { setImageUrl(''); save({ imageUrl: '' }); }}>清除</button>
          )}
        </div>
        <small className="muted">建議用可以直接打開的圖片網址（例如 imgur 的圖片連結）。3D 畫面切到「現場」模式才看得到。</small>
      </div>
      <div className="muted small">提示：要看到 LED 投光效果，把 3D 畫面上方的模式切到「現場」。</div>
    </div>
  );
}

function ObjectsManager({
  objects, status, onSeed, onAdd, onUpload, onShowVersions, onPickFromLibrary, hasModel,
  onRename, onChangeCategory, onToggleLock, onDelete,
}: {
  objects: StageObject[];
  status: LoadStatus;
  onSeed: () => void;
  onAdd: () => void;
  onUpload: () => void;
  onShowVersions: () => void;
  onPickFromLibrary: () => void;
  hasModel: boolean;
  onRename: (obj: StageObject) => void;
  onChangeCategory: (obj: StageObject, cat: StageObjectCategory) => void;
  onToggleLock: (obj: StageObject) => void;
  onDelete: (obj: StageObject) => void;
}) {
  return (
    <div className="objects-manager">
      <div className="objects-manager__bar">
        <button className="btn btn--primary" onClick={onUpload} title="從 .glb / .gltf 匯入"><Icon icon={Upload} /> 上傳模型</button>
        <button className="btn btn--ghost" onClick={onPickFromLibrary} title="從模型庫選一個模型（不用重複上傳）">
          <Icon icon={Library} /> 模型庫
        </button>
        <button
          className="btn btn--ghost"
          onClick={onShowVersions}
          disabled={!hasModel}
          title={hasModel ? '看以前上傳過的模型，可切回舊版' : '還沒上傳過模型'}
        >
          <Icon icon={HistoryIcon} /> 歷史版本
        </button>
        <button className="btn btn--ghost" onClick={onSeed} title="一鍵加入 10 個常用範例物件"><Icon icon={Sprout} /> 範例</button>
        <button className="btn btn--ghost" onClick={onAdd} title="手動新增單一物件"><Icon icon={Plus} /> 手動</button>
      </div>

      {status === 'loading' ? (
        <div className="editor-empty muted">載入中…</div>
      ) : status === 'error' && objects.length === 0 ? (
        <div className="editor-empty muted" role="alert">物件載入失敗，請重新整理頁面再試一次</div>
      ) : objects.length === 0 ? (
        <div className="editor-empty">
          <Icon icon={Shapes} size="xl" className="editor-empty__icon" />
          <div className="muted">還沒有物件</div>
          <small className="muted">點上方「範例」一鍵加入 10 個常用物件</small>
        </div>
      ) : (
        <ul className="object-mgr-list">
          {objects.map(o => (
            <li key={o.id} className={'object-mgr-row' + (o.locked ? ' is-locked' : '')}>
              <span className="object-row__cat" title={CATEGORY_INFO[o.category].label}><Icon icon={CATEGORY_INFO[o.category].icon} /></span>
              <div className="object-mgr-main">
                <div className="object-mgr-name">
                  {o.displayName}
                  {o.locked && <span className="lock-tag" title="已鎖定"><Icon icon={Lock} size="xs" /></span>}
                </div>
                <div className="muted small object-mgr-mesh">{o.meshName}</div>
              </div>
              <select
                className="object-mgr-cat"
                value={o.category}
                onChange={(e) => onChangeCategory(o, e.target.value as StageObjectCategory)}
                title="分類"
                disabled={o.locked}
              >
                {(Object.keys(CATEGORY_INFO) as StageObjectCategory[]).map(c => (
                  <option key={c} value={c}>{CATEGORY_INFO[c].label}</option>
                ))}
              </select>
              <div className="object-mgr-actions">
                <button
                  onClick={() => onToggleLock(o)}
                  title={o.locked ? '解鎖（可編輯）' : '鎖定（3D 不可選、屬性不可改）'}
                  aria-label={o.locked ? '解鎖' : '鎖定'}
                  className={o.locked ? 'is-locked-btn' : ''}
                >
                  <Icon icon={o.locked ? Lock : LockOpen} />
                </button>
                <button onClick={() => onRename(o)} title="改名" aria-label="改名" disabled={o.locked}><Icon icon={Pencil} /></button>
                <button onClick={() => onDelete(o)} title="刪除" aria-label="刪除"><Icon icon={Trash2} /></button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function msg(e: unknown) { return e instanceof Error ? e.message : String(e); }
function formatVideoTime(s: number): string {
  if (!isFinite(s) || s < 0) return '00:00';
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1);
  return `${String(m).padStart(2, '0')}:${sec.padStart(4, '0')}`;
}

/** 歌單上每首歌的影片：最新是哪一版、正在交的進度、＋加影片 */
function SongVideoMeta({ song, jobs, onAdd }: { song: Song; jobs: VideoJob[] | undefined; onAdd: () => void }) {
  const active = (jobs ?? []).filter(isJobActive);
  const failed = (jobs ?? []).find(j => j.phase === 'failed');
  return (
    <span className="song-item__video" onClick={(e) => e.stopPropagation()}>
      {active.length > 0 ? (
        <span className="song-item__video-job" title={active.map(j => `${j.name}：${jobStatusText(j)}`).join('\n')}>{jobStatusText(active[0])}</span>
      ) : failed ? (
        <span className="song-item__video-job is-error" title={failed.error ?? ''}>影片沒交成功</span>
      ) : song.latestVideoVersion ? (
        <span className="song-item__video-label" title="最新的影片版本">影片 V{song.latestVideoVersion}</span>
      ) : (
        <span className="song-item__video-none">還沒有影片</span>
      )}
      <button
        type="button"
        className="song-item__video-add"
        onClick={onAdd}
        title={`幫「${songTitle(song)}」加影片（上傳檔案或貼連結，好了變成下一個版本）`}
      >
        <Icon icon={Plus} size="xs" /> 加影片
      </button>
    </span>
  );
}

function StatusBadge({ value, onChange }: { value: SongStatus; onChange: (next: SongStatus) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const info = STATUS_INFO[value];
  return (
    <div className="status-badge-wrap" ref={ref}>
      <button
        className={`status-badge status-badge--${info.mod}`}
        onClick={() => setOpen(o => !o)}
        title="點擊切換狀態"
      >
        <span className="status-dot" />
        <span className="status-label">{info.label}</span>
      </button>
      {open && (
        <div className="status-menu" role="menu">
          {STATUS_ORDER.map(s => (
            <button
              key={s}
              role="menuitem"
              className={`status-menu__item${s === value ? ' is-current' : ''}`}
              onClick={() => { setOpen(false); if (s !== value) onChange(s); }}
            >
              <span className={`status-dot status-dot--${STATUS_INFO[s].mod}`} />
              <span>{STATUS_INFO[s].label}</span>
              {s === value && <span className="status-menu__check"><Icon icon={Check} /></span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusFilterChips({
  counts, total, value, onChange,
}: {
  counts: Record<SongStatus, number>;
  total: number;
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
}) {
  return (
    <div className="status-filter-chips" role="tablist" aria-label="依狀態篩選歌曲">
      <button
        role="tab"
        aria-selected={value === 'all'}
        className={'status-chip' + (value === 'all' ? ' is-active' : '')}
        onClick={() => onChange('all')}
      >
        全部 <span className="status-chip__count">{total}</span>
      </button>
      {STATUS_ORDER.map(s => (
        <button
          key={s}
          role="tab"
          aria-selected={value === s}
          className={`status-chip status-chip--${STATUS_INFO[s].mod}` + (value === s ? ' is-active' : '')}
          onClick={() => onChange(s)}
          title={STATUS_INFO[s].label}
        >
          <span className={`status-dot status-dot--${STATUS_INFO[s].mod}`} />
          <span className="status-chip__label">{STATUS_INFO[s].label}</span>
          <span className="status-chip__count">{counts[s]}</span>
        </button>
      ))}
    </div>
  );
}
