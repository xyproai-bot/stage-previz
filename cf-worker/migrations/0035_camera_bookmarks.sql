-- 視角書籤（導演 / 製作在 3D 畫面上存的視角），全專案所有人共用（只加一個欄位）
--   camera_bookmarks — JSON 陣列：[{ "id": "cb_ab12cd34", "name": "控台看舞台", "position": [x, y, z], "target": [x, y, z], "fov": 度 }]
--                      座標是 3D 場景單位（模型自己的座標，跟 home_view 同一種）；順序就是畫面上的順序
--                      格式、數量上限、檢查規則：web/src/lib/cameraBookmarks.ts（前後端共用同一個檔）
--   沒存過的專案是 '[]'；舊版前端不認識這個欄位，照樣能用（舊版的視角還是存在各自電腦的 localStorage）
ALTER TABLE projects ADD COLUMN camera_bookmarks TEXT NOT NULL DEFAULT '[]';
