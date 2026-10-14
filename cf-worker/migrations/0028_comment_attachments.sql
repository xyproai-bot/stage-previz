-- 留言的參考圖片（附件）：貼上 / 拖進來 / 選檔案，一則最多 4 張（分享連結的訪客 2 張）。
-- 只有加表、加索引（不改舊資料）→ 舊版前端照樣能用：舊的留言沒有附件，API 格式跟以前一樣（多一個 attachments 欄位，舊版畫面不看）。
-- 規則在 cf-worker/commentAttachments.mjs（上傳、檢查、清掉）和 web/src/lib/review/attachmentRules.ts（前後台共用）；
-- 測試：commentAttachments.test.mjs（node:sqlite 跑真的 SQL）。
--
-- 一列 = 一張圖。先上傳（comment_id 還是 NULL = 還沒送出）→ 送出留言時才掛上去（comment_id = 那則留言）。
-- 一直沒送出的（打到一半關掉）排程一天後清掉。刪留言 / 刪歌時 R2 的檔案一起清（資料庫這邊跟著 ON DELETE CASCADE）。
--   r2_key       comment-attachments/<專案>/<32 個隨機 hex>.<png|jpg|webp|gif>（網址猜不到，跟留言縮圖一樣）
--   thumb_key    清單上的小縮圖（約 480 px）：comment-attachments/<專案>/<同一串隨機碼>-t.<webp|jpg>；NULL = 用原圖
--   mime / size / width / height   檔案類型、大小（bytes）、尺寸（px）
--   sort_order   在留言裡的順序（0 起）
--   uploaded_by_user_id   團隊成員傳的；share_token   分享連結的訪客傳的（兩個一定有一個）
--   created_at / attached_at   上傳 / 掛到留言上的時間（ISO）
CREATE TABLE IF NOT EXISTS comment_attachments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  comment_id TEXT,
  r2_key TEXT NOT NULL,
  thumb_key TEXT,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  uploaded_by_user_id TEXT,
  share_token TEXT,
  created_at TEXT NOT NULL,
  attached_at TEXT,

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
  FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_comment_attachments_song ON comment_attachments(song_id, comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_attachments_comment ON comment_attachments(comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_attachments_uploader ON comment_attachments(uploaded_by_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comment_attachments_share ON comment_attachments(share_token, created_at);
CREATE INDEX IF NOT EXISTS idx_comment_attachments_pending ON comment_attachments(created_at) WHERE comment_id IS NULL;
