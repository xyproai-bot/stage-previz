-- 0030 機關 v2 第 2 階段：對開（兩邊往反方向）和翻轉（沿著邊緣翻）
-- 設計：docs/superpowers/specs/2026-10-15-mechanism-v2-design.md（第 1、2、3、5 節）
-- （0029 留給別的工作；設計文件原本寫的 0028 已經被留言參考圖片用掉，這一階段改用 0030）
-- 只有加欄位（不改舊資料、不重建表）：舊的機關三欄都是 NULL = 一般機關，畫面跟以前一樣。
--
--   mechanisms.variant         NULL 一般 | 'split' 對開（之後的階段還會有 'hoist_rig' 吊掛 / 'hoist' 吊點）
--   mechanisms.mirror          只有對開：B 邊的 JSON {"axis":{x,y,z},"pivot":{x,y,z}|null,"consoleLabel":"Axis 8"|null}
--                              （A 邊就是機關本來的方向 / 轉軸 / 控台編號；B 邊用同一個位置，往鏡像的方向動）
--   mechanism_objects.side     只有對開：NULL 或 'a' = A 邊，'b' = B 邊
-- 翻轉（沿著上緣 / 下緣 / 左緣 / 右緣 / 前緣 / 後緣翻）不用新欄位：它還是旋轉機關，
--   轉軸和轉軸中心算好存在原本的欄位，選的邊緣記在 metadata.setup（編輯時才看得到原本的選擇）。
-- 舊版前端（正式站）讀機關時後台不給 variant 不是 NULL 的機關（網址沒帶 ?mech=2）→ 對開的零件在舊版畫面是靜止的，不會往錯的方向動；
--   翻轉是普通的旋轉機關，舊版照樣會動。舊版後台用明確欄位的 INSERT，欄位多了也照樣寫得進去。
ALTER TABLE mechanisms ADD COLUMN variant TEXT CHECK (variant IS NULL OR variant IN ('split', 'hoist_rig', 'hoist'));
ALTER TABLE mechanisms ADD COLUMN mirror TEXT;
ALTER TABLE mechanism_objects ADD COLUMN side TEXT CHECK (side IS NULL OR side IN ('a', 'b'));
