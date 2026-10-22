-- 0045 自動貼 UV「不放進畫布」的 LED 在 3D 上一律顯示黑色（像沒通電）
-- 只新增欄位：不改、不刪任何舊資料。NULL = 沒有（舊專案完全不變）
-- 內容 = JSON 字串陣列：「物件id」= 整個物件不放進畫布；「物件id~mesh 名稱」= 物件裡那一塊 LED 不放進畫布
-- 跟著模型版本走（套用時寫、換版本時換成那個版本的）；真正的來源是 model_uv_layouts.recipe
ALTER TABLE projects ADD COLUMN led_off_pieces TEXT;
