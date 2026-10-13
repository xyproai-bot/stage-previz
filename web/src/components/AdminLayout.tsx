import { ReactNode, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { helpUrl } from '../lib/helpLinks';
import { ROLE_LABEL } from '../lib/roleLabels';
import { Archive, ArrowLeft, BookOpen, Boxes, Cloud, Folder, LogOut, Settings, Ticket, Users } from 'lucide-react';
import HelpModal from './HelpModal';
import NotificationBell from './NotificationBell';
import OverflowMenu from './OverflowMenu';
import Icon from './Icon';
import { confirmDialog } from './dialogs';
import './AdminLayout.css';

interface AdminLayoutProps {
  children: ReactNode;
}

const NAV = [
  { key: 'projects', icon: Folder, label: '專案', path: '/admin' },
  { key: 'shows', icon: Ticket, label: 'Show 巡迴', path: '/admin/shows' },
  { key: 'drive', icon: Cloud, label: 'Drive 來源', path: '/admin/drive-sources' },
  { key: 'users', icon: Users, label: '用戶', path: '/admin/users' },
  { key: 'templates', icon: Boxes, label: '模型庫', path: '/admin/templates' },
  { key: 'archived', icon: Archive, label: '封存的專案', path: '/admin/archived' },
  { key: 'settings', icon: Settings, label: '設定', path: '/settings' },
];

export default function AdminLayout({ children }: AdminLayoutProps) {
  const { user } = useAuth();
  // 管理側欄只給製作；動畫師 / 導演開設定頁時用簡單的上方列
  if (user && user.role !== 'admin') return <MemberLayout>{children}</MemberLayout>;
  return <AdminShell>{children}</AdminShell>;
}

function AdminShell({ children }: AdminLayoutProps) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [helpOpen, setHelpOpen] = useState(false);
  // 手機上側欄是一條可以左右滑的分頁列：換頁後把目前那一頁捲到看得到
  const navRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>('.admin-sidebar__link.is-active');
    if (active) scrollNavIntoView(active);
  }, [pathname]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === '?' && !helpOpen) {
        const t = e.target as HTMLElement;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        setHelpOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [helpOpen]);

  async function handleLogout() {
    if (!(await confirmDialog({ title: '要登出嗎？', confirmLabel: '登出' }))) return;
    await logout();
    navigate('/login');
  }

  return (
    <div className="admin-layout">
      <aside className="admin-sidebar">
        <button className="admin-sidebar__logo" onClick={() => navigate('/')} title="返回首頁">
          <span className="admin-sidebar__logo-mark" />
          <span className="admin-sidebar__logo-text">STAGE</span>
        </button>

        <nav className="admin-sidebar__nav" ref={navRef}>
          {NAV.map(item => (
            <NavLink
              key={item.key}
              to={item.path}
              end={item.path === '/admin'}
              className={({ isActive }) =>
                'admin-sidebar__link' + (isActive ? ' is-active' : '')
              }
            >
              <span className="admin-sidebar__icon"><Icon icon={item.icon} size="md" /></span>
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="admin-sidebar__footer">
          <div className="admin-sidebar__user">
            <div
              className="avatar avatar--sm"
              style={{ background: user?.avatarColor || '#10c78a' }}
            >
              {user?.name?.[0] || '?'}
            </div>
            <div className="admin-sidebar__user-info">
              <div className="admin-sidebar__user-name">{user?.name || '載入中…'}</div>
              <div className="admin-sidebar__user-role">{user ? ROLE_LABEL[user.role] : ''}</div>
            </div>
            {/* 站內通知（@你、新版、被指派…）：側欄在左下角 → 面板往上開 */}
            <NotificationBell placement="up-left" className="admin-sidebar__bell" />
            <button
              className="admin-sidebar__logout"
              onClick={handleLogout}
              title="登出"
              aria-label="登出"
            ><Icon icon={LogOut} /></button>
          </div>
        </div>
      </aside>

      <main className="admin-main">
        {children}
        <button
          className="admin-help-fab"
          onClick={() => setHelpOpen(true)}
          title="使用說明（按 ? 也可叫出）"
          aria-label="使用說明"
        >?</button>
      </main>
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

/** 手機上側欄變成一條可以左右滑的分頁列：目前那一頁捲到看得到（不動整個頁面） */
function scrollNavIntoView(el: HTMLElement) {
  const nav = el.parentElement;
  if (!nav || nav.scrollWidth <= nav.clientWidth) return;
  const left = el.offsetLeft - (nav.clientWidth - el.offsetWidth) / 2;
  nav.scrollLeft = Math.max(0, left);
}

/** 非製作（動畫師 / 導演）看設定頁時的外框：沒有管理側欄，只有回自己的專案、說明、登出 */
function MemberLayout({ children }: AdminLayoutProps) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  async function handleLogout() {
    if (!(await confirmDialog({ title: '要登出嗎？', confirmLabel: '登出' }))) return;
    await logout();
    navigate('/login');
  }

  return (
    <div className="member-layout">
      <header className="member-layout__top">
        <Link className="member-layout__back" to="/" title="回我的專案" aria-label="回我的專案"><Icon icon={ArrowLeft} /><span className="member-layout__back-label"> 回我的專案</span></Link>
        <span className="member-layout__brand">
          <span className="admin-sidebar__logo-mark" aria-hidden="true" />
          STAGE <strong>PREVIZ</strong>
        </span>
        <span className="member-layout__grow" />
        <a className="member-layout__link ovf-hide-narrow" href={helpUrl()} target="_blank" rel="noopener">使用說明</a>
        <NotificationBell />
        <span className="member-layout__user ovf-hide-narrow">
          <span className="avatar avatar--sm" style={{ background: user?.avatarColor || '#10c78a' }}>
            {user?.name?.[0] || '?'}
          </span>
          <span className="member-layout__user-name">{user?.name}</span>
        </span>
        <button className="member-layout__link ovf-hide-narrow" onClick={handleLogout}>登出</button>
        <OverflowMenu
          className="ovf-only-narrow"
          header={user?.name}
          items={[
            { key: 'help', label: '使用說明', icon: BookOpen, href: helpUrl(), external: true },
            { key: 'logout', label: '登出', icon: LogOut, danger: true, separatorBefore: true, onSelect: () => { void handleLogout(); } },
          ]}
        />
      </header>
      <main className="member-layout__main">{children}</main>
    </div>
  );
}
