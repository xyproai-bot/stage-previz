import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Admin from './pages/Admin';
import ProjectEditor from './pages/ProjectEditor';
import Shows from './pages/Shows';
import ShowDetail from './pages/ShowDetail';
import Users from './pages/Users';
import Templates from './pages/Templates';
import DriveSources from './pages/DriveSources';
import ArchivedProjects from './pages/ArchivedProjects';
import Settings from './pages/Settings';
import CommandPalette from './components/CommandPalette';
import ToastContainer from './components/ToastContainer';
import { DialogHost } from './components/dialogs';
import ErrorBoundary from './components/ErrorBoundary';
import { RequireAuth, useAuth } from './lib/auth';
import { HomeRedirect, RequireAdmin, RequireProjectEditor, RouteLoading } from './lib/roleRouting';
import MyProjectsPage from './lib/MyProjectsPage';
import ViewAsPage from './components/ViewAsPage';

// Lazy-load 大頁面（含 StageScene + three.js 的）→ 不必要時不下載
const Studio  = lazy(() => import('./pages/Studio'));
const Preview = lazy(() => import('./pages/Preview'));
const Share   = lazy(() => import('./pages/Share'));
// 線上使用說明（公開，不用登入）
const Help    = lazy(() => import('./pages/Help'));
// 邀請連結（公開，不用登入；按「進入」才登入 + 加進專案）
const InvitePage = lazy(() => import('./pages/InvitePage'));

function PageLoading() {
  return <RouteLoading text="載入頁面…" />;
}

export default function App() {
  return (
    <>
      <ErrorBoundary>
        <Suspense fallback={<PageLoading />}>
          <Routes>
            {/* 首頁：沒登入 → 登入頁；登入了 → 依角色進自己的頁面 */}
            <Route path="/" element={<HomeRedirect />} />
            <Route path="/login" element={<Login />} />
            {/* 管理頁只給製作（admin）；其他角色會被帶回自己的頁面 */}
            <Route path="/admin" element={<RequireAdmin><Admin /></RequireAdmin>} />
            <Route path="/admin/projects/:projectId" element={<RequireProjectEditor><ErrorBoundary><ProjectEditor /></ErrorBoundary></RequireProjectEditor>} />
            <Route path="/admin/shows" element={<RequireAdmin><Shows /></RequireAdmin>} />
            <Route path="/admin/shows/:showId" element={<RequireAdmin><ShowDetail /></RequireAdmin>} />
            <Route path="/admin/users" element={<RequireAdmin><Users /></RequireAdmin>} />
            <Route path="/admin/templates" element={<RequireAdmin><Templates /></RequireAdmin>} />
            <Route path="/admin/drive-sources" element={<RequireAdmin><DriveSources /></RequireAdmin>} />
            <Route path="/admin/archived" element={<RequireAdmin><ArchivedProjects /></RequireAdmin>} />
            {/* 設定每個登入的人都能開（動畫師要用 NDI 檢查連線）；舊網址轉過去 */}
            <Route path="/admin/settings" element={<Navigate to="/settings" replace />} />
            <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
            <Route path="/admin/:tab" element={<RequireAdmin><Admin /></RequireAdmin>} />
            {/* 沒指定專案 → 我的專案清單（只有我被加入的） */}
            <Route path="/studio" element={<RequireAuth><MyProjectsPage kind="studio" /></RequireAuth>} />
            {/* 製作加 ?as=animator / ?as=director → 用那個身分看、只能看（lib/viewAs.ts） */}
            <Route path="/studio/:projectId" element={<RequireAuth><ViewAsPage><ErrorBoundary><Studio /></ErrorBoundary></ViewAsPage></RequireAuth>} />
            <Route path="/preview" element={<RequireAuth><MyProjectsPage kind="preview" /></RequireAuth>} />
            <Route path="/preview/:projectId" element={<RequireAuth><ViewAsPage><ErrorBoundary><Preview /></ErrorBoundary></ViewAsPage></RequireAuth>} />
            <Route path="/share/:token" element={<ErrorBoundary><Share /></ErrorBoundary>} />
            {/* 好讀分享網址（/s/jinma2026-k7p2），同一個分享頁 */}
            <Route path="/s/:slug" element={<ErrorBoundary><Share /></ErrorBoundary>} />
            <Route path="/help" element={<ErrorBoundary><Help /></ErrorBoundary>} />
            <Route path="/invite/:token" element={<ErrorBoundary><InvitePage /></ErrorBoundary>} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
      <GlobalCmdK />
      <ToastContainer />
      {/* 站內確認 / 輸入對話框（取代瀏覽器的 confirm / prompt） */}
      <DialogHost />
    </>
  );
}

/** Cmd/Ctrl+K palette — 只給製作（裡面的動作和搜尋結果都是進管理頁） */
function GlobalCmdK() {
  const { user } = useAuth();
  if (!user || user.role !== 'admin') return null;
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
