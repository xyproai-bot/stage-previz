-- Activity log（admin Tier 1 #1 Activity feed）
-- 每個 mutation 寫一筆，audit log 風格（不可改、不可刪）

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  user_id TEXT,                       -- 動作的人（暫時都 u_phang，#13 權限細分後才有多人）
  action TEXT NOT NULL,               -- create / update / delete / reorder / reset / activate / upload
  target_type TEXT NOT NULL,          -- song / cue / cue_state / stage_object / project / model
  target_id TEXT,                     -- 目標 row id（model upload 時放 r2 key）
  payload TEXT NOT NULL DEFAULT '{}', -- JSON：display name, diff, 額外 context
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- 主要查詢：按 project 倒序拉最近 N 筆
CREATE INDEX IF NOT EXISTS idx_activity_project_time ON activity_log(project_id, created_at DESC);
