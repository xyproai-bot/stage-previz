-- 維運加固：重設登入碼 / 停用時登出其他裝置、前端錯誤回報、每天自動備份的進度
-- 只有加欄位、加表、加索引（不改舊資料）→ 舊版前端（0d6df54）照樣能用。
-- 規則在 cf-worker/sessions.mjs、clientErrors.mjs、backups.mjs（各自有 *.test.mjs）。

-- ─── 登入狀態失效的時間點（sessions.mjs）───
--   sessions_revoked_at  unix 秒；這個時間點以前發的登入都不算（製作重設登入碼、停用帳號時寫）
--   session_keep_hash    製作重設「自己」的登入碼時，自己現在這一個登入留著（存登入字串的 SHA-256）
ALTER TABLE users ADD COLUMN sessions_revoked_at INTEGER;
ALTER TABLE users ADD COLUMN session_keep_hash TEXT;

-- ─── 前端錯誤回報（clientErrors.mjs）───
--   不存 IP；path 是網址的路徑（不含 ? 後面，分享連結碼 / 邀請碼遮掉）
--   fingerprint  同一組錯誤（訊息裡的數字當成一樣）
--   created_at   毫秒；超過 30 天的排程自動清掉
CREATE TABLE IF NOT EXISTS client_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  path TEXT,
  user_agent TEXT,
  app_version TEXT,
  user_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_errors_created ON client_errors(created_at);
CREATE INDEX IF NOT EXISTS idx_client_errors_fp ON client_errors(fingerprint, created_at);

-- 每天的回報次數（每個 IP 一個，只存加了鹽的雜湊；全站一個 'day:YYYY-MM-DD'），隔天清掉
CREATE TABLE IF NOT EXISTS client_error_counts (
  bucket TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_client_error_counts_day ON client_error_counts(day);

-- ─── 維運進度（backups.mjs：key = 'backup_d1'，value = JSON）───
--   updated_at  毫秒，也當版本號（兩個排程同時跑時只有一個存得進去）
CREATE TABLE IF NOT EXISTS ops_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
