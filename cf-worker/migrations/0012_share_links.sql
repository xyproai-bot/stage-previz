-- 公開分享連結（director 寄給藝人經紀人 / 製作公司讓他們看 read-only 預覽）
CREATE TABLE IF NOT EXISTS share_links (
  token TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  song_id TEXT,                            -- NULL = 全 project；非 NULL = 鎖定單首歌
  created_by_user_id TEXT,
  password TEXT,                           -- 可選簡單密碼（明文 hash 太重了，且非高敏資料）
  expires_at TEXT,                         -- ISO，NULL = 永久
  view_count INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_share_project ON share_links(project_id);
