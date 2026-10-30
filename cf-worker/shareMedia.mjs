// 分享連結的「禁止下載」（0038）：訪客播影片用的短效播放通行證 + 連結編號。純函式，不碰資料庫；shareMedia.test.mjs 有測。
//
// 為什麼要有播放通行證：
//   以前沒設密碼的連結，影片網址是 /api/share/<連結碼>/song-videos/<影片>/stream —— 連結碼永遠有效，
//   拿到這個網址的人（或從瀏覽器開發人員工具複製出來的人）什麼時候都能直接下載。
//   連結打開「禁止下載」之後：
//     - 影片網址後面一定要帶 ?play=<播放通行證>，沒帶或過期一律 401（不給檔案）
//     - 播放通行證綁「這條連結 + 這一支影片」，換連結、換影片都不能用，幾個小時就失效（過期後重新整理頁面拿新的）
//     - 網址和回應裡都沒有 R2 的檔案位置（r2_key 從來不會出現在分享連結的回應裡）
//     - 回應不讓瀏覽器 / 中間的快取存起來（Cache-Control: private, no-store）
//   成員的影片網址本來就是綁登入者的短效通行證（videos.mjs signVideoPass），不在這裡。
//
// 連結編號：連結碼雜湊後取 6 個大寫英數字。浮水印上印這組編號，製作在「公開分享連結」清單看到同一組，
// 外流的畫面上有編號就知道是哪一條連結；連結碼本身不會露給用好讀網址（/s/名稱）打開的人。

const enc = new TextEncoder();

/** 播放通行證每 3 小時換一次（同一段時間拿到的一樣），有效 3～6 小時 */
export const SHARE_PLAY_BUCKET_MS = 3 * 3600 * 1000;

// noun：影片 / 音樂（歌曲的音樂也走這一套播放通行證，見 songMusic.mjs 的 shareMusicMediaId）
export const playTokenMissingMessage = (noun = '影片') => `這條分享連結不能直接下載${noun}，請從分享頁面播放`;
export const PLAY_TOKEN_MISSING_MESSAGE = playTokenMissingMessage();
export const PLAY_TOKEN_EXPIRED_MESSAGE = '播放網址過期了，請重新整理頁面';

async function hmac(secret, data) {
  const key = await globalThis.crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(data)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sameStr(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** 播放通行證：「到期時間.簽章」，綁連結碼 + 影片（mediaId：歌曲影片的 id，或舊的 Drive 檔案 id，或 music:<音樂 id>） */
export async function signSharePlay(secret, { linkToken, mediaId, now = Date.now() }) {
  const exp = (Math.floor(now / SHARE_PLAY_BUCKET_MS) + 2) * SHARE_PLAY_BUCKET_MS;
  const sig = await hmac(secret, `share-play|${linkToken}|${mediaId}|${exp}`);
  return `${exp}.${sig}`;
}

/** 通行證對不對（要同一條連結、同一支影片、還沒過期、簽章正確） */
export async function verifySharePlay(secret, token, { linkToken, mediaId, now = Date.now() }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return false;
  const [expStr, sig] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= now || exp > now + 2 * SHARE_PLAY_BUCKET_MS) return false;
  const expected = await hmac(secret, `share-play|${linkToken}|${mediaId}|${exp}`);
  return sameStr(sig, expected);
}

/**
 * 影片串流請求能不能放行。
 *   noDownload 沒開 → 放行（跟以前一樣：連結碼 / 好讀網址 + 密碼通行證就夠）
 *   noDownload 開了 → 一定要有效的播放通行證
 * @returns {{ok: true} | {ok: false, status: 401, error: string, passExpired: boolean}}
 */
export async function decideShareStream(secret, { noDownload, playToken, linkToken, mediaId, now = Date.now(), noun = '影片' }) {
  if (!noDownload) return { ok: true };
  if (!playToken) return { ok: false, status: 401, error: playTokenMissingMessage(noun), passExpired: false };
  if (await verifySharePlay(secret, playToken, { linkToken, mediaId, now })) return { ok: true };
  return { ok: false, status: 401, error: PLAY_TOKEN_EXPIRED_MESSAGE, passExpired: true };
}

/** 影片網址後面接的東西：有密碼的連結接 access（密碼通行證）、禁止下載接 play（播放通行證） */
export function withShareQuery(path, { access = null, play = null } = {}) {
  const q = [];
  if (access) q.push(`access=${encodeURIComponent(access)}`);
  if (play) q.push(`play=${encodeURIComponent(play)}`);
  return q.length ? `${path}?${q.join('&')}` : path;
}

/** 影片回應的快取規則：禁止下載 → 不讓瀏覽器 / 快取存；沒開 → 跟以前一樣（每一版一個網址，內容不變，可以一直快取） */
export function sharePlaybackCacheControl(noDownload) {
  return noDownload ? 'private, no-store' : 'private, max-age=31536000, immutable';
}

const ID_ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** 連結編號：6 個大寫英數字（沒有 I、O），同一個連結碼永遠同一組 */
export async function shortLinkId(linkToken) {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', enc.encode(`share-id|${linkToken}`)));
  let out = '';
  for (let i = 0; i < 6; i++) out += ID_ALPHABET[digest[i] % ID_ALPHABET.length];
  return out;
}
