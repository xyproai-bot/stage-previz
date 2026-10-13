-- 分享連結密碼不再存明文：改存加鹽雜湊（PBKDF2-SHA256，算法在 cf-worker/sharePassword.mjs）
--   password_hash — 'pbkdf2-sha256$<次數>$<base64>'；NULL = 沒設密碼（或還是舊的明文，見下）
--   password_salt — base64，每條連結自己的隨機鹽
-- 舊欄位 password（明文）先留著：還有明文的連結，第一次有人輸入正確密碼時後台會換成雜湊並清掉明文；
-- 上線時另外用一次性腳本把剩下的明文全部轉掉（正式資料庫上線前檢查是 0 條）。
ALTER TABLE share_links ADD COLUMN password_hash TEXT;
ALTER TABLE share_links ADD COLUMN password_salt TEXT;
