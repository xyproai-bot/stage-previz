-- 0002 stage objects + per-cue object states
-- cue 改成「每個機關/LED 的 position/rotation 快照」，不再只有攝影機狀態

-- ─────────────────────────────────────────────
-- Stage Objects（每個專案的可動物件清單）
-- 對應模型內的 mesh，admin 可手動建/或之後上傳模型自動掃出
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stage_objects (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  mesh_name TEXT NOT NULL,            -- 對應 .glb 內的 mesh name
  display_name TEXT,                  -- 顯示用名稱（NULL = mesh_name）
  category TEXT NOT NULL DEFAULT 'other'
    CHECK(category IN ('led_panel', 'walk_point', 'mechanism', 'fixture', 'performer', 'other')),
  "order" INTEGER NOT NULL DEFAULT 0, -- 顯示排序
  default_position TEXT NOT NULL DEFAULT '{"x":0,"y":0,"z":0}',
  default_rotation TEXT NOT NULL DEFAULT '{"pitch":0,"yaw":0,"roll":0}',
  default_scale TEXT NOT NULL DEFAULT '{"x":1,"y":1,"z":1}',
  metadata TEXT,                      -- JSON：UV offset、機關旋轉軸、LED 解析度等
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, mesh_name)
);

CREATE INDEX IF NOT EXISTS idx_stage_objects_project ON stage_objects(project_id, "order");
CREATE INDEX IF NOT EXISTS idx_stage_objects_category ON stage_objects(category);

-- ─────────────────────────────────────────────
-- Cue Object States（cue × object → 該物件在該 cue 的狀態）
-- 沒記錄 = 該物件在這個 cue 用 default
-- 有記錄 = override default
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cue_object_states (
  id TEXT PRIMARY KEY,
  cue_id TEXT NOT NULL,
  stage_object_id TEXT NOT NULL,
  position TEXT,                      -- JSON {x,y,z} 或 NULL = 用 default
  rotation TEXT,                      -- JSON {pitch,yaw,roll}
  scale TEXT,                         -- JSON {x,y,z}
  visible INTEGER DEFAULT 1,          -- 0/1，這個 cue 該物件是否顯示
  custom_props TEXT,                  -- JSON：例如 LED brightness/opacity/content_url
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (cue_id) REFERENCES cues(id) ON DELETE CASCADE,
  FOREIGN KEY (stage_object_id) REFERENCES stage_objects(id) ON DELETE CASCADE,
  UNIQUE(cue_id, stage_object_id)
);

CREATE INDEX IF NOT EXISTS idx_cos_cue ON cue_object_states(cue_id);
CREATE INDEX IF NOT EXISTS idx_cos_object ON cue_object_states(stage_object_id);
