# 動畫師上手教學頁的短片（錄影工具）

教學頁 `/tutorial/animator` 有動作的 13 步，畫面是 10～20 秒、沒有聲音、會循環的短片
（`web/public/help/tutorial/<id>.mp4` + 封面 `<id>.jpg`）。這個資料夾是錄它們的工具：
**網站改了，照下面的步驟從零重錄就好**。

- 只在**本機**錄：本機後台（wrangler dev）、本機資料庫和檔案、本機網站（Vite）、假帳號、假專案。
  正式站和測試站的資料完全不碰，工具也不會連過去（`lib.mjs` 看到不是 127.0.0.1 / localhost 的網址會直接停）。
- 舞台用 `assets/demo-stage.glb`（原創的示範舞台）。LED 上的動畫、音樂都是用 ffmpeg 現場生的（`media.mjs`），
  大小跟專案的 LED 畫布一樣。**不能用** repo 根目錄的 `stage.glb`，也不能用任何客戶的模型、圖、影片。
- 登入走網站本來的登入頁（打登入碼、按登入）。工具不自己簽登入憑證。登入碼只存在 `.work/`（不進 git），不會入鏡。
- 網站程式、後台程式、前後台共用的規則檔一個字都不用動。假游標、拖檔案都是錄影腳本自己在頁面裡加的。

## 檔案

| 檔案 | 做什麼 |
|---|---|
| `seed.mjs` | 建好本機示範專案（可以重跑，每次先清掉舊的示範專案和帳號再重建） |
| `seed-uv.mjs` | 示範舞台的「自動貼 UV」（UV 是瀏覽器算的，所以這一步開瀏覽器，照製作平常的做法按一次） |
| `seed-content.mjs` | 歌、cue、升降台機關、影片版本、音樂、導演的留言；也有「錄之前把資料還原」的小函式 |
| `media.mjs`、`uvRects.mjs` | 生示範動畫（照每片 LED 在畫布上的位置畫）和音樂 |
| `clips.mjs` | 13 段短片：每段 = `setup`（準備畫面，不錄）+ `run`（真正錄的動作）+ `encode`（裁切、封面） |
| `record.mjs` | 錄影 |
| `encode.mjs` | 把錄好的畫格轉成 mp4 + 封面 jpg，另外做一張 6 格縮圖給人檢查 |
| `recorder.mjs`、`browser.mjs`、`env.mjs`、`lib.mjs` | 底層：假游標、畫面擷取、開瀏覽器、後台呼叫、ffmpeg |
| `.work/`（不進 git） | 假帳號的登入碼、登入狀態、生成的影片 / 音樂、錄下來的畫格 |

## 從零重錄

需要：Node 20 以上、ffmpeg、Windows / Mac 有 GPU 的電腦（3D 用顯示卡畫才不會卡；沒有顯示卡會自動退回軟體算，比較慢）。

1. 裝套件（第一次）：
   ```
   cd web && npm ci
   cd ../cf-worker && npm ci
   cd ../web/scripts/tutorial-clips && npm install
   ```
   這個資料夾自己有一份 `package.json`（`playwright 1.62.0`，對得上電腦上已經有的 `chromium-1234`；
   沒有的話跑一次 `npx playwright install chromium`）。**不要動 `web/package.json`**。

2. 本機後台（開著，另開一個終端機）：
   ```
   cd cf-worker
   node -e "require('fs').writeFileSync('.dev.vars','AUTH_SECRET='+require('crypto').randomBytes(32).toString('hex')+'\n')"
   npx wrangler d1 migrations apply stage-previz-db --local
   npx wrangler dev --port 8799 --local
   ```
   `.dev.vars` 放的是隨機產生的密鑰，**錄完要刪掉**。

3. 本機網站（開著，再開一個終端機）：
   ```
   cd web
   npx vite --port 5199 --strictPort --host 127.0.0.1
   ```
   （換了 port 的話，用環境變數 `CLIP_API_BASE`、`CLIP_WEB_BASE` 告訴錄影工具。）

4. 建示範專案：
   ```
   cd web/scripts/tutorial-clips
   node seed.mjs
   ```
   會建三個假帳號（示範製作、示範動畫師、示範導演）、專案「示範演唱會」、6 首歌。
   （本機資料庫的 migration 會預設放一個製作帳號，名字是真人的，seed 會把它從**本機**資料庫刪掉，免得入鏡。）

   | 歌 | 內容 | 給哪一段用 |
   |---|---|---|
   | S01 開場 | V1（熱色）、V2（冷色）；導演對 V1 按了「需修改」，另有一則有 3D 視角和畫記的留言 | overview、versions、record-*、feedback-*、compare |
   | S02 主題曲 | V1，還沒提交審查 | submit-review |
   | S03 抒情 | V1 | add-video（要傳的 V2 是 `.work/media/S03_抒情_V2.mp4`） |
   | S04 間奏 | 沒影片、有音樂、有升降台機關 | music-cue |
   | S05 安可 | 沒影片、沒音樂 | test-pattern、local-file |
   | S06 謝幕 | 沒指派給動畫師 | find-song（「全部」看得到、「我的」看不到） |

5. 錄影、轉檔：
   ```
   node record.mjs --encode --grid-dir <6 格縮圖放哪裡>      # 全部
   node record.mjs overview compare --encode                 # 只錄指定的幾段
   node encode.mjs overview                                  # 只重新轉檔（不重錄）
   ```
   - 輸出：`web/public/help/tutorial/<id>.mp4`（H.264、yuv420p、`faststart`、沒有聲音、1280×720）和 `<id>.jpg`。
   - `--grid-dir` 的 6 格縮圖是給人檢查用的，**放在 repo 外面**。
   - 有改到資料的幾段（提交審查、加影片、回覆）錄之前和錄完都會自動還原，所以可以單獨重錄任何一段。

6. 錄完：關掉兩個終端機的伺服器、**刪掉 `cf-worker/.dev.vars`**。本機資料庫的示範資料在 `cf-worker/.wrangler/`（不進 git），可以留著。

## 每段短片錄完要看什麼

看 `encode.mjs` 做的 6 格縮圖，四件事都要對：字讀得出來、3D 有畫面、假游標看得到、沒有不該入鏡的東西。

**不能入鏡**：登入碼、任何真的網址或帳號、真人的名字、開發工具的畫面。示範用的名字一律是「示範製作 / 示範動畫師 / 示範導演 / 示範演唱會」。
短片裡不加字（字幕用教學頁的文字，之後改字不用重錄）。

## 為什麼這樣錄（踩過的坑）

- **畫面用 `--force-device-scale-factor=1.5`（瀏覽器自己的參數）**，錄出 1920×1080 再縮成 1280×720，字比較清楚。
  Playwright 的 `deviceScaleFactor` 只是模擬，擷取到的還是 1280×720，字不會變清楚，所以不能用。
- **用 CDP 的 `Page.startScreencast` 一格一格接**，不用 Playwright 內建的錄影（畫質低、字會糊）。
  畫面沒變的時候不會有新的一格，所以每格都記時間，轉檔時依時間決定停多久。
- **假游標**只在錄影腳本裡用 `addInitScript` 加（`recorder.mjs`），跟著真的滑鼠事件走，按下去有一圈波紋。
- **拖檔案**：用頁面裡的 `DataTransfer` + `File` 做出一樣的 dragenter / dragover / drop，游標旁邊跟著一張檔案小卡。
- **上傳進度**：本機上傳 1.5 MB 一下就完了，錄影腳本用 CDP 的 `Network.emulateNetworkConditions` 把上傳速度壓慢，進度條才看得到。
- **3D 視角拖太多會轉到看不到舞台**（畫面全黑）：拖的距離一次不要超過 100 像素左右。
- **AE 即時的說明卡**（沒有小程序時蓋在 3D 上）：沒影片的歌要看測試圖，先把卡片收起來（`dismissAeCard`）。
- **裁切放大**：`clips.mjs` 的 `encode.crop`（CSS 像素，長寬比固定 16:9，不能超出 1280×720）；輸出一律 1280×720。

## 新增 / 修改一段短片

1. 在 `clips.mjs` 的 `CLIPS` 加一段（`setup` 準備畫面、`run` 做動作；要等畫面真的到了那個狀態再往下，不要只靠固定秒數）。
2. 需要新的假資料就改 `seed-content.mjs`，需要還原就寫 `reset`。
3. `node record.mjs <id> --encode --grid-dir ...`，看 6 格縮圖，不對就調到對為止。
4. 在 `web/src/lib/tutorial/animatorTutorialContent.tsx` 用 `clip('<id>', '一句白話描述')` 掛到對應的步驟。
