# 後台做得到、網站畫面沒有入口的功能（2026-10-26 盤點）

目的：找出「後台早就能做，使用者在畫面上卻找不到按鈕」的功能（例：以前用戶頁沒有「改名」，但 `PATCH /api/users/:id` 早就收 `name`），挑對日常有用、又不放寬權限的補上入口。

怎麼查的：
1. `cf-worker/access.mjs` 的 `describeProjectRoute`（專案底下的每條路由、方法、要什麼角色）+ `worker.js` 的最上層路由（用戶、Show、模型庫、邀請、Drive、搜尋、通知、系統狀態…）。
2. `web/src` 裡每個打後台的函式（`lib/api.ts`、`videoApi.ts`、`cueLibraryApi.ts`、`ledTemplateApi.ts`、`ledUvApi.ts`、`mechanisms/mechanismApi.ts`、`reviewApi.ts`、`storageApi.ts`、`systemStatusApi.ts`）有沒有被畫面用到。網站所有後台呼叫都經過這幾支檔案，沒有畫面自己偷打的。
3. 每個 PATCH 路由接受哪些欄位，對照畫面給不給改。

欄位說明：「網站呼叫」= 有沒有對應的呼叫函式；「畫面入口」= 有沒有人按得到；「誰用」= 製作（全站製作或該專案的製作）/ 導演 / 動畫師 / 客戶（分享連結）。

## 一、專案底下的路由（`/api/projects/:id/...`）

| 路由 | 後台能做什麼 | 網站呼叫 | 畫面入口 | 誰用 |
|---|---|---|---|---|
| GET/PATCH/DELETE `/` | 讀專案、改專案欄位、封存 | 有 | 有（首頁卡片選單、編輯頁） | 製作 |
| PATCH `/` 的 `status` | 進行中 / 審查中 | 有（函式收 status） | 以前沒有，這次補（卡片選單「標成審查中」） | 全站製作 |
| `stage-props`、`camera-bookmarks` | 比例尺樂手器材、視角書籤 | 有 | 有 | 製作、導演 |
| `share-links` GET/POST/PATCH/DELETE | 分享連結 | 有 | 有（網址、留言、名稱、浮水印、禁下載、密碼、有效期、分享的歌都能改） | 製作、導演 |
| `stage-objects` 列 / 建 / 改 / 刪 / `seed-defaults` / `bulk` | 舞台物件 | 有 | 有 | 製作 |
| `model` 上傳 / `use-asset` / `versions` / `activate` / 刪舊版 | 模型檔與版本 | 有 | 有 | 製作 |
| `invites` 列 / 建 / 撤銷 | 邀請連結 | 有 | 有 | 製作 |
| `members` 列 / 改角色 / 移出、`member-candidates` | 專案成員 | 有 | 有 | 製作 |
| `activity` | 最近活動（最多 200 筆） | 有，但只讀 50 筆 | 看得到 50 筆；這次補「看更早的紀錄」 | 全部成員 |
| `comments/summary` | 每首歌留言數 | 有 | 有 | 全部成員 |
| `duplicate`、`restore`、`export`、`wrap-up` | 複製、還原、匯出、結束清影片 | 有 | 有 | 全站製作 |
| `mechanisms` 列 / 建 / 改 / 刪 / `reorder` / `batch` / `convert-cue-positions`、`mechanism-sheet`、`mechanism-groups` | 機關 | 有 | 有 | 製作（看 = 全部成員） |
| `led-templates` 列 / 建 / 改 / 刪 | LED 畫布版型 | 有 | 有 | 製作 |
| `led-screens` POST / DELETE | 手動切螢幕 | 有 | 有 | 製作 |
| `led-screens/:id` PATCH | 改螢幕名字、位置 | 沒有 | 沒有（只能刪掉重切） | 製作 |
| `led-uv` `apply` / `impact` / `layout` | 自動貼 UV | 有 | 有 | 製作 |
| `library-cues` 列 / 建 / 改 / 刪 / `look` / `states` / `usage` | Cue 庫 | 有（單筆 GET 沒用到） | 有 | 製作 |
| `cue-templates` 列 / 單筆 / 建；`/api/cue-templates/:id` DELETE | Cue 模板 | 有 | 有 | 製作 |
| `drive` `files` / `files/:id/assign` / `sync` / `sync-log` | Drive 檔案歸類與同步 | 有 | 有 | 製作（同步 = 全部成員） |
| `songs` 列 / 建 / `reorder` / 改 / 刪 | 歌曲 | 有 | 有 | 製作 |
| `songs/:id` GET 單筆 | 讀一首歌 | 沒有 | 沒有（列表已經有全部欄位，不需要） | 不用補 |
| `songs/:id/import-cues`、`template-timeline`、`cue-object-states`（看 / 清 / 復原） | 匯入 cue、換版型時間線、清 cue 位置 | 有 | 有 | 製作 |
| `songs/:id/reviews` | 審片紀錄 | 有 | 有 | 全部成員 |
| `songs/:id/mechanism-positions` | 每個 cue 的機關位置 | 有 | 有 | 全部成員 |
| `songs/:id/cues` 列 / 建 / `reorder` / `rearrange` / 改 / 刪 / `reset` | Cue | 有 | 有 | 製作 |
| `songs/:id/cues/:cueId` GET 單筆 | 讀一個 cue | 沒有 | 沒有（列表已經有，不需要） | 不用補 |
| `cues/:id` PATCH 的 `status`（master / proposal / alternate） | 舊的「提案」 | 函式收 status | 沒有（提案功能已淘汰：畫面註明「還沒有接受提案」） | 不補 |
| `cues/:id/states`、`mechanisms/:id`、`mechanism-positions` | 每個 cue 的物件 / 機關位置 | 有 | 有 | 製作 |
| `songs/:id/videos` 列 / 單筆 / 上傳（分段）/ 貼連結 / 取消 / 重試 / 刪 / `deleted` / `restore` / `duplicates` / `stream` | 影片版本 | 有 | 有 | 製作、動畫師、導演 |
| `songs/:id/videos/:videoId` PATCH（說明、標題、長寬秒數） | 改這一版的資料 | 有函式 `patchSongVideo`，但沒有任何畫面用 | 以前沒有；這次補「改說明」 | 製作、交這一版的動畫師、導演（自己貼連結交的） |

## 二、專案以外的路由

| 路由 | 後台能做什麼 | 網站呼叫 | 畫面入口 | 誰用 |
|---|---|---|---|---|
| `/api/auth/login` `logout` `me` `change-code` | 登入、登出、改自己的登入碼 | 有 | 有（設定頁） | 全部 |
| `/api/users` GET / POST | 列用戶、新增 | 有 | 有 | 全站製作 |
| `/api/users/:id` PATCH `name` `role` `deactivated` | 改名、角色、停用 | 有 | 有 | 全站製作 |
| `/api/users/:id` PATCH `avatarColor` | 換頭像顏色 | 有（函式收） | 以前只有「新增用戶」時能選；這次補「顏色」按鈕 | 全站製作 |
| `/api/auth/me` PATCH `name` `avatarColor` | 用戶改自己的名字、頭像顏色（只收這兩個，其他欄位不收） | 有（`updateMyProfile`） | 有（設定頁「我的帳號」、上方列頭像選單、窄畫面「⋯」：改名字、換顏色） | 每個登入的人（只能改自己） |
| `/api/users/:id` DELETE、`access-code`、`projects` POST / DELETE | 刪用戶、重設登入碼、指派專案 | 有 | 有 | 全站製作 |
| `/api/users/:id/projects` GET | 某人的專案 | 沒有 | 沒有（列用戶時已經一起給了） | 不用補 |
| `/api/shows` 列 / 單筆 / 建 / 刪 | Show | 有 | 有 | 全站製作（看 = 有專案在裡面的人） |
| `/api/shows/:id` PATCH `name` | 改名 | 有 | 有 | 全站製作 |
| `/api/shows/:id` PATCH `description` | 改說明 | 有 | 以前沒有（建立時能寫，之後改不了）；這次補 | 全站製作 |
| `/api/assets` 列 / 建 / `file` 上傳 / PATCH `name` `description` / DELETE | 共用模型庫 | 有 | 有 | 全站製作 |
| `/api/assets/:id` PATCH `deactivated` | 停用（就是「刪除」，會從清單消失） | 有（用刪除呼叫） | 有 | 全站製作 |
| `/api/assets/:id/file` 對已存在的模型再傳一次 | 蓋掉原檔 | 只在新增時用 | 沒有 | 不補（用到的專案會跟著變，要先想清楚規則） |
| `/api/assets/:id` GET 單筆 | 讀一個模型 | 沒有 | 沒有 | 不用補 |
| `/api/invites` GET | 所有專案的邀請 | 有 | 有（用戶頁） | 全站製作 |
| `/api/invites/peek` `redeem` | 打開邀請連結 | 有 | 有（邀請頁） | 被邀請的人 |
| `/api/projects` GET / POST、`projects/import`、`projects-archived` | 列、建、匯入、封存清單 | 有 | 有 | 製作 |
| `/api/search` | 全站搜尋 | 有 | 有（Ctrl+K） | 全部 |
| `/api/comments`、`comment-thumbs`、`comment-attachments` | 留言（含改文字、標已改好、重新打開）、縮圖、參考圖 | 有 | 有 | 全部 |
| `/api/notifications` 列 / `read` | 站內通知 | 有 | 有（鈴鐺） | 全部 |
| `/api/drive/oauth/start` `callback`、`accounts` GET / DELETE | Google 帳號連結 | 有 | 有（Drive 來源頁） | 全站製作 |
| `/api/drive/folders` | 列出 Drive 資料夾（挑資料夾用） | 有函式 `listDriveFolders`，沒有畫面用 | 沒有（現在是貼資料夾網址） | 全站製作；之後可以補 |
| `/api/drive/stream/:id` | 舊的 Drive 影片播放 | 有 | 有 | 全部成員 |
| `/api/admin/system-status` | 最近一份備份、最近 7 天畫面錯誤 | 有 | 有（設定頁） | 全站製作 |
| `/api/admin/backups` 列 | 全部備份清單（30 天每日 + 12 個月每月） | 沒有 | 以前沒有（畫面寫「共留著 N 份」卻只能下載最近一份）；這次補 | 全站製作 |
| `/api/admin/backups/:日期.sql.gz` | 下載一份備份 | 有 | 只能下載最近一份；這次連同清單一起補 | 全站製作 |
| `/api/admin/client-errors?days=30` | 畫面錯誤（最多 30 天、100 組） | 沒有 | 沒有（設定頁只列最近 7 天 20 組，已夠用） | 全站製作；之後可以補 |
| `/api/admin/storage`、`storage/rescan` | 空間用量、重新掃描 | 有 | 有 | 全站製作 |
| `/api/client-errors` POST | 畫面出錯自動回報 | 有 | 自動（不用畫面） | 系統 |
| `/downloads/…` | NDI 小程序下載 | 有 | 有（NDI 說明） | 動畫師、製作 |
| `/api/share/…`、`/api/s/…`（分享連結公開頁） | 客戶看片、留言 | 有 | 有 | 客戶 |
| `/r2/models/…`、`/r2/assets/…` | 模型檔下載 | 有 | 自動 | 全部成員 |

## 三、畫面有、後台 PATCH 也接受，但畫面沒給改的欄位

| PATCH | 後台接受的欄位 | 畫面有給改 | 畫面沒給改 |
|---|---|---|---|
| 專案 | name、description、status、show_id、tags、watermark_members、scale_correction、look_settings、material_overrides、home_view、led_canvas、drive_folder_id、drive_oauth_token_id、drive_filename_pattern | 全部，除了右邊兩個 | `status`（這次補）、`drive_filename_pattern`（Drive 檔名比對固定用歌曲代號規則，不給改，不補） |
| 歌曲 | name、order、status、animator_user_id、code、template_id、drive_folder_id | 前六個（順序走拖曳排序的 reorder） | `drive_folder_id`（每首歌自己的 Drive 資料夾，已被歌曲代號取代，不補） |
| Cue | name、order、position、rotation、fov、crossfadeSeconds、videoTimeSec、status | 前七個 | `status`（提案功能已淘汰，不補） |
| 舞台物件 | displayName、category、order、defaultPosition / Rotation / Scale、metadata、locked、defaultHidden、materialProps、ledProps | 除了 order、defaultScale、metadata | `order`（物件清單沒有拖曳排序，之後可以補）；`defaultScale` 模型縮放不能改（規則）；`metadata` 內部用 |
| Show | name、description | name | `description`（這次補） |
| 用戶 | name、role、avatarColor、deactivated | name、role、deactivated | `avatarColor`（這次補） |
| 共用模型 | name、description、deactivated | 全部 | 無 |
| 分享連結 | slug、allowComments、label、watermark、noDownload、password、expiresInDays（或 expiresAt）、songId | 全部（密碼、有效期、分享的歌是 10-26 後台新增的，面板有「改密碼」「拿掉密碼」「改有效期」「改分享的歌」） | 無 |
| LED 版型 | name、canvas、scalePct、cabinet、screens | 全部 | 無 |
| LED 螢幕 | name、uv | 沒有 | 兩個都沒有（只能刪掉重切），之後可以補 |
| Cue 庫的 cue | name、label、note、crossfadeSeconds | 全部 | 無 |
| 機關、機關群組 | 名稱、範圍、共用設定… | 全部 | 無 |
| 影片版本 | title、note、width、height、durationSec | 沒有 | `note`（這次補）；`title` 是檔名、長寬秒數是交的時候量好的，不補 |
| 留言 | text、status（已改好 / 重新打開）、resolvedVideoId、attachmentIds | 全部 | 無 |
| 專案成員 | role | 全部 | 無 |

## 四、這次補的入口（共 6 個，都是純畫面，沒有改後台、沒有放寬任何權限）

| # | 入口 | 在哪 | 做什麼 | 用的後台路由 | 誰看得到 |
|---|---|---|---|---|---|
| 1 | 「改說明 / 寫說明」 | 導演頁、動畫師工作站的版本列（選到的那一版旁邊，在「刪除」前面）；編輯頁的「影片版本」視窗每一版 | 事後補寫、改掉影片版本的一行說明（清空 = 拿掉）。動畫師常常交的時候忘了寫 | PATCH `songs/:id/videos/:videoId` `{ note }` | 跟「刪除」同一個條件：製作、交這一版的人；導演只有自己貼連結交的那一版 |
| 2 | 「看更早的紀錄」 | 「最近活動」抽屜最下面（導演頁、編輯頁） | 一次讀到後台的上限 200 筆；讀滿 200 筆會寫「只列出最近 200 筆」 | GET `activity?limit=200` | 這個專案的成員（跟原本抽屜一樣） |
| 3 | 「標成審查中 / 改回進行中」 | 首頁專案卡片的「更多動作」選單 | 切專案狀態，首頁上面「審查中」的篩選才有東西可篩 | PATCH `projects/:id` `{ status }` | 全站製作 |
| 4 | 「改說明 / 寫說明」 | Show 頁上方（「改名」旁邊） | 改 Show 的說明（最多 300 字，清空 = 拿掉） | PATCH `shows/:id` `{ description }` | 全站製作 |
| 5 | 「顏色」 | 用戶頁每個人的按鈕列，開一個選顏色的小視窗 | 換頭像顏色（6 個顏色，點一下就存好）；新增用戶和換顏色用同一組顏色 | PATCH `users/:id` `{ avatarColor }` | 全站製作 |
| 6 | 「看全部備份」 | 設定頁 → 系統狀態 → 資料庫備份下面 | 列出全部備份（30 天每日 + 每月第一份），每一份都能下載；以前只能下載最近一份 | GET `admin/backups`（下載照舊） | 全站製作 |

測試：`lib/textEdit.test.ts`、`lib/editVersionNote.test.ts`、`lib/editShowDescription.test.ts`、`lib/backendGapCalls.test.ts`、`test/backendEntrances.test.ts`（守門：畫面上的入口被拿掉會失敗）。

## 五、需要後台改才能做的（這次只列出來，沒有做）

（原本第 1、2 點「分享連結建好以後改密碼、有效期、換分享的歌」「用戶自己改自己的名字、頭像顏色」已經在 10-26 補完：後台新增 PATCH 欄位 / `PATCH /api/auth/me`，畫面接上，見第八節。）

3. 專案的製作（不是全站製作）改專案狀態：`status` 在 `PROJECT_GLOBAL_ADMIN_FIELDS` 裡，只有全站製作能改，所以第 3 個入口只在首頁（全站製作）出現。
4. 救回「已刪除」的共用模型：`listAssets` 只列沒停用的，沒有「已刪除的模型」清單和還原路由。
5. 備份「還原」按鈕：還原要手動匯入 SQL（`docs/backups.md`），後台沒有還原路由。

## 六、沒補的和原因

| 項目 | 原因 |
|---|---|
| Cue「提案」接受 / 狀態 | 功能已淘汰，畫面上有註明 |
| 歌曲 `drive_folder_id`、專案 `drive_filename_pattern` | 已被歌曲代號規則取代，開放自訂反而容易設錯 |
| `GET songs/:id`、`GET cues/:id`、`GET users/:id/projects`、`GET assets/:id`、`GET library-cues/:id` | 列表已經有同樣資料，單筆讀取沒有使用情境 |
| 舞台物件 `defaultScale` | 模型縮放不能改（專案規則：尺寸問題走測距校準） |
| 影片 `title`、長寬、秒數 | 檔名和影片資料交的時候自動量好，改了反而對不上 |
| `/api/client-errors` POST、`/r2/…`、`/downloads/…` | 系統自己用，不是給人按的 |
| 對已存在的共用模型「換檔案」（`PUT assets/:id/file`） | 正在用的專案會跟著變，要先決定規則再做 |

## 七、之後可以補（這次最多挑 6 個，這些先放著）

1. LED 手動切的螢幕「改名 / 微調位置」（PATCH `led-screens/:id`，現在只能刪掉重切）。
2. Drive 資料夾瀏覽器（GET `drive/folders`，現在要貼資料夾網址）。
3. 舞台物件清單拖曳排序（PATCH `stage-objects` 的 `order`）。
4. 系統狀態看更久的畫面錯誤（GET `admin/client-errors?days=30`，現在 7 天 20 組）。
5. 影片版本改標題（`title`，其實是檔名）。

## 八、後台跟著改的兩件事（2026-10-26，第五節的第 1、2 點）

### 分享連結建好以後可以改密碼、有效期、分享的歌

`PATCH /api/projects/:id/share-links/:token` 多收三組欄位（有給的才改；舊版前端不送，行為跟以前一樣）。權限跟原本的 PATCH 一樣（全站製作、這個專案的製作 / 導演；動畫師、別的專案的人不行；用別的專案的網址也改不到這條連結）。規則檔：`cf-worker/shareLinkEdit.mjs`。

| 欄位 | 值 | 做什麼 |
|---|---|---|
| `password` | 字串 / `null` | 字串 = 設新密碼（最多 60 字，跟建立時用同一個函式存成加鹽雜湊，舊的明文欄位一起清掉）；`null` = 拿掉密碼。空字串、其他型別不收（免得手滑清掉密碼） |
| `expiresInDays` | 正數 / `null` | 從現在起算幾天後過期（最多 365）；`null` = 不會過期。也可以改送 `expiresAt`（ISO 時間，要是未來）；兩種寫法不能一起給 |
| `songId` | 歌的 id / `null` | 只分享那一首（要是這個專案的歌，別的專案的歌 404）；`null` = 整個專案；空字串不收（等於一首都沒選） |

- **改密碼後舊的客戶要不要重輸**：要，而且不用另外做機制。客戶輸入密碼後拿到的「通行證」（8 小時）本來就簽在「這條連結目前的密碼雜湊」上（`sharePassword.mjs` 的 `shareCredential`）；換密碼 / 拿掉再設回同一個密碼，鹽都是新的，雜湊一定變，舊通行證馬上全部失效（含影片網址上的 `?access=`），客戶看到「通行證過期了，請重新輸入密碼」。拿掉密碼之後本來就不用密碼。
- **分享的範圍只有兩種**：整個專案，或單獨一首歌（資料表 `share_links.song_id` 一個欄位）。沒有「同時分享幾首但不是全部」；那要新增資料表、改訪客頁的每個範圍檢查，這次沒做。
- 畫面：公開分享連結面板每一條連結多一排「改密碼」「拿掉密碼」（有密碼才有）「改有效期」「改分享的歌」，用站內對話框選；存好提示「已更新」。
- 測試：`cf-worker/shareLinkEdit.test.mjs`、`web/src/lib/shareLinkEdit.test.ts`。

### 每個人可以改自己的名字、頭像顏色

`PATCH /api/auth/me`（跟 `GET /api/auth/me`、`POST /api/auth/change-code` 同一個位置），登入的人只能改「自己」：

- 只收 `name`、`avatarColor`；`role`、`email`、登入碼、停用…偷塞也不收、不理；兩個欄位都沒有 = 400。
- 名字規則 `web/src/lib/userProfileRules.ts`（前後台共用，新增用戶、全站製作改名、自己改名同一套）：前後空白去掉、最多 80 字、不能是空的。順便把全站製作改名的漏洞補了（以前能把名字改成空的）。
- 頭像顏色：後台只擋格式（`#rrggbb`），畫面給 `avatarColors.ts` 那 6 個。
- 畫面：設定頁「我的帳號」多「改名字」「換顏色」；專案首頁、導演頁、動畫師工作站、非製作的設定頁上方列，頭像 + 名字變成小選單（改名字、換顏色），窄畫面的「⋯」選單也有；製作左側欄點自己的名字會到設定頁。「用其他身分看」的時候不能在畫面上改被看的人的名字。
- 測試：`cf-worker/myProfile.test.mjs`、`web/src/lib/shareLinkEdit.test.ts`（守門：入口被拿掉會失敗）。
