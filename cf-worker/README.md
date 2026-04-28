# Stage Previz — Cloudflare Worker (Drive CORS Proxy)

當 Google Drive 影片 >100MB 時，Drive 會強制顯示「無法掃毒」警告頁，
前端 JS 拿不到後續 confirm token，無法直接串流。

這個 Worker 在 server-side 處理那個警告頁，自動取得 token，
然後用 CORS 標頭把影片串流回 client。

## 部署步驟

```bash
cd cf-worker
npm install
npx wrangler login          # 第一次登入
npx wrangler deploy
```

部署後會得到一個 URL：`https://stage-previz-proxy.<account>.workers.dev`

## 在前端啟用

修改 `index.html` 中的 `gdriveDirectURL` function：

```javascript
const GDRIVE_PROXY = 'https://stage-previz-proxy.<account>.workers.dev';

function gdriveDirectURL(fileId) {
  // 用 Worker proxy 處理大檔案
  return `${GDRIVE_PROXY}/?id=${fileId}`;
}
```

## 本地測試

```bash
npx wrangler dev
# 然後 GDRIVE_PROXY 改成 http://localhost:8787
```

## 限額

CF Workers 免費方案：
- 每天 100,000 次請求
- 每次最多 10ms CPU 時間（影片串流主要是 I/O 不占 CPU，沒問題）
- Worker 本身不收頻寬費，但流量穿透 Drive → Worker → Client

實際使用上對個人 / 小團隊使用幾乎不會超過免額度。
