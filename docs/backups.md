# 資料庫備份與還原

正式資料庫是 Cloudflare D1 的 `stage-previz-db`。有兩種方法可以把資料救回來：

| | 每天自動備份（R2） | D1 Time Travel |
|---|---|---|
| 是什麼 | 每天一份 SQL 檔，存在我們自己的 R2 | Cloudflare 自動記錄，可以回到任何一分鐘 |
| 留多久 | 最近 30 天每天一份 + 最近 12 個月每個月一份 | 30 天（Workers 付費方案）／ 7 天（免費方案） |
| 適合 | 還原到另一個資料庫、拿舊資料出來看、很久以前的資料 | 正式資料庫整個退回某個時間點（最快） |

---

## 每天自動備份

- 排程每 5 分鐘看一次：台灣時間每天 **04:00 以後**做當天的一份；24 小時內都沒有備份的話（例如剛上線）馬上做。
- 存在 R2 bucket `stage-previz-models` 的 `backups/d1/YYYY-MM-DD.sql.gz`（日期是台灣時間）。
- 內容：所有資料表的 `CREATE TABLE` + 每一列的 `INSERT` + 索引，gzip 壓縮。
  不包含 `sqlite_` / `_cf_` 開頭的系統表；**也不包含 R2 上的檔案**（模型、影片本來就在 R2）。
- 自動刪舊的：留最近 30 份每日備份 + 最近 12 個月、每個月最早的那一份。
- 資料庫很大時會分好幾輪做（每輪有列數 / 大小 / 時間上限），中間的段落放在 `backups/d1-parts/`，做完接成一個檔、段落刪掉。
- 在哪裡看：**設定 → 系統狀態**（只有製作看得到）會寫最近一份是什麼時候、多大，可以按「下載最近一份」。
  全部的清單：`GET https://proxy.haimiaan.com/api/admin/backups`（要用製作登入）。
- 程式：`cf-worker/backups.mjs`（測試 `backups.test.mjs`）；進度記在 D1 的 `ops_state` 表（key = `backup_d1`）。

大小和費用：現在資料庫不到 1 MB，一份備份壓縮後約 60 KB，全部留著的 42 份約 2.5 MB。
R2 每個月前 10 GB 免費，就算資料庫長大 100 倍也還在免費額度內。

---

## 下載一份備份

方法 1：設定 → 系統狀態 →「下載最近一份」。

方法 2：用 wrangler（在 `cf-worker` 資料夾，日期換成要的那天）：

```bash
npx wrangler r2 object get stage-previz-models/backups/d1/2026-10-14.sql.gz --remote --file backup.sql.gz
```

解壓縮（任何一種都可以；大資料庫分好幾段做的備份也一樣解得開）：

```bash
# Git Bash / Mac
gzip -dc backup.sql.gz > backup.sql

# 任何電腦（Node）
node -e "require('fs').writeFileSync('backup.sql', require('zlib').gunzipSync(require('fs').readFileSync('backup.sql.gz')))"
```

（Windows PowerShell 不要用 `>` 存檔，會變成 UTF-16；用上面 Node 那一行。）

---

## 還原到一個新的資料庫（建議）

備份檔裡有 `CREATE TABLE`，所以一定要還原到**空的**資料庫（已經有表的話會失敗，不會蓋掉資料）。

```bash
cd cf-worker

# 1. 開一個新的空資料庫
npx wrangler d1 create stage-previz-restore

# 2. 把備份灌進去
npx wrangler d1 execute stage-previz-restore --remote --file backup.sql

# 3. 檢查
npx wrangler d1 execute stage-previz-restore --remote --command "SELECT COUNT(*) AS n FROM projects"
npx wrangler d1 migrations list stage-previz-restore --remote   # 會寫「No migrations to apply」（備份裡有 d1_migrations）
```

接下來看要怎麼用：

- **只要拿回幾筆資料**：在新的資料庫查出來，再手動寫回正式資料庫。
- **整個換成還原的資料庫**：先把正式的匯出一份（`npx wrangler d1 export stage-previz-db --remote --output before-switch.sql`），
  把 `cf-worker/wrangler.toml` 的 `database_id` 換成 `stage-previz-restore` 的 id（`wrangler d1 create` 有印出來），
  再 `npx wrangler deploy`。之後備份那天以後的新資料就沒了，請先確定。
- 用完不要的話：`npx wrangler d1 delete stage-previz-restore`。

在自己電腦上試還原（不碰正式的）：

```bash
npx wrangler d1 execute stage-previz-db --local --persist-to .wrangler/restore-test --file backup.sql
```

備份檔開頭有 `PRAGMA defer_foreign_keys = TRUE;`，而且被參照的表排在前面，所以資料灌進去的順序不會撞到外鍵檢查。

---

## D1 Time Travel：正式資料庫整個退回某個時間點

不用備份檔，Cloudflare 自動記錄每一次修改（付費方案 30 天內、免費方案 7 天內，任何一分鐘都可以）。
**會直接蓋掉正式資料庫**：那個時間點以後的修改全部消失。

```bash
cd cf-worker

# 1. 先匯出現在的一份（萬一退錯了還有）
npx wrangler d1 export stage-previz-db --remote --output before-time-travel.sql

# 2. 看那個時間點對應的書籤（時間可以寫台灣時間，例如 2026-10-14T03:00:00+08:00）
npx wrangler d1 time-travel info stage-previz-db --timestamp=2026-10-14T03:00:00+08:00

# 3. 退回去（用時間或上一步的書籤都可以）
npx wrangler d1 time-travel restore stage-previz-db --timestamp=2026-10-14T03:00:00+08:00
# 或
npx wrangler d1 time-travel restore stage-previz-db --bookmark=<書籤>
```

退回去以後 wrangler 會印出「退回前」的書籤；退錯了用那個書籤再 `time-travel restore --bookmark=...` 一次就回到原本的樣子。

說明：<https://developers.cloudflare.com/d1/reference/time-travel/>
