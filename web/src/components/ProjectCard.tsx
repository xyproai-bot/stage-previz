import { useNavigate } from 'react-router-dom';
import type { Project } from '../lib/mockData';
import './ProjectCard.css';

const STATUS_LABELS: Record<Project['status'], { label: string; cls: string }> = {
  active: { label: '進行中', cls: 'status--active' },
  in_review: { label: '待修', cls: 'status--review' },
  archived: { label: '封存', cls: 'status--archived' },
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

export default function ProjectCard({ project }: { project: Project }) {
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
        <h3 className="project-card__title">{project.name}</h3>
        <p className="project-card__desc">{project.description}</p>

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
