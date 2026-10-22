// 「更新 Cue X」：這個 cue 有別的歌在用時，先列出會一起變的歌再問。規格 5.1。

import { useEffect } from 'react';
import { X } from 'lucide-react';
import Icon from './Icon';
import type { LibraryCueUsage } from '../lib/cueLibraryApi';
import './NewProjectDialog.css';
import './LookDraftBar.css';

interface Props {
  label: string;
  name: string;
  usage: LibraryCueUsage;
  busy: boolean;
  onConfirm: () => void;
  /** 「改成另存新的 cue」 */
  onSaveAs: () => void;
  onCancel: () => void;
}

/** 在用的歌（每首歌只列一次，寫代號，沒有代號寫歌名） */
export function usageSongNames(usage: LibraryCueUsage): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of usage.slots) {
    if (seen.has(s.songId)) continue;
    seen.add(s.songId);
    out.push(s.songCode || s.songName);
  }
  return out;
}

export default function UpdateCueDialog({ label, name, usage, busy, onConfirm, onSaveAs, onCancel }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);
  const songs = usageSongNames(usage);
  return (
    <div className="dialog-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div className="dialog cue-save-dlg" role="dialog" aria-modal="true" aria-labelledby="cue-update-title" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2 id="cue-update-title">更新 Cue {label}「{name}」？</h2>
          <button className="dialog__close" onClick={onCancel} disabled={busy} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <div className="dialog__body">
          <p className="cue-save-dlg__hint">
            會影響 {usage.songCount} 首歌：{songs.join('、')}。更新之後，這些歌用到它的地方都會變。只想改這首歌的話，按「改成另存新的 cue」。
          </p>
          <div className="dialog__footer">
            <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>取消</button>
            <button type="button" className="btn btn--ghost" onClick={onSaveAs} disabled={busy}>改成另存新的 cue</button>
            <button type="button" className="btn btn--primary" onClick={onConfirm} disabled={busy}>{busy ? '更新中…' : `更新 ${usage.songCount} 首歌`}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
