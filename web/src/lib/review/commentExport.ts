// 匯出留言：一首歌、一個版本（或全部版本）的留言 → 可以列印的頁面（瀏覽器「列印 → 儲存為 PDF」）和 CSV。
// 純函式（commentExport.test.ts 有測）；按鈕、對話框在 components/ExportCommentsDialog.tsx。
//
//   每一則：編號、時間（區段 0:12–0:18）、時間碼、版本、作者、身分、內容、狀態、縮圖（含畫記）、底下的回覆
//   縮圖是留言當下抓的（後台 R2）；舊留言沒有縮圖、但有畫記 → 用灰底把畫記畫出來

import type { SongComment } from '../api';
import type { CommentThread } from '../commentThreads';
import { roleLabel } from '../roleLabels';
import { formatDateTime } from '../serverTime';
import { formatRange, formatTimecode } from './timecode';
import { parseAnnotation, shapePath, strokePx } from './annotations';

export interface ExportMeta {
  projectName: string;
  songTitle: string;
  /** 'V3'；全部版本 = '全部版本' */
  versionLabel: string;
  /** 篩選的說明（例：未解決） */
  filterLabel?: string;
  /** 匯出的時間（ISO） */
  generatedAt: string;
  /** 量到的影片格數（時間碼用；不知道 = 30） */
  fps?: number | null;
  /** API 網址（縮圖相對路徑前面接這個） */
  apiBase: string;
}

/** 留言上的身分（訪客、導演、動畫師、製作） */
export function exportRoleLabel(c: Pick<SongComment, 'role'>): string {
  return c.role === 'guest' ? '訪客' : roleLabel(c.role);
}

/** 狀態：未解決 / 已解決（V3） */
export function exportStatusLabel(c: Pick<SongComment, 'status' | 'resolvedVersion'>): string {
  if (c.status !== 'resolved') return '未解決';
  return typeof c.resolvedVersion === 'number' && c.resolvedVersion > 0 ? `已解決（V${c.resolvedVersion}）` : '已解決';
}

/** 留言的時間：沒綁時間 = 空白；區段 0:12–0:18 */
export function exportTimeLabel(c: Pick<SongComment, 'time' | 'timeEnd'>): string {
  const hasRange = c.timeEnd != null && c.timeEnd > c.time;
  if (!(c.time > 0) && !hasRange) return '';
  return formatRange(c.time, hasRange ? c.timeEnd : null);
}

// ─── CSV ───

/** CSV 一格：有逗號、引號、換行就包起來；開頭是 = + - @ 的加一個 '（Excel 不會當成公式） */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = ['編號', '類型', '時間', '開始時間碼', '結束時間碼', '版本', '作者', '身分', '內容', '狀態', '回覆給', '建立時間', '有記視角', '畫記', '縮圖'];

/** 留言串 → CSV（Excel 打得開：前面有 BOM、換行 CRLF）；每則留言一行，回覆接在下面 */
export function commentsToCsv(threads: readonly CommentThread[], meta: ExportMeta): string {
  const lines: string[] = [CSV_HEADER.map(csvCell).join(',')];
  const thumb = (c: SongComment) => (c.thumbUrl ? (/^https?:/.test(c.thumbUrl) ? c.thumbUrl : meta.apiBase + c.thumbUrl) : '');
  const row = (c: SongComment, num: string, type: string, parentNum: string) => {
    const hasTime = c.time > 0 || (c.timeEnd != null && c.timeEnd > c.time);
    const hasRange = c.timeEnd != null && c.timeEnd > c.time;
    lines.push([
      num, type, exportTimeLabel(c),
      hasTime ? formatTimecode(c.time, meta.fps) : '',
      hasRange ? formatTimecode(c.timeEnd as number, meta.fps) : '',
      typeof c.videoVersion === 'number' && c.videoVersion > 0 ? `V${c.videoVersion}` : '',
      c.author, exportRoleLabel(c), c.text,
      type === '留言' ? exportStatusLabel(c) : '',
      parentNum, formatDateTime(c.createdAt), c.view ? '有' : '',
      c.annotation?.shapes?.length ? `${c.annotation.shapes.length} 筆` : '',
      thumb(c),
    ].map(csvCell).join(','));
  };
  threads.forEach((t, i) => {
    const num = String(i + 1);
    row(t.root, num, '留言', '');
    t.replies.forEach((r, j) => row(r, `${num}-${j + 1}`, '回覆', num));
  });
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** 檔名：金馬2026_S01開場_V3_留言.csv（不能用在檔名的字換掉） */
export function exportFileName(meta: Pick<ExportMeta, 'projectName' | 'songTitle' | 'versionLabel'>, ext: 'csv' | 'pdf'): string {
  const clean = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 40);
  return `${[clean(meta.projectName), clean(meta.songTitle), clean(meta.versionLabel), '留言'].filter(Boolean).join('_')}.${ext}`;
}

// ─── 列印頁 ───

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

/** 沒有縮圖的畫記 → 灰底 SVG（跟畫的時候一樣比例） */
export function annotationSvg(raw: unknown, width = 320): string {
  const ann = parseAnnotation(raw);
  if (!ann) return '';
  const W = width;
  const H = Math.round(width / ann.aspect);
  const paths = ann.shapes.map(s =>
    `<path d="${shapePath(s, W, H)}" fill="none" stroke="${escapeHtml(s.c)}" stroke-width="${strokePx(s.w, H).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`,
  ).join('');
  return `<svg class="thumb__svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#2a2d33"/>${paths}</svg>`;
}

function thumbHtml(c: SongComment, apiBase: string): string {
  if (c.thumbUrl) {
    const src = /^https?:/.test(c.thumbUrl) ? c.thumbUrl : apiBase + c.thumbUrl;
    return `<img class="thumb__img" src="${escapeHtml(src)}" alt="留言當下的畫面" />`;
  }
  const svg = annotationSvg(c.annotation);
  return svg || '<div class="thumb__none">沒有縮圖</div>';
}

function textHtml(s: string): string {
  return escapeHtml(s).replace(/\n/g, '<br />');
}

/** 整頁 HTML（A4 直的，一則一塊，不會被切到下一頁） */
export function buildPrintHtml(threads: readonly CommentThread[], meta: ExportMeta): string {
  const items = threads.map((t, i) => {
    const c = t.root;
    const time = exportTimeLabel(c);
    const tc = c.time > 0 || (c.timeEnd != null && c.timeEnd > c.time)
      ? `${formatTimecode(c.time, meta.fps)}${c.timeEnd != null && c.timeEnd > c.time ? ` – ${formatTimecode(c.timeEnd, meta.fps)}` : ''}`
      : '';
    const ver = typeof c.videoVersion === 'number' && c.videoVersion > 0 ? `V${c.videoVersion}` : '';
    const replies = t.replies.map(r => `
        <li class="reply">
          <div class="reply__head"><strong>${escapeHtml(r.author)}</strong><span class="role">${escapeHtml(exportRoleLabel(r))}</span><span class="muted">${escapeHtml(formatDateTime(r.createdAt))}</span></div>
          <div class="reply__text">${textHtml(r.text)}</div>
        </li>`).join('');
    return `
    <article class="item${c.status === 'resolved' ? ' is-resolved' : ''}">
      <div class="thumb">${thumbHtml(c, meta.apiBase)}</div>
      <div class="body">
        <div class="head">
          <span class="num">#${i + 1}</span>
          ${time ? `<span class="time">${escapeHtml(time)}</span>` : '<span class="time time--none">沒有綁時間</span>'}
          ${tc ? `<span class="tc">${escapeHtml(tc)}</span>` : ''}
          ${ver ? `<span class="chip">${escapeHtml(ver)}</span>` : ''}
          <span class="status status--${c.status === 'resolved' ? 'done' : 'open'}">${escapeHtml(exportStatusLabel(c))}</span>
        </div>
        <div class="who"><strong>${escapeHtml(c.author)}</strong><span class="role">${escapeHtml(exportRoleLabel(c))}</span><span class="muted">${escapeHtml(formatDateTime(c.createdAt))}</span></div>
        <div class="text">${textHtml(c.text)}</div>
        ${replies ? `<ul class="replies">${replies}</ul>` : ''}
      </div>
    </article>`;
  }).join('\n');

  const title = `${meta.projectName} — ${meta.songTitle} · ${meta.versionLabel} 留言`;
  const open = threads.filter(t => t.root.status !== 'resolved').length;
  return `<!doctype html>
<html lang="zh-TW">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang TC', 'Microsoft JhengHei', 'Noto Sans TC', sans-serif; margin: 0; padding: 24px; color: #15171a; background: #fff; font-size: 12px; line-height: 1.55; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { color: #555; font-size: 13px; margin: 0 0 4px; }
  .meta { color: #888; font-size: 11px; margin: 0 0 18px; }
  .item { display: grid; grid-template-columns: 220px 1fr; gap: 14px; padding: 12px 0; border-top: 1px solid #e3e3e3; break-inside: avoid; page-break-inside: avoid; }
  .item.is-resolved .text { color: #666; }
  .thumb { width: 220px; }
  .thumb__img, .thumb__svg { display: block; width: 220px; height: auto; border-radius: 4px; background: #111; }
  .thumb__none { width: 220px; aspect-ratio: 16 / 9; display: flex; align-items: center; justify-content: center; background: #f2f2f2; color: #999; border-radius: 4px; font-size: 11px; }
  .head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-bottom: 2px; }
  .num { font-weight: 700; color: #333; }
  .time { font-weight: 700; font-variant-numeric: tabular-nums; }
  .time--none { font-weight: 400; color: #999; }
  .tc { font-family: ui-monospace, 'SF Mono', Consolas, monospace; color: #666; font-size: 11px; }
  .chip { border: 1px solid #ccc; border-radius: 3px; padding: 0 5px; font-size: 11px; color: #444; }
  .status { margin-left: auto; font-size: 11px; font-weight: 600; }
  .status--open { color: #c0392b; }
  .status--done { color: #1e8449; }
  .who { display: flex; gap: 8px; align-items: baseline; }
  .role { font-size: 11px; color: #666; }
  .muted { color: #999; font-size: 11px; }
  .text { margin-top: 4px; font-size: 13px; white-space: normal; word-break: break-word; }
  .replies { list-style: none; margin: 8px 0 0; padding: 0 0 0 12px; border-left: 2px solid #e3e3e3; }
  .reply { margin: 0 0 6px; }
  .reply__head { display: flex; gap: 8px; align-items: baseline; }
  .reply__text { word-break: break-word; }
  .empty { color: #888; padding: 24px 0; }
  @page { size: A4; margin: 12mm; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <h1>${escapeHtml(meta.songTitle)} · 留言</h1>
  <p class="sub">${escapeHtml(meta.projectName)} · ${escapeHtml(meta.versionLabel)}${meta.filterLabel ? ` · ${escapeHtml(meta.filterLabel)}` : ''}</p>
  <p class="meta">共 ${threads.length} 則（未解決 ${open} 則）· 匯出時間 ${escapeHtml(formatDateTime(meta.generatedAt))} · 時間碼以 ${escapeHtml(String(Math.round(meta.fps && meta.fps > 0 ? meta.fps : 30)))} 格 / 秒計</p>
  ${items || '<p class="empty">沒有符合的留言</p>'}
</body>
</html>`;
}

/** 對話框上「共 N 則」的說明 */
export function exportSummary(threads: readonly CommentThread[]): string {
  const replies = threads.reduce((n, t) => n + t.replies.length, 0);
  return `${threads.length} 則留言${replies ? `、${replies} 則回覆` : ''}`;
}
