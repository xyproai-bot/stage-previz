import { describe, expect, it } from 'vitest';
import type { LedTemplatePlan, ScreenDef } from './ledTemplate';
import { splitLayoutByScreens } from './ledTemplateContent';
import { buildAeTilesScript, layoutFromDefs, tileFileNames, tilesOf, tilesToCsv, tilesZipFileName } from './ledTemplateTiles';
import { buildZip, crc32 } from './zipStore';
import { es3Violations } from '../test/es3Lint';
import { readFileSync } from 'node:fs';

const DEFS: ScreenDef[] = [
  { key: 'o:a', objectId: 'a', name: '中間底幕', manual: false, uv: null, src: { us: 0.25, ul: 0.5, vs: 0.4, vl: 0.2 }, nativeW: 4400, nativeH: 400 },
  { key: 'o:b', objectId: 'b', name: 'Side "L"/左', manual: false, uv: null, src: { us: 0, ul: 0.1, vs: 0, vl: 0.5 }, nativeW: 880, nativeH: 1000 },
  { key: 'o:c', objectId: 'c', name: 'side "l"/左', manual: false, uv: null, src: { us: 0.9, ul: 0.1, vs: 0, vl: 0.5 }, nativeW: 880, nativeH: 1000 },
];

const PLAN: LedTemplatePlan = {
  v: 1, id: 't1', name: '版型 1', canvas: { width: 1920, height: 1080 }, scalePct: 25,
  screens: [
    { key: 'o:a', objectId: 'a', uv: null, dest: { x: 0, y: 0, w: 1100, h: 100 }, rotate: 0, flipH: false, flipV: false },
    { key: 'o:b', objectId: 'b', uv: null, dest: { x: 10, y: 120, w: 250, h: 220 }, rotate: 90, flipH: true, flipV: false },
    { key: 'o:c', objectId: 'c', uv: null, dest: { x: 300, y: 120, w: 220, h: 250 }, rotate: 0, flipH: false, flipV: true },
  ],
};

describe('每塊 LED 的檔名', () => {
  it('不能用在檔名的字換成 _，重名（大小寫不分）加 -2、-3', () => {
    expect(tileFileNames(['A/B', 'a/b', 'A:B', '正常'])).toEqual(['A_B.png', 'a_b-2.png', 'A_B-3.png', '正常.png']);
  });
  it('空名字有預設；開頭的點、結尾的點拿掉', () => {
    expect(tileFileNames(['', '..x.'])).toEqual(['專案.png', 'x.png']);
  });
});

describe('每塊的大小跟位置', () => {
  it('大小 = 版型裡的像素大小，檔名不重複', () => {
    const { tiles } = tilesOf(PLAN, DEFS);
    expect(tiles.map(t => [t.w, t.h, t.x, t.y])).toEqual([[1100, 100, 0, 0], [250, 220, 10, 120], [220, 250, 300, 120]]);
    expect(new Set(tiles.map(t => t.fileName.toLowerCase())).size).toBe(3);
  });
  it('整張畫布的測試圖排法：每塊螢幕一塊', () => {
    const lay = layoutFromDefs(DEFS, { width: 8800, height: 2000 });
    expect(lay.panels.length).toBe(3);
  });
});

describe('座標表 CSV', () => {
  it('有名稱、x、y、w、h、旋轉、翻轉、檔名，前面有 BOM', () => {
    const csv = tilesToCsv(tilesOf(PLAN, DEFS).tiles);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('名稱,x,y,w,h,旋轉,左右翻,上下翻,檔名');
    expect(lines[2]).toBe('"Side ""L""/左",10,120,250,220,90,是,否,Side _L_左.png');
    expect(lines.length).toBe(4);
  });
});

describe('AE 腳本：每塊 LED 一個合成', () => {
  const { tiles } = tilesOf(PLAN, DEFS);
  const js = buildAeTilesScript({ plan: PLAN, tiles, projectName: '示範專案', date: '2026-10-22' });

  it('是合法的 ES3，沒有說明框那句話', () => {
    expect(es3Violations(js)).toEqual([]);
    expect(js).not.toContain('不要一起輸出');
  });

  it('跑一遍：每塊一個合成（大小 = 那塊）+ 一個整張畫布大小的總合成，位置 = 中心點', () => {
    const comps: { name: string; w: number; h: number; layers: { name: string; guide: boolean; pos?: number[]; src: string }[] }[] = [];
    class FakeFile {
      fsName: string; exists = true;
      constructor(public p: string) { this.fsName = p; }
      get parent() { return new FakeFolder('C:/zip'); }
    }
    class FakeFolder {
      exists = true; fsName: string;
      constructor(public p: string) { this.fsName = p; }
      static selectDialog() { return null; }
    }
    const app = {
      project: {
        items: {
          addFolder: (name: string) => ({ name }),
          addComp: (name: string, w: number, h: number) => {
            const c = { name, w, h, layers: [] as { name: string; guide: boolean; pos?: number[]; src: string }[] };
            comps.push(c);
            return {
              name, comment: '', parentFolder: null, openInViewer() {},
              layers: {
                add: (src: { id: string; width?: number; height?: number }) => {
                  const L = { name: '', guide: false, pos: undefined as number[] | undefined, src: src.id };
                  c.layers.push(L);
                  const o = {
                    set name(v: string) { L.name = v; }, set guideLayer(v: boolean) { L.guide = v; }, set locked(_v: boolean) {}, set comment(_v: string) {},
                    property: (n: string) => ({ setValue: (v: number[]) => { if (n === 'Position') L.pos = v; } }),
                  };
                  return o;
                },
              },
            };
          },
        },
        importFile: (io: { f: FakeFile }) => ({ id: 'footage:' + io.f.p, width: 0, height: 0 }),
      },
      newProject() {}, beginUndoGroup() {}, endUndoGroup() {},
    };
    // 合成物件要有 id 讓 layers.add 認得來源
    const origAdd = app.project.items.addComp;
    app.project.items.addComp = ((name: string, w: number, h: number) => { const r = origAdd(name, w, h) as Record<string, unknown>; r.id = 'comp:' + name; return r as never; }) as never;
    const alerts: string[] = [];
    new Function('app', 'File', 'Folder', 'ImportOptions', 'prompt', 'alert', '$', js)(
      app, FakeFile, FakeFolder, class { f: FakeFile; constructor(f: FakeFile) { this.f = f; } }, () => '10', (m: string) => alerts.push(m), { fileName: 'C:/zip/AE.jsx' },
    );
    expect(comps.length).toBe(4);   // 總合成 + 3 塊
    const main = comps[0];
    expect([main.w, main.h]).toEqual([1920, 1080]);
    expect(main.layers.length).toBe(3);
    expect(main.layers.map(l => l.pos)).toEqual([[550, 50], [135, 230], [410, 245]]);
    for (const t of comps.slice(1)) {
      expect(t.layers.length).toBe(1);
      expect(t.layers[0].guide).toBe(true);
    }
    expect(comps.slice(1).map(c => [c.w, c.h])).toEqual([[1100, 100], [250, 220], [220, 250]]);
    expect(alerts.length).toBe(1);
    expect(alerts[0]).toContain('建好了');
  });
});

describe('zip', () => {
  it('crc32 標準答案', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('打包後能讀回每個檔案（檔名 UTF-8、內容一樣）', async () => {
    const a = new TextEncoder().encode('hello');
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    const blob = buildZip([{ path: 'tiles/中文.png', data: a }, { path: 'x.csv', data: b }]);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    // 結尾記錄
    const end = buf.length - 22;
    expect(dv.getUint32(end, true)).toBe(0x06054b50);
    expect(dv.getUint16(end + 10, true)).toBe(2);
    let p = dv.getUint32(end + 16, true);
    const out: [string, number, number][] = [];
    for (let i = 0; i < 2; i++) {
      expect(dv.getUint32(p, true)).toBe(0x02014b50);
      const crc = dv.getUint32(p + 16, true), size = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), off = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nl));
      const lnl = dv.getUint16(off + 26, true);
      const data = buf.subarray(off + 30 + lnl, off + 30 + lnl + size);
      expect(crc32(data)).toBe(crc);
      out.push([name, size, data[0]]);
      p += 46 + nl;
    }
    expect(out).toEqual([['tiles/中文.png', 5, 104], ['x.csv', 5, 1]]);
  });
  it('zip 檔名', () => {
    expect(tilesZipFileName('主舞臺', PLAN)).toBe('LED每塊圖-主舞臺-版型 1-1920x1080.zip');
  });
});

describe('下載的圖不再有說明框', () => {
  it('ledTemplateDraw 裡沒有說明框的文字', () => {
    const src = readFileSync(new URL('./ledTemplateDraw.ts', import.meta.url), 'utf-8');
    expect(src).not.toContain('不要一起輸出');
    expect(src).not.toContain('drawGuideLegend');
  });
});

describe('一個物件裡好幾塊 LED：每塊各自一張完整測試圖', () => {
  const canvas = { width: 8800, height: 2000 };
  const sp = (us: number, ul: number, vs: number, vl: number) => ({ us, ul, vs, vl });
  const mk = (key: string, name: string, src: ReturnType<typeof sp>): ScreenDef =>
    ({ key, objectId: 'x', name, manual: false, uv: null, src, nativeW: Math.round(src.ul * 8800), nativeH: Math.round(src.vl * 2000) });
  const PARTS: ScreenDef[] = [
    mk('o:x~曲線升降-3_L', '曲線升降-3_L', sp(0.1, 0.05, 0.2, 0.3)),
    mk('o:x~曲線升降-3_R', '曲線升降-3_R', sp(0.45, 0.05, 0.2, 0.3)),
    mk('o:x~曲線升降-3_正面', '曲線升降-3_正面', sp(0.15, 0.3, 0.2, 0.1)),
  ];
  // 模擬 3D 排出來的「一個物件一格」（格子 id = 物件 id）
  const objLayout = (() => {
    const l = layoutFromDefs([mk('x', '曲線升降-3', sp(0.1, 0.4, 0.2, 0.3)), mk('y', '別的LED', sp(0.6, 0.1, 0, 0.2))], canvas);
    return { ...l, panels: l.panels.map(p => ({ ...p })) };
  })();

  it('整個物件一格 -> 換成每塊各自一格，名稱和範圍都是自己的', () => {
    const out = splitLayoutByScreens(objLayout, PARTS);
    expect(out.panels.map(p => p.name)).toEqual(['曲線升降-3_L', '曲線升降-3_R', '曲線升降-3_正面', '別的LED']);
    const l = out.panels[0].rect, f = out.panels[2].rect;
    expect(l.w).toBeCloseTo(0.05 * 8800); expect(l.h).toBeCloseTo(0.3 * 2000);
    expect(f.w).toBeCloseTo(0.3 * 8800); expect(f.h).toBeCloseTo(0.1 * 2000);
    expect(new Set(out.panels.map(p => p.color)).size).toBe(4);
  });
  it('沒有拆的物件、舊代號 o:物件id：原樣回傳', () => {
    expect(splitLayoutByScreens(objLayout, [mk('o:x', '曲線升降-3', sp(0.1, 0.4, 0.2, 0.3))])).toBe(objLayout);
    expect(splitLayoutByScreens(objLayout, DEFS)).toBe(objLayout);
  });
});
