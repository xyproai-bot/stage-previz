// 3D 模型檔在 R2 的檔名（純計算）
//
// 模型檔用 /r2/<key> 直接下載、不用登入（分享頁也要能讀），所以檔名本身就是鑰匙：
//   以前：models/<專案 id>/<上傳時間>.glb               → 知道專案 id 就猜得到
//   現在：models/<專案 id>/<上傳時間>-<32 個 hex>.glb   → 加 128 bits 隨機，猜不到
//   模型庫：assets/models/<資產 id>-<32 個 hex>.glb（以前 assets/models/<資產 id>.glb）
// 舊的檔案不動、網址不變（瀏覽器快取的大模型照樣有效）。
// 檔名只拿來當鑰匙，不從檔名解析任何東西（上傳時間用 R2 記的時間）。

const HEX32_RE = /^[0-9a-f]{32}$/;

/** 128 bits 隨機 → 32 個小寫 hex */
export function randomKeyPart() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** 新上傳的專案模型 key（每次上傳一個新檔，內容永遠不變） */
export function newProjectModelKey(projectId, nowMs = Date.now(), rand = randomKeyPart()) {
  if (!HEX32_RE.test(rand)) throw new Error('bad random part');
  return `models/${projectId}/${nowMs}-${rand}.glb`;
}

/** 新建的模型庫資產 key（重新上傳會蓋掉同一個檔，用這個資產的專案都會換到新模型） */
export function newSharedAssetKey(assetId, rand = randomKeyPart()) {
  if (!HEX32_RE.test(rand)) throw new Error('bad random part');
  return `assets/models/${assetId}-${rand}.glb`;
}

/** /model/versions/:file 的檔名（舊的「時間.glb」和新的「時間-隨機.glb」都認） */
export function isModelVersionFile(name) {
  return typeof name === 'string' && /^\d{1,16}(-[0-9a-f]{32})?\.glb$/.test(name);
}

/** 新格式的專案模型（帶隨機碼、寫一次就不會再改）→ 可以讓瀏覽器一直快取 */
export function isImmutableModelKey(key) {
  return typeof key === 'string' && /^models\/[a-zA-Z0-9_-]{1,64}\/\d{1,16}-[0-9a-f]{32}\.glb$/.test(key);
}

/** /r2/<key> 的 Cache-Control：新格式一年 + immutable；舊格式和模型庫（會被重新上傳蓋掉）照舊 1 小時 */
export function modelCacheControl(key) {
  return isImmutableModelKey(key) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
}

/**
 * 版本清單上的上傳時間（毫秒）：R2 記的上傳時間 → 上傳時寫的 customMetadata.uploadedAt → 0
 * （不從檔名解析，新舊檔名都一樣）
 */
export function modelVersionTimestamp(obj) {
  const up = obj?.uploaded;
  const t = up instanceof Date ? up.getTime() : (up ? Date.parse(up) : NaN);
  if (Number.isFinite(t)) return t;
  const meta = Date.parse(obj?.customMetadata?.uploadedAt || '');
  return Number.isFinite(meta) ? meta : 0;
}
