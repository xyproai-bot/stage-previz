// 模型壓縮的設定（瀏覽器的壓縮 worker、測試共用同一份）
//
// 用 Draco（KHR_draco_mesh_compression）：只壓「形狀」（頂點、UV、法線、三角形），
// 節點的名稱、階層、位置、旋轉、縮放一個字都不動 → 已經存好的 cue 位置不受影響。
// 不用 KHR_mesh_quantization / meshopt 量化：那些會把縮放搬到節點上，等於改了節點的 transform。
//
// 精度：位置、UV 用 24 bits（每個 mesh 自己的範圍切 1677 萬格），誤差 ≤ 範圍 ÷ 3355 萬，
// 跟 float32 本身的精度同一個等級（LED 對位圖、測試圖、負的 v UV 都對得一樣）。
// 法線 16 bits（只影響打光，看不出差別）。

/** Draco 每種資料用幾個 bits（gltf-transform KHRDracoMeshCompression 的 quantizationBits） */
export const DRACO_QUANTIZATION_BITS = {
  POSITION: 24,
  NORMAL: 16,
  COLOR: 16,
  TEX_COORD: 24,
  GENERIC: 24,
} as const;

/** gltf-transform KHRDracoMeshCompression.setEncoderOptions 的內容 */
export const DRACO_ENCODER_OPTIONS = {
  method: 1,            // EDGEBREAKER（壓得最小；會重排頂點順序，不影響畫面）
  encodeSpeed: 5,
  decodeSpeed: 5,       // 5 / 5：實測檔案最小、解壓也快
  quantizationBits: { ...DRACO_QUANTIZATION_BITS },
  quantizationVolume: 'mesh' as const,
};

/** 壓完至少要小到原本的幾成才值得換（不然就上傳原檔） */
export const MIN_SIZE_RATIO = 0.9;

/**
 * 比對原檔和壓縮檔用的容許誤差（全部都要過才會上傳壓縮檔）
 *   - 位置 / UV / 其他小數資料：範圍的 2^-21（約 0.5 ppm）；24 bits 的實際誤差最多 2^-25，留 16 倍空間
 *   - 法線：方向（正規化後）每個分量差 ≤ 0.002
 *   - 顏色：≤ 1/2048
 *   - 節點的世界矩陣：每個數字差 ≤ 1e-6 ×（1 和兩邊絕對值的最大值）
 *   - 整個場景的外框：差 ≤ 1e-5 × 對角線長度；自動縮放倍率要一模一樣
 */
export const TOLERANCE = {
  floatRel: 2 ** -21,
  normalAbs: 2e-3,
  colorAbs: 1 / 2048,
  matrixRel: 1e-6,
  bboxRel: 1e-5,
  ledSpan: 1e-6,
} as const;

/** 比對時頂點互相比較的總次數上限（一大堆頂點疊在同一點的怪模型 → 不硬算，直接不壓縮） */
export const MATCH_WORK_FACTOR = 64;
