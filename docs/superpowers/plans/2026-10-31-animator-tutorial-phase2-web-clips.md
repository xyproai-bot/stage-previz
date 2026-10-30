# 動畫師上手教學 第二階段（網站短片）計畫

> **For agentic workers:** 照順序做 Task 1～4。不 push、不部署，上線由主線程做。

**Goal：** 教學頁（/tutorial/animator）有動作的步驟，從截圖換成 10～20 秒的短片。短片在本機測試環境錄，錄影腳本存進 repo，網站改了以後可以重錄。

**Spec：** `docs/superpowers/specs/2026-10-30-animator-tutorial-design.md`（C. 短片和教學影片）

**這次不做：** AE 的片段（`before-script`、`preview-ae-output`、`preview-ae-use`、`submit-export`）。這幾段之後由主線程用電腦操作錄，要用戶在場。登入那兩張圖也照舊（靜態圖就夠了）。

## 全域規則

- 只在本機測試環境錄：本機 wrangler dev、本機 D1 / R2、Vite dev、假帳號、假專案。**正式站和測試站的資料完全不碰**，也不連過去。
- 舞台用我們自己做的原創示範舞台：`C:\Users\phang\Desktop\StagePreviz-Demo\素材\示範舞台_demo-stage.glb`（142 KB）。把它複製進 repo：`web/scripts/tutorial-clips/assets/demo-stage.glb`。
  - **不能用 repo 根目錄的 `stage.glb`**，那個來源不確定。
  - 任何客戶的模型、圖、影片都不能用。
- LED 上的示範動畫有兩個來源：
  - 用 `C:\Users\phang\Desktop\StagePreviz-Demo\素材\` 裡的 S01 / S02 / S03 mp4。這些也是原創的。不要把它們複製進 repo，太大了。
  - 或在 seed 腳本裡用 ffmpeg 生成：彩色、看得出每片 LED 對位。
  - 不管用哪一個，大小都要跟本機專案的 LED 畫布一致。用 ffprobe 對一下。
- 假名字要一看就是示範用的：
  - 帳號：「示範製作」「示範動畫師」「示範導演」。
  - 專案：「示範演唱會」。
  - 不要出現像真人的名字。
- 登入要走網站本來的登入流程，例如登入碼或邀請連結。
  - 在本機 D1 建假帳號可以。
  - **不要自己簽登入憑證**，也不要用 AUTH_SECRET 做 session。
  - `cf-worker/.dev.vars` 放隨機產生的密鑰，錄完要刪掉。
- 不改 cf-worker 的程式，只在本機跑它。
- 前後台共用的規則檔不動。清單在 `.claude/skills/stage-previz-dispatch/SKILL.md` 第 7 節。
- 介面一律用繁中，不用 emoji（要圖示就用 `<Icon/>`），不用原生對話框。畫面上不能出現英文的角色字，守門測試會擋。
- commit 用中文寫，不加署名。

## 短片規格

- **錄影**：
  - 瀏覽器 viewport 1280×720。
  - 為了讓字清楚，可以用 deviceScaleFactor 1.5 錄，再縮成 1280×720；先試一段看看效果。
  - 一定要看得到滑鼠：錄影腳本自己注入一個假游標，加上點擊時的一圈小波紋。**只能在錄影腳本裡用 `addInitScript` 加，不能改網站程式**。
  - Playwright 本身錄的影片如果糊，就改用 CDP `Page.startScreencast`（品質 90）把每一格接給 ffmpeg。
- **輸出檔**：
  - 影片：`web/public/help/tutorial/<id>.mp4`。
    - H.264、yuv420p、`-movflags +faststart`、沒有聲音（`-an`）。
    - 長度 10～20 秒，每支不超過 2 MB，13 支加起來不超過 20 MB。
    - 能自然循環最好：結尾回到跟開頭差不多的畫面。
  - 封面：`web/public/help/tutorial/<id>.jpg`。
    - 大小跟影片一樣，不超過 150 KB。
    - 選一格看得懂在做什麼的畫面，不一定要第一格。
- **不能入鏡**：
  - 登入碼。
  - 任何真的網址或帳號。
  - 開發工具的畫面。
- **短片裡不加字**：字幕用教學頁的文字，之後改字不用重錄。
- **裁切**：教學頁的內容大約 1000 px 寬。要看的是小地方的話，例如版本列、加影片視窗，可以用 ffmpeg 裁切放大到重點區域。寬度至少 960，長寬比要固定。

## 要錄的 13 段

| id | 放在教學頁哪一步 | 內容 |
|---|---|---|
| `overview` | intro-what | 動畫師工作站。示範舞台的 LED 播著示範動畫，鏡頭慢慢轉：拖拉、滾輪縮放、按「重置攝影機」。 |
| `find-song` | login-find | 從首頁的「我的」歌點一首，進到工作站。 |
| `local-file` | preview-file | 來源選「本地檔案」，把影片拖進來，LED 出現動畫，然後播放。<br>拖檔可以在頁面裡用 DataTransfer 和 File 模擬，假游標要做出拖過去的樣子。 |
| `test-pattern` | preview-test | LED 上的測試圖。轉到側邊，看每片 LED 的名字和位置。 |
| `music-cue` | preview-music | 一首沒影片、有音樂的歌：按播放，點 cue 跳到那個時間，機關跟著動。<br>音樂用 ffmpeg 生的測試音，畫面沒聲音沒關係。 |
| `add-video` | submit-add | 按「＋ 加影片」，選檔，看上傳進度，出現新的一版。 |
| `versions` | submit-versions | 在版本列切 V1 / V2，LED 跟著換。 |
| `submit-review` | submit-review | 按提交審查，狀態變成「審查中」。 |
| `record-options` | record-options | 按「錄成影片」，打開設定視窗，看一遍解析度、範圍、鏡頭、cue 字幕，按「開始錄」。 |
| `record-progress` | record-wait | 錄影中：播放控制鎖住，下方出現進度條，按「停止」，出現「已存成 …」。 |
| `feedback-see` | feedback-see | 「審查 / 留言」分頁：點一則導演留言，換到那一版、跳到那一秒，攝影機飛到導演的視角，畫記疊上去。 |
| `feedback-reply` | feedback-reply | 按回覆打一句話，再按「已改好（V2）」，留言變灰。 |
| `compare` | feedback-compare | 「比較」選 V1，按 C 在兩版之間切換。 |

要錄的畫面得先準備好，由 seed 腳本做：

- 專案：示範舞台、自動貼 UV、版型。
- 3 首歌：
  - 第一首有 V1、V2，V1 被導演按「需修改」，有一則有視角、有畫記的留言。
  - 一首沒影片、有音樂。
  - 一首給「加影片」用。
- 幾個 cue。至少一個機關，例如升降台，cue 會動它。
- 把動畫師指派到這幾首歌。

每段的動作要先讀 `web/src/lib/tutorial/animatorTutorialContent.tsx` 那一步的文字，畫面要跟文字講的一樣。不一樣的話，以網站實際的樣子為準，然後回報哪裡不一樣，不要自己改教學文字。

## Task 1：錄影工具和本機示範專案

**檔案**（全部新的）：

- `web/scripts/tutorial-clips/package.json`：自己一份，放 `playwright`，**不要動 `web/package.json`**。
  - 本機已經有 Playwright 的瀏覽器：`%LOCALAPPDATA%\ms-playwright\chromium-1234`。挑一個對得上這個瀏覽器的 Playwright 版本，避免再下載。
  - 這個資料夾的 `node_modules` 不要進 git。
- `web/scripts/tutorial-clips/assets/demo-stage.glb`
- `web/scripts/tutorial-clips/seed.mjs`：照上面的清單建好本機示範專案。
  - 一律呼叫本機後台 API。帳號可以直接寫進本機 D1。
  - 跑兩次結果要一樣，例如先清掉舊的示範專案，或是已經有了就跳過。
- `web/scripts/tutorial-clips/README.md`：怎麼從零重錄，包含啟動本機後台和網站、跑 seed、跑錄影、轉檔，以及哪些東西不能入鏡。

**WebGL**：無頭模式下 3D 可能很慢，或是黑畫面。可以用有視窗的模式，或加 `--use-angle=d3d11` / `--enable-gpu` 試試。3D 要順，不能卡。

## Task 2：錄 13 段、轉檔

- `web/scripts/tutorial-clips/record.mjs`：
  - 一段一個函式，可以用 `node record.mjs overview` 只錄一段。
  - 要等畫面真的到了那個狀態再往下做，例如等元素出現、等 LED 有畫面。不要只靠固定秒數。
- `web/scripts/tutorial-clips/encode.mjs`：
  - 輸出 mp4 和 jpg。
  - 另外在 repo 外面（scratchpad 或 Temp）為每段做一張「6 格縮圖」，給主線程檢查用。路徑要寫進回報。
- 每段錄完，自己看那張 6 格縮圖，檢查四件事，不對就重錄：
  - 字讀得出來；
  - 3D 有畫面；
  - 假游標看得到；
  - 沒有不該入鏡的東西。

## Task 3：教學頁換成短片

**檔案：**

- `web/src/lib/tutorial/animatorTutorialContent.tsx`：
  - 加一個 `clip(id, alt)` 小函式，回傳 `{ kind: 'clip', src: '/help/tutorial/<id>.mp4', poster: '/help/tutorial/<id>.jpg', alt, width: 1280, height: 720 }`。寬高照實際檔案填。
  - 上面表格那 13 步改用 clip。原本沒有畫面的步驟也加上。
  - 其他步驟維持原本的圖。
  - `alt` 用一句白話描述短片在做什麼。
- `web/src/components/TutorialMedia.tsx`：一頁有 13 支短片，不能一打開就全部下載、全部播放。
  - 改成捲到看得到才開始載、開始播：用 IntersectionObserver，大約一半進畫面就播，離開就暫停。
  - 還沒進畫面時 `preload="none"`，只顯示封面。
  - 使用者設了「減少動態」就維持現在的做法：不自動播，給播放鍵。
  - 不支援 IntersectionObserver 的瀏覽器：顯示封面和播放鍵。
- 測試：
  - `animatorTutorialContent.test.ts`：每支 clip 的 mp4 和 jpg 都存在；mp4 不超過 2.5 MB；jpg 不超過 200 KB；有 alt。
  - `TutorialMedia` 的測試：
    - 進畫面就播、離開就暫停；
    - 減少動態時不自動播；
    - 沒有 IntersectionObserver 時有播放鍵。

## Task 4：驗證

- 跑新測試、全部 vitest 一次、`npm run build`。
- 瀏覽器實測一次，在本機打開 `/tutorial/animator`：
  - 1280 寬：捲到短片會播、捲走會停，封面都在；
  - 375 寬：不會左右捲動。
  - 截圖 1～2 張。
- 錄完：
  - 關掉本機伺服器；
  - 刪掉 `.dev.vars`；
  - 本機 D1 的示範資料可以留著（在 `.wrangler` 裡，不會進 git）。
- commit 拆成三個：工具＋seed、短片檔、教學頁＋測試。

## 回報（簡短）

- 做了什麼、commit 編號。
- 每段短片的長度和大小。
- 6 格縮圖放在哪裡。
- 哪些畫面跟教學文字不一樣。
- 哪些沒驗證到。
