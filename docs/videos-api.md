# 歌曲影片版本 API（V1、V2…，檔案放 R2）

後台：`cf-worker/worker.js`「歌曲影片版本」那一段；純判斷（代號對歌、版本號、連結、權限、播放通行證）在 `cf-worker/videos.mjs`（`videos.test.mjs` 有測）。
前端呼叫：`web/src/lib/videoApi.ts`（有型別，直接用）。資料表：`cf-worker/migrations/0021_song_videos.sql`。

所有網址前面是 `https://proxy.haimiaan.com`（`apiBase()`）。登入方式跟其他 API 一樣（`Authorization: Bearer <token>`）。
錯誤一律是 `{ "error": "中文說明", ...其他欄位 }`，`error` 可以直接顯示給使用者。

## 重點

- **影片一律放我們的 R2**，播放不經過 Google（之後大陸入口也能播）。貼連結 / Drive 同步都是後台**複製一份**到 R2，播放時不會再去抓來源。
- **版本號固定**：每首歌 V1、V2…，檔案好了（ready）才給號碼；取消 / 失敗不佔號碼；刪掉的號碼不會再用（V2 刪了，下一版是 V3）。
- **歌曲固定代號** `code`（S01…）：每個專案裡不重複、可以改。Drive 資料夾同步用「檔名開頭的代號」對歌，不再看歌單第幾首。
- 舊的 Drive 直播（`/api/drive/stream/:fid`、分享頁 `/videos/:fid/stream`）照樣能用，之後再拿掉。

## 權限

| 動作 | 誰可以 |
|---|---|
| 看版本清單、播放 | 專案成員（admin / 導演 / 動畫師） |
| 交新版（上傳、貼連結） | admin；負責這首歌的動畫師（歌沒指派人 = 專案裡的動畫師都可以）。導演不行（403） |
| 改標題 / 說明、刪除、取消、續傳、重試 | admin；交這一版的人（而且還有交影片的權限） |
| 改歌曲代號 | admin（跟改歌名一樣） |

封存的專案：只能看，寫入一律 409。

## 一版影片（`SongVideo`）

```jsonc
{
  "id": "sv_3f9a1c2b4d5e6f70",
  "projectId": "p_…", "songId": "s_…",
  "version": 3,              // 好了才有；上傳中 / 複製中 / 失敗 = null
  "label": "V3",             // 沒有版本號 = ""
  "title": "S01_開場", "note": "修了第二段的轉場",
  "source": "upload",        // upload | link | drive
  "originalUrl": null,       // 貼的連結（source = link）
  "driveFileId": null,
  "mime": "video/mp4",       // video/mp4 | video/quicktime | video/webm
  "sizeBytes": 123456789, "width": 1920, "height": 1080, "durationSec": 215.4,
  "status": "ready",         // uploading | processing | ready | failed
  "error": null,             // failed：失敗原因；processing：最近一次出錯（後台會自動重試）
  "progress": null,          // 上傳中 / 複製中：{ "bytesDone": 0, "totalBytes": 123 }
  "createdBy": { "id": "u_…", "name": "小明" },   // Drive 同步 = null
  "createdAt": "2026-10-14T03:00:00.000Z", "updatedAt": "…", "readyAt": "…",
  "isLatest": true,          // 這首歌最新的可播版本
  "streamUrl": "/api/videos/sv_…/stream?pass=…",  // ready 才有；相對路徑
  "upload": { "partSize": 16777216, "partCount": 8, "uploadedParts": [1, 2], "maxConcurrency": 3 }  // 只有 uploading
}
```

## 網址

`:p` = 專案 id，`:s` = 歌 id，`:v` = 影片 id。

### 版本清單 / 單一版本

| | 網址 | 回傳 |
|---|---|---|
| GET | `/api/projects/:p/songs/:s/videos` | `{ videos: SongVideo[], latestVideoId, songCode }`。上傳中 / 複製中 / 失敗的在最前面（新的在前），接著版本號由大到小 |
| GET | `/api/projects/:p/songs/:s/videos/:v` | `{ video }`（上傳中多 `upload` 給續傳用） |
| PATCH | `/api/projects/:p/songs/:s/videos/:v` | body 任選 `{ title, note, width, height, durationSec }` → `{ video }` |
| DELETE | `/api/projects/:p/songs/:s/videos/:v` | `{ ok: true }`。從清單拿掉（R2 的檔案先留著），還沒好的順便取消 |

歌曲清單 `GET /api/projects/:p/songs` 每首歌多了：`code`、`latestVideoId`、`latestVideoVersion`（沒有影片 = null）。

> 有「複製中」的版本時，畫面每 2～5 秒查一次清單或單一版本 —— **每次查詢都會推動後台繼續複製**（見下面「後台複製」）。

### 上傳（分段，可以續傳）

1. `POST /api/projects/:p/songs/:s/videos/uploads`
   body `{ filename, sizeBytes, mime, title?, note?, width?, height?, durationSec? }`
   → 201 `{ video }`（`status: "uploading"`，`video.upload` 告訴你怎麼切）
   - 413 太大（`maxBytes` = 上限，預設 4 GB）、415 格式不收（只收 MP4 / MOV / WebM）、400 大小不對
2. `PUT /api/projects/:p/songs/:s/videos/:v/parts/:n`（n 從 1 開始）
   body = 檔案的第 n 段原始 bytes（`Content-Type: application/octet-stream`），**大小一定要剛好**：每段 `partSize`，最後一段放剩下的。
   → `{ ok, partNumber, etag, bytesDone, totalBytes }`。可以同時傳好幾段（建議 3）；同一段可以重傳。
   - 400 段數 / 大小不對（`expectedBytes`）、409 這一版已經不在上傳中、502 這一段沒傳成功（重傳這一段）
3. `POST /api/projects/:p/songs/:s/videos/:v/complete`，body 可選 `{ width, height, durationSec }`
   → `{ video }`（`status: "ready"`，有 `version`）。按兩次也沒關係。
   - 409 還有段沒傳（`missingParts: [3, 7]`）
4. 取消：`POST /api/projects/:p/songs/:s/videos/:v/abort` → `{ ok: true }`（號碼不會被佔走）

續傳：把 `video.id` 存在 localStorage（`uploadResumeKey(...)`），下次 `GET` 那一版看 `upload.uploadedParts`，只傳缺的段。
上傳中超過 2 天沒動 → 排程自動取消。`videoApi.ts` 的 `uploadSongVideo()` 把整個流程（續傳、同時傳、失敗重試、完成）包好了。

### 貼連結（後台複製到 R2）

`POST /api/projects/:p/songs/:s/videos/link`，body `{ url, title?, note? }`

後台先試抓一下，有問題**馬上**回中文錯誤；沒問題回 202 `{ video }`（`status: "processing"`），開始複製。
同一個連結還在複製中又貼一次 → 200 回同一版（`duplicate: true`）。

| 連結 | 怎麼處理 |
|---|---|
| Google Drive 單檔（`/file/d/…`、`open?id=`、`uc?id=`） | 用連接的 Google 帳號讀（專案綁的那個優先）。連接帳號自己的檔案、又不在專案資料夾裡 → 只有 admin 能用；其他人改走公開下載（檔案要設「知道連結的使用者都能查看」） |
| Dropbox（`/s/…`、`/scl/fi/…`） | 自動改成 `dl=1` |
| OneDrive（`1drv.ms`、`onedrive.live.com`）/ SharePoint | 盡量轉成下載網址；微軟不給下載時回清楚的錯誤，請對方下載後用上傳 |
| 直接網址（`.mp4` / `.mov` / `.webm`，或伺服器說是影片） | 直接抓 |
| 資料夾、Google 文件、YouTube / Vimeo、WeTransfer…、本機 / 內部網路位址 | 400，中文說明 |

錯誤碼：400 看不懂 / 不支援的連結、413 太大、422 抓不到（沒權限、是網頁不是影片、找不到檔案、來源沒說多大…）。

### 後台複製（貼連結 / Drive 同步共用）

Cloudflare 一個請求做完後最多再跑 30 秒、免費方案一次最多 50 個對外請求，所以大檔**分好幾輪**複製（每輪抓 32 MiB 一段，最多十段左右）：

- 貼連結的那個請求做完後馬上做一輪
- 畫面查清單 / 單一版本時，如果有閒著的複製工作就再做一輪
- 排程每 5 分鐘做 3 分多鐘（畫面關掉也會慢慢做完）

來源不支援分段下載（Range）→ 一次複製完：150 MB 以下馬上做，更大的交給排程（排程最多可以跑 15 分鐘）。
連續 8 輪沒有進度、或來源打不開了（401 / 403 / 404）→ `failed` + 原因。失敗的可以重試：

`POST /api/projects/:p/songs/:s/videos/:v/retry` → 202 `{ video }`（`processing`）；格式不支援 / 太大的不能重試（409）。

### 播放（R2，支援 Range）

- 成員：用清單回的 `streamUrl`：`GET|HEAD /api/videos/:v/stream?pass=<通行證>`
  - 通行證綁「這個人 + 這一版」，有效 6～12 小時；同一段時間拿到的網址一樣（瀏覽器快取有用）
  - 過期 → 401 `{ passExpired: true }` → 重新拿清單換新網址
  - 沒帶 `pass` 也可以用登入身分（Bearer / cookie）；`/api/projects/:p/songs/:s/videos/:v/stream` 也可以（要登入 header）
- 回應：`Content-Type`（影片類型）、`Accept-Ranges: bytes`、`ETag`、`Cache-Control: private, max-age=31536000, immutable`（每一版一個網址、內容永遠不變）
  - `Range: bytes=…` → 206 + `Content-Range`；超出檔案 → 416；`If-None-Match` 對上 → 304
- 給 Three.js 當 LED 貼圖：`<video crossOrigin="anonymous">` 就可以（後台有回 CORS）

### 分享連結（不用登入）

`<base>` = `/api/share/<連結碼>` 或 `/api/s/<網址名稱>`；有密碼的連結照舊用 `X-Share-Access` header（影片網址已經接好 `?access=`）。

| | 網址 | 回傳 |
|---|---|---|
| GET | `<base>/data` | `songs[]` 每首多了 `code`、`latestVideo`（最新可播版本，沒有 = null） |
| GET | `<base>/songs/:s/versions` | `{ videos: [最新可播版本]（0 或 1 個）, latestVideoId }` |
| GET/HEAD | `<base>/song-videos/:v/stream[?access=…]` | 跟成員播放一樣（Range、快取） |

分享看到的一版沒有 `note`、`createdBy`、`originalUrl`。限定單首歌的連結看不到別首歌的影片（403）。

## 歌曲代號

- 規則：英文字母、數字、中間可以有 `-`，1～12 字，存成大寫（`S01`、`ENC-1`、`OP`）。`S1` 和 `S01` 算同一個。
- 新歌自動給下一個號碼（目前最大的 S 號碼 + 1）；`POST /songs` 也可以帶 `code`。
- 改：`PATCH /api/projects/:p/songs/:s` body `{ code: "S05" }`。被別首歌用掉 → 409 `{ codeTaken: true }`；格式不對 → 400。
- 換歌單順序**不會**改代號。
- 舊專案：migration 0021 照當時的順序補（第 1 首 = S01…），跟以前「S03 = 第 3 首」對到同一首。

## Drive 資料夾同步（排程每 5 分鐘 / 手動）

- 只收影片檔（圖片、文件不列）。
- 檔名開頭是代號就對到那首歌：`S01_開場.mp4`、`S01-開場.mov`、`S01 開場.mp4`、`S01.mp4`、`s1_x.mp4` → 代號 S01。代號後面一定要接「不是英文字母 / 數字」的字（`S01A_x.mp4` 不算 S01）。
- 對不到的留在「未分類」（`drive_files.song_id = NULL`），不掛到任何一首歌；手動歸類的照舊保留。
- 新的 / 內容改過的影片（看 Drive 的 md5）→ 那首歌多一版，後台複製到 R2；同一個內容不會重複建（刪掉的版本也不會再冒出來）。瀏覽器播不了的格式（.mkv 等）、太大的 → 建一筆 `failed` 並寫原因。
- `drive_filename_pattern`（舊的正規表示式設定）不再使用。

## 設定（`cf-worker/wrangler.toml` 的 `[vars]`）

| 名稱 | 預設 | 說明 |
|---|---|---|
| `VIDEO_MAX_BYTES` | `4294967296`（4 GB） | 單一影片上限 |
| `VIDEO_COPY_PART_BYTES` | 32 MiB | 後台複製每段多大（5 MiB～95 MiB） |
| `VIDEO_COPY_STEP_FETCHES` | 10 | 請求裡每輪最多抓幾段（測試用） |

R2 位置：`videos/<專案>/<歌>/<影片 id>.<mp4|mov|webm>`（bucket `stage-previz-models`，binding `MODELS`）。刪歌時那首歌的影片檔一起清掉。
