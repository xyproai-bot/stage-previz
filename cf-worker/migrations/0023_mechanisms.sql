-- 0023 機關系統：每個機關設定一次（帶哪些物件、方向、行程、速度、常用位置），每個 cue 存自己的機關位置。
-- （0022 是邀請連結；兩個 migration 沒有相依）
-- 設計：docs/superpowers/specs/2026-10-14-mechanism-system-design.md
--
-- mechanisms
--   kind           'linear' 直線移動 / 'rotary' 旋轉
--   axis           JSON {x,y,z}：場景座標的單位向量。直線 = 數字變大時往哪裡動；旋轉 = 轉軸（右手定則決定正的角度）
--   pivot          JSON {x,y,z}：旋轉中心，場景單位（跟 cue 位置同一種單位）；直線 = NULL
--   travel_min/max 行程（直線：公尺；旋轉：度）。0 = 物件在 cue 裡原本的位置
--   default_value  沒有 cue 設定時的位置
--   max_speed      最高速度（公尺/秒、度/秒）；NULL = 不檢查速度，照轉場秒數移動
--   presets        JSON [{"name":"全開","value":3.5}]：常用位置，最多 12 個
--   parent_id      裝在哪個機關上（例：轉台上的升降台）→ 跟著那個機關一起動
--   console_label  自動化控台上的軸名（選填，匯出機關總表用）
--   metadata       JSON，之後放加減速、碰撞外框等；現在 NULL
--   legacy_object_id / legacy_axis  從舊的「全專案機關滑桿」轉過來的（哪片 LED、'x' 或 'y'）；新建的是 NULL
--   edited_at      在新介面改過（定義，或任何 cue 的位置）的時間；NULL = 沒改過，舊滑桿的修改還會同步過來
CREATE TABLE IF NOT EXISTS mechanisms (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('linear', 'rotary')),
  axis TEXT NOT NULL DEFAULT '{"x":0,"y":1,"z":0}',
  pivot TEXT,
  travel_min REAL NOT NULL DEFAULT 0,
  travel_max REAL NOT NULL DEFAULT 1,
  default_value REAL NOT NULL DEFAULT 0,
  max_speed REAL,
  presets TEXT NOT NULL DEFAULT '[]',
  parent_id TEXT,
  console_label TEXT,
  "order" INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  legacy_object_id TEXT,
  legacy_axis TEXT,
  edited_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (travel_max > travel_min),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES mechanisms(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_mechanisms_project ON mechanisms(project_id, "order");

-- 機關帶哪些物件（一組）。一個物件只能「直接」放在一個機關（要疊就用 parent_id）
CREATE TABLE IF NOT EXISTS mechanism_objects (
  mechanism_id TEXT NOT NULL,
  stage_object_id TEXT NOT NULL,
  PRIMARY KEY (mechanism_id, stage_object_id),
  FOREIGN KEY (mechanism_id) REFERENCES mechanisms(id) ON DELETE CASCADE,
  FOREIGN KEY (stage_object_id) REFERENCES stage_objects(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mechanism_objects_object ON mechanism_objects(stage_object_id);

-- 每個 cue 自己設的機關位置（沒有 = 沿用前面的 cue / 預設位置）
CREATE TABLE IF NOT EXISTS cue_mechanism_positions (
  cue_id TEXT NOT NULL,
  mechanism_id TEXT NOT NULL,
  value REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (cue_id, mechanism_id),
  FOREIGN KEY (cue_id) REFERENCES cues(id) ON DELETE CASCADE,
  FOREIGN KEY (mechanism_id) REFERENCES mechanisms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cmp_mechanism ON cue_mechanism_positions(mechanism_id);

-- ── 舊的全專案機關滑桿 → 機關（畫面不能變）────────────────────────────
-- 跟以前一樣只看 LED 面板、0 不轉。每片 LED：
--   只有左右 → 「<名稱> 左右」帶這片 LED；只有上下 → 「<名稱> 上下」帶這片 LED；
--   兩個都有 → 「上下」帶 LED、「上下」裝在「左右」上（兩個位移加起來 = 以前的位置）
-- 預設位置 = 舊位移；行程 = 舊滑桿的 -10 ~ 10 公尺（舊值超過就放寬到包含它）；不填速度 → 不檢查、不會慢下來
-- id 固定（mlx_ / mly_ + 物件 id）→ 重跑也不會多出來，後台同步舊滑桿時也找得到
-- 跟 web/src/lib/mechanisms/model.ts 的 legacyOffsetsToMechanisms 一模一樣（cf-worker/mechanisms.test.mjs 有比對）
INSERT OR IGNORE INTO mechanisms
  (id, project_id, name, kind, axis, pivot, travel_min, travel_max, default_value, max_speed, presets,
   parent_id, "order", legacy_object_id, legacy_axis)
WITH legacy AS (
  SELECT p.id AS project_id, o.id AS object_id, o."order" AS object_order,
         COALESCE(NULLIF(TRIM(o.display_name), ''), o.mesh_name) AS label,
         COALESCE(CAST(json_extract(j.value, '$.x') AS REAL), 0) AS x,
         COALESCE(CAST(json_extract(j.value, '$.y') AS REAL), 0) AS y
    FROM projects p
    JOIN json_each(CASE WHEN json_valid(p.mechanism_offsets) THEN p.mechanism_offsets ELSE '{}' END) j
    JOIN stage_objects o ON o.id = j.key AND o.project_id = p.id AND o.category = 'led_panel'
)
SELECT 'mlx_' || object_id, project_id, label || ' 左右', 'linear', '{"x":1,"y":0,"z":0}', NULL,
       MIN(-10, x), MAX(10, x), x, NULL, '[]', NULL, object_order * 2, object_id, 'x'
  FROM legacy WHERE x != 0;

INSERT OR IGNORE INTO mechanisms
  (id, project_id, name, kind, axis, pivot, travel_min, travel_max, default_value, max_speed, presets,
   parent_id, "order", legacy_object_id, legacy_axis)
WITH legacy AS (
  SELECT p.id AS project_id, o.id AS object_id, o."order" AS object_order,
         COALESCE(NULLIF(TRIM(o.display_name), ''), o.mesh_name) AS label,
         COALESCE(CAST(json_extract(j.value, '$.x') AS REAL), 0) AS x,
         COALESCE(CAST(json_extract(j.value, '$.y') AS REAL), 0) AS y
    FROM projects p
    JOIN json_each(CASE WHEN json_valid(p.mechanism_offsets) THEN p.mechanism_offsets ELSE '{}' END) j
    JOIN stage_objects o ON o.id = j.key AND o.project_id = p.id AND o.category = 'led_panel'
)
SELECT 'mly_' || object_id, project_id, label || ' 上下', 'linear', '{"x":0,"y":1,"z":0}', NULL,
       MIN(-10, y), MAX(10, y), y, NULL, '[]',
       CASE WHEN x != 0 THEN 'mlx_' || object_id END, object_order * 2 + 1, object_id, 'y'
  FROM legacy WHERE y != 0;

INSERT OR IGNORE INTO mechanism_objects (mechanism_id, stage_object_id)
WITH legacy AS (
  SELECT p.id AS project_id, o.id AS object_id, o."order" AS object_order,
         COALESCE(NULLIF(TRIM(o.display_name), ''), o.mesh_name) AS label,
         COALESCE(CAST(json_extract(j.value, '$.x') AS REAL), 0) AS x,
         COALESCE(CAST(json_extract(j.value, '$.y') AS REAL), 0) AS y
    FROM projects p
    JOIN json_each(CASE WHEN json_valid(p.mechanism_offsets) THEN p.mechanism_offsets ELSE '{}' END) j
    JOIN stage_objects o ON o.id = j.key AND o.project_id = p.id AND o.category = 'led_panel'
)
SELECT CASE WHEN y != 0 THEN 'mly_' ELSE 'mlx_' END || object_id, object_id
  FROM legacy WHERE x != 0 OR y != 0;
