// 快捷鍵要不要讓給正在操作的欄位
//
// 以前只要焦點在任何 <input> 上（連勾選框、滑桿也算）快捷鍵就不動：
// 在 3D 旁邊勾了一個物件、拖完機關滑桿之後按 Ctrl+Z 什麼都不會發生。
// 現在只有「會打字的欄位」才讓給瀏覽器（它們有自己的復原）；勾選框、滑桿、按鈕照樣用快捷鍵。

const TEXT_INPUT_TYPES = new Set([
  'text', 'search', 'email', 'url', 'tel', 'password', 'number',
  'date', 'datetime-local', 'month', 'time', 'week',
]);

/** 焦點在會打字的欄位（文字框、多行文字、可以編輯的區塊）→ 復原 / 重做交給瀏覽器 */
export function isTextEntryTarget(t: EventTarget | null): boolean {
  const el = t as { tagName?: string; type?: string; isContentEditable?: boolean } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has(String(el.type || 'text').toLowerCase());
  return false;
}

/** 一般字母快捷鍵（J / K 切歌…）：會打字的欄位和下拉選單（打字會跳選項）都讓給它們 */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (isTextEntryTarget(t)) return true;
  const el = t as { tagName?: string } | null;
  return !!el && typeof el.tagName === 'string' && el.tagName.toUpperCase() === 'SELECT';
}
