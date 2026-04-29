-- Show 概念（admin Tier 1 #8）
-- 對標 Disguise — 一場巡迴有多場 project，每場 LED 內容大致一致但有差異

CREATE TABLE IF NOT EXISTS shows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- project 加歸屬 show 的 FK，nullable（不一定屬於某 show）
ALTER TABLE projects ADD COLUMN show_id TEXT REFERENCES shows(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_projects_show ON projects(show_id);
