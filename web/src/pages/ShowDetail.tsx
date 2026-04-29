import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import AdminLayout from '../components/AdminLayout';
import ProjectCard from '../components/ProjectCard';
import * as api from '../lib/api';
import type { Project } from '../lib/mockData';
import type { ShowDetail as ShowDetailT } from '../lib/api';
import './Shows.css';

export default function ShowDetail() {
  const { showId } = useParams();
  const navigate = useNavigate();
  const [show, setShow] = useState<ShowDetailT | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!showId) return;
    setLoading(true);
    setError(null);
    try {
      const [s, allProjects] = await Promise.all([
        api.getShow(showId),
        api.listProjects(),
      ]);
      setShow(s);
      setProjects(allProjects.filter(p => p.showId === showId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [showId]);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleRename() {
    if (!show) return;
    const name = prompt('新的 Show 名稱', show.name)?.trim();
    if (!name || name === show.name) return;
    try {
      await api.updateShow(show.id, { name });
      await refresh();
    } catch (e) {
      alert('改名失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function handleDelete() {
    if (!show) return;
    if (projects.length > 0) {
      alert(`這個 Show 底下還有 ${projects.length} 個專案，請先把專案移走或封存後再刪。`);
      return;
    }
    if (!confirm(`刪除 Show「${show.name}」？此操作無法復原。`)) return;
    try {
      await api.deleteShow(show.id);
      navigate('/admin/shows');
    } catch (e) {
      alert('刪除失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  const headTitle = useMemo(() => show?.name || '載入中…', [show]);

  return (
    <AdminLayout>
      <header className="admin-topbar">
        <div>
          <div className="show-detail__crumb">
            <Link to="/admin/shows">← Show 巡迴</Link>
            <span className="show-detail__sep">/</span>
            <span>{headTitle}</span>
          </div>
          <h1>{headTitle}</h1>
        </div>
        <div className="admin-topbar__actions">
          <button className="btn btn--ghost" onClick={handleRename} disabled={!show}>✎ 改名</button>
          <button className="show-detail__delete" onClick={handleDelete} disabled={!show}>🗑 刪除 Show</button>
        </div>
      </header>

      <div className="admin-content">
        {loading ? (
          <div className="empty-card"><div className="empty-card__icon">⏳</div><p>載入中…</p></div>
        ) : error ? (
          <div className="empty-card">
            <div className="empty-card__icon">⚠️</div>
            <p>{error}</p>
            <button className="btn btn--ghost" onClick={refresh} style={{ marginTop: 12 }}>重試</button>
          </div>
        ) : (
          <>
            {show?.description && <p className="show-detail__desc">{show.description}</p>}

            <h2 style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-dim)', margin: '0 0 12px' }}>
              場次（{projects.length}）
            </h2>

            {projects.length === 0 ? (
              <div className="empty-card">
                <div className="empty-card__icon">📁</div>
                <p>這個 Show 底下還沒有專案</p>
                <small className="muted">回到「專案」頁建立新專案時，把它歸在這個 Show 下</small>
                <Link to="/admin" className="btn btn--primary" style={{ marginTop: 12 }}>＋ 去建立專案</Link>
              </div>
            ) : (
              <div className="project-grid">
                {projects.map((p) => <ProjectCard key={p.id} project={p} />)}
              </div>
            )}
          </>
        )}
      </div>
    </AdminLayout>
  );
}
