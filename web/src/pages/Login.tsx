import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { returnPathAfterLogin } from '../lib/landing';
import './Login.css';

export default function Login() {
  const { login, user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // 被要求登入前想去的頁面（RequireAuth 記下來的）
  const from = (location.state as { from?: string } | null)?.from;

  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 已登入 / 剛登入 → 回到原本想去的頁面（自己能開的才回去），不然去首頁，首頁會依角色帶到對的地方
  useEffect(() => {
    if (!authLoading && user) navigate(returnPathAfterLogin(user.role, from) ?? '/', { replace: true });
  }, [authLoading, user, navigate, from]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = code.trim().toUpperCase().replace(/\s+/g, '');
    if (!trimmed) { setError('請輸入號碼'); return; }
    setSubmitting(true);
    try {
      await login(trimmed);  // 登入成功 → user 變了，上面的 effect 會帶去對的頁面
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-card__brand">
          <span className="login-card__brand-mark" />
          <span>STAGE <strong>PREVIZ</strong></span>
        </div>

        <h1>輸入號碼</h1>
        <p className="muted">用 admin 給你的號碼登入。</p>

        <form onSubmit={handleLogin}>
          <label>號碼
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="例：A7K3MN9X"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className="login-card__code"
            />
          </label>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? '登入中…' : '登入'}
          </button>
        </form>

        <p className="muted small login-card__hint">
          沒拿到號碼？請聯絡 admin。
        </p>
      </div>
    </div>
  );
}
