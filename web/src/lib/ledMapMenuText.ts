// 3D 工具列「⋯」→ LED 對位圖 那一段的下載選項怎麼叫（純函式，ledMapMenuText.test.ts 有測）。
//   這首歌沒有用自己排的版型 → 跟以前一模一樣（整張畫布的對位圖 / AE 合成腳本 / 位置表）
//   這首歌用了版型 → 每個下載都有兩個：「（版型 1）」跟著版型、「（整張畫布）」還是整張畫布的

export type LedDownloadKind = 'png' | 'jsx' | 'csv' | 'json';
/** timeline = true：這首歌有中途換版型，下載整條版型時間線（template 寫「版型時間線」） */
export type LedDownloadScope = 'plain' | 'full' | { template: string; timeline?: boolean };

const PLAIN: Record<LedDownloadKind, string> = {
  png: '下載對位圖（PNG）',
  jsx: '下載 AE 合成腳本（.jsx）',
  csv: '下載位置表（CSV）',
  json: '下載位置表（JSON）',
};

const BASE: Record<LedDownloadKind, string> = {
  png: '下載對位圖',
  jsx: '下載 AE 合成腳本',
  csv: '下載位置表 CSV',
  json: '下載位置表 JSON',
};

export function ledMapMenuLabel(kind: LedDownloadKind, scope: LedDownloadScope): string {
  if (scope === 'plain') return PLAIN[kind];
  return `${BASE[kind]}（${scope === 'full' ? '整張畫布' : scope.template}）`;
}

/** 滑鼠停上去的說明：版型的下載說清楚是版型畫布、和整張畫布差在哪 */
export function ledMapMenuHint(kind: LedDownloadKind, scope: LedDownloadScope): string | undefined {
  const name = typeof scope === 'object' ? scope.template : null;
  if (typeof scope === 'object' && scope.timeline) {
    switch (kind) {
      case 'png': return '這首歌中途換版型：每個版型各一張模板圖（一次下載好幾個檔案，瀏覽器問下載多個檔案請按允許），放進 AE 當各段的參考圖層';
      case 'jsx': return '下載一個 zip：每個版型一個資料夾，裡面每塊 LED 一張圖，加座標表和 AE 腳本。解壓縮後在 AE 按「File > Scripts > Run Script File…」（檔案 > 指令碼 > 執行指令碼檔案）跑：每個版型的每塊 LED 一個合成，再建一個整張畫布大小的總合成，每個版型的那一組只在那一段時間出現，換版型的時間在時間軸上有標記';
      case 'csv': return 'Excel 打得開：每個版型一個區段，寫清楚每塊螢幕的位置、轉向、翻轉、實際點數、比例，和每一段從什麼時候開始（給 LED 工程師、d3 操作員）';
      case 'json': return '給程式讀：跟 CSV 一樣的內容（整條版型時間線）';
    }
  }
  switch (kind) {
    case 'png':
      return name !== null
        ? `這首歌用的版型「${name}」的模板圖：版型畫布大小，每塊螢幕的長方形、名字、像素大小、指著上方的箭頭，放進 AE 當參考圖層`
        : '每塊 LED 在 AE 畫布上的位置：名字、x y w h、每 100 px 格線；可以直接放進 AE 當參考圖層';
    case 'jsx':
      return name !== null
        ? `在 AE 按「File > Scripts > Run Script File…」（檔案 > 指令碼 > 執行指令碼檔案）跑：下載的是 zip（每塊 LED 一張圖、座標表、AE 腳本），解壓縮後跑腳本：每塊 LED 建一個合成，再建一個版型「${name}」大小的總合成，每塊 LED 已經擺在正確位置`
        : '在 AE 按「File > Scripts > Run Script File…」（檔案 > 指令碼 > 執行指令碼檔案）跑：自動建好畫布大小的合成，每塊 LED 的外框、名字都是導引圖層（不會算圖出去）';
    case 'csv':
      return name !== null
        ? `Excel 打得開：版型「${name}」每塊螢幕的位置、轉向、翻轉、實際點數、比例，和它在整張畫布上的位置（給 LED 工程師、d3 操作員）`
        : 'Excel 打得開：每塊 LED 的名字和 x、y、w、h';
    case 'json':
      return name !== null ? `給程式讀：跟 CSV 一樣的內容（版型「${name}」）` : '給 AE 腳本 / 程式讀';
  }
}
