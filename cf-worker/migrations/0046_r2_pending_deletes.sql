-- 永久刪除影片版本時，R2 沒刪成功的檔案記在這裡，排程（cron purge）之後補刪，補到刪成功就從這張表拿掉。
--   r2_key      R2 上的位置（主鍵；同一個重複記也只有一列）
--   attempts    補刪試過幾次
--   last_error  最近一次失敗的原因
CREATE TABLE IF NOT EXISTS r2_pending_deletes (
  r2_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
