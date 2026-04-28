# Stage Previz — LED 舞臺預覽（網頁版）

給導演看的預覽工具。動畫師把預覽內容（影片）給導演，導演用網頁打開看 3D 舞臺效果。

## 功能

- **本地上傳** — 拖入或選擇 mp4/mov 檔案
- **Google Drive 公開連結** — 貼連結即可
- **3D 舞臺** — 攝影機預設、Walk Mode、機構控制（轉台、LED-1 升降）
- **每面板控制** — 亮度/對比/HSL/不透明度
- **錄影** — 直接下載 mp4/webm
- **自動偵測畫布** — 10912×2024（含樂手）/ 8800×2024（純主牆）

## 技術

- 純前端：HTML + Three.js r128
- 模型用 Draco 壓縮（281MB → 3.6MB）
- 部署：Cloudflare Pages
- 域名：`stage-previz.haimiaan.com`

## 開發

```bash
# 本地測試（任何靜態 server）
npx serve .
# 或
python -m http.server 8000
```

## 模型壓縮

如果模型有更新，重新壓縮：

```bash
npx gltf-pipeline -i stage.gltf -o stage.glb -d --draco.compressionLevel 10
```

## 與 Electron 版的差異

Electron 版（`../stage preview/`）給動畫師用：
- NDI 接收 AE 即時輸出
- 視窗置頂、錄影本地存檔等桌面功能

網頁版給導演看：
- 移除所有 NDI / Electron API
- 加入 GDrive 連結載入
- 錄影改瀏覽器 download
