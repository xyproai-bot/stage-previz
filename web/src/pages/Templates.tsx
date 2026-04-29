import { useEffect, useState, useCallback, useRef } from 'react';
import AdminLayout from '../components/AdminLayout';
import * as api from '../lib/api';
import type { SharedAsset } from '../lib/api';
import { useAuth } from '../lib/auth';
import './Templates.css';

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function formatTime(iso: string) {
  const d = new Date(iso + (iso.includes('Z') ? '' : 'Z'));
  return d.toLocaleDateString('zh-TW') + ' ' + d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
}

export default function Templates() {
  const { user: me } = useAuth();
  const [assets, setAssets] = useState<SharedAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAssets(await api.listAssets());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleRename(a: SharedAsset) {
    const name = prompt('改名稱', a.name)?.trim();
    if (!name || name === a.name) return;
    try { await api.updateAsset(a.id, { name }); await refresh(); }
    catch (e) { alert('失敗：' + (e instanceof Error ? e.message : String(e))); }
  }
  async function handleEditDesc(a: SharedAsset) {
    const d = prompt('改描述', a.description)?.trim();
    if (d == null || d === a.description) return;
    try { await api.updateAsset(a.id, { description: d }); await refresh(); }
    catch (e) { alert('失敗：' + (e instanceof Error ? e.message : String(e))); }
  }
  async function handleDelete(a: SharedAsset) {
    if (a.usedByCount > 0) {
      alert(`這個資產還有 ${a.usedByCount} 個專案在用，請先把那些專案切到別的 model 再刪。`);
      return;
    }
    if (!confirm(`刪除資產「${a.name}」？\n\n資產被軟刪除（標記為已停用），R2 上的檔案保留。`)) return;
    try { await api.deleteAsset(a.id); await refresh(); }
    catch (e) { alert('失敗：' + (e instanceof Error ? e.message : String(e))); }
  }

  const isAdmin = me?.role === 'admin';

  return (
    <AdminLayout>
      <header className="admin-topbar">
        <h1>模板庫</h1>
        <div className="admin-topbar__actions">
          {isAdmin && (
            <button className="btn btn--primary" onClick={() => setUploadOpen(true)}>＋ 上傳新資產</button>
          )}
        </div>
      </header>

      <div className="admin-content">
        <p className="muted small" style={{ marginTop: 0 }}>
          共用的 3D model 庫。admin 上傳一份後，多個專案都可以使用同一份 model（不用每個專案各自上傳一遍）。
          {!isAdmin && <span style={{ color: 'var(--warn)' }}>{' '}（只有 admin 可以新增 / 修改）</span>}
        </p>

        {loading ? (
          <div className="empty-card"><div className="empty-card__icon">⏳</div><p>載入中…</p></div>
        ) : error ? (
          <div className="empty-card">
            <div className="empty-card__icon">⚠️</div>
            <p>{error}</p>
            <button className="btn btn--ghost" onClick={refresh} style={{ marginTop: 12 }}>重試</button>
          </div>
        ) : assets.length === 0 ? (
          <div className="empty-card">
            <div className="empty-card__icon">📐</div>
            <p>還沒有任何共用資產</p>
            <small className="muted">建一個共用 model，未來新增專案時可以直接挑一個用</small>
            {isAdmin && (
              <button className="btn btn--primary" onClick={() => setUploadOpen(true)} style={{ marginTop: 12 }}>
                ＋ 上傳第一個資產
              </button>
            )}
          </div>
        ) : (
          <div className="asset-grid">
            {assets.map(a => (
              <article key={a.id} className="asset-card">
                <div className="asset-card__head">
                  <span className="asset-card__icon">📦</span>
                  <span className="asset-card__used" title="使用中的專案數">{a.usedByCount} 個專案使用</span>
                </div>
                <h3 className="asset-card__title">{a.name}</h3>
                {a.description && <p className="asset-card__desc">{a.description}</p>}
                <div className="asset-card__meta">
                  <span>{formatSize(a.sizeBytes)}</span>
                  {a.uploaderName && <><span className="dot">·</span><span>{a.uploaderName}</span></>}
                  <span className="dot">·</span><span>{formatTime(a.updatedAt)}</span>
                </div>
                {isAdmin && (
                  <div className="asset-card__actions">
                    <button onClick={() => handleRename(a)} title="改名稱">✎ 改名</button>
                    <button onClick={() => handleEditDesc(a)} title="改描述">📝 描述</button>
                    <button onClick={() => handleDelete(a)} disabled={a.usedByCount > 0} title="刪除">🗑</button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>

      {isAdmin && (
        <UploadAssetDialog
          open={uploadOpen}
          onClose={() => setUploadOpen(false)}
          onCreated={async () => { setUploadOpen(false); await refresh(); }}
        />
      )}
    </AdminLayout>
  );
}

function UploadAssetDialog({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) { setName(''); setDescription(''); setFile(null); setError(null); }
  }, [open]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) { setError('請選一個 .glb / .gltf 檔'); return; }
    setSubmitting(true);
    try {
      const { id } = await api.createAsset({ name: name.trim(), description: description.trim() });
      await api.uploadAssetFile(id, file);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2>上傳新資產</h2>
          <button className="dialog__close" onClick={onClose}>×</button>
        </header>
        <form className="dialog__body" onSubmit={submit}>
          <div className="form-row">
            <label htmlFor="a-name">資產名稱 *</label>
            <input id="a-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="例：標準舞臺 v1" />
          </div>
          <div className="form-row">
            <label htmlFor="a-desc">描述</label>
            <textarea id="a-desc" maxLength={300} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="這個 model 是給哪場巡迴用的？" />
          </div>
          <div className="form-row">
            <label>3D 模型檔（.glb / .gltf）*</label>
            <input
              ref={fileRef}
              type="file"
              accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              required
            />
            {file && <small className="form-hint">{file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</small>}
          </div>
          {error && <div className="login-error">{error}</div>}
          <footer className="dialog__footer">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={submitting}>取消</button>
            <button type="submit" className="btn btn--primary" disabled={submitting || !name || !file}>
              {submitting ? '上傳中…' : '上傳資產'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
