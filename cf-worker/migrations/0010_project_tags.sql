-- Project 標籤系統（admin Tier 1 #20）
-- 用 JSON array 存（D1/SQLite 沒原生 array，用 TEXT JSON）

ALTER TABLE projects ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
