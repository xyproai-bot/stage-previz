import { ReactNode, useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import HelpModal from './HelpModal';
import './AdminLayout.css';

interface AdminLayoutProps {
  children: ReactNode;
}

const NAV = [
  { key: 'projects', icon: '📁', label: '專案', path: '/admin' },
  { key: 'shows', icon: '🎫', label: 'Show 巡迴', path: '/admin/shows' },
  { key: 'drive', icon: '☁️', label: 'Drive 來源', path: '/admin/drive-sources' },
  { key: 'users', icon: '👥', label: '用戶', path: '/admin/users' },
  { key: 'templates', icon: '📐', label: '模板庫', path: '/admin/templates' },
  { key: 'settings', icon: '⚙️', label: '設定', path: '/admin/settings' },
];

export default function AdminLayout({ children }: AdminLayoutProps) {
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
              <span className="admin-sidebar__icon">{item.icon}</span>
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
              <div className="admin-sidebar__user-name">{user?.name || 'Loading…'}</div>
              <div className="admin-sidebar__user-role">{user?.role || ''}</div>
            </div>
            <button
              className="admin-sidebar__logout"
              onClick={handleLogout}
              title="登出"
              aria-label="登出"
            >⏻</button>
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
