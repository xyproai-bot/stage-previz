// 浮水印 / 禁止下載在畫面上的說明文字（公開分享連結的視窗、分享頁、使用說明共用同一份，幾個地方不會各說各話）。

export const WATERMARK_LABEL = '浮水印';
export const WATERMARK_HINT = '對方的畫面印上他的名字（沒留過言就印連結名稱和編號）和現在的時間，外流的畫面看得出是誰。';

export const NO_DOWNLOAD_LABEL = '禁止下載';
export const NO_DOWNLOAD_HINT = '拿掉下載鈕和右鍵另存，影片網址只能從分享頁播放、幾個小時就失效。';

/** 誠實的限制（兩個開關旁邊都放這一句） */
export const PROTECTION_LIMIT_NOTE = '可以防止直接下載，但擋不住螢幕錄影；浮水印能追到是誰外流。';

/** 舊連結（這個功能出現以前建的）不會自動打開 */
export const LEGACY_LINK_NOTE = '這個功能出現以前建的連結不會自動打開，行為跟以前一樣；要在那一條連結上自己打開。';

/** 連結名稱會印在對方的浮水印上 */
export const LABEL_ON_WATERMARK_NOTE = '開了浮水印的連結，名稱也會印在對方畫面的浮水印上，名稱不要寫不想讓對方看到的內容。';

/** 分享頁上的小提示 */
export const SHARE_PAGE_WATERMARK_NOTE = '此連結已加浮水印';

export const MEMBER_WATERMARK_LABEL = '成員看片也加浮水印';
export const MEMBER_WATERMARK_HINT = '團隊成員在這個專案看 3D 畫面和影片時，畫面上也印著自己的名字和時間。預設關。';
export const MEMBER_WATERMARK_DENIED = '只有製作可以改這一項';
