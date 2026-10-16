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

## 第 3 階段（自己排版、排法存起來）

後台只多兩個網址，**沒有新的 migration**（用 0036 的 `recipe` 欄位）；都只有這個專案的製作（`editor`），導演、動畫師 403，沒登入 401。舊版前端不會呼叫它們。

- `GET /api/projects/:id/led-uv/layout` → `{ key, edit }`：`key` = 目前使用的模型版本，`edit` = 這個版本上次存的「製作填的東西」（沒有 = `null`）。
- `PUT /api/projects/:id/led-uv/layout`　body `{ "ifActive": "<key>" | null, "edit": { "v": 1, … } }`
  - `ifActive` 一定要附，跟現在使用的版本不一樣 → 409「模型已經被別人換過了，請重新分析」（`conflict: true`）。
  - `edit` 要是物件、`v` 是 1、<= 200 KB（413）；存進這個版本的 `recipe.edit`，`recipe` 其他部分留著（合起來 <= 256 KB）。這個版本還沒有紀錄就建一筆（畫布 = 現在的畫布）。成功 `{ ok: true, key }`。
  - 沒有模型 → 400。
- `edit` 的內容（前端格式，`web/src/lib/ledUv/editState.ts`）：`{ v: 1, selected: { <物件 id>: bool }, forms: { <螢幕片代號>: 點數表單 }, overrides: { <物件 id>: 'flat' | 'arc' }, gutter, arrangement: { v: 1, canvasMode: 'auto' | 'custom', canvas: {width,height}, items: [{ key, x, y, rotate, flipH, flipV }], groups: [[key, …], …] } | null }`。螢幕的寬高不存（永遠是 LED 規格算出來的）。
- `POST /led-uv/apply` 的 `recipe` 現在多一個 `edit`（同上格式），所以套用出來的新版本就帶著排法；換回舊版看到的是舊版自己的 `edit`；一般上傳（壓縮）沿用上一版的紀錄。沒帶 `edit` 的舊版前端照常套用（`GET` 回 `edit: null`）。

## 第 4 階段（曲面、舊影片更牢的保護、連續套用）

後台多一個 migration **`0037_model_uv_lineage.sql`**（只 `ALTER TABLE model_uv_layouts ADD COLUMN parent_key TEXT`，不改舊資料、不重建表、不刪表），網址沒有新增。

- `POST /led-uv/apply` 的 `legacy` 多一個選填的 `originalUv: [物件 id…]`（<= 200，要是這個專案的 LED 物件，不然 400）：這些物件**原本的 UV 這次存進新模型的第二組 UV（TEXCOORD_1）**，舊影片取色直接用它。會寫進「舊版面」的快照（`plan.originalUv`），沒帶（舊版前端）就沒有這個欄位；`screens` 可以是空的（原本的畫面橫跨畫布邊緣、放不進長方形的物件），只要 `screens` 或 `originalUv` 有東西就建「舊版面」。舊版前端只看 `screens`，照舊可用。
- 套用時新的一版記 `parent_key` = 套用當下使用中的版本。`POST /model/versions/activate` 換版本時沿著 `parent_key` 看「離開的版本 + 祖先」和「進去的版本 + 祖先」：只在離開那條線上的批次，影片還原成沒有版型（要 `template_id` 還是那個舊版面才還原，使用者自己換過的不動）；只在進去那條線上的批次，重新套上它的舊版面（要快照還是 NULL 才套）。兩條線都有的不動。連續套用 v0 → v1 → v2 再來回換，每一批影片都對。
- `DELETE /model/versions/:file`：紀錄一起刪，從它套用出來的版本改接到它的上一版。`PUT /model`（一般上傳）沿用上一版的紀錄時 `parent_key` 一起沿用。沒有 `parent_key` 的舊紀錄（第 4 階段以前套用的）行為跟以前一樣，只看自己這一筆。
- `recipe` 多 `uv1`（物件 id → `fresh` / `carried` / `blocked` / `none`），`edit` 多 `seams`（物件 id → 整圈圓柱接縫位置，度）；舊版前端不認識也不影響。
- 限制：套用中間那一版時才傳的影片，只在它的後代版本上有保護；換回更早的版本（例如 v0）時它沒有對得上的對應。
