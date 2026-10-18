// 版型時間線的 AE 合成腳本：資料（每一段放什麼）、整支腳本的 ES3 語法、用假的 AE 跑一遍
// （每一組圖層只在自己那一段的時間顯示、換版型的時間有標記、同一個版型出現好幾段只匯入一次模板圖）
import { describe, expect, it } from 'vitest';
import { RUNNER_COMMON } from './aeCompScript';
import {
  RUNNER_TIMELINE, aeTimelineCompName, aeTimelineScriptFileName, buildAeTimelineScript, segmentWhere, timelineSegmentsData,
  type AeTimelineScriptInput,
} from './aeTimelineScript';
import type { LedTemplatePlan, ScreenDef } from './ledTemplate';
import { buildTimeline, type TimelineSwitch } from './ledTemplateTimeline';
import { runInFakeAe } from '../test/fakeAeHost';
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
const bytes = Uint8Array.from({ length: 3001 }, (_, i) => (i * 17 + 3) & 255);
const b64 = (() => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); })();
const guide = (name: string) => ({ fileName: name, width: 960, height: 540, base64: b64 });

describe('名稱和每一段的資料', () => {
  it('合成名稱、檔名', () => {
    expect(aeTimelineCompName('示範專案', '開場', CANVAS)).toBe('示範專案 - 開場 版型時間線 1920x1080');
    expect(aeTimelineCompName('A\nB', undefined, CANVAS)).toBe('A B - 版型時間線 1920x1080');
    expect(aeTimelineScriptFileName('主/舞臺', '開場:1', CANVAS)).toBe('AE合成腳本-主_舞臺-開場_1-版型時間線-1920x1080.jsx');
    expect(aeTimelineScriptFileName('主舞臺', undefined, CANVAS)).toBe('AE合成腳本-主舞臺-版型時間線-1920x1080.jsx');
  });
  it('segmentWhere', () => {
    expect(segmentWhere(null, 0)).toBe('開頭');
    expect(segmentWhere('Cue 4', 83)).toBe('Cue 4 · 1:23.0');
    expect(segmentWhere(null, 130)).toBe('2:10.0');
  });
  it('三段：時間範圍首尾相接，最後一段沒有結束；標記文字講清楚怎麼換的；每段是自己版型的外框', () => {
    const segs = timelineSegmentsData(input());
    expect(segs.map(s => [s.from, s.to, s.mapKey])).toEqual([[0, 83, 'tA'], [83, 130, 'tB'], [130, null, 'tA']]);
    expect(segs.map(s => s.markerText)).toEqual([
      '開頭：版型「版型 A」', '從 Cue 4（1:23.0）起換成「版型 B」', '從 2:10.0 起換成「版型 A」',
    ]);
    expect(segs.map(s => s.panels.length)).toEqual([1, 2, 1]);
    expect(segs[1].panels[0].paths).toEqual([{ v: [[0, 500], [550, 500], [550, 550], [0, 550]], c: true }]);
    expect(segs[1].tag).toBe('[版型 B] ');
  });
});

describe('整支 .jsx', () => {
  it('開頭有 BOM、說明註解（整條時間線寫在註解裡）；程式的部分只有 ASCII', () => {
    const js = buildAeTimelineScript(input());
    expect(js.charCodeAt(0)).toBe(0xfeff);
    expect(js).toContain('// Stage Previz：AE 一鍵建 LED 版型時間線合成');
    expect(js).toContain('3 段');
    expect(js).toContain('2. Cue 4 · 1:23.0 用「版型 B」');
    const code = js.slice(js.indexOf('(function () {'));
    expect(/[^\x09\x0a\x0d\x20-\x7e]/.test(code)).toBe(false);
  });
  it('ES3：沒有 let / const / 箭頭函式 / 樣板字串 / JSON…；整支腳本用語法樹查', () => {
    for (const part of [RUNNER_COMMON, RUNNER_TIMELINE]) {
      expect(part).not.toMatch(/\b(let|const|class)\s/);
      expect(part).not.toMatch(/=>/);
      expect(part).not.toMatch(/`/);
      expect(part).not.toMatch(/\bJSON\b/);
    }
    expect(es3Violations(buildAeTimelineScript(input()))).toEqual([]);
    expect(es3Violations(buildAeTimelineScript(input({ guides: { tA: guide('a.png'), tB: guide('b.png') } })))).toEqual([]);
  });
  it('專案、歌、版型名稱有換行或引號也不會跑出註解、不會弄壞字串', () => {
    const tl = buildTimeline({ ...planA, name: '版"型\\1\u2028A' }, [sw('1', 'tB', { atSec: 5 })], plans)!;
    const js = buildAeTimelineScript(input({ timeline: tl, projectName: 'A\nalert("x")', songName: '歌\r\nX' }));
    for (const line of js.split('\n').slice(0, 8)) expect(line.startsWith('//') || line.startsWith('\uFEFF//') || line.startsWith('(function')).toBe(true);
    expect(es3Violations(js)).toEqual([]);
    expect(runInFakeAe(js, { answers: ['3:00'] }).comps).toHaveLength(1);
  });
});

describe('用假的 AE 跑整支腳本', () => {
  it('建一個時間線畫布大小的合成；每塊螢幕每一段一個外框；全是導引圖層、鎖住；圖層名字前面是版型名稱', () => {
    const r = runInFakeAe(buildAeTimelineScript(input()), { answers: ['4:00'] });
    expect(r.prompts[0].msg).toContain('1920 × 1080、30 fps');
    expect(r.comps).toHaveLength(1);
    expect(r.comps[0]).toMatchObject({ name: '示範專案 - 開場 版型時間線 1920x1080', width: 1920, height: 1080, par: 1, pixelAspect: 1, duration: 240, opened: true });
    expect(String(r.comps[0].comment)).toContain('Cue 4 · 1:23.0');
    const names = r.layers.map(l => l.name);
    expect(names.sort()).toEqual(['[版型 A] 中間底幕', '[版型 A] 中間底幕', '[版型 B] Side "L"', '[版型 B] 中間底幕'].sort());
    for (const l of r.layers) { expect(l.kind).toBe('shape'); expect(l.guideLayer).toBe(true); expect(l.locked).toBe(true); }
  });

  it('每組圖層只在自己那一段顯示：入點 = 這一段開始、出點 = 下一段開始（最後一段不設出點，到合成結束）', () => {
    const r = runInFakeAe(buildAeTimelineScript(input()), { answers: ['4:00'] });
    const span = (n: string) => r.layers.filter(l => l.name === n).map(l => [l.inPoint ?? 0, l.outPoint ?? null]).sort((a, b) => (a[0] as number) - (b[0] as number));
    expect(span('[版型 A] 中間底幕')).toEqual([[0, 83], [130, null]]);
    expect(span('[版型 B] 中間底幕')).toEqual([[83, 130]]);
    expect(span('[版型 B] Side "L"')).toEqual([[83, 130]]);
  });

  it('換版型的時間在合成的時間軸上有標記（開頭也有一個）', () => {
    const r = runInFakeAe(buildAeTimelineScript(input()), { answers: ['4:00'] });
    const marks = (r.comps[0].markerProperty as { markers: { time: number; text: string }[] }).markers;
    expect(marks).toEqual([
      { time: 0, text: '開頭：版型「版型 A」' },
      { time: 83, text: '從 Cue 4（1:23.0）起換成「版型 B」' },
      { time: 130, text: '從 2:10.0 起換成「版型 A」' },
    ]);
    expect(r.alerts[0]).toContain('版型時間線 3 段');
  });

  it('AE 太舊、合成放不上標記 → 標記放在那一段第一個圖層上，不會壞', () => {
    const r = runInFakeAe(buildAeTimelineScript(input()), { answers: ['4:00'], noCompMarkers: true });
    expect(r.comps).toHaveLength(1);
    const withMarks = r.layers.filter(l => l.property('ADBE Marker').markers.length > 0);
    expect(withMarks.length).toBe(3);
    expect(withMarks.map(l => l.property('ADBE Marker').markers[0].time).sort((a, b) => a - b)).toEqual([0, 83, 130]);
  });

  it('合成比換版型的時間短：太晚開始的那一段不放，說一聲；出點超過合成長度就不設', () => {
    const r = runInFakeAe(buildAeTimelineScript(input()), { answers: ['1:40'] });   // 100 秒
    expect(r.layers.filter(l => l.name.startsWith('[版型 A]')).map(l => [l.inPoint ?? 0, l.outPoint ?? null])).toEqual([[0, 83]]);
    expect(r.layers.filter(l => l.name.startsWith('[版型 B]')).map(l => [l.inPoint ?? 0, l.outPoint ?? null])).toEqual([[83, null], [83, null]]);
    expect(r.alerts[0]).toContain('有 1 段比合成的長度還晚才開始');
    const marks = (r.comps[0].markerProperty as { markers: { time: number }[] }).markers;
    expect(marks.map(m => m.time)).toEqual([0, 83]);
  });

  it('夾帶模板圖：每個版型只匯入一次（A → B → A 的 A 共用一張），每一段一個模板圖圖層放在最下面、只在那一段顯示', () => {
    const r = runInFakeAe(buildAeTimelineScript(input({ guides: { tA: guide('A.png'), tB: guide('B.png') } })), { answers: ['4:00'] });
    expect([...r.files.keys()].sort()).toEqual(['C:/Users/me/Downloads/A.png', 'C:/Users/me/Downloads/B.png']);
    const written = r.files.get('C:/Users/me/Downloads/A.png')!;
    expect(Array.from(written, c => c.charCodeAt(0))).toEqual(Array.from(bytes));
    const footage = r.layers.filter(l => l.kind === 'footage');
    expect(footage.map(l => l.name).sort()).toEqual(['版型模板圖（版型 A）', '版型模板圖（版型 A）', '版型模板圖（版型 B）']);
    expect(r.layers.slice(-3).every(l => l.kind === 'footage')).toBe(true);    // 在最下面
    for (const l of footage) { expect(l.guideLayer).toBe(true); expect(l.locked).toBe(true); }
    const b = footage.find(l => l.name === '版型模板圖（版型 B）')!;
    expect([b.inPoint, b.outPoint]).toEqual([83, 130]);
    expect(b.property('ADBE Transform Group').property('ADBE Scale').value).toEqual([200, 200]);
    expect(r.alerts[0]).toContain('每個版型一張');
  });

  it('AE 不允許腳本存檔 → 不放模板圖，說要去哪裡打開；外框照建', () => {
    const r = runInFakeAe(buildAeTimelineScript(input({ guides: { tA: guide('A.png'), tB: guide('B.png') } })), { answers: ['4:00'], canWrite: false });
    expect(r.files.size).toBe(0);
    expect(r.layers.some(l => l.kind === 'footage')).toBe(false);
    expect(r.layers.filter(l => l.kind === 'shape')).toHaveLength(4);
    expect(r.alerts[0]).toContain('允許指令碼寫入檔案和存取網路');
  });

  it('按取消 → 什麼都不建；畫布超過 AE 上限 → 先說，不問也不建', () => {
    expect(runInFakeAe(buildAeTimelineScript(input()), { answers: [null] }).comps).toHaveLength(0);
    const big = { ...CANVAS, width: 32000 };
    const tl = buildTimeline({ ...planA, canvas: big }, [sw('1', 'tB', { atSec: 5 })], new Map([['tB', { ...planB, canvas: big }]]))!;
    const r = runInFakeAe(buildAeTimelineScript(input({ timeline: tl })), { answers: ['3:00'] });
    expect(r.prompts).toHaveLength(0);
    expect(r.comps).toHaveLength(0);
    expect(r.alerts[0]).toContain('超過 AE 合成的上限 30000 px');
  });
});
