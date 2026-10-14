// 「最近刪除」：這首歌刪掉的版本，30 天內製作可以救回來（號碼不變），30 天後排程清掉檔案。
//   DeletedVersionsList   清單本身（編輯頁「影片版本」視窗下面那一段）
//   DeletedVersionsDialog 包成站內視窗（導演頁的版本列「最近刪除」按鈕打開）
// 後台：cf-worker/storage.mjs（只有製作看得到、救得回來）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { History, LoaderCircle, RotateCcw, X } from 'lucide-react';
import Icon from './Icon';
import { formatGb, listDeletedVideos, restoreDeletedVideo, type DeletedVideo } from '../lib/storageApi';
import { formatDateTime } from '../lib/serverTime';
import { toast } from '../lib/toast';
import { useEscapeClose } from '../lib/useEscapeClose';
import './SongVideosDialog.css';
import './DeletedVersions.css';

interface ListProps {
  projectId: string;
  songId: string;
  /** 變了就重新讀（例如剛刪了一版） */
  reloadKey?: unknown;
  /** 救回來了 → 版本清單、歌單重新讀 */
  onRestored: (label: string) => void;
  /** 讀到幾版（標題上的數字） */
  onCount?: (n: number) => void;
}

export function DeletedVersionsList({ projectId, songId, reloadKey, onRestored, onCount }: ListProps) {
  const [items, setItems] = useState<DeletedVideo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const countRef = useRef(onCount);
  countRef.current = onCount;

  const load = useCallback(async () => {
    try {
      const r = await listDeletedVideos(projectId, songId);
      setItems(r.videos);
      setError(null);
      countRef.current?.(r.videos.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId, songId]);
  useEffect(() => { void load(); }, [load, reloadKey]);

  async function restore(v: DeletedVideo) {
    setBusyId(v.id);
    try {
      await restoreDeletedVideo(projectId, songId, v.id);
      toast.success(`已救回 ${v.label}（號碼不變）`);
      await load();
      onRestored(v.label);
    } catch (e) {
      toast.error('救不回來：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyId(null);
    }
  }

  if (error) return <div className="delvid__empty is-error" role="alert">讀不到最近刪除的版本：{error}</div>;
  if (!items) return <div className="delvid__empty" role="status"><Icon icon={LoaderCircle} spin size="sm" /> 讀取中…</div>;
  if (items.length === 0) return <div className="delvid__empty">最近 30 天沒有刪掉的版本。</div>;
  return (
    <ul className="delvid__list" aria-label="最近刪除的版本">
      {items.map(v => (
        <li key={v.id} className="delvid-row">
          <div className="delvid-row__num">{v.label}</div>
          <div className="delvid-row__main">
            <div className="delvid-row__title" title={v.title}>{v.note ? `「${v.note}」` : (v.title || '（沒有寫說明）')}</div>
            <div className="delvid-row__meta">
              {[v.deletedBy?.name ? `${v.deletedBy.name} 刪的` : '刪掉的', formatDateTime(v.deletedAt), v.sizeBytes ? formatGb(v.sizeBytes) : '']
                .filter(Boolean).join(' · ')}
              {' · '}
              <span className={v.daysLeft <= 3 ? 'delvid-row__left is-soon' : 'delvid-row__left'}>
                {v.daysLeft > 0 ? `還剩 ${v.daysLeft} 天` : '今天就會清掉'}
              </span>
            </div>
          </div>
          <button type="button" className="songvid-btn" onClick={() => void restore(v)} disabled={busyId === v.id}>
            {busyId === v.id ? <><Icon icon={LoaderCircle} spin size="sm" /> 救回中…</> : <><Icon icon={RotateCcw} size="sm" /> 救回 {v.label}</>}
          </button>
        </li>
      ))}
    </ul>
  );
}

interface DialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  songId: string;
  songLabel: string;
  onRestored: (label: string) => void;
}

export function DeletedVersionsDialog({ open, onClose, projectId, songId, songLabel, onRestored }: DialogProps) {
  useEscapeClose(open, onClose);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) panelRef.current?.focus(); }, [open]);
  if (!open) return null;
  return (
    <div className="songvid-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panelRef} className="songvid delvid-dialog" role="dialog" aria-modal="true" aria-labelledby="delvid-title" tabIndex={-1}
        onKeyDown={(e) => e.stopPropagation()}>
        <header className="songvid__head">
          <div className="songvid__titles">
            <h2 id="delvid-title"><Icon icon={History} /> 最近刪除 · <span className="songvid__song">{songLabel}</span></h2>
            <p className="songvid__sub">刪掉的版本留 30 天，這段時間可以救回來（號碼不變）；30 天後檔案會清掉，就救不回來了。</p>
          </div>
          <button type="button" className="songvid__close" onClick={onClose} title="關閉" aria-label="關閉">
            <Icon icon={X} size="md" />
          </button>
        </header>
        <div className="songvid__body">
          <DeletedVersionsList projectId={projectId} songId={songId} onRestored={onRestored} />
        </div>
        <footer className="songvid__foot">
          <span className="songvid__count" />
          <button type="button" className="btn btn--ghost" onClick={onClose}>關閉</button>
        </footer>
      </div>
    </div>
  );
}
