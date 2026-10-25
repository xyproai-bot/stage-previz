// 分享連結建好以後改：密碼、有效期、分享的歌（公開分享連結面板每一條連結的「改密碼」「改有效期」「改分享的歌」）。
// 純判斷（不碰畫面）：選項怎麼排、選到的值要送什麼給後台、現在的狀態怎麼說。後台對應 cf-worker/shareLinkEdit.mjs。
//
// 分享範圍只有兩種：整個專案，或單獨一首歌（一條連結不能同時分享「幾首但不是全部」）。

import type { Choice } from '../components/dialogs/dialogStore';
import { formatDate, parseServerTime } from './serverTime';
import { songTitle } from './songCode';

export const SHARE_PASSWORD_MAX = 60;

// 畫面文字（守門測試 shareLinkEdit.test.ts 會確認面板上真的有）
export const EDIT_PASSWORD_LABEL = '改密碼';
export const REMOVE_PASSWORD_LABEL = '拿掉密碼';
export const EDIT_EXPIRY_LABEL = '改有效期';
export const NEVER_EXPIRES_LABEL = '不會過期';
export const EDIT_SONGS_LABEL = '改分享的歌';
export const SAVED_TOAST = '已更新';

/** 有效期的選項（從今天起算幾天）；跟建立連結時的選項一樣 */
export const EXPIRY_DAYS = [1, 7, 30, 90] as const;

const EXPIRY_NEVER = 'never';
const expiryValue = (days: number) => `days:${days}`;

/** 現在的有效期用一句話說 */
export function expiryText(expiresAt: string | null | undefined, now: number = Date.now()): string {
  if (!expiresAt) return NEVER_EXPIRES_LABEL;
  const t = parseServerTime(expiresAt);
  if (!Number.isFinite(t)) return NEVER_EXPIRES_LABEL;
  return t < now ? `已過期（${formatDate(expiresAt)}）` : `到 ${formatDate(expiresAt)} 為止`;
}

/** 「改有效期」的選項：幾天後過期（從今天重新算起）+ 不會過期 */
export function expiryChoices(expiresAt: string | null | undefined): Choice[] {
  return [
    ...EXPIRY_DAYS.map(d => ({ value: expiryValue(d), label: `${d} 天` })),
    { value: EXPIRY_NEVER, label: NEVER_EXPIRES_LABEL, current: !expiresAt },
  ];
}

/** 選到的有效期 → 要送給後台的內容；不認得 → null */
export function expiryPatch(value: string | null | undefined): { expiresInDays: number | null } | null {
  if (value === EXPIRY_NEVER) return { expiresInDays: null };
  const m = /^days:(\d{1,3})$/.exec(value ?? '');
  if (!m) return null;
  const d = Number(m[1]);
  return d > 0 ? { expiresInDays: d } : null;
}

/** 「整個專案」那個選項的值（歌的 id 不會是這個） */
export const SCOPE_ALL = '__all__';

interface SongLike { id: string; name: string; code?: string | null }

/** 「改分享的歌」的選項：整個專案 + 這個專案的每一首歌；目前的那個標「目前」 */
export function scopeChoices(songs: readonly SongLike[], currentSongId: string | null | undefined): Choice[] {
  return [
    { value: SCOPE_ALL, label: '整個專案', current: !currentSongId },
    ...songs.map(s => ({ value: s.id, label: songTitle(s), current: s.id === currentSongId })),
  ];
}

/** 選到的範圍 → 要送給後台的內容（整個專案 = null）；不在這個專案的歌 → null（不送） */
export function scopePatch(value: string | null | undefined, songs: readonly SongLike[]): { songId: string | null } | null {
  if (value === SCOPE_ALL) return { songId: null };
  return songs.some(s => s.id === value) ? { songId: value as string } : null;
}

/** 現在分享的是什麼（一句話） */
export function scopeText(songId: string | null | undefined, songs: readonly SongLike[]): string {
  if (!songId) return '整個專案';
  const s = songs.find(x => x.id === songId);
  return s ? songTitle(s) : '單首歌';
}

/** 新密碼 → 要送給後台的內容；空白（全是空格）不送 */
export function passwordPatch(raw: string | null | undefined): { password: string } | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return { password: raw.slice(0, SHARE_PASSWORD_MAX) };
}
