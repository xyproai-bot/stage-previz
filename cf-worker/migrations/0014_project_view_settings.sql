-- 專案共用的 3D 檢視設定（之前存在各自瀏覽器 localStorage，導演/動畫師/換電腦都看不到）
--   scale_correction  — 測距校準倍率（模型 scene units → 真實公尺），1 = 未校準
--   mechanism_offsets — 機關滑桿位移 JSON：{ "<stage_object_id>": { "x": 公尺, "y": 公尺 } }
ALTER TABLE projects ADD COLUMN scale_correction REAL NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN mechanism_offsets TEXT NOT NULL DEFAULT '{}';
