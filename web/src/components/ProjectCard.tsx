import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { Project, SongStatus, SongStatusCounts } from '../lib/mockData';
import { formatRelativeTime } from '../lib/serverTime';
import { Archive, Copy, Download, Ellipsis, Pencil, Tag, Ticket } from 'lucide-react';
import Icon from './Icon';
import { useViewAsMenu, VIEW_AS_MENU_LABEL } from './ViewAsMenu';
import { editorPath } from '../lib/viewAs';
import './ProjectCard.css';

const STATUS_LABELS: Record<Project['status'], { label: string; cls: string }> = {
  active: { label: '進行中', cls: 'status--active' },
  in_review: { label: '審查中', cls: 'status--review' },
  archived: { label: '封存', cls: 'status--archived' },
};

// Tag 文字 → 穩定 hash → HSL 色相（讓同一 tag 永遠同色）
function tagStyle(tag: string): React.CSSProperties {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) | 0;
  const h = Math.abs(hash) % 360;
  return {
    background: `hsla(${h}, 60%, 45%, 0.18)`,
    color: `hsl(${h}, 70%, 65%)`,
    border: `1px solid hsla(${h}, 60%, 45%, 0.4)`,
  };
}

const SONG_STATUS_ORDER: SongStatus[] = ['approved', 'in_review', 'needs_changes', 'todo'];
const SONG_STATUS_LABEL: Record<SongStatus, string> = {
  approved: '已通過',
  in_review: '審查中',
  needs_changes: '需修改',
  todo: '待製作',
};

export default function ProjectCard({
  project, showName, onDuplicate, onArchive, onExport, onEditTags, onRename,
  selected, onToggleSelect, showViewAs,
}: {
  project: Project;
  showName?: string | null;
  onDuplicate?: (project: Project) => void;
  onArchive?: (project: Project) => void;
  onExport?: (project: Project) => void;
  onEditTags?: (project: Project) => void;
  /** 改專案名稱和說明 */
  onRename?: (project: Project) => void;
  selected?: boolean;
  onToggleSelect?: (project: Project) => void;
  /** 選單裡加「用其他身分看」：導演畫面 / 動畫師畫面 / 客戶畫面（管理頁給製作用） */
  showViewAs?: boolean;
}) {
  const navigate = useNavigate();
  const status = STATUS_LABELS[project.status];
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // 選單放在 body 底下（卡片會裁掉超出的部分、滑鼠移上去還會位移），用按鈕的位置定位
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent | TouchEvent) {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setMenuOpen(false); }
    // 捲動 / 縮放 → 關掉（位置對不上了）；捲的是選單自己就不用
    function onScroll(e: Event) { if (!listRef.current?.contains(e.target as Node)) setMenuOpen(false); }
    const onResize = () => setMenuOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('touchstart', onClick);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('touchstart', onClick);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [menuOpen]);

  useLayoutEffect(() => {
    if (!menuOpen) { setMenuPos(null); return; }
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = 220;
    const left = Math.max(8, Math.min(Math.round(r.left), window.innerWidth - width - 8));
    const top = Math.round(r.bottom + 4);
    setMenuPos({ top, left, maxHeight: Math.max(160, window.innerHeight - top - 8) });
  }, [menuOpen]);

  // 「用其他身分看」：選單打開時才去讀分享連結
  const animators = useMemo(() => project.members.filter(m => m.role === 'animator'), [project.members]);
  const viewAsMenu = useViewAsMenu({
    projectId: project.id,
    animators,
    onCreateShare: () => navigate(editorPath(project.id), { state: { openShare: true } }),
  });
  const { load: loadViewAs } = viewAsMenu;
  useEffect(() => { if (menuOpen && showViewAs) loadViewAs(); }, [menuOpen, showViewAs, loadViewAs]);

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
        {(onDuplicate || onArchive || onExport || onRename || showViewAs) && (
          // 鍵盤（Enter / 空白鍵）按選單不要變成「進入專案」
          <div className={'project-card__menu' + (menuOpen ? ' is-open' : '')} ref={menuRef} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <button
              ref={triggerRef}
              className="project-card__menu-trigger"
              onClick={() => setMenuOpen(o => !o)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="更多動作"
              title="更多動作"
            ><Icon icon={Ellipsis} size="md" /></button>
            {menuOpen && menuPos && createPortal(
              <div
                className="project-card__menu-list"
                ref={listRef}
                role="menu"
                style={{ position: 'fixed', top: menuPos.top, left: menuPos.left, maxHeight: menuPos.maxHeight }}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                {onRename && (
                  <button
                    className="project-card__menu-item"
                    onClick={() => { setMenuOpen(false); onRename(project); }}
                  ><Icon icon={Pencil} /> 改名稱和說明</button>
                )}
                {onDuplicate && (
                  <button
                    className="project-card__menu-item"
                    onClick={() => { setMenuOpen(false); onDuplicate(project); }}
                  ><Icon icon={Copy} /> 複製專案</button>
                )}
                {onExport && (
                  <button
                    className="project-card__menu-item"
                    onClick={() => { setMenuOpen(false); onExport(project); }}
                  ><Icon icon={Download} /> 匯出 JSON</button>
                )}
                {onEditTags && (
                  <button
                    className="project-card__menu-item"
                    onClick={() => { setMenuOpen(false); onEditTags(project); }}
                  ><Icon icon={Tag} /> 編輯標籤</button>
                )}
                {onArchive && (
                  <button
                    className="project-card__menu-item project-card__menu-item--danger"
                    onClick={() => { setMenuOpen(false); onArchive(project); }}
                  ><Icon icon={Archive} /> 封存</button>
                )}
                {showViewAs && (
                  <>
                    <div className="project-card__menu-sep" role="separator" />
                    <div className="project-card__menu-section">{VIEW_AS_MENU_LABEL}</div>
                    {viewAsMenu.items.map(it => (it.href && !it.disabled ? (
                      <a
                        key={it.key}
                        className="project-card__menu-item"
                        href={it.href}
                        target="_blank"
                        rel="noopener"
                        onClick={() => setMenuOpen(false)}
                      >{it.icon && <Icon icon={it.icon} />} {it.label}</a>
                    ) : (
                      <button
                        key={it.key}
                        className="project-card__menu-item"
                        disabled={it.disabled}
                        onClick={() => { setMenuOpen(false); it.onSelect?.(); }}
                      >{it.icon && <Icon icon={it.icon} />} {it.label}</button>
                    )))}
                  </>
                )}
              </div>,
              document.body,
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
            <Icon icon={Ticket} size="xs" /> {showName}
          </button>
        )}
        <h3 className="project-card__title">{project.name}</h3>
        {project.tags && project.tags.length > 0 && (
          <div className="project-card__tags">
            {project.tags.map(t => (
              <span key={t} className="project-card__tag" style={tagStyle(t)}>#{t}</span>
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
          <span>{project.cueCount} 個 cue</span>
          {project.proposalCount > 0 && (
            <>
              <span className="dot">·</span>
              <span className="project-card__proposals">{project.proposalCount} 提案</span>
            </>
          )}
          <span className="dot">·</span>
          <span className="project-card__time">{formatRelativeTime(project.updatedAt)}</span>
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
