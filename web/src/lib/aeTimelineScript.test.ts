// 版型時間線的下載（中途換版型）：zip 的資料（每個版型一個資料夾、座標表）、整支腳本的 ES3 語法、
// 用假的 AE 跑一遍（每個版型的每塊 LED 一個合成、測試圖是一般圖層、總合成每一段 in/out、換版型的時間有標記）
import { describe, expect, it } from 'vitest';
import {
  aeTimelineCompName, buildAeTimelineScript, segmentWhere, timelineSegmentsData, timelineTilePath, timelineTilePlans, timelineTilesToCsv,
  timelineZipFileName, type AeTimelineScriptInput,
} from './aeTimelineScript';
import type { LedTemplatePlan, ScreenDef } from './ledTemplate';
import { buildTimeline, type TimelineSwitch } from './ledTemplateTimeline';
import { es3Violations } from '../test/es3Lint';

const DEFS: ScreenDef[] = [
  { key: 'o:a', objectId: 'a', name: '中間底幕', manual: false, uv: null, src: { us: 0.25, ul: 0.5, vs: 0.4, vl: 0.2 }, nativeW: 4400, nativeH: 400 },
  { key: 'o:b', objectId: 'b', name: 'Side "L"', manual: false, uv: null, src: { us: 0, ul: 0.1, vs: 0, vl: 0.5 }, nativeW: 880, nativeH: 1000 },
];
const CANVAS = { width: 1920, height: 1080 };
const planA: LedTemplatePlan = {
  v: 1, id: 'tA', name: '版型 A', canvas: CANVAS, scalePct: 25,
  screens: [{ key: 'o:a', objectId: 'a', uv: null, dest: { x: 0, y: 0, w: 1100, h: 100 }, rotate: 0, flipH: false, flipV: false }],
};
const planB: LedTemplatePlan = {
  v: 1, id: 'tB', name: '版型 B', canvas: CANVAS, scalePct: 25,
  screens: [
    { key: 'o:a', objectId: 'a', uv: null, dest: { x: 0, y: 500, w: 550, h: 50 }, rotate: 0, flipH: false, flipV: false },
    { key: 'o:b', objectId: 'b', uv: null, dest: { x: 600, y: 0, w: 250, h: 220 }, rotate: 90, flipH: true, flipV: false },
  ],
};
const sw = (id: string, templateId: string, o: Partial<TimelineSwitch>): TimelineSwitch => ({ id, cueId: null, atSec: null, templateId, ...o });
const plans = new Map([['tA', planA], ['tB', planB]]);
// A（0 秒起）→ B（Cue 4，83 秒起）→ A（130 秒起）
const TL = buildTimeline(planA, [sw('1', 'tB', { cueId: 'c4', cueTimeSec: 83, cueName: 'Cue 4' }), sw('2', 'tA', { atSec: 130 })], plans)!;

function input(over: Partial<AeTimelineScriptInput> = {}): AeTimelineScriptInput {
  return { timeline: TL, defs: DEFS, projectName: '示範專案', songName: '開場', date: '2026-10-18', ...over };
}

describe('名稱和資料', () => {
  it('合成名稱、zip 檔名', () => {
    expect(aeTimelineCompName('示範專案', '開場', CANVAS)).toBe('示範專案 - 開場 版型時間線 1920x1080');
    expect(aeTimelineCompName('A\nB', undefined, CANVAS)).toBe('A B - 版型時間線 1920x1080');
    expect(timelineZipFileName('主/舞臺', '開場:1', CANVAS)).toBe('LED每塊圖-主_舞臺-開場_1-版型時間線-1920x1080.zip');
    expect(timelineZipFileName('主舞臺', undefined, CANVAS)).toBe('LED每塊圖-主舞臺-版型時間線-1920x1080.zip');
  });
  it('segmentWhere', () => {
    expect(segmentWhere(null, 0)).toBe('開頭');
    expect(segmentWhere('Cue 4', 83)).toBe('Cue 4 · 1:23.0');
  });
  it('每個版型一個資料夾（A → B → A 只有兩個），每塊 LED 一張圖', () => {
    const ps = timelineTilePlans(TL, DEFS);
    expect(ps.map(p => [p.id, p.dir, p.tiles.length, p.segmentNumbers])).toEqual([['tA', '版型 A', 1, [1, 3]], ['tB', '版型 B', 2, [2]]]);
    expect(timelineTilePath(ps[1], ps[1].tiles[1])).toBe('tiles/版型 B/Side _L_.png');
  });
  it('版型重名 → 資料夾加 -2', () => {
    const tl = buildTimeline(planA, [sw('1', 'tB', { atSec: 5 })], new Map([['tA', planA], ['tB', { ...planB, name: '版型 a' }]]))!;
    expect(timelineTilePlans(tl, DEFS).map(p => p.dir)).toEqual(['版型 A', '版型 a-2']);
  });
  it('每一段：時間首尾相接，最後一段沒有結束，標記文字沿用', () => {
    const ps = timelineTilePlans(TL, DEFS);
    const segs = timelineSegmentsData(TL, ps);
    expect(segs.map(s => [s.plan, s.from, s.to])).toEqual([[0, 0, 83], [1, 83, 130], [0, 130, null]]);
    expect(segs.map(s => s.markerText)).toEqual(['開頭：版型「版型 A」', '從 Cue 4（1:23.0）起換成「版型 B」', '從 2:10.0 起換成「版型 A」']);
  });
  it('座標表 CSV：每個版型一段，有 BOM', () => {
    const csv = timelineTilesToCsv(TL, timelineTilePlans(TL, DEFS));
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toContain('版型「版型 A」');
    expect(lines[0]).toContain('第 1 段 · 開頭、第 3 段 · 2:10.0');
    expect(lines[1]).toBe('名稱,x,y,w,h,旋轉,左右翻,上下翻,檔名');
    expect(lines[2]).toContain('tiles/版型 A/中間底幕.png');
    expect(lines.filter(l => l.startsWith('版型「'))).toHaveLength(2);
    expect(lines.length).toBe(3 + 1 + 4);   // A 段（標題 + 欄名 + 1 塊）、空行、B 段（標題 + 欄名 + 2 塊）
  });
});

interface FLayer { name: string; src: string; locked: boolean; guide: boolean; pos?: number[]; inPoint?: number; outPoint?: number; markers: { time: number; text: string }[] }
interface FComp { name: string; w: number; h: number; dur: number; layers: FLayer[]; markers: { time: number; text: string }[] }

function runScript(js: string, answer: string, opts: { noCompMarkers?: boolean; missing?: string[] } = {}) {
  const comps: FComp[] = [];
  const alerts: string[] = [];
  class FakeFile {
    fsName: string; exists: boolean;
    constructor(public p: string) { this.fsName = p; this.exists = !(opts.missing ?? []).some(m => p.endsWith(m)); }
    get parent() { return new FakeFolder('C:/zip'); }
  }
  class FakeFolder {
    exists = true; fsName: string;
    constructor(public p: string) { this.fsName = p; }
    static selectDialog() { return null; }
  }
  class MarkerValue { constructor(public text: string) {} }
  const app = {
    project: {
      items: {
        addFolder: (name: string) => ({ name }),
        addComp: (name: string, w: number, h: number, _par: number, dur: number) => {
          const c: FComp = { name, w, h, dur, layers: [], markers: [] };
          comps.push(c);
          return {
            id: 'comp:' + name, name, width: w, height: h, comment: '', parentFolder: null, openInViewer() {},
            markerProperty: opts.noCompMarkers
              ? { setValueAtTime() { throw new Error('old AE'); } }
              : { setValueAtTime: (time: number, v: MarkerValue) => c.markers.push({ time, text: v.text }) },
            layers: {
              add: (src: { id: string }) => {
                const L: FLayer = { name: '', src: src.id, locked: false, guide: false, markers: [] };
                c.layers.push(L);
                return {
                  set name(v: string) { L.name = v; }, set locked(v: boolean) { L.locked = v; }, set guideLayer(v: boolean) { L.guide = v; }, set comment(_v: string) {},
                  set inPoint(v: number) { L.inPoint = v; }, set outPoint(v: number) { L.outPoint = v; },
                  property: (n: string) => (n === 'ADBE Marker'
                    ? { setValueAtTime: (time: number, v: MarkerValue) => L.markers.push({ time, text: v.text }) }
                    : { setValue: (v: number[]) => { if (n === 'Position') L.pos = v; } }),
                };
              },
            },
          };
        },
      },
      importFile: (io: { f: FakeFile }) => ({ id: 'footage:' + io.f.p, width: 0, height: 0 }),
    },
    newProject() {}, beginUndoGroup() {}, endUndoGroup() {},
  };
  new Function('app', 'File', 'Folder', 'ImportOptions', 'MarkerValue', 'prompt', 'alert', '$', js)(
    app, FakeFile, FakeFolder, class { f: FakeFile; constructor(f: FakeFile) { this.f = f; } }, MarkerValue, () => answer, (m: string) => alerts.push(m), { fileName: 'C:/zip/AE.jsx' },
  );
  return { comps, alerts };
}

describe('整支 .jsx', () => {
  it('開頭有 BOM、說明註解（整條時間線寫在註解裡）；程式的部分只有 ASCII；ES3', () => {
    const js = buildAeTimelineScript(input());
    expect(js.charCodeAt(0)).toBe(0xfeff);
    expect(js).toContain('2 個版型、3 段');
    expect(js).toContain('2. Cue 4 · 1:23.0 用「版型 B」');
    const code = js.slice(js.indexOf('(function () {'));
    expect(/[^\x09\x0a\x0d\x20-\x7e]/.test(code)).toBe(false);
    expect(es3Violations(js)).toEqual([]);
  });
  it('專案、歌、版型名稱有換行或引號也不會跑出註解、不會弄壞字串', () => {
    const tl = buildTimeline({ ...planA, name: '版"型\\1\u2028A' }, [sw('1', 'tB', { atSec: 5 })], plans)!;
    const js = buildAeTimelineScript(input({ timeline: tl, projectName: 'A\nalert("x")', songName: '歌\r\nX' }));
    for (const line of js.split('\n').slice(0, 6)) expect(line.startsWith('//') || line.startsWith('\uFEFF//') || line.startsWith('(function')).toBe(true);
    expect(es3Violations(js)).toEqual([]);
    expect(runScript(js, '3:00').comps.length).toBe(1 + 1 + 2);
  });
});

describe('用假的 AE 跑整支腳本', () => {
  const js = buildAeTimelineScript(input());

  it('每個版型的每塊 LED 一個合成（名稱前面是 [版型名稱]）+ 一個整張畫布大小的總合成；測試圖是一般圖層、鎖住', () => {
    const r = runScript(js, '4:00');
    expect(r.comps.length).toBe(1 + 1 + 2);   // 總合成 + 版型 A 一塊 + 版型 B 兩塊（A 出現兩段也只建一次）
    const [main, ...tiles] = r.comps;
    expect(main).toMatchObject({ name: '示範專案 - 開場 版型時間線 1920x1080', w: 1920, h: 1080, dur: 240 });
    expect(tiles.map(c => [c.name, c.w, c.h])).toEqual([['[版型 A] 中間底幕', 1100, 100], ['[版型 B] 中間底幕', 550, 50], ['[版型 B] Side "L"', 250, 220]]);
    for (const t of tiles) {
      expect(t.layers.length).toBe(1);
      expect(t.layers[0]).toMatchObject({ name: '測試圖', guide: false, locked: true });
    }
    expect(r.alerts.length).toBe(1);
    expect(r.alerts[0]).toContain('建好了');
  });

  it('總合成每一段：圖層位置 = 那塊的中心，入點 = 這一段開始，出點 = 下一段開始（最後一段不設出點）', () => {
    const main = runScript(js, '4:00').comps[0];
    expect(main.layers.length).toBe(1 + 2 + 1);
    const view = main.layers.map(l => [l.name, l.pos, l.inPoint ?? 0, l.outPoint ?? null]);
    expect(view).toEqual([
      ['[版型 A] 中間底幕', [550, 50], 0, 83],
      ['[版型 B] 中間底幕', [275, 525], 83, 130],
      ['[版型 B] Side "L"', [725, 110], 83, 130],
      ['[版型 A] 中間底幕', [550, 50], 130, null],
    ]);
    for (const l of main.layers) expect(l.guide).toBe(false);
  });

  it('換版型的時間在總合成的時間軸上有標記（開頭也有一個）', () => {
    expect(runScript(js, '4:00').comps[0].markers).toEqual([
      { time: 0, text: '開頭：版型「版型 A」' },
      { time: 83, text: '從 Cue 4（1:23.0）起換成「版型 B」' },
      { time: 130, text: '從 2:10.0 起換成「版型 A」' },
    ]);
  });

  it('AE 太舊、合成放不上標記 → 標記放在那一段第一個圖層上，不會壞', () => {
    const r = runScript(js, '4:00', { noCompMarkers: true });
    const marks = r.comps[0].layers.flatMap(l => l.markers);
    expect(marks.map(m => m.time)).toEqual([0, 83, 130]);
  });

  it('合成比換版型的時間短：太晚開始的那一段不放、說一聲；出點超過合成長度就不設', () => {
    const r = runScript(js, '100');
    const main = r.comps[0];
    expect(main.layers.map(l => [l.inPoint ?? 0, l.outPoint ?? null])).toEqual([[0, 83], [83, null], [83, null]]);
    expect(main.markers.map(m => m.time)).toEqual([0, 83]);
    expect(r.alerts[0]).toContain('有 1 段比合成的長度還晚才開始');
  });

  it('有圖找不到 → 那一塊不建、不放，最後列出來', () => {
    const r = runScript(js, '4:00', { missing: ['Side _L_.png'] });
    expect(r.comps.length).toBe(1 + 1 + 1);
    expect(r.comps[0].layers.length).toBe(1 + 1 + 1);
    expect(r.alerts[0]).toContain('Side _L_.png');
  });
});
