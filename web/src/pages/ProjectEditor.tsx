import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { Song, Cue, CueState, StageObject, StageObjectCategory, Vec3, Euler } from '../lib/api';
import StageScene from '../components/StageScene';
import UploadModelDialog from '../components/UploadModelDialog';
import './ProjectEditor.css';

type RightTab = 'cues' | 'state' | 'proposals' | 'objects';

const CATEGORY_INFO: Record<StageObjectCategory, { icon: string; label: string }> = {
  led_panel:  { icon: '🟦', label: 'LED 面板' },
  mechanism:  { icon: '⚙️', label: '機關' },
  walk_point: { icon: '📍', label: '走位點' },
  fixture:    { icon: '💡', label: '燈光/道具' },
  performer:  { icon: '🧍', label: '表演者' },
  other:      { icon: '⬜', label: '其他' },
};

export default function ProjectEditor() {
  const { projectId } = useParams();
  const navigate = useNavigate();

  // Songs
  const [songs, setSongs] = useState<Song[]>([]);
  const [songsLoading, setSongsLoading] = useState(true);
  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);

  // Cues
  const [cues, setCues] = useState<Cue[]>([]);
  const [cuesLoading, setCuesLoading] = useState(false);
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);

  // Stage objects (project-level)
  const [stageObjects, setStageObjects] = useState<StageObject[]>([]);

  // Cue object states (per selected cue)
  const [cueStates, setCueStates] = useState<CueState[]>([]);
  const [statesLoading, setStatesLoading] = useState(false);

  // Selected object (synced between 3D viewport and right panel accordion)
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);

  const [rightTab, setRightTab] = useState<RightTab>('cues');
  const [uploadOpen, setUploadOpen] = useState(false);

  // ── Loaders ──
  const refreshSongs = useCallback(async () => {
    if (!projectId) return;
    setSongsLoading(true);
    try {
      const list = await api.listSongs(projectId);
      setSongs(list);
      setSelectedSongId(prev => prev || (list[0]?.id ?? null));
    } catch (e) {
      alert('載入歌曲失敗：' + (e instanceof Error ? e.message : String(e)));
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
      setStageObjects(list);
    } catch (e) {
      console.warn('load stage objects failed', e);
    }
  }, [projectId]);

  const refreshCueStates = useCallback(async () => {
    if (!projectId || !selectedSongId || !selectedCueId) { setCueStates([]); return; }
    setStatesLoading(true);
    try {
      const list = await api.listCueStates(projectId, selectedSongId, selectedCueId);
      setCueStates(list);
    } catch (e) {
      console.warn('load cue states failed', e);
    } finally {
      setStatesLoading(false);
    }
  }, [projectId, selectedSongId, selectedCueId]);

  useEffect(() => { refreshSongs(); refreshStageObjects(); }, [refreshSongs, refreshStageObjects]);
  useEffect(() => { refreshCues(); }, [refreshCues]);
  useEffect(() => { refreshCueStates(); }, [refreshCueStates]);

  // ── Derived ──
  const masterCues = useMemo(() => cues.filter(c => c.status === 'master'), [cues]);
  const proposalCues = useMemo(() => cues.filter(c => c.status === 'proposal'), [cues]);
  const selectedCue = useMemo(() => cues.find(c => c.id === selectedCueId) || null, [cues, selectedCueId]);
  const selectedSong = useMemo(() => songs.find(s => s.id === selectedSongId) || null, [songs, selectedSongId]);

  // viewport 用的 states：有 cue 用 cueStates，沒 cue 用 stageObjects 的 default 假裝成 state
  const viewportStates: CueState[] = useMemo(() => {
    if (selectedCueId && cueStates.length > 0) return cueStates;
    return stageObjects.map(o => ({
      objectId: o.id,
      meshName: o.meshName,
      displayName: o.displayName,
      category: o.category,
      order: o.order,
      default: { position: o.defaultPosition, rotation: o.defaultRotation, scale: o.defaultScale },
      override: null,
      effective: { position: o.defaultPosition, rotation: o.defaultRotation, scale: o.defaultScale, visible: true },
    }));
  }, [selectedCueId, cueStates, stageObjects]);

  // ── Song actions ──
  async function handleAddSong() {
    if (!projectId) return;
    const name = prompt('新增歌曲名稱（例：S03 主題曲）')?.trim();
    if (!name) return;
    try { await api.createSong(projectId, name); await refreshSongs(); }
    catch (e) { alert('新增失敗：' + msg(e)); }
  }
  async function handleRenameSong(songId: string, currentName: string) {
    if (!projectId) return;
    const name = prompt('改名稱', currentName)?.trim();
    if (!name || name === currentName) return;
    try { await api.updateSong(projectId, songId, { name }); await refreshSongs(); }
    catch (e) { alert('改名失敗：' + msg(e)); }
  }
  async function handleDeleteSong(songId: string, name: string) {
    if (!projectId) return;
    if (!confirm(`刪除歌曲「${name}」？這會連同它的所有 cue 一起刪掉。`)) return;
    try {
      await api.deleteSong(projectId, songId);
      if (selectedSongId === songId) setSelectedSongId(null);
      await refreshSongs();
    } catch (e) { alert('刪除失敗：' + msg(e)); }
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
    catch (e) { alert('排序失敗：' + msg(e)); await refreshSongs(); }
  }

  // ── Cue actions ──
  async function handleAddBlankCue() {
    if (!projectId || !selectedSongId) return;
    const defaultName = `Cue ${cues.length + 1}`;
    const name = prompt('新增空白 cue（全部用 default）— 名稱：', defaultName)?.trim();
    if (!name) return;
    try { await api.createCue(projectId, selectedSongId, { name }); await refreshCues(); setRightTab('cues'); }
    catch (e) { alert('新增失敗：' + msg(e)); }
  }
  async function handleCloneCue(sourceCueId?: string) {
    if (!projectId || !selectedSongId) return;
    const src = sourceCueId
      ? cues.find(c => c.id === sourceCueId)
      : (selectedCue);
    if (!src) { alert('沒有選中的 cue 可沿用，請先在左側選一個 cue'); return; }
    const defaultName = `${src.name} (副本)`;
    const name = prompt(`沿用「${src.name}」— 新 cue 名稱：`, defaultName)?.trim();
    if (!name) return;
    try {
      await api.createCue(projectId, selectedSongId, { name, cloneFrom: src.id });
      await refreshCues();
      setRightTab('cues');
    } catch (e) { alert('沿用失敗：' + msg(e)); }
  }
  async function handleSnapshotCue() {
    if (!projectId || !selectedSongId) return;
    if (viewportStates.length === 0) { alert('沒有物件可 snapshot'); return; }
    const defaultName = selectedCue ? `${selectedCue.name} (snapshot)` : `Cue ${cues.length + 1}`;
    const name = prompt('從目前 3D 狀態建立 cue — 名稱：', defaultName)?.trim();
    if (!name) return;
    try {
      const snapshotStates = viewportStates.map(s => ({
        objectId: s.objectId,
        position: s.effective.position,
        rotation: s.effective.rotation,
      }));
      await api.createCue(projectId, selectedSongId, { name, snapshotStates });
      await refreshCues();
      setRightTab('cues');
    } catch (e) { alert('snapshot 失敗：' + msg(e)); }
  }
  async function handleDuplicateCueQuick(cueId: string) {
    if (!projectId || !selectedSongId) return;
    const src = cues.find(c => c.id === cueId);
    if (!src) return;
    try {
      await api.createCue(projectId, selectedSongId, { name: `${src.name} (副本)`, cloneFrom: cueId });
      await refreshCues();
    } catch (e) { alert('複製失敗：' + msg(e)); }
  }
  async function handleResetCue(cueId: string, name: string) {
    if (!projectId || !selectedSongId) return;
    if (!confirm(`重置「${name}」cue 的所有物件 override？這會把所有物件回到 default。`)) return;
    try {
      await api.resetCue(projectId, selectedSongId, cueId);
      await refreshCueStates();
    } catch (e) { alert('重置失敗：' + msg(e)); }
  }
  async function handleRenameCue(cueId: string, currentName: string) {
    if (!projectId || !selectedSongId) return;
    const name = prompt('改名稱', currentName)?.trim();
    if (!name || name === currentName) return;
    try {
      await api.updateCue(projectId, selectedSongId, cueId, { name });
      await refreshCues();
    } catch (e) { alert('改名失敗：' + msg(e)); }
  }
  async function handleDeleteCue(cueId: string, name: string) {
    if (!projectId || !selectedSongId) return;
    if (!confirm(`刪除 cue「${name}」？`)) return;
    try {
      await api.deleteCue(projectId, selectedSongId, cueId);
      if (selectedCueId === cueId) setSelectedCueId(null);
      await refreshCues();
    } catch (e) { alert('刪除失敗：' + msg(e)); }
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
    } catch (e) { alert('排序失敗：' + msg(e)); }
  }
  async function handleUpdateCueMeta(patch: Partial<Pick<Cue, 'name' | 'crossfadeSeconds'>>) {
    if (!projectId || !selectedSongId || !selectedCueId) return;
    try {
      await api.updateCue(projectId, selectedSongId, selectedCueId, patch);
      await refreshCues();
    } catch (e) { alert('更新 cue 失敗：' + msg(e)); }
  }

  // ── Cue state (per object override) actions ──
  async function handleSetState(objId: string, patch: Partial<{ position: Vec3; rotation: Euler; visible: boolean }>) {
    if (!projectId) return;
    // 沒選 cue 時 → 改 stage_object 的 default（影響所有 cue 預設值）
    if (!selectedCueId) {
      const objPatch: any = {};
      if ('position' in patch) objPatch.defaultPosition = patch.position;
      if ('rotation' in patch) objPatch.defaultRotation = patch.rotation;
      await api.updateStageObject(projectId, objId, objPatch);
      await refreshStageObjects();
      return;
    }
    if (!selectedSongId) return;
    await api.setCueState(projectId, selectedSongId, selectedCueId, objId, patch);
    await refreshCueStates();
  }
  async function handleResetState(objId: string) {
    if (!projectId || !selectedSongId || !selectedCueId) return;
    if (!confirm('重置這個物件回 default？')) return;
    await api.resetCueState(projectId, selectedSongId, selectedCueId, objId);
    await refreshCueStates();
  }

  // ── Stage object actions ──
  async function handleSeedObjects() {
    if (!projectId) return;
    if (!confirm('一鍵塞入 10 個常用物件範例（SKY、LED-1~4、樂手 LED、旋轉舞臺、升降台、走位）？')) return;
    try {
      const r = await api.seedDefaultStageObjects(projectId);
      alert(`已新增 ${r.inserted} 個範例物件`);
      await refreshStageObjects();
      await refreshCueStates();
    } catch (e) { alert('失敗：' + msg(e)); }
  }
  async function handleAddObject() {
    if (!projectId) return;
    const meshName = prompt('Mesh 名稱（對應 .glb 內的 mesh）')?.trim();
    if (!meshName) return;
    const displayName = prompt('顯示名稱（顯示用、可留空）', meshName)?.trim() || meshName;
    try {
      await api.createStageObject(projectId, { meshName, displayName, category: 'other' });
      await refreshStageObjects();
      await refreshCueStates();
    } catch (e) { alert('失敗：' + msg(e)); }
  }
  async function handleRenameObject(obj: StageObject) {
    if (!projectId) return;
    const displayName = prompt('改顯示名稱', obj.displayName)?.trim();
    if (!displayName || displayName === obj.displayName) return;
    try {
      await api.updateStageObject(projectId, obj.id, { displayName });
      await refreshStageObjects();
      await refreshCueStates();
    } catch (e) { alert('失敗：' + msg(e)); }
  }
  async function handleChangeCategory(obj: StageObject, category: StageObjectCategory) {
    if (!projectId) return;
    try {
      await api.updateStageObject(projectId, obj.id, { category });
      await refreshStageObjects();
      await refreshCueStates();
    } catch (e) { alert('失敗：' + msg(e)); }
  }
  async function handleDeleteObject(obj: StageObject) {
    if (!projectId) return;
    if (!confirm(`刪除物件「${obj.displayName}」？這會連同所有 cue 對它的 override 一起刪掉。`)) return;
    try {
      await api.deleteStageObject(projectId, obj.id);
      await refreshStageObjects();
      await refreshCueStates();
    } catch (e) { alert('失敗：' + msg(e)); }
  }

  return (
    <div className="editor">
      {/* Top */}
      <header className="editor-topbar">
        <button className="editor-back" onClick={() => navigate('/admin')} title="返回專案總覽">←</button>
        <div className="editor-breadcrumb">
          <span className="muted">專案</span>
          <span className="sep">/</span>
          <span className="strong">{projectId}</span>
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
          <span className="muted small">{stageObjects.length} 物件</span>
        </div>
      </header>

      <div className="editor-body">
        {/* Left — songs */}
        <aside className="editor-songs">
          <div className="editor-songs__header">
            <h3>歌曲</h3>
            <span className="muted">{songs.length} 首</span>
          </div>

          {songsLoading ? (
            <div className="editor-empty muted">載入中…</div>
          ) : songs.length === 0 ? (
            <div className="editor-empty">
              <div style={{ fontSize: 36 }}>🎵</div>
              <div>還沒有歌曲</div>
              <small className="muted">點下方按鈕新增第一首</small>
            </div>
          ) : (
            <ul className="song-list">
              {songs.map((s, i) => (
                <li
                  key={s.id}
                  className={'song-item' + (selectedSongId === s.id ? ' is-active' : '')}
                  onClick={() => setSelectedSongId(s.id)}
                >
                  <div className="song-item__order">{String(i + 1).padStart(2, '0')}</div>
                  <div className="song-item__main">
                    <div className="song-item__name">{s.name}</div>
                    <div className="song-item__meta">
                      <span>{s.cueCount} cues</span>
                      {s.proposalCount > 0 && <span className="proposal-badge">{s.proposalCount} 提案</span>}
                    </div>
                  </div>
                  <div className="song-item__actions" onClick={(e) => e.stopPropagation()}>
                    <button title="上移" onClick={() => moveSong(s.id, -1)} disabled={i === 0}>↑</button>
                    <button title="下移" onClick={() => moveSong(s.id, 1)} disabled={i === songs.length - 1}>↓</button>
                    <button title="改名" onClick={() => handleRenameSong(s.id, s.name)}>✎</button>
                    <button title="刪除" onClick={() => handleDeleteSong(s.id, s.name)}>🗑</button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <button className="btn btn--ghost editor-songs__add" onClick={handleAddSong}>＋ 新增歌曲</button>
        </aside>

        {/* Center — 3D viewport（永遠顯示；沒 cue 時編輯 = 改 default） */}
        <section className="editor-viewport">
          {stageObjects.length === 0 ? (
            <div className="viewport-stage">
              <div className="viewport-placeholder">
                <div style={{ fontSize: 64, opacity: 0.4 }}>📦</div>
                <div className="muted">這個專案還沒有物件</div>
                <small className="muted">右側「物件」分頁 → 上傳模型或一鍵範例</small>
              </div>
            </div>
          ) : (
            <StageScene
              states={viewportStates}
              selectedObjectId={selectedObjectId}
              onSelect={(id) => {
                setSelectedObjectId(id);
                if (id) setRightTab('state');
              }}
              onTransform={async (objId, position, rotation) => {
                await handleSetState(objId, { position, rotation });
              }}
              cueName={selectedCue ? selectedCue.name : '(default — 改的是物件預設位置)'}
            />
          )}
        </section>

        {/* Right — Cue panel */}
        <aside className="editor-cues">
          <div className="editor-cues__tabs">
            {([
              ['cues',      `Cue (${masterCues.length})`],
              ['state',     '物件狀態'],
              ['proposals', `提案${proposalCues.length > 0 ? ` (${proposalCues.length})` : ''}`],
              ['objects',   `物件 (${stageObjects.length})`],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                className={'tab' + (rightTab === key ? ' is-active' : '')}
                onClick={() => setRightTab(key)}
              >{label}</button>
            ))}
          </div>

          <div className="editor-cues__body">
            {!selectedSongId ? (
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
                onDuplicateQuick={handleDuplicateCueQuick}
                onReset={handleResetCue}
                onRename={handleRenameCue}
                onDelete={handleDeleteCue}
                onMove={moveCue}
              />
            ) : rightTab === 'state' ? (
              <ObjectStateEditor
                cue={selectedCue}
                states={cueStates}
                loading={statesLoading}
                stageObjects={stageObjects}
                selectedObjectId={selectedObjectId}
                onSelectObject={setSelectedObjectId}
                onSet={handleSetState}
                onReset={handleResetState}
                onUpdateCueMeta={handleUpdateCueMeta}
                onJumpToObjects={() => setRightTab('objects')}
              />
            ) : rightTab === 'proposals' ? (
              <CueList
                cues={proposalCues}
                loading={cuesLoading}
                selectedId={selectedCueId}
                onSelect={(id) => { setSelectedCueId(id); setRightTab('state'); }}
                onDelete={handleDeleteCue}
                emptyText="尚無提案"
              />
            ) : (
              <ObjectsManager
                objects={stageObjects}
                onSeed={handleSeedObjects}
                onAdd={handleAddObject}
                onUpload={() => setUploadOpen(true)}
                onRename={handleRenameObject}
                onChangeCategory={handleChangeCategory}
                onDelete={handleDeleteObject}
              />
            )}
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
        }}
      />
    </div>
  );
}

// ──────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────

function CueList({
  cues, loading, selectedId, onSelect, onAddBlank, onClone, onSnapshot, onDuplicateQuick,
  onReset, onRename, onDelete, onMove, emptyText,
}: {
  cues: Cue[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddBlank?: () => void;
  onClone?: (sourceCueId?: string) => void;
  onSnapshot?: () => void;
  onDuplicateQuick?: (cueId: string) => void;
  onReset?: (cueId: string, name: string) => void;
  onRename?: (cueId: string, name: string) => void;
  onDelete: (id: string, name: string) => void;
  onMove?: (cueId: string, direction: -1 | 1) => void;
  emptyText?: string;
}) {
  if (loading) return <div className="editor-empty muted">載入中…</div>;
  return (
    <>
      {cues.length === 0 ? (
        <div className="editor-empty">
          <div style={{ fontSize: 36 }}>🎬</div>
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
                  cross {c.crossfadeSeconds}s
                  {c.status === 'proposal' && <span className="proposal-tag">提案</span>}
                </div>
              </div>
              <div className="cue-item__actions" onClick={(e) => e.stopPropagation()}>
                {onMove && <>
                  <button title="上移" onClick={() => onMove(c.id, -1)} disabled={i === 0}>↑</button>
                  <button title="下移" onClick={() => onMove(c.id, 1)} disabled={i === cues.length - 1}>↓</button>
                </>}
                {onDuplicateQuick && <button title="一鍵複製" onClick={() => onDuplicateQuick(c.id)}>📋</button>}
                {onReset && <button title="重置（清掉所有 override）" onClick={() => onReset(c.id, c.name)}>↺</button>}
                {onRename && <button title="改名" onClick={() => onRename(c.id, c.name)}>✎</button>}
                <button title="刪除" onClick={() => onDelete(c.id, c.name)}>🗑</button>
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
          hasSelectedCue={!!selectedId}
        />
      )}
    </>
  );
}

function CueAddSplitButton({
  onAddBlank, onClone, onSnapshot, hasSelectedCue,
}: {
  onAddBlank: () => void;
  onClone?: (id?: string) => void;
  onSnapshot?: () => void;
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
      <button className="cue-split__main btn btn--primary" onClick={onAddBlank} title="新增空白 cue（全部用 default）">
        ＋ 新增 cue
      </button>
      <button className="cue-split__caret btn btn--primary" onClick={() => setOpen(o => !o)} aria-label="更多新增方式">
        ▾
      </button>
      {open && (
        <div className="cue-split__menu">
          <button onClick={() => { setOpen(false); onAddBlank(); }}>
            <span>🆕 空白 cue</span>
            <small>全部用 default 位置</small>
          </button>
          <button
            onClick={() => { setOpen(false); onClone && onClone(); }}
            disabled={!onClone || !hasSelectedCue}
            title={!hasSelectedCue ? '先在左側選一個 cue' : ''}
          >
            <span>📋 沿用當前 cue</span>
            <small>{hasSelectedCue ? '複製當前 cue 的所有 override' : '需先選一個 cue'}</small>
          </button>
          <button onClick={() => { setOpen(false); onSnapshot && onSnapshot(); }} disabled={!onSnapshot}>
            <span>📸 從目前 3D 狀態建立</span>
            <small>capture 現在 viewport 看到的位置</small>
          </button>
        </div>
      )}
    </div>
  );
}

function ObjectStateEditor({
  cue, states, loading, stageObjects, selectedObjectId, onSelectObject,
  onSet, onReset, onUpdateCueMeta, onJumpToObjects,
}: {
  cue: Cue | null;
  states: CueState[];
  loading: boolean;
  stageObjects: StageObject[];
  selectedObjectId: string | null;
  onSelectObject: (id: string | null) => void;
  onSet: (objId: string, patch: Partial<{ position: Vec3; rotation: Euler; visible: boolean }>) => Promise<void>;
  onReset: (objId: string) => Promise<void>;
  onUpdateCueMeta: (patch: Partial<Pick<Cue, 'name' | 'crossfadeSeconds'>>) => Promise<void>;
  onJumpToObjects: () => void;
}) {
  if (!cue) return <div className="editor-empty muted">先選一個 cue</div>;
  if (loading) return <div className="editor-empty muted">載入物件狀態中…</div>;
  if (stageObjects.length === 0) {
    return (
      <div className="editor-empty">
        <div style={{ fontSize: 36 }}>🧩</div>
        <div>這個專案還沒有物件</div>
        <small className="muted">先到「物件」分頁新增 / 一鍵範例</small>
        <button className="btn btn--primary" style={{ marginTop: 12 }} onClick={onJumpToObjects}>
          管理物件 →
        </button>
      </div>
    );
  }

  return (
    <div className="state-editor">
      <CueMetaEditor cue={cue} onUpdate={onUpdateCueMeta} />
      <ul className="object-state-list">
        {states.map(s => (
          <ObjectStateRow
            key={s.objectId}
            state={s}
            forceOpen={s.objectId === selectedObjectId}
            onClickHeader={() => onSelectObject(s.objectId === selectedObjectId ? null : s.objectId)}
            onSet={onSet}
            onReset={onReset}
          />
        ))}
      </ul>
    </div>
  );
}

function CueMetaEditor({
  cue, onUpdate,
}: {
  cue: Cue;
  onUpdate: (patch: Partial<Pick<Cue, 'name' | 'crossfadeSeconds'>>) => Promise<void>;
}) {
  const [name, setName] = useState(cue.name);
  const [crossfade, setCrossfade] = useState(cue.crossfadeSeconds);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(cue.name);
    setCrossfade(cue.crossfadeSeconds);
  }, [cue.id, cue.name, cue.crossfadeSeconds]);

  const dirty = name !== cue.name || crossfade !== cue.crossfadeSeconds;

  async function save() {
    if (!dirty) return;
    setSaving(true);
    try {
      const patch: Partial<Pick<Cue, 'name' | 'crossfadeSeconds'>> = {};
      if (name !== cue.name) patch.name = name.trim().slice(0, 100);
      if (crossfade !== cue.crossfadeSeconds) patch.crossfadeSeconds = Math.max(0, crossfade);
      await onUpdate(patch);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cue-meta-editor">
      <div className="cue-meta-editor__row">
        <label>當前 cue 名稱</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          maxLength={100}
        />
      </div>
      <div className="cue-meta-editor__row">
        <label>淡入淡出時間（秒）</label>
        <input
          type="number"
          step={0.1}
          min={0}
          value={crossfade}
          onChange={(e) => setCrossfade(parseFloat(e.target.value) || 0)}
          onBlur={save}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
        <small className="muted">0 = 硬切；大於 0 時 cue 切換用此秒數漸變</small>
      </div>
      {dirty && (
        <button className="btn btn--primary cue-meta-editor__save" onClick={save} disabled={saving}>
          {saving ? '儲存中…' : '💾 儲存變更'}
        </button>
      )}
    </div>
  );
}

function ObjectStateRow({
  state, forceOpen, onClickHeader, onSet, onReset,
}: {
  state: CueState;
  forceOpen: boolean;
  onClickHeader: () => void;
  onSet: (objId: string, patch: Partial<{ position: Vec3; rotation: Euler; visible: boolean }>) => Promise<void>;
  onReset: (objId: string) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const cat = CATEGORY_INFO[state.category];
  const hasOverride = !!state.override;
  const rowRef = useRef<HTMLLIElement>(null);

  // accordion 只跟 selectedObjectId 走 — 點 header 等同切換選取
  useEffect(() => {
    if (forceOpen) rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [forceOpen]);

  const isOpen = forceOpen;
  const eff = state.effective;
  const [pos, setPos] = useState<Vec3>(eff.position);
  const [rot, setRot] = useState<Euler>(eff.rotation);

  useEffect(() => {
    setPos(eff.position);
    setRot(eff.rotation);
  }, [state.objectId, eff.position.x, eff.position.y, eff.position.z, eff.rotation.pitch, eff.rotation.yaw, eff.rotation.roll]);

  async function save() {
    try {
      setSaving(true);
      await onSet(state.objectId, { position: pos, rotation: rot });
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setSaving(true);
    try { await onReset(state.objectId); } finally { setSaving(false); }
  }

  return (
    <li
      ref={rowRef}
      className={'object-row' + (hasOverride ? ' has-override' : '') + (forceOpen ? ' is-selected' : '')}
    >
      <header className="object-row__head" onClick={onClickHeader}>
        <span className="object-row__cat" title={cat.label}>{cat.icon}</span>
        <span className="object-row__name">{state.displayName}</span>
        {hasOverride && <span className="override-dot" title="此 cue 有覆蓋" />}
        <span className="object-row__chev">{isOpen ? '▾' : '▸'}</span>
      </header>
      {isOpen && (
        <div className="object-row__body">
          <div className="form-row">
            <label>Position (X / Y / Z)</label>
            <div className="vec3">
              {(['x', 'y', 'z'] as const).map(axis => (
                <input
                  key={axis}
                  type="number"
                  step={0.1}
                  value={pos[axis]}
                  onChange={(e) => setPos({ ...pos, [axis]: parseFloat(e.target.value) || 0 })}
                  placeholder={axis.toUpperCase()}
                />
              ))}
            </div>
          </div>
          <div className="form-row">
            <label>Rotation (P / Y / R)</label>
            <div className="vec3">
              {(['pitch', 'yaw', 'roll'] as const).map(axis => (
                <input
                  key={axis}
                  type="number"
                  step={1}
                  value={rot[axis]}
                  onChange={(e) => setRot({ ...rot, [axis]: parseFloat(e.target.value) || 0 })}
                  placeholder={axis[0].toUpperCase()}
                />
              ))}
            </div>
          </div>
          <div className="object-row__actions">
            <button className="btn btn--primary" onClick={save} disabled={saving}>
              {saving ? '儲存中…' : '💾 儲存'}
            </button>
            {hasOverride && (
              <button className="btn btn--ghost" onClick={reset} disabled={saving} title="重置成 default">
                ↺ 重置
              </button>
            )}
          </div>
          {hasOverride && (
            <div className="muted small object-row__hint">
              📍 此 cue 有覆蓋；default 是 ({state.default.position.x}, {state.default.position.y}, {state.default.position.z})
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function ObjectsManager({
  objects, onSeed, onAdd, onUpload, onRename, onChangeCategory, onDelete,
}: {
  objects: StageObject[];
  onSeed: () => void;
  onAdd: () => void;
  onUpload: () => void;
  onRename: (obj: StageObject) => void;
  onChangeCategory: (obj: StageObject, cat: StageObjectCategory) => void;
  onDelete: (obj: StageObject) => void;
}) {
  return (
    <div className="objects-manager">
      <div className="objects-manager__bar">
        <button className="btn btn--primary" onClick={onUpload} title="從 .glb / .gltf 匯入">📦 上傳模型</button>
        <button className="btn btn--ghost" onClick={onSeed} title="塞入 10 個常用範例">🌱 範例</button>
        <button className="btn btn--ghost" onClick={onAdd} title="手動新增單一物件">＋ 手動</button>
      </div>

      {objects.length === 0 ? (
        <div className="editor-empty">
          <div style={{ fontSize: 36 }}>🧩</div>
          <div className="muted">還沒有物件</div>
          <small className="muted">點上方「一鍵範例」塞入 10 個常用物件</small>
        </div>
      ) : (
        <ul className="object-mgr-list">
          {objects.map(o => (
            <li key={o.id} className="object-mgr-row">
              <span className="object-row__cat">{CATEGORY_INFO[o.category].icon}</span>
              <div className="object-mgr-main">
                <div className="object-mgr-name">{o.displayName}</div>
                <div className="muted small object-mgr-mesh">{o.meshName}</div>
              </div>
              <select
                className="object-mgr-cat"
                value={o.category}
                onChange={(e) => onChangeCategory(o, e.target.value as StageObjectCategory)}
                title="分類"
              >
                {(Object.keys(CATEGORY_INFO) as StageObjectCategory[]).map(c => (
                  <option key={c} value={c}>{CATEGORY_INFO[c].icon} {CATEGORY_INFO[c].label}</option>
                ))}
              </select>
              <div className="object-mgr-actions">
                <button onClick={() => onRename(o)} title="改名">✎</button>
                <button onClick={() => onDelete(o)} title="刪除">🗑</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function msg(e: unknown) { return e instanceof Error ? e.message : String(e); }
