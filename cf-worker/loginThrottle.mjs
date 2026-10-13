// 登入防猜號碼：同一個來源 IP 在 15 分鐘內打錯 10 次 → 鎖 15 分鐘（回 429）。
// 這裡只放「純判斷」（不碰資料庫），方便測試；資料庫讀寫在 worker.js 的 authLogin。

export const LOGIN_MAX_FAILURES = 10;               // 視窗內最多可錯幾次
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;      // 算錯誤次數的視窗
export const LOGIN_LOCK_MS = 15 * 60 * 1000;        // 鎖多久（從第 10 次錯算起）
export const LOGIN_ATTEMPT_KEEP_MS = 24 * 3600 * 1000; // 超過一天的紀錄可以清掉
// 判斷只需要看這段時間內的錯誤（視窗 + 鎖定時間）
export const LOGIN_LOOKBACK_MS = LOGIN_WINDOW_MS + LOGIN_LOCK_MS;

/**
 * 給「這個 IP 最近的錯誤時間（毫秒）」和「現在」，決定這次能不能試。
 *
 * 規則：只要某一次錯誤發生時，往前 15 分鐘內（含它自己）累積到 10 次，
 * 就從那一次起鎖 15 分鐘。鎖定期間被擋的嘗試不會記成錯誤，所以鎖完會乾淨重新算。
 *
 * @param {number[]} failureTimes 錯誤發生時間（epoch ms，順序不拘）
 * @param {number} now 現在（epoch ms）
 * @returns {{ allowed: boolean, retryAfterMs: number }}
 */
export function loginThrottleDecision(failureTimes, now, {
  maxFailures = LOGIN_MAX_FAILURES,
  windowMs = LOGIN_WINDOW_MS,
  lockMs = LOGIN_LOCK_MS,
} = {}) {
  const times = (Array.isArray(failureTimes) ? failureTimes : [])
    .map(Number)
    .filter((t) => Number.isFinite(t) && t <= now && t > now - (windowMs + lockMs))
    .sort((a, b) => a - b);

  let lockUntil = 0;
  let start = 0;
  for (let i = 0; i < times.length; i++) {
    // 滑動視窗：(times[i] - windowMs, times[i]] 之內的錯誤數
    while (times[start] <= times[i] - windowMs) start++;
    if (i - start + 1 >= maxFailures) lockUntil = Math.max(lockUntil, times[i] + lockMs);
  }

  if (now < lockUntil) return { allowed: false, retryAfterMs: lockUntil - now };
  return { allowed: true, retryAfterMs: 0 };
}

/** 429 時給使用者看的話（剩幾分鐘，至少 1 分鐘） */
export function loginLockedMessage(retryAfterMs) {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60000));
  return `錯太多次了，請 ${minutes} 分鐘後再試`;
}

/**
 * 把來源 IP 變成記錄用的 key。
 * IPv6 一般一戶就配一整段 /64，換位址不用成本 → 以 /64 為單位算，避免換位址繞過。
 * 沒有 IP（本機開發）→ 'unknown'。
 */
export function loginClientKey(rawIp) {
  const ip = (rawIp || '').toString().split(',')[0].trim();
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip.slice(0, 64);

  // IPv6：去掉 zone（%eth0），展開 '::'，取前 4 組
  const addr = ip.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  // IPv4-mapped（::ffff:1.2.3.4）→ 當 IPv4
  const mapped = addr.match(/^[0:]*:ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return mapped[1];
  const [head, tail] = addr.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = addr.includes('::') ? Math.max(0, 8 - headParts.length - tailParts.length) : 0;
  const groups = [...headParts, ...Array(missing).fill('0'), ...tailParts];
  if (groups.length < 4 || groups.slice(0, 4).some((g) => !/^[0-9a-f]{1,4}$/.test(g))) {
    return addr.slice(0, 64); // 看不懂的格式就原樣（截長度）
  }
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/**
 * 分享連結密碼也用同一套防猜（同一張 login_attempts 表，同樣 15 分鐘錯 10 次鎖 15 分鐘）。
 * 記錄用的 key = 連結 token + 來源 IP，猜某一條連結不會鎖到別的連結，也不會鎖到登入。
 * 登入的 key 是純 IP（loginClientKey），不會以 'share:' 開頭，所以兩邊的紀錄不會混在一起。
 */
export function shareAttemptKey(token, ipKey) {
  return `share:${String(token || '').slice(0, 64)}|${String(ipKey || 'unknown').slice(0, 64)}`;
}
