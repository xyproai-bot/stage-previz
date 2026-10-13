import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import AdminLayout from '../components/AdminLayout';
import { useAuth } from '../lib/auth';
import type { UserRole } from '../lib/api';
import { NdiClient } from '../lib/ndiClient';
import { NDI_HELPER_DOWNLOAD_URL, NDI_TOOLS_URL } from '../lib/downloads';
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

type NdiCheck =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'found'; helperVersion: string; source: string | null; sources: string[] }
  | { kind: 'none' };

/**
 * 試著連一次 NDI 小程序（ws://127.0.0.1:7777），連到就拿版本 / 來源名稱後馬上斷開。
 * 不自動重連；cancel() 之後 done 永遠不會 resolve（元件已經不在了）。
 */
function probeNdiHelper(timeoutMs = 4000): { done: Promise<NdiCheck>; cancel: () => void } {
  let finished = false;
  let resolveFn: (r: NdiCheck) => void = () => {};
  const done = new Promise<NdiCheck>(res => { resolveFn = res; });
  let hello: { helperVersion: string; source: string } | null = null;
  let sources: string[] = [];
  let settleTimer = 0;
  let timeoutTimer = 0;
  let client: NdiClient | null = null;

  const finish = (r: NdiCheck | null) => {
    if (finished) return;
    finished = true;
    window.clearTimeout(timeoutTimer);
    window.clearTimeout(settleTimer);
    try { client?.destroy(); } catch { /* ignore */ }
    if (r) resolveFn(r);
  };
  const finishFound = () => {
    if (!hello) return;
    const src = hello.source && hello.source !== '(no source)' ? hello.source : null;
    finish({ kind: 'found', helperVersion: hello.helperVersion, source: src, sources });
  };

  client = new NdiClient({
    reconnectIntervalMs: 0,
    onFrame: (bitmap) => { bitmap.close?.(); },
    onStatus: (s) => {
      if (finished) return;
      if (s.kind === 'connected') {
        const first = !hello;
        hello = { helperVersion: s.helperVersion, source: s.source };
        // 連上後 client 會問一次 status（來源名稱、找得到的來源），等一下下再收尾
        if (first) settleTimer = window.setTimeout(finishFound, 800);
      } else if (s.kind === 'error' || s.kind === 'disconnected') {
        if (hello) finishFound();
        else finish({ kind: 'none' });
      }
    },
    onSources: (list) => {
      sources = list;
      // 同一則 status 訊息接著會更新來源名稱 → 下一輪再收尾
      if (hello && !finished) window.setTimeout(finishFound, 0);
    },
  });
  timeoutTimer = window.setTimeout(() => {
    if (hello) finishFound();
    else finish({ kind: 'none' });
  }, timeoutMs);
  client.connect();

  return { done, cancel: () => finish(null) };
}

function NdiSection() {
  const [check, setCheck] = useState<NdiCheck>({ kind: 'idle' });
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => () => { cancelRef.current?.(); }, []);

  const runCheck = useCallback(() => {
    cancelRef.current?.();
    setCheck({ kind: 'checking' });
    const probe = probeNdiHelper();
    cancelRef.current = probe.cancel;
    probe.done.then((r) => {
      cancelRef.current = null;
      setCheck(r);
    });
  }, []);

  return (
    <section className="settings-card">
      <h2>NDI 小程序（AE 即時預覽）</h2>
      <p className="settings-desc">裝好打開後，AE 的畫面會即時播在 3D 舞台的 LED 上。</p>

      <div className="settings-ndi-check">
        <button className="btn btn--ghost" onClick={runCheck} disabled={check.kind === 'checking'}>
          {check.kind === 'checking' ? '檢查中…' : '檢查連線'}
        </button>
        <NdiCheckResult check={check} />
      </div>

      <div className="settings-links">
        <a className="btn btn--primary" href={NDI_HELPER_DOWNLOAD_URL}>⬇ 下載 NDI 小程序（Windows）</a>
        <a className="btn btn--ghost" href={NDI_TOOLS_URL} target="_blank" rel="noreferrer">NDI Tools（官方免費）↗</a>
      </div>

      <ol className="settings-steps">
        <li>裝 NDI Tools</li>
        <li>裝並打開 NDI 小程序</li>
        <li>AE 的預覽輸出選 NDI（NDI Tools 裡的 Adobe 外掛）</li>
      </ol>
    </section>
  );
}

function NdiCheckResult({ check }: { check: NdiCheck }) {
  switch (check.kind) {
    case 'idle':
      return null;
    case 'checking':
      return <span className="settings-status">正在找小程序…</span>;
    case 'none':
      return (
        <span className="settings-status settings-status--warn">
          沒有偵測到小程序 — 裝好後打開它，再按一次「檢查連線」
        </span>
      );
    case 'found':
      return (
        <span className="settings-status settings-status--ok">
          <span>
            {check.source
              ? <>已連上 · 正在收：<strong>{check.source}</strong></>
              : '已連上，但還沒收到 AE 畫面（AE 輸出選 NDI 了嗎？）'}
          </span>
          {!check.source && check.sources.length > 0 && (
            <span className="settings-status__sub">這台電腦找得到：{check.sources.join('、')}</span>
          )}
          <span className="settings-status__sub">小程序版本 {check.helperVersion}</span>
        </span>
      );
  }
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
