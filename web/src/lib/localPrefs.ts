// 這台電腦（這個瀏覽器）存的個人設定 — 設定頁用來顯示 / 清掉「自己調的現場亮度」。
//
// 只動 sp-look:*（每個人自己調的現場亮度，見 stageLook/personalLook.ts）。
// admin 的材質暫存（sp-materials:*）、重置視角暫存（sp-home-view:*）可能還有沒存到伺服器的設定，
// 視角書籤（sp_camera_bookmarks:*）是使用者自己存的，這裡都不碰。

type StorageScan = Pick<Storage, 'length' | 'key'>;
type StorageClear = StorageScan & Pick<Storage, 'removeItem'>;

/** 跟 stageLook/personalLook.ts 的 key() 同一個前綴 */
export const PERSONAL_LOOK_PREFIX = 'sp-look:';

/** 找出所有「前綴 + 至少一個字」的 key；storage 壞掉 / 無痕模式 → 空清單 */
export function listKeysWithPrefix(storage: StorageScan | null | undefined, prefix: string): string[] {
  const out: string[] = [];
  if (!storage) return out;
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.length > prefix.length && k.startsWith(prefix)) out.push(k);
    }
  } catch { /* 讀不到就當沒有 */ }
  return out;
}

/** 有幾個專案存了自己調的現場亮度 */
export function countPersonalLooks(storage: StorageScan | null | undefined): number {
  return listKeysWithPrefix(storage, PERSONAL_LOOK_PREFIX).length;
}

/** 清掉所有自己調的現場亮度（回到專案預設），回傳清掉幾個 */
export function clearPersonalLooks(storage: StorageClear | null | undefined): number {
  if (!storage) return 0;
  // 先收齊再刪：邊數邊刪 index 會跳號
  const keys = listKeysWithPrefix(storage, PERSONAL_LOOK_PREFIX);
  let removed = 0;
  for (const k of keys) {
    try { storage.removeItem(k); removed++; } catch { /* 刪不掉就跳過 */ }
  }
  return removed;
}
