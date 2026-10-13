// 使用說明（/help）的圖片：放在 web/public/help/，紅框 / 編號用 CSS 疊在圖上（不改圖）。
//
// 紅框座標 = 佔整張圖的百分比（x 左、y 上、w 寬、h 高），圖縮放時跟著走。
//   n = 框旁邊的圓圈編號（跟內文的 ①②③ 對上）；dashed = 虛線框（只是「在這裡」，不用按）
// 圖片還沒放進去 → 顯示「圖片準備中」的框；optional = 沒有就整個不顯示
// w / h = 圖片實際像素（先留好位置，載入時畫面不會跳）；width = 最多顯示多寬（CSS px）

export interface HelpBox {
  x: number;
  y: number;
  w: number;
  h: number;
  n?: number;
  dashed?: boolean;
}

export interface HelpFig {
  src: string;
  alt: string;
  caption?: string;
  w?: number;
  h?: number;
  width?: number;
  boxes?: HelpBox[];
  optional?: boolean;
}

const fig = (f: HelpFig) => f;

export const FIGS = {
  // ─── 網站（分享頁）：測試站的分享連結 + 模擬小程序各種狀態截的（2 倍解析度）───
  shareLive: fig({
    src: '/help/web/share-live.webp', w: 1400, h: 850, width: 820,
    alt: '分享頁：AE 即時正在播',
    caption: '成功的樣子：① 上面選「🔴 AE 即時」② 旁邊顯示你的 AE 和每秒幾張 ③ 3D 畫面上方亮綠色「LIVE」④ LED 上就是 AE 的畫面',
    boxes: [
      { x: 0.86, y: 5.53, w: 6.79, h: 4.12, n: 1 },
      { x: 14.93, y: 6.0, w: 17.21, h: 3.18, n: 2 },
      { x: 46.79, y: 12.35, w: 9.0, h: 3.88, n: 3 },
      { x: 27, y: 43.5, w: 45, h: 31, n: 4, dashed: true },
    ],
  }),
  sharePermission: fig({
    src: '/help/web/share-permission.webp', w: 1400, h: 850, width: 820,
    alt: '分享頁第一次打開：AE 即時畫面卡片',
    caption: '① 上面選「🔴 AE 即時」（預設就是）② 卡片上按「連接 AE 即時」',
    boxes: [
      { x: 0.86, y: 5.53, w: 6.79, h: 4.12, n: 1 },
      { x: 40.5, y: 36.59, w: 7.64, h: 4.82, n: 2 },
    ],
  }),
  popoverSource: fig({
    src: '/help/web/popover-source.webp', w: 642, h: 672, width: 321,
    alt: '工具列 NDI 標示的面板：來源選單',
    caption: '按 3D 畫面上方的 NDI 標示（例如「LIVE」）→ ① 用「來源」選單換',
    boxes: [{ x: 13.08, y: 64.88, w: 83.49, h: 10.42, n: 1 }],
  }),
  cardBlocked: fig({ src: '/help/web/card-blocked.webp', w: 720, h: 720, width: 360, alt: '卡片：瀏覽器擋住了連到 NDI 小程序' }),
  cardNoHelper: fig({ src: '/help/web/card-no-helper.webp', w: 720, h: 802, width: 360, alt: '卡片：沒有偵測到 NDI 小程序' }),
  cardOutdated: fig({ src: '/help/web/card-outdated.webp', w: 720, h: 798, width: 360, alt: '卡片：小程序有新版，請下載更新' }),
  cardNdiMissing: fig({ src: '/help/web/card-ndi-missing.webp', w: 720, h: 766, width: 360, alt: '卡片：請先安裝 NDI Tools' }),
  cardNoAe: fig({ src: '/help/web/card-no-ae.webp', w: 720, h: 794, width: 360, alt: '卡片：這台電腦的 AE 沒有在送 NDI，下面可以選別台電腦' }),
  cardWaiting: fig({ src: '/help/web/card-waiting.webp', w: 720, h: 744, width: 360, alt: '卡片：已連上 AE，但 AE 沒在送畫面' }),
  cardSafari: fig({ src: '/help/web/card-safari.webp', w: 720, h: 714, width: 360, alt: '卡片：Safari 不支援 AE 即時畫面' }),

  // ─── Windows（真的截圖）───
  aeMenuWin: fig({
    src: '/help/win/ae-menu-preferences.png', w: 740, h: 1150, width: 400,
    alt: 'AE（Windows）：Edit → Preferences → Video Preview',
    caption: 'Windows：① Edit（編輯）→ ② Preferences（偏好設定）→ ③ Video Preview…（視訊預覽）',
    boxes: [
      { x: 5.6, y: 2.2, w: 4.5, h: 3.4, n: 1 },
      { x: 6.1, y: 59.6, w: 49.6, h: 2.5, n: 2 },
      { x: 56.2, y: 76.8, w: 39.2, h: 2.5, n: 3 },
    ],
  }),
  aeVideoPreviewWin: fig({
    src: '/help/win/ae-video-preview.png', w: 957, h: 765, width: 760,
    alt: 'AE 偏好設定的「Video Preview（視訊預覽）」頁',
    caption: '① 勾 Enable Mercury Transmit ② NDI output 那一行勾 Video Stream ③ 「Disable video output when in the background」不要勾 ④ 按 OK',
    boxes: [
      { x: 26.6, y: 6.4, w: 16.1, h: 3.2, n: 1 },
      { x: 26.7, y: 21.6, w: 38.2, h: 3.8, n: 2 },
      { x: 26.6, y: 41.4, w: 26.1, h: 3.4, n: 3 },
      { x: 89.6, y: 6.4, w: 7.8, h: 3.6, n: 4 },
      { x: 3.1, y: 35.3, w: 21.6, h: 2.9, dashed: true },
    ],
  }),
  aeResolutionWin: fig({
    src: '/help/win/ae-resolution.png', width: 560, optional: true,
    alt: 'AE 合成視窗下方的「解析度 / 降低取樣」選單',
    caption: '合成視窗下方的解析度選單（LED 畫布很大時選 Third）',
  }),
  helperInstallingWin: fig({
    src: '/help/win/helper-installing.png', w: 495, h: 383, width: 420,
    alt: 'NDI 小程序安裝中（Windows）',
    caption: '安裝中，等進度條跑完（幾秒鐘）',
  }),

} satisfies Record<string, HelpFig>;

export type FigKey = keyof typeof FIGS;
