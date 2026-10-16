-- 0036 自動貼 UV（第 1 階段）：模型版本記住它搭配的 LED 畫布和「舊版面」
-- 設計：docs/superpowers/specs/2026-10-16-auto-uv-design.md
-- 只有加表（不改舊資料、不重建表、不刪表）：沒有這張表的資料 = 跟以前一模一樣。
--
--   model_uv_layouts  某個專案的某個模型版本（model_key = R2 的路徑）搭配的資料：
--     led_canvas        那個版本搭配的整張 LED 畫布（JSON {width,height}；NULL = 那時候專案還沒設定畫布）。
--                       「模型版本」換回舊版時，畫布跟著換回來（不然對位圖、像素格、所有影片都會對不上）
--     recipe            自動貼 UV 當時填的東西（點數、排版），之後要重新編輯時讀回來；可以是 NULL
--     note              版本列上的說明（例如「自動貼 UV · 12 塊螢幕 · 9216×3072」）
--     legacy_template_id / legacy_plan / stamped_videos
--                       套用時自動建的「舊版面」版型 id、它的排法（JSON，跟影片版本的快照同一個格式）、
--                       被改成用「舊版面」的影片版本 id 清單（JSON 陣列）。換回舊版模型時把這些影片還原、再換回新版時重新套上
--     created_by / created_at
--   「套用前」的版本也會有一列（只有 led_canvas），這樣換回去時畫布才找得回來
CREATE TABLE IF NOT EXISTS model_uv_layouts (
  project_id TEXT NOT NULL,
  model_key TEXT NOT NULL,
  led_canvas TEXT,
  recipe TEXT,
  note TEXT,
  legacy_template_id TEXT,
  legacy_plan TEXT,
  stamped_videos TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, model_key),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
