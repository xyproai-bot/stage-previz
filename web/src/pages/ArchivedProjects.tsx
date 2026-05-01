import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AdminLayout from '../components/AdminLayout';
import * as api from '../lib/api';
import type { Project } from '../lib/mockData';
import { toast } from '../lib/toast';
import './ArchivedProjects.css';

export default function ArchivedProjects() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listArchivedProjects();
      setProjects(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleRestore(p: Project) {
    if (!confirm(`還原專案「${p.name}」？\n\n還原後會回到專案列表。`)) return;
    setRestoring(p.id);
    try {
      await api.restoreProject(p.id);
      toast.success(`已還原「${p.name}」`);
      await refresh();
      navigate(`/admin/projects/${p.id}`);
    } catch (e) {
      toast.error('還原失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setRestoring(null);
    }
  }

  return (
    <AdminLayout>
      <div className="archived">
        <header className="archived__head">
          <h1>🗑 封存的專案</h1>
          <p>從這裡可以還原任何之前封存的專案。資料完整保留。</p>
        </header>

        {error && <div className="archived__err">⚠ {error}</div>}

        {projects === null && !error ? (
          <div className="archived__empty">載入中…</div>
        ) : projects && projects.length === 0 ? (
          <div className="archived__empty">
            <div className="archived__empty-icon">🗂️</div>
            <div>沒有封存的專案</div>
          </div>
        ) : (
          <ul className="archived__list">
            {projects?.map(p => (
              <li key={p.id} className="archived__row">
                <div className="archived__row-info">
                  <div className="archived__row-name">{p.name}</div>
                  <div className="archived__row-meta">
                    {p.songCount} 首歌 · {p.cueCount} cue · 封存於 {formatDate(p.updatedAt)}
                  </div>
                  {p.description && <div className="archived__row-desc">{p.description}</div>}
                </div>
                <button
                  className="btn btn--primary btn--sm"
                  onClick={() => handleRestore(p)}
                  disabled={restoring === p.id}
                >
                  {restoring === p.id ? '還原中…' : '↺ 還原'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AdminLayout>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric' });
  } catch { return iso; }
}
