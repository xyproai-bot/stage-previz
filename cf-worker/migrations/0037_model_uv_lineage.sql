-- 0037 自動貼 UV（第 4 階段）：模型版本記住「是從哪個版本套用出來的」
-- 只有加一個欄位（不改舊資料、不重建表、不刪表）：沒有值（NULL）= 這條線只有它自己，跟以前一模一樣。
--
--   model_uv_layouts.parent_key  套用自動貼 UV 當下使用中的模型版本（model_key）。
--                                連續套用兩次（v0 → v1 → v2）、來回換版本時，舊影片的「舊版面」保護要沿著這條線走：
--                                換到某個版本 = 這個版本和它所有祖先套用時改過的影片都要在「舊版面」上
ALTER TABLE model_uv_layouts ADD COLUMN parent_key TEXT;
