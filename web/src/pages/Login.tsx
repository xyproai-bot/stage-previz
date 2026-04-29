import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import './Login.css';

export default function Login() {
  const { login, user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from || '/admin';

  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 已登入直接導
  useEffect(() => {
    if (!authLoading && user) navigate(from, { replace: true });
  }, [authLoading, user, navigate, from]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = code.trim().toUpperCase().replace(/\s+/g, '');
    if (!trimmed) { setError('請輸入號碼'); return; }
    setSubmitting(true);
    try {
      await login(trimmed);
      navigate(from, { replace: true });
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
