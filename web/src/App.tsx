import { Routes, Route } from 'react-router-dom';
import RolePicker from './pages/RolePicker';
import Login from './pages/Login';
import Admin from './pages/Admin';
import ProjectEditor from './pages/ProjectEditor';
import Shows from './pages/Shows';
import ShowDetail from './pages/ShowDetail';
import Users from './pages/Users';
import Templates from './pages/Templates';
import Studio from './pages/Studio';
import Preview from './pages/Preview';
import CommandPalette from './components/CommandPalette';
import { RequireAuth, useAuth } from './lib/auth';

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<RolePicker />} />
        <Route path="/login" element={<Login />} />
        <Route path="/admin" element={<RequireAuth><Admin /></RequireAuth>} />
        <Route path="/admin/projects/:projectId" element={<RequireAuth><ProjectEditor /></RequireAuth>} />
        <Route path="/admin/shows" element={<RequireAuth><Shows /></RequireAuth>} />
        <Route path="/admin/shows/:showId" element={<RequireAuth><ShowDetail /></RequireAuth>} />
        <Route path="/admin/users" element={<RequireAuth role="admin"><Users /></RequireAuth>} />
        <Route path="/admin/templates" element={<RequireAuth><Templates /></RequireAuth>} />
        <Route path="/admin/:tab" element={<RequireAuth><Admin /></RequireAuth>} />
        <Route path="/studio/:projectId" element={<Studio />} />
        <Route path="/preview/:projectId" element={<Preview />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      <GlobalCmdK />
    </>
  );
}

/** Cmd/Ctrl+K palette — 只在登入狀態 mount */
function GlobalCmdK() {
  const { user } = useAuth();
  if (!user) return null;
  return <CommandPalette />;
}

function NotFound() {
  return (
    <div className="empty-state">
      <h1>404</h1>
      <p>找不到頁面</p>
      <a href="/">返回首頁</a>
    </div>
  );
}
