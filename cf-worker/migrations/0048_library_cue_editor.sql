-- 0048：Cue 庫的 cue 記「最後一次改畫面的是誰」（導演存回舞台時，被別人搶先改過要告訴他「剛剛被 ○○ 改過」）
--   updated_by_user_id  最後一次改機關位置 / 整個畫面的人
--   updated_by_rev      他改完之後的 rev。跟現在的 rev 對不上 = 後來又有別的寫入（舊版前端的舊網址、拆開對開…）沒有記人，
--                       這時候不亂指名，只說「被別人改過」
-- 只有加欄位（不改舊資料、不重建表）：舊的 cue 兩個欄位都是 NULL。
-- 匯出 / 匯入 / 複製專案 / 備份：複製專案和匯入是照欄位名單寫的，不帶這兩個欄位（換了專案，用戶 id 沒有意義）；
--   整個資料庫的備份是照 sqlite_master 的表，欄位自然一起在裡面。
ALTER TABLE library_cues ADD COLUMN updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE library_cues ADD COLUMN updated_by_rev INTEGER;
