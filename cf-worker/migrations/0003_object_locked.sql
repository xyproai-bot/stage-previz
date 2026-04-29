-- 0003: stage_objects 加 locked 欄位（鎖定後 raycaster 不選、accordion 灰色）
ALTER TABLE stage_objects ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_stage_objects_locked ON stage_objects(locked);
