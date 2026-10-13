-- 分享連結的「好讀網址」：/s/<slug>（例：/s/jinma2026-k7p2），可選
--   slug — 小寫 a-z、0-9、「-」，3～40 字，開頭英數字（規則在 web/src/lib/shareSlug.ts，worker 也用同一份）
--          NULL = 沒有好讀網址（只有舊式 /share/<token>）
-- 每個 slug 只能屬於一條連結（UNIQUE；SQLite 的 UNIQUE 允許很多個 NULL）。
-- 換 slug = 直接覆蓋，舊的 slug 馬上失效；舊式 /share/<token> 一直有效。
ALTER TABLE share_links ADD COLUMN slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_share_links_slug ON share_links(slug);
