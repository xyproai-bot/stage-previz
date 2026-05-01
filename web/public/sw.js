// Stage Previz Service Worker — 簡易離線殼策略
//
// 策略：
//   1. App shell (HTML / JS / CSS / icons) → cache-first，新版本部署時 versioning bump
//   2. /api/* → network-only（一律打 worker，不快取）
//   3. /r2/* (3D 模型) → cache-first（模型 key 含版本 timestamp，安全）
//   4. /api/drive/stream/* → network-only（影片 range request 不快取）
//
// 部署：vite build 會把 dist/ 弄好，部 vercel 後瀏覽器自動撈 sw.js
// 更新：bump CACHE_VERSION 即可（用戶下次開頁會跳 SW update event）

const CACHE_VERSION = 'v1-2026-05-01';
const APP_SHELL = 'sp-shell-' + CACHE_VERSION;
const R2_CACHE  = 'sp-r2-' + CACHE_VERSION;

// install：快取 app shell
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(APP_SHELL);
    // 預先抓的資源（manifest + icons）；JS/CSS 太多就動態抓
    await cache.addAll([
      '/',
      '/manifest.webmanifest',
      '/icon-192.svg',
      '/icon-512.svg',
    ]).catch(() => { /* 容錯：dev 模式有些資源不存在 */ });
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 清舊版 cache
    const names = await caches.keys();
    await Promise.all(
      names.filter(n => !n.endsWith(CACHE_VERSION)).map(n => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // /api/* → network-only（never cache）
  if (url.pathname.startsWith('/api/')) return;
  // Drive stream → network-only（Range support）
  if (url.pathname.startsWith('/api/drive/stream/')) return;
  // proxy.haimiaan.com 跨 origin → network-only
  if (url.origin !== self.location.origin) return;

  // /r2/* (3D 模型) → cache-first
  if (url.pathname.startsWith('/r2/')) {
    e.respondWith(cacheFirst(R2_CACHE, req));
    return;
  }

  // App shell：HTML navigation → network-first（讓新版部署立即看到）
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(APP_SHELL, req));
    return;
  }

  // 其他 static assets (.js / .css / .svg / .woff) → cache-first
  e.respondWith(cacheFirst(APP_SHELL, req));
});

async function cacheFirst(cacheName, req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const resp = await fetch(req);
    if (resp.ok) cache.put(req, resp.clone());
    return resp;
  } catch {
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirst(cacheName, req) {
  try {
    const resp = await fetch(req);
    if (resp.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, resp.clone());
    }
    return resp;
  } catch {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(req);
    return hit || new Response('Offline', { status: 503, statusText: 'Offline' });
  }
}
