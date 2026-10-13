-- 每首歌的影片版本（V1、V2…），檔案一律放在我們自己的 R2（不靠 Google 播放，之後大陸入口也能播）
--
-- songs.code — 歌曲固定代號（例：S01），每個專案裡不重複，可以改。
--   Drive 資料夾同步改用「檔名開頭的代號」對歌（S01_xxx.mp4 → 代號 S01 的歌），不再看歌單第幾首。
--   舊資料：照現在的順序補一次（order 0 → S01、order 1 → S02…），跟以前「S03 = 第 3 首」的對法一樣，
--   所以已經同步過的 Drive 檔案還是對到同一首歌。順序重複的歌（理論上不會有）排在最後面接著編號。
-- songs.video_version_seq — 這首歌發到第幾版了（版本號只增不減，刪掉的版本號碼也不會再用）
ALTER TABLE songs ADD COLUMN code TEXT;
ALTER TABLE songs ADD COLUMN video_version_seq INTEGER NOT NULL DEFAULT 0;

UPDATE songs
   SET code = printf('S%02d', "order" + 1)
 WHERE "order" >= 0
   AND NOT EXISTS (
     SELECT 1 FROM songs s2
      WHERE s2.project_id = songs.project_id AND s2."order" = songs."order" AND s2.id != songs.id
   );

-- 沒補到的（順序重複或小於 0）：接在最大號碼後面，依順序 → 建立時間 → id 排
-- （排名只看「順序重複或小於 0」這個不會在更新途中改變的條件）
UPDATE songs
   SET code = printf('S%02d',
     (SELECT MAX(s3."order") + 2 FROM songs s3 WHERE s3.project_id = songs.project_id)
     + (SELECT COUNT(*) FROM songs s4
         WHERE s4.project_id = songs.project_id
           AND (s4."order" < 0 OR EXISTS (
                 SELECT 1 FROM songs s5
                  WHERE s5.project_id = s4.project_id AND s5."order" = s4."order" AND s5.id != s4.id))
           AND (s4."order" < songs."order"
                OR (s4."order" = songs."order" AND (s4.created_at < songs.created_at
                    OR (s4.created_at = songs.created_at AND s4.id < songs.id))))))
 WHERE code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_project_code ON songs(project_id, code);

-- 影片版本
--   version       — 這首歌的第幾版（1 開始）；檔案好了（ready）才給號碼，取消 / 失敗的不佔號碼
--   source        — 'upload' 瀏覽器上傳 / 'link' 貼連結（後台複製一份）/ 'drive' Drive 資料夾同步（後台複製一份）
--   original_url  — 貼的連結（source = link）
--   drive_file_id — Drive 檔案 id（source = drive，或貼的是 Drive 連結）
--   source_rev    — Drive 檔案內容的版本（md5，沒有就用修改時間）→ 同一個檔案內容沒變不會再建新版
--   r2_key        — R2 裡的位置（videos/<專案>/<歌>/<id>.<副檔名>）
--   status        — 'uploading' 上傳中 / 'processing' 後台複製中 / 'ready' 可以播 / 'failed' 失敗
--   以下是上傳 / 複製用的工作欄位（好了以後清掉）：
--   upload_id     — R2 分段上傳的 id
--   part_size     — 每一段幾 bytes（最後一段可以比較小）
--   bytes_done    — 已經好了幾 bytes（進度條）
--   copy_kind     — 'drive_api'（用連接的 Google 帳號讀）/ 'url'（直接下載網址）
--   copy_url      — 實際下載的網址（copy_kind = url）
--   copy_token_id — 用哪個 Google 帳號（copy_kind = drive_api）
--   copy_mode     — 'range' 一段一段複製 / 'single' 來源不支援分段，一次複製完
--   lease_until   — 正在複製的那一輪做到幾點（毫秒；避免兩個地方同時複製同一個）
--   stall_count   — 連續幾輪沒有進度（太多次 → 失敗）
CREATE TABLE IF NOT EXISTS song_videos (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  song_id TEXT NOT NULL,
  version INTEGER,
  title TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK(source IN ('upload', 'link', 'drive')),
  original_url TEXT,
  drive_file_id TEXT,
  source_rev TEXT,
  r2_key TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER,
  width INTEGER,
  height INTEGER,
  duration_sec REAL,
  status TEXT NOT NULL CHECK(status IN ('uploading', 'processing', 'ready', 'failed')),
  error TEXT,
  upload_id TEXT,
  part_size INTEGER,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  copy_kind TEXT,
  copy_url TEXT,
  copy_token_id TEXT,
  copy_mode TEXT,
  lease_until INTEGER,
  stall_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ready_at TEXT,
  deleted_at TEXT,

  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_song_videos_version ON song_videos(song_id, version);
CREATE INDEX IF NOT EXISTS idx_song_videos_song ON song_videos(song_id, status);
CREATE INDEX IF NOT EXISTS idx_song_videos_project ON song_videos(project_id);
CREATE INDEX IF NOT EXISTS idx_song_videos_jobs ON song_videos(status, created_at);
CREATE INDEX IF NOT EXISTS idx_song_videos_drive ON song_videos(project_id, drive_file_id);

-- 分段上傳 / 複製已經好的段（瀏覽器可以同時傳好幾段 → 一段一列，不會互相蓋掉）
CREATE TABLE IF NOT EXISTS song_video_parts (
  video_id TEXT NOT NULL,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (video_id, part_number),
  FOREIGN KEY (video_id) REFERENCES song_videos(id) ON DELETE CASCADE
);
