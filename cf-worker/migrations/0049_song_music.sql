-- 每首歌可以放一首音樂（沒有影片的歌用音樂當「歌的時間」）。
-- 一首歌最多一首：換音樂 = 這一列換成新的（舊的 R2 檔記進 r2_pending_deletes，之後補刪）；移除 = 這一列拿掉。
--   id           這一首音樂的代號（sm_…）。每次上傳都換新的 → 播放網址跟著變，瀏覽器不會拿到舊的快取
--   r2_key       R2 上的位置：music/<專案>/<歌>/<音樂 id>.<mp3|wav|m4a|aac|flac>
--   filename     上傳時的檔名（畫面上顯示）
--   mime         標準化後的格式（audio/mpeg、audio/wav、audio/mp4、audio/aac、audio/flac）
--   size_bytes   檔案大小
--   duration_sec 長度（秒，瀏覽器上傳前量的；量不到 = NULL）
--   uploaded_by  誰傳的
--   uploaded_at  什麼時候
-- 歌被刪、專案被刪時這一列跟著刪（ON DELETE CASCADE）；R2 的檔案由刪歌的程式先記下來清掉。
CREATE TABLE IF NOT EXISTS song_music (
  song_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  duration_sec REAL,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_song_music_project ON song_music(project_id);
