// 「上次登入」顯示成白話：剛才 / 5 分鐘前 / 3 小時前 / 2 天前 / 日期；從未登入
import { parseServerTime } from './serverTime';

export function formatLastLogin(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '從未登入';
  const d = new Date(parseServerTime(iso));  // 手動加 Z 的寫法 Safari 讀不懂（中間是空白不是 T）
  const ms = now - d.getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return '剛才';
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} 天前`;
  return d.toLocaleDateString('zh-TW');
}
