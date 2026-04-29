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

export default function ProjectCard({ project, showName }: { project: Project; showName?: string | null }) {
  const navigate = useNavigate();
  const status = STATUS_LABELS[project.status];

  const visibleMembers = project.members.slice(0, 5);
  const overflow = project.members.length - visibleMembers.length;

  return (
    <article
      className="project-card"
      onClick={() => navigate(`/admin/projects/${project.id}`)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          navigate(`/admin/projects/${project.id}`);
        }
      }}
    >
      <div className="project-card__thumb">
        {project.thumbnailUrl ? (
          <img src={project.thumbnailUrl} alt={project.name} />
        ) : (
          <div className="project-card__thumb-placeholder">16:9</div>
        )}
        <span className={`project-card__status ${status.cls}`}>{status.label}</span>
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
