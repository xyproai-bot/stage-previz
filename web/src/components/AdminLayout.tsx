import { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import './AdminLayout.css';

interface AdminLayoutProps {
  children: ReactNode;
}

const NAV = [
  { key: 'projects', icon: '📁', label: '專案', path: '/admin' },
  { key: 'drive', icon: '☁️', label: 'Drive 來源', path: '/admin/drive-sources' },
  { key: 'users', icon: '👥', label: '用戶', path: '/admin/users' },
  { key: 'templates', icon: '📐', label: '模板庫', path: '/admin/templates' },
  { key: 'settings', icon: '⚙️', label: '設定', path: '/admin/settings' },
];

export default function AdminLayout({ children }: AdminLayoutProps) {
  const navigate = useNavigate();

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
            <div className="avatar avatar--sm" style={{ background: '#10c78a' }}>P</div>
            <div className="admin-sidebar__user-info">
              <div className="admin-sidebar__user-name">phang9111</div>
              <div className="admin-sidebar__user-role">Admin</div>
            </div>
          </div>
        </div>
      </aside>

      <main className="admin-main">{children}</main>
    </div>
  );
}
