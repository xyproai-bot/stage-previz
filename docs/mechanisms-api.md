# 機關 API（升降台、轉台、滑軌…）

設計：`docs/superpowers/specs/2026-10-14-mechanism-system-design.md`。
後台：`cf-worker/mechanisms.mjs`（`mechanisms.test.mjs` 有測，用 node:sqlite 跑真的 migration）；路由 / 權限在 `cf-worker/access.mjs`。
檢查規則跟前端共用：`web/src/lib/mechanisms/model.ts`。前端呼叫：`web/src/lib/mechanisms/mechanismApi.ts`。
資料表：`cf-worker/migrations/0023_mechanisms.sql`（`mechanisms`、`mechanism_objects`、`cue_mechanism_positions`）。

> 2026-10-15 製作決定：這是預覽工具，機關的速度提醒（太快 / 來不及 / 會晚到）全部拿掉，機關一律照每個 cue 設的時間動。後台本來就沒有速度檢查，API 不變：`maxSpeed` / `max_speed` 欄位還在（舊資料和舊版前端照常讀寫），只是畫面不再設定、預覽不看它。

所有網址前面是 `https://proxy.haimiaan.com`（`apiBase()`）。登入方式跟其他 API 一樣（`Authorization: Bearer <token>`）。
錯誤一律是 `{ "error": "中文說明", ...其他欄位 }`，`error` 可以直接顯示給使用者。

## 重點

- **一個機關設定一次**：帶哪些物件、直線移動或旋轉、方向 / 轉軸、行程、常用位置。
- **一個機關的位置是一個數字**，從物件在 cue 裡原本的位置算起：直線 = 公尺，旋轉 = 度。0 = cue 放的位置。模型縮放永遠不動；公尺 → 場景單位用專案的測距校準倍率。
- **每個 cue 存自己的位置**；沒存 = 沿用前面最近一個**正式 cue** 存的；前面都沒存 = 預設位置（規則在 `web/src/lib/mechanisms/track.ts`，每一頁都用同一份）。
- 存的值不會因為改行程被改掉；播放 / 畫面 / 總表用的值夾在行程內。
- **每個 cue 每個機關自己的時間**（v2，0027）：`delaySec` = GO 之後幾秒開始動、`durationSec` = 走幾秒（0 = 直接切換）；`null` = 跟著 cue（延遲 0、走 = 轉場）。跟著那個 cue 自己存的位置那一列，**不沿用**；回到沿用時一起清掉。規則：`docs/superpowers/specs/2026-10-15-mechanism-v2-design.md`。
- **對開和翻轉**（v2 第 2 階段，0030）：對開 = 兩邊用同一個數字往反方向動（`variant: "split"`）；翻轉 = 旋轉機關沿著物件的某個邊緣翻（轉軸和轉軸中心已經算好存在 `axis` / `pivot`，選的邊緣記在 `metadata.setup`）。見下面「對開和翻轉」。
- **一排機關和動作花樣**（v2 第 3 階段，0031）：一次建立 N 個機關放進同一排（`mechanism_groups`，機關的 `groupId` / `groupIndex`）；花樣（一起 / 依序 / 波浪 / 漸層）在前端算好，用「一次寫很多個 cue 位置」存成一列一列普通的位置。見下面「一排機關」。
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
  "maxSpeed": 0.25,             // 公尺/秒、度/秒；舊欄位，畫面不再設定、預覽不看它（機關一律照每個 cue 設的時間動）
  "presets": [{ "name": "收起", "value": 0 }, { "name": "全開", "value": 3.5 }],  // 照數字排，最多 12 個
  "parentId": null,             // 裝在哪個機關上
  "objectIds": ["so_…", "so_…"],
  "consoleLabel": "Axis 3",     // 自動化控台上的軸名（選填）
  "order": 0,
  "metadata": null,             // 之後放加減速、碰撞外框；翻轉記 { "setup": { "hinge": "top", "positive": "first" } }
  "cueCount": 12,               // 幾個 cue 有自己設的位置
  "updatedAt": "2026-10-14 03:00:00",
  "variant": null,              // v2：null 一般 | "split" 對開
  "mirror": null,               // 只有對開：B 邊 { axis, pivot（旋轉才有）, consoleLabel }
  "objectSides": {},            // 只有對開：{ [物件 id]: "a" | "b" }（沒寫 = A 邊）
  "groupId": null,              // v2 第 3 階段：屬於哪一排（沒有 = null）
  "groupIndex": null,           // 這一排裡的第幾個（0 起算）
  "rigId": null,                // v2 第 4 階段（0032）：只有吊點（variant = "hoist"）：屬於哪一組吊掛
  "rigIndex": null,             // 第幾個吊點（0 起算）
  "attach": null                // 吊點在物件上的位置 { x, y, z }（場景單位，cue 位置的座標）
}
```

### 對開和翻轉（`variant`、`mirror`、`objectSides`、`metadata.setup`）

- **對開**：`variant: "split"`。A 邊就是機關本來的 `axis` / `pivot` / `consoleLabel`；B 邊用 `mirror`（`axis`、`pivot`、`consoleLabel`）。兩邊**同一個位置**（一個數字），所以每個 cue 的位置、延遲、走幾秒、檢查都只有一份。`objectSides` 說每個帶動的物件在 A 邊還是 B 邊。
  - 直線沒給 `mirror` → 後台補反方向；旋轉一定要給 `mirror.axis` 和 `mirror.pivot`（不然 400，`field: "mirror"`）。畫面用 `mirrorForSplit`（`model.ts`）算：直線 B 方向 = −A 方向；旋轉 n = A 邊中心 → B 邊中心的方向，B 轉軸 = −reflect(A 轉軸, n)，B 轉軸中心 = B 邊中心 + reflect(A 轉軸中心 − A 邊中心, n)（左右對稱時 n = normalize(B 轉軸中心 − A 轉軸中心)）。
  - 對開的機關**不能當別的機關的上層**（`parentId` 指到它 → 400「對開的機關不能當別的機關的上層」；有機關裝在它上面時不能改成對開）；它自己可以裝在別的機關上。
  - 改回一般機關：`PATCH { "variant": null }` → `mirror` 和每個物件的邊都清掉。換邊：`PATCH { "objectSides": {...} }`。只改名字、行程這類不會動到邊。
  - 對開不能用「轉換 cue 位置」（400「對開的機關不能轉換 cue 位置（兩邊的物件動法不一樣）」）。
- **翻轉**：`kind: "rotary"`，`axis` / `pivot` 由畫面從帶動物件的外框算好（`hingeFromBox`，`flip.ts`）；`metadata.setup = { hinge: "top" | "bottom" | "left" | "right" | "front" | "back", positive: "first" | "second" }` 只是讓編輯時看得到原本的選擇（後台不看它、舊版前端也照樣存回來）。
- **舊版前端相容**：讀機關和位置的網址要帶 `?mech=N`（新版畫面一律帶；`GET …/mechanisms`、`…/mechanism-sheet`、`…/songs/:s/mechanism-positions`、分享連結的 `…/data` 和 `…/mechanism-positions`）。**沒帶（最舊的前端）→ 後台只給一般機關（`variant` 是空的）和它們的位置**；`?mech=2`（第 2、3 階段的畫面，看得懂對開）→ 一般 + 對開；`?mech=3`（第 4 階段，看得懂吊掛）→ 全部。看不懂的 variant 後台不給，它們的零件在舊畫面是靜止的，不會往錯的方向動；翻轉是普通的旋轉機關，舊版照樣看得到、會動。新增 / 修改的回應一律給完整的。

### 吊掛（`variant: "hoist_rig"` / `"hoist"`、`rigId`、`rigIndex`、`attach`）

- 一組吊掛 = 一個**整組**（`variant: "hoist_rig"`，帶動物件，自己沒有位置；`kind` 固定 `linear`、行程 0~1 只是湊數）+ **2 ~ 4 個吊點**（`variant: "hoist"`，往上的直線，有自己的行程、最高速度、控台編號、每個 cue 的位置和延遲；沒有物件、不裝在別的機關上）。整組可以裝在別的機關上（轉台），但整組和吊點都不能當別的機關的上層（400「吊掛的機關不能當別的機關的上層」）。
- 吊點的值 h = 這個吊點被拉高幾公尺（0 = cue 裡原本的位置）；`attach` = 吊點在物件上的位置（場景單位）。物件是硬的，畫面照 h 算姿勢（`web/src/lib/mechanisms/hoist.ts`）：2 個吊點沿著兩點的連線轉到高度差剛好等於 h₂ − h₁（轉不到 → 斜到垂直為止並提醒）；3 個吊點用最小的轉動把吊點平面轉到通過三個目標點的平面；4 個吊點用最小平方法找平面（四點不共面 → 提醒）。吊點的重心升高 h 的平均，永遠沒有繞垂直軸轉。
- 新增：`POST …/mechanisms` body `{ variant: "hoist_rig", name, objectIds, parentId?, hoists: [{ name?, attach, travelMin?, travelMax?, maxSpeed?, consoleLabel?, defaultValue?, presets? }], moveObjects? }`，一個交易建好整組和吊點（吊點沒給名字 = 「整組名稱 吊點 N」，行程預設 0 ~ 5 m）→ 201 `{ mechanism（整組）, hoists }`。物件已經在別的機關 → 409，問過後帶 `moveObjects: true`。吊點不能單獨新增（400「吊掛要用「新增吊掛」建立…」）。
- 檢查（400，`field`）：吊點要 2 到 4 個（`hoists`）、要有物件（`objectIds`）、兩個吊點不能在同一個位置 / 三個以上不能排一直線（`attach`，水平位置要分開）、位置要填 X、Y、Z 三個數字（`attach`）、行程（`travel`）、名稱不能重複（`name`）。
- 修改整組：`PATCH …/mechanisms/:rig` body `{ name?, objectIds?, parentId?, metadata?, hoists? }`；`hoists` 有送 = 整個換成這份清單：有 `id` 的改那個吊點、沒有 `id` 的新增、原本有卻沒列出來的刪掉（連同每個 cue 的位置）→ `{ mechanism, hoists, outOfRangeCount }`。
- 修改單一吊點：`PATCH …/mechanisms/:hoist` 只能改名稱、行程、預設位置、最高速度、常用位置、控台編號；`attach`、`rigId`、`variant`、物件、方向都鎖住（送了也不動）。吊點不能單獨刪（400「吊掛至少要有 2 個吊點…」）；刪整組 `DELETE …/mechanisms/:rig` 連吊點和它們每個 cue 的位置一起刪（`removedPositions`）。一般機關不能改成吊掛、吊掛也不能改回一般（400）。
- 位置：吊點跟普通機關一樣用 `PUT …/cues/:c/mechanisms/:hoist` 和一次寫很多個；**整組沒有自己的位置**（400「這是整組吊掛，沒有自己的位置，請設定它的每個吊點」，一次寫很多個時整批不動）。吊掛不能用「轉換 cue 位置」。
- 舊版前端相容：正式站上還在跑的前端讀機關帶 `?mech=2`（或沒帶）→ 整組和吊點、它們的位置都不給，物件在舊畫面是靜止的；它存別的機關、排序、沿用 cue 都不會動到吊掛（沿用 cue 時吊點的位置和延遲照樣複製）。複製專案 / 匯出匯入帶著整組和吊點（新 id、吊點接回新的整組；吊點不到 2 個或位置不合的整組連同吊點略過；舊的匯出檔沒有這些欄位 → 都是一般機關）。

### 一排機關（`mechanism_groups`、`groupId`、`groupIndex`）

- 一排裡的每個機關都是**普通機關**（`variant` 是 null）：自己的物件、方向、行程、速度、控台編號、每個 cue 一列位置。「一排」只是把它們放在一起（名字、順序）。
- 一排的長相：`{ id, name, order, settings: { namePrefix?, numbering? } | null, updatedAt }`。`numbering`：`leftToRight` / `rightToLeft` / `frontToBack` / `selection`，只是建立時選的，編輯時看得到。成員 = `groupId` 指到這一排的機關，照 `groupIndex` 排。
- 讀：`GET …/mechanisms?mech=2` 的回應多 `groups: MechanismGroup[]`（沒帶 `?mech=2` 的舊版前端回應跟以前一模一樣，沒有 `groups`；`groupId` / `groupIndex` 是多出來的欄位，舊版前端不認得就忽略）。
- 一次建立：`POST …/mechanisms/batch`，一個物件一個機關，名稱「{namePrefix} {編號}」，同一個交易建好；物件已經在別的機關 → 409，問過後帶 `moveObjects: true` 再送（整批一起移）。
  - `base`：每個機關共用的設定（`kind`、`axis`、`pivot`、`travelMin` / `travelMax`、`defaultValue`、`maxSpeed`、`presets`、`parentId`、`metadata`…），規則跟單獨新增一樣；不能是對開。
  - `objectIds`：2 ~ 64 個，**照這個順序編 1、2、3…**（畫面已經照「編號順序」排好）。`namePrefix`：名稱開頭；`groupName`：這一排的名字（沒給 = 名稱開頭）；`numbering`：建立時選的編號順序。
  - `overrides`：`{ [物件 id]: { axis?, pivot? } }`，沿著邊緣翻的轉軸要照每個物件自己的外框算。
- 改一排：`PATCH …/mechanism-groups/:g`，`name` 是這一排的名字；`travelMin` / `travelMax` / `defaultValue` / `maxSpeed` / `presets` 是**共用設定**，這一排每個機關都改成一樣（每個都用單獨修改的規則檢查，錯了整批不改）。成員的名字不會跟著排名改。回 `{ group, mechanisms, outOfRangeCount }`。
- 解散 / 刪除：`DELETE …/mechanism-groups/:g?dissolve=1` 只解散這一排（機關都留著，位置和時間不動）→ `{ ok, dissolved, mechanisms }`；不帶 `dissolve` = 這一排和裡面的機關一起刪掉（連每個 cue 的位置）→ `{ ok, removedMechanisms, removedPositions }`。一排裡最後一個機關被刪掉（含舊版前端刪）→ 這一排也自動刪掉，不留空殼。
- 一次寫很多個 cue 位置（套用花樣、復原花樣）：`PUT …/songs/:s/cues/:c/mechanism-positions`，`{ items: [{ mechanismId, value, delaySec?, durationSec? }] }`（1 ~ 200 列，同一個機關只能一列，機關都要在這個專案裡）。**一個交易**：要嘛全寫、要嘛都不動。`value` 是數字 → 存位置（夾進各自的行程）；`value` 是 `null` → 刪掉這個 cue 自己的那一列（回到沿用，時間一起清掉）；`delaySec` / `durationSec` 沒放 = 不改、`null` = 跟著 cue、數字 = 設定（跟單獨寫一樣）。回 `{ ok, items: [{ mechanismId, value, clamped, delaySec, durationSec } | { mechanismId, removed: true }] }`。跟單獨寫一樣不寫活動紀錄。
- 舊版前端相容：一排裡就是一個一個普通機關，舊版讀、存（只送它認得的欄位）、排序、刪除都不會動到 `groupId` / `groupIndex` 或弄壞這一排；它不認得延遲（跟以前一樣）。複製專案 / 匯出匯入帶著一排（匯出檔多 `mechanismGroups`，機關列上的 `group_id` / `group_index` 指過去；匯入給新 id；舊的匯出檔沒有 → 都是一般機關）。

## 網址

`:p` = 專案 id，`:s` = 歌 id，`:c` = cue id，`:m` = 機關 id，`:g` = 一排的 id。

| | 網址 | 送 | 回傳 |
|---|---|---|---|
| GET | `/api/projects/:p/mechanisms?mech=3` | | `{ mechanisms: Mechanism[], groups: MechanismGroup[] }`（照順序；`?mech=3` 才含吊掛，`?mech=2` 含對開不含吊掛，沒帶只有一般機關也沒有 `groups`） |
| POST | `/api/projects/:p/mechanisms/batch` | `{ base, objectIds, namePrefix, groupName?, numbering?, overrides?, moveObjects? }` | 201 `{ group, mechanisms }`（一次建立 N 個，見「一排機關」） |
| PATCH | `/api/projects/:p/mechanism-groups/:g` | `{ name?, travelMin?, travelMax?, defaultValue?, maxSpeed?, presets? }` | `{ group, mechanisms, outOfRangeCount }`（共用設定套到每個成員） |
| DELETE | `/api/projects/:p/mechanism-groups/:g[?dissolve=1]` | | 解散 `{ ok, dissolved, mechanisms }`；刪除 `{ ok, removedMechanisms, removedPositions }` |
| PUT | `/api/projects/:p/songs/:s/cues/:c/mechanism-positions` | `{ items: [{ mechanismId, value, delaySec?, durationSec? }] }`（1 ~ 200 列） | `{ ok, items }`（一個交易；`value: null` = 回到沿用） |
| POST | `/api/projects/:p/mechanisms` | 機關的欄位（不用 id / order / cueCount）+ `moveObjects?: true`；整組吊掛：`variant: "hoist_rig"` + `hoists` | 201 `{ mechanism }`（吊掛多 `hoists`） |
| POST | `/api/projects/:p/mechanisms/reorder` | `{ ids: string[] }` | `{ ok }` |
| PATCH | `/api/projects/:p/mechanisms/:m` | 要改的欄位 + `moveObjects?: true`；整組吊掛可以帶 `hoists` | `{ mechanism, outOfRangeCount }`（有幾個 cue 存的值超出新的行程；吊掛多 `hoists`） |
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
| 400 | 檢查沒過（還會帶 `field`：name / kind / variant / axis / pivot / mirror / travel / maxSpeed / presets / objectIds / parentId） | 「機關名稱不能空白」「這個專案已經有叫「…」的機關」「機關類型不正確」「方向不正確」「轉軸中心要是數字」「行程的最高要比最低大」「行程要填數字」「最高速度要是正的數字，或留空不檢查」「常用位置最多 12 個」「常用位置的名稱重複了：「…」」「一個機關最多帶 200 個物件」「有物件不在這個專案裡」「不能選自己，或裝在自己上面的機關」「機關一層套一層最多 4 層」「找不到要裝上去的機關」「機關的變化類型不正確」「對開的 B 邊方向不正確」「對開的 B 邊轉軸中心要是數字」「對開的機關不能當別的機關的上層」「有機關裝在它上面，不能改成對開」 |
| 400 | 一排：一次建立 / 改一排（`field`：objectIds / namePrefix / groupName / variant，還有上面單獨新增的欄位） | 「一排至少要 2 個機關，請多選幾個物件」「一次最多建立 64 個機關」「名稱開頭太長了（最多 N 個字，後面還要接編號）」「這個專案已經有叫「…」的一排機關」「這一排的名字不能空白」「這一排的名字最多 40 個字」「一次建立的機關不能是對開，請一個一個設定」 |
| 400 | 吊掛（`field`：hoists / objectIds / attach / travel / name / variant / value） | 「吊掛要有 2 到 4 個吊點」「吊掛要先選好帶動的物件」「吊點的位置要填 X、Y、Z 三個數字」「兩個吊點不能在同一個位置，請把它們分開」「三個以上的吊點不能排成一直線，請把其中一個移開」「吊掛至少要有 2 個吊點，要減少吊點請編輯整組吊掛；要整組刪掉請刪除吊掛」「這是整組吊掛，沒有自己的位置，請設定它的每個吊點」「吊掛要用「新增吊掛」建立，不能把一般機關改成吊掛，也不能把吊掛改回一般機關」「吊掛的機關不能轉換 cue 位置」 |
| 400 | 一次寫很多個位置（`field`：items / value / delaySec / durationSec） | 「一次最多設定 200 個機關的位置」「每一列都要有機關和位置」「同一個機關在這一次只能出現一次」「有機關不在這個專案裡」 |
| 400 | PUT 每個 cue 的位置不是數字 | 「位置要是數字」 |
| 400 | PUT 的秒數不對（`field`：delaySec / durationSec） | 「延遲要是 0 到 3600 秒，或留空跟著 cue」「走幾秒要是 0 到 3600 秒，或留空跟著轉場」 |
| 400 | 只送時間，但這個 cue 還沒有自己的位置 | 「這個 cue 還沒有設定這個機關的位置，要一起送位置」 |
| 403 | 導演 / 動畫師改東西 | 「只有製作可以修改專案內容」 |
| 404 | 網址上的機關不在這個專案 | 「這個專案裡找不到這個機關」 |
| 404 | 網址上的一排不在這個專案 | 「這個專案裡找不到這一排機關」 |
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
| 複製專案 | 機關（新 id、`parentId` 換成新的）、一排（新 id）、帶的物件、每個 cue 的位置都跟著；舊滑桿的數值也換成新物件的 id |
| 匯出 / 匯入專案 | 匯出檔多 `mechanisms`、`mechanismObjects`、`cueMechanismPositions`（資料庫原樣，含對開的 `variant`、`mirror`、`side`）；舊的匯出檔沒有 → 什麼都不做（沒有 variant / mirror / side 的當一般機關） |
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
