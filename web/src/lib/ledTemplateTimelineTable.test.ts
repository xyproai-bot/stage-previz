// 版型時間線的座標表（CSV / JSON）和下載選單的說明文字
import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_TABLE_COLUMNS, timelineTableFileName, timelineTableHeaderLines, timelineTableSections, timelineTableToCsv, timelineTableToJson,
  type TemplateTableMeta,
} from './ledTemplateTable';
import { buildTimeline } from './ledTemplateTimeline';
import type { LedTemplatePlan, Placement, ScreenDef } from './ledTemplate';
import { ledMapMenuHint, ledMapMenuLabel } from './ledMapMenuText';

const FULL = { width: 8800, height: 2000 };
const DEFS: ScreenDef[] = [
  { key: 'o:a', objectId: 'a', name: '中間底幕', manual: false, uv: null, src: { us: 0.25, ul: 0.5, vs: 0.4, vl: 0.2 }, nativeW: 4400, nativeH: 400 },
  { key: 'o:b', objectId: 'b', name: 'Side "L"', manual: false, uv: null, src: { us: 0, ul: 0.1, vs: 0, vl: 0.5 }, nativeW: 880, nativeH: 1000 },
];
const META: TemplateTableMeta & { songName: string } = { projectName: '主舞臺', date: '2026-10-18', fullCanvas: FULL, songName: '開場' };
const A: Placement = { key: 'o:a', objectId: 'a', uv: null, dest: { x: 0, y: 0, w: 1100, h: 100 }, rotate: 0, flipH: false, flipV: false };
const B: Placement = { key: 'o:b', objectId: 'b', uv: null, dest: { x: 0, y: 120, w: 250, h: 220 }, rotate: 90, flipH: true, flipV: false };
const plan = (screens: Placement[], over: Partial<LedTemplatePlan>): LedTemplatePlan => ({
  v: 1, id: 't1', name: '版型 1', canvas: { width: 1920, height: 1080 }, scalePct: 25, screens, ...over,
});

const planA = plan([A, B], { id: 'tA', name: '版型 A' });
const planB = plan([{ ...A, dest: { x: 0, y: 500, w: 550, h: 50 } }], { id: 'tB', name: '版型 B' });
// A（開頭）→ B（Cue 4，83 秒起）→ A（2:10 起）
const tl = buildTimeline(planA, [
  { id: '1', cueId: 'c4', atSec: null, templateId: 'tB', cueTimeSec: 83, cueName: 'Cue 4' },
  { id: '2', cueId: null, atSec: 130, templateId: 'tA' },
], new Map([['tA', planA], ['tB', planB]]))!;

describe('版型時間線的座標表', () => {
  it('每個版型一個區段（A → B → A 的 A 只寫一次，標題寫第 1、3 段）', () => {
    const secs = timelineTableSections(tl, DEFS, FULL);
    expect(secs.map(x => [x.templateId, x.segmentNumbers, x.rows.length])).toEqual([['tA', [1, 3], 2], ['tB', [2], 1]]);
    expect(secs[0].title).toBe('第 1、3 段 · 開頭、2:10.0 · 版型「版型 A」');
    expect(secs[1].title).toBe('第 2 段 · Cue 4 · 1:23.0 · 版型「版型 B」');
    expect(secs[1].rows[0]).toMatchObject({ name: '中間底幕', x: 0, y: 500, w: 550, h: 50 });
  });

  it('表頭：歌名、畫布大小（每一段一樣大）、怎麼換版型', () => {
    const lines = timelineTableHeaderLines(tl, META);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('歌「開場」');
    expect(lines[0]).toContain('1920×1080');
    expect(lines[0]).toContain('共 3 段');
    expect(lines[1]).toBe('開頭用「版型 A」；從 Cue 4（1:23.0）起換成「版型 B」；從 2:10.0 起換成「版型 A」');
  });

  it('CSV：BOM、CRLF、每個區段有標題列 + 欄位列 + 資料列，區段之間空一行', () => {
    const csv = timelineTableToCsv(tl, DEFS, META);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.endsWith('\r\n')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    const cols = TEMPLATE_TABLE_COLUMNS.join(',');
    expect(lines.filter(l => l === cols)).toHaveLength(2);
    const i1 = lines.indexOf('第 1、3 段 · 開頭、2:10.0 · 版型「版型 A」');
    const i2 = lines.indexOf('第 2 段 · Cue 4 · 1:23.0 · 版型「版型 B」');
    expect(i1).toBeGreaterThan(0);
    expect(i2).toBeGreaterThan(i1);
    expect(lines[i1 - 1]).toBe('');
    expect(lines[i2 - 1]).toBe('');
    expect(lines[i1 + 2].startsWith('中間底幕,0,0,1100,100')).toBe(true);
    expect(lines[i2 + 2].startsWith('中間底幕,0,500,550,50')).toBe(true);
  });

  it('JSON：每一段從幾秒到幾秒、每個版型的螢幕座標', () => {
    const j = JSON.parse(timelineTableToJson(tl, DEFS, META));
    expect(j.song).toBe('開場');
    expect(j.canvas).toEqual({ width: 1920, height: 1080 });
    expect(j.segments.map((s: { fromSec: number; toSec: number | null; templateName: string }) => [s.fromSec, s.toSec, s.templateName])).toEqual([
      [0, 83, '版型 A'], [83, 130, '版型 B'], [130, null, '版型 A'],
    ]);
    expect(j.segments[1].label).toBe('Cue 4');
    expect(j.templates.map((t: { name: string; segments: number[]; screens: unknown[] }) => [t.name, t.segments, t.screens.length])).toEqual([['版型 A', [1, 3], 2], ['版型 B', [2], 1]]);
    expect(j.templates[1].screens[0]).toMatchObject({ name: '中間底幕', x: 0, y: 500, w: 550, h: 50 });
  });

  it('檔名', () => {
    expect(timelineTableFileName('csv', '主/舞臺', '開場:1', { width: 4400, height: 200 })).toBe('LED座標表-主_舞臺-開場_1-版型時間線-4400x200.csv');
    expect(timelineTableFileName('json', '主舞臺', undefined, { width: 4400, height: 200 })).toBe('LED座標表-主舞臺-版型時間線-4400x200.json');
  });
});

describe('下載選單的文字：版型時間線', () => {
  it('模板圖一次好幾個檔、腳本是一個合成每段一組圖層、座標表每個版型一個區段；單一版型的說明沒變', () => {
    const scope = { template: '版型時間線', timeline: true };
    expect(ledMapMenuLabel('jsx', scope)).toBe('下載 AE 合成腳本（版型時間線）');
    expect(ledMapMenuLabel('csv', scope)).toBe('下載位置表 CSV（版型時間線）');
    expect(ledMapMenuHint('png', scope)).toContain('每個版型各一張');
    expect(ledMapMenuHint('jsx', scope)).toContain('只在那一段的時間顯示');
    expect(ledMapMenuHint('csv', scope)).toContain('每個版型一個區段');
    expect(ledMapMenuHint('jsx', { template: '版型 1' })).toContain('版型「版型 1」大小的合成');
  });
});
