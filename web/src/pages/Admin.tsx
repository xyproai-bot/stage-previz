import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import AdminLayout from '../components/AdminLayout';
import ProjectCard from '../components/ProjectCard';
import NewProjectDialog from '../components/NewProjectDialog';
import * as api from '../lib/api';
import type { Project } from '../lib/mockData';
import './Admin.css';

type Filter = 'all' | 'active' | 'in_review' | 'mine';
const ME = 'Phang'; // 暫時硬編，之後從 auth 拿

export default function Admin() {
  const { tab } = useParams();

  if (tab === 'drive-sources') return <AdminLayout><PlaceholderTab name="Drive 來源" /></AdminLayout>;
  if (tab === 'users') return <AdminLayout><PlaceholderTab name="用戶" /></AdminLayout>;
  if (tab === 'templates') return <AdminLayout><PlaceholderTab name="模板庫" /></AdminLayout>;
  if (tab === 'settings') return <AdminLayout><PlaceholderTab name="設定" /></AdminLayout>;

  return (
    <AdminLayout>
      <ProjectsTab />
    </AdminLayout>
  );
}

function ProjectsTab() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  async function refresh() {
    try {
      setLoading(true);
      setError(null);
      const list = await api.listProjects();
      setProjects(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  const filtered = useMemo(() => {
    let list = projects;
    if (filter === 'active') list = list.filter(p => p.status === 'active');
    else if (filter === 'in_review') list = list.filter(p => p.status === 'in_review');
    else if (filter === 'mine') list = list.filter(p => p.members.some(m => m.name === ME));
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
    }
    return list;
  }, [projects, filter, search]);

  const counts = useMemo(() => ({
    all: projects.length,
    active: projects.filter(p => p.status === 'active').length,
    in_review: projects.filter(p => p.status === 'in_review').length,
    mine: projects.filter(p => p.members.some(m => m.name === ME)).length,
  }), [projects]);

  async function handleCreate(data: { name: string; description: string }) {
    try {
      setCreating(true);
      await api.createProject(data);
      setDialogOpen(false);
      await refresh();
    } catch (e) {
      alert('建立失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <header className="admin-topbar">
        <h1>專案總覽</h1>
        <div className="admin-topbar__actions">
          <input
            type="text"
            className="admin-search"
            placeholder="搜尋專案..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn btn--primary" onClick={() => setDialogOpen(true)}>
            ＋ 新增專案
          </button>
        </div>
      </header>

      <div className="admin-content">
        <div className="filter-chips">
          {([
            ['all', '全部'],
            ['active', '進行中'],
            ['in_review', '待修'],
            ['mine', '我負責的'],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              className={'chip' + (filter === key ? ' is-active' : '')}
              onClick={() => setFilter(key)}
            >
              {label} <span className="chip__count">({counts[key]})</span>
            </button>
          ))}
        </div>

        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState message={error} onRetry={refresh} />
        ) : filtered.length === 0 ? (
          <EmptyState
            onCreate={() => setDialogOpen(true)}
            hasFilter={search.length > 0 || filter !== 'all'}
            hasAnyProjects={projects.length > 0}
          />
        ) : (
          <div className="project-grid">
            {filtered.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </div>

      <NewProjectDialog
        open={dialogOpen}
        onClose={() => !creating && setDialogOpen(false)}
        onCreate={handleCreate}
        submitting={creating}
      />
    </>
  );
}

function EmptyState({ onCreate, hasFilter, hasAnyProjects }: {
  onCreate: () => void;
  hasFilter: boolean;
  hasAnyProjects: boolean;
}) {
  if (hasFilter && hasAnyProjects) {
    return (
      <div className="empty-card">
        <div className="empty-card__icon">🔍</div>
        <p>找不到符合的專案</p>
      </div>
    );
  }
  return <OnboardingWizard onStart={onCreate} />;
}

function OnboardingWizard({ onStart }: { onStart: () => void }) {
  const steps = [
    { icon: '📁', title: '建立專案', desc: '取一個名字，例如「魅影巡演 2026」', here: true },
    { icon: '📦', title: '上傳 3D 模型', desc: '把舞臺的 .glb / .gltf 拖進來，自動分類 LED / 走位 / 機關' },
    { icon: '🧩', title: '認識物件',     desc: '一鍵塞入 10 個常用範例，或手動加你的 mesh' },
    { icon: '🎵', title: '加入歌曲',     desc: '依 set list 排好順序，每首歌可獨立追蹤狀態' },
    { icon: '🎬', title: '製作第一個 cue', desc: '從 3D viewport 直接 snapshot 位置，或從空白建立' },
  ];
  return (
    <div className="onboarding">
      <div className="onboarding__head">
        <div className="onboarding__hello">👋 歡迎</div>
        <h2>5 個步驟建立你的第一個 LED 舞臺預覽</h2>
        <p className="onboarding__sub">第 1 步在這裡，後面 4 步建好專案會自動帶你進編輯器繼續</p>
      </div>
      <ol className="onboarding__steps">
        {steps.map((s, i) => (
          <li key={i} className={'onboarding-step' + (s.here ? ' is-current' : '')}>
            <div className="onboarding-step__num">{i + 1}</div>
            <div className="onboarding-step__icon" aria-hidden="true">{s.icon}</div>
            <div className="onboarding-step__body">
              <div className="onboarding-step__title">
                {s.title}
                {s.here && <span className="onboarding-step__here">就在這一步</span>}
              </div>
              <div className="onboarding-step__desc">{s.desc}</div>
            </div>
            {s.here && (
              <button className="btn btn--primary onboarding-step__cta" onClick={onStart}>
                建立專案 →
              </button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="empty-card">
      <div className="empty-card__icon">⏳</div>
      <p>載入專案中…</p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="empty-card">
      <div className="empty-card__icon">⚠️</div>
      <p>載入失敗</p>
      <small style={{ color: 'var(--warn)', maxWidth: 400 }}>{message}</small>
      <button className="btn btn--ghost" onClick={onRetry} style={{ marginTop: 12 }}>
        重試
      </button>
    </div>
  );
}

function PlaceholderTab({ name }: { name: string }) {
  return (
    <>
      <header className="admin-topbar">
        <h1>{name}</h1>
      </header>
      <div className="admin-content">
        <div className="empty-card">
          <div className="empty-card__icon">🚧</div>
          <p>{name} 功能開發中</p>
          <small>後續 Phase 會加上</small>
        </div>
      </div>
    </>
  );
}
