// 「匯出留言」（導演頁、動畫師工作站）：一首歌、這一版（或全部版本）的留言 →
//   列印 / 存成 PDF：瀏覽器的列印（選「儲存為 PDF」），每則有時間碼、作者、內容、狀態、留言當下的畫面（含畫記）、回覆
//   下載 CSV：Excel 打得開
// 格式在 lib/review/commentExport.ts。

import { useMemo, useState } from 'react';
import { FileSpreadsheet, Printer, X } from 'lucide-react';
import Icon from './Icon';
import { apiBase, type SongComment } from '../lib/api';
import { buildThreads, filterAndSortThreads, scopeThreads, type ViewedVersion } from '../lib/commentThreads';
import { buildPrintHtml, commentsToCsv, exportFileName, exportSummary, type ExportMeta } from '../lib/review/commentExport';
import { downloadBlob } from '../lib/ledMapDraw';
import { useEscapeClose } from '../lib/useEscapeClose';
import { toast } from '../lib/toast';
import './NewProjectDialog.css';
import './ExportCommentsDialog.css';

interface Props {
  onClose: () => void;
  projectName: string;
  songTitle: string;
  comments: readonly SongComment[];
  /** 正在看的那一版（「這一版」）；沒有版本 = null */
  viewed: (ViewedVersion & { label: string }) | null;
  /** 量到的影片格數（時間碼用） */
  fps?: number | null;
}

/** 隱藏的 iframe 放列印頁 → 圖片載好（最多等 5 秒）再叫瀏覽器列印 */
export function printHtml(html: string): void {
  document.getElementById('sp-print-frame')?.remove();
  const iframe = document.createElement('iframe');
  iframe.id = 'sp-print-frame';
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:-10000px;bottom:0;width:800px;height:600px;border:0;';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) { iframe.remove(); toast.error('這個瀏覽器不讓我們開列印頁'); return; }
  doc.open();
  doc.write(html);
  doc.close();
  const imgs = Array.from(doc.images);
  const ready = Promise.all(imgs.map(img => (img.complete ? Promise.resolve() : new Promise<void>(res => {
    img.addEventListener('load', () => res(), { once: true });
    img.addEventListener('error', () => res(), { once: true });
  }))));
  const timeout = new Promise<void>(res => setTimeout(res, 5000));
  toast.info('正在準備列印頁（等縮圖載好），等一下會跳出列印視窗');
  void Promise.race([ready, timeout]).then(() => {
    try { win.focus(); win.print(); } catch { toast.error('沒辦法打開列印'); }
    // 印完（或一分鐘後）收掉
    const cleanup = () => setTimeout(() => iframe.remove(), 500);
    win.addEventListener('afterprint', cleanup, { once: true });
    setTimeout(() => iframe.remove(), 60_000);
  });
}

export default function ExportCommentsDialog({ onClose, projectName, songTitle, comments, viewed, fps }: Props) {
  useEscapeClose(true, onClose);
  const [scope, setScope] = useState<'version' | 'all'>(viewed ? 'version' : 'all');
  const [status, setStatus] = useState<'all' | 'open' | 'resolved'>('all');

  const threads = useMemo(() => {
    const all = buildThreads(comments);
    const scoped = scopeThreads(all, viewed ? scope : 'all', viewed ? { id: viewed.id, version: viewed.version } : null);
    return filterAndSortThreads(scoped, { status, sort: 'time-asc' });
  }, [comments, scope, status, viewed]);

  const meta: ExportMeta = {
    projectName,
    songTitle,
    versionLabel: scope === 'version' && viewed ? viewed.label : '全部版本',
    filterLabel: status === 'open' ? '未解決' : status === 'resolved' ? '已解決' : undefined,
    generatedAt: new Date().toISOString(),
    fps: fps ?? null,
    apiBase: apiBase(),
  };

  function doPrint() {
    printHtml(buildPrintHtml(threads, meta));
  }
  function doCsv() {
    const csv = commentsToCsv(threads, meta);
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), exportFileName(meta, 'csv'));
    toast.success('CSV 下載好了');
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title" onClick={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2 id="export-title">匯出留言：{songTitle}</h2>
          <button className="dialog__close" onClick={onClose} title="關閉" aria-label="關閉"><Icon icon={X} size="md" /></button>
        </header>
        <div className="dialog__body">
          <div className="export-dialog__row">
            <span className="export-dialog__label">版本</span>
            <div className="comment-scope" role="tablist" aria-label="哪一版的留言">
              <button type="button" role="tab" aria-selected={scope === 'version'} disabled={!viewed}
                className={'comment-scope__btn' + (scope === 'version' && viewed ? ' is-active' : '')} onClick={() => setScope('version')}
              >這一版{viewed ? `（${viewed.label}）` : ''}</button>
              <button type="button" role="tab" aria-selected={scope === 'all' || !viewed}
                className={'comment-scope__btn' + (scope === 'all' || !viewed ? ' is-active' : '')} onClick={() => setScope('all')}
              >全部版本</button>
            </div>
          </div>
          <div className="export-dialog__row">
            <span className="export-dialog__label">狀態</span>
            <div className="comment-scope" role="tablist" aria-label="未解決 / 已解決">
              {([['all', '全部'], ['open', '未解決'], ['resolved', '已解決']] as const).map(([k, l]) => (
                <button key={k} type="button" role="tab" aria-selected={status === k}
                  className={'comment-scope__btn' + (status === k ? ' is-active' : '')} onClick={() => setStatus(k)}
                >{l}</button>
              ))}
            </div>
          </div>
          <p className="export-dialog__summary">
            {threads.length > 0 ? `會匯出 ${exportSummary(threads)}（依影片時間排）` : '沒有符合的留言'}
          </p>
          <p className="export-dialog__hint">
            列印時選「儲存為 PDF」就是 PDF。每則留言旁邊是留言當下的畫面（含畫記）；舊留言沒有縮圖。
          </p>
          <div className="dialog__footer">
            <button type="button" className="btn btn--ghost" onClick={doCsv} disabled={threads.length === 0}>
              <Icon icon={FileSpreadsheet} /> 下載 CSV
            </button>
            <button type="button" className="btn btn--primary" onClick={doPrint} disabled={threads.length === 0}>
              <Icon icon={Printer} /> 列印 / 存成 PDF
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
