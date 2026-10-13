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
  `kind`：`mention` / `reply` / `needs_changes` / `approved` / `new_version` / `assigned`。
- `POST /api/notifications/read` body `{ ids: [...] }` 或 `{ all: true }` → `{ ok, unreadCount }`（只能標自己的）。
- 排程每 5 分鐘清掉 60 天以前的通知。
- 前端：小鈴鐺每 25 秒 + 切回分頁更新；點一則開 `/preview/:p?song=&video=&comment=`（動畫師開 `/studio/...`）。
