import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import AdminLayout from '../components/AdminLayout';
import NewShowDialog from '../components/NewShowDialog';
import * as api from '../lib/api';
import type { Show } from '../lib/api';
import './Shows.css';

export default function Shows() {
  const navigate = useNavigate();
  const [shows, setShows] = useState<Show[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setShows(await api.listShows());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleCreate(data: { name: string; description: string }) {
    try {
      setCreating(true);
      const { id } = await api.createShow(data);
      setDialogOpen(false);
      await refresh();
      navigate(`/admin/shows/${id}`);
    } catch (e) {
      alert('建立失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setCreating(false);
    }
  }

  return (
    <AdminLayout>
      <header className="admin-topbar">
        <h1>Show 巡迴</h1>
        <div className="admin-topbar__actions">
          <button className="btn btn--primary" onClick={() => setDialogOpen(true)}>＋ 新增 Show</button>
        </div>
      </header>

      <div className="admin-content">
        <p className="muted small" style={{ marginTop: 0 }}>
          一個 Show 是一場演唱會的母體（含多個巡迴場次）。每個 Show 底下可放多個專案，每個專案是一場（或一輪設定）。
        </p>

        {loading ? (
          <div className="empty-card"><div className="empty-card__icon">⏳</div><p>載入中…</p></div>
        ) : error ? (
          <div className="empty-card">
            <div className="empty-card__icon">⚠️</div>
            <p>載入失敗</p>
            <small style={{ color: 'var(--warn)' }}>{error}</small>
            <button className="btn btn--ghost" onClick={refresh} style={{ marginTop: 12 }}>重試</button>
          </div>
        ) : shows.length === 0 ? (
          <div className="empty-card">
            <div className="empty-card__icon">🎫</div>
            <p>尚無任何 Show</p>
            <small>有跨多場的巡迴時，建一個 Show 把所有場次的專案歸在一起</small>
            <button className="btn btn--primary" onClick={() => setDialogOpen(true)} style={{ marginTop: 12 }}>
              ＋ 建立第一個 Show
            </button>
          </div>
        ) : (
          <div className="show-grid">
            {shows.map(s => (
              <article
                key={s.id}
                className="show-card"
                onClick={() => navigate(`/admin/shows/${s.id}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigate(`/admin/shows/${s.id}`);
                  }
                }}
              >
                <div className="show-card__header">
                  <span className="show-card__icon">🎫</span>
                  <div className="show-card__count">{s.projectCount} 個專案</div>
                </div>
                <h3 className="show-card__title">{s.name}</h3>
                {s.description && <p className="show-card__desc">{s.description}</p>}
              </article>
            ))}
          </div>
        )}
      </div>

      <NewShowDialog
        open={dialogOpen}
        onClose={() => !creating && setDialogOpen(false)}
        onCreate={handleCreate}
        submitting={creating}
      />
    </AdminLayout>
  );
}
