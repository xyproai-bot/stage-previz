-- 審片 v2：留言綁版本、可以回覆、「已改好（V3）」；通過 / 需修改綁版本（審片紀錄）；站內通知。
-- 只有加欄位、加表、加索引（不改舊資料）→ 舊版前端照樣能用（沒帶版本的留言 = 舊留言）。
-- 規則（誰能做什麼）在 cf-worker/access.mjs；寫入 / 讀出在 cf-worker/reviews.mjs（reviews.test.mjs 有測）。

-- ─── 留言 ───
--   video_id / video_version          留言時看的那一版（V2）；NULL = 舊留言（沒綁版本）
--   reply_to_comment_id（0019 就有）  回覆哪一則（只有一層：回覆的回覆一律掛在最上面那則）
--   resolved_video_id / resolved_version  「已改好（V3）」是哪一版改好的
--   resolved_by_user_id               誰標的（resolved_by 只有名字）
--   kind                              NULL 一般留言；'needs_changes' = 導演按「需修改」時寫的原因
ALTER TABLE comments ADD COLUMN video_id TEXT;
ALTER TABLE comments ADD COLUMN video_version INTEGER;
ALTER TABLE comments ADD COLUMN resolved_video_id TEXT;
ALTER TABLE comments ADD COLUMN resolved_version INTEGER;
ALTER TABLE comments ADD COLUMN resolved_by_user_id TEXT;
ALTER TABLE comments ADD COLUMN kind TEXT;

CREATE INDEX IF NOT EXISTS idx_comments_reply ON comments(reply_to_comment_id);

-- ─── 審片紀錄：導演（或製作）按「已通過」「需修改」時看的是哪一版 ───
--   status      'approved' / 'needs_changes'
--   from_status 按之前的狀態
--   reason      需修改的原因（已通過可以空白）
--   comment_id  原因同時發成一則留言 → 那則留言的 id
--   by_role     當時在這個專案的角色（director / admin）
CREATE TABLE IF NOT EXISTS song_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  video_id TEXT,
  video_version INTEGER,
  status TEXT NOT NULL,
  from_status TEXT,
  reason TEXT NOT NULL DEFAULT '',
  comment_id TEXT,
  by_user_id TEXT,
  by_name TEXT NOT NULL DEFAULT '',
  by_role TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
  FOREIGN KEY (by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_song_reviews_song ON song_reviews(song_id, created_at);
CREATE INDEX IF NOT EXISTS idx_song_reviews_project ON song_reviews(project_id, created_at);

-- ─── 站內通知（每個人一份；事情發生的當下寫進來；超過 60 天的排程自動清掉）───
--   kind  'mention' @到你 / 'needs_changes' 你的歌被退（需修改）/ 'new_version' 新版等你審 /
--         'assigned' 歌指派給你 / 'approved' 你的歌通過了 / 'reply' 有人回覆你的留言
--   song_name / actor_name / excerpt  寫進來當下的名字和一小段內容（之後改名也看得懂當時是什麼）
--   read_at  看過的時間；NULL = 未讀
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  song_id TEXT,
  video_id TEXT,
  video_version INTEGER,
  comment_id TEXT,
  kind TEXT NOT NULL,
  actor_user_id TEXT,
  actor_name TEXT NOT NULL DEFAULT '',
  song_name TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  read_at TEXT,

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);
