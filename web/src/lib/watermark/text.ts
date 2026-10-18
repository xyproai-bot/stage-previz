// 浮水印上寫什麼字（純函式）：誰在看 + 現在的日期時間。
//
//   成員：顯示名稱，有 email 的話接在後面（系統自己產生的假 email 不算）
//   分享連結的訪客：他留言時寫的名字 +「連結 #編號」；沒寫過名字 →「分享連結：連結名稱 · #編號」
//   編號（linkId）是後台用連結碼算出來的 6 個字，製作在「公開分享連結」清單裡看得到同一組，
//   外流的畫面上看到編號就知道是哪一條連結（連結碼本身不會露給用好讀網址打開的人）

export type WatermarkIdentity =
  | { kind: 'member'; name: string; email?: string | null }
  | { kind: 'guest'; guestName?: string | null; linkName?: string | null; linkId: string };

const SEP = ' · ';
const NAME_MAX = 24;
const EMAIL_MAX = 40;
const LINK_NAME_MAX = 24;

function clean(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  // 一行、不要控制字元；太長截掉
  const one = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(one).slice(0, max).join('');
}

/** 後台建使用者時塞的假 email（xxx@auto.local）不是真的信箱，不要印在浮水印上 */
export function isRealEmail(email: unknown): boolean {
  if (typeof email !== 'string') return false;
  const e = email.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return false;
  return !/@auto\.local$/i.test(e) && !/\.(test|invalid|example)$/i.test(e);
}

/** 連結編號顯示成「#A1B2C3」（後台給 6 個大寫英數字；沒有就不印） */
export function linkIdLabel(linkId: unknown): string {
  const id = clean(linkId, 12).replace(/^#/, '').toUpperCase();
  return id ? `#${id}` : '';
}

/** 誰在看：浮水印的第一行 */
export function identityText(id: WatermarkIdentity): string {
  if (id.kind === 'member') {
    const name = clean(id.name, NAME_MAX) || '成員';
    const email = isRealEmail(id.email) ? clean(id.email, EMAIL_MAX) : '';
    return email ? `${name}${SEP}${email}` : name;
  }
  const idLabel = linkIdLabel(id.linkId);
  const guest = clean(id.guestName, NAME_MAX);
  if (guest) return [guest, idLabel ? `連結 ${idLabel}` : '分享連結'].join(SEP);
  const linkName = clean(id.linkName, LINK_NAME_MAX);
  return [linkName ? `分享連結：${linkName}` : '分享連結', idLabel].filter(Boolean).join(SEP);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 現在的日期時間（這台電腦的時區），精準到分：2026-10-18 14:05 */
export function formatWatermarkStamp(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

/** 浮水印的字：[誰在看, 日期時間] */
export function watermarkLines(id: WatermarkIdentity, now: Date): [string, string] {
  return [identityText(id), formatWatermarkStamp(now)];
}

/** 兩個身分一樣嗎（store 用：一樣就不重畫） */
export function sameIdentity(a: WatermarkIdentity | null, b: WatermarkIdentity | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
