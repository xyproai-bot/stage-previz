// 分享連結的 LED 畫面來源：一打開放什麼。
//   - 這首歌有影片 → 放影片（最新的一版）
//   - 沒有影片 → 什麼都不放（LED 顯示測試圖），上面寫「這首歌還沒有影片」；AE 即時 / 本地檔案照樣可以選
//   - 這個人上次在這個分享連結自己選過 AE 即時 / 本地檔案 → 照上次的（動畫師也會用分享連結）
// AE 即時的檢查清單（小程序、NDI Tools…）要使用者自己按了「AE 即時」才出現；
// 按之前完全不連 ws://127.0.0.1:7777（新版 Chrome 一連就會跳「要允許連到這個網路上的裝置嗎」，客戶不該看到）。
// 純函式（shareSource.test.ts 有測）

import type { ShareRef } from './api';
import type { LedSource } from '../components/LedSourceSwitch';

/** 記住這個人在「這個分享連結」上次自己選的來源（每個連結分開記） */
export function shareSourceStorageKey(ref: Pick<ShareRef, 'kind' | 'key'>): string {
  return `sp_led_source:share:${ref.kind}:${ref.key}`;
}

/**
 * 現在 LED 放什麼；null = 什麼都不放（測試圖）。
 * pref = 上次自己選的（沒選過 = null）；hasVideo = 這首歌有可以播的影片；settled = 這首歌的影片清單讀完了
 */
export function resolveShareSource(o: { pref: LedSource | null; hasVideo: boolean; settled: boolean }): LedSource | null {
  if (o.pref === 'ndi' || o.pref === 'file') return o.pref;
  // 沒選過 / 選了影片：有影片就放；還在讀清單時先當作影片（「讀取影片中…」，不會先閃一下別的）
  if (o.hasVideo || !o.settled) return 'version';
  return null;
}

/** 沒有放東西時上面那一行（讀清單失敗 → 說失敗了，不是沒有影片） */
export function noSourceStatus(versionsError: string | null): string {
  return versionsError ? versionsError : '這首歌還沒有影片';
}
