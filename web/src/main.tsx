import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './lib/auth';
import './lib/errorReporting';  // 畫面錯誤自動回報（正式版才送；製作在「設定 → 系統狀態」看）
import { installViewportVars } from './lib/viewportVars';
import './styles/global.css';

// 手機、iPad：螢幕鍵盤跳出來 / 網址列縮起來時，版面照「真的看得到的高度」算（--vvh）
installViewportVars();

// 網站剛更新、這個分頁還是舊版：打開某些功能時要的舊程式檔已經不在了（Failed to fetch dynamically imported module）。
// 不要讓功能壞在那裡，跳一條提醒請使用者重新整理（不自動重新整理，免得正在打的字不見）
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  if (document.getElementById('sp-update-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'sp-update-banner';
  bar.setAttribute('role', 'alert');
  bar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:100000;display:flex;gap:12px;align-items:center;padding:10px 14px;border-radius:8px;background:var(--surface-2,#2a2d33);color:var(--text,#fff);border:1px solid var(--accent,#10c78a);box-shadow:0 6px 24px rgba(0,0,0,.4);font-size:14px;max-width:calc(100vw - 32px)';
  const msg = document.createElement('span');
  msg.textContent = '網站剛更新了，這個功能要重新整理頁面才能用。';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '重新整理';
  btn.style.cssText = 'padding:6px 12px;border-radius:6px;border:none;background:var(--accent,#10c78a);color:#000;font-weight:600;cursor:pointer';
  btn.onclick = () => window.location.reload();
  bar.append(msg, btn);
  document.body.appendChild(bar);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);

// PWA — 註冊 Service Worker（dev 模式跳過避免 cache 卡 HMR）
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => {
      console.warn('[PWA] SW register failed:', e);
    });
  });
}
