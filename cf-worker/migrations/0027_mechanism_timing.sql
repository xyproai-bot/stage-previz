-- 0027 機關 v2 第 1 階段：每個 cue 每個機關自己的時間（延遲幾秒開始動、走幾秒）
-- 設計：docs/superpowers/specs/2026-10-15-mechanism-v2-design.md
-- 只有加欄位（不改舊資料）：舊的位置兩欄都是 NULL = 跟著 cue（延遲 0、走 = 轉場），畫面跟以前一樣。
-- 舊版前端只送 { value } → 後台用 ON CONFLICT … SET value 只改位置，時間不會被清掉。
--
--   delay_sec     GO 之後幾秒開始動（0 ~ 3600）；NULL = 0
--   duration_sec  走幾秒（0 ~ 3600，0 = 直接切換）；NULL = 跟著這個 cue 的轉場
-- 時間跟著「這個 cue 自己設的位置」那一列：回到沿用（刪掉那一列）時間也一起清掉；不會沿用到下一個 cue。
ALTER TABLE cue_mechanism_positions ADD COLUMN delay_sec REAL CHECK (delay_sec IS NULL OR (delay_sec >= 0 AND delay_sec <= 3600));
ALTER TABLE cue_mechanism_positions ADD COLUMN duration_sec REAL CHECK (duration_sec IS NULL OR (duration_sec >= 0 AND duration_sec <= 3600));
