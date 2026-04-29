import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { Song, Cue, CueState, StageObject, StageObjectCategory, Vec3, Euler } from '../lib/api';
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

  const [rightTab, setRightTab] = useState<RightTab>('cues');

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
  async function handleAddCue() {
    if (!projectId || !selectedSongId) return;
    const name = prompt('新增 cue 名稱（例：開場、副歌爆破）')?.trim();
    if (!name) return;
    try { await api.createCue(projectId, selectedSongId, { name }); await refreshCues(); setRightTab('cues'); }
    catch (e) { alert('新增 cue 失敗：' + msg(e)); }
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

  // ── Cue state (per object override) actions ──
  async function handleSetState(objId: string, patch: Partial<{ position: Vec3; rotation: Euler; visible: boolean }>) {
    if (!projectId || !selectedSongId || !selectedCueId) return;
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

        {/* Center — viewport placeholder + selected cue summary */}
        <section className="editor-viewport">
          <div className="viewport-toolbar">
            <span className="muted">攝影機預設</span>
            {['前台', '舞臺左', '舞臺右', '俯瞰', '表演者'].map(p => (
              <button key={p} className="cam-chip">{p}</button>
            ))}
            <span className="grow" />
            <span className="fps">B2: 3D viewport</span>
          </div>

          <div className="viewport-stage">
            <div className="viewport-placeholder">
              <div style={{ fontSize: 64, opacity: 0.4 }}>🎭</div>
              <div className="muted">3D 預覽（B2 階段加入 Three.js）</div>
              {selectedCue ? (
                <div className="viewport-cue-info">
                  <div className="strong">{selectedCue.name}</div>
                  <div className="muted small">
                    {cueStates.length} 物件 · {cueStates.filter(s => s.override).length} 有覆蓋
                  </div>
                </div>
              ) : (
                <small className="muted">先在右側選一個 cue</small>
              )}
            </div>
          </div>
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
                onAdd={handleAddCue}
                onDelete={handleDeleteCue}
              />
            ) : rightTab === 'state' ? (
              <ObjectStateEditor
                cue={selectedCue}
                states={cueStates}
                loading={statesLoading}
                stageObjects={stageObjects}
                onSet={handleSetState}
                onReset={handleResetState}
                onJumpToObjects={() => setRightTab('objects')}
              />
            ) : rightTab === 'proposals' ? (
              <CueList
                cues={proposalCues}
                loading={cuesLoading}
                selectedId={selectedCueId}
                onSelect={(id) => { setSelectedCueId(id); setRightTab('state'); }}
                onAdd={null}
                onDelete={handleDeleteCue}
                emptyText="尚無提案"
              />
            ) : (
              <ObjectsManager
                objects={stageObjects}
                onSeed={handleSeedObjects}
                onAdd={handleAddObject}
                onRename={handleRenameObject}
                onChangeCategory={handleChangeCategory}
                onDelete={handleDeleteObject}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────
// Sub-components
// ──────────────────────────────────────────────────

function CueList({
  cues, loading, selectedId, onSelect, onAdd, onDelete, emptyText,
}: {
  cues: Cue[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: (() => void) | null;
  onDelete: (id: string, name: string) => void;
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
              <button className="cue-item__del" onClick={(e) => { e.stopPropagation(); onDelete(c.id, c.name); }} title="刪除">🗑</button>
            </li>
          ))}
        </ul>
      )}
      {onAdd && <button className="btn btn--primary editor-cues__add" onClick={onAdd}>＋ 新增 cue</button>}
    </>
  );
}

function ObjectStateEditor({
  cue, states, loading, stageObjects, onSet, onReset, onJumpToObjects,
}: {
  cue: Cue | null;
  states: CueState[];
  loading: boolean;
  stageObjects: StageObject[];
  onSet: (objId: string, patch: Partial<{ position: Vec3; rotation: Euler; visible: boolean }>) => Promise<void>;
  onReset: (objId: string) => Promise<void>;
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
      <div className="state-editor__cue">
        <span className="muted small">當前 cue：</span>
        <span className="strong">{cue.name}</span>
      </div>
      <ul className="object-state-list">
        {states.map(s => (
          <ObjectStateRow key={s.objectId} state={s} onSet={onSet} onReset={onReset} />
        ))}
      </ul>
    </div>
  );
}

function ObjectStateRow({
  state, onSet, onReset,
}: {
  state: CueState;
  onSet: (objId: string, patch: Partial<{ position: Vec3; rotation: Euler; visible: boolean }>) => Promise<void>;
  onReset: (objId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const cat = CATEGORY_INFO[state.category];
  const hasOverride = !!state.override;

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
    <li className={'object-row' + (hasOverride ? ' has-override' : '')}>
      <header className="object-row__head" onClick={() => setOpen(o => !o)}>
        <span className="object-row__cat" title={cat.label}>{cat.icon}</span>
        <span className="object-row__name">{state.displayName}</span>
        {hasOverride && <span className="override-dot" title="此 cue 有覆蓋" />}
        <span className="object-row__chev">{open ? '▾' : '▸'}</span>
      </header>
      {open && (
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
  objects, onSeed, onAdd, onRename, onChangeCategory, onDelete,
}: {
  objects: StageObject[];
  onSeed: () => void;
  onAdd: () => void;
  onRename: (obj: StageObject) => void;
  onChangeCategory: (obj: StageObject, cat: StageObjectCategory) => void;
  onDelete: (obj: StageObject) => void;
}) {
  return (
    <div className="objects-manager">
      <div className="objects-manager__bar">
        <button className="btn btn--ghost" onClick={onSeed}>🌱 一鍵範例</button>
        <button className="btn btn--primary" onClick={onAdd}>＋ 新增物件</button>
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
