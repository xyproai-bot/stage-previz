import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../lib/api';
import type { SharedAsset } from '../lib/api';
import { ArrowRight, Box, Boxes, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import Icon from './Icon';
import { confirmDialog, toast } from './dialogs';
import './AssetPickerDialog.css';

interface Props {
  open: boolean;
  projectId: string;
  currentKey: string | null;
  onClose: () => void;
  onPicked: () => void;
}

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function AssetPickerDialog({ open, projectId, currentKey, onClose, onPicked }: Props) {
  const [assets, setAssets] = useState<SharedAsset[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    api.listAssets()
      .then(setAssets)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function pick(a: SharedAsset) {
    if (!(await confirmDialog({
      title: `把這個專案的模型換成「${a.name}」？`,
      message: '專案目前的模型會被換掉，原本的那一版還留在「歷史版本」裡，隨時可以換回來。',
      confirmLabel: '換成這個模型',
    }))) return;
    setBusyId(a.id);
    try {
      await api.useAssetForProject(projectId, a.id);
      onPicked();
      onClose();
    } catch (e) {
      toast.error('模型沒有換成：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <div>
            <h2>從模型庫選模型</h2>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              選一個模型，這個專案就會改用它（多個專案可以共用同一份）
            </p>
          </div>
          <button className="dialog__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <div className="dialog__body">
          {loading ? (
            <div className="empty-card"><div className="empty-card__icon"><Icon icon={LoaderCircle} size="xl" spin /></div><p>載入中…</p></div>
          ) : error ? (
            <div className="empty-card">
              <div className="empty-card__icon"><Icon icon={TriangleAlert} size="xl" /></div>
              <p>{error}</p>
            </div>
          ) : assets.length === 0 ? (
            <div className="empty-card">
              <div className="empty-card__icon"><Icon icon={Boxes} size="xl" /></div>
              <p>模型庫還沒有任何模型</p>
              <small className="muted">先到「模型庫」上傳，再回來選</small>
              <Link to="/admin/templates" className="btn btn--primary" style={{ marginTop: 12 }}>
                前往模型庫 <Icon icon={ArrowRight} />
              </Link>
            </div>
          ) : (
            <ul className="asset-picker">
              {assets.map(a => {
                const isCurrent = currentKey === a.key;
                return (
                  <li
                    key={a.id}
                    className={'asset-picker__row' + (isCurrent ? ' is-active' : '')}
                    onClick={() => !isCurrent && !busyId && pick(a)}
                  >
                    <Icon icon={Box} size="lg" className="asset-picker__row__icon" />
                    <div className="asset-picker__row__main">
                      <div className="asset-picker__row__title">
                        {a.name}
                        {isCurrent && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--accent)' }}>當前使用</span>}
                      </div>
                      {a.description && <div className="asset-picker__row__meta">{a.description}</div>}
                      <div className="asset-picker__row__meta">
                        {formatSize(a.sizeBytes)} · {a.usedByCount} 個專案使用中
                      </div>
                    </div>
                    {!isCurrent && (
                      <button
                        className="btn btn--primary btn--sm"
                        disabled={busyId === a.id}
                        onClick={(e) => { e.stopPropagation(); pick(a); }}
                      >
                        {busyId === a.id ? '切換中…' : '使用這個模型'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
