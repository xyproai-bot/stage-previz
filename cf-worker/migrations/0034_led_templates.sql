-- 0034 LED 畫布版型（像 d3 的 feed map）第 1a 階段
-- 設計：docs/superpowers/specs/2026-10-15-led-canvas-templates-design.md；API：docs/led-templates-api.md
-- （0033 留給別的工作；這個檔案用 0034）
-- 只有加表、加欄位、加索引（不改舊資料、不重建表、不刪表）：
--   舊的歌 / 影片版本新欄位都是 NULL = 整張畫布（「全部」版型），畫面跟以前一樣。
--
--   led_templates         一個專案的版型。kind = 'full'（「全部」：現在的整張畫布，大小跟著 projects.led_canvas，canvas_w / canvas_h 是 NULL，
--                         不能改、不能刪）/ 'custom'（canvas_w × canvas_h = 這個版型的畫布，也就是 AE 要輸出的影片大小）
--                         scale_pct = 從 LED 真實點數縮成這個版型的比例（100 / 50 / 自訂）
--   led_screens           手動切的螢幕：一個模型物件裡有好幾塊螢幕時，在整張畫布上框出來（u0 v0 u1 v1 是整張畫布的 UV 比例，0~1）
--                         整個物件一塊的螢幕不用存：從模型的 UV 外框算
--   led_template_screens  某個版型把哪些螢幕放在哪裡（版型畫布的像素）、轉 90° 的倍數、翻轉
--                         screen_key：'o:<物件 id>'（整個物件一塊）或 's:<led_screens.id>'（手動切的）
--   songs.template_id     這首歌選的版型（NULL = 全部）；版型被刪 → 回到 NULL
--   song_videos.template_id / template_snapshot  這一版影片做的時候用的版型和當時的排法（JSON）；
--                         版型之後改了，舊影片照舊貼對。沒有 FK：版型刪掉了，影片的快照還在
CREATE TABLE IF NOT EXISTS led_templates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('full', 'custom')),
  canvas_w INTEGER CHECK (canvas_w IS NULL OR (canvas_w >= 16 AND canvas_w <= 32768)),
  canvas_h INTEGER CHECK (canvas_h IS NULL OR (canvas_h >= 16 AND canvas_h <= 32768)),
  scale_pct REAL NOT NULL DEFAULT 100 CHECK (scale_pct >= 1 AND scale_pct <= 400),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_led_templates_full ON led_templates(project_id) WHERE kind = 'full';
CREATE UNIQUE INDEX IF NOT EXISTS idx_led_templates_name ON led_templates(project_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_led_templates_project ON led_templates(project_id, sort_order);

CREATE TABLE IF NOT EXISTS led_screens (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  name TEXT NOT NULL,
  u0 REAL NOT NULL CHECK (u0 >= 0 AND u0 < 1),
  v0 REAL NOT NULL CHECK (v0 >= 0 AND v0 < 1),
  u1 REAL NOT NULL CHECK (u1 > 0 AND u1 <= 1),
  v1 REAL NOT NULL CHECK (v1 > 0 AND v1 <= 1),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (u1 > u0 AND v1 > v0),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_led_screens_project ON led_screens(project_id, object_id);

CREATE TABLE IF NOT EXISTS led_template_screens (
  template_id TEXT NOT NULL,
  screen_key TEXT NOT NULL,
  dest_x INTEGER NOT NULL,
  dest_y INTEGER NOT NULL,
  dest_w INTEGER NOT NULL CHECK (dest_w >= 1),
  dest_h INTEGER NOT NULL CHECK (dest_h >= 1),
  rotate INTEGER NOT NULL DEFAULT 0 CHECK (rotate IN (0, 90, 180, 270)),
  flip_h INTEGER NOT NULL DEFAULT 0 CHECK (flip_h IN (0, 1)),
  flip_v INTEGER NOT NULL DEFAULT 0 CHECK (flip_v IN (0, 1)),
  PRIMARY KEY (template_id, screen_key),
  FOREIGN KEY (template_id) REFERENCES led_templates(id) ON DELETE CASCADE
);

ALTER TABLE songs ADD COLUMN template_id TEXT REFERENCES led_templates(id) ON DELETE SET NULL;
ALTER TABLE song_videos ADD COLUMN template_id TEXT;
ALTER TABLE song_videos ADD COLUMN template_snapshot TEXT;

-- 每個舊專案自動有一個「全部」版型（新專案和舊版後台建的專案，後台第一次讀版型時也會補）
INSERT OR IGNORE INTO led_templates (id, project_id, name, kind, scale_pct, sort_order)
  SELECT 'lt_full_' || id, id, '全部', 'full', 100, 0 FROM projects;
