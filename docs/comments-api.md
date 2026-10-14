# 留言摘要 API

一次拿整個專案每首歌的留言數和最新一則，工作站重新整理時不用一首一首抓留言。
後台：`cf-worker/worker.js` 的 `commentsSummary`；路由權限在 `cf-worker/access.mjs`（`comments.summary`，專案成員都可以看）。
前端呼叫：`web/src/lib/videoApi.ts` 的 `getCommentsSummary(projectId)`。

## `GET /api/projects/:projectId/comments/summary`

權限：專案成員（admin / 導演 / 動畫師）。沒登入 401、不是成員 403、封存的專案非 admin 404。

```jsonc
{
  "songs": [
    {
      "songId": "s_…",
      "count": 5,                 // 這首歌全部留言（含回覆、含已解決）
      "openCount": 2,             // 還沒解決的
      "latestAt": "2026-10-14T03:00:00.000Z",   // 最新一則的 createdAt（沒有留言 = null）
      "latestId": "c_…",          // 最新一則的 id
      "fromOthersCount": 3,       // 不是我留的（看登入的人；舊資料沒記作者的算別人）
      "latestFromOthersAt": "2026-10-13T09:00:00.000Z"
    }
  ],
  "generatedAt": "2026-10-14T03:00:05.000Z"
}
```

- 每首歌都會列（沒有留言 = `count: 0`、時間 / id = null），順序跟歌單一樣。
- `createdAt` 是留言送出時前端帶的 ISO 時間（跟 `/api/comments` 回的一樣），所以可以直接跟 `unreadComments.ts` 的「上次看的時間」比。

## 算未讀的建議做法

1. 每次重新整理只叫一次 summary。
2. 某首歌 `latestFromOthersAt` 比上次看的時間新 → 才去抓那首歌的留言（`/api/comments?session=…`）算精確的未讀數；
   沒有比較新 → 未讀 = 0，不用抓。
3. 從沒看過的歌：未讀 = `fromOthersCount`。

---

# 審片 v2（留言綁版本、回覆、已改好、審片紀錄、站內通知）

後台：`cf-worker/reviews.mjs`（寫入、通知；`reviews.test.mjs`、`reviewsRoutes.test.mjs` 用 node:sqlite 跑真的 SQL）；
權限：`cf-worker/access.mjs`（`commentPostDecision` / `commentResolveDecision` / `commentReopenDecision` / `describeNotificationRoute`）；
資料表：`migrations/0024_review_v2.sql`（只有加欄位、加表）。前端：`web/src/lib/reviewApi.ts`、`commentThreads.ts`、`notifications.ts`。

## 留言（`/api/comments?session=…`，舊版前端不帶新欄位照樣能用）

- POST `comment` 多帶：`videoId`（正在看的那一版 → 記下 `videoVersion`；不是這首歌可以播的版本就當沒帶）、`parentId`（回覆；只有一層，回覆的回覆掛在最上面那則；沒帶版本就跟著那則）。
- PATCH 多帶：`resolvedVideoId`（`status: "resolved"` 時是哪一版改好的；沒帶 = 最新一版）。重新打開會清掉。
- DELETE：底下的回覆一起刪。
- 回傳的留言多了（有才有）：`videoId`、`videoVersion`、`parentId`、`resolvedVideoId`、`resolvedVersion`、`resolvedByUserId`、`kind`（`"needs_changes"` = 按需修改時寫的原因，文字是「需修改：…」）。

| 動作 | 誰可以 |
|---|---|
| 發留言、回覆 | 製作、導演；動畫師只能在自己的歌或還沒指派的歌 |
| 已改好 | 製作、負責的動畫師（沒指派 = 專案裡的動畫師）、留言的人自己（新畫面不給導演這個按鈕） |
| 重新打開 | 製作、導演、負責的動畫師、留言的人自己 |
| 改文字、刪除 | 留言的人、製作（跟以前一樣） |

通知：@到的人（`mention`）；回覆 → 被回覆的那則和最上面那則的作者（`reply`）。自己不通知自己；只通知專案成員和全站 admin（停用的不通知）。

## 通過 / 需修改（`PATCH /api/projects/:p/songs/:s`）

- 多帶 `reason`（需修改一定要寫：有 `reason` 欄位但空白 → 400）、`reviewVideoId`（看的是哪一版；沒帶 = 最新一版；不是這首歌可以播的版本 → 400，狀態不改）。舊版前端沒帶 `reason` → 照以前可以改，紀錄的原因空白。
- 改成功後：寫一筆審片紀錄；需修改的原因發成一則留言（綁那一版）；通知這首歌的動畫師（沒指派 → 交那一版的人）。回傳多 `reviewId`、`reviewCommentId`。409 `expectedStatus` 照舊。
- 動畫師提交（待製作 / 需修改 → 審查中）→ 通知專案的導演（`new_version`）。
- 新的一版好了（上傳完成 / 貼連結、Drive 複製完）：歌在需修改 → 自動回到審查中；歌在審查中 / 已通過 → 通知導演（`new_version`）。待製作不動。
- 指派動畫師 → 通知他（`assigned`）。

`GET /api/projects/:p/songs/:s/reviews`（成員）→ `{ reviews: [{ id, songId, videoId, version, versionLabel, status, statusLabel, fromStatus, reason, commentId, by: { id, name, role }, createdAt }] }`，新的在前。

`GET /api/projects/:p/songs` 每首歌多：`lastReview`（`{ videoId, version, versionLabel, status, reason, byName, byRole, at }` 或 null）、`reviewedVersion`（審過的最新版本號；`latestVideoVersion` 比它新 → 「有新版 V3」）。

## 站內通知（要登入；分享連結的訪客沒有）

- `GET /api/notifications?limit=30` → `{ items: [...], unreadCount, generatedAt }`（一個請求；最新的在前）。只列現在還是成員的專案（全站 admin 都看得到），封存的專案非 admin 不列。
  每則：`{ id, kind, projectId, projectName, projectRole, songId, songName, songCode, videoId, version, versionLabel, commentId, actorName, excerpt, createdAt, read }`。
  `kind`：`mention` / `reply` / `needs_changes` / `approved` / `new_version` / `assigned` / `guest_comment`（0026：分享連結的訪客留言）。
- `POST /api/notifications/read` body `{ ids: [...] }` 或 `{ all: true }` → `{ ok, unreadCount }`（只能標自己的）。
- 排程每 5 分鐘清掉 60 天以前的通知。
- 前端：小鈴鐺每 25 秒 + 切回分頁更新；點一則開 `/preview/:p?song=&video=&comment=`（動畫師開 `/studio/...`）。

---

# 審片像 Frame.io（0026：畫記、3D 視角、區段、縮圖、訪客留言）

後台：`cf-worker/comments.mjs`（整理 / 檢查，純函式）、`reviews.mjs`（團隊留言寫入、縮圖）、`guestComments.mjs`（訪客）；
權限：`access.mjs`（`canToggleShareComments`、`guestCommentDecision`）；資料表：`migrations/0026_framelike_review.sql`（只有加欄位）。
測試：`comments.test.mjs`、`guestComments.test.mjs`、`framelikeRoutes.test.mjs`。前端：`web/src/lib/annotations.ts`、`reviewApi.ts`、`guestComments.ts`。

## 留言多的欄位（團隊 `/api/comments`、訪客分享連結都一樣；舊版前端不帶 → 跟以前一樣）

| 欄位 | 說明 | 不對的時候 |
|---|---|---|
| `time` + `timeEnd` | 區段留言 0:12–0:18（`timeEnd` 沒有 = 一個時間點） | 結束 ≤ 開始、超過 1 小時 → 400（中文說明） |
| `view` | 留言當下的攝影機 `{ position: [x,y,z], target: [x,y,z], fov, aspect }` | 壞掉的當沒帶（不擋留言） |
| `cueId` | 留言當下的 cue | 格式不對當沒帶 |
| `annotation` | 畫記 `{ v: 1, aspect, shapes: [{ t: 'pen'\|'arrow'\|'rect'\|'ellipse', c, w, p: [x0,y0,x1,y1,…] }] }`；座標 0~1（相對 3D 畫面，`aspect` = 畫的時候畫面的寬 / 高）；顏色只收 `#ff3b30 #ffcc00 #34c759 #0a84ff #ffffff`；最多 60 筆、一筆 400 點、全部 4000 點 | 400 |
| `thumbnail`（只有送） | `data:image/jpeg;base64,…`，留言當下抓一次 3D 畫面 + 畫記（約 480 px 寬），最多 150 KB | 不是 JPEG 400、太大 413 |
| `thumbUrl`（只有讀） | `/api/comment-thumbs/<專案>/<留言>-<隨機碼>.jpg`（前面接 API 網址） | |

- 縮圖不用登入就能看（網址有 128 bits 隨機碼，跟模型檔一樣）；`Cache-Control: immutable`。刪留言（含底下的回覆）縮圖一起刪。
- 一次送來的 JSON 最多 400 KB（413）。

## 訪客留言（分享連結，每條連結預設關）

- 製作在分享連結對話框勾「允許看的人留言」：`POST /api/projects/:p/share-links` 或 `PATCH .../share-links/:token` 帶 `{ allowComments: true }`。
  **打開只有製作**（導演 403）；關掉製作、導演都可以。也可以帶 `label`（連結名稱，例：給經紀人；最多 40 字、不收 HTML）。
  舊版前端只送 `{ slug }` 照樣能改。清單每條多 `allowComments`、`label`、`guestCommentCount`。
- 分享頁 `GET <分享>/data` 多 `allowComments`（連結名稱不給訪客）。
- `GET <分享>/songs/:s/comments` → `{ comments }`：**只有這條連結留的留言串 + 團隊在那些串底下的回覆**（團隊自己的留言、別條連結的都看不到）；
  不給 email、帳號 id、@ 誰、誰標的已改好。沒開 → 403 `{ commentsDisabled: true }`。
- `POST <分享>/songs/:s/comments` body `{ guestName, comment: { id, text, time, timeEnd?, view?, cueId?, annotation?, thumbnail?, parentId?, videoId? } }`
  - 名字一定要（最多 30 字）；內容最多 1000 字；名字、內容的 HTML 拿掉。作者、身分、狀態由後台填（送來冒充的一律不算）。
  - `parentId`：只能回覆這條連結裡的串（回覆的回覆掛在最上面那則），不然 404。
  - 綁版本：送來的 `videoId` 是這首歌可以播的就用它，不然最新一版。
  - 防亂發：同一條連結 + 同一個 IP 10 分鐘 10 則、同一張通行證（有密碼的連結）1 小時 30 則、一條連結一天 200 則 → 429（`retryAfterSec`）。同一個 `id` 重送不算新的。
  - 密碼 / 通行證、有效期、封存、限定單首歌：跟分享頁其他請求一樣。
  - 回 `{ ok, id, comments }`（訪客看得到的整串）。
- 團隊看到：`author` = 「訪客：小李（給經紀人）」、`role: 'guest'`、`guest: { name, linkName }`；在訪客的串底下回覆，訪客也看得到。
- 小鈴鐺（`actorName` = 「訪客：小李（給經紀人）」）：只通知**建這條連結的人**、**專案的導演**、**這首歌的動畫師**（`guest_comment`）；
  訪客回覆一串時，這串裡團隊那邊留過言的人也收到（`reply`，跟團隊回覆的規則一樣）。同一個人只收一則；要還是專案成員（全站製作算）、沒停用。
  其他成員、全站製作（不是建連結的人）不收。規則在 `guestComments.mjs` `guestCommentWants`。
- 訪客不能改、刪、標已改好。

---

# 參考圖片（0028：留言附圖片）

後台：`cf-worker/commentAttachments.mjs`（上傳、檢查、掛到留言上、清掉）、`guestComments.mjs`（訪客的額度）；
規則前後台共用 `web/src/lib/review/attachmentRules.ts`；資料表：`migrations/0028_comment_attachments.sql`（只有加表）。
測試：`commentAttachments.test.mjs`。前端：`web/src/lib/review/attachmentsApi.ts`、`useAttachmentDraft.ts`、`components/CommentAttachments.tsx`。

1. 先上傳：`POST /api/comment-attachments?session=…`（團隊，跟發留言同樣的人）／`POST <分享>/songs/:s/comment-attachments`（訪客，連結要開留言）
   - multipart：`file`（PNG / JPEG / WebP / GIF，看檔頭判斷，最多 15 MB；JPEG / PNG / WebP 長邊最多 4096）、`thumb`（清單用的小縮圖，約 480 px，可以沒有）
   - 回 `{ ok, attachment: { id, url, thumbUrl?, type, size, width, height } }`；類型不對 415、太大 413、尺寸太大 400
   - 前端先縮到長邊 2560、重新存一次（EXIF / GPS 拿掉）；GIF 原樣
2. 送出：留言多帶 `attachmentIds: [...]`（照順序；團隊最多 4、訪客最多 2；要是自己 / 這條連結傳、還沒送出的）。有圖片可以不寫字。
   - 只有圖片的留言：API 回 `text: "（圖片）"` + `noText: true`（舊版畫面看到「（圖片）」）；通知內容也是「（圖片）」
   - 留言多一個 `attachments: [...]`（沒有圖片的留言沒有這個欄位）
3. 改留言：PATCH 帶 `attachmentIds` = 新的整串（留言的人或製作）；拿掉的連 R2 檔案一起刪。沒帶 = 圖片不動。
4. 拿掉還沒送出的：`DELETE /api/comment-attachments?session=…&id=…`／`DELETE <分享>/songs/:s/comment-attachments/:id`
5. 看圖：`GET /api/comment-attachments/<專案>/<32 hex>[-t].<副檔名>`，不用登入（網址猜不到），快取一年、`nosniff`
6. 清掉：刪留言（含回覆）、刪歌 → R2 檔案一起刪；上傳了一天都沒送出的 → 排程清掉
7. 額度：團隊一個人還沒送出的最多 24 張、一天 300 張；訪客（最近 24 小時）同一條連結 + 同一個 IP 20 張、同一張通行證 20 張、一條連結 100 張 → 429
