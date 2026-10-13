// 「貼連結」框旁邊的小提示：看起來是哪一種連結（真的能不能抓由後台判斷，錯誤訊息照後台的中文顯示）。

export type VideoLinkKind = 'drive' | 'dropbox' | 'onedrive' | 'direct' | 'other' | 'invalid' | 'empty';

export function detectVideoLink(raw: string): VideoLinkKind {
  const s = String(raw ?? '').trim();
  if (!s) return 'empty';
  let u: URL;
  try { u = new URL(s); } catch { return 'invalid'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'invalid';
  const host = u.hostname.toLowerCase();
  if (host === 'drive.google.com' || host === 'docs.google.com' || host === 'drive.usercontent.google.com') return 'drive';
  if (host === 'dropbox.com' || host.endsWith('.dropbox.com') || host.endsWith('.dropboxusercontent.com')) return 'dropbox';
  if (host === '1drv.ms' || host.endsWith('onedrive.live.com') || host.endsWith('.sharepoint.com')) return 'onedrive';
  if (/\.(mp4|m4v|mov|webm)$/i.test(u.pathname)) return 'direct';
  return 'other';
}

/** 框下面的一句話 */
export function videoLinkHint(kind: VideoLinkKind): string {
  switch (kind) {
    case 'drive': return 'Google Drive 單一檔案（檔案要設「知道連結的使用者都能查看」）';
    case 'dropbox': return 'Dropbox 分享連結';
    case 'onedrive': return 'OneDrive / SharePoint 分享連結';
    case 'direct': return '影片檔的直接網址';
    case 'other': return '會試著直接下載這個網址';
    case 'invalid': return '請貼完整的網址（https:// 開頭）';
    default: return '可以貼 Google Drive 單檔、Dropbox、OneDrive，或 .mp4 / .mov / .webm 的直接網址';
  }
}
