-- 0032 機關 v2 第 4 階段：吊掛 / 飛行（單點、多點）
-- 設計：docs/superpowers/specs/2026-10-15-mechanism-v2-design.md（第 1、2、3、5 節 Stage 4）
-- （設計文件原本沒寫確切號碼；0028 留言參考圖片、0029 省空間、0030 對開 / 翻轉、0031 一排機關都用掉了，這一階段用 0032）
-- 只有加欄位和索引（不改舊資料、不重建表）：舊的機關三欄都是 NULL = 一般機關，畫面跟以前一樣。
--
-- 一組吊掛 = 一個「整組」+ 2～4 個「吊點」，都是 mechanisms 的一列：
--   整組   variant = 'hoist_rig'：帶動物件（mechanism_objects）、自己沒有位置（kind = 'linear'，行程 0~1 只是湊數）
--   吊點   variant = 'hoist'    ：往上的直線機關，有自己的行程、最高速度、控台編號、每個 cue 的位置和延遲；沒有物件、不裝在別的機關上
--   （variant 的 CHECK 在 0030 就允許 'hoist_rig' / 'hoist' 了，這裡不用動）
--   mechanisms.rig_id     吊點屬於哪一組吊掛（整組被刪掉 → 吊點跟著刪）
--   mechanisms.rig_index  第幾個吊點（0 起算，照這個順序排）
--   mechanisms.attach     吊點在物件上的位置 JSON {"x":0,"y":0,"z":0}（場景單位，cue 位置的座標）；每個吊點拉高 h，整片物件依此傾斜
-- 舊版前端（正式站）讀機關時網址只帶 ?mech=2（或沒帶）→ 後台不給 'hoist_rig' / 'hoist'（它們的零件在舊版畫面是靜止的，不會往錯的方向動）；
--   新版前端讀機關和位置的網址帶 ?mech=3 才給吊掛。舊版後台用明確欄位的 INSERT，欄位多了也照樣寫得進去。
ALTER TABLE mechanisms ADD COLUMN rig_id TEXT REFERENCES mechanisms(id) ON DELETE CASCADE;
ALTER TABLE mechanisms ADD COLUMN rig_index INTEGER;
ALTER TABLE mechanisms ADD COLUMN attach TEXT;
CREATE INDEX IF NOT EXISTS idx_mechanisms_rig ON mechanisms(rig_id);
