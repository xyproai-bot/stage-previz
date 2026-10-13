// 「我的專案」清單：動畫師工作站（/studio）、導演審片（/preview）沒指定專案時看到的頁面。
// 後台只回這個人被加入的專案（製作看得到全部）。

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import * as api from './api';
import type { Project, SongStatusCounts } from './mockData';
import { formatRelativeTime } from './serverTime';
import { helpUrl } from './helpLinks';
import { ProjectCardSkeleton } from '../components/Skeleton';
import './myProjects.css';

type Kind = 'studio' | 'preview';

const COPY: Record<Kind, { title: string; sub: string }> = {
  studio: { title: '動畫師工作站', sub: '選一個專案，看你要做的歌和 cue' },
  preview: { title: '導演審片', sub: '選一個專案，看每首歌的進度、影片和留言' },
};

const SEGMENTS: { key: keyof SongStatusCounts; label: string }[] = [
  { key: 'approved', label: '已通過' },
  { key: 'in_review', label: '審查中' },
  { key: 'needs_changes', label: '需修改' },
  { key: 'todo', label: '待製作' },
];

export default function MyProjectsPage({ kind }: { kind: Kind }) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setError(null);
    setProjects(null);
    api.listProjects()
      .then(list => { if (!cancelled) setProjects(list); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => load(), [load]);

  if (!user) return null;  // 外層 RequireAuth 已經擋掉沒登入的
  const copy = COPY[kind];

  return (
    <div className="my-projects">
      <header className="my-projects__top">
        <span className="my-projects__brand">
          <span className="my-projects__brand-mark" aria-hidden="true" />
          STAGE <strong>PREVIZ</strong>
        </span>
        <span className="my-projects__grow" />
        {user.role === 'admin' && <Link className="my-projects__link" to="/admin">回管理頁</Link>}
        <a className="my-projects__link" href={helpUrl()} target="_blank" rel="noopener">使用說明</a>
        <Link className="my-projects__link" to="/settings">設定</Link>
        <span className="my-projects__user">
          <span className="avatar avatar--sm" style={{ background: user.avatarColor }}>{user.name?.[0] || '?'}</span>
          <span className="my-projects__user-name">{user.name}</span>
        </span>
        <button
          className="my-projects__link my-projects__logout"
          onClick={async () => { await logout(); navigate('/login'); }}
        >登出</button>
      </header>

      <main className="my-projects__main">
        <h1>{copy.title}</h1>
        <p className="my-projects__sub">{copy.sub}</p>

        {error && (
          <div className="my-projects__notice my-projects__notice--error" role="alert">
            <p>讀不到專案清單：{error}</p>
            <button className="btn btn--ghost" onClick={load}>重試</button>
          </div>
        )}

        {!projects && !error && (
          <div className="my-projects__grid">
            {Array.from({ length: 3 }).map((_, i) => <ProjectCardSkeleton key={i} />)}
          </div>
        )}

        {projects && projects.length === 0 && (
          <div className="my-projects__notice">
            <p>還沒有被加入任何專案，請聯絡製作</p>
          </div>
        )}

        {projects && projects.length > 0 && (
          <div className="my-projects__grid">
            {projects.map(p => <ProjectTile key={p.id} project={p} to={`/${kind}/${encodeURIComponent(p.id)}`} />)}
          </div>
        )}
      </main>
    </div>
  );
}

function ProjectTile({ project: p, to }: { project: Project; to: string }) {
  const counts = p.songStatusCounts || { todo: p.songCount, in_review: 0, approved: 0, needs_changes: 0 };
  const total = counts.todo + counts.in_review + counts.approved + counts.needs_changes;
  const updated = formatRelativeTime(p.updatedAt);
  return (
    <Link to={to} className="my-projects__card">
      <div className="my-projects__card-name">{p.name}</div>
      {p.description && <div className="my-projects__card-desc">{p.description}</div>}
      <div className="my-projects__bar" aria-hidden="true">
        {total > 0 && SEGMENTS.map(s => counts[s.key] > 0 && (
          <span
            key={s.key}
            className={`my-projects__bar-seg my-projects__bar-seg--${s.key}`}
            style={{ width: `${(counts[s.key] / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="my-projects__card-stats">
        {total === 0 ? (
          <span>還沒有歌</span>
        ) : (
          <>
            <span>{total} 首歌</span>
            {SEGMENTS.filter(s => counts[s.key] > 0).map(s => (
              <span key={s.key} className={`my-projects__stat my-projects__stat--${s.key}`}>{s.label} {counts[s.key]}</span>
            ))}
          </>
        )}
      </div>
      {updated && <div className="my-projects__card-time">更新於 {updated}</div>}
    </Link>
  );
}
