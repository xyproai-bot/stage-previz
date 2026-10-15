-- 比例尺的「樂手和器材」（導演 / 製作在 3D 畫面上擺的鼓組、鋼琴、各種樂手…），全專案所有人共用（只加一個欄位）
--   stage_props — JSON 陣列：[{ "id": "sp_ab12cd34", "type": "drummer", "x": 公尺, "y": 公尺, "z": 公尺, "rotY": 度 }]
--                 座標是 3D 場景原點為準的公尺（= 場景單位 × 測距校準倍率），y 是腳底站的高度；rotY 是繞 y 軸的角度（0 = 面向 +Z）
--                 種類、尺寸、檢查規則：web/src/lib/stageProps.ts（前後端共用同一個檔）
--   沒擺過的專案是 '[]'；舊版前端不認識這個欄位，照樣能用
ALTER TABLE projects ADD COLUMN stage_props TEXT NOT NULL DEFAULT '[]';
