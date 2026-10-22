// 右邊面板最上面那一排：目前這個 cue 有沒有「還沒存的改動」，以及另存 / 更新 / 放棄。
// 只在 Cue 庫專案出現。規格 5.1。

import { Copy, RefreshCw, Undo2 } from 'lucide-react';
import Icon from './Icon';
import './LookDraftBar.css';

interface Props {
  /** 目前這個 cue 指到的 Cue 庫的 cue 的編號 / 名稱 */
  label: string;
  name: string;
  /** 幾首歌在用（null = 還沒讀到） */
  songCount: number | null;
  summary: { objects: number; mechanisms: number };
  hasChanges: boolean;
  busy: boolean;
  onSaveAs: () => void;
  onUpdate: () => void;
  onDiscard: () => void;
}

export function usageText(songCount: number | null): string {
  if (songCount === null) return '';
  if (songCount <= 0) return '（沒有歌在用）';
  if (songCount === 1) return '（只有這首歌在用）';
  return `會影響 ${songCount} 首歌`;
}

export default function LookDraftBar({ label, name, songCount, summary, hasChanges, busy, onSaveAs, onUpdate, onDiscard }: Props) {
  const parts: string[] = [];
  if (summary.objects > 0) parts.push(`${summary.objects} 個物件`);
  if (summary.mechanisms > 0) parts.push(`${summary.mechanisms} 個機關`);
  const cueName = `Cue ${label}「${name}」`;
  return (
    <div className={'look-draft-bar' + (hasChanges ? ' is-dirty' : '')} role="status">
      <div className="look-draft-bar__text">
        {hasChanges ? (
          <>
            <strong>還沒存的改動：{parts.join('、')}</strong>
            <span className="look-draft-bar__sub">你正在改 {cueName}{songCount !== null && songCount > 1 ? '，' : ' '}{usageText(songCount)}</span>
          </>
        ) : (
          <>
            <strong>{cueName}</strong>
            <span className="look-draft-bar__sub">{songCount === null ? '' : songCount <= 0 ? '沒有歌在用' : `${songCount} 首歌在用`}</span>
          </>
        )}
      </div>
      <div className="look-draft-bar__actions">
        <button type="button" className={'btn btn--sm ' + (hasChanges ? 'btn--primary' : 'btn--ghost')} onClick={onSaveAs} disabled={busy}>
          <Icon icon={Copy} /> 另存成新的 cue
        </button>
        {hasChanges && (
          <>
            <button type="button" className="btn btn--sm btn--ghost" onClick={onUpdate} disabled={busy}>
              <Icon icon={RefreshCw} /> 更新 Cue {label}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={onDiscard} disabled={busy}>
              <Icon icon={Undo2} /> 放棄
            </button>
          </>
        )}
      </div>
    </div>
  );
}
