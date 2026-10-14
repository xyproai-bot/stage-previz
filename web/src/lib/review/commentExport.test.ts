import { describe, expect, it } from 'vitest';
import type { SongComment } from '../api';
import { buildThreads } from '../commentThreads';
import {
  CSV_HEADER, annotationSvg, buildPrintHtml, commentsToCsv, csvCell, escapeHtml, exportFileName, exportRoleLabel,
  exportStatusLabel, exportSummary, exportTimeLabel, type ExportMeta,
} from './commentExport';

const base: SongComment = {
  id: 'c1', time: 12, x: 0.5, y: 0.5, text: '主牆再亮一點', author: '王導', email: null, role: 'director',
  createdAt: '2026-10-14T03:00:00.000Z', status: 'open', videoVersion: 2,
};
const list: SongComment[] = [
  { ...base, timeEnd: 18, thumbUrl: '/api/comment-thumbs/p1/c1-aaaa.jpg', view: { position: [1, 2, 3], target: [0, 0, 0], fov: 50 },
    annotation: { v: 1, aspect: 1.6, shapes: [{ t: 'arrow', c: '#ff3b30', w: 0.006, p: [0.1, 0.1, 0.5, 0.5] }] } },
  { ...base, id: 'c2', parentId: 'c1', author: '阿凱', role: 'animator', text: '收到，V3 會改', createdAt: '2026-10-14T03:05:00.000Z' },
  { ...base, id: 'c3', time: 40, author: '訪客：小李（給經紀人）', role: 'guest', text: '=SUM(A1) "引號", 逗號\n換行', status: 'resolved', resolvedVersion: 3, createdAt: '2026-10-14T04:00:00.000Z' },
  { ...base, id: 'c4', time: 0, text: '<script>alert(1)</script> 整體不錯', createdAt: '2026-10-14T05:00:00.000Z' },
];
const meta: ExportMeta = {
  projectName: '金馬 2026', songTitle: 'S01 開場', versionLabel: 'V2', generatedAt: '2026-10-14T06:00:00.000Z',
  fps: 25, apiBase: 'https://proxy.test',
};

describe('匯出：每則的字', () => {
  it('身分、狀態、時間', () => {
    expect(exportRoleLabel({ role: 'guest' })).toBe('訪客');
    expect(exportRoleLabel({ role: 'designer' })).toBe('製作');
    expect(exportStatusLabel({ status: 'open' })).toBe('未解決');
    expect(exportStatusLabel({ status: 'resolved', resolvedVersion: 3 })).toBe('已解決（V3）');
    expect(exportStatusLabel({ status: 'resolved' })).toBe('已解決');
    expect(exportTimeLabel({ time: 12, timeEnd: 18 })).toBe('0:12–0:18');
    expect(exportTimeLabel({ time: 40 })).toBe('0:40');
    expect(exportTimeLabel({ time: 0 })).toBe('');
  });
  it('檔名不放不能用的字', () => {
    expect(exportFileName({ projectName: '金馬 2026', songTitle: 'S01/開場', versionLabel: 'V2' }, 'csv')).toBe('金馬2026_S01開場_V2_留言.csv');
  });
  it('共幾則', () => {
    expect(exportSummary(buildThreads(list))).toBe('3 則留言、1 則回覆');
  });
});

describe('匯出：CSV', () => {
  it('一格：逗號 / 引號 / 換行包起來；= 開頭的不會被 Excel 當公式', () => {
    expect(csvCell('普通')).toBe('普通');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('他說"好"')).toBe('"他說""好"""');
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell(null)).toBe('');
  });
  it('有 BOM（Excel 才認得中文）、表頭、每則一行、回覆接在下面', () => {
    const csv = commentsToCsv(buildThreads(list), meta);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n').filter(Boolean);
    expect(lines[0]).toBe(CSV_HEADER.join(','));
    expect(lines[1].startsWith('1,留言,0:12–0:18,00:00:12:00,00:00:18:00,V2,王導,導演,主牆再亮一點,未解決,,')).toBe(true);
    expect(lines[1]).toContain(',有,1 筆,https://proxy.test/api/comment-thumbs/p1/c1-aaaa.jpg');
    expect(lines[2].startsWith('1-1,回覆,0:12,00:00:12:00,,V2,阿凱,動畫師,"收到，V3 會改",,1,')).toBe(false);  // 全形逗號不用包
    expect(lines[2].startsWith('1-1,回覆,0:12,00:00:12:00,,V2,阿凱,動畫師,收到，V3 會改,,1,')).toBe(true);
    // 換行在格子裡面（包起來），所以第三則會跨兩行
    expect(csv).toContain(`"'=SUM(A1) ""引號"", 逗號\n換行"`);
    expect(csv).toContain('訪客：小李（給經紀人）,訪客');
    expect(csv).toContain('已解決（V3）');
  });
});

describe('匯出：列印頁', () => {
  const html = buildPrintHtml(buildThreads(list), meta);
  it('標題、時間碼、作者、狀態、回覆都在', () => {
    expect(html).toContain('<title>金馬 2026 — S01 開場 · V2 留言</title>');
    expect(html).toContain('0:12–0:18');
    expect(html).toContain('00:00:12:00 – 00:00:18:00');
    expect(html).toContain('王導');
    expect(html).toContain('未解決');
    expect(html).toContain('收到，V3 會改');
    expect(html).toContain('共 3 則（未解決 2 則）');
    expect(html).toContain('以 25 格 / 秒計');
  });
  it('縮圖接上 API 網址；沒有縮圖的寫「沒有縮圖」', () => {
    expect(html).toContain('src="https://proxy.test/api/comment-thumbs/p1/c1-aaaa.jpg"');
    expect(html).toContain('沒有縮圖');
  });
  it('留言裡的 HTML 不會變成程式（訪客也留得了言）', () => {
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('"<&>\'')).toBe('&quot;&lt;&amp;&gt;&#39;');
  });
  it('沒有縮圖但有畫記 → 灰底把畫記畫出來', () => {
    const svg = annotationSvg({ v: 1, aspect: 2, shapes: [{ t: 'rect', c: '#ffcc00', w: 0.006, p: [0.1, 0.1, 0.5, 0.5] }] }, 200);
    expect(svg).toContain('viewBox="0 0 200 100"');
    expect(svg).toContain('stroke="#ffcc00"');
    expect(annotationSvg(null)).toBe('');
    const noThumb = buildPrintHtml(buildThreads([{ ...base, annotation: { v: 1, aspect: 2, shapes: [{ t: 'rect', c: '#ffcc00', w: 0.006, p: [0.1, 0.1, 0.5, 0.5] }] } }]), meta);
    expect(noThumb).toContain('<svg class="thumb__svg"');
  });
  it('沒有符合的留言', () => {
    expect(buildPrintHtml([], meta)).toContain('沒有符合的留言');
  });
});
