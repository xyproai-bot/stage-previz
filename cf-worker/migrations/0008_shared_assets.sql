-- 共用資產庫（admin Tier 1 #10）
-- admin 上傳一份 model 到資產庫，多個 project 共用，省 R2 空間

CREATE TABLE IF NOT EXISTS shared_assets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('model')),  -- 之後可擴成 cue_palette / texture
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  r2_key TEXT NOT NULL,                          -- 例：assets/models/<assetId>.glb
  size_bytes INTEGER NOT NULL DEFAULT 0,
  uploaded_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deactivated INTEGER NOT NULL DEFAULT 0,

  FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_shared_assets_type ON shared_assets(type, deactivated);
CREATE INDEX IF NOT EXISTS idx_shared_assets_updated ON shared_assets(updated_at DESC);
