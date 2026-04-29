import { useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { ModelVersion } from '../lib/api';
import './ModelVersionsDialog.css';

interface Props {
  open: boolean;
  projectId: string;
  onClose: () => void;
  /** 切換版本 / 刪除版本後呼叫，讓父層 refresh 模型 */
  onChanged: () => void;
}

function formatTime(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return '剛才';
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return d.toLocaleDateString('zh-TW') + ' ' + d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function ModelVersionsDialog({ open, projectId, onClose, onChanged }: Props) {
  const [versions, setVersions] = useState<ModelVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const { versions } = await api.listModelVersions(projectId);
      setVersions(versions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (open) refresh(); /* eslint-disable-next-line */ }, [open, projectId]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function handleActivate(v: ModelVersion) {
    if (v.isActive) return;
    if (!confirm(`切換到此版本？\n\n上傳於 ${formatTime(v.uploaded)}（${formatSize(v.size)}）\n切換後 3D 視窗會重載這個版本。`)) return;
    setBusyKey(v.key);
    try {
      await api.activateModelVersion(projectId, v.key);
      onChanged();
      await refresh();
    } catch (e) {
      alert('切換失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyKey(null);
    }
  }

  async function handleDelete(v: ModelVersion) {
    if (v.isActive) return;
    if (!confirm(`刪除這個舊版本？\n\n上傳於 ${formatTime(v.uploaded)}（${formatSize(v.size)}）\n此操作無法復原（R2 直接刪除）。`)) return;
    setBusyKey(v.key);
    try {
      await api.deleteModelVersion(projectId, v.key);
      await refresh();
    } catch (e) {
      alert('刪除失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="versions-overlay" onClick={onClose}>
      <div className="versions-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="versions-dialog__header">
          <div>
            <h2>模型版本歷史</h2>
            <p className="versions-dialog__sub muted">
              每次上傳都會留一份。可以隨時切回舊版、或刪掉用不到的版本。
            </p>
          </div>
          <button className="versions-dialog__close" onClick={onClose} aria-label="關閉">×</button>
        </header>

        <div className="versions-dialog__body">
          {loading ? (
            <div className="versions-empty muted">載入中…</div>
          ) : error ? (
            <div className="versions-empty">
              <div style={{ fontSize: 36 }}>⚠️</div>
              <div>載入失敗</div>
              <small style={{ color: 'var(--warn)' }}>{error}</small>
              <button className="btn btn--ghost" onClick={refresh} style={{ marginTop: 12 }}>重試</button>
            </div>
          ) : versions.length === 0 ? (
            <div className="versions-empty">
              <div style={{ fontSize: 36 }}>📦</div>
              <div>還沒有任何模型版本</div>
              <small className="muted">關掉這個視窗，到「物件」分頁上傳第一個 .glb / .gltf</small>
            </div>
          ) : (
            <ul className="versions-list">
              {versions.map((v, i) => (
                <li key={v.key} className={'version-row' + (v.isActive ? ' is-active' : '')}>
                  <div className="version-row__num">v{versions.length - i}</div>
                  <div className="version-row__main">
                    <div className="version-row__title">
                      {v.isActive
                        ? <span className="version-row__active-tag">當前使用</span>
                        : <span className="muted small">舊版本</span>}
                      <span className="version-row__time">{formatTime(v.uploaded)}</span>
                    </div>
                    <div className="version-row__meta muted small">
                      {formatSize(v.size)}
                      <span className="dot">·</span>
                      <span className="mono">{v.key.split('/').pop()}</span>
                    </div>
                  </div>
                  <div className="version-row__actions">
                    {!v.isActive && (
                      <button
                        className="btn btn--primary btn--sm"
                        onClick={() => handleActivate(v)}
                        disabled={busyKey === v.key}
                      >
                        {busyKey === v.key ? '切換中…' : '↺ 切回此版'}
                      </button>
                    )}
                    {!v.isActive && (
                      <button
                        className="btn btn--ghost btn--sm version-row__delete"
                        onClick={() => handleDelete(v)}
                        disabled={busyKey === v.key}
                        title="刪除這個舊版本（不可復原）"
                      >
                        🗑
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="versions-dialog__footer">
          <span className="muted small">共 {versions.length} 個版本</span>
          <button className="btn btn--ghost" onClick={onClose}>關閉</button>
        </footer>
      </div>
    </div>
  );
}
