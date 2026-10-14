# 機關 API（升降台、轉台、滑軌…）

設計：`docs/superpowers/specs/2026-10-14-mechanism-system-design.md`。
後台：`cf-worker/mechanisms.mjs`（`mechanisms.test.mjs` 有測，用 node:sqlite 跑真的 migration）；路由 / 權限在 `cf-worker/access.mjs`。
檢查規則跟前端共用：`web/src/lib/mechanisms/model.ts`。前端呼叫：`web/src/lib/mechanisms/mechanismApi.ts`。
資料表：`cf-worker/migrations/0023_mechanisms.sql`（`mechanisms`、`mechanism_objects`、`cue_mechanism_positions`）。

所有網址前面是 `https://proxy.haimiaan.com`（`apiBase()`）。登入方式跟其他 API 一樣（`Authorization: Bearer <token>`）。
錯誤一律是 `{ "error": "中文說明", ...其他欄位 }`，`error` 可以直接顯示給使用者。

## 重點

- **一個機關設定一次**：帶哪些物件、直線移動或旋轉、方向 / 轉軸、行程、最高速度、常用位置。
- **一個機關的位置是一個數字**，從物件在 cue 裡原本的位置算起：直線 = 公尺，旋轉 = 度。0 = cue 放的位置。模型縮放永遠不動；公尺 → 場景單位用專案的測距校準倍率。
- **每個 cue 存自己的位置**；沒存 = 沿用前面最近一個**正式 cue** 存的；前面都沒存 = 預設位置（規則在 `web/src/lib/mechanisms/track.ts`，每一頁都用同一份）。
- 存的值不會因為改行程被改掉；播放 / 畫面 / 總表用的值夾在行程內。
- **每個 cue 每個機關自己的時間**（v2，0027）：`delaySec` = GO 之後幾秒開始動、`durationSec` = 走幾秒（0 = 直接切換）；`null` = 跟著 cue（延遲 0、走 = 轉場）。跟著那個 cue 自己存的位置那一列，**不沿用**；回到沿用時一起清掉。規則：`docs/superpowers/specs/2026-10-15-mechanism-v2-design.md`。
- 機關可以裝在另一個機關上（`parentId`，例：轉台上的升降台），一層套一層最多 4 層。一個物件只能**直接**放在一個機關。
- 每個 cue 的位置不寫活動紀錄（拖滑桿不洗版）；機關的新增 / 修改 / 刪除 / 排序會寫。

## 權限

| 動作 | 誰可以 |
|---|---|
| 看機關、看每首歌每個 cue 的機關位置 | 專案成員（製作 / 導演 / 動畫師）；分享連結只看正式 cue |
| 新增 / 修改 / 刪除 / 排序機關、設定每個 cue 的位置、機關總表、轉換舊位置 | 這個專案的製作（`editor`）。導演 / 動畫師 403 |

封存的專案：只能看，寫入一律 409。

## 一個機關（`Mechanism`）

```jsonc
{
  "id": "mech_…",               // 從舊滑桿轉來的：mlx_<物件 id>（左右）/ mly_<物件 id>（上下）
  "name": "中央升降台",
  "kind": "linear",             // linear 直線移動 | rotary 旋轉
  "axis": { "x": 0, "y": 1, "z": 0 },   // 單位向量（場景座標，Y 朝上）：直線 = 數字變大往哪；旋轉 = 轉軸（右手定則）
  "pivot": null,                // 旋轉中心（場景單位）；直線 = null
  "travelMin": 0, "travelMax": 3.5,     // 行程（公尺 / 度）
  "defaultValue": 0,            // 沒有 cue 設定時的位置
  "maxSpeed": 0.25,             // 公尺/秒、度/秒；null = 不檢查，照轉場秒數移動
  "presets": [{ "name": "收起", "value": 0 }, { "name": "全開", "value": 3.5 }],  // 照數字排，最多 12 個
  "parentId": null,             // 裝在哪個機關上
  "objectIds": ["so_…", "so_…"],
  "consoleLabel": "Axis 3",     // 自動化控台上的軸名（選填）
  "order": 0,
  "metadata": null,             // 之後放加減速、碰撞外框
  "cueCount": 12,               // 幾個 cue 有自己設的位置
  "updatedAt": "2026-10-14 03:00:00"
}
```

## 網址

`:p` = 專案 id，`:s` = 歌 id，`:c` = cue id，`:m` = 機關 id。

| | 網址 | 送 | 回傳 |
|---|---|---|---|
| GET | `/api/projects/:p/mechanisms` | | `{ mechanisms: Mechanism[] }`（照順序） |
| POST | `/api/projects/:p/mechanisms` | 機關的欄位（不用 id / order / cueCount）+ `moveObjects?: true` | 201 `{ mechanism }` |
| POST | `/api/projects/:p/mechanisms/reorder` | `{ ids: string[] }` | `{ ok }` |
| PATCH | `/api/projects/:p/mechanisms/:m` | 要改的欄位 + `moveObjects?: true` | `{ mechanism, outOfRangeCount }`（有幾個 cue 存的值超出新的行程） |
| DELETE | `/api/projects/:p/mechanisms/:m` | | `{ ok, removedPositions }`（一起刪掉幾個 cue 的位置） |
| GET | `/api/projects/:p/songs/:s/mechanism-positions` | | `{ positions: [{ cueId, mechanismId, value, delaySec, durationSec, updatedAt }] }`（每個 cue **自己存的**；沿用的在前端算） |
| PUT | `/api/projects/:p/songs/:s/cues/:c/mechanisms/:m` | `{ value?, delaySec?, durationSec? }`（沒送的欄位不改；`null` = 跟著 cue；只送時間時這個 cue 要已經有自己的位置） | `{ ok, value, clamped, delaySec, durationSec }`（存的是夾進行程後的值） |
| DELETE | `/api/projects/:p/songs/:s/cues/:c/mechanisms/:m` | | `{ ok, removed }`（回到沿用上一個 cue） |
| GET | `/api/projects/:p/mechanism-sheet` | | `{ songs: [{ id, name, code, order, cues: [{ id, name, order, videoTimeSec, crossfadeSeconds }] }], positions, mechanisms }`（只有正式 cue；匯出機關總表一次拿完） |
| POST | `/api/projects/:p/mechanisms/:m/convert-cue-positions` | `{ dryRun?: true }` | `{ ok, converted, skipped: [{ cueId, name, reason }], positions, rowsChanged }`（見下面） |

分享連結（不用登入，只看）：

| | 網址 | 回傳 |
|---|---|---|
| GET | `/api/share/:token/data`、`/api/s/:slug/data` | 多一個 `mechanisms: Mechanism[]` |
| GET | `/api/share/:token/songs/:s/mechanism-positions`（`/api/s/:slug/…` 一樣） | `{ positions }`，只有正式 cue；連結限定某首歌時只能拿那首 |

### 錯誤

| 狀態 | 什麼時候 | `error` |
|---|---|---|
| 400 | 檢查沒過（還會帶 `field`：name / kind / axis / pivot / travel / maxSpeed / presets / objectIds / parentId） | 「機關名稱不能空白」「這個專案已經有叫「…」的機關」「機關類型不正確」「方向不正確」「轉軸中心要是數字」「行程的最高要比最低大」「行程要填數字」「最高速度要是正的數字，或留空不檢查」「常用位置最多 12 個」「常用位置的名稱重複了：「…」」「一個機關最多帶 200 個物件」「有物件不在這個專案裡」「不能選自己，或裝在自己上面的機關」「機關一層套一層最多 4 層」「找不到要裝上去的機關」 |
| 400 | PUT 每個 cue 的位置不是數字 | 「位置要是數字」 |
| 400 | PUT 的秒數不對（`field`：delaySec / durationSec） | 「延遲要是 0 到 3600 秒，或留空跟著 cue」「走幾秒要是 0 到 3600 秒，或留空跟著轉場」 |
| 400 | 只送時間，但這個 cue 還沒有自己的位置 | 「這個 cue 還沒有設定這個機關的位置，要一起送位置」 |
| 403 | 導演 / 動畫師改東西 | 「只有製作可以修改專案內容」 |
| 404 | 網址上的機關不在這個專案 | 「這個專案裡找不到這個機關」 |
| 409 | 要放的物件已經直接放在別的機關（還會帶 `conflicts: [{ objectId, objectName, mechanismId, mechanismName }]`）。畫面問「要把它移到「…」嗎？」，要移就再送一次帶 `moveObjects: true` | 「「LED-1」已經在「升降台」裡，一個物件只能直接放在一個機關」 |
| 409 | 轉換：這個機關已經有 cue 設了位置 | 「這個機關已經有 cue 設了位置，只有還沒在 cue 裡設過位置的機關可以轉」 |

## 把現有 cue 的位置轉成機關位置

以前升降台 / 轉台是一個 cue 一個 cue 手動擺高度、角度的，定義成機關後兩種動法會加在一起。這個按鈕把它們變成機關的位置：

- 每首歌照順序，每個 cue 量**第一個物件**離它的預設位置差多少（直線：沿著方向，公尺；旋轉：繞著轉軸，度）→ 這個 cue 的機關位置 = 預設位置 + 差多少，物件自己存的位置扣掉這一段。
- **轉完畫面一模一樣**（每個 cue、每個物件；有測）。沿用前面位置的物件需要的話會在那個 cue 補一筆。
- 同一個機關裡物件差得不一樣（超過 1 mm / 0.1°）的 cue 不轉；轉出來超出行程的也不轉 → `skipped` 列出來（`reason`：`inconsistent` / `range`）。
- 只有還沒有任何 cue 設過位置的機關可以轉。先用 `dryRun: true` 看會轉幾個，畫面再問要不要轉；要試的話可以先複製專案在副本上試。

## 跟其他功能

| 功能 | 機關 |
|---|---|
| 複製專案 | 機關（新 id、`parentId` 換成新的）、帶的物件、每個 cue 的位置都跟著；舊滑桿的數值也換成新物件的 id |
| 匯出 / 匯入專案 | 匯出檔多 `mechanisms`、`mechanismObjects`、`cueMechanismPositions`（資料庫原樣）；舊的匯出檔沒有 → 什麼都不做 |
| 新 cue「沿用」 | 複製來源 cue 自己存的機關位置和時間 |
| 新 cue「從目前 3D 畫面」 | `POST …/cues` 多送 `snapshotMechanisms: { [機關 id]: 值 }` → 存成新 cue 自己的值 |
| 存成常用擺位 / 套用 | 常用擺位多存 `mechanismPositions: [{ name, value, delaySec?, durationSec? }]`（時間有設才放），套用時**照機關名稱**對（別的專案有同名的機關也套得上），夾進行程 |
| 從別首歌匯入 cue | 同一個專案照機關 id；別的專案照機關名稱 |
| 重置 cue | 這個 cue 自己存的機關位置也清掉（回應多 `removedMechanismPositions`） |
| 清除所有物件（上傳新模型時） | 409 的 `willDelete` 多 `mechanismObjects`，說明多一句「也會清掉 N 個機關裡選的物件」；機關的設定和每個 cue 的位置留著 |
| 刪物件 / cue / 歌 / 專案 | 資料庫一起清（ON DELETE CASCADE） |

## 舊的「全專案機關滑桿」（`projects.mechanism_offsets`）

- 0023 把它轉成每片 LED 的機關（`mlx_` / `mly_` + 物件 id），預設位置 = 舊的位移、不填速度 → **畫面不變**。
- 已經清理（2026-10-14，新網站上線之後）：`PATCH /api/projects/:p` 帶 `mechanism_offsets` 或 `mechanismOffsets` → **400**「機關改版了，請重新整理頁面」，整個請求都不收（同一次帶的其他欄位也不改）；不再同步到機關。
- 欄位留著不刪（舊資料、0023 轉換的來源）。`GET /api/projects/:p` 和分享連結的資料照樣讀得到（只讀，給還沒重新整理的舊前端）；複製專案不再複製這個欄位（機關本身照樣複製）。
