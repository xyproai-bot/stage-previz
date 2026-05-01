import { useCallback, useEffect, useState } from 'react';
import AdminLayout from '../components/AdminLayout';
import * as api from '../lib/api';
import type { DriveAccount } from '../lib/api';
import './DriveSources.css';

export default function DriveSources() {
  const [accounts, setAccounts] = useState<DriveAccount[]>([]);
  const [configured, setConfigured] = useState<boolean>(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listDriveAccounts();
      setAccounts(data.accounts);
      setConfigured(data.configured);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleConnect() {
    setConnecting(true);
    try {
      await api.startDriveOAuth('/admin/drive-sources');
      // 走到這裡前已經 location.href 跳走
    } catch (e) {
      alert('連接失敗：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect(acc: DriveAccount) {
    if (!confirm(`斷開 ${acc.email}？\n\n所有用此帳號的專案會失去 Drive 同步（檔案 cache 保留，但不會更新）。`)) return;
    try {
      await api.deleteDriveAccount(acc.id);
      await refresh();
    } catch (e) { alert('斷開失敗：' + (e instanceof Error ? e.message : String(e))); }
  }

  return (
    <AdminLayout>
      <div className="drive-sources">
        <header className="drive-sources__head">
          <h1>Drive 來源</h1>
          <p>連接 Google 帳號 → 在專案編輯頁設定要抓哪個 Drive 資料夾</p>
        </header>

        {!configured && (
          <div className="drive-sources__warn">
            <strong>⚠ 平台尚未設定 Google OAuth</strong>
            <p>需要先在 Cloudflare Workers 的 secret 設定：</p>
            <ul>
              <li><code>GOOGLE_CLIENT_ID</code></li>
              <li><code>GOOGLE_CLIENT_SECRET</code></li>
              <li><code>GOOGLE_REDIRECT_URI</code></li>
            </ul>
            <p>步驟詳見 <code>cf-worker/wrangler.toml</code> 註解</p>
          </div>
        )}

        <section className="drive-sources__section">
          <div className="drive-sources__section-head">
            <h2>已連接的 Google 帳號</h2>
            <div>
              <button className="link-btn" onClick={refresh} disabled={loading}>重新整理</button>
              <button
                className="btn btn--primary"
                onClick={handleConnect}
                disabled={connecting || !configured}
                title={!configured ? '請先設定 Google OAuth' : '連接 Google Drive'}
              >+ 連接 Google</button>
            </div>
          </div>

          {error && <div className="drive-sources__error">{error}</div>}

          {loading ? (
            <div className="drive-sources__empty">載入中…</div>
          ) : accounts.length === 0 ? (
            <div className="drive-sources__empty">
              還沒連接任何 Google 帳號。{configured ? '點上方「+ 連接 Google」開始。' : '先設定 OAuth secrets。'}
            </div>
          ) : (
            <ul className="drive-accounts">
              {accounts.map(a => (
                <li key={a.id} className="drive-account">
                  <div className="drive-account__icon">G</div>
                  <div className="drive-account__info">
                    <div className="drive-account__name">{a.name || a.email}</div>
                    <div className="drive-account__email">{a.email}</div>
                    <div className="drive-account__meta">
                      連接：{formatDate(a.createdAt)}
                      {a.lastUsedAt && <> · 最後使用：{formatDate(a.lastUsedAt)}</>}
                    </div>
                  </div>
                  <button className="btn btn--ghost btn--sm" onClick={() => handleDisconnect(a)}>
                    斷開
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="drive-sources__section">
          <h2>使用說明</h2>
          <ol className="drive-sources__guide">
            <li>連接你的 Google 帳號（上方按鈕）— 平台只要 <strong>讀取權限</strong></li>
            <li>進入專案編輯頁 → Drive 來源區塊 → 選擇此 Google 帳號 + 貼上資料夾連結</li>
            <li>設定檔名規則（預設 <code>^S(\d+)_</code>，例如 <code>S03_主題曲.mp4</code> 自動分到第 3 首歌）</li>
            <li>每 5 分鐘自動同步；也可隨時手動同步</li>
            <li>動畫師在 Drive 上傳新版本影片 → 5 分鐘內導演端就看得到</li>
          </ol>
        </section>
      </div>
    </AdminLayout>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}
