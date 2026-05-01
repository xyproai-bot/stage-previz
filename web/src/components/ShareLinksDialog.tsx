import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { ShareLink, Song } from '../lib/api';
import { toast } from '../lib/toast';
import './ShareLinksDialog.css';

interface Props {
  open: boolean;
  projectId: string;
  songs: Song[];
  onClose: () => void;
}

export default function ShareLinksDialog({ open, projectId, songs, onClose }: Props) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 建立新連結 form
  const [songId, setSongId] = useState<string>('');
  const [password, setPassword] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<number>(0); // 0 = 永久
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.listShareLinks(projectId);
      setLinks(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  async function handleCreate() {
    setCreating(true);
    try {
      await api.createShareLink(projectId, {
        songId: songId || undefined,
        password: password || undefined,
        expiresInDays: expiresInDays > 0 ? expiresInDays : undefined,
      });
      setPassword('');
      await refresh();
    } catch (e) {
      toast.error('建立連結失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally { setCreating(false); }
  }

  async function handleDelete(token: string) {
    if (!confirm('刪除這個分享連結？\n\n之前發出去的人會立刻失效。')) return;
    try { await api.deleteShareLink(projectId, token); toast.success('已刪除分享連結'); await refresh(); }
    catch (e) { toast.error('刪除失敗：' + (e instanceof Error ? e.message : String(e))); }
  }

  function shareUrl(token: string): string {
    return `${window.location.origin}/share/${token}`;
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('已複製連結 ✓');
    } catch {
      // fallback：開新分頁讓用戶自己複製
      window.prompt('複製這個連結：', url);
    }
  }

  if (!open) return null;

  return (
    <div className="dlg-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg" style={{ maxWidth: 720 }}>
        <header className="dlg__header">
          <h2>🔗 公開分享連結</h2>
          <button className="dlg__close" onClick={onClose}>×</button>
        </header>
        <div className="dlg__body">
          <p className="share-dlg__hint">
            建立連結後寄給外部人 → 對方不需登入，直接看 read-only 預覽（包含 3D 場景 + cue 切換）
          </p>

          {/* Create form */}
          <section className="share-dlg__create">
            <div className="share-dlg__row">
              <label>
                <span>範圍</span>
                <select value={songId} onChange={e => setSongId(e.target.value)}>
                  <option value="">整個專案</option>
                  {songs.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label>
                <span>密碼（可選）</span>
                <input
                  type="text"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="留空 = 不設密碼"
                  maxLength={60}
                />
              </label>
              <label>
                <span>有效期</span>
                <select value={expiresInDays} onChange={e => setExpiresInDays(parseInt(e.target.value, 10))}>
                  <option value={0}>永久</option>
                  <option value={1}>1 天</option>
                  <option value={7}>7 天</option>
                  <option value={30}>30 天</option>
                  <option value={90}>90 天</option>
                </select>
              </label>
            </div>
            <button className="btn btn--primary btn--sm" onClick={handleCreate} disabled={creating}>
              {creating ? '建立中…' : '+ 建立分享連結'}
            </button>
          </section>

          {error && <div className="share-dlg__err">{error}</div>}

          <section className="share-dlg__list">
            <h3>已建立的連結（{links.length}）</h3>
            {loading ? (
              <div className="share-dlg__empty">載入中…</div>
            ) : links.length === 0 ? (
              <div className="share-dlg__empty">還沒建立任何分享連結</div>
            ) : (
              <ul>
                {links.map(l => {
                  const url = shareUrl(l.token);
                  const expired = l.expiresAt && new Date(l.expiresAt + 'Z').getTime() < Date.now();
                  return (
                    <li key={l.token} className={'share-link-row' + (expired ? ' is-expired' : '')}>
                      <div className="share-link-row__main">
                        <code className="share-link-row__url">{url}</code>
                        <div className="share-link-row__meta">
                          {l.songId
                            ? `🎵 ${songs.find(s => s.id === l.songId)?.name || '單首歌'}`
                            : '📁 整個專案'}
                          {l.hasPassword && ' · 🔒 有密碼'}
                          {l.expiresAt && ` · ⏰ ${expired ? '已過期' : `到期 ${new Date(l.expiresAt).toLocaleDateString('zh-TW')}`}`}
                          {' · 👁 ' + l.viewCount + ' 次瀏覽'}
                          {l.lastViewedAt && ` · 上次 ${formatRelative(l.lastViewedAt)}`}
                        </div>
                      </div>
                      <div className="share-link-row__actions">
                        <button className="btn btn--ghost btn--sm" onClick={() => copyLink(url)} title="複製連結">📋</button>
                        <a className="btn btn--ghost btn--sm" href={url} target="_blank" rel="noreferrer">↗</a>
                        <button className="btn btn--ghost btn--sm" onClick={() => handleDelete(l.token)} title="刪除">🗑</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return '剛剛';
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' });
  } catch { return iso; }
}
