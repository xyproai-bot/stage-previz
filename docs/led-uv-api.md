# 自動貼 UV API（migration 0036）

設計：`docs/superpowers/specs/2026-10-16-auto-uv-design.md`（0.2 寫第 1 階段實際做的）。程式：`cf-worker/modelUvLayouts.mjs`；前端：`web/src/lib/ledUvApi.ts`。
**舊版前端不用改**：沒帶新參數的 `PUT /model`、`POST /model/versions/activate` 跟以前一樣。

權限：下面兩個新網址只有這個專案的製作（`editor`）；導演、動畫師 403，沒登入 401。

## 流程

1. `PUT /api/projects/:id/model?hold=1`　body = 新的 .glb（`Content-Type: model/gltf-binary`）
   只放進 R2，**不**換成目前使用的版本、不動資料庫。回 `{ ok, key, url, held: true }`。（舊的後台不認識 `hold`，會直接換版本、回應沒有 `held`；前端先打 `GET /led-uv/impact`，404 = 後台太舊就不開始。）
2. 前端把它下載回來、比對 SHA-256、用網站的讀法再檢查。
3. `POST /api/projects/:id/led-uv/apply`　一個 D1 交易全部換好，要嘛全換、要嘛全不換。

## POST /led-uv/apply

```json
{
  "key": "models/<專案>/<時間>-<隨機>.glb",       // 第 1 步回的 key
  "ifActive": "models/…glb" | null,                // 分析時使用中的版本；現在不一樣 → 409「模型已經被別人換過了，請重新分析」
  "ledCanvas": { "width": 1752, "height": 1632 },   // 新的整張畫布（16~32768）
  "note": "自動貼 UV · 3 塊螢幕 · 1752×1632",       // 版本列上的說明，<= 80 字
  "recipe": { "v": 1, "…": "…" },                   // 選填，<= 256 KB，之後重新編輯用
  "legacy": { "canvas": {…套用前的畫布…}, "screens": [ { "key": "o:<物件 id>" | "s:<螢幕 id>" | "s:@<ref>", "dest": {x,y,w,h}, "rotate": 0|90|180|270, "flipH": false, "flipV": false } ] } | null,
  "pieceScreens": [ { "ref": "so_6#0", "objectId": "so_6", "name": "雙翼 1", "uv": [u0,v0,u1,v1] } ],
  "screenUpdates": [ { "id": "ls_…", "uv": [u0,v0,u1,v1] } ]
}
```

- `pieceScreens`：一個物件有好幾片分開的平面 → 每片建一個手動螢幕（一個物件最多 8 塊、專案最多 200 塊）。`legacy` 裡的 `s:@<ref>` 換成新螢幕的真 id。
- `screenUpdates`：原本就切過的手動螢幕，範圍跟著物件平移。
- `legacy`（有螢幕才會建）：建版型「舊版面」（名稱重複就「舊版面 2」…；版型數量要在上限內，不然 409），並把這個專案**所有 `template_snapshot` 是 NULL 的影片版本**寫上它的快照（`template_id`、`template_snapshot` = 跟版型 API 一樣的 plan，手動螢幕帶 `uv`）。已經有版型的影片、`songs.template_id` 都不動。
- 同一個交易裡：`projects.model_r2_key` / `led_canvas`、套用前那一版的紀錄（畫布，沒有才建）、新一版的紀錄（畫布、recipe、說明、舊版面 id / 排法、被改的影片 id）。
- 成功：`{ ok, key, url, ledCanvas, legacyTemplateId, legacyTemplateName, stampedVideos, pieceScreens: [{ ref, id }] }`。
- 錯誤：400（欄位不對、資料庫拒絕，訊息中文）、404（找不到模型檔 / LED 物件 / 螢幕）、409（`conflict: true` = 別人換過了；版型太多）、413（recipe 太大）。

## GET /led-uv/impact

`{ videoVersions, songsWithVideos, customTemplates, templateScreens, manualSplits }`：套用前告訴製作會動到什麼（沒有版型的舊影片版本數 = 會被「舊版面」保護的數量）。

## 模型版本

- `GET /model/versions` 每個版本多：`note`、`ledCanvas`、`hasLayout`（有 recipe）、`autoUv`。沒有紀錄的版本是 `null / null / false / false`。
- `POST /model/versions/activate`（和 `POST /model/use-asset`）：回應多 `restoredCanvas`、`ledCanvas`。這個版本有紀錄 → 同一個交易把 `projects.led_canvas` 換成它的畫布；離開套用過自動貼 UV 的版本 → 當初被改成用「舊版面」的影片還原成 NULL，換回去再重新套上。離開之前會把現在的畫布記在離開的那個版本上（製作手動改過畫布不會丟）。沒有紀錄的版本：畫布不動。
- `PUT /model`（一般上傳，例如「壓縮這個模型」）：上一版有紀錄 → 新的這版沿用（畫布、舊版面、哪些影片）。
- `DELETE /model/versions/:file`：紀錄一起刪。

## 資料表

`model_uv_layouts (project_id, model_key, led_canvas, recipe, note, legacy_template_id, legacy_plan, stamped_videos, created_by, created_at)`，主鍵 `(project_id, model_key)`，專案刪掉時跟著刪。

## 第 2 階段（弧面、3D 預覽）

後台**沒有改**（沒有新的 migration、網址、欄位）。弧面也走上面同一套「放進 R2 → 一次換好」。`recipe`（選填，<= 256 KB）多了每個物件的 `override`（`auto` / `flat` / `arc`）和每片螢幕的 `surface`（`flat` / `arc`）、`convex`、`spanDeg`、`distortion`，舊版前端不認識也不影響。
