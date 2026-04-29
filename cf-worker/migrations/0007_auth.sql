-- 簡易 auth：admin 給每個用戶一組 access code（號碼）
-- 用戶用 code 登入，沒密碼、沒 email 註冊步驟
-- 共享 code 的風險由 admin 控管（隨時可重新產生 code 讓舊 code 失效）

ALTER TABLE users ADD COLUMN access_code TEXT;        -- 8 位英數字，明文存（admin 後台可顯示給用戶）
ALTER TABLE users ADD COLUMN deactivated INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_access_code ON users(access_code) WHERE access_code IS NOT NULL;

-- 給已存在的 admin (u_phang) 一個初始 code，他登入後可改
UPDATE users SET access_code = 'PHANG-001' WHERE id = 'u_phang' AND access_code IS NULL;
