-- 0047：機關「沿弧形軌道」（API 的 variant = 'arc'）的軌道半徑（公尺）
--   圓心用 pivot（跟旋轉機關的轉軸中心同一種座標）、轉軸用 axis（正負決定「值變大往哪邊走」）、行程 / 預設 / 常用位置照舊是公尺（沿弧線量）。
-- 只有加欄位（不改舊資料、不重建表）：舊的機關 arc_radius 都是 NULL = 一般機關，畫面跟以前一樣。
-- 注意：0030 的 variant 欄位有 CHECK（只收 NULL / 'split' / 'hoist_rig' / 'hoist'），SQLite 不能改 CHECK 又不准重建表，
--   所以弧形機關在資料庫裡 variant 還是 NULL，用「arc_radius 有值（> 0）」表示它是弧形；後台讀出來才變成 variant = 'arc'（cf-worker/mechanisms.mjs）。
--   好處：舊版前端 / 舊版後台讀到它就是一般直線機關（variant 是 NULL），不會壞。
ALTER TABLE mechanisms ADD COLUMN arc_radius REAL;
