-- 0031 機關 v2 第 3 階段：一排機關（一次建立 N 個、一起動 / 依序 / 波浪 / 漸層）
-- 設計：docs/superpowers/specs/2026-10-15-mechanism-v2-design.md（第 1、2、5 節）
-- （設計文件原本寫 0029；0029 被「省空間」用掉、0030 是對開 / 翻轉，這一階段用 0031）
-- 只有加表和加欄位（不改舊資料、不重建表）：舊的機關 group_id / group_index 都是 NULL = 不在任何一排裡，畫面跟以前一樣。
--
--   mechanism_groups            一排機關的名字和順序；settings = JSON {"namePrefix":"LED 升降","numbering":"leftToRight"}（建立時的選項，編輯時看得到）
--   mechanisms.group_id         這個機關屬於哪一排（排被刪掉 → 回到 NULL，機關本身留著）
--   mechanisms.group_index      這一排裡的第幾個（0 起算；花樣「依序」「波浪」照這個順序）
-- 一排裡的每個機關都是普通機關（variant 是 NULL）：自己的物件、行程、速度、控台編號、每個 cue 一列位置；
--   花樣只是一次幫每個機關寫好它在這個 cue 的位置和延遲（一樣可以一個一個再改）。
-- 舊版前端（正式站）看到的就是一個一個普通機關，不認得 group 欄位：讀、存、排序、刪除都不會弄壞排；
--   舊版後台的 INSERT 用明確欄位，欄位多了也照樣寫得進去。
CREATE TABLE IF NOT EXISTS mechanism_groups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  "order" INTEGER NOT NULL DEFAULT 0,
  settings TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mechanism_groups_project ON mechanism_groups(project_id, "order");

ALTER TABLE mechanisms ADD COLUMN group_id TEXT REFERENCES mechanism_groups(id) ON DELETE SET NULL;
ALTER TABLE mechanisms ADD COLUMN group_index INTEGER;
CREATE INDEX IF NOT EXISTS idx_mechanisms_group ON mechanisms(group_id);
