-- 邀請連結 + 登入碼雜湊要用的欄位（只有新增，不改舊資料，舊版前端照樣能用）
--
-- 1. invites：製作幫某個人建的邀請連結（https://<網站>/invite/<邀請碼>），規則在 cf-worker/invites.mjs
--    token_hash   — 邀請碼的 SHA-256（base64url）；邀請碼本身不存
--    user_id      — 已經有帳號的人；NULL = 新的人（第一次打開時才建帳號，建好後填進來）
--    new_user_name— 新的人的名字
--    時間一律 epoch 毫秒
-- 2. users.access_code_hash：登入碼的 PBKDF2 雜湊（cf-worker/loginCodes.mjs）。
--    現在還是空的：真正換成雜湊、清掉明文是上線新版前端那天的另一步（docs/release-checklist.md）
-- 3. app_settings：全站設定（login_code_storage = 'hashed' 代表登入碼已經換成雜湊；沒有這列 = 明文，跟以前一樣）

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('animator', 'director')),
  user_id TEXT,
  new_user_name TEXT,
  created_by_user_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1,
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  used_by_user_id TEXT,
  revoked_at INTEGER,
  revoked_by_user_id TEXT,

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (revoked_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_invites_project ON invites(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invites_open ON invites(revoked_at, expires_at);

ALTER TABLE users ADD COLUMN access_code_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_access_code_hash ON users(access_code_hash) WHERE access_code_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
