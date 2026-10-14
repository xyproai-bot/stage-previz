import { describe, expect, it } from 'vitest';
import {
  RUNNER, aeCompName, buildAeCompScript, chunkBase64, edgeLoops, es3Literal, es3String, hslToRgb01, panelLabels, panelPaths,
  simplifyPath, type AeScriptInput,
} from './aeCompScript';
import { buildLedLayout, ledMapFileName, type LedLayout } from './ledMap';

/** 一個長方形（兩個三角形）的 UV */
function quad(u0: number, v0: number, u1: number, v1: number): number[] {
  return [u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1];
}

const CANVAS = { width: 3840, height: 2160 };

function demoLayout(): LedLayout {
  return buildLedLayout([
    { id: 'a', name: '主螢幕', tris: quad(0, 0, 0.5, 0.5) },          // 0,0 1920×1080
    { id: 'b', name: 'Side "L"', tris: quad(0.5, 0, 0.75, 0.5) },     // 1920,0 960×1080
    { id: 'c', name: '鏡像', tris: quad(0, 0, 0.5, 0.5) },             // 跟主螢幕同一個位置
  ], CANVAS);
}

describe('es3String / es3Literal：寫成 ExtendScript 看得懂的樣子', () => {
  it('ASCII 照寫，引號、反斜線、換行跳脫', () => {
    expect(es3String('abc 123')).toBe('"abc 123"');
    expect(es3String('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(es3String('a\nb\rc\td')).toBe('"a\\nb\\rc\\td"');
  });

  it('中文、全形、emoji、行分隔字元都寫成 \\uXXXX（檔案編碼怎樣都不會亂掉）', () => {
    expect(es3String('示範')).toBe('"\\u793A\\u7BC4"');
    expect(es3String('×–')).toBe('"\\u00D7\\u2013"');
    expect(es3String('\u{1F600}')).toBe('"\\uD83D\\uDE00"');
    expect(es3String('a\u2028b')).toBe('"a\\u2028b"');
    expect(es3String('\u0000')).toBe('"\\u0000"');
    // 寫出來的字串用 JS 讀回去跟原本一樣
    const tricky = '示範專案 "A\\B"\n第二行 \u2028 \u{1F600} </script>';
    expect(JSON.parse(es3String(tricky))).toBe(tricky);
  });

  it('es3Literal：物件、陣列、數字（四捨五入到小數 3 位）、壞數字變 0', () => {
    expect(es3Literal({ a: [1, 2.34567, -0], b: '中', c: null, d: true, e: undefined }))
      .toBe('{"a":[1,2.346,0],"b":"\\u4E2D","c":null,"d":true}');
    expect(es3Literal([NaN, Infinity])).toBe('[0,0]');
  });
});

describe('panelPaths：每塊 LED 的外框（畫布像素）', () => {
  it('長方形 → 四個角，跟對位圖的 x y w h 一樣', () => {
    const layout = demoLayout();
    const main = layout.panels.find(p => p.name === '主螢幕')!;
    expect(main.rect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(panelPaths(main, CANVAS)).toEqual([{ v: [[0, 0], [1920, 0], [1920, 1080], [0, 1080]], c: true }]);
    const side = layout.panels.find(p => p.name === 'Side "L"')!;
    expect(panelPaths(side, CANVAS)).toEqual([{ v: [[1920, 0], [2880, 0], [2880, 1080], [1920, 1080]], c: true }]);
  });

  it('跨畫布左右邊緣 → 兩份（往左平移一個畫布再畫一次）', () => {
    const layout = buildLedLayout([{ id: 'w', name: '環形', tris: quad(0.9, 0.25, 1.1, 0.75) }], CANVAS);
    const p = layout.panels[0];
    expect(p.wrapsX).toBe(true);
    expect(p.rect).toEqual({ x: 3456, y: 540, w: 768, h: 1080 });
    const paths = panelPaths(p, CANVAS);
    expect(paths).toHaveLength(2);
    expect(paths[0].v[0]).toEqual([3456, 540]);
    expect(paths[1].v[0]).toEqual([3456 - 3840, 540]);
  });

  it('不是長方形（L 形）→ 照實際形狀，直線中間的點拿掉', () => {
    // L 形：左邊一條直的 + 下面一條橫的（三個正方形）
    const tris = [...quad(0, 0, 0.25, 0.25), ...quad(0, 0.25, 0.25, 0.5), ...quad(0.25, 0.25, 0.5, 0.5)];
    const p = buildLedLayout([{ id: 'l', name: 'L', tris }], { width: 1000, height: 1000 }).panels[0];
    expect(p.coverage).toBeLessThan(0.98);
    const paths = panelPaths(p, { width: 1000, height: 1000 });
    expect(paths).toHaveLength(1);
    expect(paths[0].c).toBe(true);
    const pts = paths[0].v.map(([x, y]) => `${x},${y}`).sort();
    expect(pts).toEqual(['0,0', '0,500', '250,0', '250,250', '500,250', '500,500'].sort());
  });

  it('edgeLoops：沒有接起來的線段 → 開放的路徑；simplifyPath 留下轉角', () => {
    const loops = edgeLoops([0, 0, 0.5, 0, 0.5, 0, 1, 0], { width: 100, height: 100 });
    expect(loops).toHaveLength(1);
    expect(loops[0].c).toBe(false);
    expect(loops[0].v).toEqual([[0, 0], [100, 0]]);
    expect(simplifyPath([[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]], true)).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
  });
});

describe('panelLabels：名字標籤', () => {
  it('同一個位置的 LED 共用一個標籤；寫名字、像素大小、位置；放在 LED 左上角裡面', () => {
    const labels = panelLabels(demoLayout());
    expect(labels).toHaveLength(2);
    const main = labels.find(l => l.text.startsWith('主螢幕'))!;
    expect(main.text).toBe('主螢幕 / 鏡像\r1920 × 1080 px\rx 0  y 0');
    expect(main.layerName).toBe('主螢幕 / 鏡像 標籤');
    expect(main.label).toBe(1);
    expect(main.size).toBeGreaterThanOrEqual(10);
    expect(main.size).toBeLessThanOrEqual(40);
    expect(main.pos[0]).toBeGreaterThan(0);
    expect(main.pos[1]).toBeGreaterThan(main.size);
    expect(main.pos[0]).toBeLessThan(1920);
  });

  it('超過三塊在同一個位置 → 寫「等 N 塊」', () => {
    const layout = buildLedLayout(['A', 'B', 'C', 'D'].map(n => ({ id: n, name: n, tris: quad(0, 0, 1, 1) })), CANVAS);
    expect(panelLabels(layout)[0].text.split('\r')[0]).toBe('A / B / C 等 4 塊');
  });
});

describe('其他小工具', () => {
  it('合成名稱', () => {
    expect(aeCompName('示範專案', CANVAS)).toBe('Stage Previz – 示範專案 – 3840x2160');
    expect(aeCompName('', CANVAS)).toBe('Stage Previz – 未命名專案 – 3840x2160');
    expect(aeCompName('A\nB', CANVAS)).toBe('Stage Previz – A B – 3840x2160');
  });

  it('顏色', () => {
    expect(hslToRgb01(0, 1, 0.5)).toEqual([1, 0, 0]);
    expect(hslToRgb01(120, 1, 0.5)).toEqual([0, 1, 0]);
    expect(hslToRgb01(240, 1, 0.5)).toEqual([0, 0, 1]);
  });

  it('檔名、base64 分段', () => {
    expect(ledMapFileName('jsx', { projectName: '主舞臺', canvas: CANVAS, date: '2026-10-14' })).toBe('AE合成腳本-主舞臺-3840x2160-2026-10-14.jsx');
    expect(chunkBase64('abcdefgh', 4)).toEqual(['abcd', 'efgh']);
    expect(chunkBase64('', 4)).toEqual([]);
  });
});

// ─── 整支腳本 ───

function input(over: Partial<AeScriptInput> = {}): AeScriptInput {
  return { layout: demoLayout(), projectName: '示範專案', date: '2026-10-14', canvasSource: 'project', ...over };
}

describe('buildAeCompScript：整支 .jsx', () => {
  it('開頭有 BOM、說明註解；程式的部分只有 ASCII（中文都跳脫了）', () => {
    const js = buildAeCompScript(input());
    expect(js.charCodeAt(0)).toBe(0xfeff);
    expect(js).toContain('// Stage Previz：AE 一鍵建合成');
    expect(js).toContain('//@target aftereffects');
    const code = js.slice(js.indexOf('(function () {'));
    expect(/[^\x09\x0a\x0d\x20-\x7e]/.test(code)).toBe(false);
  });

  it('RUNNER 是 ES3：沒有 let / const / 箭頭函式 / 樣板字串 / forEach / indexOf / JSON', () => {
    expect(RUNNER).not.toMatch(/\b(let|const|class)\s/);
    expect(RUNNER).not.toMatch(/=>/);
    expect(RUNNER).not.toMatch(/`/);
    expect(RUNNER).not.toMatch(/\.(forEach|map|filter|indexOf|includes|trim)\(/);
    expect(RUNNER).not.toMatch(/\bJSON\b/);
  });

  it('專案名稱有換行也不會跑出註解', () => {
    const js = buildAeCompScript(input({ projectName: 'A\nalert("x")' }));
    for (const line of js.split('\n').slice(0, 7)) expect(line.startsWith('//') || line.startsWith('\uFEFF//') || line.startsWith('(function')).toBe(true);
  });
});

// ─── 用假的 AE 跑一次整支腳本 ───

interface FakeLayer {
  kind: 'shape' | 'text' | 'footage';
  name: string;
  label?: number;
  guideLayer: boolean;
  locked: boolean;
  blendingMode?: string;
  root: FakeProp;
  property: (n: string) => FakeProp;
}

class FakeProp {
  value: unknown;
  name = '';
  children = new Map<string, FakeProp>();
  added: { type: string; prop: FakeProp }[] = [];
  constructor(public type: string) {}
  setValue(v: unknown) { this.value = v; }
  property(n: string): FakeProp {
    let p = this.children.get(n);
    if (!p) { p = new FakeProp(n); this.children.set(n, p); }
    return p;
  }
  addProperty(n: string): FakeProp {
    const p = new FakeProp(n);
    this.added.push({ type: n, prop: p });
    return p;
  }
}

function runInFakeAe(script: string, opts: { answers: (string | null)[]; canWrite?: boolean }) {
  const alerts: string[] = [];
  const prompts: { msg: string; def: string }[] = [];
  const files = new Map<string, string>();
  const comps: Record<string, unknown>[] = [];
  const layers: FakeLayer[] = [];
  const answers = [...opts.answers];
  const makeLayer = (kind: FakeLayer['kind']): FakeLayer => {
    const root = new FakeProp('root');
    const l: FakeLayer = { kind, name: '', guideLayer: false, locked: false, root, property: (n: string) => root.property(n) };
    layers.unshift(l);
    return l;
  };
  const folderObj = (fsName: string) => ({ fsName, exists: true });
  class File {
    fsName: string;
    encoding = 'UTF-8';
    constructor(path: string) { this.fsName = path; }
    get parent() { return folderObj(this.fsName.replace(/[\\/][^\\/]*$/, '')); }
    get exists() { return files.has(this.fsName); }
    get length() { return files.get(this.fsName)?.length ?? 0; }
    open() { files.set(this.fsName, ''); return true; }
    write(s: string) { files.set(this.fsName, (files.get(this.fsName) ?? '') + s); }
    close() {}
  }
  const app = {
    project: {
      items: {
        addFolder: (name: string) => ({ name, remove() {} }),
        addComp: (name: string, width: number, height: number, par: number, duration: number, fps: number) => {
          const comp = {
            name, width, height, par, duration, fps, comment: '', parentFolder: null as unknown, opened: false, removed: false,
            layers: {
              addShape: () => makeLayer('shape'),
              addText: (text: string) => {
                const l = makeLayer('text');
                l.property('ADBE Text Properties').property('ADBE Text Document').value = { text };
                return l;
              },
              add: () => makeLayer('footage'),
            },
            openInViewer() { this.opened = true; },
            remove() { this.removed = true; },
          };
          comps.push(comp);
          return comp;
        },
      },
      importFile: (io: { file: File }) => ({ file: io.file, parentFolder: null }),
    },
    preferences: { getPrefAsLong: () => (opts.canWrite === false ? 0 : 1) },
    beginUndoGroup() {},
    endUndoGroup() {},
  };
  const env = {
    app,
    alert: (m: string) => { alerts.push(m); },
    prompt: (msg: string, def: string) => { prompts.push({ msg, def }); return answers.length ? answers.shift()! : null; },
    $: { os: 'Windows 10', fileName: 'C:/Users/me/Downloads/AE合成腳本.jsx' },
    File,
    Folder: { myDocuments: folderObj('C:/Users/me/Documents'), temp: folderObj('C:/Temp') },
    Shape: class { vertices: unknown; closed = false },
    ImportOptions: class { constructor(public file: File) {} },
    BlendingMode: { SCREEN: 'screen' },
    ParagraphJustification: { LEFT_JUSTIFY: 'left' },
  };
  const names = Object.keys(env);
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(...names, script.replace(/^\uFEFF/, ''))(...names.map(n => (env as Record<string, unknown>)[n]));
  return { alerts, prompts, files, comps, layers };
}

describe('用假的 AE 跑整支腳本', () => {
  it('問長度 → 建合成（名字、大小、fps、長度）、每塊 LED 一個外框、名字標籤，都是導引圖層、鎖住', () => {
    const r = runInFakeAe(buildAeCompScript(input()), { answers: ['2:30'] });
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0].def).toBe('3:00');
    expect(r.prompts[0].msg).toContain('3840 × 2160、30 fps');
    expect(r.comps).toHaveLength(1);
    expect(r.comps[0]).toMatchObject({ name: 'Stage Previz – 示範專案 – 3840x2160', width: 3840, height: 2160, par: 1, duration: 150, fps: 30, opened: true });
    const shapes = r.layers.filter(l => l.kind === 'shape');
    const texts = r.layers.filter(l => l.kind === 'text');
    expect(shapes.map(l => l.name).sort()).toEqual(['Side "L"', '主螢幕', '鏡像'].sort());
    expect(texts).toHaveLength(2);
    for (const l of r.layers) { expect(l.guideLayer).toBe(true); expect(l.locked).toBe(true); }
    // 名字在最上面、外框在下面；第一塊 LED 的外框在外框裡最上面
    expect(r.layers[0].kind).toBe('text');
    expect(r.layers[texts.length].name).toBe('主螢幕');
    // 外框的點 = 對位圖的位置
    const main = shapes.find(l => l.name === '主螢幕')!;
    const group = main.root.property('ADBE Root Vectors Group').added[0].prop;
    const vectors = group.property('ADBE Vectors Group');
    expect(vectors.added.map(a => a.type)).toEqual(['ADBE Vector Shape - Group', 'ADBE Vector Graphic - Stroke', 'ADBE Vector Graphic - Fill']);
    const shapeVal = vectors.added[0].prop.property('ADBE Vector Shape').value as { vertices: number[][]; closed: boolean };
    expect(shapeVal.vertices).toEqual([[0, 0], [1920, 0], [1920, 1080], [0, 1080]]);
    expect(shapeVal.closed).toBe(true);
    // 標籤的字
    const label = texts.find(l => l.name.startsWith('主螢幕'))!;
    const doc = label.property('ADBE Text Properties').property('ADBE Text Document').value as Record<string, unknown>;
    expect(doc.text).toBe('主螢幕 / 鏡像\r1920 × 1080 px\rx 0  y 0');
    expect(doc.font).toBe('MicrosoftJhengHeiRegular');
    // 最後的說明
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toContain('建好了');
    expect(r.alerts[0]).toContain('長度 2:30');
    expect(r.alerts[0]).toContain('LED 外框 3 塊、名字標籤 2 個');
  });

  it('按取消 → 什麼都不建；長度寫錯 → 再問一次', () => {
    expect(runInFakeAe(buildAeCompScript(input()), { answers: [null] }).comps).toHaveLength(0);
    const r = runInFakeAe(buildAeCompScript(input()), { answers: ['三分鐘', '90'] });
    expect(r.prompts).toHaveLength(2);
    expect(r.prompts[1].msg).toContain('看不懂這個長度');
    expect(r.prompts[1].def).toBe('三分鐘');
    expect(r.comps[0].duration).toBe(90);
    expect(runInFakeAe(buildAeCompScript(input()), { answers: ['1:02:03'] }).comps[0].duration).toBe(3723);
    expect(runInFakeAe(buildAeCompScript(input()), { answers: ['0:75', '0'] }).comps).toHaveLength(0);
  });

  it('夾帶的對位圖：解開寫成檔案（跟原本的 bytes 一樣）、放在最下面、濾色', () => {
    const bytes = Uint8Array.from({ length: 30001 }, (_, i) => (i * 37 + (i >> 3)) & 255);
    const base64 = Buffer.from(bytes).toString('base64');
    const r = runInFakeAe(buildAeCompScript(input({ map: { fileName: 'LED對位圖.png', width: 1920, height: 1080, base64 } })), { answers: ['3:00'] });
    const path = 'C:/Users/me/Downloads/LED對位圖.png';
    expect(r.files.has(path)).toBe(true);
    const written = r.files.get(path)!;
    expect(written.length).toBe(bytes.length);
    expect(Array.from(written, c => c.charCodeAt(0))).toEqual(Array.from(bytes));
    const bottom = r.layers[r.layers.length - 1];
    expect(bottom.kind).toBe('footage');
    expect(bottom.name).toBe('LED 對位圖（參考）');
    expect(bottom.blendingMode).toBe('screen');
    expect(bottom.property('ADBE Transform Group').property('ADBE Scale').value).toEqual([200, 200]);
    expect(r.alerts[0]).toContain('LED 對位圖：放好了');
  });

  it('AE 不允許腳本存檔 → 不放對位圖，說要去哪裡打開', () => {
    const r = runInFakeAe(buildAeCompScript(input({ map: { fileName: 'm.png', width: 10, height: 10, base64: 'AAAA' } })), { answers: ['3:00'], canWrite: false });
    expect(r.files.size).toBe(0);
    expect(r.layers.some(l => l.kind === 'footage')).toBe(false);
    expect(r.alerts[0]).toContain('允許指令碼寫入檔案和存取網路');
  });

  it('畫布超過 AE 上限 → 先說，不問也不建', () => {
    const layout = buildLedLayout([{ id: 'a', name: 'A', tris: quad(0, 0, 1, 1) }], { width: 32000, height: 2000 });
    const r = runInFakeAe(buildAeCompScript(input({ layout })), { answers: ['3:00'] });
    expect(r.prompts).toHaveLength(0);
    expect(r.comps).toHaveLength(0);
    expect(r.alerts[0]).toContain('超過 AE 合成的上限 30000 px');
  });
});
