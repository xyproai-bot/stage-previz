-- stage-previz v2.0 初始 schema
-- 對應 platform_v2_spec.md 的 D1 schema 定稿

-- ─────────────────────────────────────────────
-- Users（用戶 + 角色）
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  avatar_color TEXT NOT NULL DEFAULT '#10c78a',
  role TEXT NOT NULL CHECK(role IN ('admin', 'animator', 'director')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ─────────────────────────────────────────────
-- Projects（專案）
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  thumbnail_r2_key TEXT,
  model_r2_key TEXT,

  -- Drive 來源（後臺管理用，Phase 1 backend 後段做）
  drive_folder_id TEXT,
  drive_filename_pattern TEXT NOT NULL DEFAULT '^S(\d+)_',
  drive_oauth_token_id TEXT,
  drive_refresh_interval_min INTEGER NOT NULL DEFAULT 5,

  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'in_review', 'archived')),
  created_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);

-- ─────────────────────────────────────────────
-- Project Members（多對多）
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin', 'animator', 'director')),
  added_at TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pm_user ON project_members(user_id);

-- ─────────────────────────────────────────────
-- Songs（歌曲，平的、可拖拉排序）
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0,
  animator_user_id TEXT,
  drive_folder_id TEXT,  -- 可 override project 的
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in_review', 'approved', 'needs_changes')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (animator_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_songs_project ON songs(project_id, "order");
CREATE INDEX IF NOT EXISTS idx_songs_animator ON songs(animator_user_id);

-- ─────────────────────────────────────────────
-- Cues（master + proposal）
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cues (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL,
  name TEXT NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0,

  -- 攝影機 / 走位 / 機關 狀態（JSON）
  position_xyz TEXT NOT NULL DEFAULT '{"x":0,"y":0,"z":0}',
  rotation_xyz TEXT NOT NULL DEFAULT '{"pitch":0,"yaw":0,"roll":0}',
  fov REAL NOT NULL DEFAULT 60,
  crossfade_seconds REAL NOT NULL DEFAULT 0,

  status TEXT NOT NULL DEFAULT 'master' CHECK(status IN ('master', 'proposal', 'alternate')),
  proposed_by_user_id TEXT,
  base_cue_id TEXT,         -- proposal 對應的 master cue id
  approved_at TEXT,
  approved_by_user_id TEXT,

  thumbnail_r2_key TEXT,    -- 自動生成的縮圖
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
  FOREIGN KEY (proposed_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (approved_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (base_cue_id) REFERENCES cues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cues_song ON cues(song_id, "order");
CREATE INDEX IF NOT EXISTS idx_cues_status ON cues(status);

-- ─────────────────────────────────────────────
-- Mesh Classifications（模型上傳後自動分類）
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mesh_classifications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  mesh_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('led_panel', 'walk_point', 'mechanism', 'fixture', 'other')),
  metadata TEXT,  -- JSON：LED panel 的 UV offset 等

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mesh_project ON mesh_classifications(project_id);

-- ─────────────────────────────────────────────
-- Drive Files Cache（後台輪詢結果）
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS drive_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  song_id TEXT,                 -- NULL = 未歸類
  drive_file_id TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime_type TEXT,
  modified_time TEXT,
  size_bytes INTEGER,
  thumbnail_url TEXT,
  view_url TEXT,
  stream_url TEXT,
  classified_by TEXT NOT NULL DEFAULT 'pattern' CHECK(classified_by IN ('pattern', 'manual')),
  cached_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_drive_project ON drive_files(project_id);
CREATE INDEX IF NOT EXISTS idx_drive_song ON drive_files(song_id, modified_time DESC);

-- ─────────────────────────────────────────────
-- Comments（3D-anchored 留言、含 thread）
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  song_id TEXT,
  drive_file_id TEXT,
  time_in_video REAL,

  -- 留言錨點：3D world / mesh / screen 三種
  anchor_type TEXT NOT NULL CHECK(anchor_type IN ('screen', 'world', 'mesh')),
  anchor_world_xyz TEXT,   -- world 模式 JSON
  anchor_mesh_name TEXT,   -- mesh 模式
  anchor_screen_xy TEXT,   -- screen 模式 JSON

  text TEXT NOT NULL,
  mentions TEXT,           -- JSON [user_id]
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
  reply_to_comment_id TEXT,
  author_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE SET NULL,
  FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reply_to_comment_id) REFERENCES comments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_comments_project ON comments(project_id);
CREATE INDEX IF NOT EXISTS idx_comments_song ON comments(song_id, time_in_video);
CREATE INDEX IF NOT EXISTS idx_comments_thread ON comments(reply_to_comment_id);

-- ─────────────────────────────────────────────
-- Seed：建一個 admin 用戶（你自己）
-- ─────────────────────────────────────────────
INSERT OR IGNORE INTO users (id, email, name, role, avatar_color)
VALUES ('u_phang', 'phang9111@gmail.com', 'Phang', 'admin', '#10c78a');
