import { useEffect, useState, useCallback, useRef } from 'react';
import AdminLayout from '../components/AdminLayout';
import * as api from '../lib/api';
import type { SharedAsset } from '../lib/api';
import { parseServerTime } from '../lib/serverTime';
import { useAuth } from '../lib/auth';
import Icon from '../components/Icon';
import { confirmDialog, promptDialog, toast } from '../components/dialogs';
import { Box, Boxes, FileText, LoaderCircle, Pencil, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import './Templates.css';

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function formatTime(iso: string) {
  const d = new Date(parseServerTime(iso));  // 手動加 Z 的寫法 Safari 讀不懂（中間是空白不是 T）
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
    const name = (await promptDialog({
      title: '改模型名稱',
      label: '名稱',
      defaultValue: a.name,
      confirmLabel: '改名',
      maxLength: 100,
    }))?.trim();
    if (!name || name === a.name) return;
    try { await api.updateAsset(a.id, { name }); await refresh(); }
    catch (e) { toast.error('改名失敗：' + (e instanceof Error ? e.message : String(e))); }
  }
  async function handleEditDesc(a: SharedAsset) {
    const d = (await promptDialog({
      title: `「${a.name}」的說明`,
      label: '說明（可以留空）',
      defaultValue: a.description,
      confirmLabel: '儲存',
      required: false,
      maxLength: 500,
    }))?.trim();
    if (d == null || d === a.description) return;
    try { await api.updateAsset(a.id, { description: d }); await refresh(); }
    catch (e) { toast.error('說明沒有存到：' + (e instanceof Error ? e.message : String(e))); }
  }
  async function handleDelete(a: SharedAsset) {
    if (a.usedByCount > 0) {
      toast.warn(`這個模型還有 ${a.usedByCount} 個專案在用，請先把那些專案換成別的模型再刪。`);
      return;
    }
    if (!(await confirmDialog({
      title: `刪除模型「${a.name}」？`,
      message: '模型會先標成停用、不會再出現在模型庫，檔案還會留著。',
      confirmLabel: '刪除',
      destructive: true,
    }))) return;
    try { await api.deleteAsset(a.id); await refresh(); }
    catch (e) { toast.error('刪除失敗：' + (e instanceof Error ? e.message : String(e))); }
  }

  const isAdmin = me?.role === 'admin';

  return (
    <AdminLayout>
      <header className="admin-topbar">
        <h1>模型庫</h1>
        <div className="admin-topbar__actions">
          {isAdmin && (
            <button className="btn btn--primary" onClick={() => setUploadOpen(true)}><Icon icon={Plus} /> 上傳新模型</button>
          )}
        </div>
      </header>

      <div className="admin-content">
        <p className="muted small" style={{ marginTop: 0 }}>
          共用的 3D 模型。製作上傳一份後，多個專案都可以用同一份模型（不用每個專案各自上傳一遍）。
          {!isAdmin && <span style={{ color: 'var(--warn)' }}>{' '}（只有製作可以新增 / 修改）</span>}
        </p>

        {loading ? (
          <div className="empty-card"><div className="empty-card__icon"><Icon icon={LoaderCircle} size="xl" spin /></div><p>載入中…</p></div>
        ) : error ? (
          <div className="empty-card">
            <div className="empty-card__icon"><Icon icon={TriangleAlert} size="xl" /></div>
            <p>{error}</p>
            <button className="btn btn--ghost" onClick={refresh} style={{ marginTop: 12 }}>重試</button>
          </div>
        ) : assets.length === 0 ? (
          <div className="empty-card">
            <div className="empty-card__icon"><Icon icon={Boxes} size="xl" /></div>
            <p>模型庫還沒有任何模型</p>
            <small className="muted">上傳一個共用模型，之後新增專案時可以直接選來用</small>
            {isAdmin && (
              <button className="btn btn--primary" onClick={() => setUploadOpen(true)} style={{ marginTop: 12 }}>
                <Icon icon={Plus} /> 上傳第一個模型
              </button>
            )}
          </div>
        ) : (
          <div className="asset-grid">
            {assets.map(a => (
              <article key={a.id} className="asset-card">
                <div className="asset-card__head">
                  <span className="asset-card__icon"><Icon icon={Box} size="lg" /></span>
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
                    <button onClick={() => handleRename(a)} title="改名稱"><Icon icon={Pencil} /> 改名</button>
                    <button onClick={() => handleEditDesc(a)} title="改描述"><Icon icon={FileText} /> 描述</button>
                    <button onClick={() => handleDelete(a)} disabled={a.usedByCount > 0} title={a.usedByCount > 0 ? '還有專案在用，不能刪除' : '刪除'} aria-label="刪除"><Icon icon={Trash2} /></button>
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
          <h2>上傳新模型</h2>
          <button className="dialog__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <form className="dialog__body" onSubmit={submit}>
          <div className="form-row">
            <label htmlFor="a-name">模型名稱 *</label>
            <input id="a-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="例：標準舞臺 v1" />
          </div>
          <div className="form-row">
            <label htmlFor="a-desc">描述</label>
            <textarea id="a-desc" maxLength={300} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="這個模型是給哪場巡迴用的？" />
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
              {submitting ? '上傳中…' : '上傳模型'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
