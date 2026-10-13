-- 專案共用的 3D 檢視設定（之前存在各自瀏覽器 localStorage，導演/動畫師/換電腦都看不到）
--   scale_correction   — 測距校準倍率（模型 scene units → 真實公尺），1 = 未校準
--   mechanism_offsets  — 機關滑桿位移 JSON：{ "<stage_object_id>": { "x": 公尺, "y": 公尺 } }
--   look_settings      — 現場模式設定 JSON：{ houseLight, exposure, ledLightStrength, bloomStrength, floorReflection, reflectionSharpness, ledViewFalloff }
--   material_overrides — 依 C4D 材質名稱的覆寫 JSON：{ "<材質名>": { color, roughness, metalness, envIntensity, opacity, mirrorFloor } }
--   home_view          — 「🎥 重置攝影機」的畫面 JSON：{ position: [x,y,z], target: [x,y,z], fov }（場景單位；NULL = 自動正面全景）
ALTER TABLE projects ADD COLUMN scale_correction REAL NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN mechanism_offsets TEXT NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN look_settings TEXT NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN material_overrides TEXT NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN home_view TEXT;
