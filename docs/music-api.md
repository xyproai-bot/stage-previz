# 歌曲的音樂 API（沒有影片的歌，用音樂當「歌的時間」）

後台：`cf-worker/songMusic.mjs`（格式 / 大小 / 權限 / 資料庫 / R2）和 `cf-worker/worker.js`（路由接線、播放）；`songMusic.test.mjs` 有測。
前端呼叫：`web/src/lib/musicApi.ts`。資料表：`cf-worker/migrations/0049_song_music.sql`（`song_music`，一首歌一列）。

所有網址前面是 `https://proxy.haimiaan.com`。登入方式跟其他 API 一樣（`Authorization: Bearer <token>`）。

## 規則

- 一首歌最多一首音樂。換音樂 = 這一列換成新的；移除 = 這一列拿掉。
- **誰能做什麼**
  - 看資料、聽：這個專案的成員（製作、導演、動畫師）。
  - 上傳 / 換 / 移除：製作（全站製作和這個專案的製作）和這個專案的導演（`canEditStage`）。動畫師 403、不是成員 403、沒登入 401。
  - 分享連結的訪客：這一版不給。分享連結走 `/api/share/…`，沒有音樂的路；分享頁的資料裡也沒有音樂。
  - 封存的專案：不能上傳 / 換 / 移除（409，跟其他寫入一樣）；全站製作還是可以看和聽。
- 有影片的歌放影片（影片自己的聲音），不放音樂；沒影片才放音樂。這是前端的規則，後台兩個都收。
- 格式：MP3（`audio/mpeg`）、WAV（`audio/wav`）、M4A（`audio/mp4`）、AAC（`audio/aac`）、FLAC（`audio/flac`）。看 `Content-Type`；類型是一般檔案（`application/octet-stream`）或沒寫時看檔名的副檔名。影片檔、OGG 之類不收（415）。
- **大小上限 90 MiB**（約 94 MB；4 分鐘 WAV 44.1k/16bit 約 40 MB、48k/24bit 約 70 MB 都放得下）。`wrangler.toml` 的 `MUSIC_MAX_BYTES` 可以改，最多 95 MiB（Cloudflare 一個請求最多 100 MB）。
- R2 位置：`music/<專案>/<歌>/<音樂 id>.<mp3|wav|m4a|aac|flac>`（bucket `stage-previz-models`，binding `MODELS`）。每次上傳一個新的音樂 id，換音樂不會蓋掉舊檔。
- 換 / 移除 / 刪歌時舊檔的 R2 位置先記進 `r2_pending_deletes`（跟資料庫的更新同一批），再試著刪；沒刪成功的留著，排程（`runPendingR2Deletes`）之後補刪。

## 路由

| 方法 | 網址 | 權限 | 說明 |
|---|---|---|---|
| GET | `/api/projects/:p/songs/:s/music` | 成員 | `{ music: Music \| null }`，含 `streamUrl` |
| PUT | `/api/projects/:p/songs/:s/music?filename=…&durationSec=…` | 製作、導演 | 請求內容就是音樂檔。201 = 新的、200 = 換掉舊的，回 `{ music }` |
| DELETE | `/api/projects/:p/songs/:s/music` | 製作、導演 | `{ ok: true }`；沒有音樂 404 |
| GET / HEAD | `/api/projects/:p/songs/:s/music/stream` | 成員（要登入 header） | 播放，支援 Range |
| GET / HEAD | `/api/music/:musicId/stream?pass=<通行證>` | 成員 | 給 `<audio src>` 用（帶不了登入 header）；沒帶 `pass` 也可以用登入身分 |

### 上傳

```
PUT /api/projects/p1/songs/s1/music?filename=S01%20開場.mp3&durationSec=215.5
Content-Type: audio/mpeg
Content-Length: 4120000
<檔案內容>
```

- `Content-Length` 一定要帶（後台把請求內容直接串進 R2）。沒帶 411、是 0 → 400、超過上限 413（回 `maxBytes`）、格式不收 415。
- `filename`：畫面上顯示的檔名（最多 255 字，路徑會去掉）；`durationSec`：瀏覽器量到的長度（秒，選填，不對就當沒有）。
- 瀏覽器用 XMLHttpRequest 傳才有進度（`musicApi.ts` 的 `uploadSongMusic`）。

### Music

```jsonc
{
  "id": "sm_0123456789abcdef",     // 每次上傳都換新的
  "songId": "s1",
  "filename": "S01 開場.mp3",
  "mime": "audio/mpeg",
  "sizeBytes": 4120000,
  "durationSec": 215.5,            // 沒有 = null
  "uploadedAt": "2026-10-30T08:00:00.000Z",
  "uploadedBy": { "id": "u_dir", "name": "王導" },   // 單首歌才有
  "streamUrl": "/api/music/sm_…/stream?pass=…"       // 單首歌才有；相對路徑，前面接後台網址
}
```

通行證跟影片同一套（6～12 小時有效，換人 / 換首 / 過期都不行），但簽名跟影片的分開：影片的通行證不能聽音樂。播到一半 401（`passExpired: true`）→ 重新 `GET …/music` 換新網址。

## 歌單帶的欄位

`GET /api/projects/:p/songs` 每首歌多：

- `hasMusic`：有沒有音樂（舊版前端不認識這個欄位，忽略就好）。
- `music`：`null`，或 `{ id, filename, mime, sizeBytes, durationSec, uploadedAt }`（沒有播放網址；要聽再 `GET …/music`）。

`GET /api/projects/:p/songs/:s` 多一個 `music`（同上）。

## 沒有帶過去的

複製專案、匯出 / 匯入專案**不帶音樂**（音樂是這一場的，複製出來的歌要自己再傳）。刪歌時音樂一起清掉。
