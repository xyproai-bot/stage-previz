import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getRecentProjects } from './CommandPalette';
import './RecentProjectsBar.css';

/**
 * Admin 頂部最近開過的專案橫條（最多 8 個）
 * 從 localStorage 讀（CommandPalette 共用）
 */
export default function RecentProjectsBar() {
  const navigate = useNavigate();
  const [items, setItems] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    setItems(getRecentProjects());
    // 切回此頁時重新整理（focus 事件）
    const onFocus = () => setItems(getRecentProjects());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="recent-bar">
      <span className="recent-bar__label">最近</span>
      <div className="recent-bar__items">
        {items.map(p => (
          <button
            key={p.id}
            className="recent-bar__chip"
            onClick={() => navigate(`/admin/projects/${p.id}`)}
            title={p.name}
          >
            {p.name}
          </button>
        ))}
      </div>
    </div>
  );
}
