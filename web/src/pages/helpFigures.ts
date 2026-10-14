// 使用說明（/help）的圖片：放在 web/public/help/，紅框 / 編號用 CSS 疊在圖上（不改圖）。
//
// 紅框座標 = 佔整張圖的百分比（x 左、y 上、w 寬、h 高），圖縮放時跟著走。
//   n = 框旁邊的圓圈編號（跟內文的 ①②③ 對上）；dashed = 虛線框（只是「在這裡」，不用按）
// 圖片還沒放進去 → 顯示「圖片準備中」的框；optional = 沒有就整個不顯示
// w / h = 圖片實際像素（先留好位置，載入時畫面不會跳）；width = 最多顯示多寬（CSS px）
// phone = 手機截圖（窄、置中）
//
// 截圖是用本機的示範資料（「示範專案」、動畫師小明、導演王導）拍的，不是真的客戶資料。

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
  phone?: boolean;
}

const fig = (f: HelpFig) => f;

export const FIGS = {
  // ═══ 開始使用 ═══
  inviteOpenPhone: fig({
    src: '/help/start/invite-open-phone.webp', w: 600, h: 730, width: 300, phone: true,
    alt: '手機打開邀請連結：王導你好，製作邀請你進入「示範專案」，你的身分是導演',
    caption: '手機打開邀請連結：① 按「進入專案」',
    boxes: [{ x: 14.87, y: 51.73, w: 70.26, h: 11.07, n: 1 }],
  }),
  inviteOpen: fig({
    src: '/help/start/invite-open.webp', w: 840, h: 616, width: 420,
    alt: '電腦打開邀請連結的畫面',
    caption: '電腦上也一樣：① 按「進入專案」',
    boxes: [{ x: 8.1, y: 52.03, w: 83.81, h: 17, n: 1 }],
  }),
  login: fig({
    src: '/help/start/login.webp', w: 760, h: 754, width: 380,
    alt: '登入頁：輸入登入碼',
    caption: '① 輸入製作給你的登入碼，按「登入」',
    boxes: [{ x: 8.95, y: 46.55, w: 82.11, h: 14.06, n: 1 }],
  }),
  notifications: fig({
    src: '/help/start/notifications.webp', w: 760, h: 756, width: 380,
    alt: '小鈴鐺打開的通知清單：有新版等你審、回覆了你的留言',
    caption: '小鈴鐺打開的樣子（導演）：點一則就會打開那首歌、那一版、那則留言',
  }),

  // ═══ 製作 ═══
  adminOverview: fig({
    src: '/help/producer/admin-overview.webp', w: 1200, h: 716, width: 820,
    alt: '專案總覽：專案卡片、左邊選單、新增專案按鈕',
    caption: '專案總覽：① 新增專案 ② 專案卡片（點進去編輯）③ 左邊選單：專案、用戶、封存的專案、設定…',
    boxes: [
      { x: 90.07, y: 2.6, w: 7.92, h: 5.06, n: 1 },
      { x: 18.68, y: 18.72, w: 19.2, h: 42.04, n: 2 },
      { x: 0.69, y: 8.26, w: 15.21, h: 79.3, n: 3, dashed: true },
    ],
  }),
  newProject: fig({
    src: '/help/producer/new-project.webp', w: 1000, h: 1026, width: 440,
    alt: '新增專案第 1 步：專案名稱、Show、描述',
    caption: '第 1 步：① 專案名稱（一定要填）② 按「建立專案」，專案就建好了 ③ 最上面看得到在第幾步',
    boxes: [
      { x: 2.63, y: 25.68, w: 94.74, h: 6.19, n: 1 },
      { x: 82.63, y: 93.08, w: 15, h: 5.64, n: 2 },
      { x: 2.37, y: 9.1, w: 95.26, h: 5.38, n: 3, dashed: true },
    ],
  }),
  newProjectModel: fig({
    src: '/help/producer/new-project-model.webp', w: 1000, h: 1026, width: 440,
    alt: '新增專案第 2 步：模型匯入後寫找到幾片 LED、幾個機關',
    caption: '第 2 步：① 模型裡找到什麼 ② 物件怎麼命名（開新分頁看說明）③ 下一步',
    boxes: [
      { x: 4.74, y: 29.01, w: 90.53, h: 3.72, n: 1 },
      { x: 2.63, y: 22.67, w: 30.79, h: 3.27, n: 2, dashed: true },
      { x: 84.34, y: 92.98, w: 13.29, h: 5.64, n: 3 },
    ],
  }),
  newProjectSongs: fig({
    src: '/help/producer/new-project-songs.webp', w: 1000, h: 1026, width: 440,
    alt: '新增專案第 4 步：貼上歌單，下面列出每首歌的歌曲代號和歌名',
    caption: '第 4 步：① 一行一首貼進來 ② 歌曲代號照順序排好，可以改 ③ 按「加入 3 首歌」',
    boxes: [
      { x: 2.63, y: 28.53, w: 94.74, h: 23.68, n: 1 },
      { x: 2.63, y: 56.57, w: 12.89, h: 16.83, n: 2 },
      { x: 83.3, y: 92.98, w: 14.34, h: 5.64, n: 3 },
    ],
  }),
  newProjectDone: fig({
    src: '/help/producer/new-project-done.webp', w: 1000, h: 1026, width: 440,
    alt: '新增專案最後一步：做好了什麼、還沒做什麼',
    caption: '完成：① 還沒做的可以回去設定 ② 進入編輯頁 ③ 建立分享連結、用其他身分看',
    boxes: [
      { x: 84.61, y: 57.6, w: 10.79, h: 4.97, n: 1 },
      { x: 2.63, y: 66.05, w: 17.89, h: 6.54, n: 2 },
      { x: 20.79, y: 66.4, w: 37.63, h: 5.83, n: 3 },
    ],
  }),
  projectCardMenu: fig({
    src: '/help/producer/project-card-menu.webp', w: 580, h: 750, width: 290,
    alt: '專案卡片的更多動作：複製專案、匯出 JSON、編輯標籤、封存',
    caption: '專案卡片右上角的「⋯」',
  }),
  editorOverview: fig({
    src: '/help/producer/editor-overview.webp', w: 1200, h: 716, width: 820,
    alt: '專案編輯頁：左邊歌曲、中間 3D 舞台、右邊 Cue / 物件狀態 / 機關 / 物件分頁',
    caption: '編輯頁：① 歌曲 ② 3D 工具列 ③ 右邊的分頁：Cue、物件狀態、機關、物件 ④ 復原 / 重做',
    boxes: [
      { x: 0, y: 5.58, w: 19.44, h: 94.42, n: 1, dashed: true },
      { x: 20.96, y: 6.51, w: 53.9, h: 5.58, n: 2 },
      { x: 76.39, y: 5.58, w: 23.61, h: 94.42, n: 3, dashed: true },
      { x: 29.06, y: 0.64, w: 10.33, h: 4.19, n: 4 },
    ],
  }),
  uploadModel: fig({
    src: '/help/producer/upload-model.webp', w: 1000, h: 768, width: 500,
    alt: '上傳 3D 模型對話框：拖檔的框和命名規則',
    caption: '① 把 .glb 拖進來或點一下選檔案 ② 命名規則（對到的會自動分類）',
    boxes: [
      { x: 2.63, y: 13.85, w: 94.74, h: 38.22, n: 1 },
      { x: 2.63, y: 65.2, w: 94.74, h: 31.38, n: 2, dashed: true },
    ],
  }),
  uploadReview: fig({
    src: '/help/producer/upload-review.webp', w: 1000, h: 948, width: 560,
    alt: '模型讀好之後的物件清單：C4D 物件名稱、顯示名稱、分類',
    caption: '讀好的樣子：① 幾個物件、各分類幾個；沒對到命名規則的會標出來 ② 按「匯入」',
    boxes: [
      { x: 0, y: 8.19, w: 100, h: 12.64, n: 1 },
      { x: 80.47, y: 92.01, w: 16.89, h: 6.32, n: 2 },
    ],
  }),
  measure: fig({
    src: '/help/producer/measure.webp', w: 1100, h: 1254, width: 460,
    alt: '測距模式：量主牆左右兩邊的距離',
    caption: '量主牆的寬度：① 畫面下方顯示量到的距離 ② 按「設為已知距離」',
    boxes: [
      { x: 24.55, y: 82.31, w: 50.91, h: 10.11, n: 1, dashed: true },
      { x: 33.03, y: 86.57, w: 19.18, h: 4.79, n: 2 },
    ],
  }),
  calibrate: fig({
    src: '/help/producer/calibrate.webp', w: 840, h: 502, width: 420,
    alt: '校準尺寸對話框：輸入實際是幾公尺',
    caption: '① 輸入實際長度（公尺）② 按「套用」',
    boxes: [
      { x: 4.05, y: 53.67, w: 91.9, h: 19.09, n: 1 },
      { x: 79.76, y: 75.14, w: 16.19, h: 18.1, n: 2 },
    ],
  }),
  songList: fig({
    src: '/help/producer/song-list.webp', w: 558, h: 1022, width: 300,
    alt: '編輯頁左邊的歌單：每首歌有代號和歌名、狀態和 cue 數、影片版本和加影片、負責動畫師，最右邊一個「⋯」',
    caption: '① 歌曲代號（點一下可以改）② 狀態（點一下可以改）③ 影片 V2（點一下看所有版本）④ ＋加影片 ⑤ 負責動畫師 ⑥「⋯」：上移、下移、改名、刪除',
    boxes: [
      { x: 16.13, y: 32.68, w: 12.96, h: 4.7, n: 1 },
      { x: 16.13, y: 37.57, w: 23.35, h: 4.79, n: 2 },
      { x: 16.13, y: 41.98, w: 23, h: 5.09, n: 3 },
      { x: 39.13, y: 41.98, w: 24.37, h: 5.09, n: 4 },
      { x: 37.99, y: 46.67, w: 57.35, h: 5.48, n: 5 },
      { x: 84.59, y: 31.9, w: 11.47, h: 6.26, n: 6 },
    ],
  }),
  songVideos: fig({
    src: '/help/producer/song-videos.webp', w: 1240, h: 856, width: 520,
    alt: '影片版本視窗：一版沒交成功的連結，下面是 V2、V1，每一版有到導演頁播放、刪除',
    caption: '① 每一版的狀態、誰交的、什麼時候、說明 ② 到導演頁播放 ③ 刪除（號碼不會再用）④ 沒交成功的：重試或拿掉',
    boxes: [
      { x: 12.42, y: 42.17, w: 63.39, h: 11.8, n: 1 },
      { x: 76.45, y: 42.17, w: 19.19, h: 7.94, n: 2 },
      { x: 76.45, y: 50.12, w: 19.19, h: 7.94, n: 3 },
      { x: 77.9, y: 20.79, w: 18.1, h: 7.01, n: 4 },
    ],
  }),
  drive: fig({
    src: '/help/producer/drive.webp', w: 900, h: 676, width: 480,
    alt: 'Drive 來源設定：Google 帳號、資料夾、檔案怎麼對到歌',
    caption: '專案的 Drive 設定：① 檔名開頭寫歌曲代號就會自動對到那首歌',
    boxes: [{ x: 2.5, y: 52.86, w: 95, h: 7.26, n: 1 }],
  }),
  cueList: fig({
    src: '/help/producer/cue-list.webp', w: 680, h: 960, width: 340,
    alt: 'Cue 分頁：cue 清單，第 2 個 cue 最右邊的「⋯」打開的選單',
    caption: '① 轉場秒數（0 寫「直接切換」）② 每個 cue 最右邊的「⋯」③ 存成常用擺位 ④ 重置這個 cue',
    boxes: [
      { x: 14.41, y: 29.01, w: 16.5, h: 4.27, n: 1 },
      { x: 87.65, y: 25.78, w: 8.82, h: 6.25, n: 2 },
      { x: 17.06, y: 61.04, w: 77.05, h: 8.75, n: 3 },
      { x: 17.06, y: 77.71, w: 77.05, h: 8.75, n: 4 },
    ],
  }),
  cueAdd: fig({
    src: '/help/producer/cue-add.webp', w: 680, h: 596, width: 340,
    alt: '新增 cue 旁邊小箭頭的選單：空白 cue、沿用目前的 cue、從目前 3D 狀態建立、從常用擺位建立',
    caption: '「新增 cue」旁邊的小箭頭：四種新增方法',
  }),
  cueMeta: fig({
    src: '/help/producer/cue-meta.webp', w: 630, h: 596, width: 320,
    alt: '物件狀態分頁上方：cue 名稱、轉場秒數、對應影片時間',
    caption: '① 轉場（秒）② 對應影片時間',
    boxes: [
      { x: 3.49, y: 32.16, w: 93.02, h: 13.23, n: 1 },
      { x: 3.49, y: 61.31, w: 93.02, h: 13.23, n: 2 },
    ],
  }),
  templateSave: fig({
    src: '/help/producer/template-save.webp', w: 800, h: 492, width: 400,
    alt: '存成常用擺位：取名字',
    caption: '存成常用擺位：取一個好認的名字 →「下一步」',
  }),
  templatePick: fig({
    src: '/help/producer/template-pick.webp', w: 800, h: 288, width: 400,
    alt: '從常用擺位建立 cue：選一個按套用',
    caption: '從常用擺位建立 cue：按「套用」',
  }),
  mechTab: fig({
    src: '/help/producer/mech-tab.webp', w: 680, h: 1514, width: 340,
    alt: '機關分頁：這個 cue 的機關位置、來不及到位的提醒、設定機關',
    caption: '① 照機器速度播放 ② 換 cue ③ 常用位置 ④ 照機器速度（把轉場改成夠用的秒數）⑤ 匯出機關總表 ⑥ 新增機關',
    boxes: [
      { x: 3.24, y: 16.01, w: 93.82, h: 7.86, n: 1 },
      { x: 3.24, y: 24.4, w: 93.82, h: 4.36, n: 2 },
      { x: 6.47, y: 34.11, w: 87.35, h: 3.85, n: 3 },
      { x: 8.82, y: 49.72, w: 46.4, h: 4.49, n: 4 },
      { x: 3.24, y: 11, w: 34.71, h: 4.49, n: 5 },
      { x: 69.41, y: 73.72, w: 27.65, h: 4.49, n: 6 },
    ],
  }),
  mechForm: fig({
    src: '/help/producer/mech-form.webp', w: 626, h: 2262, width: 300,
    alt: '設定機關的表單：名稱、動作、方向、帶動的物件、行程、預設位置、最高速度、常用位置、控台編號',
    caption: '設定一個機關（例：中央升降台）',
  }),
  mech3d: fig({
    src: '/help/producer/mech-3d.webp', w: 1000, h: 1160, width: 420,
    alt: '3D 畫面：升降台升到全開，前緣 LED 和主唱一起上去',
    caption: '升降台在這個 cue 升到「全開」：帶動的物件（前緣 LED、主唱）一起上去',
  }),
  mechTimeline: fig({
    src: '/help/producer/mech-timeline.png', w: 880, h: 120, width: 880,
    alt: '機關時間軸：中央升降台在 Cue 2 延遲 5 秒、走 6 秒，紅色代表照最高速度來不及，後面的斜線是實際會走到哪',
    caption: '機關時間軸：上面的數字是 cue，色塊是每一段移動；紅色 = 照最高速度來不及（斜線 = 實際會走到哪）',
  }),
  ledMenu: fig({
    src: '/help/producer/led-menu.webp', w: 1000, h: 390, width: 600,
    alt: '3D 工具列的更多選單：LED 對位圖、LED 顯示測試圖、設定畫布大小',
    caption: '① 工具列最右邊「⋯」② 下載對位圖 ③ LED 顯示測試圖 ④ 設定畫布大小（製作才有）',
    boxes: [
      { x: 93.49, y: 4.44, w: 4.79, h: 11.6, n: 1 },
      { x: 64.09, y: 30.89, w: 34.03, h: 11.6, n: 2 },
      { x: 64.09, y: 63.65, w: 34.03, h: 11.6, n: 3 },
      { x: 64.09, y: 74.57, w: 34.03, h: 11.6, n: 4 },
    ],
  }),
  ledCanvas: fig({
    src: '/help/producer/led-canvas.webp', w: 800, h: 426, width: 400,
    alt: 'LED 畫布大小對話框：AE 合成的寬 × 高',
    caption: '① 寫成「寬 × 高」，例：10496 × 5120',
    boxes: [{ x: 3.64, y: 30.65, w: 92.72, h: 19.96, n: 1 }],
  }),
  homeView: fig({
    src: '/help/producer/home-view.webp', w: 900, h: 714, width: 450,
    alt: '重置攝影機的畫面設定',
    caption: '① 重置攝影機 ② 旁邊的小箭頭：設定重置攝影機的畫面 ③ 用現在的畫面',
    boxes: [
      { x: 21.5, y: 3.32, w: 7.28, h: 8.67, n: 1 },
      { x: 27.97, y: 3.32, w: 4.45, h: 8.67, n: 2 },
      { x: 43.56, y: 39.54, w: 52.98, h: 8.16, n: 3 },
    ],
  }),
  lookSettings: fig({
    src: '/help/producer/look-settings.webp', w: 520, h: 1052, width: 260,
    alt: '現場設定：底光、曝光、LED 照明、光暈、倒影',
    caption: '現場模式的「設定」',
  }),
  shareLinks: fig({
    src: '/help/producer/share-links.webp', w: 1000, h: 702, width: 560,
    alt: '公開分享連結對話框：範圍、密碼、有效期、好讀網址、已建立的連結',
    caption: '① 密碼（可選）② 有效期 ③ 好讀網址名稱 ④ 建立 ⑤ 已建立的連結：複製、打開、改網址、刪除',
    boxes: [
      { x: 38.8, y: 30.5, w: 33.6, h: 7, n: 1 },
      { x: 73.2, y: 30.5, w: 22.6, h: 7, n: 2 },
      { x: 4, y: 42.5, w: 92, h: 7.5, n: 3 },
      { x: 4.2, y: 59.8, w: 14.3, h: 6.4, n: 4 },
      { x: 2.8, y: 79.5, w: 94.4, h: 17.5, n: 5 },
    ],
  }),
  viewAsMenu: fig({
    src: '/help/producer/view-as-menu.webp', w: 1120, h: 640, width: 560,
    alt: '編輯頁上方的「用其他身分看」：導演畫面、動畫師畫面、動畫師「小明」的畫面、客戶畫面（分享連結）',
    caption: '① 編輯頁上方的「用其他身分看」② 導演、動畫師、客戶的畫面（都開新分頁、只能看）',
    boxes: [
      { x: 67.79, y: 1.72, w: 21.32, h: 11.25, n: 1 },
      { x: 44.82, y: 13.13, w: 44.29, h: 68.75, n: 2, dashed: true },
    ],
  }),
  inviteForm: fig({
    src: '/help/producer/invite-form.webp', w: 1000, h: 1152, width: 500,
    alt: '邀請連結對話框：邀請誰、角色、有效期限',
    caption: '① 對方的名字 ② 角色 ③ 有效期限 ④ 建立邀請連結',
    boxes: [
      { x: 3.57, y: 26.55, w: 92.86, h: 7.17, n: 1 },
      { x: 3.57, y: 38.99, w: 92.86, h: 12.15, n: 2 },
      { x: 3.57, y: 56.41, w: 92.86, h: 6.82, n: 3 },
      { x: 71.43, y: 68.38, w: 25, h: 6.74, n: 4 },
    ],
  }),
  inviteResult: fig({
    src: '/help/producer/invite-result.webp', w: 1000, h: 1252, width: 500,
    alt: '邀請連結建好了：可以直接貼到 LINE / 微信的訊息',
    caption: '① 寫好的訊息 ② 複製訊息 ③ 還沒用的邀請連結（可以撤銷）',
    boxes: [
      { x: 6.43, y: 18.72, w: 87.14, h: 13.69, n: 1 },
      { x: 6.43, y: 33.42, w: 20, h: 5.92, n: 2 },
      { x: 3.75, y: 66.65, w: 92.5, h: 20.01, n: 3 },
    ],
  }),
  users: fig({
    src: '/help/producer/users.webp', w: 1200, h: 892, width: 820,
    alt: '用戶頁：每個人的角色、登入碼、可看的專案',
    caption: '① 邀請連結 ② 新增用戶 ③ 登入碼（只在建立時顯示，忘記了按「重設」）④ 指派專案、邀請連結、停用、刪除',
    boxes: [
      { x: 77.92, y: 2.35, w: 9.67, h: 5.1, n: 1 },
      { x: 88.08, y: 2.47, w: 9.5, h: 4.88, n: 2 },
      { x: 8, y: 22.26, w: 81.81, h: 3.73, n: 3 },
      { x: 88.56, y: 35.52, w: 7.6, h: 15.14, n: 4 },
    ],
  }),
  loginCode: fig({
    src: '/help/producer/login-code.webp', w: 900, h: 904, width: 450,
    alt: '新的登入碼：只顯示這一次，可以複製或複製訊息',
    caption: '新用戶的登入碼：只顯示這一次，「複製訊息」貼給對方',
  }),
  systemStatus: fig({
    src: '/help/producer/system-status.webp', w: 1000, h: 330, width: 560,
    alt: '設定頁的系統狀態：資料庫備份、最近 7 天的畫面錯誤',
    caption: '設定 → 系統狀態',
  }),
  archived: fig({
    src: '/help/producer/archived.webp', w: 1000, h: 246, width: 560,
    alt: '封存的專案清單',
    caption: '封存的專案：① 還原',
    boxes: [{ x: 87.45, y: 59.62, w: 7.44, h: 15.38, n: 1 }],
  }),

  // ═══ 動畫師 ═══
  studioOverview: fig({
    src: '/help/animator/studio-overview.webp', w: 1200, h: 750, width: 820,
    alt: '動畫師工作站：歌單、LED 畫面來源、影片版本、3D 舞台、小播放器、審查和留言',
    caption: '① 歌曲 ② LED 畫面來源 ③ 這首歌的影片 ④ 小播放器 ⑤ cue 列 ⑥ Cue / 審查 / 留言 / 活動',
    boxes: [
      { x: 0, y: 6.11, w: 16.67, h: 93.89, n: 1, dashed: true },
      { x: 16.67, y: 6.11, w: 59.72, h: 5.31, n: 2 },
      { x: 16.67, y: 11.42, w: 59.72, h: 5.35, n: 3 },
      { x: 54.58, y: 64.47, w: 21.11, h: 28.19, n: 4 },
      { x: 16.67, y: 93.78, w: 59.72, h: 6.22, n: 5 },
      { x: 76.39, y: 6.11, w: 23.61, h: 93.89, n: 6, dashed: true },
    ],
  }),
  sourceSwitch: fig({
    src: '/help/animator/source-switch.webp', w: 1000, h: 54, width: 820,
    alt: 'LED 畫面來源：影片 V2、AE 即時、本地檔案',
    caption: '① 影片 ② AE 即時 ③ 本地檔案（右邊的「?」打開這一段）',
    boxes: [
      { x: 1.63, y: 16.75, w: 10.46, h: 64.4, n: 1 },
      { x: 11.85, y: 16.75, w: 10.52, h: 64.4, n: 2 },
      { x: 22.14, y: 16.75, w: 11.16, h: 64.4, n: 3 },
    ],
  }),
  studioLive: fig({
    src: '/help/animator/studio-ae-live.webp', w: 1100, h: 1080, width: 560,
    alt: '工作站選 AE 即時：LED 上就是 AE 的畫面，工具列顯示 LIVE',
    caption: '① 選「AE 即時」② 3D 畫面上方亮綠色「LIVE」，LED 上就是你 AE 的畫面',
    boxes: [
      { x: 11.69, y: 0.83, w: 10.78, h: 3.88, n: 1 },
      { x: 36.2, y: 13.57, w: 14.58, h: 3.37, n: 2 },
    ],
  }),
  localFilesEmpty: fig({
    src: '/help/animator/local-files-empty.webp', w: 1100, h: 646, width: 680,
    alt: '本地檔案：還沒選檔案時，LED 顯示測試圖',
    caption: '選了「本地檔案」：① 加入影片 / 圖片（也可以直接把檔案拖進來）',
    boxes: [{ x: 0.56, y: 60.14, w: 15.49, h: 21.78, n: 1 }],
  }),
  localFiles: fig({
    src: '/help/animator/local-files.webp', w: 1100, h: 646, width: 680,
    alt: '本地檔案：放了一支影片在 LED 上',
    caption: '① 本地檔案清單（點哪個放哪個）② 播放列',
    boxes: [
      { x: 0, y: 55.7, w: 16.88, h: 44.3, n: 1 },
      { x: 16.53, y: 88.28, w: 60, h: 5.33, n: 2 },
    ],
  }),
  addVideoUpload: fig({
    src: '/help/animator/add-video-upload.webp', w: 900, h: 568, width: 480,
    alt: '加影片對話框：上傳檔案、貼連結、本地檔案',
    caption: '① 三種方法 ② 說明（選填）③ 拖檔案進來 ④ 說明「?」',
    boxes: [
      { x: 0, y: 15.58, w: 100, h: 15.44, n: 1, dashed: true },
      { x: 2.68, y: 33.85, w: 94.64, h: 17.99, n: 2 },
      { x: 2.68, y: 54.11, w: 94.64, h: 41.64, n: 3 },
      { x: 84.46, y: 4.25, w: 5.71, h: 9.07, n: 4 },
    ],
  }),
  uploading: fig({
    src: '/help/animator/uploading.webp', w: 900, h: 790, width: 450,
    alt: '上傳中：進度條和百分比',
    caption: '上傳中：可以關掉視窗、切到別首歌，上傳會繼續',
  }),
  addVideoLink: fig({
    src: '/help/animator/add-video-link.webp', w: 900, h: 586, width: 450,
    alt: '加影片：貼 Google Drive 單一檔案的連結',
    caption: '貼連結：貼上之後下面會說看起來是哪一種連結',
  }),
  versionBar: fig({
    src: '/help/animator/version-bar.webp', w: 1000, h: 56, width: 820,
    alt: '影片版本列：V2、V1、說明、加影片',
    caption: '① 每一版（點哪一版 LED 就放哪一版）② 加影片',
    boxes: [
      { x: 7.44, y: 8.31, w: 23.06, h: 83.38, n: 1 },
      { x: 88.26, y: 8.96, w: 10.58, h: 82.08, n: 2 },
    ],
  }),
  reviewTab: fig({
    src: '/help/animator/review-tab.webp', w: 680, h: 1690, width: 340,
    alt: '審查 / 留言分頁：目前狀態、導演的需修改原因、審片紀錄、留言',
    caption: '「審查 / 留言」：狀態、導演上次的決定和原因、留言（「已改好（V2）」）',
  }),
  compare: fig({
    src: '/help/animator/compare.webp', w: 600, h: 506, width: 300,
    alt: '小播放器的比較：選 V1，按鈕或 C 鍵切換',
    caption: '① 選另一版 ② 按這個（或鍵盤 C）切換，停在同一秒',
    boxes: [
      { x: 12.33, y: 86.21, w: 24.67, h: 11.03, n: 1 },
      { x: 37.67, y: 85.42, w: 16.22, h: 12.61, n: 2 },
    ],
  }),
  animLedMenu: fig({
    src: '/help/animator/led-menu.webp', w: 600, h: 604, width: 300,
    alt: '動畫師的更多選單：LED 對位圖、AE 合成腳本、位置表、LED 顯示測試圖',
    caption: '工具列最右邊「⋯」：LED 對位圖',
  }),
  aeScriptMenu: fig({
    src: '/help/animator/led-menu.webp', w: 600, h: 604, width: 300,
    alt: '更多選單裡的「下載 AE 合成腳本（.jsx）」',
    caption: '「⋯」→ ① 下載 AE 合成腳本（.jsx）',
    boxes: [{ x: 7.67, y: 41.23, w: 84.67, h: 10.6, n: 1 }],
  }),
  ledMapSample: fig({
    src: '/help/animator/led-map-sample.webp', w: 1200, h: 450, width: 820,
    alt: '下載的 LED 對位圖：每塊 LED 在 AE 畫布上的位置、名字、x y w h、格線',
    caption: '下載的 LED 對位圖（示範專案，3840 × 1440）：放進 AE 當參考圖層',
  }),
  aeScriptResult: fig({
    src: '/help/animator/ae-script-result.webp', w: 1544, h: 744, width: 820,
    alt: 'After Effects 跑完腳本：LED 畫布大小的合成，每塊 LED 的外框和名字都是導引圖層',
    caption: '跑完腳本的 AE（示範專案）：每塊 LED 一個外框（不同顏色）和名字標籤，都是導引圖層、鎖住',
  }),
  aeScriptLayers: fig({
    src: '/help/animator/ae-script-layers.webp', w: 858, h: 296, width: 820,
    alt: 'AE 時間軸：名字標籤、每塊 LED 的外框、LED 對位圖，都鎖住、都是導引圖層',
    caption: '時間軸：上面是名字標籤（T）、接著每塊 LED 的外框、最下面對位圖；鎖頭 = 鎖住，名字前面的格子圖示 = 導引圖層',
  }),
  testPattern: fig({
    src: '/help/animator/test-pattern.webp', w: 1100, h: 886, width: 560,
    alt: 'LED 測試圖：每塊 LED 的名字、位置、格線、彩條',
    caption: 'LED 沒有畫面時顯示測試圖：每塊 LED 的名字、x y w h、格線、彩條',
  }),

  // ═══ 導演 ═══
  board: fig({
    src: '/help/director/board.webp', w: 1200, h: 276, width: 820,
    alt: '導演總覽：待製作、審查中、需修改、已通過四欄',
    caption: '① 四個狀態 ② 有新版 ③ 審查中的歌可以直接按「通過」「需修改」④ 整體進度',
    boxes: [
      { x: 0.97, y: 21.52, w: 24.1, h: 16.06, n: 1 },
      { x: 27.08, y: 55.91, w: 6.15, h: 8.03, n: 2 },
      { x: 26.25, y: 65.38, w: 22.85, h: 16.06, n: 3 },
      { x: 14.37, y: 4.55, w: 14.27, h: 7.27, n: 4 },
    ],
  }),
  boardPhone: fig({
    src: '/help/director/board-phone.webp', w: 600, h: 1298, width: 280, phone: true,
    alt: '手機上的導演總覽：狀態一欄一欄往下排',
    caption: '手機：狀態一欄一欄往下排',
  }),
  songDetail: fig({
    src: '/help/director/song-detail.webp', w: 1200, h: 716, width: 820,
    alt: '導演看一首歌：版本、3D 舞台、小播放器、cue 列、留言',
    caption: '① 上一首 / 下一首 ② 通過 / 需修改（旁邊的「?」打開說明）③ 版本 ④ 小播放器 ⑤ cue 列 ⑥ 審片紀錄和留言',
    boxes: [
      { x: 6.18, y: 7.76, w: 9.19, h: 3.08, n: 1 },
      { x: 85.61, y: 7.21, w: 10.57, h: 4.19, n: 2 },
      { x: 0, y: 12.33, w: 75, h: 5.6, n: 3 },
      { x: 53.19, y: 57.47, w: 21.11, h: 33.92, n: 4 },
      { x: 0, y: 92.56, w: 75, h: 7.44, n: 5 },
      { x: 75, y: 12.33, w: 25, h: 87.67, n: 6, dashed: true },
    ],
  }),
  songPhone: fig({
    src: '/help/director/song-phone.webp', w: 600, h: 1298, width: 280, phone: true,
    alt: '手機上的歌曲頁：通過 / 需修改、版本、3D、小播放器',
    caption: '手機：按鈕、版本在上面，3D 和留言往下捲',
  }),
  commentTime: fig({
    src: '/help/director/comment-time.webp', w: 662, h: 312, width: 330,
    alt: '留言綁在影片時間：掛在 00:14',
    caption: '① 「掛在 00:14」= 這則留言綁在影片的這一秒',
    boxes: [{ x: 0, y: 0, w: 100, h: 22.12, n: 1 }],
  }),
  commentMention: fig({
    src: '/help/director/comment-mention.webp', w: 694, h: 344, width: 340,
    alt: '打 @ 出現成員清單',
    caption: '打 @ 加名字：選清單裡的人，他會收到通知',
  }),
  needsChanges: fig({
    src: '/help/director/needs-changes.webp', w: 900, h: 718, width: 450,
    alt: '需修改對話框：要改什麼（一定要寫）',
    caption: '需修改一定要寫原因，動畫師才知道改什麼',
  }),
  reviewHistory: fig({
    src: '/help/director/review-history.webp', w: 662, h: 158, width: 330,
    alt: '審片紀錄：V1 需修改、原因',
    caption: '審片紀錄：哪一版、誰、什麼時候、原因（點原因跳到那則留言）',
  }),
  dirCompare: fig({
    src: '/help/director/compare.webp', w: 1100, h: 718, width: 560,
    alt: '導演頁比較兩版：小播放器選 V1',
    caption: '① 比較：選 V1，按旁邊的按鈕或 C 在兩版之間切換',
    boxes: [{ x: 71.67, y: 78.44, w: 26.67, h: 4.82, n: 1 }],
  }),
  annotate: fig({
    src: '/help/director/annotate.webp', w: 1200, h: 716, width: 820,
    alt: '導演在 3D 畫面上畫箭頭和圓圈，留言框上面寫區段 0:05–0:09、畫記 2 筆、會記住現在的視角',
    caption: '① 畫記工具：筆、箭頭、方框、圓圈、顏色、復原、畫好了 ② 這則留言會帶的：區段、畫記、視角 ③ 寫一句說明，按「送出」',
    boxes: [
      { x: 12.56, y: 22.22, w: 44.89, h: 6.98, n: 1 },
      { x: 70.92, y: 47.56, w: 28.25, h: 8, n: 2 },
      { x: 70.92, y: 55.27, w: 28.25, h: 11.8, n: 3 },
    ],
  }),
  commentOpen: fig({
    src: '/help/director/comment-open.webp', w: 1200, h: 716, width: 820,
    alt: '點一則留言：攝影機飛到留言時的視角，畫記疊在 3D 畫面上，區段在時間軸上面那一條',
    caption: '① 畫記疊上去（停在畫的那一格；按播放或轉視角就收起來）② 小播放器先收起來，按播放就一直循環這一段（「循環」旁邊的叉叉 = 停）③ 打開的留言（縮圖是留言當下的畫面）',
    boxes: [
      { x: 0.33, y: 29.21, w: 13.49, h: 5.31, n: 1 },
      { x: 43.9, y: 77.4, w: 25.2, h: 11.8, n: 2 },
      { x: 70.92, y: 73.74, w: 28.25, h: 18.51, n: 3 },
    ],
  }),

  // ═══ 客戶 ═══
  sharePassword: fig({
    src: '/help/client/password-phone.webp', w: 600, h: 370, width: 300, phone: true,
    alt: '分享連結要輸入密碼',
    caption: '① 輸入密碼 ② 按「解鎖」',
    boxes: [
      { x: 10, y: 48.4, w: 62, h: 18.6, n: 1 },
      { x: 73.6, y: 48.4, w: 16.4, h: 18.6, n: 2 },
    ],
  }),
  shareDesktop: fig({
    src: '/help/client/share-desktop.webp', w: 1200, h: 716, width: 820,
    alt: '分享連結（電腦）：歌曲、影片、3D 舞台、小播放器、cue',
    caption: '① 歌曲 ② 影片 / AE 即時 / 本地檔案 ③ 重置攝影機 ④ 小播放器 ⑤ cue',
    boxes: [
      { x: 0, y: 4.8, w: 15.21, h: 95.2, n: 1, dashed: true },
      { x: 16.11, y: 5.49, w: 19.19, h: 4.04, n: 2 },
      { x: 49.93, y: 17.69, w: 2.64, h: 4.19, n: 3 },
      { x: 78.19, y: 66.02, w: 21.11, h: 26.02, n: 4 },
      { x: 15.28, y: 93.2, w: 84.72, h: 6.8, n: 5 },
    ],
  }),
  shareMenu: fig({
    src: '/help/client/share-menu.webp', w: 568, h: 664, width: 284,
    alt: '分享頁 3D 工具列的更多選單：LED 對位圖、說明',
    caption: '① 「⋯」② 說明（打開這份使用說明）',
    boxes: [
      { x: 82.75, y: 3.91, w: 12.68, h: 10.23, n: 1 },
      { x: 4.93, y: 85.56, w: 90.14, h: 10.23, n: 2 },
    ],
  }),
  sharePhone: fig({
    src: '/help/client/share-phone.webp', w: 600, h: 1298, width: 280, phone: true,
    alt: '手機打開分享連結：歌曲在上面一排、3D 舞台、小播放器、cue',
    caption: '手機：歌曲在上面一排，cue 在最下面',
  }),
  guestComment: fig({
    src: '/help/client/guest-comment.webp', w: 1200, h: 716, width: 820,
    alt: '分享連結的留言：寫一次名字、在影片上留言和畫記、團隊在底下回覆',
    caption: '① 你的名字（只要寫一次）② 綁在哪一秒、畫記、會記住現在的視角 ③ 你的留言和團隊的回覆（點一下打開）',
    boxes: [
      { x: 72.42, y: 12.26, w: 26.92, h: 3.98, n: 1 },
      { x: 72.42, y: 16.52, w: 26.92, h: 4.75, n: 2 },
      { x: 72.42, y: 43.4, w: 26.92, h: 26.89, n: 3 },
    ],
  }),

  // ═══ AE 即時預覽：網站（分享頁）：測試站的分享連結 + 模擬小程序各種狀態截的（2 倍解析度）═══
  shareLive: fig({
    src: '/help/web/share-live.webp', w: 1400, h: 850, width: 820,
    alt: '分享頁：AE 即時正在播',
    caption: '成功的樣子：① 上面選「AE 即時」② 旁邊顯示你的 AE 和每秒幾張 ③ 3D 畫面上方亮綠色「LIVE」④ LED 上就是 AE 的畫面',
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
    caption: '① 上面選「AE 即時」（預設就是）② 卡片上按「連接 AE 即時」',
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

  // ─── AE 即時預覽：Windows（真的截圖）───
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
    caption: '合成視窗下方的解析度選單（建議選 Half）',
  }),
  helperInstallingWin: fig({
    src: '/help/win/helper-installing.png', w: 495, h: 383, width: 420,
    alt: 'NDI 小程序安裝中（Windows）',
    caption: '安裝中，等進度條跑完（幾秒鐘）',
  }),

} satisfies Record<string, HelpFig>;

export type FigKey = keyof typeof FIGS;
