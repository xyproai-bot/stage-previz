import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router-dom';
import RolePicker from './pages/RolePicker';
import Login from './pages/Login';
import Admin from './pages/Admin';
import ProjectEditor from './pages/ProjectEditor';
import Shows from './pages/Shows';
import ShowDetail from './pages/ShowDetail';
import Users from './pages/Users';
import Templates from './pages/Templates';
import DriveSources from './pages/DriveSources';
import ArchivedProjects from './pages/ArchivedProjects';
import CommandPalette from './components/CommandPalette';
import ToastContainer from './components/ToastContainer';
import ErrorBoundary from './components/ErrorBoundary';
import { RequireAuth, useAuth } from './lib/auth';

// Lazy-load 大頁面（含 StageScene + three.js 的）→ 不必要時不下載
const Studio  = lazy(() => import('./pages/Studio'));
const Preview = lazy(() => import('./pages/Preview'));
const Share   = lazy(() => import('./pages/Share'));

function PageLoading() {
  return <div className="empty-state"><h1>⏳</h1><p>載入頁面…</p></div>;
}

export default function App() {
  return (
    <>
      <ErrorBoundary>
        <Suspense fallback={<PageLoading />}>
          <Routes>
            <Route path="/" element={<RolePicker />} />
            <Route path="/login" element={<Login />} />
            <Route path="/admin" element={<RequireAuth><Admin /></RequireAuth>} />
            <Route path="/admin/projects/:projectId" element={<RequireAuth><ErrorBoundary><ProjectEditor /></ErrorBoundary></RequireAuth>} />
            <Route path="/admin/shows" element={<RequireAuth><Shows /></RequireAuth>} />
            <Route path="/admin/shows/:showId" element={<RequireAuth><ShowDetail /></RequireAuth>} />
            <Route path="/admin/users" element={<RequireAuth role="admin"><Users /></RequireAuth>} />
            <Route path="/admin/templates" element={<RequireAuth><Templates /></RequireAuth>} />
            <Route path="/admin/drive-sources" element={<RequireAuth role="admin"><DriveSources /></RequireAuth>} />
        <Route path="/admin/archived" element={<RequireAuth role="admin"><ArchivedProjects /></RequireAuth>} />
            <Route path="/admin/:tab" element={<RequireAuth><Admin /></RequireAuth>} />
            <Route path="/studio" element={<RequireAuth><ErrorBoundary><Studio /></ErrorBoundary></RequireAuth>} />
            <Route path="/studio/:projectId" element={<RequireAuth><ErrorBoundary><Studio /></ErrorBoundary></RequireAuth>} />
            <Route path="/preview" element={<RequireAuth><ErrorBoundary><Preview /></ErrorBoundary></RequireAuth>} />
            <Route path="/preview/:projectId" element={<RequireAuth><ErrorBoundary><Preview /></ErrorBoundary></RequireAuth>} />
            <Route path="/share/:token" element={<ErrorBoundary><Share /></ErrorBoundary>} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
      <GlobalCmdK />
      <ToastContainer />
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
