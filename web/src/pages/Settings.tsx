import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AdminLayout from '../components/AdminLayout';
import { useAuth } from '../lib/auth';
import type { UserRole } from '../lib/api';
import { useNdiConnection } from '../lib/ndiConnection';
import { ndiStepMessage, type NdiBrowser, type NdiGuide } from '../lib/ndiSteps';
import { NDI_HELPER_DOWNLOAD_URL, NDI_HELPER_DOWNLOAD_URL_MAC, NDI_TOOLS_URL } from '../lib/downloads';
import { clearPersonalLooks, countPersonalLooks } from '../lib/localPrefs';
import { toast } from '../lib/toast';
import { version as APP_VERSION } from '../../package.json';
import './Settings.css';

const ROLE_LABEL: Record<UserRole, string> = {
  admin: '管理員',
  animator: '動畫師',
  director: '導演',
};

export default function Settings() {
  const { user } = useAuth();
  return (
    <AdminLayout>
      <header className="admin-topbar">
        <h1>設定</h1>
      </header>
      <div className="admin-content settings">
        <AccountSection />
        <NdiSection />
        {/* 自己調的現場亮度：只有管理員能調燈光，其他人看不到這區 */}
        {user?.role === 'admin' && <ThisComputerSection />}
        <AboutSection />
      </div>
    </AdminLayout>
  );
}

// ─── 我的帳號 ───

function AccountSection() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <section className="settings-card">
      <h2>我的帳號</h2>
      <div className="settings-account">
        <div className="avatar settings-account__avatar" style={{ background: user.avatarColor || '#10c78a' }}>
          {user.name?.[0] || '?'}
        </div>
        <dl className="settings-account__rows">
          <div><dt>名字</dt><dd>{user.name}</dd></div>
          <div><dt>身分</dt><dd>{ROLE_LABEL[user.role] ?? user.role}</dd></div>
        </dl>
      </div>
      <p className="settings-hint">
        {user.role === 'admin'
          ? <>要改名字或登入號碼，到 <Link to="/admin/users">用戶</Link> 頁。</>
          : '要改名字或登入號碼，請找管理員。'}
      </p>
    </section>
  );
}

// ─── NDI 小程序 ───

/**
 * 「檢查連線」：連 NDI 小程序看卡在哪一步（跟分享頁 / 工作站的卡片同一套說法），不收畫面。
 * 按了才開始（瀏覽器還沒問過權限的話，按下去就會跳出詢問）；之後一直更新，裝好小程序會自己變。
 */
function NdiSection() {
  const [checking, setChecking] = useState(false);
  const ndi = useNdiConnection({ enabled: checking, wantFrames: false, userInitiated: true });
  const g = ndi.guide;
  const busy = checking && (g.step === 'connecting' || (g.step === 'need_permission' && g.pending));
  const mac = ndi.env.os === 'mac';
  const winLink = (
    <a key="win" className={'btn ' + (mac ? 'btn--ghost' : 'btn--primary')} href={NDI_HELPER_DOWNLOAD_URL}>⬇ 下載 NDI 小程序（Windows）</a>
  );
  const macLink = (
    <a key="mac" className={'btn ' + (mac ? 'btn--primary' : 'btn--ghost')} href={NDI_HELPER_DOWNLOAD_URL_MAC}>⬇ 下載 NDI 小程序（Mac）</a>
  );

  return (
    <section className="settings-card">
      <h2>NDI 小程序（AE 即時預覽）</h2>
      <p className="settings-desc">裝好打開後，AE 的畫面會即時播在 3D 舞台的 LED 上。</p>

      <div className="settings-ndi-check">
        <button
          className="btn btn--ghost"
          onClick={() => (checking ? ndi.retry() : setChecking(true))}
          disabled={busy || (checking && g.step === 'browser_unsupported')}
        >
          {busy ? '檢查中…' : checking ? '再檢查一次' : '檢查連線'}
        </button>
        {checking && <NdiCheckResult guide={g} browser={ndi.env.browser} />}
      </div>

      <div className="settings-links">
        {mac ? [macLink, winLink] : [winLink, macLink]}
        <a className="btn btn--ghost" href={NDI_TOOLS_URL} target="_blank" rel="noreferrer">NDI Tools（官方免費）↗</a>
      </div>

      <ol className="settings-steps">
        <li>裝 NDI Tools</li>
        <li>裝並打開 NDI 小程序（之後開機會自動啟動）</li>
        <li>AE：偏好設定 → 視訊預覽 → 勾 NDI；「在背景時停用視訊輸出」取消勾選</li>
        <li>用 Chrome / Edge / Firefox 打開，瀏覽器問「允許存取這台裝置上的應用程式和服務」→ 按「允許」</li>
      </ol>
    </section>
  );
}

function NdiCheckResult({ guide, browser }: { guide: NdiGuide; browser: NdiBrowser }) {
  const msg = ndiStepMessage(guide, browser);
  const ok = guide.step === 'ready' || guide.step === 'live';
  const neutral = guide.step === 'connecting';
  return (
    <span className={'settings-status' + (ok ? ' settings-status--ok' : neutral ? '' : ' settings-status--warn')} role="status">
      <span>{msg.title}</span>
      {msg.detail.map(d => <span key={d} className="settings-status__sub">{d}</span>)}
      {guide.helperVersion && <span className="settings-status__sub">小程序版本 {guide.helperVersion}</span>}
    </span>
  );
}

// ─── 這台電腦的設定 ───

function browserStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

function ThisComputerSection() {
  const [lookCount, setLookCount] = useState(() => countPersonalLooks(browserStorage()));

  // 別的分頁調了亮度 → 回到這頁時數字跟著更新
  useEffect(() => {
    const recount = () => setLookCount(countPersonalLooks(browserStorage()));
    window.addEventListener('focus', recount);
    window.addEventListener('storage', recount);
    return () => {
      window.removeEventListener('focus', recount);
      window.removeEventListener('storage', recount);
    };
  }, []);

  function handleClearLooks() {
    if (!confirm(
      `清掉你在 ${lookCount} 個專案自己調的現場亮度？\n\n` +
      '這些專案會回到專案預設的亮度。只影響這台電腦，不會動到別人。',
    )) return;
    const removed = clearPersonalLooks(browserStorage());
    setLookCount(countPersonalLooks(browserStorage()));
    toast.success(`已清掉 ${removed} 個專案的現場亮度，回到專案預設`);
  }

  return (
    <section className="settings-card">
      <h2>這台電腦的設定</h2>
      <p className="settings-desc">這些只存在這台電腦的瀏覽器裡，換電腦不會跟著走。</p>
      <div className="settings-row">
        <div className="settings-row__text">
          <div className="settings-row__title">自己調的現場亮度</div>
          <div className="settings-row__sub">
            {lookCount > 0 ? `${lookCount} 個專案有調過` : '沒有調過，都是專案預設'}
          </div>
        </div>
        <button className="btn btn--ghost" onClick={handleClearLooks} disabled={lookCount === 0}>
          清掉我調的現場亮度（回到專案預設）
        </button>
      </div>
    </section>
  );
}

// ─── 關於 ───

function AboutSection() {
  return (
    <section className="settings-card">
      <h2>關於</h2>
      <dl className="settings-account__rows">
        <div><dt>版本</dt><dd>{APP_VERSION}</dd></div>
        <div><dt>使用說明</dt><dd>按右下角的 ?（或鍵盤 ?）</dd></div>
      </dl>
    </section>
  );
}
