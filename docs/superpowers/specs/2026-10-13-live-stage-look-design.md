# 現場模式：演唱會實拍光感 + 可調材質 — 設計

日期：2026-10-13　狀態：用戶已同意方向與順序

## 目標

3D 預覽要像「演唱會現場用相機拍」：全場暗、LED 是主要光源、LED 顏色染到舞台、亮面地板映出 LED、
LED 面板有真實質感、亮處有相機光暈。舞台材質照 C4D 材質名稱可調，全專案共用（只有 admin 能改）。

不在這次範圍：舞台燈具、煙霧 / 光束、離線 / path tracing 出圖。

## 現況問題（2026-10-13 走查）

| 現象 | 原因 |
|---|---|
| Realistic / Cinematic 舞台都像白天的白色石膏模型 | `scene.environment` 用 RoomEnvironment（明亮攝影棚）PMREM，所有非 LED 材質 envMapIntensity 1 |
| LED 打到舞台的光永遠是白色、位置怪 | RectAreaLight 顏色 = tint（預設白）；尺寸寫死 `2×scale.x / 1.2×scale.y`；放在 pivot、lookAt 寫死方向 |
| 亮面反射的是白色攝影棚 | 同上 environment |
| C4D 材質（黑亮+銀蔥、霧銀…）被洗掉 | 材質 effect 用 `materialProps ?? 預設 0.1/0.6` 覆蓋 GLB 原本的 metalness / roughness / color |
| Cinematic 的 LED 顏色灰灰的 | composer 的 OutputPass 會對整張圖做 ACES，LED 的 `toneMapped=false` 在 composer 路徑沒效 |
| 鎖頭圖示一直蓋在畫面上 | lock pin layer 設計成永遠顯示，連唯讀頁也顯示 |

## 模式

- **快速（quick）**：保留。不打光、LED 像素 1:1，給動畫師對顏色。
- **現場（live）**：取代 realistic + cinematic。舊的 `defaultRenderMode="realistic" | "cinematic"` 一律視為 live。
  工具列按鈕在兩個模式間切換。

## 現場模式組成

### 1. 暗場 + 底光 + 相機
- 背景近黑；grid / axes 在 live 隱藏。
- 移除 RoomEnvironment 當光源。「現場底光」= hemisphere + ambient，強度可調（預設很低，結構剛好看得到）。
- Tone mapping 改 `NeutralToneMapping`（Khronos PBR Neutral，保留 LED 飽和色）；「曝光」可調。
- live 一律走 composer（RenderPass → Bloom → OutputPass），tone mapping 由 OutputPass 統一做。

### 2. LED 照明（依畫面顏色）
- 模型載入後，對每個 LED 物件把三角形依法線分群（角度門檻約 35°，曲面會分成幾段），每群算：
  面積加權中心、法線、在切平面上的寬高、UV 範圍（套 fract 後）。
- 每群一盞 RectAreaLight：位置 = 中心沿法線推一點點，lookAt(中心 + 法線)，寬高 = 群的尺寸。
- **顏色 / 強度來自畫面內容**：每 ~100ms 把目前 LED 貼圖（NDI live / mock / 自訂圖片）畫到 64×32 小 canvas，
  對每群的 UV 範圍取平均色（線性空間）。color = 平均色正規化；intensity ∝ 亮度 × LED 照明強度設定。
- 上限：全場最多 24 盞（超過就合併小群）；iPad 最多 8 盞。
- 動態 LED 環境光：場景中央一個 CubeCamera 只拍 LED（layer 隔離），128px，PMREM 後當 `scene.environment`。
  效果：所有物件被 LED 顏色微微染色、亮面材質映出 LED。每 ~200ms 更新一次（iPad 1 秒）。

### 3. 光暈
- UnrealBloomPass：threshold / strength / radius 調成「只有亮的 LED 會暈開」，「光暈強度」可調。
- iPad 半解析度 bloom。

### 4. LED 面板質感（第二段）
- LED 材質 onBeforeCompile：
  - 像素格：依貼圖解析度算 `fract(uv × texSize)` 做像素遮罩；`fwidth` 判斷螢幕上像素太小時淡出，避免摩爾紋。
  - 暗處黑亮面：base 黑、roughness 約 0.3，會映到其他 LED（靠第 2 點的動態環境）。
  - 側看變暗：emissive × 視角衰減（可調）。

### 5. 地板倒影（第三段）
- 材質可勾「鏡面地板」。取勾選材質中面積最大的水平面高度當反射平面，半解析度鏡像渲染一次，
  依材質粗糙度模糊後用螢幕座標貼回（MeshReflectorMaterial 的簡化版）；fresnel 混合。
- 「倒影清晰度」可調。iPad 預設關。

### 6. 材質面板（第四段）
- 模型載入時記下每個 GLB 材質原本的參數（color / metalness / roughness / opacity / map…）當預設。
- 依材質名稱覆寫：顏色、亮面↔霧面（roughness）、金屬感、反射強度（envMapIntensity）、透明度、鏡面地板開關。
- 存在專案上：`projects.material_overrides`（JSON：`{ [materialName]: {...} }`），admin 才能改、大家共用。
- 一般物件不再被 category 顏色 / 預設值蓋掉；舊的 per-object materialProps 仍然優先（相容）。

### 現場設定（全專案共用）
- `projects.look_settings`（JSON）：底光、曝光、LED 照明強度、光暈強度、倒影清晰度、LED 側看衰減。
- 沿用 `useProjectViewSettings`（同一套存檔 / admin 限定 / 防抖），跟校準倍率、機關滑桿同一個 hook。
- migration 0014 尚未上到正式 D1 → 直接把這兩欄加進 0014。

### 鎖頭圖示
- 只在可編輯頁（非 readOnly）且 Label 開著時顯示；導演、動畫師、分享頁不顯示。

## 效能

- 偵測觸控 / 小螢幕（iPad）→ 低畫質檔：pixelRatio 1、燈數 8、環境更新 1 秒、bloom 半解析度、倒影預設關。
- 只有 live 模式才跑 LED 取色、CubeCamera、composer。

## 驗證

- 本機 dev + 真 NDI（AE → helper）+ 兩個實際模型（2026 金曲獎、主舞臺）。
- 每段完成給用戶看截圖 / 本機畫面；Quick 模式畫面不能變。
- type-check + build；不能有新的 console error。

## 實作順序（用戶確認）

1. 現場模式（暗場 / 底光 / 曝光 / Neutral tone mapping）+ LED 照明 + 光暈 + 現場設定 + 鎖頭
2. LED 面板質感
3. 地板倒影
4. 材質面板
