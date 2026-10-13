-- 留言從 KV（一首歌一個 JSON 陣列，同時留言會互相蓋掉）搬到 D1：一則留言一列。
-- 0001 建的 comments 表從來沒用過（正式資料庫 0 列），欄位跟現在的留言格式對不上 → 重建。
-- API 格式不變（cf-worker/comments.mjs 的 rowToComment）。
--   author_user_id — 誰留的（後台依登入身分填，不信前端）；刪掉用戶時留言保留、這欄變 NULL
--   author_name / author_role / author_email — 留言當下顯示的名字和身分
--   anchor_type    — NULL = 沒有錨點；'screen' / 'world' / 'mesh'
--   anchor_screen_xy — {x,y}（0~1 螢幕座標）；anchor_world_xyz — world 錨點；anchor_mesh_name + anchor_offset_xyz — mesh 錨點
--   created_at     — ISO 字串（前端送的時間，跟以前一樣）
-- 順序：用 rowid（寫入順序），跟以前 KV 陣列的順序一樣。
DROP TABLE IF EXISTS comments;

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  drive_file_id TEXT,
  time_in_video REAL NOT NULL DEFAULT 0,
  anchor_type TEXT CHECK(anchor_type IS NULL OR anchor_type IN ('screen', 'world', 'mesh')),
  anchor_screen_xy TEXT,
  anchor_world_xyz TEXT,
  anchor_mesh_name TEXT,
  anchor_offset_xyz TEXT,
  text TEXT NOT NULL,
  mentions TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved')),
  resolved_by TEXT,
  resolved_at TEXT,
  reply_to_comment_id TEXT,
  author_user_id TEXT,
  author_name TEXT NOT NULL,
  author_role TEXT NOT NULL,
  author_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
  FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (reply_to_comment_id) REFERENCES comments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_comments_song ON comments(song_id);
CREATE INDEX IF NOT EXISTS idx_comments_project ON comments(project_id);
