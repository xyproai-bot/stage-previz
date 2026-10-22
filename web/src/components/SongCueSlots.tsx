// 「這首歌的 cue」（Cue 庫專案）：每列 = 時間 + Cue 庫編號 + Cue 庫名稱，照時間排。規格 5.3、第 10 節。
// 加 cue 從 Cue 庫選；每列「⋯」可以改時間 / 改轉場 / 換成別的 cue / 複製成新的 cue（只改這首歌）/ 拿掉（Cue 庫裡還在）。

import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Bookmark, BookmarkPlus, Check, Clapperboard, Clock, Copy, Library, Plus, Repeat, RotateCcw, Timer, Trash2, X } from 'lucide-react';
import Icon from './Icon';
import OverflowMenu, { type OverflowItem } from './OverflowMenu';
import type { Cue } from '../lib/api';
import type { LibraryCue } from '../lib/cueLibraryApi';
import { crossfadeLabel, parseCrossfadeInput, parseVideoTimeInput } from '../lib/cueTiming';
import { EMPTY_LIBRARY_TEXT, EMPTY_SONG_TEXT, fmtSlotTime, OUT_OF_ORDER_TEXT, slotsOutOfOrder, timeTaken, timeTakenText } from '../lib/songSlots';
import { RESET_ALL_MENU_LABEL } from '../lib/cueResetAll';
import './LookDraftBar.css';
import './AddSongCueDialog.css';

interface Props {
  cues: Cue[];
  loading: boolean;
  selectedId: string | null;
  libCues: LibraryCue[];
  libLoading: boolean;
  onSelect: (id: string) => void;
  onAdd: () => void;
  /** 從常用擺位建立新 cue（套進草稿再另存） */
  onNewFromTemplate?: () => void;
  /** 回 null = 改好了；回文字 = 錯誤 */
  onChangeTime: (cue: Cue, sec: number | null) => Promise<string | null>;
  onChangeFade: (cue: Cue, sec: number) => Promise<string | null>;
  onSwap: (cue: Cue) => void;
  onCopyNew: (cue: Cue) => void;
  onRemove: (cue: Cue) => void;
  onSaveTemplate: (cue: Cue) => void;
  onShowInLibrary: (libraryCueId: string) => void;
  onMove: (cueId: string, direction: -1 | 1) => void;
  onResortNow: () => void;
  onResetAllObjects: () => void;
  busy: boolean;
}

export default function SongCueSlots({
  cues, loading, selectedId, libCues, libLoading, onSelect, onAdd, onNewFromTemplate, onChangeTime, onChangeFade, onSwap, onCopyNew, onRemove,
  onSaveTemplate, onShowInLibrary, onMove, onResortNow, onResetAllObjects, busy,
}: Props) {
  const [editing, setEditing] = useState<{ id: string; field: 'time' | 'fade' } | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) setTimeout(() => inputRef.current?.select(), 20); }, [editing]);
  useEffect(() => { if (editing && !cues.some(c => c.id === editing.id)) setEditing(null); }, [cues, editing]);

  const libById = new Map(libCues.map(l => [l.id, l]));
  const outOfOrder = slotsOutOfOrder(cues);

  function startEdit(c: Cue, field: 'time' | 'fade') {
    setEditing({ id: c.id, field });
    setDraft(field === 'time' ? (c.videoTimeSec === null ? '' : fmtSlotTime(c.videoTimeSec)) : String(c.crossfadeSeconds));
    setError(null);
  }
  const editCue = editing ? cues.find(c => c.id === editing.id) ?? null : null;

  // 打的內容有什麼問題（沒問題 = null）
  let localError: string | null = null;
  let parsed: { time?: number | null; fade?: number } = {};
  if (editing && editCue) {
    if (editing.field === 'time') {
      const r = parseVideoTimeInput(draft);
      if (!r.ok) localError = '時間要填像 15.5 或 1:23 這樣（空白 = 不對應影片時間）';
      else if (r.value !== null && r.value > 36000) localError = '時間最多 10 小時';
      else if (r.value !== null && timeTaken(cues, r.value, editCue.id)) localError = timeTakenText(r.value);
      else parsed = { time: r.value };
    } else {
      const n = parseCrossfadeInput(draft);
      if (n === null) localError = '轉場秒數要填 0 或正的數字';
      else parsed = { fade: n };
    }
  }

  async function commit() {
    if (!editing || !editCue || saving) return;
    if (localError) { setError(localError); return; }
    if (editing.field === 'time' && parsed.time === editCue.videoTimeSec) { setEditing(null); return; }
    if (editing.field === 'fade' && parsed.fade === editCue.crossfadeSeconds) { setEditing(null); return; }
    setSaving(true);
    const err = editing.field === 'time' ? await onChangeTime(editCue, parsed.time ?? null) : await onChangeFade(editCue, parsed.fade ?? 0);
    setSaving(false);
    if (err) setError(err); else setEditing(null);
  }

  function rowMenu(c: Cue): OverflowItem[] {
    const items: OverflowItem[] = [
      { key: 'time', label: '改時間', icon: Clock, onSelect: () => startEdit(c, 'time') },
      { key: 'fade', label: '改轉場', icon: Timer, onSelect: () => startEdit(c, 'fade') },
      { key: 'swap', label: '換成別的 cue', icon: Repeat, onSelect: () => onSwap(c), disabled: busy },
      { key: 'copy', label: '複製成新的 cue（只改這首歌）', icon: Copy, onSelect: () => onCopyNew(c), disabled: busy || !c.libraryCueId },
      { key: 'show', label: '在 Cue 庫裡看', icon: Library, onSelect: () => { if (c.libraryCueId) onShowInLibrary(c.libraryCueId); }, disabled: !c.libraryCueId },
      { key: 'tpl', label: '存成常用擺位', icon: BookmarkPlus, onSelect: () => onSaveTemplate(c) },
    ];
    if (c.videoTimeSec === null) {
      const i = cues.findIndex(x => x.id === c.id);
      items.push({ key: 'up', label: '上移', icon: ArrowUp, disabled: i <= 0, separatorBefore: true, onSelect: () => onMove(c.id, -1) });
      items.push({ key: 'down', label: '下移', icon: ArrowDown, disabled: i >= cues.length - 1, onSelect: () => onMove(c.id, 1) });
    }
    items.push({ key: 'remove', label: '拿掉（Cue 庫裡還在）', icon: Trash2, danger: true, separatorBefore: true, onSelect: () => onRemove(c), disabled: busy });
    return items;
  }

  if (loading) return <div className="editor-empty muted">載入中…</div>;

  return (
    <div className="song-slots">
      {outOfOrder && (
        <div className="song-slots__notice" role="status">
          <span>{OUT_OF_ORDER_TEXT}</span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={onResortNow} disabled={busy}>現在照時間排</button>
        </div>
      )}
      {cues.length === 0 ? (
        <div className="editor-empty">
          <Icon icon={Clapperboard} size="xl" className="editor-empty__icon" />
          <div className="muted">{!libLoading && libCues.length === 0 ? EMPTY_LIBRARY_TEXT : EMPTY_SONG_TEXT}</div>
        </div>
      ) : (
        <ul className="cue-list">
          {cues.map(c => {
            const lc = c.libraryCueId ? libById.get(c.libraryCueId) : undefined;
            const label = c.libraryCue?.label ?? lc?.label ?? '';
            const name = c.libraryCue?.name ?? lc?.name ?? c.name;
            const isEditing = editing?.id === c.id;
            return (
              <li
                key={c.id}
                data-slot={c.id}
                className={'cue-item' + (selectedId === c.id ? ' is-active' : '')}
                onClick={() => { if (!isEditing) onSelect(c.id); }}
              >
                <div className="song-slots__time" title="這個 cue 在影片的第幾秒切進來">{c.videoTimeSec === null ? '—' : fmtSlotTime(c.videoTimeSec)}</div>
                {label ? <span className="slot-badge" title="Cue 庫編號">{label}</span> : <span className="slot-badge" title="沒有指到 Cue 庫">?</span>}
                <div className="cue-item__main">
                  <div className="cue-item__name">{name}</div>
                  <div className="cue-item__meta muted small">
                    {c.videoTimeSec === null && '沒有時間 · '}{crossfadeLabel(c.crossfadeSeconds)}
                    {lc && lc.usage.songCount > 1 && <span className="song-slots__shared">{lc.usage.songCount} 首歌在用</span>}
                  </div>
                  {isEditing && editing && (
                    <div className="song-slots__edit" onClick={(e) => e.stopPropagation()}>
                      <input
                        ref={inputRef}
                        value={draft}
                        aria-label={editing.field === 'time' ? '時間' : '轉場秒數'}
                        aria-invalid={!!localError}
                        placeholder={editing.field === 'time' ? '例：1:23' : '秒'}
                        onChange={(e) => { setDraft(e.target.value); setError(null); }}
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void commit(); else if (e.key === 'Escape') setEditing(null); }}
                      />
                      <button type="button" className="btn btn--sm btn--primary" onClick={() => void commit()} disabled={saving || !!localError}><Icon icon={Check} /> 存</button>
                      <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(null)} disabled={saving}><Icon icon={X} /> 取消</button>
                      {(error || localError) && <span className="song-slots__error" role="alert">{error || localError}</span>}
                    </div>
                  )}
                </div>
                <div className="cue-item__more" onClick={(e) => e.stopPropagation()}>
                  <OverflowMenu label={`Cue ${label}「${name}」的動作`} items={rowMenu(c)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="editor-cues__footer">
        <button type="button" className="btn btn--primary editor-cues__add" onClick={onAdd} disabled={busy}>
          <Icon icon={Plus} /> 從 Cue 庫加 cue
        </button>
        <OverflowMenu
          label="這首歌所有 cue 的動作"
          items={[
            ...(onNewFromTemplate ? [{ key: 'newFromTpl', label: '從常用擺位建立新 cue', icon: Bookmark, disabled: busy, onSelect: onNewFromTemplate }] : []),
            { key: 'resetAll', label: RESET_ALL_MENU_LABEL, icon: RotateCcw, disabled: cues.length === 0, onSelect: onResetAllObjects },
          ]}
        />
      </div>
    </div>
  );
}
