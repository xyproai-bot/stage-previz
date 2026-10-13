// 下載連結統一放這裡（分享頁、3D 舞台的 NDI 面板、設定頁都用這份）
//
// NDI 小程序從我們自己的網域下載（中國大陸連 GitHub 很慢或連不上）：
//   後台（cf-worker/downloads.mjs）把 GitHub 最新發佈版的檔案存一份在 R2，最多 30 分鐘檢查一次新版，
//   檔名固定，換版本不用改這裡；後台抓不到時會自己轉去 GitHub。

/** NDI 小程序（Windows 安裝檔） */
export const NDI_HELPER_DOWNLOAD_URL =
  'https://proxy.haimiaan.com/downloads/stage-previz-ndi-helper-windows.msi';

/** NDI 官方免費工具（AE 送 NDI 要裝它） */
export const NDI_TOOLS_URL = 'https://ndi.video/tools/';

/** NDI 小程序（Mac 版 zip：解壓後拖進「應用程式」） */
export const NDI_HELPER_DOWNLOAD_URL_MAC =
  'https://proxy.haimiaan.com/downloads/stage-previz-ndi-helper-mac.zip';
