-- Drive OAuth tokens（Google 連線授權）
-- refresh_token 用 AES-GCM 加密後存（key 從 AUTH_SECRET 衍生）
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('google')),
  account_email TEXT NOT NULL,
  account_name TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '',
  encrypted_refresh_token TEXT NOT NULL,
  -- 短期 access token cache（避免每次都 refresh）— 過期時間 + 加密 token
  encrypted_access_token TEXT,
  access_token_expires_at TEXT,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,

  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_provider ON oauth_tokens(provider);
CREATE INDEX IF NOT EXISTS idx_oauth_email ON oauth_tokens(provider, account_email);

-- OAuth state 暫存（CSRF 保護）— 5 分鐘過期
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  return_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 同步記錄（admin 在 /admin/drive-sources 看上次同步狀態）
CREATE TABLE IF NOT EXISTS drive_sync_log (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  triggered_by TEXT NOT NULL CHECK(triggered_by IN ('cron', 'manual')),
  files_found INTEGER NOT NULL DEFAULT 0,
  files_classified INTEGER NOT NULL DEFAULT 0,
  files_unclassified INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  duration_ms INTEGER,
  ran_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_drive_sync_project ON drive_sync_log(project_id, ran_at DESC);
