# LED 畫布版型 API

設計：`docs/superpowers/specs/2026-10-15-led-canvas-templates-design.md`。
後台：`cf-worker/ledTemplates.mjs`（`ledTemplates.test.mjs` 有測，用 node:sqlite 跑真的 migration）；路由 / 權限在 `cf-worker/access.mjs`。
檢查規則、排法的格式、對應數學跟前端共用：`web/src/lib/ledTemplate.ts`。前端呼叫：`web/src/lib/ledTemplateApi.ts`。
資料表：`cf-worker/migrations/0034_led_templates.sql`（`led_templates`、`led_screens`、`led_template_screens`，加上 `songs.template_id`、`song_videos.template_id` / `template_snapshot`）。

所有網址前面是 `https://proxy.haimiaan.com`（`apiBase()`）。登入方式跟其他 API 一樣（`Authorization: Bearer <token>`）。
錯誤一律是 `{ "error": "中文說明", ...其他欄位 }`，`error` 可以直接顯示給使用者。

## 重點

- **「全部」版型**：每個專案一個（`kind: "full"`），就是現在的整張 LED 畫布（`projects.led_canvas`）。畫布大小跟著專案走，每塊螢幕的真實點數都從它算。不能改、不能刪、沒有放法。舊專案 migration 時補好，新專案和舊版後台建的專案第一次讀版型時補。
- **自訂版型**（`kind: "custom"`）：`canvas` = 這個版型的畫布（AE 要輸出的影片大小），`scalePct` = LED 真實點數縮成這個版型的比例（100 / 50 / 自訂），`screens` = 挑出來的螢幕放在畫布的哪裡。
- **螢幕**：整個 LED 物件一塊（`key: "o:<物件 id>"`，範圍從模型的 UV 外框算，後台不存）；或手動切的（`key: "s:<螢幕 id>"`，存在 `led_screens`，範圍是整張畫布的 UV 比例）。物件有手動切的螢幕時，整個物件那一塊就不能放了。
- **放法**：`dest` = 版型畫布上的長方形（像素，轉完以後的外框）、`rotate` = 順時針 0 / 90 / 180 / 270、`flipH` / `flipV` = 轉完再在長方形裡翻。重疊、超出畫布 API 都收（畫面上提醒）。沒放進版型的螢幕顯示黑的。
- **每首歌選一個版型**：`songs.template_id`（`GET …/songs` 回 `templateId`，沒選 = `null` = 整張畫布）。
- **影片版本記住版型**：新的一版記下 `templateId` 和當時的排法 `template`（快照）。之後版型改了、刪了，舊影片照舊貼對。沒有（舊版本、沒選版型）= 整張畫布。
- 沒填專案的 LED 畫布大小，不能建版型（409，`needsLedCanvas: true`）。

## 權限

| 動作 | 誰可以 |
|---|---|
| 看版型、手動切的螢幕、歌選了哪個、版本的版型 | 專案成員（製作 / 導演 / 動畫師）；分享連結的影片帶 `template` |
| 新增 / 修改 / 刪除版型、手動切的螢幕、改歌的版型 | 這個專案的製作（`editor`）。導演 / 動畫師 403 |

## 網址

### `GET /api/projects/:id/led-templates`

```json
{
  "fullCanvas": { "width": 8800, "height": 2024 },
  "templates": [
    { "id": "lt_full_p1", "kind": "full", "name": "全部", "canvas": { "width": 8800, "height": 2024 }, "scalePct": 100,
      "screens": [], "sortOrder": 0, "songCount": 0, "createdAt": "…", "updatedAt": "…", "v": 1 },
    { "id": "lt_x", "kind": "custom", "name": "中間底幕", "canvas": { "width": 4400, "height": 200 }, "scalePct": 50,
      "screens": [ { "key": "o:so_1", "objectId": "so_1", "uv": null,
                     "dest": { "x": 0, "y": 0, "w": 4400, "h": 200 }, "rotate": 0, "flipH": false, "flipV": false } ],
      "sortOrder": 1, "songCount": 2, "v": 1 }
  ],
  "screens": [ { "id": "ls_a", "objectId": "so_2", "name": "左半", "uv": [0, 0, 0.5, 1], "sortOrder": 1 } ]
}
```
`fullCanvas` 和「全部」的 `canvas` 在專案還沒填 LED 畫布時是 `null`。

### `POST /api/projects/:id/led-templates`（製作）

`{ "name": "中間底幕", "canvas": {"width":4400,"height":200}, "scalePct": 50, "screens": [ { "key": "o:so_1", "dest": {"x":0,"y":0,"w":4400,"h":200}, "rotate": 0, "flipH": false, "flipV": false } ] }` → 201 `{ template }`

- 名稱 1～40 字、同專案不重複（不分大小寫）、不能叫「全部」（400 / 409 `nameTaken`）
- 畫布寬高 16～32768 的整數；`scalePct` 1～400；一個版型最多 200 塊；一個專案最多 50 個版型
- 螢幕要真的存在（這個專案的 LED 物件，或手動切的螢幕）、同一塊只能放一次；`dest` 全部整數、寬高至少 1

### `PATCH /api/projects/:id/led-templates/:tid`（製作）

`name` / `canvas` / `scalePct` / `screens`（有給就整份換掉）。「全部」409。→ `{ template }`

### `DELETE /api/projects/:id/led-templates/:tid`（製作）

還有歌在用 → 409（`inUse`、`songCount`，說明裡列前幾首歌）。影片版本不擋（快照自己帶著排法）。

### `POST /api/projects/:id/led-screens`（製作）— 手動切的螢幕

`{ "objectId": "so_2", "name": "左半", "uv": [0,0,0.5,1] }`，或 `"rect": {"x":0,"y":0,"w":4400,"h":2024}`（整張畫布的像素，要先填 LED 畫布大小）。一個物件最多 8 塊、一個專案最多 200 塊。→ 201 `{ screen }`

`PATCH …/led-screens/:sid`（`name`、`uv`；不能換物件）、`DELETE …/led-screens/:sid`（版型裡放著它的那一格一起拿掉）。

### 歌選版型

`PATCH /api/projects/:id/songs/:sid` 帶 `{ "template_id": "lt_x" }`（或 `templateId`）；`null` / `""` / 「全部」的 id = 整張畫布。要是這個專案的版型，不然 400。只有製作（跟改歌名一樣）。

### 影片版本

- `POST …/songs/:sid/videos/uploads` 可以多帶 `"templateId"`：不帶 = 歌現在選的；帶 `null` = 整張畫布；帶不認識的 id = 當沒帶。貼連結 / Drive 同步的版本用歌那時選的。
- 版本 JSON 多 `templateId`（沒有 = `null`）和 `template`（快照，格式同上面 `templates[]` 的一項，沒有 `kind` / `songCount`；沒有 = `null`）。分享連結的影片 JSON 多 `template`。

## 同一首歌中途換版型（時間線，0039）

設計：`docs/superpowers/specs/2026-10-15-led-canvas-templates-design.md` 6d。資料表 `song_template_switches`（`cf-worker/migrations/0039_template_timeline.sql`）、`song_videos.template_timeline`。共用的檢查和格式：`web/src/lib/ledTemplateTimeline.ts`。

- **開頭的版型** = 歌選的版型（`songs.template_id` / `templateId`，舊的版型選單就是它）；**換版型的點** = `templateSwitches`（最多 12 個）。
- 一個點二選一：**Cue**（`cueId`，跟著 Cue 的影片時間走；Cue 的時間改了點跟著動；Cue 刪掉點一起刪）或**時間**（`atSec`，秒）。時間要大於 0（0 秒就是開頭）。只有這首歌的**正式** Cue（不是提案）、而且有影片時間的能用。
- **畫布大小要一樣**：開頭和所有換版型的版型，畫布寬高完全相同（影片只有一個大小）。不一樣 → 409 + 中文說明（寫出兩個版型各是多大）。時間線只能用自己排的版型（不能是「全部」）。

### `GET /api/projects/:id/songs`

每首歌多 `templateSwitches`（沒有 = `[]`）：

```json
"templateId": "lt_a",
"templateSwitches": [
  { "id": "tsw_x", "cueId": "c_4", "cueName": "Cue 4", "cueTimeSec": 83, "atSec": 83, "templateId": "lt_b" },
  { "id": "tsw_y", "cueId": null, "cueName": null, "cueTimeSec": null, "atSec": 130, "templateId": "lt_a" }
]
```
`cueTimeSec` 是 Cue 現在的影片時間（Cue 還沒有時間 = `null`，這個點先不生效）；`atSec` 是直接寫的時間（用 Cue 時是存檔那一刻 Cue 的時間，備用）。

### `PUT /api/projects/:id/songs/:sid/template-timeline`（製作）

整份換掉：`{ "start": "lt_a", "switches": [ { "cueId": "c_4", "templateId": "lt_b" }, { "atSec": 130, "templateId": "lt_a" } ] }` → `{ templateId, templateSwitches }`。`start` 是 `null` / 「全部」的 id 時不能有換版型的點。檢查：版型都存在、都是自己排的、畫布一樣大、Cue 有影片時間、時間大於 0、兩個點不能在同一個時間。錯誤一律 409 + `{ error, timeline: true }`（格式不對 400）。導演 / 動畫師 403。

### 護欄

- 還有歌在用的版型不能刪：開頭選了它**或**換版型換成它都算（`songCount` 同一首歌只算一次）。
- 改版型的畫布大小時，它如果在某首歌的時間線裡、改完會跟那首歌別的版型不一樣大 → 409（`inTimeline: true`）。
- 舊的 `PATCH …/songs/:sid` `{ template_id }` 換開頭：這首歌有換版型的點時，不能改成「全部」、不能換成畫布大小不同的版型（409 + 說明）。

### 影片版本

新的一版上傳那一刻（沒有明確指定別的版型時）把整條時間線記下來，版本 JSON 多 `templateTimeline`（沒有 = `null`）：

```json
{ "v": 1,
  "plans": { "lt_a": { "…": "版型 A 的排法" }, "lt_b": { "…": "版型 B 的排法" } },
  "segments": [ { "fromSec": 0, "templateId": "lt_a", "label": null },
                { "fromSec": 83, "templateId": "lt_b", "label": "Cue 4" } ] }
```
Cue 的時間在上傳那一刻就定下來，之後 Cue 或版型改了這一版不變。`template` / `templateId` 仍然是開頭的版型（舊版前端照舊看得到）。分享連結的影片 JSON 也多 `templateTimeline`。算不出時間的點（Cue 沒有時間）不進快照；全部都算不出就沒有時間線。

### 複製專案 / 匯出匯入

匯出檔多 `songTemplateSwitches`；複製、匯入時歌、Cue、版型的 id 換成新的（Cue 對不到的改成純時間）；舊的匯出檔沒有這個欄位 → 沒有換版型。

## 舊版相容

全部是加欄位 / 加網址：舊版前端不送 `template_id` / `templateId`、不認識新欄位，照常運作；舊版前端會把任何版本當整張畫布播。舊版後台沒有 `led-templates` 網址（404）→ 新版前端當作沒有版型。複製專案帶著版型、手動切的螢幕和每首歌的選擇；匯出檔多 `ledTemplates` / `ledTemplateScreens` / `ledScreens`（舊的匯出檔沒有 → 匯入時沒有版型）。
