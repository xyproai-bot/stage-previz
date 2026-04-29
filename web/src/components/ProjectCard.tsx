import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Project, SongStatus, SongStatusCounts } from '../lib/mockData';
import './ProjectCard.css';

const STATUS_LABELS: Record<Project['status'], { label: string; cls: string }> = {
  active: { label: '進行中', cls: 'status--active' },
  in_review: { label: '待修', cls: 'status--review' },
  archived: { label: '封存', cls: 'status--archived' },
};

const SONG_STATUS_ORDER: SongStatus[] = ['approved', 'in_review', 'needs_changes', 'todo'];
const SONG_STATUS_LABEL: Record<SongStatus, string> = {
  approved: '已通過',
  in_review: '審查中',
  needs_changes: '需修改',
  todo: '未開始',
};

function timeAgo(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return '剛才';
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  const day = Math.floor(hr / 24);
  return `${day} 天前`;
}

export default function ProjectCard({
  project, showName, onDuplicate, onArchive, onExport, onEditTags,
  selected, onToggleSelect,
}: {
  project: Project;
  showName?: string | null;
  onDuplicate?: (project: Project) => void;
  onArchive?: (project: Project) => void;
  onExport?: (project: Project) => void;
  onEditTags?: (project: Project) => void;
  selected?: boolean;
  onToggleSelect?: (project: Project) => void;
}) {
  const navigate = useNavigate();
  const status = STATUS_LABELS[project.status];
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  const visibleMembers = project.members.slice(0, 5);
  const overflow = project.members.length - visibleMembers.length;

  return (
    <article
      className={'project-card' + (selected ? ' is-selected' : '')}
      onClick={(e) => {
        // 點 checkbox / menu 不要當「進入專案」
        const t = e.target as HTMLElement;
        if (t.closest('.project-card__menu') || t.closest('.project-card__select')) return;
        navigate(`/admin/projects/${project.id}`);
      }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          navigate(`/admin/projects/${project.id}`);
        }
      }}
    >
      {onToggleSelect && (
        <div className="project-card__select" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onToggleSelect(project)}
            aria-label="選擇此專案"
          />
        </div>
      )}
      <div className="project-card__thumb">
        {project.thumbnailUrl ? (
          <img src={project.thumbnailUrl} alt={project.name} />
        ) : (
          <div className="project-card__thumb-placeholder">16:9</div>
        )}
        <span className={`project-card__status ${status.cls}`}>{status.label}</span>
        {(onDuplicate || onArchive || onExport) && (
          <div className="project-card__menu" ref={menuRef} onClick={(e) => e.stopPropagation()}>
            <button
              className="project-card__menu-trigger"
              onClick={() => setMenuOpen(o => !o)}
              aria-label="更多動作"
              title="更多動作"
            >⋯</button>
            {menuOpen && (
              <div className="project-card__menu-list">
                {onDuplicate && (
                  <button
                    className="project-card__menu-item"
                    onClick={() => { setMenuOpen(false); onDuplicate(project); }}
                  >📋 複製專案</button>
                )}
                {onExport && (
                  <button
                    className="project-card__menu-item"
                    onClick={() => { setMenuOpen(false); onExport(project); }}
                  >💾 匯出 JSON</button>
                )}
                {onEditTags && (
                  <button
                    className="project-card__menu-item"
                    onClick={() => { setMenuOpen(false); onEditTags(project); }}
                  >🏷 編輯標籤</button>
                )}
                {onArchive && (
                  <button
                    className="project-card__menu-item project-card__menu-item--danger"
                    onClick={() => { setMenuOpen(false); onArchive(project); }}
                  >🗑 封存</button>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="project-card__body">
        {showName && (
          <button
            type="button"
            className="project-card__show"
            onClick={(e) => { e.stopPropagation(); if (project.showId) navigate(`/admin/shows/${project.showId}`); }}
            title={`Show: ${showName}`}
          >
            🎫 {showName}
          </button>
        )}
        <h3 className="project-card__title">{project.name}</h3>
        {project.tags && project.tags.length > 0 && (
          <div className="project-card__tags">
            {project.tags.map(t => (
              <span key={t} className="project-card__tag">#{t}</span>
            ))}
          </div>
        )}
        <p className="project-card__desc">{project.description}</p>

        <SongProgress
          counts={project.songStatusCounts}
          total={project.songCount}
        />

        <div className="project-card__stats">
          <span>{project.songCount} 首歌</span>
          <span className="dot">·</span>
          <span>{project.cueCount} cues</span>
          {project.proposalCount > 0 && (
            <>
              <span className="dot">·</span>
              <span className="project-card__proposals">{project.proposalCount} 提案</span>
            </>
          )}
          <span className="dot">·</span>
          <span className="project-card__time">{timeAgo(project.updatedAt)}</span>
        </div>

        <div className="project-card__avatars">
          {visibleMembers.map((m) => (
            <div
              key={m.id}
              className="avatar avatar--xs"
              style={{ background: m.avatarColor }}
              title={m.name}
            >
              {m.name[0]}
            </div>
          ))}
          {overflow > 0 && (
            <div className="avatar avatar--xs project-card__avatar-more">+{overflow}</div>
          )}
        </div>
      </div>
    </article>
  );
}

function SongProgress({ counts, total }: { counts?: SongStatusCounts; total: number }) {
  if (total === 0) {
    return (
      <div className="project-card__progress is-empty">
        <div className="project-card__progressbar" aria-hidden="true">
          <span className="seg seg--empty" style={{ flex: 1 }} />
        </div>
        <div className="project-card__progress-label">尚無歌曲</div>
      </div>
    );
  }

  // worker 還沒部署時 counts 會是 undefined → 顯示「待後端推送」的樣式（全顯灰）
  const safe: SongStatusCounts = counts ?? { todo: total, in_review: 0, approved: 0, needs_changes: 0 };
  const approved = safe.approved;
  const pct = Math.round((approved / total) * 100);

  return (
    <div
      className="project-card__progress"
      title={SONG_STATUS_ORDER
        .filter(s => safe[s] > 0)
        .map(s => `${SONG_STATUS_LABEL[s]} ${safe[s]}`)
        .join(' · ')}
    >
      <div className="project-card__progressbar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`已通過 ${approved} / ${total}`}>
        {SONG_STATUS_ORDER.map(s => {
          const n = safe[s];
          if (n === 0) return null;
          return <span key={s} className={`seg seg--${s.replace('_', '-')}`} style={{ flex: n }} />;
        })}
      </div>
      <div className="project-card__progress-label">
        <span className="strong">{approved}</span> / {total} 已通過
        <span className="muted"> · {pct}%</span>
      </div>
    </div>
  );
}
