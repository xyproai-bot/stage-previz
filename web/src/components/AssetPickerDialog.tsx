import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as api from '../lib/api';
import type { SharedAsset } from '../lib/api';
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
    if (!confirm(`把這個專案的 model 切到「${a.name}」？\n\n會替換掉專案目前的 model。原本的舊版本仍會留在歷史版本內。`)) return;
    setBusyId(a.id);
    try {
      await api.useAssetForProject(projectId, a.id);
      onPicked();
      onClose();
    } catch (e) {
      alert('切換失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <div>
            <h2>從共用庫挑 model</h2>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              選一個資產 → 這個專案的 model 會切到該資產（多個專案可共用同一份）
            </p>
          </div>
          <button className="dialog__close" onClick={onClose}>×</button>
        </header>
        <div className="dialog__body">
          {loading ? (
            <div className="empty-card"><div className="empty-card__icon">⏳</div><p>載入中…</p></div>
          ) : error ? (
            <div className="empty-card">
              <div className="empty-card__icon">⚠️</div>
              <p>{error}</p>
            </div>
          ) : assets.length === 0 ? (
            <div className="empty-card">
              <div className="empty-card__icon">📐</div>
              <p>共用庫還沒有任何資產</p>
              <small className="muted">先去「模板庫」上傳，再回來挑</small>
              <Link to="/admin/templates" className="btn btn--primary" style={{ marginTop: 12 }}>
                去模板庫 →
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
                    <span style={{ fontSize: 24 }}>📦</span>
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
                        {busyId === a.id ? '切換中…' : '使用此資產'}
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
