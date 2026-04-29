import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import * as api from './api';
import type { AuthUser, UserRole } from './api';

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  login: (accessCode: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const u = await api.authMe();
      setUser(u);
    } catch (e) {
      // Dev fallback：本機 dev 連的 worker 還沒新 auth endpoint（404）
      // 直接假裝 admin 已登入，避免測既有功能時被 auth 卡住
      const status = (e as { status?: number }).status;
      const isLocalhost = typeof location !== 'undefined' && location.hostname === 'localhost';
      if (isLocalhost && (status === 404 || status === 405 || !status)) {
        setUser({
          id: 'u_phang',
          name: 'Phang', role: 'admin', avatarColor: '#10c78a',
        });
      } else {
        setUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = useCallback(async (accessCode: string) => {
    const u = await api.authLogin(accessCode);
    setUser(u);
  }, []);

  const logout = useCallback(async () => {
    try { await api.authLogout(); } catch { /* ignore */ }
    setUser(null);
  }, []);

  return (
    <AuthCtx.Provider value={{ user, loading, refresh, login, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth(): AuthState {
  const v = useContext(AuthCtx);
  if (!v) throw new Error('useAuth must be inside <AuthProvider>');
  return v;
}

export function RequireAuth({ children, role }: { children: ReactNode; role?: UserRole }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div className="empty-state">
        <h1>⏳</h1>
        <p>載入中…</p>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (role && user.role !== role) {
    return (
      <div className="empty-state">
        <h1>403</h1>
        <p>沒有權限存取此頁面（需要 {role} 角色）</p>
      </div>
    );
  }
  return <>{children}</>;
}
