// 分享連結建好以後改：密碼、有效期、分享的歌（PATCH /api/projects/:id/share-links/:token）。
// 純判斷（不碰資料庫）：worker.js 用這裡整理好的結果去查歌、算雜湊、寫資料庫；shareLinkEdit.test.mjs 有測。
//
// 收的欄位（有給的才改，沒給的不動；舊版前端不送這幾個欄位，行為跟以前一模一樣）：
//   password       字串 = 設新密碼（跟建立時一樣：最多 60 字、存加鹽雜湊）；null = 拿掉密碼
//                  空字串 / 其他型別 = 不收（拿掉密碼一定要明確送 null，免得手滑把密碼清掉）
//   expiresInDays  正數 = 從現在起算幾天後過期（最多 365，跟建立時一樣）；null = 不會過期
//   expiresAt      ISO 時間字串（要是未來）= 到那個時間過期；null = 不會過期
//   songId         字串 = 只分享這一首（要是這個專案的歌，由 worker.js 查）；null = 整個專案
//                  空字串 = 不收（等於「一首都沒選」）
//
// 分享範圍只有兩種：整個專案（song_id 是 NULL）或單獨一首歌（song_id）。一條連結不能同時分享好幾首但不是全部。

import { SHARE_PASSWORD_MAX } from './sharePassword.mjs';

export const SHARE_EXPIRES_MAX_DAYS = 365;
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * @param {unknown} body PATCH 收到的內容
 * @param {{ now?: number }} [opts]
 * @returns {{ ok: true, edits: { password?: string | null, expiresAt?: string | null, songId?: string | null } }
 *         | { ok: false, error: string }}
 */
export function parseShareLinkEdits(body, { now = Date.now() } = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const edits = {};

  if ('password' in b) {
    const p = b.password;
    if (p === null) edits.password = null;
    else if (typeof p === 'string' && p) edits.password = p.slice(0, SHARE_PASSWORD_MAX);
    else return { ok: false, error: '密碼不能是空的（要拿掉密碼，請用「拿掉密碼」）' };
  }

  const hasDays = 'expiresInDays' in b;
  const hasAt = 'expiresAt' in b;
  if (hasDays && hasAt) return { ok: false, error: '有效期只能給一種寫法' };
  if (hasDays) {
    const d = b.expiresInDays;
    if (d === null) edits.expiresAt = null;
    else if (typeof d === 'number' && Number.isFinite(d) && d > 0) {
      edits.expiresAt = new Date(now + Math.min(d, SHARE_EXPIRES_MAX_DAYS) * 86400_000).toISOString();
    } else return { ok: false, error: '有效期的天數要大於 0（不要過期請選「不會過期」）' };
  }
  if (hasAt) {
    const a = b.expiresAt;
    if (a === null) edits.expiresAt = null;
    else {
      const t = typeof a === 'string' ? Date.parse(a) : NaN;
      if (!Number.isFinite(t)) return { ok: false, error: '有效期的日期格式不對' };
      if (t <= now) return { ok: false, error: '有效期要選今天以後的時間' };
      if (t > now + SHARE_EXPIRES_MAX_DAYS * 86400_000) return { ok: false, error: `有效期最多 ${SHARE_EXPIRES_MAX_DAYS} 天` };
      edits.expiresAt = new Date(t).toISOString();
    }
  }

  if ('songId' in b) {
    const s = b.songId;
    if (s === null) edits.songId = null;
    else if (typeof s === 'string' && ID_RE.test(s)) edits.songId = s;
    else return { ok: false, error: '請選一首歌，或選「整個專案」' };
  }

  return { ok: true, edits };
}

/** 有沒有任何一個要改的 */
export function hasShareLinkEdits(edits) {
  return !!edits && Object.keys(edits).length > 0;
}
