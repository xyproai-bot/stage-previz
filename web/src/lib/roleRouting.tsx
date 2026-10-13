// 依角色導頁的元件：
//   <HomeRedirect />    首頁「/」：沒登入 → 登入頁；登入了 → 依角色進自己的頁面（見 landing.ts）
//   <RequireAdmin>      管理頁只給製作；別的角色帶回自己的頁面，右下角說一聲
//   <RouteLoading />    換頁時的「載入中」（純文字）

import { ReactNode, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import * as api from './api';
import { landingNeedsProjects, landingPath } from './landing';
import { toast } from './toast';

export function RouteLoading({ text = '載入中…' }: { text?: string }) {
  return (
    <div className="empty-state" role="status">
      <p>{text}</p>
    </div>
  );
}

/** 首頁：依角色導到對的頁面 */
export function HomeRedirect() {
  const { user, loading } = useAuth();
  const [target, setTarget] = useState<{ userId: string; path: string } | null>(null);

  useEffect(() => {
    if (loading || !user || !landingNeedsProjects(user.role)) return;
    let cancelled = false;
    api.listProjects()
      .then(list => { if (!cancelled) setTarget({ userId: user.id, path: landingPath(user.role, list) }); })
      // 拿不到清單 → 去清單頁，那邊會說讀不到、可以重試
      .catch(() => { if (!cancelled) setTarget({ userId: user.id, path: landingPath(user.role, null) }); });
    return () => { cancelled = true; };
  }, [loading, user]);

  if (loading) return <RouteLoading />;
  if (!user) return <Navigate to="/login" replace />;
  if (!landingNeedsProjects(user.role)) return <Navigate to={landingPath(user.role, null)} replace />;
  if (!target || target.userId !== user.id) return <RouteLoading text="正在打開你的專案…" />;
  return <Navigate to={target.path} replace />;
}

/** 管理頁（/admin/...）的門：只有製作能進 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <RouteLoading />;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  if (user.role !== 'admin') return <NotAllowedRedirect />;
  return <>{children}</>;
}

// 開發模式（StrictMode）effect 會跑兩次；連點兩個不能進的連結也只說一次
let lastNoticeAt = 0;

function NotAllowedRedirect() {
  useEffect(() => {
    const now = Date.now();
    if (now - lastNoticeAt < 1500) return;
    lastNoticeAt = now;
    toast.info('管理頁只有製作可以開，已帶你回自己的頁面');
  }, []);
  return <Navigate to="/" replace />;
}
