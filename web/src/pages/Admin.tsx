import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import AdminLayout from '../components/AdminLayout';
import ProjectCard from '../components/ProjectCard';
import NewProjectWizard from '../components/NewProjectWizard';
import ProjectWrapUpDialog from '../components/ProjectWrapUpDialog';
import RecentProjectsBar from '../components/RecentProjectsBar';
import OverflowMenu from '../components/OverflowMenu';
import * as api from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Project } from '../lib/mockData';
import Icon from '../components/Icon';
import { confirmDialog, promptDialog, toast } from '../components/dialogs';
import {
  needsResume, readWizardProgress, resumeStep, stepFromParam, stepLabel, unfinishedSteps, writeWizardProgress,
  type WizardProgress, type WizardStep,
} from '../lib/newProjectWizard';
import {
  Archive, ArrowRight, Clapperboard, Construction, Folder, Import, ListChecks, LoaderCircle, Music, Plus, Search, Shapes, TriangleAlert, Upload,
} from 'lucide-react';
import './Admin.css';

type Filter = 'all' | 'active' | 'in_review' | 'mine';

export default function Admin() {
  const { tab } = useParams();

  if (tab === 'drive-sources') return <AdminLayout><PlaceholderTab name="Drive 來源" /></AdminLayout>;
  if (tab === 'users') return <AdminLayout><PlaceholderTab name="用戶" /></AdminLayout>;
  if (tab === 'templates') return <AdminLayout><PlaceholderTab name="模型庫" /></AdminLayout>;

  return (
    <AdminLayout>
      <RecentProjectsBar />
      <ProjectsTab />
    </AdminLayout>
  );
}

function ProjectsTab() {
  const navigate = useNavigate();
  const { user } = useAuth();
  // 「我負責的」= 我有被加進去的專案（用登入的人的 id 比，不是名字）
  const myId = user?.id ?? null;
  const isMine = (p: Project) => myId != null && p.members.some(m => m.id === myId);
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
  const [duplicating, setDuplicating] = useState<string | null>(null);

  // ── 新專案精靈：步驟放在網址上（?new=<步驟>&project=<id>）→ 瀏覽器 / 手機的上一頁 = 上一步 ──
  // wizardDepth = 打開精靈之後在瀏覽器裡往前走了幾頁（關掉時一次退回打開前那一頁，按上一頁不會又跑回精靈）
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const wizardProjectId = searchParams.get('project');
  const wizardStep = stepFromParam(searchParams.get('new'), !!wizardProjectId);
  const wizardDepth = Math.max(0, Number((location.state as { wizardDepth?: unknown } | null)?.wizardDepth) || 0);
  const goWizard = useCallback((step: WizardStep, projectId: string | null, opts: { replace?: boolean } = {}) => {
    const q = new URLSearchParams({ new: step });
    if (projectId) q.set('project', projectId);
    navigate({ search: '?' + q.toString() }, { replace: !!opts.replace, state: { wizardDepth: opts.replace ? Math.max(1, wizardDepth) : wizardDepth + 1 } });
  }, [navigate, wizardDepth]);
  const backWizard = useCallback((step: WizardStep, projectId: string | null) => {
    // 前一頁就是上一步（照順序走過來的）→ 用瀏覽器的上一頁；從「繼續設定」直接跳進來的 → 換過去
    if (wizardDepth > 1) navigate(-1);
    else goWizard(step, projectId, { replace: true });
  }, [navigate, goWizard, wizardDepth]);
  const closeWizard = useCallback(() => {
    if (wizardProjectId) {
      const p = readWizardProgress(safeLocalStorage());
      if (p && p.projectId === wizardProjectId && needsResume(p)) {
        toast.info(`「${p.projectName || '新專案'}」已經建好了，沒做完的可以之後在編輯頁設定，或在專案總覽按「繼續設定」`);
      }
    }
    if (wizardDepth > 0) navigate(-wizardDepth);
    else navigate({ search: '' }, { replace: true });
  }, [navigate, wizardDepth, wizardProjectId]);
  // 精靈關掉 → 重新整理專案卡片、看要不要提醒「繼續設定」
  const [resume, setResume] = useState<WizardProgress | null>(() => readWizardProgress(safeLocalStorage()));
  const wasWizardOpen = useRef(wizardStep !== null);
  useEffect(() => {
    const open = wizardStep !== null;
    if (wasWizardOpen.current && !open) {
      setResume(readWizardProgress(safeLocalStorage()));
      void refresh();
    }
    wasWizardOpen.current = open;
  }, [wizardStep]); // eslint-disable-line react-hooks/exhaustive-deps
  const resumeProject = resume && needsResume(resume) ? projects.find(p => p.id === resume.projectId) ?? null : null;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // 封存：問要不要順便清影片（專案結束清影片）
  const [archiving, setArchiving] = useState<Project | null>(null);

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
    if (!(await confirmDialog({
      title: `封存選中的 ${ids.length} 個專案？`,
      message: '封存後不會出現在專案總覽，資料都會留著，之後可以在「封存的專案」還原。影片全部留著；要清掉用不到的版本，之後可以在「封存的專案」按「清影片」。',
      confirmLabel: '封存',
      destructive: true,
    }))) return;
    let ok = 0, fail = 0;
    for (const id of ids) {
      try { await api.archiveProject(id); ok++; }
      catch { fail++; }
    }
    if (fail) toast.warn(`已封存 ${ok} 個，${fail} 個沒有封存成功`);
    else toast.success(`已封存 ${ok} 個專案`);
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
    else if (filter === 'mine') list = list.filter(isMine);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
    }
    return list;
  }, [projects, filter, search, myId]);

  const counts = useMemo(() => ({
    all: projects.length,
    active: projects.filter(p => p.status === 'active').length,
    in_review: projects.filter(p => p.status === 'in_review').length,
    mine: projects.filter(isMine).length,
  }), [projects, myId]);

  async function handleDuplicate(p: Project) {
    if (duplicating) return;
    const newName = await promptDialog({
      title: `複製專案「${p.name}」`,
      message: '會帶過去：模型（共用同一份，不用重新上傳）、物件、歌曲（代號、狀態、負責動畫師）、cue 和每個 cue 的位置、機關。\n不會帶過去：影片版本、留言、審片紀錄、成員和分享連結。新專案要用的話，請再邀請導演和動畫師、讓動畫師重新交影片。',
      label: '新專案名稱',
      defaultValue: `${p.name} (副本)`,
      confirmLabel: '複製',
      maxLength: 100,
    });
    if (!newName?.trim()) return;
    setDuplicating(p.id);
    try {
      const res = await api.duplicateProject(p.id, { newName: newName.trim() });
      toast.success(`已複製：${res.counts.stageObjects} 個物件、${res.counts.songs} 首歌、${res.counts.cues} 個 cue`);
      await refresh();
      navigate(`/admin/projects/${res.id}`);
    } catch (e) {
      toast.error('複製失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setDuplicating(null);
    }
  }

  function handleArchive(p: Project) {
    setArchiving(p);
  }

  async function handleExport(p: Project) {
    try {
      await api.exportProjectToFile(p.id, p.name);
    } catch (e) {
      toast.error('匯出失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function handleEditTags(p: Project) {
    const current = (p.tags || []).join(', ');
    const input = await promptDialog({
      title: `「${p.name}」的標籤`,
      label: '標籤（用逗號分開，最多 20 個）',
      placeholder: '例：演唱會, 巡迴, 試片',
      defaultValue: current,
      hint: '全部清空就是拿掉所有標籤',
      confirmLabel: '儲存',
      required: false,
    });
    if (input == null) return;
    const tags = input.split(',').map(t => t.trim()).filter(Boolean).slice(0, 20);
    try {
      await api.updateProject(p.id, { tags });
      await refresh();
    } catch (e) {
      toast.error('標籤沒有存到：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async function handleImport(file: File) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data?.project || !Array.isArray(data?.stageObjects)) {
        toast.error('這個檔案不是專案備份。請選「匯出」存下來的 .json 檔');
        return;
      }
      const newName = await promptDialog({
        title: '匯入專案',
        label: '匯入後的專案名稱',
        defaultValue: `${data.project.name} (匯入)`,
        confirmLabel: '匯入',
        maxLength: 100,
      });
      if (!newName?.trim()) return;
      const res = await api.importProject({ ...data, newName: newName.trim() });
      toast.success(`已匯入：${res.counts.stageObjects} 個物件、${res.counts.songs} 首歌、${res.counts.cues} 個 cue`);
      await refresh();
      navigate(`/admin/projects/${res.id}`);
    } catch (e) {
      toast.error(e instanceof SyntaxError ? '這個檔案讀不懂，不是專案備份（.json）' : '匯入失敗：' + (e instanceof Error ? e.message : String(e)));
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
            <div className="admin-drop-overlay__icon"><Icon icon={Import} size="xxl" /></div>
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
          <button className="btn btn--ghost ovf-hide-narrow" onClick={triggerImport} title="從 JSON 匯入專案備份（也可拖檔到頁面）">
            <Icon icon={Upload} /> 匯入
          </button>
          <OverflowMenu
            className="ovf-only-narrow"
            items={[{ key: 'import', label: '匯入專案備份（.json）', icon: Upload, onSelect: triggerImport }]}
          />
          <button className="btn btn--primary" onClick={() => goWizard('name', null)}>
            <Icon icon={Plus} /> 新增專案
          </button>
        </div>
      </header>

      <div className="admin-content">
        {resumeProject && resume && wizardStep === null && (
          <div className="admin-resume" role="status">
            <Icon icon={ListChecks} size="md" />
            <span className="admin-resume__text">
              「{resumeProject.name}」還沒設定完：{unfinishedSteps(resume).map(stepLabel).join('、')}
            </span>
            <button className="btn btn--primary btn--sm" onClick={() => goWizard(resumeStep(resume), resume.projectId)}>繼續設定</button>
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => { writeWizardProgress(safeLocalStorage(), null); setResume(null); }}
              title="不用再提醒（之後在編輯頁慢慢設定也可以）"
            >
              不用了
            </button>
          </div>
        )}
        <div className="filter-chips">
          {([
            ['all', '全部'],
            ['active', '進行中'],
            ['in_review', '審查中'],
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
            onCreate={() => goWizard('name', null)}
            onClearFilter={() => { setSearch(''); setFilter('all'); }}
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
                <button className="btn btn--ghost btn--sm" onClick={bulkArchive}><Icon icon={Archive} /> 批次封存</button>
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
                  showViewAs
                  selected={selectedIds.has(p.id)}
                  onToggleSelect={toggleSelect}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {wizardStep && (
        <NewProjectWizard
          step={wizardStep}
          projectId={wizardProjectId}
          onGo={goWizard}
          onBack={backWizard}
          onClose={closeWizard}
          onOpenEditor={(id) => navigate(`/admin/projects/${encodeURIComponent(id)}`)}
          onProjectCreated={() => { void refresh(); }}
        />
      )}
      {archiving && (
        <ProjectWrapUpDialog open mode="archive" project={archiving} onClose={() => setArchiving(null)} onDone={() => { void refresh(); }} />
      )}
    </>
  );
}

function safeLocalStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

function EmptyState({ onCreate, onClearFilter, hasFilter, hasAnyProjects }: {
  onCreate: () => void;
  onClearFilter: () => void;
  hasFilter: boolean;
  hasAnyProjects: boolean;
}) {
  if (hasFilter && hasAnyProjects) {
    return (
      <div className="empty-card">
        <div className="empty-card__icon"><Icon icon={Search} size="xl" /></div>
        <p>找不到符合的專案</p>
        <small>換個關鍵字，或看全部的專案</small>
        <button className="btn btn--ghost" onClick={onClearFilter} style={{ marginTop: 12 }}>顯示全部專案</button>
      </div>
    );
  }
  return <OnboardingWizard onStart={onCreate} />;
}

function OnboardingWizard({ onStart }: { onStart: () => void }) {
  const steps = [
    { icon: Folder,       title: '建立專案', desc: '取一個名字，例如「魅影巡演 2026」', here: true },
    { icon: Upload,       title: '上傳 3D 模型', desc: '把舞臺的 .glb / .gltf 拖進來，自動分類 LED / 走位 / 機關' },
    { icon: Shapes,       title: '認識物件',     desc: '一鍵塞入 10 個常用範例，或手動加你的物件' },
    { icon: Music,        title: '加入歌曲',     desc: '依歌單排好順序，每首歌可以分開追蹤進度' },
    { icon: Clapperboard, title: '製作第一個 cue', desc: '從 3D 畫面直接記下目前的位置，或從空白建立' },
  ];
  return (
    <div className="onboarding">
      <div className="onboarding__head">
        <div className="onboarding__hello">歡迎</div>
        <h2>5 個步驟建立你的第一個 LED 舞臺預覽</h2>
        <p className="onboarding__sub">按「建立專案」會一步一步帶你：名稱、3D 模型、LED 畫布大小、歌單、邀請人（每一步都可以先跳過）</p>
      </div>
      <ol className="onboarding__steps">
        {steps.map((s, i) => (
          <li key={i} className={'onboarding-step' + (s.here ? ' is-current' : '')}>
            <div className="onboarding-step__num">{i + 1}</div>
            <div className="onboarding-step__icon" aria-hidden="true"><Icon icon={s.icon} size="lg" /></div>
            <div className="onboarding-step__body">
              <div className="onboarding-step__title">
                {s.title}
                {s.here && <span className="onboarding-step__here">就在這一步</span>}
              </div>
              <div className="onboarding-step__desc">{s.desc}</div>
            </div>
            {s.here && (
              <button className="btn btn--primary onboarding-step__cta" onClick={onStart}>
                建立專案 <Icon icon={ArrowRight} />
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
      <div className="empty-card__icon"><Icon icon={LoaderCircle} size="xl" spin /></div>
      <p>載入專案中…</p>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="empty-card">
      <div className="empty-card__icon"><Icon icon={TriangleAlert} size="xl" /></div>
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
          <div className="empty-card__icon"><Icon icon={Construction} size="xl" /></div>
          <p>{name} 功能開發中</p>
          <small>之後的版本會加上</small>
        </div>
      </div>
    </>
  );
}
