import { describe, it, expect } from 'vitest';
import {
  axisSpan, buildLedLayout, exportScales, groupSameRect, layoutPanel, layoutToCsv, layoutToJson, ledMapFileName, legendLines,
  parseCanvasInput, pickLegendCorner, resolveLedCanvas, spanToPixels, testPatternSize, wrapOffsets, type LedMapMeta,
} from './ledMap';

/** 一個長方形（兩個三角形）的 UV */
function quad(u0: number, v0: number, u1: number, v1: number): number[] {
  return [u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1];
}

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('axisSpan', () => {
  it('一般情況：最小到最大', () => {
    const s = axisSpan([[0.1, 0.3], [0.25, 0.5]])!;
    close(s.start, 0.1); close(s.length, 0.4); expect(s.wraps).toBe(false);
  });
  it('整片在負的（C4D 匯出常見 v ∈ [-0.8, -0.45]）→ 繞回 [0.2, 0.55]', () => {
    const s = axisSpan([[-0.8, -0.6], [-0.6, -0.45]])!;
    close(s.start, 0.2); close(s.length, 0.35); expect(s.wraps).toBe(false);
  });
  it('整片大於 1（u ∈ [1.2, 1.4]）→ [0.2, 0.4]', () => {
    const s = axisSpan([[1.2, 1.4]])!;
    close(s.start, 0.2); close(s.length, 0.2);
  });
  it('剛好壓在接縫上的三角形（u ∈ [0.95, 1.05]）→ 跨邊緣', () => {
    const s = axisSpan([[0.95, 1.05]])!;
    close(s.start, 0.95); close(s.length, 0.1); expect(s.wraps).toBe(true);
  });
  it('負的那邊跨接縫（v ∈ [-0.1, 0.2]）→ 從 0.9 開始、長 0.3', () => {
    const s = axisSpan([[-0.1, 0.2]])!;
    close(s.start, 0.9); close(s.length, 0.3); expect(s.wraps).toBe(true);
  });
  it('接縫剛好切在三角形中間（[0.9, 1.0] 和 [1.0, 1.1] 兩個三角形）→ 還是同一塊、跨邊緣', () => {
    const s = axisSpan([[0.9, 1.0], [1.0, 1.1]])!;
    close(s.start, 0.9); close(s.length, 0.2); expect(s.wraps).toBe(true);
  });
  it('左右兩頭各一段、沒有跨接縫：空檔沒有大很多 → 不跨，照一般範圍', () => {
    // 中間空檔 0.2、接縫空檔 0 + 0.0 = 0：差不到 0.25 → 不跨
    const s = axisSpan([[0, 0.4], [0.6, 1.0]])!;
    close(s.start, 0); close(s.length, 1); expect(s.wraps).toBe(false);
  });
  it('左右兩頭各一小段（中間空很大）→ 當成跨邊緣的同一塊', () => {
    const s = axisSpan([[0, 0.1], [0.9, 1.0]])!;
    close(s.start, 0.9); close(s.length, 0.2); expect(s.wraps).toBe(true);
  });
  it('三段平均分散 → 不跨', () => {
    const s = axisSpan([[0, 0.3], [0.35, 0.65], [0.7, 1]])!;
    expect(s.wraps).toBe(false); close(s.start, 0); close(s.length, 1);
  });
  it('一個三角形本身就超過 1 → 整條', () => {
    expect(axisSpan([[-0.2, 0.9]])).toEqual({ start: 0, length: 1, wraps: false });
  });
  it('沒有範圍 / 壞數字 → null', () => {
    expect(axisSpan([])).toBeNull();
    expect(axisSpan([[NaN, 1]])).toBeNull();
  });
  it('浮點誤差：0.9999999 當成 1', () => {
    const s = axisSpan([[0.9999999, 1.2]])!;
    close(s.start, 0); close(s.length, 0.2); expect(s.wraps).toBe(false);
  });
});

describe('spanToPixels', () => {
  it('邊界四捨五入', () => {
    expect(spanToPixels({ start: 0.2, length: 0.35, wraps: false }, 5120)).toEqual({ pos: 1024, len: 1792 });
  });
  it('start 很接近 1 → 從 0 開始', () => {
    expect(spanToPixels({ start: 0.99999, length: 0.1, wraps: true }, 1000)).toEqual({ pos: 0, len: 100 });
  });
});

const canvas = { width: 10496, height: 5120 };

describe('layoutPanel', () => {
  it('負的 v 繞回來，算出像素位置', () => {
    const p = layoutPanel({ id: 'a', name: '主螢幕', tris: quad(0, -0.8, 0.5, -0.45) }, canvas, 0)!;
    expect(p.rect).toEqual({ x: 0, y: 1024, w: 5248, h: 1792 });
    expect(p.wrapsX).toBe(false);
    expect(p.wrapsY).toBe(false);
    // 三角形也繞回來了
    for (let i = 1; i < p.tris.length; i += 2) {
      expect(p.tris[i]).toBeGreaterThanOrEqual(0.2 - 1e-9);
      expect(p.tris[i]).toBeLessThanOrEqual(0.55 + 1e-9);
    }
    expect(p.coverage).toBeCloseTo(1, 5);
    expect(p.triCount).toBe(2);
    // 長方形：外圍 4 條邊（對角線是兩個三角形共用的，不算）
    expect(p.edges.length / 4).toBe(4);
  });

  it('跨畫布右邊緣：x 在畫布裡、寬度跨出去，三角形都在同一段', () => {
    const p = layoutPanel({ id: 'b', name: '側翼', tris: [...quad(0.9, 0, 1.0, 0.1), ...quad(1.0, 0, 1.1, 0.1)] }, { width: 1000, height: 1000 }, 1)!;
    expect(p.rect).toEqual({ x: 900, y: 0, w: 200, h: 100 });
    expect(p.wrapsX).toBe(true);
    for (let i = 0; i < p.tris.length; i += 2) {
      expect(p.tris[i]).toBeGreaterThanOrEqual(0.9 - 1e-9);
      expect(p.tris[i]).toBeLessThanOrEqual(1.1 + 1e-9);
    }
    expect(wrapOffsets(p, { width: 1000, height: 1000 })).toEqual([[0, 0], [-1000, 0]]);
  });

  it('不是長方形（三角形）：位置是外框，coverage 大約一半', () => {
    const p = layoutPanel({ id: 'c', name: '斜的', tris: [0.1, 0.1, 0.5, 0.1, 0.1, 0.5] }, { width: 1000, height: 1000 }, 2)!;
    expect(p.rect).toEqual({ x: 100, y: 100, w: 400, h: 400 });
    expect(p.coverage).toBeCloseTo(0.5, 5);
    expect(p.edges.length / 4).toBe(3);
  });

  it('正反兩面同一塊 UV：重複的三角形只留一個，外框線照樣畫得出來', () => {
    const front = quad(0.1, 0.1, 0.3, 0.2);
    // 背面：同樣的點、反過來的順序
    const back: number[] = [];
    for (let t = 0; t < front.length; t += 6) back.push(front[t], front[t + 1], front[t + 4], front[t + 5], front[t + 2], front[t + 3]);
    const p = layoutPanel({ id: 'd', name: '雙面', tris: [...front, ...back] }, { width: 1000, height: 1000 }, 0)!;
    expect(p.triCount).toBe(2);
    expect(p.edges.length / 4).toBe(4);
  });

  it('擠成一條線的側面（UV 面積 0）不算進外框', () => {
    const p = layoutPanel({ id: 'e', name: '有側邊', tris: [...quad(0.5, 0.5, 0.6, 0.6), 0, 0, 0, 0, 0.5, 0.5] }, { width: 1000, height: 1000 }, 0)!;
    expect(p.rect).toEqual({ x: 500, y: 500, w: 100, h: 100 });
  });

  it('沒有能用的三角形 → null，buildLedLayout 記在 skipped', () => {
    expect(layoutPanel({ id: 'f', name: '壞的', tris: [0, 0, 0, 0, 0, 0] }, canvas, 0)).toBeNull();
    const layout = buildLedLayout([
      { id: 'a', name: 'A', tris: quad(0, 0, 0.5, 0.5) },
      { id: 'f', name: '沒有 UV', tris: [] },
      { id: 'b', name: 'B', tris: quad(0.5, 0, 1, 0.5) },
    ], canvas);
    expect(layout.panels.map(p => p.name)).toEqual(['A', 'B']);
    expect(layout.skipped).toEqual(['沒有 UV']);
    // 顏色每塊不一樣
    expect(layout.panels[0].color).not.toBe(layout.panels[1].color);
  });
});

describe('groupSameRect', () => {
  it('位置一樣的放一起（左右兩面同畫面）', () => {
    const layout = buildLedLayout([
      { id: 'l', name: '左', tris: quad(0, 0, 0.5, 1) },
      { id: 'r', name: '右', tris: quad(0, 0, 0.5, 1) },
      { id: 'c', name: '中', tris: quad(0.5, 0, 1, 1) },
    ], { width: 1920, height: 1080 });
    const g = groupSameRect(layout.panels);
    expect(g).toHaveLength(2);
    expect(g[0].panels.map(p => p.name)).toEqual(['左', '右']);
  });
});

const meta: LedMapMeta = { projectName: '主舞臺', date: '2026-10-14', canvas, canvasSource: 'project' };

describe('CSV / JSON / 說明', () => {
  const layout = buildLedLayout([
    { id: 'a', name: '主螢幕', tris: quad(0, -0.8, 0.5, -0.45) },
    { id: 'b', name: '側翼, "右"', tris: quad(0.95, 0, 1.05, 0.1) },
    { id: 'c', name: '斜的', tris: [0.6, 0.6, 0.9, 0.6, 0.6, 0.9] },
  ], canvas);

  it('CSV：BOM、標題、每塊一行、逗號和引號會被包起來', () => {
    const csv = layoutToCsv(layout);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe('名稱,x,y,w,h,x+w,y+h,跨畫布邊緣,不是長方形');
    expect(lines[1]).toBe('主螢幕,0,1024,5248,1792,5248,2816,,');
    expect(lines[2]).toBe('"側翼, ""右""",9971,0,1050,512,11021,512,左右,');
    expect(lines[3]).toBe('斜的,6298,3072,3148,1536,9446,4608,,是（位置是外框）');
    expect(lines).toHaveLength(4);
  });

  it('JSON：畫布、每塊的位置和 UV', () => {
    const j = JSON.parse(layoutToJson(layout, meta));
    expect(j.project).toBe('主舞臺');
    expect(j.canvas).toEqual({ width: 10496, height: 5120, source: 'project' });
    expect(j.uvOrigin).toBe('top-left');
    expect(j.panels[0]).toMatchObject({ name: '主螢幕', x: 0, y: 1024, w: 5248, h: 1792, wrapsX: false, rectangular: true, uv: { u0: 0, v0: 0.2, u1: 0.5, v1: 0.55 } });
    expect(j.panels[1]).toMatchObject({ wrapsX: true, uv: { u0: 0.95, u1: 1.05 } });
    expect(j.panels[2].rectangular).toBe(false);
  });

  it('說明：專案、日期、畫布大小和來源', () => {
    expect(legendLines(meta, 3)).toEqual([
      'LED 對位圖',
      '專案：主舞臺',
      '日期：2026-10-14',
      '畫布：10496 × 5120 px（製作設定的）',
      'LED 3 塊 · 格線每 100 px · 位置是左上角 x, y 和寬 w、高 h',
    ]);
    const d = legendLines({ ...meta, projectName: '', canvasSource: 'default', scale: 0.5 }, 1);
    expect(d[1]).toBe('專案：（未命名）');
    expect(d[3]).toContain('預設大小，製作還沒設定');
    expect(d[5]).toContain('縮小成 50%');
  });

  it('檔名：不能用的字換掉', () => {
    expect(ledMapFileName('png', meta)).toBe('LED對位圖-主舞臺-10496x5120-2026-10-14.png');
    expect(ledMapFileName('csv', { ...meta, projectName: 'A/B: C?' })).toBe('LED位置表-A_B_ C_-10496x5120-2026-10-14.csv');
  });
});

describe('pickLegendCorner', () => {
  it('挑蓋到 LED 最少的角落', () => {
    const c = { width: 1000, height: 1000 };
    const box = { w: 300, h: 150 };
    expect(pickLegendCorner([], c, box)).toBe('tl');
    expect(pickLegendCorner([{ rect: { x: 0, y: 0, w: 500, h: 500 } }], c, box)).toBe('tr');
    expect(pickLegendCorner([{ rect: { x: 0, y: 0, w: 1000, h: 500 } }], c, box)).toBe('bl');
    expect(pickLegendCorner([{ rect: { x: 0, y: 0, w: 1000, h: 500 } }, { rect: { x: 0, y: 500, w: 500, h: 500 } }], c, box)).toBe('br');
  });
});

describe('輸出大小', () => {
  it('一般大小（4K）：原尺寸就好，每台都畫得出來', () => {
    expect(exportScales(3840, 2160)).toEqual([1]);
  });
  it('金馬 10496 × 5120：先試原尺寸（5370 萬像素），不行再縮到 iPad 也畫得出來的大小', () => {
    const s = exportScales(10496, 5120);
    expect(s[0]).toBe(1);
    expect(s).toHaveLength(2);
    expect(10496 * 5120 * s[1] ** 2).toBeLessThanOrEqual(16.7e6 + 1);
  });
  it('單邊超過 16384 → 第一個就縮', () => {
    const s = exportScales(32768, 1024);
    expect(s[0]).toBeCloseTo(0.5, 6);
    expect(new Set(s).size).toBe(s.length);
  });
  it('測試圖貼圖：同比例、不超過上限', () => {
    expect(testPatternSize({ width: 10496, height: 5120 }, 4096, 9e6)).toEqual({ width: 4096, height: 1998, scale: 4096 / 10496 });
    const byArea = testPatternSize({ width: 10496, height: 5120 }, 4096, 4e6);
    expect(byArea.width * byArea.height).toBeLessThanOrEqual(4e6 + 5000);
    expect(byArea.width / byArea.height).toBeCloseTo(10496 / 5120, 2);
    const small = testPatternSize({ width: 1920, height: 1080 }, 4096, 8e6);
    expect(small).toEqual({ width: 1920, height: 1080, scale: 1 });
    const strip = testPatternSize({ width: 20000, height: 1000 }, 8192, 8e6);
    expect(strip.width).toBe(8192);
    expect(strip.width * strip.height).toBeLessThanOrEqual(8e6);
  });
});

describe('畫布大小', () => {
  it('製作輸入的寬 × 高', () => {
    expect(parseCanvasInput('10496 x 5120')).toEqual({ width: 10496, height: 5120 });
    expect(parseCanvasInput('10496×5120')).toEqual({ width: 10496, height: 5120 });
    expect(parseCanvasInput(' 1920, 1080 ')).toEqual({ width: 1920, height: 1080 });
    expect(parseCanvasInput('1920 1080')).toEqual({ width: 1920, height: 1080 });
    expect(parseCanvasInput('1920')).toBeNull();
    expect(parseCanvasInput('abc')).toBeNull();
    expect(parseCanvasInput('19.5 x 10')).toBeNull();
  });
  it('製作設定的 → 目前影片 → 3840 × 2160', () => {
    expect(resolveLedCanvas({ width: 10496, height: 5120 }, { width: 1920, height: 1080 })).toEqual({ canvas: { width: 10496, height: 5120 }, source: 'project' });
    expect(resolveLedCanvas(null, { width: 1920, height: 1080 })).toEqual({ canvas: { width: 1920, height: 1080 }, source: 'media' });
    expect(resolveLedCanvas(null, null)).toEqual({ canvas: { width: 3840, height: 2160 }, source: 'default' });
    expect(resolveLedCanvas(null, { width: 0, height: 0 }).source).toBe('default');
  });
});
