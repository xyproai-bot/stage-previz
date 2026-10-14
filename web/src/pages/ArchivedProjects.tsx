import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AdminLayout from '../components/AdminLayout';
import * as api from '../lib/api';
import type { Project } from '../lib/mockData';
import { parseServerTime } from '../lib/serverTime';
import { toast } from '../lib/toast';
import { confirmDialog } from '../components/dialogs';
import Icon from '../components/Icon';
import { Archive, Film, RotateCcw, TriangleAlert } from 'lucide-react';
import ProjectWrapUpDialog from '../components/ProjectWrapUpDialog';
import './ArchivedProjects.css';

export default function ArchivedProjects() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [wrapUp, setWrapUp] = useState<Project | null>(null);

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
    if (!(await confirmDialog({
      title: `還原專案「${p.name}」？`,
      message: '還原後會回到專案總覽，大家又看得到。改成長期存放的影片不會自動搬回來：照樣可以播，只是打開時有一點讀取費。',
      confirmLabel: '還原',
    }))) return;
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
          <h1>封存的專案</h1>
          <p>從這裡可以還原任何之前封存的專案。資料完整保留。</p>
        </header>

        {error && <div className="archived__err"><Icon icon={TriangleAlert} /> {error}</div>}

        {projects === null && !error ? (
          <div className="archived__empty">載入中…</div>
        ) : projects && projects.length === 0 ? (
          <div className="archived__empty">
            <div className="archived__empty-icon"><Icon icon={Archive} size="xl" /></div>
            <div>沒有封存的專案</div>
          </div>
        ) : (
          <ul className="archived__list">
            {projects?.map(p => (
              <li key={p.id} className="archived__row">
                <div className="archived__row-info">
                  <div className="archived__row-name">{p.name}</div>
                  <div className="archived__row-meta">
                    {p.songCount} 首歌 · {p.cueCount} 個 cue · 封存於 {formatDate(p.updatedAt)}
                  </div>
                  {p.description && <div className="archived__row-desc">{p.description}</div>}
                </div>
                <button className="btn btn--ghost btn--sm" onClick={() => setWrapUp(p)} title="只留每首歌最後通過的那一版、改成長期存放">
                  <Icon icon={Film} /> 清影片
                </button>
                <button
                  className="btn btn--primary btn--sm"
                  onClick={() => handleRestore(p)}
                  disabled={restoring === p.id}
                >
                  {restoring === p.id ? '還原中…' : <><Icon icon={RotateCcw} /> 還原</>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {wrapUp && <ProjectWrapUpDialog open mode="later" project={wrapUp} onClose={() => setWrapUp(null)} onDone={() => { void refresh(); }} />}
    </AdminLayout>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(parseServerTime(iso)).toLocaleDateString('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric' });
  } catch { return iso; }
}
