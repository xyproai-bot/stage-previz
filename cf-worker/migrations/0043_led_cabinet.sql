-- 0043 LED 版型的「箱體大小」（測試圖網格一格 = 一片 LED 箱體）
-- 只有加欄位（不改舊資料、不重建表、不刪表）：
--   led_templates.cabinet_w / cabinet_h         整個版型預設的箱體大小（像素）；NULL = 沒設 = 預設 128 × 128（0.5m × 0.5m）
--   led_template_screens.cabinet_w / cabinet_h  這塊螢幕自己的箱體大小；NULL = 跟版型的預設
-- 兩個欄位要一起有、一起沒有；範圍 16 ~ 4096（跟前端 lib/ledCabinet.ts 的 CABINET_RANGE 一樣）。
-- 舊版後台的 INSERT 不寫這幾個欄位，照樣寫得進去（= NULL = 預設）。
ALTER TABLE led_templates ADD COLUMN cabinet_w INTEGER CHECK (cabinet_w IS NULL OR (cabinet_w >= 16 AND cabinet_w <= 4096));
ALTER TABLE led_templates ADD COLUMN cabinet_h INTEGER CHECK (cabinet_h IS NULL OR (cabinet_h >= 16 AND cabinet_h <= 4096));
ALTER TABLE led_template_screens ADD COLUMN cabinet_w INTEGER CHECK (cabinet_w IS NULL OR (cabinet_w >= 16 AND cabinet_w <= 4096));
ALTER TABLE led_template_screens ADD COLUMN cabinet_h INTEGER CHECK (cabinet_h IS NULL OR (cabinet_h >= 16 AND cabinet_h <= 4096));
