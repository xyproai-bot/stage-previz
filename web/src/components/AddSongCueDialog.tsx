// 「加 cue」/「換成別的 cue」：從 Cue 庫選一個 cue（可搜尋編號或名稱），加 cue 時再設時間和轉場。規格 5.3。

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import Icon from './Icon';
import type { LibraryCue } from '../lib/cueLibraryApi';
import { filterLibraryCues, usageLabel } from '../lib/cueLibraryList';
import { parseCrossfadeInput, parseVideoTimeInput } from '../lib/cueTiming';
import { timeTaken, timeTakenText, type SlotLike } from '../lib/songSlots';
import './NewProjectDialog.css';
import './LookDraftBar.css';
import './AddSongCueDialog.css';

/** crossfadeSeconds 沒給 = 這首歌的這個 cue 用 Cue 庫的轉場 */
export interface AddSongCueValue { libraryCueId: string; videoTimeSec: number | null; crossfadeSeconds?: number }

interface Props {
  mode: 'add' | 'swap';
  libCues: LibraryCue[];
  /** 這首歌現有的 cue（檢查同時間） */
  slots: SlotLike[];
  /** 一開始選好的 Cue 庫的 cue（從 Cue 庫分頁「加到這首歌」進來時） */
  initialLibraryCueId?: string | null;
  /** 換成別的 cue 時：原本指到的（標出來，不能選同一個） */
  currentLibraryCueId?: string | null;
  defaultTimeSec?: number;
  /** 回 null = 成功（關掉）；回文字 = 要顯示的錯誤 */
  onSubmit: (v: AddSongCueValue) => Promise<string | null>;
  onCancel: () => void;
}

export default function AddSongCueDialog({ mode, libCues, slots, initialLibraryCueId, currentLibraryCueId, defaultTimeSec = 0, onSubmit, onCancel }: Props) {
  const [query, setQuery] = useState('');
  const [pick, setPick] = useState<string | null>(initialLibraryCueId ?? null);
  const [timeText, setTimeText] = useState(() => {
    const s = Math.floor(defaultTimeSec);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });
  const [noTime, setNoTime] = useState(false);
  const [fade, setFade] = useState('');   // 空白 = 用 Cue 庫的轉場
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => searchRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [onCancel, busy]);

  const shown = useMemo(() => filterLibraryCues(libCues, query, 'all'), [libCues, query]);

  const parsedTime = parseVideoTimeInput(timeText);
  let timeErr: string | null = null;
  let timeValue: number | null = null;
  if (mode === 'add' && !noTime) {
    if (!parsedTime.ok || parsedTime.value === null) timeErr = '時間要填像 15.5 或 1:23 這樣';
    else if (parsedTime.value > 36000) timeErr = '時間最多 10 小時';
    else if (timeTaken(slots, parsedTime.value)) timeErr = timeTakenText(parsedTime.value);
    else timeValue = parsedTime.value;
  }
  const fadeValue = fade.trim() === '' ? undefined : parseCrossfadeInput(fade);
  const fadeErr = mode === 'add' && fadeValue === null ? '轉場秒數要填 0 或正的數字，或留空用 Cue 庫的' : null;
  const pickedLib = libCues.find(l => l.id === pick);
  const sameAsCurrent = mode === 'swap' && !!pick && pick === currentLibraryCueId;
  const canSubmit = !!pick && !timeErr && !fadeErr && !sameAsCurrent && !busy;

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!canSubmit || !pick) return;
    setBusy(true);
    setServerError(null);
    try {
      const err = await onSubmit({ libraryCueId: pick, videoTimeSec: mode === 'add' && !noTime ? timeValue : null, ...(typeof fadeValue === 'number' ? { crossfadeSeconds: fadeValue } : {}) });
      if (err) setServerError(err);
    } finally { setBusy(false); }
  }

  return (
    <div className="dialog-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div className="dialog add-slot-dlg" role="dialog" aria-modal="true" aria-labelledby="add-slot-title" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2 id="add-slot-title">{mode === 'add' ? '加 cue' : '換成別的 cue'}</h2>
          <button className="dialog__close" onClick={onCancel} disabled={busy} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <form className="dialog__body" onSubmit={submit}>
          <label className="add-slot-dlg__search">
            <Icon icon={Search} />
            <input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="找 cue（編號或名稱）" aria-label="找 cue（編號或名稱）" />
          </label>
          <div className="add-slot-dlg__list" role="listbox" aria-label="Cue 庫的 cue">
            {libCues.length === 0 ? (
              <div className="add-slot-dlg__empty muted">Cue 庫還是空的：先把舞台擺好，按「另存成新的 cue」。</div>
            ) : shown.length === 0 ? (
              <div className="add-slot-dlg__empty muted">沒有符合的 cue</div>
            ) : shown.map(lc => (
              <button
                key={lc.id}
                type="button"
                role="option"
                aria-selected={pick === lc.id}
                className={'add-slot-dlg__opt' + (pick === lc.id ? ' is-selected' : '')}
                onClick={() => { setPick(lc.id); setServerError(null); }}
                onDoubleClick={() => { setPick(lc.id); }}
              >
                <span className="slot-badge">{lc.label}</span>
                <span className="add-slot-dlg__name">{lc.name}</span>
                <span className="add-slot-dlg__use muted">{lc.id === currentLibraryCueId ? '目前用的' : usageLabel(lc.usage)}</span>
              </button>
            ))}
          </div>
          {sameAsCurrent && <div className="cue-save-dlg__error">這個已經是目前用的 cue，請選別的</div>}

          {mode === 'add' && (
            <>
              <div className="add-slot-dlg__row">
                <label htmlFor="add-slot-time">時間</label>
                <input id="add-slot-time" value={timeText} disabled={noTime} onChange={(e) => { setTimeText(e.target.value); setServerError(null); }} placeholder="例：1:23" aria-invalid={!!timeErr} />
                <label className="add-slot-dlg__check">
                  <input type="checkbox" checked={noTime} onChange={(e) => setNoTime(e.target.checked)} /> 不對應影片時間
                </label>
              </div>
              {timeErr && <div className="cue-save-dlg__error" role="alert">{timeErr}</div>}
              <div className="add-slot-dlg__row">
                <label htmlFor="add-slot-fade">轉場（秒）</label>
                <input id="add-slot-fade" value={fade} inputMode="decimal" onChange={(e) => setFade(e.target.value)} aria-invalid={!!fadeErr}
                  placeholder={pickedLib ? `用 Cue 庫的 ${pickedLib.crossfadeSeconds}` : '用 Cue 庫的'} />
                <span className="muted small">留空 = 用 Cue 庫的；0 = 直接切換</span>
              </div>
              {fadeErr && <div className="cue-save-dlg__error" role="alert">{fadeErr}</div>}
            </>
          )}
          {serverError && <div className="cue-save-dlg__error" role="alert">{serverError}</div>}
          <div className="dialog__footer">
            <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>取消</button>
            <button type="submit" className="btn btn--primary" disabled={!canSubmit}>
              {busy ? '處理中…' : mode === 'add' ? '加進這首歌' : '換成這個'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
