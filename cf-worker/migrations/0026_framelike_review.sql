-- 審片像 Frame.io：留言記住 3D 視角、畫面上的畫記、區段（0:12–0:18）、縮圖；分享連結的訪客留言（預設關）。
-- 只有加欄位、加索引（不改舊資料）→ 舊版前端（ebd69bb）照樣能用：舊留言沒有這些欄位，API 格式跟以前一樣。
-- 規則在 cf-worker/comments.mjs（整理 / 檢查）、guestComments.mjs（訪客）、access.mjs（誰能做什麼）；
-- 測試：comments.test.mjs、guestComments.test.mjs、framelikeRoutes.test.mjs（node:sqlite 跑真的 SQL）。

-- ─── 留言 ───
--   time_end         區段留言的結束（秒）；NULL = 一個時間點（time_in_video 是開始）
--   view_json        留言當下的攝影機 {"position":[x,y,z],"target":[x,y,z],"fov":50,"aspect":1.78}
--   cue_id           留言當下的 cue（cue 刪掉了也留著，只是對不到）
--   annotation_json  畫記 {"v":1,"aspect":1.78,"shapes":[{"t":"arrow","c":"#ff3b30","w":0.006,"p":[x0,y0,x1,y1]}]}，座標 0~1
--   thumb_key        R2 上的縮圖（comment-thumbs/<專案>/<留言>-<隨機碼>.jpg，含畫記，約 480 px 寬）
--   guest_name       分享連結的訪客自己寫的名字；NULL = 團隊成員留的
--   share_token      從哪條分享連結留的（訪客只看得到同一條連結的留言串）
--   share_label      當時那條連結的名稱（連結刪掉了團隊還看得懂是哪裡來的）
ALTER TABLE comments ADD COLUMN time_end REAL;
ALTER TABLE comments ADD COLUMN view_json TEXT;
ALTER TABLE comments ADD COLUMN cue_id TEXT;
ALTER TABLE comments ADD COLUMN annotation_json TEXT;
ALTER TABLE comments ADD COLUMN thumb_key TEXT;
ALTER TABLE comments ADD COLUMN guest_name TEXT;
ALTER TABLE comments ADD COLUMN share_token TEXT;
ALTER TABLE comments ADD COLUMN share_label TEXT;

CREATE INDEX IF NOT EXISTS idx_comments_share ON comments(share_token, created_at);

-- ─── 分享連結 ───
--   allow_comments  1 = 允許看的人留言（只有製作能開）；舊的連結一律 0（關）
--   label           連結的名稱（例：給經紀人），團隊看訪客留言時顯示；NULL = 沒取名
ALTER TABLE share_links ADD COLUMN allow_comments INTEGER NOT NULL DEFAULT 0;
ALTER TABLE share_links ADD COLUMN label TEXT;
