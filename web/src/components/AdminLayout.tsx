import { ReactNode, useEffect, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { helpUrl } from '../lib/helpLinks';
import { ROLE_LABEL } from '../lib/roleLabels';
import { Archive, Boxes, Cloud, Folder, LogOut, Settings, Ticket, Users } from 'lucide-react';
import HelpModal from './HelpModal';
import NotificationBell from './NotificationBell';
import Icon from './Icon';
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
    if (!confirm('登出？')) return;
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

        <nav className="admin-sidebar__nav">
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

/** 非製作（動畫師 / 導演）看設定頁時的外框：沒有管理側欄，只有回自己的專案、說明、登出 */
function MemberLayout({ children }: AdminLayoutProps) {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  async function handleLogout() {
    if (!confirm('登出？')) return;
    await logout();
    navigate('/login');
  }

  return (
    <div className="member-layout">
      <header className="member-layout__top">
        <Link className="member-layout__back" to="/">回我的專案</Link>
        <span className="member-layout__brand">
          <span className="admin-sidebar__logo-mark" aria-hidden="true" />
          STAGE <strong>PREVIZ</strong>
        </span>
        <span className="member-layout__grow" />
        <a className="member-layout__link" href={helpUrl()} target="_blank" rel="noopener">使用說明</a>
        <NotificationBell />
        <span className="member-layout__user">
          <span className="avatar avatar--sm" style={{ background: user?.avatarColor || '#10c78a' }}>
            {user?.name?.[0] || '?'}
          </span>
          <span>{user?.name}</span>
        </span>
        <button className="member-layout__link" onClick={handleLogout}>登出</button>
      </header>
      <main className="member-layout__main">{children}</main>
    </div>
  );
}
