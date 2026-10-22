-- 0040 物件「預設隱藏」
-- 只有加一個欄位（不改舊資料、不重建表、不刪表）：0 = 跟以前一模一樣（沒有 cue 設定顯示 / 隱藏的歌，這個物件都顯示）。
--
--   stage_objects.default_hidden  1 = 預設隱藏：一首歌裡「到這個 cue 為止都沒有人設過顯示 / 隱藏」的 cue，這個物件是隱藏的；
--                                 cue 裡明確設成顯示的照樣顯示（要在哪首歌出現，就在那首歌的 cue 裡把它設成顯示）。
--                                 例：只有第一首歌用的瞬掉緞帶，不用每首新歌再手動把它藏起來。
ALTER TABLE stage_objects ADD COLUMN default_hidden INTEGER NOT NULL DEFAULT 0;
