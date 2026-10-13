// 發給別人的連結（分享連結等）要用哪個網址開頭 —— 全站只在這裡決定。
//
// 規則：
//   - 在「正式站」上（previz.haimiaan.com，或舊的 stage-previz.vercel.app）→ 一律用 PUBLIC_SITE_URL，
//     所以就算 admin 還在用舊網址操作，複製出去的也是新網域。
//   - 其他地方（本機開發、測試站 test.previz.haimiaan.com、Vercel 預覽網址）→ 用目前這個網址，
//     測試中的功能（例如 /s/ 好讀網址）才會開到同一版程式，不會開到還沒有這功能的正式站。

/** 正式站網址（自己的網域） */
export const PUBLIC_SITE_URL = 'https://previz.haimiaan.com';

/** 這些主機都是「正式站」（master 分支部署出來的）：在這裡產生的連結換成 PUBLIC_SITE_URL */
const PRODUCTION_HOSTS: ReadonlySet<string> = new Set([
  'previz.haimiaan.com',
  'stage-previz.vercel.app',
  'stage-previz-haimiaan-s-projects.vercel.app',
]);

function currentOrigin(): string {
  return typeof window !== 'undefined' && window.location ? window.location.origin : PUBLIC_SITE_URL;
}

/** 連結要用的網址開頭（不含結尾的 /） */
export function publicSiteOrigin(origin: string = currentOrigin()): string {
  let host: string;
  try { host = new URL(origin).hostname; } catch { return PUBLIC_SITE_URL; }
  if (PRODUCTION_HOSTS.has(host)) return PUBLIC_SITE_URL;
  return origin.replace(/\/+$/, '');
}

/** 舊式分享網址：/share/<一長串連結碼> */
export function shareTokenUrl(token: string, origin?: string): string {
  return `${publicSiteOrigin(origin)}/share/${encodeURIComponent(token)}`;
}

/** 好讀的分享網址：/s/<網址名稱> */
export function shareSlugUrl(slug: string, origin?: string): string {
  return `${publicSiteOrigin(origin)}/s/${encodeURIComponent(slug)}`;
}

/** 邀請連結：/invite/<邀請碼>（測試站建的邀請開到測試站） */
export function inviteUrl(token: string, origin?: string): string {
  return `${publicSiteOrigin(origin)}/invite/${encodeURIComponent(token)}`;
}

/** 登入頁（傳登入碼給別人時附上） */
export function loginPageUrl(origin?: string): string {
  return `${publicSiteOrigin(origin)}/login`;
}
