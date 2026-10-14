# Stage Previz NDI Helper（NDI 小程序）

在動畫師電腦背景跑的小程式：接收 After Effects 的 NDI 畫面，交給瀏覽器裡的 Stage Previz，
讓 3D 舞台的 LED 即時顯示 AE 的畫面。**裝一次就好**：之後開機自動在背景跑，不用再管它。

---

## 安裝（Windows）

1. 先裝 **NDI Tools**（官方免費）：https://ndi.video/tools/
2. 下載安裝檔：
   https://proxy.haimiaan.com/downloads/stage-previz-ndi-helper-windows.msi
   （連不上的話用 GitHub：https://github.com/xyproai-bot/stage-previz/releases/latest/download/stage-previz-ndi-helper-windows.msi）
3. 雙擊安裝檔 →「Next」→「Install」→（問要不要允許變更，按「是」）→「Finish」
   - 如果跳出藍色的「Windows 已保護您的電腦」：按「其他資訊」→「仍要執行」
   - 最後一頁「Launch Stage Previz NDI Helper now」保持打勾 → 裝完馬上開始跑
4. 右下角系統列（時鐘旁邊，可能收在 ^ 裡）出現一個圓點就成功了。
   **以後開機會自動啟動**；不想要的話：對圓點按右鍵 → 取消「開機時自動啟動」。

更新版本：直接下載新的安裝檔再裝一次就好（會自動關掉舊的、裝完自動開新的，幾秒鐘就裝完）。

## 安裝（Mac）

1. 先裝 **NDI Tools for Mac**（官方免費）：https://ndi.video/tools/ （AE 的 NDI 外掛也在裡面）
2. 下載：
   https://proxy.haimiaan.com/downloads/stage-previz-ndi-helper-mac.zip
   （連不上的話用 GitHub：https://github.com/xyproai-bot/stage-previz/releases/latest/download/stage-previz-ndi-helper-mac.zip）
3. 雙擊 zip 解壓縮 → 把「**Stage Previz NDI Helper**」拖進「**應用程式**」資料夾
   （一定要先拖進「應用程式」，直接在「下載」裡打開的話，開機自動啟動會失效）
4. 在「應用程式」裡雙擊打開。第一次 Mac 會問：
   「**「Stage Previz NDI Helper」是一個從網際網路下載的 App。確定要打開嗎？**」→ 按「**打開**」（只有第一次）
   （0.1.11 起有經過 Apple 公證，不用再去系統設定。舊版被擋「無法打開」的話，請直接下載新版）
5. 如果 Mac 問「**要允許「Stage Previz NDI Helper」尋找區域網路上的裝置嗎？**」→ 按「**允許**」
   （看別台電腦的 AE 會用到；不是每台 Mac 都會問，沒問就不用管。按了不允許的話，到
   「系統設定 → 隱私權與安全性 → 區域網路」把 Stage Previz NDI Helper 打開）
6. 右上角選單列出現一個圓點就成功了。**以後開機會自動啟動**（點圓點可以關掉）。

## 使用

1. AE 打開 NDI 輸出（偏好設定 → 視訊預覽 → 輸出裝置選 NDI）
2. 用 **Chrome / Edge / Firefox** 打開 Stage Previz 分享頁
   （**Safari 不行**：Safari 會直接擋掉網頁連到這個小程序）
3. 第一次連線時瀏覽器會問「**允許存取這台裝置上的應用程式和服務**」→ 按「**允許**」
4. LED 就會顯示 AE 的畫面

**只會自動接「這台電腦」的 AE**：網路上有好幾台電腦在送 NDI 時，小程序只自動接這台電腦的
After Effects（沒有的話接這台電腦的其他 NDI 來源）。**別台電腦的畫面不會自動出現**——
這台的 AE 沒在送時就等著（網頁會說找不到這台電腦的 AE）。
真的想看別台的畫面，要在網頁上手動選那個來源（選過會記住；選「自動」回到預設）。

### 圓點顏色

| 顏色 | 意思 |
|---|---|
| 綠 | 網頁正在收 AE 畫面 |
| 灰 | 待機（沒有網頁在看，幾乎不吃電腦資源） |
| 橘 | 要處理：沒裝 NDI Tools、找不到這台電腦 AE 的 NDI 輸出、或已經開了另一個小程序 |

右鍵（Mac 點一下）圓點的選單：狀態、打開 Stage Previz 平台、下載 NDI Tools（沒裝時才能點）、
開機時自動啟動（勾選；沒設定成功會標「⚠ 沒設定成功」，原因寫在 `helper.log`）、開啟設定資料夾、離開。

---

## WebSocket 協議（給網頁端）

- 位址：`ws://127.0.0.1:7777`（只聽本機）
- **Origin 檢查**：瀏覽器的 Origin 必須是下面其中之一，不然握手回 **403**：
  - `https://previz.haimiaan.com`、`https://test.previz.haimiaan.com`（0.1.11 起；只限這兩個，子網域不算）
  - `https://stage-previz.vercel.app`
  - `https://stage-previz-*.vercel.app`（這個專案的 Vercel 預覽網址，單一層子網域）
  - `http://localhost[:port]`、`http://127.0.0.1[:port]`、`http://*.localhost[:port]`（本機開發）
  - 沒有 Origin header 的連線（Node 腳本等非瀏覽器工具）放行
- 文字訊息都是 JSON（`type` 欄位分辨）；二進位訊息 = 一張 JPEG。

### helper → 網頁

**1. `hello`**：連上後第一則，只送一次。

```json
{ "type": "hello", "version": "0.1.13", "protocol": 2, "platform": "windows", "port": 7777,
  "source": "ULTRA9-285K (Adobe After Effects)", "colorPipeline": "raw" }
```

- `platform`：`"windows"` | `"macos"` | `"linux"`
- `source`：目前要接的來源；沒有時是空字串 `""`（舊版相容）
- `protocol`：協議版本；0.1.8 以前沒有這欄（= 1）
- `colorPipeline`：0.1.13 起：畫面的顏色怎麼處理。`"raw"`（預設）= NDI 給的原始像素，**網頁要自己做顏色校正**
  （實測 AE → NDI 收到的黑 ≈ 16、白 ≈ 255，不是乾淨的 limited range）；`"limited_to_full"` = config 打開了
  `limited_to_full`（16–235 拉成 0–255，0.1.12 以前的做法）。舊版沒有這欄 = 以前的做法。status 也有同一欄

**2. `status`**：hello 之後立刻一則；之後**狀態有變就馬上推**，另外**每秒推一次**（更新 fps）。
也可以主動要（見下面的指令）。

```json
{
  "type": "status",
  "version": "0.1.11",
  "state": "live",
  "ndi": "ready",
  "error": null,
  "lastError": null,
  "mode": "auto",
  "preferred": null,
  "source": "ULTRA9-285K (Adobe After Effects)",
  "sources": [
    { "name": "ULTRA9-285K (Adobe After Effects)", "local": true,  "afterEffects": true },
    { "name": "OTHER-PC (Adobe After Effects)",    "local": false, "afterEffects": true }
  ],
  "availableSources": ["ULTRA9-285K (Adobe After Effects)", "OTHER-PC (Adobe After Effects)"],
  "connected": true,
  "receiving": true,
  "fps": 30.0,
  "ndiFps": 59.9,
  "maxFps": 30,
  "encodeMs": 4.2,
  "width": 1920, "height": 1080,
  "outWidth": 1920, "outHeight": 1080,
  "downscale": 1,
  "jpegQuality": 90,
  "colorPipeline": "raw",
  "frameCount": 1234,
  "clients": 1,
  "framesPaused": false,
  "autostart": { "wanted": true, "registered": true, "error": null }
}
```

| 欄位 | 說明 |
|---|---|
| `state` | **網頁直接 switch 這個就好**：`"starting"` 啟動中 / `"ndi_missing"` 沒裝 NDI → 顯示「請先安裝 NDI Tools」/ `"ndi_error"` NDI 初始化失敗 / `"searching"` 沒有可以自動接的來源：一個 NDI 來源都沒有（`error.code` = `no_source`），或只有別台電腦的（`error.code` = `no_local_source`，`sources` 照樣列出來給網頁手動選）/ `"standby"` 有來源但沒有任何連線要畫面 / `"connecting"` 已連上來源、還沒收到畫面（或超過 2 秒沒畫面，例如 AE 停住）/ `"live"` 畫面正在送 |
| `ndi` | NDI 函式庫狀態：`"starting"` / `"missing"` / `"ready"` / `"error"` |
| `error` | `null` 或 `{ "code", "message" }`。`code`：`ndi_missing`、`ndi_init_failed`、`no_source`（一個 NDI 來源都沒有）、`no_local_source`（0.1.10 起：只有別台電腦的來源，不會自動接；`state` = `"searching"`）、`recv_failed`、`encoder_failed`。`message` 是可以直接顯示的中文 |
| `lastError` | = `error.message`（舊版相容） |
| `mode` | `"auto"`（自動挑）或 `"manual"`（用戶選過，記在 config） |
| `preferred` | 手動選的來源名稱；自動時 `null`。手動選的來源不在線時會先照自動規則接（一樣只接這台電腦的），等它上線再切回去 |
| `source` | 目前要接 / 正在接的來源；沒有時 `null` |
| `sources` | 網路上看得到的所有 NDI 來源。`local` = 這台電腦送的；`afterEffects` = 名稱含 "After Effects" |
| `availableSources` | 只有名稱的陣列（舊版相容） |
| `connected` | helper 有沒有連著 NDI 來源（沒人要畫面時會斷開省資源） |
| `receiving` | 最近 2 秒內有收到 NDI 畫面 |
| `fps` | 每秒送出幾張 JPEG（已套 `maxFps` 上限）；`ndiFps` = 每秒從 NDI 收到幾張（未限速） |
| `encodeMs` | 每張平均處理時間（縮小 + JPEG 編碼，毫秒；兩張可以同時編，所以 30 fps 不用小於 33） |
| `width`/`height` | NDI 原始尺寸；`outWidth`/`outHeight` = 送出的 JPEG 尺寸（太大才縮，見「畫質」）。還沒收到畫面時是 0 |
| `downscale` | 0.1.13 起：縮成幾分之一（`1` = 原樣送、`2` = 寬高各一半…；還沒收到畫面時是 0）。舊版沒有這欄（固定縮一半 = 2） |
| `jpegQuality` | 0.1.13 起：JPEG 品質（預設 90，色度不降取樣 4:4:4） |
| `clients` | 目前連著的網頁數 |
| `framesPaused` | **這條連線**有沒有暫停收畫面 |
| `autostart` | 0.1.10 起：開機自動啟動的實際狀況。`wanted` = 設定要開；`registered` = 真的有登記、而且指到目前這個執行檔（Windows Run 機碼 / macOS LaunchAgent）；`error` = 上次登記失敗的原因（中文，成功是 `null`） |

**3. 二進位訊息**：每一則 = 一張完整 JPEG（`createImageBitmap(new Blob([data], {type:'image/jpeg'}))`）。
只有在至少一條連線要畫面時才會送；最多每秒 `maxFps`（預設 30）張。網頁解碼太慢時 helper 會跳過舊的幀，不會越積越多。

**4. `select_ack`**：回應 `select_source`。

```json
{ "type": "select_ack", "name": "OTHER-PC (Adobe After Effects)", "mode": "manual", "available": true }
```

`available` = 這個名稱目前在 `sources` 裡。回到自動時 `name` 是 `null`、`mode` 是 `"auto"`。之後會緊接著一則新的 `status`。

**5. `error`**：看不懂的指令。

```json
{ "type": "error", "code": "unknown_command", "message": "不認得的指令：foo" }
```

`code`：`bad_json`、`bad_command`、`unknown_command`。

### 網頁 → helper

| 送什麼 | 作用 | 回什麼 |
|---|---|---|
| `"status"`（純文字）或 `{"type":"status"}` | 立刻要一則狀態 | `status` |
| `{"type":"select_source","name":"OTHER-PC (Adobe After Effects)"}` | 換來源，並記到 config（下次開機也用它） | `select_ack` + `status` |
| `{"type":"select_source","name":null}`（或 `""`） | 回到自動挑選 | `select_ack` + `status` |
| `{"type":"pause"}` | 這條連線暫停收畫面（只要狀態，例如設定頁）。所有連線都暫停 / 斷線 → helper 斷開 NDI，不解碼不編碼 | `status`（`framesPaused: true`） |
| `{"type":"resume"}` | 恢復收畫面 | `status`（`framesPaused: false`） |

連上時預設就會收畫面（舊版網頁不用改）。

### 自動挑來源的規則

1. 手動選過（`preferred`）而且在線 → 用它（可以是別台電腦；**只有這種情況**才會接別台）
2. 這台電腦的 After Effects（NDI 名稱「機器名 (程式名)」的機器名 = 本機名稱，不分大小寫；
   Windows 也比對 `COMPUTERNAME`；或來源 IP 是本機）
3. 這台電腦的其他 NDI 來源
4. 都沒有 → **不接**：`state` = `"searching"`、`source` = `null`、`error.code` = `no_local_source`
   （網路上一個來源都沒有時是 `no_source`）。別台電腦的來源照樣列在 `sources`（`local: false`），
   網頁要接就送 `select_source`

挑選結果會跟著來源上線 / 下線自動更新（例如 AE 晚一點才開，開了就自動切過去）。
從手動（別台）切回自動時，正在接的別台畫面會馬上斷開。

---

## 設定檔

位置（右鍵選單「開啟設定資料夾」）：
- Windows：`%APPDATA%\stage-previz-ndi-helper\config.json`
- macOS：`~/Library/Application Support/stage-previz-ndi-helper/config.json`

```json
{
  "port": 7777,
  "source_name": null,
  "downsample": true,
  "max_output_pixels": 4500000,
  "jpeg_quality": 90,
  "limited_to_full": false,
  "autostart": true,
  "max_fps": 30,
  "config_version": 3
}
```

- `source_name`：手動選的來源（網頁選來源時自動寫入）；`null` = 自動
- `downsample`：畫面**太大才縮**（預設開）：縮成整數分之一（1/2、1/3…），剛好不超過 `max_output_pixels`；
  本來就不大的畫面原樣送。`false` = 永遠不縮（原尺寸送，很吃 CPU）
- `max_output_pixels`：送出去的畫面最多幾個像素（預設 450 萬，見「畫質」）
- `limited_to_full`：把 16–235 拉成 0–255（預設關 = 送 NDI 給的原始像素，網頁照 `colorPipeline: "raw"` 自己校正顏色）。
  0.1.12 以前預設開，但實測 AE → NDI 收到的黑 ≈ 16、白 ≈ 255：拉了會把 235 以上全部截成 255、128 變 140
- `jpeg_quality`：JPEG 品質 1–100（預設 90；本機傳輸，頻寬不重要，只花 CPU）
- `max_fps`：送給網頁的最高 fps（AE 送 60 也只編 30 張）
- 改了 `config.json` 要重開小程序（右鍵 → 離開，再從開始選單打開）
- 升級：0.1.12 以前裝的（`config_version` 2 以下）第一次打開 0.1.13 會自動改成新預設：`jpeg_quality` 還是舊預設 75 → 90；
  `downsample` 開著的意思從「固定縮一半」變成「太大才縮」；`limited_to_full` 舊預設開 → 關（送原始像素）。
  自己改過的值（例如品質 60、`downsample: false`）不動
- `autostart`：開機自動啟動（預設開；右鍵選單切換）。從 0.1.8 以前升級上來會自動打開一次
- 開機自動啟動的實作：Windows = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\StagePrevizNdiHelper`；
  macOS = `~/Library/LaunchAgents/com.xyproai.stage-previz-ndi-helper.plist`（0.1.12 起直接執行 App 裡的執行檔並標明
  `AssociatedBundleIdentifiers`，「系統設定 → 一般 → 登入項目與延伸功能」和「App 背景活動」通知才會顯示 Stage Previz NDI Helper，
  不再顯示成「open」；App 在「下載」裡直接打開（暫存位置）時才用 `open -g -b <bundle id>`）。
  `autostart` 是 true 時每次啟動都會確保有登記、而且指到目前的執行檔（Windows 的值是加引號的 exe 路徑；
  寫完讀回確認），之後 15 秒、1 分鐘、然後每 10 分鐘再檢查一次（被別的程式刪掉會補回去並寫進 log）。
  結果在 status 的 `autostart` 欄位跟系統列選單。

同一個資料夾裡的 `helper.log` 是小程序的紀錄（Release 版沒有主控台視窗，出錯都寫在這裡；
超過 2 MB 會改名成 `helper.log.old` 再重新開始）。

開發 / 測試用環境變數：

| 變數 | 作用 |
|---|---|
| `STAGE_PREVIZ_NDI_PORT=7790` | 換 port（不寫回 config），可以跟正式在跑的 helper 並存 |
| `STAGE_PREVIZ_NDI_CONFIG_DIR=…` | 換設定檔資料夾 |
| `STAGE_PREVIZ_NDI_NO_AUTOSTART=1` | 不碰開機自動啟動設定 |
| `STAGE_PREVIZ_NDI_HEADLESS=1` | 不開系統列圖示 |
| `STAGE_PREVIZ_NDI_LIB=…` | 直接指定 NDI 函式庫檔案（設成不存在的路徑可以測「沒裝 NDI」） |

## 畫質（0.1.13）

0.1.12 以前**固定**把畫面寬高各縮一半、JPEG 品質 75：AE 用 Third 送 8800×2024 的畫布（2933×675）
到網頁只剩 1466×337，LED 看起來糊、有方塊。0.1.13 起：

- **太大才縮**：送出去最多 450 萬像素（`max_output_pixels`），超過才縮成整數分之一（每 f×f 個像素平均成一個，四捨五入）。
  例：1920×1080、AE Quarter / Third / Half 的 8800×2024 畫布（2200×506 / 2933×675 / 4400×1012）→ **原樣送**；
  整張 8800×2024（1780 萬）、3840×2160 → 1/2；10496×5120 → 1/4（Half 5248×2560、Third 3499×1707 → 1/2）
- **JPEG 品質 90、4:4:4**（色度不降取樣：LED 內容的彩色硬邊不會糊掉顏色）
- **兩個編碼工人輪流編**（JPEG 編碼只能單執行緒）：大畫面一張 20–35 ms，兩個輪流 → 還是能 30 fps；兩個都在忙就跳過那一張，不排隊

量測（Intel Core Ultra 9 285K，`cargo test --release -- --ignored --nocapture encode_benchmark`，像 LED 內容的測試畫面，每張中位數）：

| 畫面 | q75 4:2:0 | q75 4:4:4 | q90 4:2:0 | q90 4:4:4 |
|---|---|---|---|---|
| 2933×675（200 萬） | 4.7 ms | 6.4 ms | 5.6 ms | 8.9 ms |
| 2667×1500（400 萬） | 8.9 ms | 12.6 ms | 9.2 ms | 15.6 ms |
| 4400×1012（450 萬） | 9.9 ms | 13.3 ms | 11.3 ms | 17.9 ms |

整條（縮小 + JPEG q90 4:4:4）：AE Half 的 4400×1012 原樣送 22 ms；整張 8800×2024 → 4400×1012 34 ms
（0.1.12 同樣大小 q75：27 ms）。每秒最多編：4400×1012 一個工人 36 張、兩個 64 張。
中階筆電單核大約慢 1.6–1.8 倍 → 450 萬像素兩個工人輪流約 35 張/秒，夠 30 fps。

## 編譯

```bash
cargo test
cargo build --release
# 輸出：target/release/stage-previz-ndi-helper(.exe)
```

需要 Rust（https://rustup.rs）+ CMake + NASM（turbojpeg 會從原始碼編 libjpeg-turbo 並**靜態連結**，
使用者電腦不用另外裝任何東西；Apple Silicon 不需要 NASM）。

- Windows：Visual Studio C++ Build Tools（含 CMake）、NASM；安裝檔：`cargo install cargo-wix` → `cargo wix --no-build`
  （範本在 `wix/main.wxs`，已客製：開始選單捷徑、裝完自動啟動、升級前自動關掉舊版、不用 Restart Manager 也不建系統還原點（更新幾秒就好）、移除時清掉開機啟動。**不要**再跑 `cargo wix init --force`）
- macOS：`brew install cmake nasm`；包 App：`bash macos/make-app.sh target/release/stage-previz-ndi-helper 0.1.13 dist`
  （ad-hoc 簽章，使用者第一次打開會被擋；要發給別人用一定要再做下面的公證）
- macOS 公證（要在鑰匙圈裡有 Developer ID Application 憑證的 Mac 上做）：
  `bash macos/notarize.sh <make-app 做的 .app 或 Release 上的 zip> <輸出資料夾>` →
  Developer ID 簽章（hardened runtime + `macos/entitlements.plist`）→ Apple 公證 → staple → 輸出 `stage-previz-ndi-helper-mac.zip`。
  公證帳號用環境變數給：`NOTARY_PROFILE`（先跑過 `xcrun notarytool store-credentials`），
  或 `APPLE_ID` + `APPLE_TEAM_ID` + `APPLE_APP_SPECIFIC_PASSWORD`。**帳號、密碼、憑證都不要放進 repo / CI。**

發佈：推 tag `ndi-helper-vX.Y.Z` → GitHub Actions（`.github/workflows/ndi-helper-release.yml`）會編 Windows MSI +
Mac universal zip、跑冒煙測試、建 Release。網站固定連我們自己的網域（中國大陸連 GitHub 很慢）：
- `https://proxy.haimiaan.com/downloads/stage-previz-ndi-helper-windows.msi`
- `https://proxy.haimiaan.com/downloads/stage-previz-ndi-helper-mac.zip`

後台（`cf-worker/downloads.mjs`）最多 30 分鐘問一次 GitHub 最新版（`…/releases/latest`），有新的檔就複製一份到 R2；
同一個 tag 的檔案換掉（例如下面換成公證版）也會在 30 分鐘內換過去。後台抓不到時會轉去 GitHub 的
`…/releases/latest/download/<檔名>`。

CI 沒有 Apple 憑證，Mac zip 只有 ad-hoc 簽章 → Release 建好之後，在有 Developer ID 的 Mac 上把它換成公證版
（同一個執行檔，只換簽章；固定下載網址會自動變成公證版）：

```bash
cd ndi-helper
gh release download ndi-helper-vX.Y.Z -p stage-previz-ndi-helper-mac.zip -D /tmp/ndi-mac --clobber
bash macos/notarize.sh /tmp/ndi-mac/stage-previz-ndi-helper-mac.zip /tmp/ndi-mac/notarized
gh release upload ndi-helper-vX.Y.Z /tmp/ndi-mac/notarized/stage-previz-ndi-helper-mac.zip --clobber
```

只想測編譯不發佈：Actions 頁面手動跑 workflow（workflow_dispatch）。

## 架構

```
AE NDI Output
   ↓  NDI 函式庫（runtime 動態載入：Processing.NDI.Lib.x64.dll / libndi.dylib；找不到 → 回報 ndi_missing，每 5 秒再找）
ndi.rs   finder 常駐（每秒更新來源清單）→ 挑來源 → 有網頁要畫面才建 receiver
         → 限速 max_fps → 太大才縮小（整數分之一；顏色送原始像素）→ turbojpeg（兩個編碼工人輪流）
   ↓  broadcast
ws_server.rs  ws://127.0.0.1:7777（Origin 檢查）→ hello / status / JPEG
tray.rs  系統列圖示（主執行緒；macOS 規定）
autostart.rs  開機自動啟動（Windows Run 機碼 / macOS LaunchAgent）
```

為什麼用 libloading 不用現成的 ndi crate：那個 crate 在編譯時就要連結 NDI SDK，路徑寫死；
我們要在使用者電腦上**執行時**才去找 NDI，沒裝也能跑起來並提示去裝。

## License

MIT
