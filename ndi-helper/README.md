# Stage Previz NDI Helper

動畫師本機背景跑的 NDI 接收器 — 從 AE 的 NDI Output 抓畫面，透過本機 WebSocket 推給瀏覽器，讓 Stage Previz 平台的 LED 面板顯示即時內容。

## 安裝（用戶端）

1. 裝 NDI Tools：https://www.ndi.tv/tools/（免費）
2. 下載這個 Helper 的 binary（Windows MSI / macOS dmg / Linux tar）
3. 跑一次它，會在系統列出現綠色圓點 icon

## 使用

1. AE 開啟 NDI Output（Composition → Add Output Module → NDI）
2. 確認 system tray 看到「● 你的 NDI source 名稱 · X.X fps · N 連線」
3. 在瀏覽器打開 Stage Previz：https://stage-previz.vercel.app/
4. 進動畫師工作站 `/studio/<projectId>` → LED 面板自動顯示 NDI 內容

## 設定

設定檔位置：
- Windows: `%APPDATA%\stage-previz-ndi-helper\config.json`
- macOS: `~/Library/Application Support/stage-previz-ndi-helper/config.json`
- Linux: `~/.config/stage-previz-ndi-helper/config.json`

```json
{
  "port": 7777,
  "source_name": null,        // 指定 NDI 來源名稱，null = 自動選第一個
  "downsample": true,         // 2x 降採樣（payload 從 ~30MB 降到 ~7MB）
  "jpeg_quality": 75,         // 0-100，越高越大
  "limited_to_full": true,    // BT.709 limited (16-235) → full (0-255)
  "autostart": false          // 開機自啟（Windows only）
}
```

## 編譯

```bash
cargo build --release
# 輸出在 target/release/stage-previz-ndi-helper(.exe)
```

需要 Rust 1.75+ 跟 turbojpeg 系統函式庫：

- Windows: `vcpkg install libjpeg-turbo:x64-windows`
- macOS: `brew install jpeg-turbo`
- Linux: `apt install libturbojpeg-dev`

## 架構

```
AE NDI Output (BGRA frame)
     ↓
NDIlib_recv_capture_v2 (via libloading + Processing.NDI.Lib.x64.dll)
     ↓
2x box filter downsample (optional) + limited→full range conversion
     ↓
turbojpeg encode (q=75)
     ↓
broadcast::Sender<Arc<Vec<u8>>>
     ↓
WebSocket binary frames @ ws://127.0.0.1:7777
     ↓
Browser canvas drawImage → Three.js LED panel material
```

## 為什麼用 libloading 不用既有的 ndi crate

現有的 [ndi crate](https://crates.io/crates/ndi) 在 build.rs 寫死了 NDI SDK 安裝路徑，如果用戶沒裝在預期位置就 build 失敗。  
我們的方案：**在 runtime 動態找 NDI 安裝路徑**（環境變數 / 預設安裝目錄），找不到就 friendly 提示用戶去裝。

## License

MIT
