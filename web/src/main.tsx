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
