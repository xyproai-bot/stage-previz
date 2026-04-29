-- Cue palette / templates（admin Tier 1 #5）
-- 對標 GrandMA3：常用 cue 模式存模板，新 cue 一鍵套
-- payload 用 mesh_name 存 snapshot（跨 project 套用時對應）

CREATE TABLE IF NOT EXISTS cue_templates (
  id TEXT PRIMARY KEY,
  project_id TEXT,                          -- NULL = 全域模板（可跨專案用）
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,                    -- JSON：{ position, rotation, fov, crossfadeSeconds, snapshotStates: [{meshName, position, rotation}] }
  created_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_cue_templates_project ON cue_templates(project_id);
