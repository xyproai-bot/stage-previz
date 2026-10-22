-- 0042 Cue 庫：專案層級的 cue（畫面），每首歌的 cue（cues 列）指到它
-- 只新增：不改、不刪任何舊表；舊專案（cue_library = 0）照以前的方式運作
CREATE TABLE IF NOT EXISTS library_cues (
  id TEXT PRIMARY KEY,                       -- 'lc_…'
  project_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 16),   -- 編號：用戶自己打的文字（1、3-1、301…），同專案不能重複
  name TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  based_on_id TEXT,                          -- 另存的來源（只記錄，畫面不靠它）
  migrated_from TEXT,                        -- JSON：搬家時從哪些 cues.id 來的；NULL = 在 Cue 庫建的
  rev INTEGER NOT NULL DEFAULT 0,            -- 畫面每改一次 +1（更新時檢查有沒有被別人改過）
  created_by_user_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (based_on_id) REFERENCES library_cues(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);
-- 去頭尾空白、不分大小寫，同一個專案不能有一樣的編號
CREATE UNIQUE INDEX IF NOT EXISTS idx_library_cues_label ON library_cues(project_id, lower(trim(label)));

-- 每個 Cue 庫的 cue 裡每個物件（沒有列 = 預設位置；欄位 NULL = 那個欄位用預設）
--   own = 1：這個 cue 自己設的（own_fields：1 位置 2 角度 4 大小 8 顯示 16 自訂；其他欄位是搬家時從前面的 cue 帶過來的值）
--   own = 0：整列都是搬家時從前面的 cue 帶過來的（畫面上寫「沿用」）
CREATE TABLE IF NOT EXISTS library_cue_object_states (
  library_cue_id TEXT NOT NULL,
  stage_object_id TEXT NOT NULL,
  position TEXT, rotation TEXT, scale TEXT,
  visible INTEGER CHECK (visible IS NULL OR visible IN (0, 1)),
  custom_props TEXT,
  own INTEGER NOT NULL DEFAULT 1 CHECK (own IN (0, 1)),
  own_fields INTEGER NOT NULL DEFAULT 0 CHECK (own_fields BETWEEN 0 AND 31),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (library_cue_id, stage_object_id),
  CHECK (own = 1 OR own_fields = 0),
  FOREIGN KEY (library_cue_id) REFERENCES library_cues(id) ON DELETE CASCADE,
  FOREIGN KEY (stage_object_id) REFERENCES stage_objects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lcos_object ON library_cue_object_states(stage_object_id);

-- 每個 Cue 庫的 cue 裡每個機關（沒有列 = 機關預設位置）
--   carried = 0：這個 cue 叫機器動（照自己的延遲 / 走幾秒；跟現在「自己設的」一樣）
--   carried = 1：位置是畫面的一部分，但不打斷正在往這裡走的機器（跟現在「沿用」一樣）；時間一定是 NULL
CREATE TABLE IF NOT EXISTS library_cue_mechanism_positions (
  library_cue_id TEXT NOT NULL,
  mechanism_id TEXT NOT NULL,
  value REAL NOT NULL,
  delay_sec REAL CHECK (delay_sec IS NULL OR (delay_sec >= 0 AND delay_sec <= 3600)),
  duration_sec REAL CHECK (duration_sec IS NULL OR (duration_sec >= 0 AND duration_sec <= 3600)),
  carried INTEGER NOT NULL DEFAULT 0 CHECK (carried IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (library_cue_id, mechanism_id),
  CHECK (carried = 0 OR (delay_sec IS NULL AND duration_sec IS NULL)),
  FOREIGN KEY (library_cue_id) REFERENCES library_cues(id) ON DELETE CASCADE,
  FOREIGN KEY (mechanism_id) REFERENCES mechanisms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_lcmp_mechanism ON library_cue_mechanism_positions(mechanism_id);

-- 每首歌的 cue 指到哪個 Cue 庫的 cue（NULL = 還沒搬，舊模式的專案）
-- 外鍵不加 ON DELETE：還有歌在用就刪不掉；刪整個專案時同一個陳述式 cascade 兩邊，結束時檢查 → 刪得掉
ALTER TABLE cues ADD COLUMN library_cue_id TEXT REFERENCES library_cues(id);
CREATE INDEX IF NOT EXISTS idx_cues_library ON cues(library_cue_id);

-- 0 = 跟以前一樣（每首歌自己的 cue、沿用前面的 cue）；1 = Cue 庫
ALTER TABLE projects ADD COLUMN cue_library INTEGER NOT NULL DEFAULT 0;
