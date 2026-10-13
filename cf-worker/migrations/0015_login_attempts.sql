-- 登入防猜號碼：記錄「打錯號碼」的時間（只記失敗；登入成功會清掉該 IP 的紀錄）
--   ip           — 來源 IP（IPv6 以 /64 為單位，見 loginThrottle.mjs 的 loginClientKey）
--   attempted_at — 失敗時間（epoch 毫秒）
-- 同一 IP 15 分鐘內錯 10 次 → 鎖 15 分鐘。超過一天的紀錄在每次登入時順手清掉。
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts(ip, attempted_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_time ON login_attempts(attempted_at);
