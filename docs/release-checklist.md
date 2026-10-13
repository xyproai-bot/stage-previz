# 上線檢查清單

正式站（previz.haimiaan.com）換成新版前端那天要做的事。照順序做，每一步做完再做下一步。

---

## 登入碼換成雜湊（只顯示一次）

### 為什麼要等到這天

現在資料庫裡的登入碼是明文，舊版前端（0d6df54）的用戶頁會直接顯示每個人的登入碼。
換成雜湊之後，後台就再也拿不到明文，舊版用戶頁會變成「沒有號碼」。
所以要等正式站換成新版前端（新版用戶頁看得懂兩種情況）之後才換。

換完之後：

- 每個人原本的登入碼照樣能用（雜湊是用同一組登入碼算的）
- 登入碼一律由系統產生（10 個字，沒有 0 / O / 1 / I），只在建立、重設時顯示一次
- 用戶頁寫「登入碼只在建立時顯示，忘記了請按重設」
- 不能再自訂登入碼

做法是一個開關：資料庫 `app_settings` 表裡 `login_code_storage = 'hashed'`。後台每次都看這個開關，不用重新部署。
程式在 `cf-worker/loginCodes.mjs`，換的 SQL 由 `cf-worker/scripts/hash-login-codes.mjs` 產生。

### 開始前確認

1. 正式站已經是新版前端：用戶頁右上角有「邀請連結」按鈕。
2. 正式的 worker 是含 `loginCodes.mjs` 的版本（feat/live-stage-look 2026-10-14 之後的版本）。
3. 0022 migration 已經在正式資料庫上（在 `cf-worker/` 底下跑）：

   ```
   npx wrangler d1 migrations list stage-previz-db --remote
   ```

   列表裡不能有 `0022_invites_login_code_hash.sql`（有的話代表還沒套用，先停下來）。
4. 換的這段時間不要在用戶頁新增用戶或重設登入碼。

### 步驟（在 `cf-worker/` 底下跑，PowerShell 或 Git Bash 都可以）

1. 備份整個資料庫（檔名換成當天日期）：

   ```
   npx wrangler d1 export stage-previz-db --remote --output C:\Users\phang\AppData\Local\Temp\stage-previz-backup\stage-previz-db-2026-MM-DD-before-login-hash.sql
   ```

2. 匯出目前的登入碼（這個檔有明文登入碼，最後要刪掉）：

   ```
   npx wrangler d1 execute stage-previz-db --remote --json --command "SELECT id, name, access_code FROM users WHERE access_code IS NOT NULL" > login-codes.json
   ```

3. 產生要執行的 SQL：

   ```
   node scripts/hash-login-codes.mjs login-codes.json hash-login-codes.sql
   ```

   螢幕上只會印人數和名字，不會印登入碼：
   - 「會換成雜湊：N 人」：N 應該等於有登入碼的人數
   - 「登入碼跟別人重複，沒有換」：這幾個人換完後請在用戶頁幫他們按「重設」
   - 「登入碼比較弱」：舊的自訂號碼或少於 8 個字，照樣能用，建議之後幫他們按「重設」，或直接傳邀請連結

4. 執行：

   ```
   npx wrangler d1 execute stage-previz-db --remote --file hash-login-codes.sql
   ```

### 確認

1. 開關打開了（要看到 `hashed`）：

   ```
   npx wrangler d1 execute stage-previz-db --remote --command "SELECT value FROM app_settings WHERE key = 'login_code_storage'"
   ```

2. 明文都清掉了（要是 0），雜湊的人數等於第 3 步的 N：

   ```
   npx wrangler d1 execute stage-previz-db --remote --command "SELECT COUNT(*) AS plain_left FROM users WHERE access_code IS NOT NULL"
   npx wrangler d1 execute stage-previz-db --remote --command "SELECT COUNT(*) AS hashed FROM users WHERE access_code_hash IS NOT NULL"
   ```

3. 開一個無痕視窗，用你自己的登入碼登入正式站。
4. 用戶頁：每個人的登入碼那一格寫「登入碼只在建立時顯示，忘記了請按重設」。
5. 找一個測試用的帳號按「重設」：會跳出只顯示一次的登入碼，用新的登入碼可以登入，舊的不行。

全部沒問題之後，刪掉 `login-codes.json` 和 `hash-login-codes.sql`。

### 萬一要退回

登入出問題、要先回到明文的話（`login-codes.json` 還沒刪才能退）：

```
node scripts/hash-login-codes.mjs --revert login-codes.json revert-login-codes.sql
npx wrangler d1 execute stage-previz-db --remote --file revert-login-codes.sql
```

退回後存法變回明文，用戶頁又看得到登入碼。換成雜湊之後才被重設過的人寫不回去，要再幫他按一次「重設」。
`login-codes.json` 已經刪了的話，從第 1 步的備份檔還原。退回完一樣刪掉這些檔案。

### 換完之後要記得

- 不要再部署比這個版本舊的 worker：舊的 worker 只認明文，換完之後沒有人登得進去。

---

## 已經上線、不用再做的（2026-10-14）

這些改動跟舊版前端相容，已經部署到正式後台，寫在這裡讓你知道有什麼不一樣：

- **邀請連結**：製作可以在用戶頁、專案頁建邀請連結（新版前端才有按鈕）。資料表是 0022 migration 的 `invites`。
- **系統產生的登入碼變成 10 個字**（以前 8 個字）。舊版用戶頁的「自訂」在換成雜湊之前照樣能用。
- **模型庫清單**（`/api/assets`）：只有製作、或某個專案的製作看得到（以前任何登入的人都能列出所有模型）。
- **根網址的 Drive 代理**（`https://proxy.haimiaan.com/?id=...`）：要登入才能用。新版、舊版前端都不用這個網址；
  只有最早的單頁工具（stage-previz.haimiaan.com）還在用，沒登入的人在那裡貼 Drive 連結會播不出來。
  要恢復的話，把 `cf-worker/worker.js` 的 `handleDriveProxy` 開頭的登入檢查拿掉再部署。

## 之後可以考慮

- **模型檔網址**（`/r2/models/<專案>/<時間>.glb`、`/r2/assets/models/<id>.glb`）現在是公開的：
  知道網址就能下載，網址不會過期，分享連結被刪掉後拿過網址的人還是下載得到。
  R2 本身沒有公開、也不能列出檔案，網址只能從 API 拿到（要是成員或有分享連結）；
  但網址是「專案代號 + 上傳的毫秒時間」，知道專案代號的人（成員、拿過分享連結的人）有機會猜到其他版本。
  建議：之後新上傳的模型檔名加一段 128 bits 的隨機字（例如 `models/<專案>/<時間>-<隨機>.glb`），
  網址照樣固定不變，瀏覽器和 CDN 可以快取很久（大模型在慢的網路、中國很重要），只是猜不到；
  不建議改成會過期的簽章網址（每次網址不一樣，快取就沒用了）。
  改的時候要一起改 `listModelVersions` / `deleteModelVersion` 認檔名的規則，舊檔名照樣要能用。
