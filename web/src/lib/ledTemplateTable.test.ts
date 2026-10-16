import { describe, expect, it } from 'vitest';
import {
  TEMPLATE_TABLE_COLUMNS, scaleText, templateTableFileName, templateTableHeaderLines, templateTableRows, templateTableToCsv, templateTableToJson,
  type TemplateTableMeta,
} from './ledTemplateTable';
import type { LedTemplatePlan, Placement, ScreenDef } from './ledTemplate';
import { ledMapMenuHint, ledMapMenuLabel } from './ledMapMenuText';

// 整張畫布 8800 × 2000：橫條 4400×400（中間）、直條 880×1000（左上角）
const FULL = { width: 8800, height: 2000 };
const DEFS: ScreenDef[] = [
  { key: 'o:a', objectId: 'a', name: '中間底幕', manual: false, uv: null, src: { us: 0.25, ul: 0.5, vs: 0.4, vl: 0.2 }, nativeW: 4400, nativeH: 400 },
  { key: 'o:b', objectId: 'b', name: 'Side "L"', manual: false, uv: null, src: { us: 0, ul: 0.1, vs: 0, vl: 0.5 }, nativeW: 880, nativeH: 1000 },
];
const META: TemplateTableMeta = { projectName: '主舞臺', date: '2026-10-16', fullCanvas: FULL };

const A: Placement = { key: 'o:a', objectId: 'a', uv: null, dest: { x: 0, y: 0, w: 1100, h: 100 }, rotate: 0, flipH: false, flipV: false };
const B: Placement = { key: 'o:b', objectId: 'b', uv: null, dest: { x: 0, y: 120, w: 250, h: 220 }, rotate: 90, flipH: true, flipV: false };

function plan(screens: Placement[] = [A, B], over: Partial<LedTemplatePlan> = {}): LedTemplatePlan {
  return { v: 1, id: 't1', name: '版型 1', canvas: { width: 1920, height: 1080 }, scalePct: 25, screens, ...over };
}

describe('templateTableRows：一塊螢幕一列', () => {
  it('版型位置、轉向、翻轉、實際點數、比例、整張畫布上的位置', () => {
    const rows = templateTableRows(plan(), DEFS, FULL);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      key: 'o:a', name: '中間底幕', x: 0, y: 0, w: 1100, h: 100, rotate: 0, flipH: false, flipV: false,
      nativeW: 4400, nativeH: 400, scaleX: 25, scaleY: 25,
      source: { x: 2200, y: 800, w: 4400, h: 400, wrapsX: false, wrapsY: false }, notes: [],
    });
    // 轉 90° 以後寬高對調：真實 880×1000 → 版型上 250×220，各是 1000 / 880 的 25%
    expect(rows[1]).toMatchObject({
      name: 'Side "L"', x: 0, y: 120, w: 250, h: 220, rotate: 90, flipH: true, flipV: false,
      nativeW: 880, nativeH: 1000, scaleX: 25, scaleY: 25, source: { x: 0, y: 0, w: 880, h: 1000 }, notes: [],
    });
  });

  it('被拉伸 / 超出版型畫布 / 重疊 / 跨畫布邊緣：寫在備註', () => {
    const stretched = templateTableRows(plan([{ ...A, dest: { x: 0, y: 0, w: 550, h: 100 } }]), DEFS, FULL)[0];
    expect(stretched.scaleX).toBe(12.5);
    expect(stretched.scaleY).toBe(25);
    expect(stretched.notes).toEqual(['被拉伸']);
    expect(scaleText(stretched)).toBe('橫 12.5 / 直 25');
    expect(scaleText({ scaleX: 25, scaleY: 25.1 })).toBe('25');

    const outside = templateTableRows(plan([{ ...A, dest: { x: 900, y: 0, w: 1100, h: 100 } }]), DEFS, FULL)[0];
    expect(outside.notes).toEqual(['超出版型畫布']);

    const over = templateTableRows(plan([A, { ...B, dest: { x: 500, y: 50, w: 250, h: 220 } }]), DEFS, FULL);
    expect(over[0].notes).toEqual(['和別塊重疊']);
    expect(over[1].notes).toEqual(['和別塊重疊']);

    const wrapDefs: ScreenDef[] = [{ ...DEFS[0], src: { us: 0.95, ul: 0.1, vs: 0.4, vl: 0.2 }, nativeW: 880, nativeH: 400 }];
    const wrapped = templateTableRows(plan([{ ...A, dest: { x: 0, y: 0, w: 220, h: 100 } }]), wrapDefs, FULL)[0];
    expect(wrapped.source).toMatchObject({ x: 8360, w: 880, wrapsX: true, wrapsY: false });
  });

  it('螢幕清單裡找不到的略過', () => {
    const rows = templateTableRows(plan([A, { ...B, key: 'o:gone', objectId: 'gone' }]), DEFS, FULL);
    expect(rows.map(r => r.key)).toEqual(['o:a']);
  });
});

describe('templateTableToCsv', () => {
  const csv = templateTableToCsv(plan(), DEFS, META);

  it('開頭有 BOM（Excel 看得到中文）、換行 CRLF', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(Array.from(new TextEncoder().encode(csv).slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.split('\r\n').every(l => !l.includes('\n'))).toBe(true);
  });

  it('最上面一行寫版型名稱、畫布大小、比例；第二行說座標怎麼看；再來是欄位名稱', () => {
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('版型「版型 1」 · 版型畫布 1920×1080 像素 · 比例 25% · 專案 主舞臺 · 整張畫布 8800×2000 · 2026-10-16');
    expect(lines[1]).toContain('原點在左上角');
    expect(lines[2]).toBe('名稱,版型 x,版型 y,版型 w,版型 h,轉向,左右翻,上下翻,實際點數 W×H,比例 %,整張畫布 x,整張畫布 y,整張畫布 w,整張畫布 h,備註');
    expect(lines[2].split(',')).toEqual([...TEMPLATE_TABLE_COLUMNS]);
  });

  it('一塊螢幕一列；名字有引號會跳脫；轉向 0 / 90 / 180 / 270；翻轉寫是 / 否', () => {
    const lines = csv.slice(1).split('\r\n');
    expect(lines[3]).toBe('中間底幕,0,0,1100,100,0,否,否,4400×400,25,2200,800,4400,400,');
    expect(lines[4]).toBe('"Side ""L""",0,120,250,220,90,是,否,880×1000,25,0,0,880,1000,');
    expect(lines).toHaveLength(6);   // 3 行表頭 + 2 列 + 結尾的空字串
    for (const rot of [0, 90, 180, 270] as const) {
      const one = templateTableToCsv(plan([{ ...A, rotate: rot, dest: rot % 180 ? { x: 0, y: 0, w: 100, h: 1100 } : A.dest }]), DEFS, META).slice(1).split('\r\n');
      expect(one[3].split(',')[5]).toBe(String(rot));
    }
  });

  it('名稱有逗號、換行的也不會把欄位弄歪', () => {
    const defs: ScreenDef[] = [{ ...DEFS[0], name: '左,右\n上' }];
    const out = templateTableToCsv(plan([A]), defs, META);
    expect(out).toContain('"左,右\n上",0,0,1100,100');
  });

  it('專案沒有名字也能寫', () => {
    expect(templateTableHeaderLines(plan(), { ...META, projectName: '' })[0]).toContain('專案 （未命名）');
  });
});

describe('templateTableToJson', () => {
  it('版型、整張畫布、每塊螢幕的欄位都是數字 / 布林', () => {
    const j = JSON.parse(templateTableToJson(plan(), DEFS, META));
    expect(j.project).toBe('主舞臺');
    expect(j.date).toBe('2026-10-16');
    expect(j.template).toEqual({ id: 't1', name: '版型 1', canvas: { width: 1920, height: 1080 }, scalePct: 25 });
    expect(j.fullCanvas).toEqual(FULL);
    expect(j.origin).toBe('top-left');
    expect(j.rotateUnit).toBe('degrees-clockwise');
    expect(j.screens).toHaveLength(2);
    expect(j.screens[1]).toMatchObject({
      key: 'o:b', name: 'Side "L"', x: 0, y: 120, w: 250, h: 220, rotate: 90, flipH: true, flipV: false,
      native: { w: 880, h: 1000 }, scalePct: { x: 25, y: 25 }, source: { x: 0, y: 0, w: 880, h: 1000, wrapsX: false, wrapsY: false },
    });
  });
});

describe('檔名', () => {
  it('LED座標表-專案-版型-寬x高', () => {
    expect(templateTableFileName('csv', '主舞臺', plan())).toBe('LED座標表-主舞臺-版型 1-1920x1080.csv');
    expect(templateTableFileName('json', '主/舞臺', plan([A, B], { name: 'A:B' }))).toBe('LED座標表-主_舞臺-A_B-1920x1080.json');
    expect(templateTableFileName('csv', undefined, plan())).toBe('LED座標表-專案-版型 1-1920x1080.csv');
  });
});

describe('「⋯」選單的下載名稱', () => {
  it('沒有版型 → 跟以前一模一樣', () => {
    expect(ledMapMenuLabel('png', 'plain')).toBe('下載對位圖（PNG）');
    expect(ledMapMenuLabel('jsx', 'plain')).toBe('下載 AE 合成腳本（.jsx）');
    expect(ledMapMenuLabel('csv', 'plain')).toBe('下載位置表（CSV）');
    expect(ledMapMenuLabel('json', 'plain')).toBe('下載位置表（JSON）');
  });

  it('用了版型 → 寫版型名稱；整張畫布的版本寫「（整張畫布）」', () => {
    expect(ledMapMenuLabel('jsx', { template: '版型 1' })).toBe('下載 AE 合成腳本（版型 1）');
    expect(ledMapMenuLabel('png', { template: '版型 1' })).toBe('下載對位圖（版型 1）');
    expect(ledMapMenuLabel('csv', { template: '版型 1' })).toBe('下載位置表 CSV（版型 1）');
    expect(ledMapMenuLabel('json', { template: '版型 1' })).toBe('下載位置表 JSON（版型 1）');
    expect(ledMapMenuLabel('jsx', 'full')).toBe('下載 AE 合成腳本（整張畫布）');
    expect(ledMapMenuLabel('csv', 'full')).toBe('下載位置表 CSV（整張畫布）');
  });

  it('說明：版型的寫版型名稱，整張畫布的跟以前的說明一樣', () => {
    expect(ledMapMenuHint('jsx', { template: '版型 1' })).toContain('版型「版型 1」');
    expect(ledMapMenuHint('csv', { template: '版型 1' })).toContain('d3');
    expect(ledMapMenuHint('jsx', 'full')).toBe(ledMapMenuHint('jsx', 'plain'));
    expect(ledMapMenuHint('png', 'full')).toBe(ledMapMenuHint('png', 'plain'));
  });
});
