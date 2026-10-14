// 留言文字裡的連結：找出網址（變成可以點的）、太長的網址縮短顯示、認得的影片 / 參考網站多一張小卡片。
// 純函式（commentLinks.test.ts 有測）；畫面在 components/CommentAttachments.tsx 的 CommentText。
//
//   - 只認 http:// 和 https:// 開頭的（javascript:、data: 這些一律當字）；留言內容一律當文字顯示，不會變成 HTML
//   - 網址只到英數和網址符號為止：中文、全形標點（，。「」（）：）、空白都會把網址斷開
//   - 結尾的 . , ; : ! ? 引號、沒有成對的 ) ] 不算網址（「看這個 https://a.com/x。」）
//   - 有帳號密碼的網址（https://youtube.com@壞網站）不變成連結
//   - 卡片：YouTube、Vimeo、Google 雲端硬碟、Dropbox、Instagram、Bilibili、優酷（不向這些網站抓預覽）

export type LinkKind = 'youtube' | 'vimeo' | 'drive' | 'dropbox' | 'instagram' | 'bilibili' | 'youku';

export type TextPart =
  | { type: 'text'; text: string }
  | { type: 'link'; url: string; text: string };

export interface LinkCard {
  kind: LinkKind;
  /** 網站名稱（卡片上的字） */
  label: string;
  /** 卡片第二行：影片 / 檔案 / 貼文 */
  what: string;
  url: string;
  /** YouTube 影片的 id（有的話卡片試著顯示縮圖；載不到就只有圖示） */
  youtubeId?: string;
}

const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi;
const TRAILING = /[.,;:!?'"*]$/;

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/** 去掉結尾不算網址的標點（沒有成對的括號也去掉） */
export function trimUrlEnd(raw: string): string {
  let s = raw;
  for (;;) {
    if (TRAILING.test(s)) { s = s.slice(0, -1); continue; }
    if (s.endsWith(')') && count(s, ')') > count(s, '(')) { s = s.slice(0, -1); continue; }
    if (s.endsWith(']') && count(s, ']') > count(s, '[')) { s = s.slice(0, -1); continue; }
    return s;
  }
}

/** 是不是可以點的網址（http / https、有網域、沒有帳號密碼） */
export function safeLinkUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname;
  if (!host || (!host.includes('.') && host !== 'localhost')) return null;
  return u.href;
}

/** 留言文字 → 一段一段（字 / 連結）；連結的 url 一定是 http(s) */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const s = String(text ?? '');
  let last = 0;
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(s); m; m = URL_RE.exec(s)) {
    const raw = trimUrlEnd(m[0]);
    const url = raw.length > 'https://'.length ? safeLinkUrl(raw) : null;
    if (!url) continue;
    if (m.index > last) parts.push({ type: 'text', text: s.slice(last, m.index) });
    parts.push({ type: 'link', url, text: raw });
    last = m.index + raw.length;
    URL_RE.lastIndex = last;
  }
  if (last < s.length) parts.push({ type: 'text', text: s.slice(last) });
  return parts;
}

/** 留言裡的網址（照順序、去掉重複） */
export function findLinks(text: string): string[] {
  const out: string[] = [];
  for (const p of splitLinks(text)) if (p.type === 'link' && !out.includes(p.url)) out.push(p.url);
  return out;
}

/** 太長的網址縮短顯示：拿掉 https://、www.，中間用「…」（完整的放在 title） */
export function shortenUrl(url: string, max = 42): string {
  const s = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  if (s.length <= max) return s;
  const tail = 10;
  return `${s.slice(0, Math.max(8, max - tail - 1))}…${s.slice(-tail)}`;
}

const hostIs = (host: string, domain: string) => host === domain || host.endsWith('.' + domain);
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

function youtubeId(u: URL): string | null {
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  let id: string | null = null;
  if (host === 'youtu.be') id = seg[0] ?? null;
  else if (seg[0] === 'watch') id = u.searchParams.get('v');
  else if (['shorts', 'embed', 'live', 'v'].includes(seg[0] ?? '')) id = seg[1] ?? null;
  return id && YT_ID.test(id) ? id : null;
}

/** 認得的影片 / 參考網站 → 小卡片的內容；其他網站 → null */
export function classifyLink(url: string): LinkCard | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  if (hostIs(host, 'youtube.com') || host === 'youtu.be' || hostIs(host, 'youtube-nocookie.com')) {
    const id = youtubeId(u);
    const shorts = path.startsWith('/shorts/');
    return { kind: 'youtube', label: 'YouTube', what: shorts ? '短影片' : id ? '影片' : '頻道 / 清單', url, ...(id ? { youtubeId: id } : {}) };
  }
  if (hostIs(host, 'vimeo.com')) return { kind: 'vimeo', label: 'Vimeo', what: '影片', url };
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    const folder = path.includes('/folders/');
    return { kind: 'drive', label: 'Google 雲端硬碟', what: folder ? '資料夾' : '檔案', url };
  }
  if (hostIs(host, 'dropbox.com') || hostIs(host, 'dropboxusercontent.com') || host === 'db.tt') {
    return { kind: 'dropbox', label: 'Dropbox', what: path.includes('/scl/fo/') || path.startsWith('/sh/') ? '資料夾' : '檔案', url };
  }
  if (hostIs(host, 'instagram.com') || host === 'instagr.am') {
    return { kind: 'instagram', label: 'Instagram', what: /^\/(reels?|tv)\//.test(path) ? 'Reels 影片' : '貼文', url };
  }
  if (hostIs(host, 'bilibili.com') || host === 'b23.tv') return { kind: 'bilibili', label: 'Bilibili', what: '影片', url };
  if (hostIs(host, 'youku.com')) return { kind: 'youku', label: '優酷', what: '影片', url };
  return null;
}

/** 一則留言要顯示的卡片（認得的網址，最多 3 張、同一個網址一張） */
export function linkCards(text: string, max = 3): LinkCard[] {
  const out: LinkCard[] = [];
  for (const url of findLinks(text)) {
    const c = classifyLink(url);
    if (c) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/** YouTube 縮圖（i.ytimg.com；中國等地方連不到 → 卡片只顯示圖示，見 CommentText） */
export function youtubeThumb(id: string): string {
  return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
}
