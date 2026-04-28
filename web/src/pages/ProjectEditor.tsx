import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import * as api from '../lib/api';
import type { Song, Cue } from '../lib/api';
import './ProjectEditor.css';

type RightTab = 'list' | 'props' | 'proposals';

export default function ProjectEditor() {
  const { projectId } = useParams();
  const navigate = useNavigate();

  const [songs, setSongs] = useState<Song[]>([]);
  const [songsLoading, setSongsLoading] = useState(true);
  const [selectedSongId, setSelectedSongId] = useState<string | null>(null);

  const [cues, setCues] = useState<Cue[]>([]);
  const [cuesLoading, setCuesLoading] = useState(false);
  const [selectedCueId, setSelectedCueId] = useState<string | null>(null);

  const [rightTab, setRightTab] = useState<RightTab>('list');

  const refreshSongs = useCallback(async () => {
    if (!projectId) return;
    setSongsLoading(true);
    try {
      const list = await api.listSongs(projectId);
      setSongs(list);
      // 自動選第一首（如果還沒選）
      setSelectedSongId(prev => prev || (list[0]?.id ?? null));
    } catch (e) {
      alert('載入歌曲失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSongsLoading(false);
    }
  }, [projectId]);

  const refreshCues = useCallback(async () => {
    if (!projectId || !selectedSongId) { setCues([]); return; }
    setCuesLoading(true);
    try {
      const list = await api.listCues(projectId, selectedSongId);
      setCues(list);
      setSelectedCueId(prev => list.find(c => c.id === prev) ? prev : (list[0]?.id ?? null));
    } catch (e) {
      console.error('load cues failed:', e);
    } finally {
      setCuesLoading(false);
    }
  }, [projectId, selectedSongId]);

  useEffect(() => { refreshSongs(); }, [refreshSongs]);
  useEffect(() => { refreshCues(); }, [refreshCues]);

  const masterCues = useMemo(() => cues.filter(c => c.status === 'master'), [cues]);
  const proposalCues = useMemo(() => cues.filter(c => c.status === 'proposal'), [cues]);
  const selectedCue = useMemo(() => cues.find(c => c.id === selectedCueId) || null, [cues, selectedCueId]);

  // ── Song 操作 ──
  async function handleAddSong() {
    if (!projectId) return;
    const name = prompt('新增歌曲名稱（例：S03 主題曲）')?.trim();
    if (!name) return;
    try {
      await api.createSong(projectId, name);
      await refreshSongs();
    } catch (e) {
      alert('新增失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }
  async function handleRenameSong(songId: string, currentName: string) {
    if (!projectId) return;
    const name = prompt('改名稱', currentName)?.trim();
    if (!name || name === currentName) return;
    try {
      await api.updateSong(projectId, songId, { name });
      await refreshSongs();
    } catch (e) {
      alert('改名失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }
  async function handleDeleteSong(songId: string, name: string) {
    if (!projectId) return;
    if (!confirm(`刪除歌曲「${name}」？這會連同它的所有 cue 一起刪掉。`)) return;
    try {
      await api.deleteSong(projectId, songId);
      if (selectedSongId === songId) setSelectedSongId(null);
      await refreshSongs();
    } catch (e) {
      alert('刪除失敗：' + (e instanceof Error ? e.message : String(e)));
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
    try {
      await api.reorderSongs(projectId, reordered.map(s => s.id));
    } catch (e) {
      alert('排序失敗：' + (e instanceof Error ? e.message : String(e)));
      await refreshSongs();
    }
  }

  // ── Cue 操作 ──
  async function handleAddCue() {
    if (!projectId || !selectedSongId) return;
    const name = prompt('新增 cue 名稱（例：開場燈光）')?.trim();
    if (!name) return;
    try {
      await api.createCue(projectId, selectedSongId, { name });
      await refreshCues();
      setRightTab('list');
    } catch (e) {
      alert('新增 cue 失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }
  async function handleDeleteCue(cueId: string, name: string) {
    if (!projectId || !selectedSongId) return;
    if (!confirm(`刪除 cue「${name}」？`)) return;
    try {
      await api.deleteCue(projectId, selectedSongId, cueId);
      if (selectedCueId === cueId) setSelectedCueId(null);
      await refreshCues();
    } catch (e) {
      alert('刪除失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function handleSaveCue(patch: Partial<Cue>) {
    if (!projectId || !selectedSongId || !selectedCueId) return;
    try {
      await api.updateCue(projectId, selectedSongId, selectedCueId, patch);
      await refreshCues();
    } catch (e) {
      alert('儲存失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  return (
    <div className="editor">
      {/* 頂列 */}
      <header className="editor-topbar">
        <button className="editor-back" onClick={() => navigate('/admin')} title="返回專案總覽">←</button>
        <div className="editor-breadcrumb">
          <span className="muted">專案</span>
          <span className="sep">/</span>
          <span className="strong">{projectId}</span>
        </div>
        <div className="editor-topbar__right">
          <span className="save-indicator">● 已同步</span>
        </div>
      </header>

      <div className="editor-body">
        {/* 左 — 歌曲列表 */}
        <aside className="editor-songs">
          <div className="editor-songs__header">
            <h3>歌曲列表</h3>
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
                      {s.proposalCount > 0 && (
                        <span className="proposal-badge">{s.proposalCount} 提案</span>
                      )}
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

          <button className="btn btn--ghost editor-songs__add" onClick={handleAddSong}>
            ＋ 新增歌曲
          </button>
        </aside>

        {/* 中 — 3D viewport（B2 才接 Three.js） */}
        <section className="editor-viewport">
          <div className="viewport-toolbar">
            <span className="muted">攝影機預設</span>
            {['前台', '舞臺左', '舞臺右', '俯瞰', '表演者'].map(p => (
              <button key={p} className="cam-chip">{p}</button>
            ))}
            <span className="grow" />
            <span className="fps">FPS: --</span>
          </div>

          <div className="viewport-stage">
            <div className="viewport-placeholder">
              <div style={{ fontSize: 64, opacity: 0.4 }}>🎭</div>
              <div className="muted">3D 預覽（B2 階段加入 Three.js）</div>
              {selectedCue && (
                <div className="viewport-cue-info">
                  <div className="strong">{selectedCue.name}</div>
                  <div className="muted small">
                    pos ({selectedCue.position.x.toFixed(1)}, {selectedCue.position.y.toFixed(1)}, {selectedCue.position.z.toFixed(1)})
                    · FOV {selectedCue.fov}°
                    · cross {selectedCue.crossfadeSeconds}s
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="viewport-timeline">
            <span className="muted small">時間軸（B2 階段加入）</span>
          </div>
        </section>

        {/* 右 — Cue panel */}
        <aside className="editor-cues">
          <div className="editor-cues__tabs">
            {([
              ['list', `Cue 列表 (${masterCues.length})`],
              ['props', '屬性'],
              ['proposals', `提案${proposalCues.length > 0 ? ` (${proposalCues.length})` : ''}`],
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
            ) : rightTab === 'list' ? (
              <CueList
                cues={masterCues}
                loading={cuesLoading}
                selectedId={selectedCueId}
                onSelect={setSelectedCueId}
                onAdd={handleAddCue}
                onDelete={handleDeleteCue}
              />
            ) : rightTab === 'props' ? (
              <CuePropsForm
                cue={selectedCue}
                onSave={handleSaveCue}
              />
            ) : (
              <CueList
                cues={proposalCues}
                loading={cuesLoading}
                selectedId={selectedCueId}
                onSelect={setSelectedCueId}
                onAdd={null}
                onDelete={handleDeleteCue}
                emptyText="尚無提案"
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

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
                  FOV {c.fov}° · cross {c.crossfadeSeconds}s
                  {c.status === 'proposal' && <span className="proposal-tag">提案</span>}
                </div>
              </div>
              <button className="cue-item__del" onClick={(e) => { e.stopPropagation(); onDelete(c.id, c.name); }} title="刪除">🗑</button>
            </li>
          ))}
        </ul>
      )}
      {onAdd && (
        <button className="btn btn--primary editor-cues__add" onClick={onAdd}>
          ＋ 新增 cue
        </button>
      )}
    </>
  );
}

function CuePropsForm({ cue, onSave }: { cue: Cue | null; onSave: (patch: Partial<Cue>) => Promise<void> }) {
  const [draft, setDraft] = useState<Partial<Cue> | null>(null);

  useEffect(() => {
    if (cue) setDraft({
      name: cue.name,
      position: cue.position,
      rotation: cue.rotation,
      fov: cue.fov,
      crossfadeSeconds: cue.crossfadeSeconds,
    });
    else setDraft(null);
  }, [cue?.id]);

  if (!cue || !draft) {
    return <div className="editor-empty muted">先在「Cue 列表」選一個 cue</div>;
  }

  function patch<K extends keyof Cue>(key: K, value: Cue[K]) {
    setDraft(prev => ({ ...(prev || {}), [key]: value }));
  }

  async function save() {
    if (draft) await onSave(draft);
  }

  return (
    <div className="cue-props">
      <div className="form-row">
        <label>名稱</label>
        <input
          type="text"
          value={draft.name || ''}
          onChange={(e) => patch('name', e.target.value)}
          maxLength={100}
        />
      </div>

      <div className="form-row">
        <label>位置 (X / Y / Z)</label>
        <div className="vec3">
          {(['x', 'y', 'z'] as const).map(axis => (
            <input
              key={axis}
              type="number"
              step={0.1}
              value={draft.position?.[axis] ?? 0}
              onChange={(e) => patch('position', { ...(draft.position || { x: 0, y: 0, z: 0 }), [axis]: parseFloat(e.target.value) || 0 })}
              placeholder={axis.toUpperCase()}
            />
          ))}
        </div>
      </div>

      <div className="form-row">
        <label>旋轉 (Pitch / Yaw / Roll)</label>
        <div className="vec3">
          {(['pitch', 'yaw', 'roll'] as const).map(axis => (
            <input
              key={axis}
              type="number"
              step={1}
              value={draft.rotation?.[axis] ?? 0}
              onChange={(e) => patch('rotation', { ...(draft.rotation || { pitch: 0, yaw: 0, roll: 0 }), [axis]: parseFloat(e.target.value) || 0 })}
              placeholder={axis}
            />
          ))}
        </div>
      </div>

      <div className="form-row">
        <label>FOV: {draft.fov}°</label>
        <input
          type="range"
          min={20}
          max={120}
          step={1}
          value={draft.fov ?? 60}
          onChange={(e) => patch('fov', parseFloat(e.target.value))}
        />
      </div>

      <div className="form-row">
        <label>淡入淡出時間 (s)</label>
        <input
          type="number"
          step={0.1}
          min={0}
          value={draft.crossfadeSeconds ?? 0}
          onChange={(e) => patch('crossfadeSeconds', parseFloat(e.target.value) || 0)}
        />
      </div>

      <button className="btn btn--primary cue-props__save" onClick={save}>
        💾 儲存 cue
      </button>
    </div>
  );
}
