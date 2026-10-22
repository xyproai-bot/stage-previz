// 右邊「Cue 庫」分頁：專案所有 Cue 庫的 cue，搜尋 / 篩選 / 預覽 / 改名稱與編號 / 誰在用 / 刪除。規格 5.2、第 10 節。
// 只在 Cue 庫模式的專案出現。點一列 = 在 3D 預覽這個 cue 的畫面，不改任何歌。

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Hash, Library, ListMusic, Pencil, RotateCcw, Search, Trash2, X } from 'lucide-react';
import Icon from './Icon';
import OverflowMenu from './OverflowMenu';
import type { LibraryCue, LibraryCueUsage } from '../lib/cueLibraryApi';
import { filterLibraryCues, fmtTime, usageLabel, type LibraryFilter } from '../lib/cueLibraryList';
import { labelError, LABEL_MAX } from '../lib/lookDraft';
import './CueLibraryTab.css';

interface Props {
  cues: LibraryCue[];
  loading: boolean;
  /** 舞台上現在看的 Cue 庫的 cue */
  shownId: string | null;
  /** 現在是不是「只預覽」（這首歌沒有用到它） */
  previewing: boolean;
  /** 點一列：預覽 */
  onSelect: (id: string) => void;
  onCopy: (lc: LibraryCue) => void;
  /** 回 null = 改好了；回文字 = 錯誤 */
  onRename: (lc: LibraryCue, name: string) => Promise<string | null>;
  onRelabel: (lc: LibraryCue, label: string) => Promise<string | null>;
  onDelete: (lc: LibraryCue) => void;
  onResetAll: (lc: LibraryCue) => void;
  /** 點誰在用的連結：跳去那首歌的那個 cue */
  onJump: (songId: string, cueId: string) => void;
  /** 底下的「另存成新的 cue」（從目前舞台） */
  onSaveAs: () => void;
  busy: boolean;
}

function UsageLinks({ usage, onJump }: { usage: LibraryCueUsage; onJump: Props['onJump'] }) {
  if (usage.slots.length === 0) return <span className="cue-lib__nouse">沒有歌在用</span>;
  return (
    <>
      {usage.slots.map((s, i) => (
        <span key={s.cueId}>
          {i > 0 && '、'}
          <button type="button" className="cue-lib__link" onClick={() => onJump(s.songId, s.cueId)} title={`跳到 ${s.songName} 的這個 cue`}>
            {s.songCode || s.songName}{s.videoTimeSec !== null ? ` ${fmtTime(s.videoTimeSec)}` : ''}
          </button>
        </span>
      ))}
    </>
  );
}

export default function CueLibraryTab({ cues, loading, shownId, previewing, onSelect, onCopy, onRename, onRelabel, onDelete, onResetAll, onJump, onSaveAs, busy }: Props) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [editing, setEditing] = useState<{ id: string; field: 'name' | 'label' } | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => filterLibraryCues(cues, query, filter), [cues, query, filter]);
  const current = cues.find(c => c.id === shownId) ?? null;

  useEffect(() => { if (editing) setTimeout(() => inputRef.current?.select(), 20); }, [editing]);
  // 正在改的那個 cue 不見了（被刪 / 重新讀）→ 收起來
  useEffect(() => { if (editing && !cues.some(c => c.id === editing.id)) setEditing(null); }, [cues, editing]);
  // 目前選的在清單裡捲到看得見（J / K 切換時）
  useEffect(() => {
    if (!shownId) return;
    document.querySelector<HTMLElement>(`[data-libcue="${CSS.escape(shownId)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [shownId]);

  function startEdit(lc: LibraryCue, field: 'name' | 'label') {
    setEditing({ id: lc.id, field });
    setDraft(field === 'name' ? lc.name : lc.label);
    setError(null);
  }
  const editingCue = editing ? cues.find(c => c.id === editing.id) ?? null : null;
  const localError = editing && editingCue
    ? (editing.field === 'label'
      ? labelError(draft, cues.filter(c => c.id !== editingCue.id).map(c => c.label))
      : (draft.trim() ? null : '名稱不能空白'))
    : null;

  async function commit() {
    if (!editing || !editingCue || saving) return;
    if (localError) { setError(localError); return; }
    const value = draft.trim();
    if (value === (editing.field === 'name' ? editingCue.name : editingCue.label)) { setEditing(null); return; }
    setSaving(true);
    const err = await (editing.field === 'name' ? onRename(editingCue, value) : onRelabel(editingCue, value));
    setSaving(false);
    if (err) setError(err); else setEditing(null);
  }

  return (
    <div className="cue-lib">
      <div className="cue-lib__tools">
        <label className="cue-lib__search">
          <Icon icon={Search} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="找 cue（編號或名稱）"
            aria-label="找 cue（編號或名稱）"
          />
        </label>
        <div className="cue-lib__chips" role="group" aria-label="篩選">
          {([['all', '全部'], ['unused', '沒有歌在用']] as const).map(([k, l]) => (
            <button key={k} type="button" className={'cue-lib__chip' + (filter === k ? ' is-active' : '')} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
      </div>

      {current && (
        <div className="cue-lib__now" role="status">
          <strong>正在看 Cue 庫：Cue {current.label}「{current.name}」</strong>
          <span className="cue-lib__nowsub">
            用在：<UsageLinks usage={current.usage} onJump={onJump} />
          </span>
          {previewing && <span className="cue-lib__nowsub">只是預覽，沒有改任何一首歌。在 3D 上改東西會變成「還沒存的改動」。</span>}
        </div>
      )}

      <div className="cue-lib__list" role="listbox" aria-label="Cue 庫的 cue">
        {loading && cues.length === 0 ? (
          <div className="editor-empty muted">載入中…</div>
        ) : cues.length === 0 ? (
          <div className="editor-empty">
            <Icon icon={Library} size="xl" className="editor-empty__icon" />
            <div>Cue 庫還是空的</div>
            <small className="muted">先把舞台擺好，按下面的「另存成新的 cue」。</small>
          </div>
        ) : shown.length === 0 ? (
          <div className="editor-empty muted">沒有符合的 cue</div>
        ) : shown.map(lc => {
          const isEditing = editing?.id === lc.id;
          const used = lc.usage.slotCount > 0;
          return (
            <div
              key={lc.id}
              data-libcue={lc.id}
              role="option"
              aria-selected={lc.id === shownId}
              className={'cue-lib__row' + (lc.id === shownId ? ' is-selected' : '')}
              onClick={() => { if (!isEditing) onSelect(lc.id); }}
            >
              {isEditing && editing.field === 'label' ? (
                <input
                  ref={inputRef}
                  className="cue-lib__edit cue-lib__edit--label"
                  value={draft}
                  maxLength={LABEL_MAX + 8}
                  aria-label="編號"
                  aria-invalid={!!localError}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => { setDraft(e.target.value); setError(null); }}
                  onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void commit(); else if (e.key === 'Escape') setEditing(null); }}
                />
              ) : (
                <span className="cue-lib__badge" title="編號">{lc.label}</span>
              )}
              <div className="cue-lib__main">
                {isEditing && editing.field === 'name' ? (
                  <input
                    ref={inputRef}
                    className="cue-lib__edit"
                    value={draft}
                    aria-label="名稱"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => { setDraft(e.target.value); setError(null); }}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void commit(); else if (e.key === 'Escape') setEditing(null); }}
                  />
                ) : (
                  <span className="cue-lib__name">{lc.name}</span>
                )}
                <span className={'cue-lib__use' + (used ? '' : ' is-unused')}>{usageLabel(lc.usage)}</span>
                {isEditing && (
                  <span className="cue-lib__editbar" onClick={(e) => e.stopPropagation()}>
                    {(error || localError) && <span className="cue-lib__error" role="alert">{error || localError}</span>}
                    <button type="button" className="btn btn--sm btn--primary" onClick={() => void commit()} disabled={saving || !!localError}><Icon icon={Check} /> 存</button>
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(null)} disabled={saving}><Icon icon={X} /> 取消</button>
                  </span>
                )}
              </div>
              <span onClick={(e) => e.stopPropagation()}>
                <OverflowMenu
                  label={`Cue ${lc.label} 的更多動作`}
                  align="auto"
                  items={[
                    { key: 'copy', label: '另存 / 複製成新的 cue', icon: Copy, onSelect: () => onCopy(lc) },
                    { key: 'rename', label: '改名稱', icon: Pencil, onSelect: () => startEdit(lc, 'name') },
                    { key: 'relabel', label: '改編號', icon: Hash, onSelect: () => startEdit(lc, 'label') },
                    { key: 'usage', label: '哪幾首歌在用', icon: ListMusic, onSelect: () => onSelect(lc.id) },
                    { key: 'reset', label: '這個 cue 全部回到預設', icon: RotateCcw, onSelect: () => onResetAll(lc), disabled: busy, separatorBefore: true },
                    { key: 'delete', label: used ? '刪除（還有歌在用）' : '刪除', icon: Trash2, danger: true, onSelect: () => onDelete(lc), disabled: busy },
                  ]}
                />
              </span>
            </div>
          );
        })}
      </div>

      <div className="cue-lib__foot">
        <button type="button" className="btn btn--sm btn--ghost" onClick={onSaveAs} disabled={busy}><Icon icon={Copy} /> 另存成新的 cue</button>
        <span className="cue-lib__hint">J / K 照編號上下切換</span>
      </div>
    </div>
  );
}
