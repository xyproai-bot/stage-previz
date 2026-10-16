import { describe, expect, it } from 'vitest';
import { RUNNER_COMMON, RUNNER_COMP, RUNNER_TEMPLATE, buildAeCompScript } from './aeCompScript';
import {
  AE_DEFAULT_FPS, aeTemplateCompName, aeTemplateGuideFileName, aeTemplateScriptFileName, buildAeTemplateScript, normalizeAeFps,
  panelComment, templatePanels, type AeTemplateScriptInput,
} from './aeTemplateScript';
import { buildLedLayout } from './ledMap';
import type { LedTemplatePlan, ScreenDef } from './ledTemplate';
import { layoutPattern } from './ledTemplatePattern';
import { runInFakeAe } from '../test/fakeAeHost';
import { es3Violations } from '../test/es3Lint';

// 整張畫布 8800 × 2000：兩塊螢幕（橫條 4400×400、直條 880×1000）
const DEFS: ScreenDef[] = [
  { key: 'o:a', objectId: 'a', name: '中間底幕', manual: false, uv: null, src: { us: 0.25, ul: 0.5, vs: 0.4, vl: 0.2 }, nativeW: 4400, nativeH: 400 },
  { key: 'o:b', objectId: 'b', name: 'Side "L"', manual: false, uv: null, src: { us: 0, ul: 0.1, vs: 0, vl: 0.5 }, nativeW: 880, nativeH: 1000 },
];

function plan(over: Partial<LedTemplatePlan> = {}): LedTemplatePlan {
  return {
    v: 1, id: 't1', name: '版型 1', canvas: { width: 1920, height: 1080 }, scalePct: 25,
    screens: [
      { key: 'o:a', objectId: 'a', uv: null, dest: { x: 0, y: 0, w: 1100, h: 100 }, rotate: 0, flipH: false, flipV: false },
      { key: 'o:b', objectId: 'b', uv: null, dest: { x: 0, y: 120, w: 250, h: 220 }, rotate: 90, flipH: true, flipV: false },
    ],
    ...over,
  };
}

function input(over: Partial<AeTemplateScriptInput> = {}): AeTemplateScriptInput {
  return { plan: plan(), defs: DEFS, projectName: '示範專案', date: '2026-10-16', ...over };
}

describe('合成名稱、檔名、影格速率', () => {
  it('合成名稱：專案 - 版型名 寬x高；換行拿掉、沒名字有預設', () => {
    expect(aeTemplateCompName('示範專案', '版型 1', { width: 1920, height: 1080 })).toBe('示範專案 - 版型 1 1920x1080');
    expect(aeTemplateCompName('A\nB', '中\r間', { width: 4400, height: 200 })).toBe('A B - 中 間 4400x200');
    expect(aeTemplateCompName('', '', { width: 16, height: 16 })).toBe('未命名專案 - 版型 16x16');
  });

  it('檔名：不能有 \\ / : * ? " < > | 這些字；模板圖的檔名跟「下載模板圖」的不一樣', () => {
    const c = { width: 1920, height: 1080 };
    expect(aeTemplateScriptFileName('主/舞臺', '版型:1', c)).toBe('AE合成腳本-主_舞臺-版型_1-1920x1080.jsx');
    expect(aeTemplateGuideFileName('主舞臺', '版型 1', c)).toBe('LED版型參考-主舞臺-版型 1-1920x1080.png');
    expect(aeTemplateGuideFileName('主舞臺', '版型 1', c)).not.toMatch(/^LED版型圖-/);
  });

  it('影格速率：合理的照用，不知道 / 不合理 = 30', () => {
    expect(AE_DEFAULT_FPS).toBe(30);
    expect(normalizeAeFps(undefined)).toBe(30);
    expect(normalizeAeFps(null)).toBe(30);
    expect(normalizeAeFps(NaN)).toBe(30);
    expect(normalizeAeFps(0)).toBe(30);
    expect(normalizeAeFps(120)).toBe(30);
    expect(normalizeAeFps(25)).toBe(25);
    expect(normalizeAeFps(29.97)).toBe(29.97);
    expect(normalizeAeFps(23.976024)).toBe(23.976);
  });
});

describe('templatePanels：每塊螢幕一個外框', () => {
  it('外框 = 版型裡的長方形；顏色、順序、註解都跟模板圖一樣', () => {
    const items = layoutPattern(plan(), DEFS);
    const panels = templatePanels(items);
    expect(panels.map(p => p.name)).toEqual(['中間底幕', 'Side "L"']);
    expect(panels[0].paths).toEqual([{ v: [[0, 0], [1100, 0], [1100, 100], [0, 100]], c: true }]);
    expect(panels[1].paths).toEqual([{ v: [[0, 120], [250, 120], [250, 340], [0, 340]], c: true }]);
    expect(panels[0].label).toBe(1);
    expect(panels[1].label).toBe(2);
    expect(panels[0].color).not.toEqual(panels[1].color);
    expect(panels[0].comment).toBe('位置 0, 0 · 1100×100 像素 · 上方朝上 · 轉 0° · 實際 4400×400');
    expect(panels[1].comment).toBe('位置 0, 120 · 250×220 像素 · 上方朝左 · 轉 90° · 左右翻 · 實際 880×1000');
    expect(panelComment(items[1])).toContain('左右翻');
  });

  it('版型裡有、螢幕清單找不到的螢幕略過', () => {
    const items = layoutPattern(plan(), DEFS.slice(0, 1));
    expect(templatePanels(items).map(p => p.name)).toEqual(['中間底幕']);
  });
});

describe('buildAeTemplateScript：整支 .jsx', () => {
  it('開頭有 BOM、說明註解；程式的部分只有 ASCII（中文都跳脫了）', () => {
    const js = buildAeTemplateScript(input());
    expect(js.charCodeAt(0)).toBe(0xfeff);
    expect(js).toContain('// Stage Previz：AE 一鍵建 LED 版型合成');
    expect(js).toContain('//@target aftereffects');
    expect(js).toContain('版型：版型 1');
    expect(js).toContain('1920 × 1080（比例 25%）');
    const code = js.slice(js.indexOf('(function () {'));
    expect(/[^\x09\x0a\x0d\x20-\x7e]/.test(code)).toBe(false);
    // 中文名字寫成 \uXXXX（版型 1 → \u7248\u578B 1）
    expect(code).toContain('\\u7248\\u578B 1');
  });

  it('ES3：沒有 let / const / 箭頭函式 / 樣板字串 / forEach / indexOf / JSON…（整支腳本用語法樹查）', () => {
    for (const part of [RUNNER_COMMON, RUNNER_COMP, RUNNER_TEMPLATE]) {
      expect(part).not.toMatch(/\b(let|const|class)\s/);
      expect(part).not.toMatch(/=>/);
      expect(part).not.toMatch(/`/);
      expect(part).not.toMatch(/\bJSON\b/);
    }
    expect(es3Violations(buildAeTemplateScript(input()))).toEqual([]);
    expect(es3Violations(buildAeTemplateScript(input({ guide: { fileName: 'g.png', width: 10, height: 10, base64: 'AAAA' } })))).toEqual([]);
    // 整張畫布的腳本共用同一份程式，一起查
    const layout = buildLedLayout([{ id: 'a', name: 'A', tris: [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1] }], { width: 100, height: 100 });
    expect(es3Violations(buildAeCompScript({ layout, projectName: 'p', date: '2026-10-16', canvasSource: 'project' }))).toEqual([]);
  });

  it('檢查工具本身抓得到 ES6 的寫法', () => {
    expect(es3Violations('var f = (a) => a;').length).toBeGreaterThan(0);
    expect(es3Violations('const a = 1;').length).toBeGreaterThan(0);
    expect(es3Violations('var s = `x`;').length).toBeGreaterThan(0);
    expect(es3Violations('try { x(); } catch { y(); }').length).toBeGreaterThan(0);
    expect(es3Violations('var a = [1, 2,];').length).toBeGreaterThan(0);
    expect(es3Violations('var a = [1].indexOf(1);').length).toBeGreaterThan(0);
    expect(es3Violations('var o = JSON.parse("1");').length).toBeGreaterThan(0);
    expect(es3Violations('var x = ;').length).toBeGreaterThan(0);
    expect(es3Violations('var a = [1, 2]; for (var i = 0; i < a.length; i++) { try { a[i](); } catch (e) {} }')).toEqual([]);
  });

  it('專案、版型名稱有換行或引號也不會跑出註解、不會弄壞字串', () => {
    const js = buildAeTemplateScript(input({ projectName: 'A\nalert("x")', plan: plan({ name: '版"型\\1\u2028B' }) }));
    for (const line of js.split('\n').slice(0, 7)) expect(line.startsWith('//') || line.startsWith('\uFEFF//') || line.startsWith('(function')).toBe(true);
    expect(es3Violations(js)).toEqual([]);
    const r = runInFakeAe(js, { answers: ['3:00'] });
    expect(r.comps[0].name).toBe('A alert("x") - 版"型\\1 B 1920x1080');
  });
});

describe('用假的 AE 跑整支腳本', () => {
  it('問長度 → 建版型畫布大小的合成（名字、正方形像素、fps、長度）、每塊螢幕一個外框，全是導引圖層、鎖住', () => {
    const r = runInFakeAe(buildAeTemplateScript(input()), { answers: ['2:30'] });
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0].def).toBe('3:00');
    expect(r.prompts[0].msg).toContain('1920 × 1080、30 fps');
    expect(r.comps).toHaveLength(1);
    expect(r.comps[0]).toMatchObject({
      name: '示範專案 - 版型 1 1920x1080', width: 1920, height: 1080, par: 1, pixelAspect: 1, duration: 150, fps: 30, opened: true,
    });
    expect(String(r.comps[0].comment)).toContain('版型：版型 1');
    const shapes = r.layers.filter(l => l.kind === 'shape');
    expect(r.layers.every(l => l.kind === 'shape')).toBe(true);   // 沒夾圖時只有外框，沒有文字圖層
    expect(shapes.map(l => l.name)).toEqual(['中間底幕', 'Side "L"']);   // 第一塊螢幕在最上面
    for (const l of r.layers) { expect(l.guideLayer).toBe(true); expect(l.locked).toBe(true); }
    expect(shapes[0].comment).toContain('位置 0, 0 · 1100×100 像素');
    const side = shapes.find(l => l.name === 'Side "L"')!;
    const group = side.root.property('ADBE Root Vectors Group').added[0].prop;
    const vectors = group.property('ADBE Vectors Group');
    expect(vectors.added.map(a => a.type)).toEqual(['ADBE Vector Shape - Group', 'ADBE Vector Graphic - Stroke', 'ADBE Vector Graphic - Fill']);
    const shapeVal = vectors.added[0].prop.property('ADBE Vector Shape').value as { vertices: number[][]; closed: boolean };
    expect(shapeVal.vertices).toEqual([[0, 120], [250, 120], [250, 340], [0, 340]]);
    expect(shapeVal.closed).toBe(true);
    // 說明
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toContain('建好了');
    expect(r.alerts[0]).toContain('長度 2:30');
    expect(r.alerts[0]).toContain('版型「版型 1」的螢幕外框 2 塊');
    expect(r.alerts[0]).toContain('這次沒有放');
  });

  it('專案給了影格速率就用它；沒給 / 不合理 = 30', () => {
    expect(runInFakeAe(buildAeTemplateScript(input({ fps: 25 })), { answers: ['1:00'] }).comps[0].fps).toBe(25);
    expect(runInFakeAe(buildAeTemplateScript(input({ fps: 29.97 })), { answers: ['1:00'] }).comps[0].fps).toBe(29.97);
    expect(runInFakeAe(buildAeTemplateScript(input({ fps: 500 })), { answers: ['1:00'] }).comps[0].fps).toBe(30);
    expect(runInFakeAe(buildAeTemplateScript(input()), { answers: ['1:00'] }).prompts[0].msg).toContain('30 fps');
  });

  it('夾帶的模板圖：解開寫成檔案（跟原本的 bytes 一樣）、放在最下面、一般模式、100%、導引圖層、鎖住', () => {
    const bytes = Uint8Array.from({ length: 20001 }, (_, i) => (i * 31 + (i >> 2)) & 255);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    const guide = { fileName: 'LED版型參考-示範專案-版型 1-1920x1080.png', width: 960, height: 540, base64: btoa(binary) };
    const r = runInFakeAe(buildAeTemplateScript(input({ guide })), { answers: ['3:00'] });
    const path = 'C:/Users/me/Downloads/' + guide.fileName;
    expect(r.files.has(path)).toBe(true);
    const written = r.files.get(path)!;
    expect(Array.from(written, c => c.charCodeAt(0))).toEqual(Array.from(bytes));
    const bottom = r.layers[r.layers.length - 1];
    expect(bottom.kind).toBe('footage');
    expect(bottom.name).toBe('版型模板圖（參考）');
    expect(bottom.guideLayer).toBe(true);
    expect(bottom.locked).toBe(true);
    expect(bottom.blendingMode).toBeUndefined();   // 不是濾色
    const tr = bottom.property('ADBE Transform Group');
    expect(tr.property('ADBE Scale').value).toEqual([200, 200]);   // 960×540 的圖放大成 1920×1080
    expect(tr.property('ADBE Position').value).toEqual([960, 540]);
    expect(tr.property('ADBE Opacity').value).toBe(100);
    expect(r.layers.slice(0, -1).every(l => l.kind === 'shape')).toBe(true);
    expect(r.alerts[0]).toContain('版型模板圖：放好了');
  });

  it('AE 不允許腳本存檔 → 不放模板圖，說要去哪裡打開；外框照建', () => {
    const r = runInFakeAe(buildAeTemplateScript(input({ guide: { fileName: 'g.png', width: 10, height: 10, base64: 'AAAA' } })), { answers: ['3:00'], canWrite: false });
    expect(r.files.size).toBe(0);
    expect(r.layers.some(l => l.kind === 'footage')).toBe(false);
    expect(r.layers.filter(l => l.kind === 'shape')).toHaveLength(2);
    expect(r.alerts[0]).toContain('允許指令碼寫入檔案和存取網路');
  });

  it('按取消 → 什麼都不建；長度寫錯 → 再問一次', () => {
    expect(runInFakeAe(buildAeTemplateScript(input()), { answers: [null] }).comps).toHaveLength(0);
    const r = runInFakeAe(buildAeTemplateScript(input()), { answers: ['三分鐘', '90'] });
    expect(r.prompts).toHaveLength(2);
    expect(r.prompts[1].msg).toContain('看不懂這個長度');
    expect(r.comps[0].duration).toBe(90);
  });

  it('版型畫布超過 AE 上限 → 先說，不問也不建', () => {
    const r = runInFakeAe(buildAeTemplateScript(input({ plan: plan({ canvas: { width: 32000, height: 1000 } }) })), { answers: ['3:00'] });
    expect(r.prompts).toHaveLength(0);
    expect(r.comps).toHaveLength(0);
    expect(r.alerts[0]).toContain('超過 AE 合成的上限 30000 px');
  });

  it('版型裡沒有螢幕也能建（只有空合成）', () => {
    const r = runInFakeAe(buildAeTemplateScript(input({ plan: plan({ screens: [] }) })), { answers: ['3:00'] });
    expect(r.comps).toHaveLength(1);
    expect(r.layers).toHaveLength(0);
    expect(r.alerts[0]).toContain('螢幕外框 0 塊');
  });
});
