// 浮水印 / 禁止下載的規則（純判斷，不碰畫面和資料庫）。
// 前端和後台共用同一份（cf-worker 直接 import 這個檔，跟 stageProps.ts 一樣），預設值和權限不會兩邊各寫一套。
//
//   分享連結：「浮水印」「禁止下載」各一個開關
//     新建立的連結：浮水印預設關（2026-10-22 用戶覺得干擾）、禁止下載預設開
//     0038 以前建的舊連結：兩個都關（上線後行為不變，製作自己去打開）
//   專案：「成員看片也加浮水印」，預設關，只有製作可以改

/** 新建立的分享連結，兩個開關的預設 */
export const NEW_LINK_PROTECTION = Object.freeze({ watermark: false, noDownload: true });
/** 0038 以前建的舊連結（migration 補的預設值） */
export const LEGACY_LINK_PROTECTION = Object.freeze({ watermark: false, noDownload: false });
/** 專案「成員看片也加浮水印」的預設 */
export const MEMBER_WATERMARK_DEFAULT = false;

/** 後台存的是 0 / 1；API 說的是 true / false */
export interface LinkProtection {
  watermark: boolean;
  noDownload: boolean;
}

export type FlagRead = { ok: true; value: boolean | undefined } | { ok: false };

/** 讀一個開關：true / false / 0 / 1 都收；沒給（undefined）= 沒有意見；其他（字串、null、數字 2…）= 不合法 */
export function readFlag(raw: unknown): FlagRead {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === true || raw === 1) return { ok: true, value: true };
  if (raw === false || raw === 0) return { ok: true, value: false };
  return { ok: false };
}

export type ProtectionFields = { watermark: 0 | 1; no_download: 0 | 1 };

export const PROTECTION_FLAG_ERROR = '浮水印、禁止下載要用 true 或 false';

/** 建立連結：body 沒給的開關用預設（浮水印關、禁止下載開）。舊版前端不會送這兩個欄位 → 新連結照樣用這個預設 */
export function resolveNewLinkProtection(body: unknown): { ok: true; fields: ProtectionFields } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const w = readFlag(b.watermark);
  const d = readFlag(b.noDownload);
  if (!w.ok || !d.ok) return { ok: false, error: PROTECTION_FLAG_ERROR };
  return {
    ok: true,
    fields: {
      watermark: (w.value ?? NEW_LINK_PROTECTION.watermark) ? 1 : 0,
      no_download: (d.value ?? NEW_LINK_PROTECTION.noDownload) ? 1 : 0,
    },
  };
}

/** 修改連結：只改有給的開關（沒給的不動） */
export function resolveLinkProtectionPatch(body: unknown): { ok: true; fields: Partial<ProtectionFields> } | { ok: false; error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const w = readFlag(b.watermark);
  const d = readFlag(b.noDownload);
  if (!w.ok || !d.ok) return { ok: false, error: PROTECTION_FLAG_ERROR };
  const fields: Partial<ProtectionFields> = {};
  if (w.value !== undefined) fields.watermark = w.value ? 1 : 0;
  if (d.value !== undefined) fields.no_download = d.value ? 1 : 0;
  return { ok: true, fields };
}

/** 資料庫一列 → 兩個開關（舊版資料庫沒有欄位 / 值是 null = 關） */
export function protectionOfRow(row: { watermark?: unknown; no_download?: unknown } | null | undefined): LinkProtection {
  return { watermark: Number(row?.watermark) === 1, noDownload: Number(row?.no_download) === 1 };
}

/** 誰能改專案的「成員看片也加浮水印」：只有這個專案的製作（role 是專案裡的角色代號） */
export function canSetMemberWatermark(role: string | null | undefined): boolean {
  return role === 'admin';
}

export const MEMBER_WATERMARK_DENIED_MESSAGE = '只有製作可以改「成員看片也加浮水印」';

/** 資料庫 / API 的值 → 開或關（沒有 = 預設） */
export function memberWatermarkOn(raw: unknown): boolean {
  if (raw === undefined || raw === null) return MEMBER_WATERMARK_DEFAULT;
  return raw === true || Number(raw) === 1;
}

/** 這位成員現在看片要不要加浮水印（專案開了就加，不分角色；製作自己看也加，這樣製作看得到成員看到的樣子） */
export function shouldWatermarkMember(projectFlag: unknown): boolean {
  return memberWatermarkOn(projectFlag);
}

/** 分享連結的訪客要不要加浮水印 */
export function shouldWatermarkGuest(protection: { watermark?: boolean } | null | undefined): boolean {
  return !!protection?.watermark;
}
