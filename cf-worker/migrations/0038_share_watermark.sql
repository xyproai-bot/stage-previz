-- 0038 浮水印與禁止下載
-- 只加欄位（不改舊資料、不重建表、不刪表）。舊連結全部是 0（關）：上線後行為跟以前一模一樣，要製作自己去打開。
-- 新建立的連結預設兩個都開（預設值寫在程式裡：web/src/lib/watermark/policy.ts，後台建連結時沒給就用開）。
--
--   share_links.watermark          1 = 這條連結的訪客看 3D 畫面 / 影片時加浮水印（誰在看 + 日期時間）
--   share_links.no_download        1 = 禁止下載：影片網址要帶短效播放通行證（綁這條連結 + 這支影片），
--                                      沒帶 / 過期就不給檔案；畫面上拿掉下載按鈕（cf-worker/shareMedia.mjs）
--   projects.watermark_members     1 = 專案成員（製作、導演、動畫師）看片也加浮水印；預設 0；只有製作可以改
ALTER TABLE share_links ADD COLUMN watermark INTEGER NOT NULL DEFAULT 0;
ALTER TABLE share_links ADD COLUMN no_download INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN watermark_members INTEGER NOT NULL DEFAULT 0;
