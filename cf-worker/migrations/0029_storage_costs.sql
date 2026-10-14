-- 省空間：刪掉的版本留 30 天（可以救回來）再清檔案、專案結束清影片、搬到長期存放、空間用量、重複的檔案。
-- 只有加欄位、加表、加索引（不改舊資料的意思）→ 舊版前端照樣能用。
-- 規則在 cf-worker/storage.mjs（storage.test.mjs 有測）；指紋算法跟前端共用 web/src/lib/videoFingerprint.ts。

-- ─── 影片版本 ───
--   purge_after     刪掉的版本什麼時候清 R2 的檔案（刪的時間 + 30 天）；救回來 = NULL
--   purged_at       R2 的檔案已經清掉的時間（之後不能再救；版本號照樣不會再用）
--   deleted_by      誰刪的（專案結束清影片也記是誰按的）
--   storage_class   R2 的存放方式：NULL / 'Standard' 標準、'InfrequentAccess' 長期存放（比較便宜，打開要一點讀取費）
--   fingerprint     檔案指紋 'fp1:<64 hex>'（大小 + 頭、中、尾各 8 MiB；算法見 videoFingerprint.ts）；還沒算 = NULL
--   fp_progress     後台算指紋到一半的進度（JSON：已經算好的每 1 MiB 一段的雜湊），算完清掉
ALTER TABLE song_videos ADD COLUMN purge_after TEXT;
ALTER TABLE song_videos ADD COLUMN purged_at TEXT;
ALTER TABLE song_videos ADD COLUMN deleted_by TEXT;
ALTER TABLE song_videos ADD COLUMN storage_class TEXT;
ALTER TABLE song_videos ADD COLUMN fingerprint TEXT;
ALTER TABLE song_videos ADD COLUMN fp_progress TEXT;

-- 已經刪掉的版本：30 天從刪的時間開始算；刪的時間讀不懂就從現在開始算
UPDATE song_videos
   SET purge_after = COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at, '+30 days'),
                              strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days'))
 WHERE deleted_at IS NOT NULL AND purge_after IS NULL;

CREATE INDEX IF NOT EXISTS idx_song_videos_purge ON song_videos(purge_after) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_song_videos_fp ON song_videos(project_id, fingerprint);

-- ─── 搬到長期存放（一版一列；排程一段一段搬，搬完 status = done）───
--   upload_id / part_size / parts_json   R2 分段上傳（同一個位置寫一份新的、長期存放的）
--   status   'queued' 等著 / 'done' 好了 / 'failed' 失敗（error 寫原因）
CREATE TABLE IF NOT EXISTS video_storage_jobs (
  video_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  target_class TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  upload_id TEXT,
  part_size INTEGER,
  parts_json TEXT NOT NULL DEFAULT '[]',
  bytes_done INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  requested_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  FOREIGN KEY (video_id) REFERENCES song_videos(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_video_storage_jobs_status ON video_storage_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_video_storage_jobs_project ON video_storage_jobs(project_id);

-- ─── 空間用量（排程把 R2 整個列一次的結果；看頁面時不去列 R2）───
--   project_id  '' = 不屬於哪個專案（共用模型庫、備份、小程序下載…）
--   category    'models' 模型 / 'comment-images' 留言圖片 / 'videos' 影片（R2 實際）/ 'assets' 共用模型庫 / 'backups' 備份 / 'downloads' 下載檔 / 'other' 其他
CREATE TABLE IF NOT EXISTS storage_usage (
  project_id TEXT NOT NULL,
  category TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  objects INTEGER NOT NULL DEFAULT 0,
  ia_bytes INTEGER NOT NULL DEFAULT 0,
  scanned_at TEXT NOT NULL,
  PRIMARY KEY (project_id, category)
);
