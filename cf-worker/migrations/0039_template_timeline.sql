-- 0039 LED 版型時間線（第 3 階段：同一首歌中途換版型）
-- 設計：docs/superpowers/specs/2026-10-15-led-canvas-templates-design.md 6d；API：docs/led-templates-api.md
-- 只有加表、加欄位、加索引（不改舊資料、不重建表、不刪表）：
--   沒有換版型的歌 / 影片版本 = 沒有這些資料，行為跟以前一模一樣。
--
--   song_template_switches   一首歌換版型的點。開頭用的版型還是 songs.template_id（舊的版型選單 = 開頭的版型，舊版前端照常運作）。
--                            cue_id    用 Cue 換：跟著 Cue 的影片時間（cues.video_time_sec）走；Cue 刪掉 → 這個點一起拿掉
--                            at_sec    直接寫時間（秒）；用 Cue 時是存檔那一刻 Cue 的時間（只當備用）
--                            template_id  換成哪個版型。版型還被用著不能刪（ledTemplates.mjs 擋），所以不會真的走到 CASCADE
--   song_videos.template_timeline  這一版影片上傳那一刻的整條時間線（JSON，每個版型的排法 + 每一段從第幾秒開始；Cue 的時間也在那一刻定下來）。
--                            NULL = 沒有時間線（單一版型，看 template_snapshot，跟以前一樣）。template_snapshot 仍然寫開頭的版型，舊版前端看得到
CREATE TABLE IF NOT EXISTS song_template_switches (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL,
  cue_id TEXT,
  at_sec REAL,
  template_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (cue_id IS NOT NULL OR (at_sec IS NOT NULL AND at_sec >= 0)),
  FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
  FOREIGN KEY (cue_id) REFERENCES cues(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES led_templates(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_song_template_switches_song ON song_template_switches(song_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_song_template_switches_template ON song_template_switches(template_id);
CREATE INDEX IF NOT EXISTS idx_song_template_switches_cue ON song_template_switches(cue_id);

ALTER TABLE song_videos ADD COLUMN template_timeline TEXT;
