// 舊版留在瀏覽器裡的「材質 / 重置視角」暫存（sp-materials:*、sp-home-view:*）
//
// 以前後台還沒上線時，admin 調的材質跟重置視角先在自己電腦留一份，打開專案時會補存回專案。
// 後台上線後這反而會出事：同一個 admin 的另一台電腦還留著舊值，一打開專案就把舊值寫回去，
// 別台電腦剛重設的材質 / 視角就被蓋掉。現在一律以專案上存的為準，這些舊暫存打開時清掉。

import { listKeysWithPrefix } from './localPrefs';

/** 舊版材質暫存的前綴（stageLook/materialCache.ts，已拿掉） */
export const LEGACY_MATERIAL_CACHE_PREFIX = 'sp-materials:';
/** 舊版重置視角暫存的前綴（homeView.ts 以前的 read/writeHomeViewCache，已拿掉） */
export const LEGACY_HOME_VIEW_CACHE_PREFIX = 'sp-home-view:';

type StorageClear = Pick<Storage, 'length' | 'key' | 'removeItem'>;

/** 清掉所有專案的舊材質 / 重置視角暫存，回傳清掉幾個；storage 壞掉 / 無痕模式也不會丟錯 */
export function clearLegacyViewCaches(storage: StorageClear | null | undefined): number {
  if (!storage) return 0;
  // 先收齊再刪：邊數邊刪 index 會跳號
  const keys = [
    ...listKeysWithPrefix(storage, LEGACY_MATERIAL_CACHE_PREFIX),
    ...listKeysWithPrefix(storage, LEGACY_HOME_VIEW_CACHE_PREFIX),
  ];
  let removed = 0;
  for (const k of keys) {
    try { storage.removeItem(k); removed++; } catch { /* 刪不掉就跳過 */ }
  }
  return removed;
}
