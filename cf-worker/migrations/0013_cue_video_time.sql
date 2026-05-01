-- Cue 加「影片時間」欄位（NULL = 沒對應到影片時間，hard-cut；非 NULL = 影片到那秒切到此 cue）
ALTER TABLE cues ADD COLUMN video_time_sec REAL;
CREATE INDEX IF NOT EXISTS idx_cues_video_time ON cues(song_id, video_time_sec);
