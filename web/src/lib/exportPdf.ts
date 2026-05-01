// 用瀏覽器原生 print 功能匯出 PDF
//
// 為什麼不引 jsPDF？多一個 ~200KB 套件、字型 / 中文要 embed 麻煩。
// 用 window.print() + 一個 hidden iframe 寫 print-friendly HTML
// → 用戶在 print dialog 選「儲存為 PDF」即可。Chrome / Safari / Edge / Firefox 都支援。

import type { Cue } from './api';

interface ExportOptions {
  projectName: string;
  songName: string;
  cues: Cue[];
  /** cue.id → base64 縮圖 dataURL（從 localStorage 抓 sp-cue-thumb:<cueId>） */
  thumbs: Map<string, string>;
}

export function exportSongStoryboardAsPdf({ projectName, songName, cues, thumbs }: ExportOptions): void {
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '-10000px';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  document.body.appendChild(iframe);

  const cueRows = cues.map((c, i) => {
    const thumb = thumbs.get(c.id);
    return `
      <div class="cue">
        <div class="cue__num">#${i + 1}</div>
        ${thumb
          ? `<img class="cue__thumb" src="${thumb}" alt="${escapeHtml(c.name)}" />`
          : `<div class="cue__placeholder">🎬 沒縮圖</div>`}
        <div class="cue__name">${escapeHtml(c.name)}</div>
        ${c.crossfadeSeconds > 0 ? `<div class="cue__cross">⤴ Crossfade ${c.crossfadeSeconds}s</div>` : ''}
      </div>
    `;
  }).join('\n');

  const html = `<!doctype html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(projectName)} — ${escapeHtml(songName)} · Storyboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft JhengHei', sans-serif; margin: 0; padding: 24px; color: #111; background: #fff; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    h2 { font-size: 14px; margin: 0 0 16px; color: #555; font-weight: normal; }
    .meta { color: #888; font-size: 11px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .cue { border: 1px solid #ddd; border-radius: 6px; padding: 8px; page-break-inside: avoid; }
    .cue__num { font-family: ui-monospace, monospace; font-size: 11px; color: #888; margin-bottom: 4px; }
    .cue__thumb { width: 100%; aspect-ratio: 16/9; object-fit: cover; border-radius: 4px; background: #000; }
    .cue__placeholder { width: 100%; aspect-ratio: 16/9; background: #f4f4f4; display: flex; align-items: center; justify-content: center; color: #aaa; font-size: 12px; border-radius: 4px; }
    .cue__name { font-size: 13px; font-weight: 600; margin-top: 6px; }
    .cue__cross { font-size: 11px; color: #c97a00; margin-top: 2px; font-family: ui-monospace, monospace; }
    @page { size: A4; margin: 12mm; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <h1>${escapeHtml(projectName)}</h1>
  <h2>${escapeHtml(songName)} · Storyboard（${cues.length} cue）</h2>
  <div class="meta">列印時間：${new Date().toLocaleString('zh-TW')}</div>
  <div class="grid">
    ${cueRows}
  </div>
</body>
</html>`;

  const doc = iframe.contentDocument!;
  doc.open();
  doc.write(html);
  doc.close();

  // 等所有 img 載完才 print（避免空白頁）
  const imgs = Array.from(doc.querySelectorAll('img'));
  Promise.all(imgs.map(img => new Promise<void>(resolve => {
    if (img.complete) return resolve();
    img.onload = () => resolve();
    img.onerror = () => resolve();
  }))).then(() => {
    setTimeout(() => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      // 50% 用戶點消會殘留 iframe；3 秒後清理
      setTimeout(() => { try { document.body.removeChild(iframe); } catch {} }, 3000);
    }, 100);
  });
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c] as string));
}

/** 從 localStorage 撈 cue 縮圖（CueStoryboard 存的） */
export function loadCueThumbs(cueIds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const id of cueIds) {
    try {
      const v = localStorage.getItem('sp-cue-thumb:' + id);
      if (v) map.set(id, v);
    } catch { /* ignore */ }
  }
  return map;
}
