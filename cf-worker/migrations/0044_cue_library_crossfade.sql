-- 0044 Cue 庫的 cue 自己有「轉場秒數」（預設值）；每首歌的 cue 可以另外設，沒另外設就用 Cue 庫的
-- 只新增欄位：不改、不刪任何舊資料
-- 現有資料的轉場完全不變：每個現有的 cue 的 crossfade_own 預設 1 = 「這首歌自己設的」，值照舊
ALTER TABLE library_cues ADD COLUMN crossfade_seconds REAL NOT NULL DEFAULT 1 CHECK (crossfade_seconds >= 0 AND crossfade_seconds <= 3600);
-- 1 = 這首歌的這個 cue 自己設的轉場（cues.crossfade_seconds 就是它）；0 = 用 Cue 庫的（cues.crossfade_seconds 跟著 Cue 庫的值同步，所以其他讀轉場的地方不用改）
ALTER TABLE cues ADD COLUMN crossfade_own INTEGER NOT NULL DEFAULT 1 CHECK (crossfade_own IN (0, 1));
