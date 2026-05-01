import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import AdminLayout from '../components/AdminLayout';
import ProjectCard from '../components/ProjectCard';
import NewProjectDialog from '../components/NewProjectDialog';
import RecentProjectsBar from '../components/RecentProjectsBar';
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
      <RecentProjectsBar />
      <ProjectsTab />
    </AdminLayout>
  );
}

function ProjectsTab() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [showsById, setShowsById] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(() => {
    try { return localStorage.getItem('sp_admin_search') || ''; } catch { return ''; }
  });
  const [filter, setFilter] = useState<Filter>(() => {
    try { return (localStorage.getItem('sp_admin_filter') as Filter) || 'all'; } catch { return 'all'; }
  });

  useEffect(() => { try { localStorage.setItem('sp_admin_search', search); } catch {} }, [search]);
  useEffect(() => { try { localStorage.setItem('sp_admin_filter', filter); } catch {} }, [filter]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  function toggleSelect(p: Project) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(p.id)) next.delete(p.id);
      else next.add(p.id);
      return next;
    });
  }
  function clearSelection() { setSelectedIds(new Set()); }
  async function bulkArchive() {
    const ids = Array.from(selectedIds);
    if (!confirm(`封存 ${ids.length} 個選中的專案？`)) return;
    let ok = 0, fail = 0;
    for (const id of ids) {
      try { await api.archiveProject(id); ok++; }
      catch { fail++; }
    }
    alert(`✅ 封存 ${ok} 個${fail ? ` · ❌ 失敗 ${fail}` : ''}`);
    clearSelection();
    await refresh();
  }

  async function refresh() {
    try {
      setLoading(true);
      setError(null);
      const [list, shows] = await Promise.all([api.listProjects(), api.listShows().catch(() => [])]);
      setProjects(list);
      const map: Record<string, string> = {};
      for (const s of shows) map[s.id] = s.name;
      setShowsById(map);
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

  async function handleCreate(data: { name: string; description: string; showId?: string | null }) {
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

  async function handleDuplicate(p: Project) {
    if (duplicating) return;
    const newName = prompt(
      `複製專案「${p.name}」\n\n新專案會包含全部 stage objects、歌曲、cue 跟 cue 內的物件位置。\n模型檔共用同一份（不重新上傳）。\n\n新專案名稱：`,
      `${p.name} (副本)`,
    );
    if (!newName) return;
    setDuplicating(p.id);
    try {
      const res = await api.duplicateProject(p.id, { newName: newName.trim() });
      alert(`✅ 已複製：${res.counts.stageObjects} 個物件、${res.counts.songs} 首歌、${res.counts.cues} 個 cue`);
      await refresh();
      navigate(`/admin/projects/${res.id}`);
    } catch (e) {
      alert('複製失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setDuplicating(null);
    }
  }

  async function handleArchive(p: Project) {
    if (!confirm(`封存專案「${p.name}」？\n\n封存後不會在列表中出現，但所有資料保留。日後可以從 D1 還原。`)) return;
    try {
      await api.archiveProject(p.id);
      await refresh();
    } catch (e) {
      alert('封存失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function handleExport(p: Project) {
    try {
      await api.exportProjectToFile(p.id, p.name);
    } catch (e) {
      alert('匯出失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function handleEditTags(p: Project) {
    const current = (p.tags || []).join(', ');
    const input = prompt(
      `編輯「${p.name}」的標籤\n\n用逗號分隔，例：演唱會, 巡迴, 試片\n（最多 20 個）`,
      current,
    );
    if (input == null) return;
    const tags = input.split(',').map(t => t.trim()).filter(Boolean).slice(0, 20);
    try {
      await api.updateProject(p.id, { tags });
      await refresh();
    } catch (e) {
      alert('更新標籤失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function handleImport(file: File) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data?.project || !Array.isArray(data?.stageObjects)) {
        alert('檔案格式不對 — 不像匯出檔');
        return;
      }
      const newName = prompt('匯入後的新專案名稱：', `${data.project.name} (匯入)`);
      if (!newName) return;
      const res = await api.importProject({ ...data, newName: newName.trim() });
      alert(`✅ 已匯入：${res.counts.stageObjects} 物件、${res.counts.songs} 歌、${res.counts.cues} cue`);
      await refresh();
      navigate(`/admin/projects/${res.id}`);
    } catch (e) {
      alert('匯入失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  function triggerImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) handleImport(f);
    };
    input.click();
  }

  // Drag-and-drop JSON import 全頁支援
  const [dragActive, setDragActive] = useState(false);
  useEffect(() => {
    let dragCounter = 0;
    function onDragEnter(e: DragEvent) {
      if (!e.dataTransfer?.types.includes('Files')) return;
      dragCounter++;
      setDragActive(true);
    }
    function onDragLeave() {
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; setDragActive(false); }
    }
    function onDragOver(e: DragEvent) { e.preventDefault(); }
    function onDrop(e: DragEvent) {
      e.preventDefault();
      dragCounter = 0;
      setDragActive(false);
      const files = Array.from(e.dataTransfer?.files || []);
      const json = files.find(f => /\.json$/i.test(f.name));
      if (json) handleImport(json);
    }
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return (
    <>
      {dragActive && (
        <div className="admin-drop-overlay">
          <div className="admin-drop-overlay__inner">
            <div className="admin-drop-overlay__icon">📥</div>
            <div className="admin-drop-overlay__title">放開即匯入專案</div>
            <div className="admin-drop-overlay__hint">.json 備份檔（從匯出產生的）</div>
          </div>
        </div>
      )}
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
          <button className="btn btn--ghost" onClick={triggerImport} title="從 JSON 匯入專案備份（也可拖檔到頁面）">
            ⬆ 匯入
          </button>
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
          <>
            {selectedIds.size > 0 && (
              <div className="bulk-bar">
                <span><strong>已選 {selectedIds.size}</strong> 個專案</span>
                <button className="btn btn--ghost btn--sm" onClick={clearSelection}>清空選擇</button>
                <span style={{ flex: 1 }} />
                <button className="btn btn--ghost btn--sm" onClick={bulkArchive}>🗑 批次封存</button>
              </div>
            )}
            <div className="project-grid">
              {filtered.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  showName={p.showId ? showsById[p.showId] : null}
                  onDuplicate={handleDuplicate}
                  onArchive={handleArchive}
                  onExport={handleExport}
                  onEditTags={handleEditTags}
                  selected={selectedIds.has(p.id)}
                  onToggleSelect={toggleSelect}
                />
              ))}
            </div>
          </>
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
