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
