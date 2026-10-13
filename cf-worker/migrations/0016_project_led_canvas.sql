-- AE 畫布尺寸（LED 內容的合成大小）：動畫師用 NDI Webcam 預覽時，瀏覽器收到的是 16:9 虛擬攝影機畫面，
-- 要知道 AE 合成原本的寬高才能把畫面放回 LED 的 UV 排版上。admin 每個專案填一次（例：金馬 2026 = 10496 × 5120）。
--   led_canvas — JSON：{ "width": 整數, "height": 整數 }（各 16~32768；NULL = 還沒填）
ALTER TABLE projects ADD COLUMN led_canvas TEXT;
