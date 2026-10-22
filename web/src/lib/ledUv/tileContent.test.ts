// 排版畫面框裡的測試圖：位置一改，畫出來的名字 / x y w h / 角落座標就是新位置（不是舊版面的）
import { describe, expect, it } from 'vitest';
import { drawLayers } from '../ledTemplateContentDraw';
import { makeTileContentCache, tileContent } from './tileContent';

/** 記下所有 fillText 的假 2D 畫布 */
function recorder() {
  const texts: string[] = [];
  const store: Record<string | symbol, unknown> = {};
  const handler: ProxyHandler<object> = {
    get(_t, k) {
      if (k === 'fillText') return (s: string) => { texts.push(s); };
      if (k === 'measureText') return (s: string) => ({ width: s.length * 5 });
      if (k === 'canvas') return { width: 1000, height: 1000 };
      if (k in store) return store[k];
      return () => undefined;
    },
    set(_t, k, v) { store[k] = v; return true; },
  };
  return { ctx: new Proxy({}, handler) as unknown as CanvasRenderingContext2D, texts };
}

(globalThis as { Path2D?: unknown }).Path2D ??= class { moveTo() {} lineTo() {} closePath() {} rect() {} };

const base = { canvas: { width: 6000, height: 1000 }, view: { zoom: 1, panX: 0, panY: 0 }, size: { w: 6000, h: 1000 }, dpr: 1, backdrop: null, content: null };

function drawAt(x: number, y: number, rotate: 0 | 90 = 0) {
  const { ctx, texts } = recorder();
  const get = makeTileContentCache();
  const w = rotate === 90 ? 400 : 1000, h = rotate === 90 ? 1000 : 400;
  drawLayers(ctx, {
    ...base,
    tiles: { of: k => get(k, 'PGM LED 左', 1000, 400, x, y, 0) },
    items: [{ key: 'a', dest: { x, y, w, h }, rotate, flipH: false, flipV: false }],
  });
  return texts.join('|');
}

describe('排版框裡的測試圖照現在的位置畫', () => {
  it('tileContent：x y w h 和角落座標就是現在的位置', () => {
    const t = tileContent('PGM LED 左', 1664, 2304, 576, 0, 0)!;
    expect(t.layout.panels[0].rect).toEqual({ x: 576, y: 0, w: 1664, h: 2304 });
    expect(t.layout.canvas).toEqual({ width: 2240, height: 2304 });
  });
  it('位置改了，畫出來的字跟著變；舊位置的字不見', () => {
    const before = drawAt(3520, 0);
    expect(before).toContain('x 3520  y 0  w 1000  h 400');
    expect(before).toContain('3520, 0');
    expect(before).toContain('4520, 400');
    const after = drawAt(576, 100);
    expect(after).toContain('x 576  y 100  w 1000  h 400');
    expect(after).toContain('576, 100');
    expect(after).toContain('1576, 500');
    expect(after).not.toContain('3520');
  });
  it('轉 90 度以後還是照新位置（大小用規格的樣子）', () => {
    expect(drawAt(200, 300, 90)).toContain('x 200  y 300  w 1000  h 400');
  });
  it('快取：同位置同一份，換位置重算', () => {
    const get = makeTileContentCache();
    const a = get('k', 'n', 100, 50, 0, 0, 0);
    expect(get('k', 'n', 100, 50, 0, 0, 0)).toBe(a);
    expect(get('k', 'n', 100, 50, 10, 0, 0)).not.toBe(a);
  });
});
